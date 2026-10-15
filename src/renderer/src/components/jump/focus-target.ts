import type { JumpTarget } from "./jump-model";

// Puts the keyboard in what the palette jumped to once it is on screen. A
// workspace switch lands a render later, and a revealed terminal tab focuses
// one of its panes itself, so this waits for the target to be visible plus
// one more frame and then focuses the exact pane, editor or page. The hosts
// are found by data attributes: data-pane-id on each terminal session
// (TerminalPane) and data-tab-content on editor and browser tabs.

const MAX_FRAMES = 40;

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function focusableFor(target: JumpTarget): HTMLElement | null {
  if (target.paneId) {
    const pane = document.querySelector(
      `.codara-terminal-session[data-pane-id="${cssEscape(target.paneId)}"]`,
    );
    return pane?.querySelector<HTMLElement>("textarea.xterm-helper-textarea") ?? null;
  }
  if (!target.tabId) return null;
  const host = document.querySelector(`[data-tab-content="${cssEscape(target.tabId)}"]`);
  return host?.querySelector<HTMLElement>(".cm-content, webview") ?? null;
}

function isShown(element: HTMLElement): boolean {
  const check = (element as HTMLElement & {
    checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean;
  }).checkVisibility;
  if (typeof check === "function") return check.call(element, { visibilityProperty: true });
  return element.offsetParent !== null;
}

export function focusJumpTargetWhenReady(target: JumpTarget): void {
  if (!target.paneId && !target.tabId) return;
  let frames = MAX_FRAMES;
  let seen = false;
  const tick = () => {
    const element = focusableFor(target);
    if (element && isShown(element)) {
      if (!seen) {
        seen = true;
        window.requestAnimationFrame(tick);
        return;
      }
      if (document.activeElement !== element) element.focus({ preventScroll: true });
      return;
    }
    frames -= 1;
    if (frames > 0) window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}
