import React, { useEffect, useRef } from "react";
import type { QuickCommand } from "@shared/quick-commands";
import { KindGlyph, PencilGlyph, quickCommandTargetLabel } from "./QuickCommandGlyphs";

// The rows of a quick command menu: this repository's commands, then the
// global ones, then Add and Manage. Shared by the tab strip button and the
// terminal's right-click menu, which puts Copy and Paste above it. The
// arrow keys, Home and End move between the rows; Escape is the owner's.

export interface QuickCommandMenuListProps {
  repo: readonly QuickCommand[];
  global: readonly QuickCommand[];
  repoName: string | null;
  /** Rows above the commands (the terminal's Copy and Paste). */
  leading?: React.ReactNode;
  autoFocus?: boolean;
  onRun: (command: QuickCommand) => void;
  onEdit: (command: QuickCommand) => void;
  onAdd: () => void;
  onManage: () => void;
  onClose: () => void;
}

export const MENU_ITEM_ATTR = "data-qc-menu-item";

export function MenuSection({ label }: { label: string }) {
  return (
    <div
      role="presentation"
      style={{
        padding: "7px 10px 3px",
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        userSelect: "none",
      }}
    >
      {label}
    </div>
  );
}

export function MenuDivider() {
  return <div role="separator" style={{ height: 1, margin: "4px 6px", background: "var(--rule-soft)" }} />;
}

export function MenuAction({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="spark-menu-item"
      {...{ [MENU_ITEM_ATTR]: "" }}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onClick();
      }}
      style={{ padding: "6px 10px" }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {hint ? <span style={{ color: "var(--muted)", fontSize: 11 }}>{hint}</span> : null}
    </button>
  );
}

function CommandRow({
  command,
  onRun,
  onEdit,
}: {
  command: QuickCommand;
  onRun: (command: QuickCommand) => void;
  onEdit: (command: QuickCommand) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }} className="qc-menu-row">
      <button
        type="button"
        role="menuitem"
        className="spark-menu-item"
        {...{ [MENU_ITEM_ATTR]: "" }}
        data-quick-command={command.id}
        title={command.kind === "prompt" ? command.prompt : command.command}
        onClick={() => onRun(command)}
        style={{ flex: 1, minWidth: 0, padding: "6px 10px" }}
      >
        <span aria-hidden style={{ display: "inline-flex", color: "var(--muted)", flex: "none" }}>
          <KindGlyph command={command} />
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {command.label}
        </span>
        <span style={{ flex: "none", color: "var(--muted)", fontSize: 11 }}>{quickCommandTargetLabel(command)}</span>
      </button>
      <button
        type="button"
        className="spark-icon-btn"
        aria-label={`Edit ${command.label}`}
        title="Edit (Right arrow)"
        data-qc-edit=""
        tabIndex={-1}
        onClick={() => onEdit(command)}
      >
        <PencilGlyph size={11} />
      </button>
    </div>
  );
}

export default function QuickCommandMenuList({
  repo,
  global,
  repoName,
  leading,
  autoFocus,
  onRun,
  onEdit,
  onAdd,
  onManage,
  onClose,
}: QuickCommandMenuListProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLElement>(`[${MENU_ITEM_ATTR}]:not([aria-disabled="true"])`)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    // Right reaches a row's Edit button, Left comes back to the row.
    const active = document.activeElement as HTMLElement | null;
    if (event.key === "ArrowRight" && active?.hasAttribute("data-quick-command")) {
      event.preventDefault();
      (active.nextElementSibling as HTMLElement | null)?.focus();
      return;
    }
    if (event.key === "ArrowLeft" && active?.hasAttribute("data-qc-edit")) {
      event.preventDefault();
      (active.previousElementSibling as HTMLElement | null)?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(`[${MENU_ITEM_ATTR}]`) ?? [])].filter(
      (item) => item.getAttribute("aria-disabled") !== "true",
    );
    if (items.length === 0) return;
    event.preventDefault();
    const focusedRow = active?.hasAttribute("data-qc-edit") ? (active.previousElementSibling as HTMLElement | null) : active;
    const index = focusedRow ? items.indexOf(focusedRow) : -1;
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (index + 1) % items.length
      : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const empty = repo.length === 0 && global.length === 0;
  return (
    <div ref={ref} onKeyDown={onKeyDown}>
      {leading}
      {leading ? <MenuDivider /> : null}
      {repo.length > 0 ? (
        <>
          <MenuSection label={repoName ? `This repository · ${repoName}` : "This repository"} />
          {repo.map((command) => (
            <CommandRow key={command.id} command={command} onRun={onRun} onEdit={onEdit} />
          ))}
        </>
      ) : null}
      {global.length > 0 ? (
        <>
          <MenuSection label="All workspaces" />
          {global.map((command) => (
            <CommandRow key={command.id} command={command} onRun={onRun} onEdit={onEdit} />
          ))}
        </>
      ) : null}
      {empty ? (
        <div style={{ padding: "8px 10px 6px", color: "var(--muted)", fontSize: 12, lineHeight: 1.45 }}>
          No quick commands yet. Save a shell command or an agent prompt to run it in one click.
        </div>
      ) : null}
      <MenuDivider />
      <MenuAction label="Add quick command" onClick={onAdd} />
      <MenuAction label="Manage quick commands" hint="Settings" onClick={onManage} />
    </div>
  );
}
