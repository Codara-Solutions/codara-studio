import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { terminalRightClickAction, type QuickCommand } from "@shared/quick-commands";
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

type DialogState = { command: QuickCommand | null } | null;

export default function QuickCommandsHost({ api }: { api: QuickCommandsApi }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [menu, setMenu] = useState<TerminalContextMenuRequest | null>(null);

  const apiRef = useRef(api);
  apiRef.current = api;

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
      if (detail.action === "add") {
        setDialog({ command: null });
        return;
      }
      const command = apiRef.current.commands.find((entry) => entry.id === detail.id);
      if (command) setDialog({ command });
    };
    window.addEventListener(QUICK_COMMANDS_EVENT, onRequest);
    return () => window.removeEventListener(QUICK_COMMANDS_EVENT, onRequest);
  }, []);

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
              onAdd={() => setDialog({ command: null })}
              onEdit={(command) => setDialog({ command })}
            />
          ) : null}
          {dialog ? <QuickCommandDialog key={dialog.command?.id ?? "new"} api={api} command={dialog.command} onClose={closeDialog} /> : null}
        </Suspense>
      ) : null}
    </>
  );
}
