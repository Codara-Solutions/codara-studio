// "Something on the Agents view changed": the terminal notifier calls this on
// every state, tool, prompt or message change of a pane, and the renderer
// reads the new snapshot when it hears the ping. A busy agent changes tools
// several times a second, so the ping is coalesced to one per window and
// carries no payload: the renderer reads only while the view is open.
//
// No Electron here, so the notifier's unit harness bundles it as is;
// agent-board.ts installs the sender. Other main-process readers of the same
// per-pane state (keep-awake) subscribe beside it instead of polling.

export const AGENT_BOARD_SIGNAL_WINDOW_MS = 250;

let listener: (() => void) | null = null;
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function stopWhenUnheard(): void {
  if (!listener && subscribers.size === 0 && timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function onAgentBoardChanged(next: (() => void) | null): void {
  listener = next;
  stopWhenUnheard();
}

/** Hear the same coalesced ping; returns the unsubscribe. */
export function subscribeAgentBoardChanged(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
    stopWhenUnheard();
  };
}

export function signalAgentBoardChanged(): void {
  if ((!listener && subscribers.size === 0) || timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const fn of [listener, ...subscribers]) {
      try {
        fn?.();
      } catch {
        /* the view refreshes on its next ping */
      }
    }
  }, AGENT_BOARD_SIGNAL_WINDOW_MS);
  (timer as { unref?: () => void }).unref?.();
}
