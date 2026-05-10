import { useEffect, useRef } from "react";
import { SHORTCUTS, type ShortcutId } from "./shortcuts";

// Global, capture-phase keyboard dispatcher. We register on `window` with
// `capture: true` and call `stopImmediatePropagation` once a binding fires:
// that combination is what lets a `Mod+K` style chord beat any focused
// xterm/CodeMirror/textarea handler that would otherwise swallow the key.
// Handlers are read through a ref so `useEffect` can run exactly once,
// while still using the latest closures from the parent on every keydown.

export type ShortcutHandler = (e: KeyboardEvent) => void;
export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

export type UseGlobalShortcutsOptions = {
  isDisabled?: (id: ShortcutId, e: KeyboardEvent) => boolean;
};

export function useGlobalShortcuts(
  handlers: ShortcutHandlers,
  options?: UseGlobalShortcutsOptions,
) {
  const latest = useRef({ handlers, options });
  latest.current = { handlers, options };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { handlers, options } = latest.current;
      for (const s of SHORTCUTS) {
        if (!s.match(e)) continue;
        if (options?.isDisabled?.(s.id, e)) return;
        const h = handlers[s.id];
        if (!h) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        h(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
