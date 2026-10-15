import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { quickCommandsFor, type QuickCommand } from "@shared/quick-commands";
import { openQuickCommandSettings, requestQuickCommands } from "./events";
import type { QuickCommandsApi } from "./QuickCommandsContext";
import QuickCommandMenuList, { MenuAction } from "./QuickCommandMenuList";
import type { TerminalContextMenuRequest } from "./terminal-context-menu";

// The terminal's right-click menu: Copy and Paste, then the quick commands,
// which run in the terminal that was clicked. Opened by Shift+right-click, or
// by a plain right-click when Settings says so.

export interface TerminalQuickMenuProps {
  api: QuickCommandsApi;
  request: TerminalContextMenuRequest;
  onClose: () => void;
}

export default function TerminalQuickMenu({ api, request, onClose }: TerminalQuickMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const previous = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(pad, Math.min(request.x, window.innerWidth - rect.width - pad)),
      top: Math.max(pad, Math.min(request.y, window.innerHeight - rect.height - pad)),
    });
  }, [request.x, request.y]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onClose();
    };
    const onBlur = () => onClose();
    // Escape closes the menu wherever the keyboard is, and never reaches the
    // terminal underneath. Capture phase, ahead of xterm, which consumes it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      const el = previous.current;
      if (el?.isConnected) window.requestAnimationFrame(() => el.focus());
    };
    // Capture phase: panes stop mousedown from bubbling.
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [onClose]);

  const lists = useMemo(() => quickCommandsFor(api.commands, api.repoKey), [api.commands, api.repoKey]);

  const backToTerminal = () => {
    onClose();
    const el = previous.current;
    if (el?.isConnected) window.requestAnimationFrame(() => el.focus());
  };
  const run = (command: QuickCommand) => {
    onClose();
    void api.run(command, { paneId: request.paneId });
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Terminal"
      className="spark-menu spark-glass"
      data-testid="terminal-quick-menu"
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: "fixed",
        left: pos?.left ?? request.x,
        top: pos?.top ?? request.y,
        zIndex: 140,
        width: 300,
        maxHeight: "min(440px, calc(100vh - 16px))",
        overflowY: "auto",
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <QuickCommandMenuList
        repo={lists.repo}
        global={lists.global}
        repoName={api.repoName}
        autoFocus
        leading={
          <>
            <MenuAction
              label="Copy"
              disabled={!request.selection}
              onClick={() => {
                request.copy();
                backToTerminal();
              }}
            />
            <MenuAction
              label="Paste"
              onClick={() => {
                request.paste();
                backToTerminal();
              }}
            />
          </>
        }
        onRun={run}
        onEdit={(command) => {
          onClose();
          requestQuickCommands({ action: "edit", id: command.id, returnFocus: previous.current });
        }}
        onAdd={() => {
          onClose();
          requestQuickCommands({ action: "add", returnFocus: previous.current });
        }}
        onManage={() => {
          onClose();
          openQuickCommandSettings();
        }}
        onClose={backToTerminal}
      />
    </div>,
    document.body,
  );
}
