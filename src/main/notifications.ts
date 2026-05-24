import { BrowserWindow, Notification } from "electron";
import type { RunState } from "@shared/types";

// Tab-aware notification suppression follows herdr's 3-rule policy: alert on
// transition into `blocked` (agent needs the user), alert on transition into
// `complete` ONLY if the user isn't currently looking at that run, and never
// alert when the run's status hasn't actually changed. Both pieces of state
// (active run id + window focus) live in this module so the run-store hook
// doesn't have to thread context around.

let activeRunId: string | null = null;
let mainWindowRef: BrowserWindow | null = null;

export function setActiveRunId(id: string | null): void {
  activeRunId = id;
}

export function registerMainWindow(win: BrowserWindow): void {
  mainWindowRef = win;
}

export function notifyRunStateTransition(
  run: RunState,
  prev: RunState["status"] | null,
  next: RunState["status"],
): void {
  // Rule 3: never alert on no state change. Most commitRunChange calls touch
  // unrelated fields and shouldn't fire.
  if (prev === next) return;
  if (!Notification.isSupported()) return;

  if (next === "blocked") {
    // Rule 1: always alert when the agent transitions into blocked, even if
    // the user is staring at the run — `blocked` means it stopped waiting on
    // them and a passive "the spinner stopped" cue isn't always loud enough.
    fire(`${run.title} — needs you`, "Agent is waiting on a reply.");
    return;
  }
  if (next === "complete") {
    // Rule 2: suppress if the user is already looking at this run. Focus +
    // active-run-id are both checked on demand against the main process state
    // captured by registerMainWindow / setActiveRunId.
    const focused = mainWindowRef?.isFocused() ?? false;
    if (focused && activeRunId === run.id) return;
    fire(`${run.title} — done`, "Agent finished.");
    return;
  }
}

function fire(title: string, body: string): void {
  try {
    const n = new Notification({ title, body, silent: false });
    n.on("click", () => mainWindowRef?.focus());
    n.show();
  } catch {
    // Best-effort: a malformed title/body or a platform that briefly loses
    // the notification service shouldn't break the run flow.
  }
}
