interface TerminalViewportLike {
  buffer: {
    active: {
      baseY: number;
      viewportY: number;
    };
  };
  scrollToBottom: () => void;
  scrollToLine: (line: number) => void;
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
