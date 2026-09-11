interface WakeRecoveryOptions {
  fit(): void;
  repaint(): void;
  resume(): Promise<void>;
  afterWrite(callback: () => void): void;
}

/** Repaint after both the ordered PTY backlog and wake-time layout have settled. */
export function createTerminalWakeRecovery(options: WakeRecoveryOptions) {
  let generation = 0;
  let frame: number | null = null;
  let timer: number | null = null;
  const cancel = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    if (timer !== null) window.clearTimeout(timer);
    frame = null;
    timer = null;
  };
  const paint = () => {
    options.fit();
    options.repaint();
  };
  return {
    recover() {
      const current = ++generation;
      cancel();
      let started = false;
      const settle = () => {
        if (current !== generation) return;
        options.afterWrite(() => {
          if (current !== generation) return;
          let remaining = 3;
          const finalPaint = () => {
            if (current !== generation) return;
            cancel();
            paint();
          };
          const nextFrame = () => {
            frame = null;
            if (current !== generation) return;
            paint();
            if (--remaining > 0) frame = window.requestAnimationFrame(nextFrame);
            else {
              if (timer !== null) window.clearTimeout(timer);
              // The terminal's final PTY resize is debounced by 256 ms.
              timer = window.setTimeout(finalPaint, 350);
            }
          };
          frame = window.requestAnimationFrame(nextFrame);
          // Occluded windows may not get animation frames after unlocking.
          timer = window.setTimeout(finalPaint, 250);
        });
      };
      const begin = () => {
        if (started || current !== generation) return;
        started = true;
        cancel();
        paint();
        void options.resume().then(settle, settle);
      };
      frame = window.requestAnimationFrame(begin);
      timer = window.setTimeout(begin, 250);
    },
    dispose() {
      generation += 1;
      cancel();
    },
  };
}
