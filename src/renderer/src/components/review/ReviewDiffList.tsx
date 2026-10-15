import React, { useEffect } from "react";
import { GroupedVirtuoso, type GroupedVirtuosoHandle } from "react-virtuoso";
import type { ReviewDiffFile, ReviewDiffLine } from "@shared/review-notes";
import { IconButton, MinusGlyph, OpenFileIcon, PlusGlyph, Spinner, UndoIcon, splitPath } from "../git/git-ui";
import { DraftCard, NoteCard, ReviewNotesIcon } from "./ReviewNoteCards";
import { statusWord, type FileGroup, type LineSelection, type ReviewRow } from "./review-model";

// The combined diff, virtualized: one sticky header per file and only the
// rows on screen in the DOM, so a diff of tens of thousands of lines scrolls
// like a short one. Lines carry their path and index as data attributes and
// the list handles the gutter's mouse and keyboard in one place, instead of
// a closure per row.

export type HunkAction = "stage" | "unstage" | "discard";

export interface ReviewListContext {
  selection: LineSelection | null;
  notedRanges: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;
  draftWhere: string | null;
  editingId: string | null;
  flashId: string | null;
  busy: string | null;
  confirmDiscard: string | null;
  hunkMode: (file: ReviewDiffFile) => "stage" | "unstage" | null;
  conflicted: ReadonlySet<string>;
  canOpenFileDiff: (file: ReviewDiffFile) => boolean;
  onToggleFile: (path: string) => void;
  onFileNote: (path: string) => void;
  onOpenFile: (file: ReviewDiffFile) => void;
  onOpenFileDiff: (file: ReviewDiffFile) => void;
  onResolve: (path: string, side: "ours" | "theirs") => void;
  onSaveDraft: (text: string) => Promise<void>;
  onCancelDraft: () => void;
  onEditNote: (id: string) => void;
  onSaveEdit: (id: string, text: string) => Promise<void>;
  onCancelEdit: () => void;
  onDeleteNote: (id: string) => void;
  onHunk: (path: string, hunkIndex: number, action: HunkAction) => void;
  onCancelDiscard: () => void;
  onLoadFile: (path: string, force: boolean) => void;
}

interface Props {
  groups: FileGroup[];
  rows: ReviewRow[];
  keys: string[];
  context: ReviewListContext;
  dragging: boolean;
  listRef: React.Ref<GroupedVirtuosoHandle>;
  onLineDown: (path: string, lineIndex: number, shift: boolean) => void;
  onLineEnter: (path: string, lineIndex: number) => void;
  onLineKey: (path: string, lineIndex: number, shift: boolean) => void;
}

function lineTarget(target: EventTarget | null): { path: string; lineIndex: number; add: boolean } | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>(".rv-line");
  if (!row?.dataset.path || row.dataset.lineIndex === undefined) return null;
  return { path: row.dataset.path, lineIndex: Number(row.dataset.lineIndex), add: Boolean(target.closest(".rv-add")) };
}

export default function ReviewDiffList({ groups, rows, keys, context, dragging, listRef, onLineDown, onLineEnter, onLineKey }: Props): React.ReactElement {
  return (
    <div
      className={`rv-list${dragging ? " is-dragging" : ""}`}
      data-testid="review-diff"
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        const hit = lineTarget(event.target);
        if (!hit?.add) return;
        // Keeps the text from being selected and the button from taking focus
        // while the pointer sweeps a range.
        event.preventDefault();
        onLineDown(hit.path, hit.lineIndex, event.shiftKey);
      }}
      onMouseOver={(event) => {
        if (!dragging) return;
        const hit = lineTarget(event.target);
        if (hit) onLineEnter(hit.path, hit.lineIndex);
      }}
      onClick={(event) => {
        // A click from the keyboard (Enter or Space on the + button) has no
        // pointer behind it; the pointer path already opened the note.
        if (event.detail !== 0) return;
        const hit = lineTarget(event.target);
        if (hit?.add) onLineKey(hit.path, hit.lineIndex, event.shiftKey);
      }}
    >
      <GroupedVirtuoso
        ref={listRef}
        style={{ height: "100%" }}
        context={context}
        groupCounts={groups.map((group) => group.rows.length)}
        increaseViewportBy={{ top: 600, bottom: 900 }}
        computeItemKey={(index) => keys[index] ?? index}
        groupContent={(index, ctx: ReviewListContext) => {
          const group = groups[index];
          return group ? <FileHeader group={group} ctx={ctx} /> : null;
        }}
        itemContent={(index, groupIndex, _data, ctx: ReviewListContext) => {
          const row = rows[index];
          const group = groups[groupIndex];
          if (!row || !group) return <div style={{ height: 1 }} />;
          return <RowView row={row} file={group.file} ctx={ctx} />;
        }}
      />
    </div>
  );
}

