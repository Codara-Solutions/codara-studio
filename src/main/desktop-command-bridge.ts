import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import type { DesktopNewTerminalOutcome } from "./desktop-command-socket";
import { getTrustedMainWindow, isTrustedOnSender } from "./main-window-trust";

// Carries the desktop socket's one command to the renderer, which runs it
// through the shortcut dispatcher and says whether it ran.

const REQUEST_CHANNEL = "desktop-command:new-terminal";
const RESULT_CHANNEL = "desktop-command:result";
// Below the caller's own timeout, so it hears "unavailable" rather than
// nothing. A renderer that answers later still opens the tab.
const ANSWER_TIMEOUT_MS = 250;

const pending = new Map<string, (ran: boolean) => void>();
let registered = false;

export function registerDesktopCommandBridge(): void {
  if (registered) return;
  registered = true;
  ipcMain.on(RESULT_CHANNEL, (event, payload: { reqId?: unknown; ran?: unknown } | undefined) => {
    if (!isTrustedOnSender(event, RESULT_CHANNEL)) return;
    if (typeof payload?.reqId !== "string") return;
    pending.get(payload.reqId)?.(payload.ran === true);
  });
}

export function requestDesktopNewTerminal(): Promise<DesktopNewTerminalOutcome> {
  const contents = getTrustedMainWindow()?.webContents;
  if (!contents || contents.isDestroyed() || contents.isCrashed()) {
    return Promise.resolve("unavailable");
  }
  return new Promise((resolve) => {
    const reqId = randomUUID();
    const finish = (outcome: DesktopNewTerminalOutcome) => {
      clearTimeout(timer);
      pending.delete(reqId);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("unavailable"), ANSWER_TIMEOUT_MS);
    pending.set(reqId, (ran) => finish(ran ? "opened" : "ignored"));
    contents.send(REQUEST_CHANNEL, reqId);
  });
}
