// "Something on the Agents view changed": the terminal notifier calls this on
// every state, tool, prompt or message change of a pane, and the renderer
// reads the new snapshot when it hears the ping. A busy agent changes tools
// several times a second, so the ping is coalesced to one per window and
// carries no payload: the renderer reads only while the view is open.
//
// No Electron here, so the notifier's unit harness bundles it as is;
// agent-board.ts installs the sender.

export const AGENT_BOARD_SIGNAL_WINDOW_MS = 250;

let listener: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function onAgentBoardChanged(next: (() => void) | null): void {
  listener = next;
  if (!next && timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function signalAgentBoardChanged(): void {
  if (!listener || timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      listener?.();
    } catch {
      /* the view refreshes on its next ping */
    }
  }, AGENT_BOARD_SIGNAL_WINDOW_MS);
  (timer as { unref?: () => void }).unref?.();
}