function FileHeader({ group, ctx }: { group: FileGroup; ctx: ReviewListContext }): React.ReactElement {
  const { file } = group;
  const { dir, name } = splitPath(file.path);
  const conflicted = ctx.conflicted.has(file.path);
  const tone = conflicted ? "danger" : file.status === "deleted" ? "danger" : file.status === "added" || file.status === "untracked" ? "ok" : file.status === "renamed" ? "info" : undefined;
  const busyConflict = ctx.busy?.startsWith(`conflict:${file.path}:`) ?? false;
  return (
    <div className="rv-file" data-testid="review-file" data-path={file.path}>
      <button
        type="button"
        className="rv-file__toggle"
        aria-expanded={!group.collapsed}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        onClick={() => ctx.onToggleFile(file.path)}
      >
        <span className="rv-caret" data-open={!group.collapsed} aria-hidden>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 3.8 5 6.3l2.5-2.5" />
          </svg>
        </span>
        <span className="rv-file__name">{name}</span>
        <span className="rv-file__dir">{file.oldPath ? `${file.oldPath} → ${dir}` : dir}</span>
      </button>
      <span className="rv-badge" data-tone={tone}>
        {conflicted ? "Conflict" : statusWord(file)}
      </span>
      {file.binary ? null : (
        <span className="rv-file__stats" aria-label={`${file.additions} added, ${file.deletions} removed`}>
          <span className="rv-add-count">+{file.additions}</span>
          <span className="rv-del-count">-{file.deletions}</span>
        </span>
      )}
      {group.noteCount > 0 ? (
        <span className="rv-count" title={`${group.noteCount} note${group.noteCount === 1 ? "" : "s"} on this file`}>
          {group.noteCount}
        </span>
      ) : null}
      <span className="rv-file__actions">
        {conflicted ? (
          <>
            <button type="button" className="rv-textbtn" disabled={ctx.busy !== null} onClick={() => ctx.onResolve(file.path, "ours")}>
              {busyConflict && ctx.busy?.endsWith(":ours") ? "Keeping…" : "Accept Current"}
            </button>
            <button type="button" className="rv-textbtn" disabled={ctx.busy !== null} onClick={() => ctx.onResolve(file.path, "theirs")}>
              {busyConflict && ctx.busy?.endsWith(":theirs") ? "Keeping…" : "Accept Incoming"}
            </button>
          </>
        ) : null}
        <IconButton title="Add a note on this file" onClick={() => ctx.onFileNote(file.path)} size={22}>
          <ReviewNotesIcon />
        </IconButton>
        {ctx.canOpenFileDiff(file) ? (
          <IconButton title="Open this file's diff, to stage single hunks" onClick={() => ctx.onOpenFileDiff(file)} size={22}>
            <DiffGlyph />
          </IconButton>
        ) : null}
        {file.status !== "deleted" ? (
          <IconButton title="Open file in editor" onClick={() => ctx.onOpenFile(file)} size={22}>
            <OpenFileIcon />
          </IconButton>
        ) : null}
      </span>
    </div>
  );
}

function inRanges(ranges: ReadonlyArray<readonly [number, number]> | undefined, index: number): boolean {
  if (!ranges) return false;
  for (const [a, b] of ranges) if (index >= a && index <= b) return true;
  return false;
}

function RowView({ row, file, ctx }: { row: ReviewRow; file: ReviewDiffFile; ctx: ReviewListContext }): React.ReactElement {
  switch (row.kind) {
    case "line": {
      const selection = ctx.selection;
      const selected =
        selection !== null &&
        selection.path === row.path &&
        row.lineIndex >= Math.min(selection.from, selection.to) &&
        row.lineIndex <= Math.max(selection.from, selection.to);
      return <LineRow row={row} selected={selected} noted={inRanges(ctx.notedRanges.get(row.path), row.lineIndex)} />;
    }
    case "hunk":
      return <HunkRow row={row} file={file} ctx={ctx} />;
    case "note":
      return (
        <div className="rv-card-wrap">
          <NoteCard
            note={row.note}
            outdated={row.outdated}
            flash={ctx.flashId === row.note.id}
            editing={ctx.editingId === row.note.id}
            onEdit={ctx.onEditNote}
            onSaveEdit={ctx.onSaveEdit}
            onCancelEdit={ctx.onCancelEdit}
            onDelete={ctx.onDeleteNote}
          />
        </div>
      );
    case "draft":
      return (
        <div className="rv-card-wrap">
          <DraftCard where={ctx.draftWhere ?? ""} onSave={ctx.onSaveDraft} onCancel={ctx.onCancelDraft} />
        </div>
      );
    case "placeholder":
      return <Placeholder row={row} ctx={ctx} />;
  }
}

