import React, { useEffect, useRef, useState } from "react";
import { upsertQuickCommand, removeQuickCommand, type QuickCommand } from "@shared/quick-commands";
import QuickCommandForm, { newQuickCommandDraft } from "./QuickCommandForm";
import type { QuickCommandsApi } from "./QuickCommandsContext";

// Add or edit one quick command without leaving the work: the tab strip menu,
// the terminal menu and the palette open this. The Settings page edits in
// place instead. Lazy loaded by the host, so it costs nothing until used.

export interface QuickCommandDialogProps {
  api: QuickCommandsApi;
  /** The command to edit; null adds a new one. */
  command: QuickCommand | null;
  /** What takes the keyboard back on close, when the opener knows better than the focus at mount. */
  returnFocus?: HTMLElement | null;
  onClose: () => void;
}

export default function QuickCommandDialog({ api, command, returnFocus, onClose }: QuickCommandDialogProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [initial] = useState(() => command ?? newQuickCommandDraft());
  const mode = command ? "edit" : "add";

  // Focus goes back where it was (a terminal, usually) when the dialog closes.
  // Read during the first render: by the time an effect runs, the form has
  // already moved focus into its Name field.
  const [previous] = useState<HTMLElement | null>(() =>
    returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );
  useEffect(
    () => () => {
      if (previous?.isConnected) window.requestAnimationFrame(() => previous.focus());
    },
    [previous],
  );

  // Tab stays inside the dialog while it is open.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(sectionRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])",
    ) ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const save = (next: QuickCommand) => {
    void api.save(upsertQuickCommand(api.commands, next));
    onClose();
  };

  const remove = () => {
    void api.save(removeQuickCommand(api.commands, initial.id));
    onClose();
  };

  // As in Settings, a stray click on the scrim does not drop a half typed
  // command: only Escape, Cancel and Save close it.
  return (
    <div
      className="spark-fade-in"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 130,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "72px 24px 24px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div className="spark-scrim spark-scrim--clear spark-scrim--palette" style={{ zIndex: 0 }} />
      <section
        ref={sectionRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "add" ? "Add quick command" : "Edit quick command"}
        className="spark-glass--strong spark-overlay-surface"
        onKeyDown={onKeyDown}
        style={{
          zIndex: 1,
          width: "min(520px, calc(100vw - 44px))",
          maxHeight: "calc(100vh - 112px)",
          overflowY: "auto",
          borderRadius: 12,
          padding: 18,
          display: "grid",
          gap: 14,
          color: "var(--ink)",
        }}
      >
        <strong style={{ fontSize: 14 }}>{mode === "add" ? "Add quick command" : "Edit quick command"}</strong>
        <QuickCommandForm
          initial={initial}
          mode={mode}
          repoOptions={api.repoOptions}
          onSave={save}
          onCancel={onClose}
          onDelete={mode === "edit" ? remove : undefined}
          // Settings offers Undo after a delete; this dialog cannot, so it asks first.
          confirmDelete
        />
      </section>
    </div>
  );
}
