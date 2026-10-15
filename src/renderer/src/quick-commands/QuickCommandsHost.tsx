import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { MAX_QUICK_COMMANDS, terminalRightClickAction, type QuickCommand } from "@shared/quick-commands";
import { emitLocalToast } from "../notifications/local-toast";
import { QUICK_COMMANDS_EVENT, type QuickCommandsRequest } from "./events";
import type { QuickCommandsApi } from "./QuickCommandsContext";
import { setTerminalContextMenuHandler, type TerminalContextMenuRequest } from "./terminal-context-menu";
import TerminalQuickMenu from "./TerminalQuickMenu";

// Rendered once by App: opens the palette, the add and edit dialog and the
// terminal's quick command menu when asked (QUICK_COMMANDS_EVENT, the
// keyboard command, a terminal right-click). The palette and the dialog load
// on first use.

const QuickCommandsPalette = lazy(() => import("./QuickCommandsPalette"));
const QuickCommandDialog = lazy(() => import("./QuickCommandDialog"));

type DialogState = { command: QuickCommand | null; returnFocus: HTMLElement | null } | null;

export default function QuickCommandsHost({ api }: { api: QuickCommandsApi }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [menu, setMenu] = useState<TerminalContextMenuRequest | null>(null);

  const apiRef = useRef(api);
  apiRef.current = api;

  const openAddDialog = useCallback((returnFocus: HTMLElement | null) => {
    // The saved list keeps MAX_QUICK_COMMANDS; one more would be dropped on save.
    if (apiRef.current.commands.length >= MAX_QUICK_COMMANDS) {
      emitLocalToast(
        `You have ${MAX_QUICK_COMMANDS} quick commands`,
        "That is the most Codara keeps. Delete one in Settings to add another.",
        "warning",
      );
      return;
    }
    setDialog({ command: null, returnFocus });
  }, []);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<QuickCommandsRequest>).detail;
      if (!detail) return;
      setMenu(null);
      if (detail.action === "palette") {
        // Not over another dialog (Settings, a picker): it would open behind it.
        if (!apiRef.current.workspaceId || document.querySelector('[aria-modal="true"]')) return;
        setDialog(null);
        setPaletteOpen(true);
        return;
      }
      setPaletteOpen(false);
      const returnFocus = detail.returnFocus ?? null;
      if (detail.action === "add") {
        openAddDialog(returnFocus);
        return;
      }
      const command = apiRef.current.commands.find((entry) => entry.id === detail.id);
      if (command) setDialog({ command, returnFocus });
    };
    window.addEventListener(QUICK_COMMANDS_EVENT, onRequest);
    return () => window.removeEventListener(QUICK_COMMANDS_EVENT, onRequest);
  }, [openAddDialog]);

  useEffect(
    () =>
      setTerminalContextMenuHandler((request) => {
        const current = apiRef.current;
        if (request.readOnly || !current.workspaceId) return false;
        const action = terminalRightClickAction(current.terminalRightClick, {
          shiftKey: request.shiftKey,
          hasSelection: request.selection.length > 0,
        });
        if (action !== "menu") return false;
        setMenu(request);
        return true;
      }),
    [],
  );

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <>
      {menu ? <TerminalQuickMenu api={api} request={menu} onClose={closeMenu} /> : null}
      {paletteOpen || dialog ? (
        <Suspense fallback={null}>
          {paletteOpen ? (
            <QuickCommandsPalette
              api={api}
              onClose={closePalette}
              onAdd={openAddDialog}
              onEdit={(command, returnFocus) => setDialog({ command, returnFocus })}
            />
          ) : null}
          {dialog ? (
            <QuickCommandDialog
              key={dialog.command?.id ?? "new"}
              api={api}
              command={dialog.command}
              returnFocus={dialog.returnFocus}
              onClose={closeDialog}
            />
          ) : null}
        </Suspense>
      ) : null}
    </>
  );
}
