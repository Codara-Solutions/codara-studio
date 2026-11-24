import { KeyedSerialQueue } from "./cora-policy";
import {
  encodeBoundedPreviewJpeg,
  mapNormalizedPreviewClick,
  MAX_REMOTE_PREVIEW_TABS,
  projectRemotePreviewTabs,
  REMOTE_PREVIEW_VIEWPORTS,
  sanitizeRemotePreviewTitle,
  sanitizeRemotePreviewUrl,
  type PreviewImageLike,
  type RemotePreviewInteractAction,
  type RemotePreviewScreenshot,
  type RemotePreviewTab,
  type RemotePreviewViewportMode,
} from "./preview-policy";

// Plain-Node controller for remote Browser Preview operations. Keeps Electron
// dependencies injected so error redaction, fail-closed TOCTOU URL checks,
// sleeping-tab guards, and destroyed-guest lifecycle safety run in plain Node.

const MAX_PREVIEW_VIEWPORT_MODES = 256;
const LIST_TIMEOUT_MS = 5_000;
const SCREENSHOT_TIMEOUT_MS = 12_000;
const RESIZE_TIMEOUT_MS = 8_000;
const OPEN_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 8_000;
const CLICK_SETTLE_MS = 180;
const VIEWPORT_SETTLE_MS = 150;
const RELOAD_SETTLE_MS = 1_500;

export const ERR_PREVIEW_UNAVAILABLE = "Browser preview is temporarily unavailable.";
export const ERR_PREVIEW_TAB_UNAVAILABLE = "Browser preview tab is not available in this workspace.";
export const ERR_PREVIEW_SCHEME_DISALLOWED = "Only http and https browser preview tabs can be viewed remotely.";
export const ERR_PREVIEW_TAB_CLOSED = "Browser preview tab is no longer open.";
export const ERR_PREVIEW_VIEWPORT_UNREADY = "Browser preview viewport is not ready.";
export const ERR_PREVIEW_FRAME_TOO_LARGE = "Browser preview frame exceeded the remote transfer limit.";
export const ERR_PREVIEW_TAB_LIMIT = "Too many browser preview tabs are already open in this workspace.";

export class RemotePreviewError extends Error {
  readonly remoteSafe = true;
  constructor(message: string) {
    super(message);
    this.name = "RemotePreviewError";
  }
}

export type PreviewMouseInputEvent =
  | { type: "mouseMove"; x: number; y: number }
  | { type: "mouseDown" | "mouseUp"; x: number; y: number; button: "left"; clickCount: number };

export type PreviewGuestLifecycleEvent =
  | "did-stop-loading"
  | "did-fail-load"
  | "destroyed"
  | "render-process-gone";

export interface PreviewWebContentsLike {
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  getZoomFactor(): number;
  reload(): void;
  readonly navigationHistory: { canGoBack(): boolean; canGoForward(): boolean };
  sendInputEvent(event: PreviewMouseInputEvent): void;
  once(event: PreviewGuestLifecycleEvent, listener: () => void): unknown;
  removeListener(event: PreviewGuestLifecycleEvent, listener: () => void): unknown;
}

export interface PreviewGuestResolution<
  TWebContents extends PreviewWebContentsLike = PreviewWebContentsLike,
> {
  wc: TWebContents;
  info: {
    tabId: string;
    workspaceId?: string | null;
    url: string | null;
    viewport: { width: number; height: number } | null;
  };
}

export interface RemotePreviewControllerDeps<
  TWebContents extends PreviewWebContentsLike = PreviewWebContentsLike,
> {
  requireLocalWorkspace(workspaceId: string): Promise<unknown>;
  requestPreviewOp<T = unknown>(
    op: "list" | "screenshot" | "resize" | "navigate" | "close",
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T>;
  resolvePreviewGuest(params: Record<string, unknown>): Promise<PreviewGuestResolution<TWebContents>>;
  isTrustedPreviewGuest(wc: TWebContents | null | undefined): boolean;
  decodeImage(dataUrl: string): PreviewImageLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  reloadSettleMs?: number;
}

export interface RemotePreviewController {
  listPreviewTabs(workspaceId: string): Promise<RemotePreviewTab[]>;
  openPreviewTab(input: { workspaceId: string; url: string }): Promise<RemotePreviewTab>;
  closePreviewTab(input: { workspaceId: string; tabId: string }): Promise<{ closed: true }>;
  capturePreviewScreenshot(input: { workspaceId: string; tabId: string }): Promise<RemotePreviewScreenshot>;
  interactPreviewTab(input: {
    workspaceId: string;
    tabId: string;
    action: RemotePreviewInteractAction;
  }): Promise<RemotePreviewScreenshot>;
}

function isRemoteSafeError(err: unknown): err is RemotePreviewError {
  return (
    err instanceof RemotePreviewError ||
    (Boolean(err) && typeof err === "object" && (err as { remoteSafe?: unknown }).remoteSafe === true)
  );
}

// Redact raw renderer/bridge errors so internal file paths, disallowed URLs,
// cross-workspace tab existence, and MCP tool hints never cross the wire.
function mapPreviewBridgeError(err: unknown, context: "list" | "tab"): RemotePreviewError {
  if (isRemoteSafeError(err)) return err;
  const message = err instanceof Error ? err.message : "";
  if (
    context === "tab" &&
    /\b(no browser tab|another workspace|is closed|sleeping|has not loaded|web contents is gone|not ready|not a preview guest)\b/i.test(
      message,
    )
  ) {
    return new RemotePreviewError(ERR_PREVIEW_TAB_UNAVAILABLE);
  }
  return new RemotePreviewError(ERR_PREVIEW_UNAVAILABLE);
}

async function runBridgeCall<T>(context: "list" | "tab", fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw mapPreviewBridgeError(err, context);
  }
}

