// Shared "the app is tearing down" signal for the renderer.
//
// True once the page is unloading (pagehide/beforeunload) OR main told us a quit
// is starting (app:before-quit, sent BEFORE the PTYs are killed — see
// src/main/index.ts). Consumers use it to suppress destructive reactions to the
// PTY exits that quit-time teardown produces.
//
// The load-bearing consumer is onTerminalPaneExit: at quit, disposeAllGraceful
// kills every pane's shell, which fires pty:exit into the still-alive renderer.
// Without this guard, that flips a running agent's `agentSession.active` to
// false, the flip gets persisted, and the next launch sees active!==true → no
// boot-once resume → the pane comes back as a plain shell and the user has to
// type `claude --resume` by hand. Which quit path wins the race with the final
// persist decides whether resume works — the classic "only sometimes" symptom.
// Gating the flip on this signal makes active:true survive every quit path.
let tearingDown = false;

export function isAppTearingDown(): boolean {
  return tearingDown;
}

export function markAppTearingDown(): void {
  tearingDown = true;
}

// pagehide/beforeunload cover the window-close path (renderer unloads before
// main disposes PTYs). A renderer RELOAD (crash recovery) also fires pagehide —
// which is correct: any in-flight resume is moot mid-unload, and the reloaded
// page starts a fresh module with tearingDown=false, so boot-once still runs.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", markAppTearingDown);
  window.addEventListener("beforeunload", markAppTearingDown);
}
