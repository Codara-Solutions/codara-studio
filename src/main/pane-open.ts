import { isAbsolute } from "node:path";

/**
 * pane.open: a program running in a Codara terminal opens another terminal
 * either over its own pane (an overlay of the same size and place that takes
 * the keyboard and closes when its command exits, like a zoomed split in
 * WezTerm) or in a new tab of the pane's workspace. The caller is always the
 * pane its credential was minted for (agent-socket stamps paneId), so one pane
 * can never open anything over another.
 *
 * Tabs and overlays are renderer state, reached through the terminal bridge.
 * Main keeps only which overlay covers which pane, so a tab requested from an
 * overlay lands beside the pane underneath and an overlay never outlives the
 * pane it covers.
 */

export type PaneOpenMode = "overlay" | "tab";

export interface PaneOpenRequest {
  paneId: string;
  mode: PaneOpenMode;
  command?: string;
  cwd?: string;
  title?: string;
}

export type PaneOpenResult =
  | { mode: "overlay"; paneId: string; hostPaneId: string }
  | { mode: "tab"; paneId: string; tabId: string };

export class PaneOpenError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "spawn",
  ) {
    super(message);
    this.name = "PaneOpenError";
  }
}

export interface PaneOpenDeps {
  paneAlive: (paneId: string) => boolean;
  waitForSpawn: (paneId: string, timeoutMs: number) => Promise<boolean>;
  onExit: (paneId: string, handler: () => void) => () => void;
  kill: (paneId: string) => void;
  isDirectory: (path: string) => Promise<boolean>;
  requestTerminalOp: <T>(op: "overlay" | "closeOverlay" | "create" | "destroy", params: Record<string, unknown>) => Promise<T>;
}

const MAX_COMMAND_CHARS = 8_192;
const MAX_TITLE_CHARS = 120;
// The renderer mounts the overlay and spawns its PTY a beat after the bridge
// answers; same bound terminal.create waits for its tab.
const SPAWN_WAIT_MS = 10_000;

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new PaneOpenError(`${key} must be a string`, "invalid");
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parsePaneOpenParams(params: Record<string, unknown>): PaneOpenRequest {
  const paneId = optionalString(params, "paneId");
  if (!paneId) throw new PaneOpenError("paneId is required", "invalid");
  const mode = params.mode;
  if (mode !== "overlay" && mode !== "tab") {
    throw new PaneOpenError("mode must be overlay or tab", "invalid");
  }
  const command = optionalString(params, "command");
  if (mode === "overlay" && !command) {
    throw new PaneOpenError("an overlay needs a command to run", "invalid");
  }
  if (command !== undefined) {
    if (command.length > MAX_COMMAND_CHARS) {
      throw new PaneOpenError(`command is longer than ${MAX_COMMAND_CHARS} characters`, "invalid");
    }
    // The command reaches the shell as one line (a startup argument, or typed
    // into PowerShell), so a line break would run the rest on its own.
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(command)) {
      throw new PaneOpenError("command must be a single line without control characters", "invalid");
    }
  }
  const cwd = optionalString(params, "cwd");
  if (cwd !== undefined && !isAbsolute(cwd)) {
    throw new PaneOpenError("cwd must be an absolute path", "invalid");
  }
  const title = optionalString(params, "title");
  return {
    paneId,
    mode,
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(title ? { title: title.slice(0, MAX_TITLE_CHARS) } : {}),
  };
}

export function createPaneOpener(deps: PaneOpenDeps) {
  const hostByOverlay = new Map<string, string>();
  const pendingHosts = new Set<string>();

  const coveredHosts = (): Set<string> => new Set([...hostByOverlay.values(), ...pendingHosts]);

  async function openOverlay(request: PaneOpenRequest): Promise<PaneOpenResult> {
    const host = request.paneId;
    if (hostByOverlay.has(host)) {
      throw new PaneOpenError("an overlay cannot open another overlay; open a tab instead", "invalid");
    }
    if (coveredHosts().has(host)) {
      throw new PaneOpenError("this pane already has an overlay open", "invalid");
    }
    pendingHosts.add(host);
    try {
      const created = await deps.requestTerminalOp<{ paneId: string }>("overlay", {
        hostPaneId: host,
        command: request.command,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.title ? { title: request.title } : {}),
      });
      const overlay = created?.paneId;
      if (typeof overlay !== "string" || !overlay) {
        throw new PaneOpenError("the overlay did not open", "spawn");
      }
      if (!(await deps.waitForSpawn(overlay, SPAWN_WAIT_MS))) {
        await deps.requestTerminalOp("closeOverlay", { paneId: overlay }).catch(() => undefined);
        // The renderer may already have asked for this PTY. Once the overlay
        // is gone nothing shows it and no host exit ends it, so one that
        // comes up now or a little later must not keep running unseen.
        deps.kill(overlay);
        void deps.waitForSpawn(overlay, SPAWN_WAIT_MS).then((late) => {
          if (late) deps.kill(overlay);
        });
        throw new PaneOpenError("the overlay's terminal failed to start", "spawn");
      }
      hostByOverlay.set(overlay, host);
      const offHost = deps.onExit(host, () => {
        if (hostByOverlay.get(overlay) === host) deps.kill(overlay);
      });
      const offOverlay = deps.onExit(overlay, () => {
        offOverlay();
        offHost();
        hostByOverlay.delete(overlay);
      });
      // onExit sees only future exits; either side may already be gone.
      if (!deps.paneAlive(overlay)) {
        offOverlay();
        offHost();
        hostByOverlay.delete(overlay);
      } else if (!deps.paneAlive(host)) {
        deps.kill(overlay);
      }
      return { mode: "overlay", paneId: overlay, hostPaneId: host };
    } finally {
      pendingHosts.delete(host);
    }
  }

  async function openTab(request: PaneOpenRequest): Promise<PaneOpenResult> {
    const anchor = hostByOverlay.get(request.paneId) ?? request.paneId;
    const created = await deps.requestTerminalOp<{ tabId: string; paneId: string }>("create", {
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.command ? { command: request.command } : {}),
      ...(request.title ? { title: request.title } : {}),
      callerPaneId: anchor,
      requestedFromPane: true,
    });
    if (!created?.paneId || !(await deps.waitForSpawn(created.paneId, SPAWN_WAIT_MS))) {
      if (created?.tabId) {
        await deps
          .requestTerminalOp("destroy", { tabId: created.tabId, paneId: created.paneId })
          .catch(() => undefined);
      }
      throw new PaneOpenError("the new tab's terminal failed to start", "spawn");
    }
    return { mode: "tab", paneId: created.paneId, tabId: created.tabId };
  }

  return {
    async open(request: PaneOpenRequest): Promise<PaneOpenResult> {
      if (!deps.paneAlive(request.paneId)) {
        throw new PaneOpenError("the calling pane is not running", "invalid");
      }
      if (request.cwd && !(await deps.isDirectory(request.cwd))) {
        throw new PaneOpenError(`cwd is not a folder: ${request.cwd}`, "invalid");
      }
      return request.mode === "overlay" ? openOverlay(request) : openTab(request);
    },
    hostOf(paneId: string): string | null {
      return hostByOverlay.get(paneId) ?? null;
    },
    // A reloaded renderer starts with no overlays on screen; their programs
    // would otherwise keep running unseen and keep their panes covered here.
    closeAll(): void {
      for (const overlay of [...hostByOverlay.keys()]) deps.kill(overlay);
    },
  };
}
