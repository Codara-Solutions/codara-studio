import React, { useMemo, useState } from "react";
import { displayNotePath, sortReviewNotes, type ReviewNote } from "@shared/review-notes";
import { NoteComposer } from "./ReviewNoteCards";
import { shortLocation } from "./review-model";

// Every note of the workspace beside the diff, by file: diff notes and the
// ones written on rendered Markdown. A row jumps to its note; edit and delete
// work here too, so Markdown notes can be managed without reopening the file.

interface Props {
  notes: readonly ReviewNote[];
  cwd: string | null;
  sending: boolean;
  onJump: (note: ReviewNote) => void;
  onUpdate: (id: string, text: string) => Promise<void>;
  onDelete: (note: ReviewNote) => void;
  onCopy: () => void;
  onClearAll: () => void;
  onSend: (anchor: HTMLElement) => void;
}

function firstQuoteLine(note: ReviewNote): string {
  const line = note.quote.split("\n").find((candidate) => candidate.trim()) ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

export default function ReviewNotesPanel({ notes, cwd, sending, onJump, onUpdate, onDelete, onCopy, onClearAll, onSend }: Props): React.ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const groups = useMemo(() => {
    const out: Array<{ path: string; markdown: boolean; notes: ReviewNote[] }> = [];
    for (const note of sortReviewNotes(notes)) {
      const path = displayNotePath(note, cwd);
      const last = out[out.length - 1];
      if (last && last.path === path && last.markdown === (note.source === "markdown")) last.notes.push(note);
      else out.push({ path, markdown: note.source === "markdown", notes: [note] });
    }
    return out;
  }, [cwd, notes]);

  return (
    <aside className="rv-notes" aria-label="Review notes" data-testid="review-notes-panel">
      <div className="rv-notes__head">
        <span className="rv-notes__title">Notes</span>
        {notes.length ? <span className="rv-count">{notes.length}</span> : null}
      </div>
      <div className="rv-notes__list">
        {notes.length === 0 ? (
          <div className="rv-notes__empty">
            No notes yet. Hover a line in the diff and press +, or drag down the + buttons to cover several lines. Notes stay here until you send or clear them.
          </div>
        ) : (
          groups.map((group) => (
            <div key={`${group.markdown ? "md" : "diff"}:${group.path}`} role="group" aria-label={group.path}>
              <div className="rv-notes__file" title={group.path}>
                {group.path}
                {group.markdown ? " (Markdown)" : ""}
              </div>
              {group.notes.map((note) =>
                editingId === note.id ? (
                  <div key={note.id} className="rv-draft" style={{ margin: "2px 0 6px" }}>
                    <div className="rv-note__meta">
                      <span className="rv-note__where">{shortLocation(note)}</span>
                    </div>
                    <NoteComposer
                      label={`Edit note on ${shortLocation(note)}`}
                      initial={note.body}
                      saveLabel="Save"
                      onSave={async (text) => {
                        await onUpdate(note.id, text);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                ) : (
                  <div key={note.id} className="rv-notes__row" data-testid="review-panel-note" data-note-id={note.id}>
                    <button
                      type="button"
                      className="rv-notes__item"
                      onClick={() => onJump(note)}
                      title={note.source === "markdown" ? "Open the file" : "Show in the diff"}
                    >
                      <span className="rv-notes__where">{shortLocation(note)}</span>
                      {firstQuoteLine(note) ? <div className="rv-notes__quote">{firstQuoteLine(note)}</div> : null}
                      <div className="rv-notes__text">{note.body}</div>
                    </button>
                    <span className="rv-note__actions rv-notes__row-actions">
                      <button type="button" className="rv-textbtn" onClick={() => setEditingId(note.id)} aria-label={`Edit note on ${group.path} ${shortLocation(note)}`}>
                        Edit
                      </button>
                      <button type="button" className="rv-textbtn is-danger" onClick={() => onDelete(note)} aria-label={`Delete note on ${group.path} ${shortLocation(note)}`}>
                        Delete
                      </button>
                    </span>
                  </div>
                ),
              )}
            </div>
          ))
        )}
      </div>
      <div className="rv-notes__foot" onMouseLeave={() => setConfirmClear(false)}>
        <button type="button" className="rv-textbtn" disabled={!notes.length} onClick={onCopy} title="Copy the notes as the agent would get them">
          Copy
        </button>
        <button
          type="button"
          className={`rv-textbtn${confirmClear ? " is-danger" : ""}`}
          disabled={!notes.length}
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            setConfirmClear(false);
            onClearAll();
          }}
          onBlur={() => setConfirmClear(false)}
        >
          {confirmClear ? "Click again to clear" : "Clear all"}
        </button>
        <span style={{ flex: "1 1 auto" }} />
        <button
          type="button"
          className="rv-textbtn is-primary"
          disabled={!notes.length || sending}
          onClick={(event) => onSend(event.currentTarget)}
          aria-haspopup="listbox"
          data-testid="review-send-panel"
        >
          {sending ? "Sending…" : "Send to agent"}
        </button>
      </div>
    </aside>
  );
}
