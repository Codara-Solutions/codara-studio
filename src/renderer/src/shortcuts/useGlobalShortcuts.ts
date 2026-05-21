import { useEffect, useRef } from "react";
import { findBinding, type BindingTable } from "./bindings";
import type { CommandId } from "./commands";

// Global, capture-phase keyboard dispatcher. Registers on `window` with
// `capture: true` and calls `stopImmediatePropagation` once a binding
// fires: that combination is what lets a `Mod+K` style chord beat any
// focused xterm/CodeMirror/textarea handler that would otherwise swallow
// the key. The latest handlers and binding table are read through a ref
// so `useEffect` can run exactly once while still using fresh closures
// on every keydown.

export type ShortcutHandler = (e: KeyboardEvent) => void;
export type ShortcutHandlers = Partial<Record<CommandId, ShortcutHandler>>;

export type UseGlobalShortcutsOptions = {
  isDisabled?: (id: CommandId, e: KeyboardEvent) => boolean;
};

export function useGlobalShortcuts(
  table: BindingTable,
  handlers: ShortcutHandlers,
  options?: UseGlobalShortcutsOptions,
) {
  const latest = useRef({ table, handlers, options });
  latest.current = { table, handlers, options };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { table, handlers, options } = latest.current;
      const binding = findBinding(table, e);
      if (!binding) return;
      const id = binding.command.id;
      if (options?.isDisabled?.(id, e)) return;
      const h = handlers[id];
      if (!h) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      h(e);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
