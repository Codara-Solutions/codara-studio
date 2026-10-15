import React, { useEffect, useRef, useState } from "react";
import type { ReviewNote } from "@shared/review-notes";
import { shortLocation } from "./review-model";

// The note cards inline in the diff: a saved note (read, edit, delete) and
// the composer for a new one. Mod+Enter saves, Escape cancels.

const MOD_LABEL = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "Cmd" : "Ctrl";

// The words of composers not saved yet, by place. The diff is virtualized:
// a note being written unmounts when it scrolls far out of view, and its
// words must still be there when it scrolls back. Dropped on save and on
// cancel; a composer closed another way keeps them for when the same place
// is opened again.
const unsent = new Map<string, string>();
const MAX_UNSENT = 50;

function rememberUnsent(key: string, text: string): void {
  unsent.delete(key);
  if (text.trim()) unsent.set(key, text);
  while (unsent.size > MAX_UNSENT) {
    const oldest = unsent.keys().next().value;
    if (oldest === undefined) break;
    unsent.delete(oldest);
  }
}

/** Whether the user is typing in another field, which a composer mounting must not take over. */
function typingElsewhere(el: HTMLElement): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === el) return false;
  return active.isContentEditable || active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.tagName === "SELECT";
}

function useAutoFocus(ref: React.RefObject<HTMLTextAreaElement>, when: boolean): void {
  useEffect(() => {
    if (!when) return;
    const el = ref.current;
    if (!el || typingElsewhere(el)) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [ref, when]);
}

export function NoteComposer({
  label,
  initial = "",
  saveLabel,
  onSave,
  onCancel,
  testId,
  draftKey,
}: {
  label: string;
  initial?: string;
  saveLabel: string;
  onSave: (text: string) => Promise<void> | void;
  onCancel: () => void;
  testId?: string;
  /** Where the note is; its unsaved words outlive the composer under this key. */
  draftKey?: string;
}): React.ReactElement {
  const [text, setText] = useState(() => (draftKey ? unsent.get(draftKey) : undefined) ?? initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Focus on opening, and when it scrolls back into view, unless the user is
  // typing in another field meanwhile.
  useAutoFocus(ref, true);
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(text);
      if (draftKey) unsent.delete(draftKey);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (draftKey) unsent.delete(draftKey);
    onCancel();
  };
  return (
    <div data-testid={testId}>
      <textarea
        ref={ref}
        className="rv-textarea"
        aria-label={label}
        placeholder="What should the agent change here?"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (draftKey) rememberUnsent(draftKey, event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      />
      <div className="rv-draft__foot">
        <span className="rv-hint">{MOD_LABEL}+Enter to save, Esc to cancel</span>
        <button type="button" className="rv-textbtn" onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="rv-textbtn is-primary" disabled={!text.trim() || busy} onClick={() => void save()}>
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

export function DraftCard({
  where,
  draftKey,
  onSave,
  onCancel,
}: {
  where: string;
  draftKey?: string;
  onSave: (text: string) => Promise<void> | void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div className="rv-draft" data-testid="review-draft">
      <div className="rv-note__meta">
        <span className="rv-note__where">New note</span>
        <span>{where}</span>
      </div>
      <NoteComposer label={`Note on ${where}`} saveLabel="Add note" onSave={onSave} onCancel={onCancel} draftKey={draftKey} />
    </div>
  );
}

export const NoteCard = React.memo(function NoteCard({
  note,
  outdated,
  flash,
  editing,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
}: {
  note: ReviewNote;
  outdated: boolean;
  flash: boolean;
  editing: boolean;
  onEdit: (id: string) => void;
  onSaveEdit: (id: string, text: string) => Promise<void>;
  onCancelEdit: () => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  return (
    <div
      className={`rv-note${outdated ? " is-outdated" : ""}${flash ? " is-flash" : ""}`}
      data-testid="review-note"
      data-note-id={note.id}
    >
      <div className="rv-note__meta">
        <span className="rv-note__where">{shortLocation(note)}</span>
        {outdated ? <span title="The lines this note is on are not in the diff any more.">Lines changed since</span> : null}
        {!editing ? (
          <span className="rv-note__actions">
            <button type="button" className="rv-textbtn" onClick={() => onEdit(note.id)} aria-label={`Edit note on ${shortLocation(note)}`}>
              Edit
            </button>
            <button type="button" className="rv-textbtn is-danger" onClick={() => onDelete(note.id)} aria-label={`Delete note on ${shortLocation(note)}`}>
              Delete
            </button>
          </span>
        ) : null}
      </div>
      {editing ? (
        <NoteComposer
          label={`Edit note on ${shortLocation(note)}`}
          initial={note.body}
          saveLabel="Save"
          onSave={(text) => onSaveEdit(note.id, text)}
          onCancel={onCancelEdit}
          draftKey={`edit:${note.id}`}
        />
      ) : (
        <div className="rv-note__body">{note.body}</div>
      )}
    </div>
  );
});

/** A speech bubble over lines: the review tab's button in Source Control. */
export function ReviewNotesIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 3.2a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v5.3a1 1 0 0 1-1 1H6.2L3.8 11.6V9.5h-.3a1 1 0 0 1-1-1V3.2Z" />
      <path d="M5 5.2h4M5 7.1h2.6" />
    </svg>
  );
}
