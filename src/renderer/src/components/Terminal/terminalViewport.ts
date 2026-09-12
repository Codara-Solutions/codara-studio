interface TerminalViewportLike {
  element?: HTMLElement;
  rows?: number;
  buffer: {
    active: {
      baseY: number;
      viewportY: number;
    };
  };
  scrollToBottom: () => void;
  scrollToLine: (line: number) => void;
}

interface ViewportPosition {
  line: number;
  atBottom: boolean;
}

/** Keep layout-generated scroll events from replacing the last visible position. */
export function createTerminalViewportRecovery(
  terminal: TerminalViewportLike,
  isVisible: () => boolean,
) {
  let position: ViewportPosition = { line: 0, atBottom: true };
  let suspended = false;
  let recovering = false;
  let restoring = false;
  let disposed = false;
  let timer: number | null = null;
  const viewport = terminal.element?.querySelector<HTMLElement>(".xterm-viewport");
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  const cancelTimer = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const remember = () => {
    if (disposed || suspended || recovering || !isVisible()) return;
    const buffer = terminal.buffer.active;
    position = { line: buffer.viewportY, atBottom: buffer.viewportY >= buffer.baseY };
  };
  const restore = () => {
    if (disposed || restoring || !recovering || !isVisible()) return;
    restoring = true;
    try {
      if (position.atBottom) terminal.scrollToBottom();
      else terminal.scrollToLine(Math.min(position.line, terminal.buffer.active.baseY));
      // xterm ignores some native scroll events during its own scrollbar sync.
      // scrollToBottom is a no-op if the buffer is already there, even when the
      // DOM scrollbar has reset to zero. Align both before the next event.
      const height = screen ? parseFloat(screen.style.height) : 0;
      if (viewport && height > 0 && terminal.rows) {
        const top = terminal.buffer.active.viewportY * height / terminal.rows;
        if (Math.abs(viewport.scrollTop - top) > 1) viewport.scrollTop = top;
      }
    } finally {
      restoring = false;
    }
  };
  const recover = () => {
    if (disposed || !isVisible()) return;
    cancelTimer();
    suspended = false;
    recovering = true;
    restore();
    // xterm parses writes asynchronously, and the PTY resize is debounced by
    // 256 ms. Three early animation frames cannot cover the resulting redraw.
    timer = window.setTimeout(() => {
      timer = null;
      restore();
      recovering = false;
      remember();
    }, 500);
  };
  const observe = () => {
    if (restoring) return;
    if (recovering) restore();
    else remember();
  };
  // Native scrolling suppresses xterm's public onScroll event. Register after
  // xterm's handler so wheel/scrollbar positions are captured from its buffer.
  viewport?.addEventListener("scroll", observe);
  return {
    recover,
    restore,
    observe,
    suspend() {
      cancelTimer();
      recovering = false;
      suspended = true;
    },
    userInput() {
      // Scrolling, selection and search take precedence over a pending repair.
      cancelTimer();
      recovering = false;
      suspended = false;
      remember();
    },
    restoreSnapshot(viewportFromBottom: number) {
      if (disposed) return;
      position = {
        line: Math.max(0, terminal.buffer.active.baseY - viewportFromBottom),
        atBottom: viewportFromBottom === 0,
      };
      recover();
    },
    distanceFromBottom() {
      return position.atBottom ? 0 : Math.max(0, terminal.buffer.active.baseY - position.line);
    },
    dispose() {
      disposed = true;
      cancelTimer();
      viewport?.removeEventListener("scroll", observe);
    },
  };
}

/**
 * FitAddon and Terminal.resize can reset xterm's viewport while changing the
 * grid. Preserve bottom-follow for an active TUI, or the user's distance from
 * the bottom when they deliberately scrolled into history.
 */
export function preserveTerminalViewport<T>(
  terminal: TerminalViewportLike,
  resize: () => T,
): T {
  const before = terminal.buffer.active;
  const wasAtBottom = before.viewportY >= before.baseY;
  const distanceFromBottom = Math.max(0, before.baseY - before.viewportY);

  try {
    return resize();
  } finally {
    try {
      if (wasAtBottom) {
        terminal.scrollToBottom();
      } else {
        const after = terminal.buffer.active;
        terminal.scrollToLine(Math.max(0, after.baseY - distanceFromBottom));
      }
    } catch {
      // The terminal can be disposed during a late ResizeObserver callback.
    }
  }
}
