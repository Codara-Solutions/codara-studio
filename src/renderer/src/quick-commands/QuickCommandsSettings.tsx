import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_QUICK_COMMANDS,
  moveQuickCommand,
  normalizeQuickCommands,
  normalizeTerminalRightClick,
  removeQuickCommand,
  sameRepoKey,
  upsertQuickCommand,
  type QuickCommand,
} from "@shared/quick-commands";
import { usePreferences } from "../preferences/usePreferences";
import { InlineMessage, Kbd, Segmented, SettingRow, SettingsSection } from "../components/settings/SettingsPrimitives";
import { buildBindingTable } from "../shortcuts/bindings";
import { chordToHint } from "../shortcuts/chord";
import { useOptionalQuickCommands } from "./QuickCommandsContext";
import QuickCommandForm, { newQuickCommandDraft } from "./QuickCommandForm";
import { ArrowGlyph, KindGlyph, PencilGlyph, TrashGlyph, quickCommandTargetLabel } from "./QuickCommandGlyphs";

// Settings › Quick commands: the saved list, in the order the menus show it,
// with add, edit in place, reorder and delete, and the terminal right-click
// choice. Reads and writes the preferences itself, so the page works the
// same whether or not App's quick command API is mounted around Settings.

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

type Editing = { id: string; isNew: boolean } | null;

