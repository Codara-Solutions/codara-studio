import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { quickCommandsFor } from "@shared/quick-commands";
import { openQuickCommandSettings, requestQuickCommands } from "./events";
import { useOptionalQuickCommands } from "./QuickCommandsContext";
import { PlayGlyph } from "./QuickCommandGlyphs";
import QuickCommandMenuList from "./QuickCommandMenuList";

// The tab strip's quick command button: a menu of the commands this
// workspace offers, each one click away, with Add and Manage below them.
// Shown only while a workspace is open.

export default function QuickCommandsButton() {
  const api = useOptionalQuickCommands();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onBlur = () => close(false);
    // Escape closes the menu even before focus has moved into it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [close, open]);

  const lists = useMemo(
    () => quickCommandsFor(api?.commands ?? [], api?.repoKey ?? null),
    [api?.commands, api?.repoKey],
  );

  if (!api?.workspaceId) return null;
  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        ref={buttonRef}
        type="button"
        className="spark-tabbar-new"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        title="Quick commands"
        aria-label="Quick commands"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <PlayGlyph size={10} />
      </button>
      {open ? (
        <div
          className="spark-tabbar-picker spark-glass"
          role="menu"
          aria-label="Quick commands"
          style={{ width: 320, maxHeight: "min(440px, 70vh)", overflowY: "auto", padding: 4 }}
        >
          <QuickCommandMenuList
            repo={lists.repo}
            global={lists.global}
            repoName={api.repoName}
            autoFocus
            onRun={(command) => {
              close(false);
              void api.run(command);
            }}
            onEdit={(command) => {
              close(false);
              requestQuickCommands({ action: "edit", id: command.id, returnFocus: buttonRef.current });
            }}
            onAdd={() => {
              close(false);
              requestQuickCommands({ action: "add", returnFocus: buttonRef.current });
            }}
            onManage={() => {
              close(false);
              openQuickCommandSettings();
            }}
            onClose={() => close(true)}
          />
        </div>
      ) : null}
    </div>
  );
}