function sign(line: ReviewDiffLine): string {
  return line.kind === "add" ? "+" : line.kind === "del" ? "-" : "";
}

function body(line: ReviewDiffLine): string {
  if (line.kind === "add" || line.kind === "del" || line.kind === "context") {
    const text = line.text.slice(1);
    return text === "" ? " " : text;
  }
  return line.text || " ";
}

const LineRow = React.memo(function LineRow({
  row,
  selected,
  noted,
}: {
  row: Extract<ReviewRow, { kind: "line" }>;
  selected: boolean;
  noted: boolean;
}): React.ReactElement {
  const { line } = row;
  const commentable = line.kind === "add" || line.kind === "del" || line.kind === "context";
  const number = row.newNo ?? row.oldNo;
  return (
    <div
      className={`rv-line${selected ? " is-selected" : ""}${noted ? " is-noted" : ""}`}
      data-kind={line.kind}
      data-path={row.path}
      data-line-index={row.lineIndex}
    >
      <span className="rv-gutter" aria-hidden>
        {row.oldNo ?? ""}
      </span>
      <span className="rv-gutter rv-gutter--new" aria-hidden>
        {row.newNo ?? ""}
      </span>
      {commentable ? (
        <button
          type="button"
          className="rv-add"
          aria-label={`Add a note on ${row.newNo == null ? "old " : ""}line ${number}`}
          title="Add a note. Drag or Shift+click to cover several lines."
        >
          +
        </button>
      ) : (
        <span style={{ flex: "0 0 18px" }} />
      )}
      <span className="rv-sign" aria-hidden>
        {sign(line)}
      </span>
      <span className="rv-text">{body(line)}</span>
    </div>
  );
});

function HunkRow({ row, file, ctx }: { row: Extract<ReviewRow, { kind: "hunk" }>; file: ReviewDiffFile; ctx: ReviewListContext }): React.ReactElement {
  const mode = ctx.hunkMode(file);
  const id = `${row.path}:${row.hunkIndex}`;
  const armed = ctx.confirmDiscard === id;
  const busy = (action: HunkAction) => ctx.busy === `hunk:${id}:${action}`;
  const { added, removed } = row.hunk;
  return (
    <div
      className="rv-hunk"
      onMouseLeave={() => {
        if (armed) ctx.onCancelDiscard();
      }}
    >
      <span className="rv-hunk__text" title={row.hunk.header}>
        {row.hunk.header}
      </span>
      <span style={{ flex: "0 0 auto", fontSize: 9.5, opacity: 0.8 }}>
        {added > 0 ? `+${added}` : ""}
        {added > 0 && removed > 0 ? " " : ""}
        {removed > 0 ? `-${removed}` : ""}
      </span>
      {mode ? (
        <span className="rv-hunk__actions">
          {mode === "unstage" ? (
            <IconButton title="Unstage this hunk" onClick={() => ctx.onHunk(row.path, row.hunkIndex, "unstage")} disabled={ctx.busy !== null} size={18}>
              {busy("unstage") ? <Spinner size={11} /> : <MinusGlyph />}
            </IconButton>
          ) : (
            <>
              <IconButton
                title={armed ? "Click again to discard this hunk" : "Discard this hunk"}
                danger
                active={armed}
                disabled={ctx.busy !== null}
                onClick={() => ctx.onHunk(row.path, row.hunkIndex, "discard")}
                size={18}
              >
                {busy("discard") ? <Spinner size={11} /> : <UndoIcon />}
              </IconButton>
              <IconButton title="Stage this hunk" onClick={() => ctx.onHunk(row.path, row.hunkIndex, "stage")} disabled={ctx.busy !== null} size={18}>
                {busy("stage") ? <Spinner size={11} /> : <PlusGlyph />}
              </IconButton>
            </>
          )}
        </span>
      ) : null}
    </div>
  );
}

function Placeholder({ row, ctx }: { row: Extract<ReviewRow, { kind: "placeholder" }>; ctx: ReviewListContext }): React.ReactElement {
  const { onLoadFile } = ctx;
  // A section deferred to keep the first load small fills in once it is on
  // screen; the list only mounts rows near the viewport.
  useEffect(() => {
    if (row.reason === "budget") onLoadFile(row.path, false);
  }, [onLoadFile, row.path, row.reason]);
  return (
    <div className="rv-placeholder" data-reason={row.reason}>
      {row.reason === "loading" || row.reason === "budget" ? <Spinner size={11} /> : null}
      <span>{row.text}</span>
      {row.reason === "large" ? (
        <button type="button" className="rv-textbtn" onClick={() => onLoadFile(row.path, true)}>
          Show diff
        </button>
      ) : null}
    </div>
  );
}

function DiffGlyph(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 2.5v5M2 5h5M2.5 11h5" />
      <path d="M9.5 2.5h2v9h-2" />
    </svg>
  );
}
