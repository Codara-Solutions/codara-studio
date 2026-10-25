import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behavior of a modal dialog: Escape closes it (and only it, even
 * when it sits on top of another dialog), Tab stays inside, focus moves in
 * on open and goes back where it was on close.
 */
export function useModalDialog(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { canClose?: boolean; initialFocus?: string } = {},
): void {
  const canClose = options.canClose !== false;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    const first =
      (options.initialFocus ? root?.querySelector<HTMLElement>(options.initialFocus) : null) ??
      root?.querySelector<HTMLElement>(FOCUSABLE) ??
      root;
    first?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
    // Only on open: later renders must not move the user's focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const root = ref.current;
      if (!root) return;
      if (event.key === "Escape") {
        // Capture phase on window: runs before the dialog underneath.
        event.preventDefault();
        event.stopPropagation();
        if (canClose) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => item.offsetParent !== null || item === document.activeElement,
      );
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === firstItem || !root.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || !root.contains(active))) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ref, onClose, canClose]);
}
