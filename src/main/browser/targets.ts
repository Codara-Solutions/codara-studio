// One interface for every browser tab an agent can drive. A feature built
// against BrowserTarget works on a Codara browser tab (webContents.debugger,
// preview-target.ts) and on a tab of the user's Chrome (chrome.debugger over
// the extension link) alike. Backends register themselves; the preview one
// is always there, the Chrome one while a browser is connected.

import { noteActedTab } from "./acted-tab";
import type { CdpSession } from "./cdp-session";
import { BrowserTabRefError, parseTabRef, type BrowserTabRef } from "./tab-ref";

export type BrowserTargetKind = "preview" | "chrome";

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserTargetInfo {
  /** The id agents pass back as tabId. */
  ref: string;
  kind: BrowserTargetKind;
  url: string;
  title: string;
  /** CSS pixels of the layout viewport, when the page answered. */
  viewport: BrowserViewport | null;
  devicePixelRatio: number;
}

export interface BrowserTarget {
  readonly kind: BrowserTargetKind;
  readonly ref: string;
  /** The tab's shared session; its console and network recorders already run. */
  readonly session: CdpSession;
  /** The workspace whose data folder this tab's artifacts belong to. */
  readonly workspaceId: string | null;
  info(): Promise<BrowserTargetInfo>;
  /**
   * Run an expression in the page's main world. The value comes back by
   * value (JSON); a thrown error or rejected promise rejects with its message.
   */
  evaluate<T = unknown>(expression: string, options?: { awaitPromise?: boolean }): Promise<T>;
  /** The visible viewport as PNG, painted even while the tab is in the background. */
  captureViewport(): Promise<Buffer>;
  /** Show the agent's activity on the tab (the preview cursor); a no-op where there is none. */
  showActivity(action: string, point?: { x: number; y: number }): Promise<void>;
}

export interface BrowserTabSummary {
  id: string;
  kind: BrowserTargetKind;
  title: string;
  url: string;
  isActive?: boolean;
}

export interface BrowserTargetBackend {
  readonly kind: BrowserTargetKind;
  /** ref is null when the call named no tab (only the preview backend gets that). */
  resolve(ref: BrowserTabRef | null, params: Record<string, unknown>): Promise<BrowserTarget>;
  list?(params: Record<string, unknown>): Promise<BrowserTabSummary[]>;
}

const backends = new Map<BrowserTargetKind, BrowserTargetBackend>();

export function registerBrowserBackend(backend: BrowserTargetBackend): () => void {
  backends.set(backend.kind, backend);
  return () => {
    if (backends.get(backend.kind) === backend) backends.delete(backend.kind);
  };
}

export function browserBackend(kind: BrowserTargetKind): BrowserTargetBackend | null {
  return backends.get(kind) ?? null;
}

/** The target a call's (already scoped) params name. */
export async function resolveBrowserTarget(params: Record<string, unknown>): Promise<BrowserTarget> {
  const ref = parseTabRef(params.tabId);
  const kind: BrowserTargetKind = ref?.kind ?? "preview";
  const backend = backends.get(kind);
  if (!backend) {
    if (kind === "chrome") {
      throw new BrowserTabRefError(
        "No Chrome browser is connected to Codara. Install the Codara extension in Chrome and connect it, then use the chrome: ids codara_preview_list returns.",
      );
    }
    throw new Error("Codara's browser is not ready yet. Retry in a moment.");
  }
  const target = await backend.resolve(ref, params);
  noteActedTab(target.ref);
  return target;
}

/** Run a protocol Runtime.evaluate and unwrap its value or exception. */
export async function evaluateOverCdp<T>(
  session: CdpSession,
  expression: string,
  options: { awaitPromise?: boolean } = {},
): Promise<T> {
  const result = await session.send<{
    result?: { value?: unknown; unserializableValue?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
  }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: options.awaitPromise === true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.exception?.description ?? (typeof details.exception?.value === "string" ? details.exception.value : null) ?? details.text ?? "evaluation failed";
    throw new Error(message.split("\n")[0]);
  }
  return (result.result?.value ?? null) as T;
}
