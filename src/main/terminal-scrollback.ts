import { join } from "node:path";
import * as pty from "./pty-manager";
import { codaraHome } from "./codara-home";
import { getPreferenceCached, loadPreferences } from "./preferences-store";
import { logMain } from "./file-log";
import {
  TerminalScrollbackStore,
  type TerminalScrollbackRecord,
  type TerminalScrollbackReplay,
  type TerminalScrollbackReplayOptions,
} from "./terminal-scrollback-store";
import type { IpcHandle } from "./ipc";

// The app's one terminal scrollback store (terminal-scrollback-store.ts),
// wired to the real PTYs, Codara's home folder and the restoreTerminalOutput
// setting.
//
// Other main-process features use these exports rather than the files:
// - agent hibernation stops a pane's process on purpose and starts it later.
//   flushTerminalScrollback(paneId) before the stop keeps its output, and
//   readTerminalScrollbackReplay(paneId, { force: true, rows }) hands back
//   the text to show before the new process draws, with rows the xterm's
//   height (on Windows the text ends by clearing a screen that tall, see
//   handOverScreen). Ask after the stop and right before the start. The
//   renderer can ask the same through window.spark.terminalScrollback.restore
//   with force.
//   Stopping the PTY from main (pty.dispose) keeps the file; only the
//   renderer's pty:dispose, which means the user closed the pane, deletes it.
// - readTerminalScrollbackRecord(paneId) returns the stored record itself.

export type { TerminalScrollbackRecord, TerminalScrollbackReplay, TerminalScrollbackReplayOptions };

const DIR_NAME = "terminal-scrollback";

let store: TerminalScrollbackStore | null = null;

function enabled(): boolean {
  return getPreferenceCached("restoreTerminalOutput") !== false;
}

function getStore(): TerminalScrollbackStore {
  store ??= new TerminalScrollbackStore({
    dir: join(codaraHome(), DIR_NAME),
    tap: pty.tap,
    hasSession: pty.hasSession,
    dimensions: pty.sessionDimensions,
    readTail: pty.readTail,
    enabled,
    newSessionOwnsScreen: process.platform === "win32",
    log: (line) => logMain("scrollback", line),
  });
  return store;
}

/** Boot: index the saved files once preferences are known. */
export async function initTerminalScrollback(): Promise<void> {
  await loadPreferences().catch(() => undefined);
  await getStore().init();
}

/** The renderer's user-facing panes (not Cora worker panes) for one layout sync. */
export function trackTerminalScrollbackPanes(paneIds: Iterable<string>): void {
  getStore().track(paneIds);
}

/** The user closed the pane: its saved output is deleted. */
export function forgetTerminalScrollback(paneId: string): Promise<void> {
  return getStore().forget(paneId);
}

/** Write unsaved output now, for one pane or all of them. */
export function flushTerminalScrollback(paneId?: string): Promise<void> {
  return store ? store.flush(paneId) : Promise.resolve();
}

export function readTerminalScrollbackReplay(
  paneId: string,
  options?: TerminalScrollbackReplayOptions,
): Promise<TerminalScrollbackReplay | null> {
  return getStore().restoreReplay(paneId, options);
}

export function readTerminalScrollbackRecord(paneId: string): Promise<TerminalScrollbackRecord | null> {
  return getStore().read(paneId);
}

export function setTerminalScrollbackEnabled(next: boolean): Promise<void> {
  return getStore().setEnabled(next);
}

export function registerTerminalScrollbackIpc(handle: IpcHandle): void {
  handle(
    "terminalScrollback:restore",
    async (
      _event,
      args: { paneId?: unknown; maxLines?: unknown; rows?: unknown; force?: unknown },
    ): Promise<TerminalScrollbackReplay | null> => {
      const paneId = typeof args?.paneId === "string" ? args.paneId : "";
      if (!paneId || paneId.length > 256) return null;
      const maxLines = typeof args.maxLines === "number" && Number.isFinite(args.maxLines) ? args.maxLines : undefined;
      const rows = typeof args.rows === "number" && Number.isFinite(args.rows) ? args.rows : undefined;
      return readTerminalScrollbackReplay(paneId, { maxLines, rows, force: args.force === true });
    },
  );
}
