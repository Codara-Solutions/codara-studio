import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import type { DesktopOpenPathOutcome, DesktopOpenPathRequest } from "@shared/types";
import type { DesktopNewTerminalOutcome, DesktopOpenPathReply } from "./desktop-command-socket";
import { revealWindow } from "./e2e-background";
import { grantReadFile } from "./fs-sandbox";
import { getTrustedMainWindow, isTrustedOnSender } from "./main-window-trust";
import { resolveOpenTarget, type OpenTarget, type PathDeps } from "./quick-open-path";

// Carries the desktop socket's commands to the renderer, which runs them and
// says what happened.

const REQUEST_CHANNEL = "desktop-command:new-terminal";
const OPEN_PATH_CHANNEL = "desktop-command:open-path";
const RESULT_CHANNEL = "desktop-command:result";
// Below the caller's own timeout, so it hears "unavailable" rather than
// nothing. A renderer that answers later still opens the tab.
const ANSWER_TIMEOUT_MS = 250;
// A folder becomes a workspace before the renderer answers. The socket's
// answer timeout covers this plus the disk's deadline.
const OPEN_PATH_ANSWER_TIMEOUT_MS = 1_500;

const OPEN_PATH_OUTCOMES: readonly unknown[] = ["opened", "ignored", "no-workspace"] satisfies DesktopOpenPathOutcome[];

const REFUSAL_REPLIES: Record<Extract<OpenTarget, { ok: false }>["reason"], DesktopOpenPathReply> = {
  invalid: "invalid-path",
  missing: "not-found",
  binary: "not-text",
  too_large: "too-large",
  refused: "not-allowed",
  timeout: "timeout",
};

const pending = new Map<string, (result: { ran?: unknown; outcome?: unknown }) => void>();
let registered = false;

export function registerDesktopCommandBridge(): void {
  if (registered) return;
  registered = true;
  ipcMain.on(RESULT_CHANNEL, (event, payload: { reqId?: unknown; ran?: unknown; outcome?: unknown } | undefined) => {
    if (!isTrustedOnSender(event, RESULT_CHANNEL)) return;
    if (typeof payload?.reqId !== "string") return;
    pending.get(payload.reqId)?.(payload);
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
    pending.set(reqId, ({ ran }) => finish(ran === true ? "opened" : "ignored"));
    contents.send(REQUEST_CHANNEL, reqId);
  });
}

export async function requestDesktopOpenPath(target: string, deps: PathDeps): Promise<DesktopOpenPathReply> {
  const resolved = await resolveOpenTarget(target, deps);
  if (!resolved.ok) return REFUSAL_REPLIES[resolved.reason];
  const window = getTrustedMainWindow();
  const contents = window?.webContents;
  if (!window || !contents || contents.isDestroyed() || contents.isCrashed()) return "unavailable";
  // The editor reads through the fs sandbox, which only knows the folders open
  // in Studio; the person asked for this one file.
  if (resolved.kind === "file") {
    grantReadFile(resolved.path);
    grantReadFile(resolved.real);
  }
  const request: DesktopOpenPathRequest = { path: resolved.path, kind: resolved.kind };
  const reply = await new Promise<DesktopOpenPathReply>((resolve) => {
    const reqId = randomUUID();
    const finish = (outcome: DesktopOpenPathReply) => {
      clearTimeout(timer);
      pending.delete(reqId);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("unavailable"), OPEN_PATH_ANSWER_TIMEOUT_MS);
    pending.set(reqId, ({ outcome }) => {
      finish(OPEN_PATH_OUTCOMES.includes(outcome) ? (outcome as DesktopOpenPathOutcome) : "unavailable");
    });
    contents.send(OPEN_PATH_CHANNEL, reqId, request);
  });
  if (reply === "opened" && !window.isDestroyed()) revealWindow(window);
  return reply;
}