const styles = {
  list: { display: "flex", flexDirection: "column", margin: 0, padding: 0, listStyle: "none" },
  row: { display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderTop: "1px solid var(--st-line)", minWidth: 0 },
  editor: { padding: "14px 0", borderTop: "1px solid var(--st-line)" },
  newEditor: { padding: "4px 0 14px" },
  glyph: { display: "inline-flex", flex: "none", color: "var(--muted)" },
  text: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  title: { color: "var(--ink)", fontSize: 13, fontWeight: 500 },
  body: { color: "var(--st-desc)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { color: "var(--muted)", fontSize: 11.5 },
} satisfies Record<string, React.CSSProperties>;

// Where the keyboard goes once the page re-renders after an action that
// removed or moved the focused control: the first selector that matches an
// enabled element inside the page wins.
function focusFirst(root: HTMLElement | null, selectors: readonly string[]): void {
  if (!root) return;
  for (const selector of selectors) {
    const el = root.querySelector<HTMLElement>(selector);
    if (el && !(el as HTMLButtonElement).disabled) {
      el.focus();
      return;
    }
  }
}

const rowSelector = (id: string) => `[data-quick-command="${CSS.escape(id)}"]`;

export default function QuickCommandsSettings() {
  const { preferences, hydrated, setPreference } = usePreferences();
  const api = useOptionalQuickCommands();
  const commands = useMemo(() => normalizeQuickCommands(preferences.quickCommands), [preferences.quickCommands]);
  const rightClick = normalizeTerminalRightClick(preferences.terminalRightClick);
  const repoOptions = api?.repoOptions ?? [];
  const [editing, setEditing] = useState<Editing>(null);
  const [draftNew, setDraftNew] = useState<QuickCommand | null>(null);
  const [deleted, setDeleted] = useState<{ command: QuickCommand; index: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // A move re-inserts the row (a focused button leaves the DOM and loses the
  // keyboard), a Move button at an end turns disabled, and Delete, Save and
  // Cancel remove the control that had focus. Each names where focus goes.
  const pendingFocus = useRef<readonly string[] | null>(null);
  useEffect(() => {
    const selectors = pendingFocus.current;
    if (!selectors) return;
    pendingFocus.current = null;
    focusFirst(rootRef.current, selectors);
  });

  useEffect(() => {
    if (!deleted) return;
    const timer = window.setTimeout(() => setDeleted(null), 8000);
    return () => window.clearTimeout(timer);
  }, [deleted]);

  const save = (next: QuickCommand[]) => void setPreference("quickCommands", normalizeQuickCommands(next));

  const moveFocus = (selectors: readonly string[]) => {
    pendingFocus.current = selectors;
  };
  const backToRow = (id: string) => moveFocus([`${rowSelector(id)} [data-qc-action="edit"]`, "[data-qc-action=\"add\"]"]);

  const startAdd = () => {
    const draft = newQuickCommandDraft();
    setDraftNew(draft);
    setEditing({ id: draft.id, isNew: true });
  };

  const scopeLabel = (command: QuickCommand): string => {
    if (command.scope.type === "global") return "All workspaces";
    const repo = command.scope.repo;
    const option = repoOptions.find((entry) => sameRepoKey(entry.key, repo));
    return `Only ${option?.label ?? baseName(repo)}`;
  };

  // The user's own chord for the palette, rebinds included.
  const paletteHint = useMemo(() => {
    const chord = buildBindingTable(preferences.keybindings).find((binding) => binding.command.id === "quickCommands.open")?.chords[0];
    return chord ? chordToHint(chord) : null;
  }, [preferences.keybindings]);

  return (
    <div ref={rootRef} style={{ display: "contents" }}>
      <SettingsSection
        title="Saved commands"
        description={
          <>
            Run one from the play button in the tab bar or with
            {rightClick === "menu" ? " a right-click" : " Shift+right-click"} in a terminal
            {paletteHint ? <>, or search them with <Kbd>{paletteHint}</Kbd></> : null}. Commands for one
            repository come first there.
          </>
        }
        actions={
          <button
            type="button"
            className="spark-btn"
            data-qc-action="add"
            onClick={startAdd}
            // The saved list keeps MAX_QUICK_COMMANDS; one more would be dropped on save.
            disabled={editing?.isNew === true || commands.length >= MAX_QUICK_COMMANDS}
            title={commands.length >= MAX_QUICK_COMMANDS ? `${MAX_QUICK_COMMANDS} is the most Codara keeps. Delete one to add another.` : undefined}
          >
            Add quick command
          </button>
        }
        plain
      >
        {deleted ? (
          <InlineMessage
            tone="muted"
            role="status"
            action={
              <button
                type="button"
                className="spark-btn"
                data-qc-action="undo"
                onClick={() => {
                  const next = [...commands];
                  next.splice(Math.min(deleted.index, next.length), 0, deleted.command);
                  save(next);
                  setDeleted(null);
                  backToRow(deleted.command.id);
                }}
              >
                Undo
              </button>
            }
          >
            Deleted {deleted.command.label}.
          </InlineMessage>
        ) : null}

        {editing?.isNew && draftNew ? (
          <div style={styles.newEditor}>
            <QuickCommandForm
              key={draftNew.id}
              initial={draftNew}
              mode="add"
              repoOptions={repoOptions}
              onSave={(command) => {
                save(upsertQuickCommand(commands, command));
                setEditing(null);
                setDraftNew(null);
                backToRow(command.id);
              }}
              onCancel={() => {
                setEditing(null);
                setDraftNew(null);
                moveFocus(["[data-qc-action=\"add\"]"]);
              }}
            />
          </div>
        ) : null}

        {hydrated && commands.length === 0 && !editing?.isNew ? (
          <div className="st-empty">
            <span className="st-empty__title">No quick commands yet</span>
            <span className="st-empty__body">
              Save a shell command such as npm test, or a prompt for an agent such as a review request. {"{branch}"} and {"{cwd}"} fill in the git branch and the folder.
            </span>
          </div>
        ) : null}

        {commands.length > 0 ? (
          <ul aria-label="Saved quick commands" style={styles.list}>
            {commands.map((command, index) => {
              if (editing?.id === command.id && !editing.isNew) {
                return (
                  <li key={command.id} style={index === 0 ? { ...styles.editor, borderTop: "none" } : styles.editor}>
                    <QuickCommandForm
                      initial={command}
                      mode="edit"
                      repoOptions={repoOptions}
                      onSave={(next) => {
                        save(upsertQuickCommand(commands, next));
                        setEditing(null);
                        backToRow(command.id);
                      }}
                      onCancel={() => {
                        setEditing(null);
                        backToRow(command.id);
                      }}
                      onDelete={() => {
                        setDeleted({ command, index });
                        save(removeQuickCommand(commands, command.id));
                        setEditing(null);
                        moveFocus(["[data-qc-action=\"undo\"]"]);
                      }}
                    />
                  </li>
                );
              }
              const body = command.kind === "shell" ? command.command : command.prompt;
              return (
                <li key={command.id} style={index === 0 ? { ...styles.row, borderTop: "none" } : styles.row} data-quick-command={command.id}>
                  <span aria-hidden style={styles.glyph}>
                    <KindGlyph command={command} size={13} />
                  </span>
                  <span style={styles.text}>
                    <span style={styles.title}>{command.label}</span>
                    <span className={command.kind === "shell" ? "spark-mono" : undefined} style={styles.body}>{body}</span>
                    <span style={styles.meta}>
                      {command.kind === "shell" ? "Shell command" : "Agent prompt"} · {quickCommandTargetLabel(command)} · {scopeLabel(command)}
                    </span>
                  </span>
                  <span className="st-row-actions">
                    <button
                      type="button"
                      className="spark-icon-btn st-icon-btn"
                      aria-label={`Move ${command.label} up`}
                      title="Move up"
                      data-qc-action="up"
                      disabled={index === 0}
                      onClick={() => {
                        save(moveQuickCommand(commands, command.id, -1));
                        moveFocus([`${rowSelector(command.id)} [data-qc-action="up"]`, `${rowSelector(command.id)} [data-qc-action="down"]`]);
                      }}
                    >
                      <ArrowGlyph />
                    </button>
                    <button
                      type="button"
                      className="spark-icon-btn st-icon-btn"
                      aria-label={`Move ${command.label} down`}
                      title="Move down"
                      data-qc-action="down"
                      disabled={index === commands.length - 1}
                      onClick={() => {
                        save(moveQuickCommand(commands, command.id, 1));
                        moveFocus([`${rowSelector(command.id)} [data-qc-action="down"]`, `${rowSelector(command.id)} [data-qc-action="up"]`]);
                      }}
                    >
                      <ArrowGlyph down />
                    </button>
                    <button
                      type="button"
                      className="spark-icon-btn st-icon-btn"
                      aria-label={`Edit ${command.label}`}
                      title="Edit"
                      data-qc-action="edit"
                      onClick={() => {
                        setDraftNew(null);
                        setEditing({ id: command.id, isNew: false });
                      }}
                    >
                      <PencilGlyph />
                    </button>
                    <button
                      type="button"
                      className="spark-icon-btn st-icon-btn st-icon-btn--danger"
                      aria-label={`Delete ${command.label}`}
                      title="Delete"
                      onClick={() => {
                        setDeleted({ command, index });
                        save(removeQuickCommand(commands, command.id));
                        moveFocus(["[data-qc-action=\"undo\"]"]);
                      }}
                    >
                      <TrashGlyph />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Terminal">
        <SettingRow
          title="Right-click in a terminal"
          desc={
            rightClick === "menu"
              ? "Opens the menu with Copy, Paste and your quick commands. Shift+right-click copies the selection or pastes."
              : "Copies the selection, or pastes when nothing is selected. Shift+right-click opens the quick command menu."
          }
          control={
            <Segmented
              ariaLabel="Right-click in a terminal"
              value={rightClick}
              onChange={(next) => void setPreference("terminalRightClick", next)}
              options={[
                { value: "paste", label: "Copy or paste" },
                { value: "menu", label: "Open menu" },
              ]}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
