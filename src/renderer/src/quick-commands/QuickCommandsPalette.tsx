import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { filterQuickCommands, quickCommandsFor, type QuickCommand } from "@shared/quick-commands";
import type { QuickCommandsApi } from "./QuickCommandsContext";
import { KindGlyph, PencilGlyph, quickCommandTargetLabel } from "./QuickCommandGlyphs";

// The keyboard way in: type to filter this workspace's quick commands, Enter
// runs one. Built like the Cora run switcher (clear scrim, strong glass) and
// lazy loaded by the host.

type Row =
  | { kind: "command"; command: QuickCommand; section: "repo" | "global" }
  | { kind: "add" };

export function paletteRows(commands: readonly QuickCommand[], repoKey: string | null, filter: string): Row[] {
  const { repo, global } = quickCommandsFor(commands, repoKey);
  return [
    ...filterQuickCommands(repo, filter).map((command): Row => ({ kind: "command", command, section: "repo" })),
    ...filterQuickCommands(global, filter).map((command): Row => ({ kind: "command", command, section: "global" })),
    { kind: "add" },
  ];
}

export interface QuickCommandsPaletteProps {
  api: QuickCommandsApi;
  onClose: () => void;
  onAdd: () => void;
  onEdit: (command: QuickCommand) => void;
}

export default function QuickCommandsPalette({ api, onClose, onAdd, onEdit }: QuickCommandsPaletteProps) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const keyboardMoveRef = useRef(false);

  const rows = useMemo(() => paletteRows(api.commands, api.repoKey, filter), [api.commands, api.repoKey, filter]);
  const hasCommands = rows.length > 1;

  // Focus moves before the next keystroke can land: a chord pressed in a
  // terminal is often followed at once by the filter text. On close it goes
  // back where it was unless what ran took it (a new terminal, a chat).
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        if ((!active || active === document.body) && previous?.isConnected) previous.focus();
      });
    };
  }, []);

  useEffect(() => {
    setSelected((index) => Math.min(index, rows.length - 1));
  }, [rows.length]);

  useEffect(() => {
    if (!keyboardMoveRef.current) return;
    keyboardMoveRef.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-qc-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = (row: Row | undefined, edit = false) => {
    if (!row) return;
    onClose();
    if (row.kind === "add") onAdd();
    else if (edit) onEdit(row.command);
    else void api.run(row.command);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      keyboardMoveRef.current = true;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelected((index) => (index + delta + rows.length) % rows.length);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(rows[selected], event.shiftKey);
    }
  };

  let lastSection: string | null = null;
  return (
    <div
      className="spark-fade-in"
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "72px 24px 24px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div className="spark-scrim spark-scrim--clear spark-scrim--palette" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Run a quick command"
        className="spark-glass--strong spark-overlay-surface"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          zIndex: 1,
          width: "min(560px, calc(100vw - 44px))",
          maxHeight: "min(520px, calc(100vh - 112px))",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: 12,
        }}
      >
        <header style={{ flex: "0 0 auto", padding: 14, borderBottom: "1px solid var(--rule-soft)" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 9 }}>
            <strong style={{ color: "var(--ink)", fontSize: 13 }}>Quick commands</strong>
            <span style={{ color: "var(--muted)", fontSize: 11 }}>↑↓ select · Enter run · Shift+Enter edit · Esc close</span>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(event) => {
              setFilter(event.currentTarget.value);
              setSelected(0);
            }}
            placeholder="Search quick commands…"
            aria-label="Search quick commands"
            aria-controls="qc-palette-list"
            aria-activedescendant={`qc-palette-row-${selected}`}
            spellCheck={false}
            style={{
              width: "100%",
              boxSizing: "border-box",
              appearance: "none",
              padding: "8px 10px",
              border: "1px solid var(--rule-soft)",
              borderRadius: 7,
              outline: "none",
              background: "var(--bg)",
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              boxShadow: "var(--well)",
            }}
          />
        </header>
        <div
          id="qc-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="Quick commands"
          style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 6 }}
        >
          {!hasCommands ? (
            <div style={{ padding: "18px 16px 12px", textAlign: "center", color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
              {filter ? "No matching quick commands" : "No quick commands yet. Save a shell command or an agent prompt to run it from here."}
            </div>
          ) : null}
          {rows.map((row, index) => {
            const isSelected = index === selected;
            const section = row.kind === "command" ? row.section : "add";
            const header =
              section !== lastSection && row.kind === "command"
                ? section === "repo"
                  ? api.repoName ? `This repository · ${api.repoName}` : "This repository"
                  : "All workspaces"
                : null;
            lastSection = section;
            return (
              <React.Fragment key={row.kind === "command" ? row.command.id : "add"}>
                {header ? (
                  <div
                    role="presentation"
                    style={{
                      padding: "8px 10px 4px",
                      color: "var(--muted)",
                      fontSize: 10.5,
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}
                  >
                    {header}
                  </div>
                ) : null}
                {row.kind === "add" && hasCommands ? (
                  <div role="separator" style={{ height: 1, margin: "4px 6px", background: "var(--rule-soft)" }} />
                ) : null}
                <div
                  id={`qc-palette-row-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  data-qc-index={index}
                  data-quick-command={row.kind === "command" ? row.command.id : undefined}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => choose(row)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 7,
                    background: isSelected ? "var(--hover-strong)" : "transparent",
                    boxShadow: isSelected ? "inset 0 0 0 1px color-mix(in oklab, var(--ink) 7%, transparent)" : undefined,
                    color: "var(--ink)",
                    cursor: "default",
                  }}
                >
                  {row.kind === "command" ? (
                    <>
                      <span aria-hidden style={{ display: "inline-flex", color: "var(--muted)", flex: "none" }}>
                        <KindGlyph command={row.command} size={13} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", overflow: "hidden", fontSize: 13, fontWeight: 600, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.command.label}
                        </span>
                        <span
                          className={row.command.kind === "shell" ? "spark-mono" : undefined}
                          style={{ display: "block", overflow: "hidden", marginTop: 2, color: "var(--muted)", fontSize: 11, textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {row.command.kind === "shell" ? row.command.command : row.command.prompt}
                        </span>
                      </span>
                      <span style={{ flex: "none", color: "var(--muted)", fontSize: 11 }}>{quickCommandTargetLabel(row.command)}</span>
                      <button
                        type="button"
                        className="spark-icon-btn"
                        aria-label={`Edit ${row.command.label}`}
                        title="Edit (Shift+Enter)"
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation();
                          choose(row, true);
                        }}
                      >
                        <PencilGlyph size={11} />
                      </button>
                    </>
                  ) : (
                    <span style={{ flex: 1, fontSize: 13 }}>Add quick command</span>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </section>
    </div>
  );
}
