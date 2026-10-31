import { useCallback, useEffect, useRef } from "react";
import { findBinding, type BindingTable } from "./bindings";
import type { CommandId } from "./commands";
import { noteCommandRan } from "../components/feature-tips/feature-usage";

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

// Returns a function that runs a command as its chord would, under the same
// isDisabled rules, for a press that reached Studio without a key event. It
// says whether the command ran.
export function useGlobalShortcuts(
  table: BindingTable,
  handlers: ShortcutHandlers,
  options?: UseGlobalShortcutsOptions,
): (id: CommandId) => boolean {
  const latest = useRef({ table, handlers, options });
  latest.current = { table, handlers, options };

  const enabledHandler = useCallback((id: CommandId, e: KeyboardEvent) => {
    const { handlers, options } = latest.current;
    if (options?.isDisabled?.(id, e)) return null;
    return handlers[id] ?? null;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const binding = findBinding(latest.current.table, e);
      if (!binding) return;
      const id = binding.command.id;
      const h = enabledHandler(id, e);
      if (!h) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      h(e);
      noteCommandRan(id);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [enabledHandler]);

  return useCallback(
    (id: CommandId) => {
      const event = new KeyboardEvent("keydown");
      const h = enabledHandler(id, event);
      if (!h) return false;
      h(event);
      noteCommandRan(id);
      return true;
    },
    [enabledHandler],
  );
}