export function createRemotePreviewController<
  TWebContents extends PreviewWebContentsLike = PreviewWebContentsLike,
>(deps: RemotePreviewControllerDeps<TWebContents>): RemotePreviewController {
  const tabOps = new KeyedSerialQueue();
  const workspaceOpenOps = new KeyedSerialQueue();
  const viewportModes = new Map<string, RemotePreviewViewportMode>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const reloadSettleMs = deps.reloadSettleMs ?? RELOAD_SETTLE_MS;

  function rememberViewportMode(tabId: string, mode: RemotePreviewViewportMode): void {
    viewportModes.delete(tabId);
    viewportModes.set(tabId, mode);
    while (viewportModes.size > MAX_PREVIEW_VIEWPORT_MODES) {
      const oldest = viewportModes.keys().next().value;
      if (typeof oldest !== "string") break;
      viewportModes.delete(oldest);
    }
  }

  // Verify the tab exists in this workspace, is awake, and carries an http/https
  // URL BEFORE calling resolvePreviewGuest or screenshot/resize so remote callers
  // never wake sleeping desktop tabs or probe disallowed schemes.
  async function assertAwakeAllowedTab(workspaceId: string, tabId: string): Promise<void> {
    const listed = await runBridgeCall("tab", () =>
      deps.requestPreviewOp<{ tabs?: unknown[] }>("list", { workspaceId }, { timeoutMs: LIST_TIMEOUT_MS }),
    );
    const rawTabs = Array.isArray(listed?.tabs) ? listed.tabs : [];
    const match = rawTabs.find((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const entry = raw as Record<string, unknown>;
      return entry.workspaceId === workspaceId && typeof entry.id === "string" && entry.id.trim() === tabId;
    }) as Record<string, unknown> | undefined;

    if (!match || match.asleep === true) throw new RemotePreviewError(ERR_PREVIEW_TAB_UNAVAILABLE);
    if (!sanitizeRemotePreviewUrl(match.url)) throw new RemotePreviewError(ERR_PREVIEW_SCHEME_DISALLOWED);
  }

  async function resolveVerifiedGuest(
    workspaceId: string,
    tabId: string,
  ): Promise<PreviewGuestResolution<TWebContents>> {
    const resolved = await runBridgeCall("tab", () =>
      deps.resolvePreviewGuest({ tabId, workspaceId, lookupWake: "none" }),
    );
    const { wc, info } = resolved;
    if (info.tabId !== tabId || info.workspaceId !== workspaceId) {
      throw new RemotePreviewError(ERR_PREVIEW_TAB_UNAVAILABLE);
    }
    if (!wc || wc.isDestroyed() || !deps.isTrustedPreviewGuest(wc)) {
      throw new RemotePreviewError(ERR_PREVIEW_TAB_CLOSED);
    }
    if (!sanitizeRemotePreviewUrl(wc.getURL())) {
      throw new RemotePreviewError(ERR_PREVIEW_SCHEME_DISALLOWED);
    }
    return resolved;
  }

  async function captureSanitizedTab(workspaceId: string, tabId: string): Promise<RemotePreviewScreenshot> {
    await assertAwakeAllowedTab(workspaceId, tabId);
    const { wc } = await resolveVerifiedGuest(workspaceId, tabId);
    const raw = await runBridgeCall("tab", () =>
      deps.requestPreviewOp<{ dataUrl: string; url?: string; title?: string }>(
        "screenshot",
        { tabId, workspaceId },
        { timeoutMs: SCREENSHOT_TIMEOUT_MS },
      ),
    );

    // Fail-closed post-capture TOCTOU check: never fall back to pre-capture URLs.
    if (wc.isDestroyed() || !deps.isTrustedPreviewGuest(wc)) {
      throw new RemotePreviewError(ERR_PREVIEW_TAB_CLOSED);
    }
    const liveUrl = wc.getURL();
    const finalUrl = sanitizeRemotePreviewUrl(liveUrl);
    if (!finalUrl) throw new RemotePreviewError(ERR_PREVIEW_SCHEME_DISALLOWED);
    if (typeof raw?.url === "string" && raw.url.trim().length > 0 && !sanitizeRemotePreviewUrl(raw.url)) {
      throw new RemotePreviewError(ERR_PREVIEW_SCHEME_DISALLOWED);
    }
    if (!raw || typeof raw.dataUrl !== "string" || !raw.dataUrl.startsWith("data:image/")) {
      throw new RemotePreviewError(ERR_PREVIEW_UNAVAILABLE);
    }

    let encoded: { dataUrl: string; width: number; height: number; bytes: number };
    try {
      encoded = encodeBoundedPreviewJpeg(deps.decodeImage(raw.dataUrl));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      throw new RemotePreviewError(/transfer limit/i.test(msg) ? ERR_PREVIEW_FRAME_TOO_LARGE : ERR_PREVIEW_UNAVAILABLE);
    }

    if (wc.isDestroyed()) throw new RemotePreviewError(ERR_PREVIEW_TAB_CLOSED);
    const loading = wc.isLoading();
    const canGoBack = wc.navigationHistory.canGoBack();
    const canGoForward = wc.navigationHistory.canGoForward();
    const liveTitle = wc.getTitle() || "";
    const hasUsableRawTitle =
      typeof raw.title === "string" && raw.title.replace(/[\u0000-\u001f\u007f]/g, "").trim().length > 0;
    const title = sanitizeRemotePreviewTitle(hasUsableRawTitle ? raw.title : liveTitle, finalUrl, raw.url ?? liveUrl);
    const viewportMode = viewportModes.get(tabId);
    return {
      tabId,
      workspaceId,
      title,
      url: finalUrl,
      loading,
      canGoBack,
      canGoForward,
      ...(viewportMode ? { viewportMode } : {}),
      screenshotDataUrl: encoded.dataUrl,
      width: encoded.width,
      height: encoded.height,
      updatedAt: now().toISOString(),
    };
  }

  return {
    async listPreviewTabs(workspaceId: string): Promise<RemotePreviewTab[]> {
      await deps.requireLocalWorkspace(workspaceId);
      const result = await runBridgeCall("list", () =>
        deps.requestPreviewOp<{ tabs?: unknown[] }>("list", { workspaceId }, { timeoutMs: LIST_TIMEOUT_MS }),
      );
      return projectRemotePreviewTabs(Array.isArray(result?.tabs) ? result.tabs : [], workspaceId, viewportModes);
    },

    async openPreviewTab(input: { workspaceId: string; url: string }): Promise<RemotePreviewTab> {
      await deps.requireLocalWorkspace(input.workspaceId);
      const safeUrl = sanitizeRemotePreviewUrl(input.url);
      if (!safeUrl) {
        throw new RemotePreviewError(ERR_PREVIEW_SCHEME_DISALLOWED);
      }
      return workspaceOpenOps.run(input.workspaceId, async () => {
        const listed = await runBridgeCall("list", () =>
          deps.requestPreviewOp<{ tabs?: unknown[] }>("list", { workspaceId: input.workspaceId }, { timeoutMs: LIST_TIMEOUT_MS }),
        );
        const existingCount = Array.isArray(listed?.tabs)
          ? listed.tabs.filter(
              (raw) =>
                Boolean(raw) &&
                typeof raw === "object" &&
                !Array.isArray(raw) &&
                (raw as Record<string, unknown>).workspaceId === input.workspaceId,
            ).length
          : 0;
        if (existingCount >= MAX_REMOTE_PREVIEW_TABS) {
          throw new RemotePreviewError(ERR_PREVIEW_TAB_LIMIT);
        }
        const raw = await runBridgeCall("tab", () =>
          deps.requestPreviewOp<{ tabId?: unknown; url?: unknown; title?: unknown; loading?: unknown }>(
            "navigate",
            { workspaceId: input.workspaceId, url: safeUrl, fresh: true },
            { timeoutMs: OPEN_TIMEOUT_MS },
          ),
        );
        const tabId = typeof raw?.tabId === "string" ? raw.tabId.trim() : "";
        if (!tabId || tabId.length > 128) {
          throw new RemotePreviewError(ERR_PREVIEW_UNAVAILABLE);
        }
        const rawUrl = typeof raw?.url === "string" ? raw.url.trim() : "";
        const finalUrl = rawUrl ? sanitizeRemotePreviewUrl(rawUrl) : safeUrl;
        if (!finalUrl) {
          await deps
            .requestPreviewOp("close", { workspaceId: input.workspaceId, tabId }, { timeoutMs: CLOSE_TIMEOUT_MS })
            .catch(() => undefined);
          throw new RemotePreviewError(ERR_PREVIEW_SCHEME_DISALLOWED);
        }
        const title = sanitizeRemotePreviewTitle(raw?.title, finalUrl, raw?.url);
        return {
          tabId,
          workspaceId: input.workspaceId,
          title,
          url: finalUrl,
          loading: raw?.loading === true,
          canGoBack: false,
          canGoForward: false,
          updatedAt: now().toISOString(),
        };
      });
    },

    async closePreviewTab(input: { workspaceId: string; tabId: string }): Promise<{ closed: true }> {
      await deps.requireLocalWorkspace(input.workspaceId);
      return tabOps.run(input.tabId, async () => {
        await assertAwakeAllowedTab(input.workspaceId, input.tabId);
        await runBridgeCall("tab", () =>
          deps.requestPreviewOp("close", { workspaceId: input.workspaceId, tabId: input.tabId }, { timeoutMs: CLOSE_TIMEOUT_MS }),
        );
        viewportModes.delete(input.tabId);
        return { closed: true };
      });
    },

    async capturePreviewScreenshot(input: { workspaceId: string; tabId: string }): Promise<RemotePreviewScreenshot> {
      await deps.requireLocalWorkspace(input.workspaceId);
      return tabOps.run(input.tabId, () => captureSanitizedTab(input.workspaceId, input.tabId));
    },

    async interactPreviewTab(input: {
      workspaceId: string;
      tabId: string;
      action: RemotePreviewInteractAction;
    }): Promise<RemotePreviewScreenshot> {
      await deps.requireLocalWorkspace(input.workspaceId);
      return tabOps.run(input.tabId, async () => {
        await assertAwakeAllowedTab(input.workspaceId, input.tabId);
        const { wc, info } = await resolveVerifiedGuest(input.workspaceId, input.tabId);

        switch (input.action.kind) {
          case "click": {
            const vp = info.viewport;
            if (!vp || !Number.isFinite(vp.width) || !Number.isFinite(vp.height) || vp.width <= 0 || vp.height <= 0) {
              throw new RemotePreviewError(ERR_PREVIEW_VIEWPORT_UNREADY);
            }
            const point = mapNormalizedPreviewClick(input.action.x, input.action.y, vp.width, vp.height);
            if (wc.isDestroyed()) throw new RemotePreviewError(ERR_PREVIEW_TAB_CLOSED);
            const zoom = wc.getZoomFactor() || 1;
            const x = Math.round(point.x * zoom);
            const y = Math.round(point.y * zoom);
            const events: PreviewMouseInputEvent[] = [
              { type: "mouseMove", x, y },
              { type: "mouseDown", x, y, button: "left", clickCount: 1 },
              { type: "mouseUp", x, y, button: "left", clickCount: 1 },
            ];
            for (const event of events) {
              if (wc.isDestroyed()) throw new RemotePreviewError(ERR_PREVIEW_TAB_CLOSED);
              wc.sendInputEvent(event);
            }
            await sleep(CLICK_SETTLE_MS);
            break;
          }
          case "reload": {
            if (wc.isDestroyed()) throw new RemotePreviewError(ERR_PREVIEW_TAB_CLOSED);
            let timer: NodeJS.Timeout | undefined;
            let finish = (): void => {};
            const waitForSettle = new Promise<void>((resolvePromise) => {
              let settled = false;
              finish = (): void => {
                if (settled) return;
                settled = true;
                resolvePromise();
              };
              timer = setTimeout(finish, reloadSettleMs);
              wc.once("did-stop-loading", finish);
              wc.once("did-fail-load", finish);
              wc.once("destroyed", finish);
              wc.once("render-process-gone", finish);
            });
            try {
              if (wc.isDestroyed()) finish();
              else wc.reload();
              await waitForSettle;
            } finally {
              if (timer) clearTimeout(timer);
              if (!wc.isDestroyed()) {
                wc.removeListener("did-stop-loading", finish);
                wc.removeListener("did-fail-load", finish);
                wc.removeListener("destroyed", finish);
                wc.removeListener("render-process-gone", finish);
              }
            }
            break;
          }
          case "viewport": {
            const size = REMOTE_PREVIEW_VIEWPORTS[input.action.mode];
            await runBridgeCall("tab", () =>
              deps.requestPreviewOp(
                "resize",
                { tabId: input.tabId, workspaceId: input.workspaceId, width: size.width, height: size.height },
                { timeoutMs: RESIZE_TIMEOUT_MS },
              ),
            );
            rememberViewportMode(input.tabId, input.action.mode);
            await sleep(VIEWPORT_SETTLE_MS);
            break;
          }
        }
        return captureSanitizedTab(input.workspaceId, input.tabId);
      });
    },
  };
}
