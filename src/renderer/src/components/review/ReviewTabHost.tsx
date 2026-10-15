import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GroupedVirtuosoHandle } from "react-virtuoso";
import type { GitStatus } from "@shared/types";
import { isRemotePath } from "@shared/remote";
import {
  formatReviewNotes,
  sortReviewNotes,
  type ReviewDiff,
  type ReviewDiffFile,
  type ReviewDiffMode,
  type ReviewNote,
} from "@shared/review-notes";
import { useOptionalSelectionRouting } from "../../routing/SelectionRoutingContext";
import { IconButton, RefreshIcon, Spinner } from "../git/git-ui";
import ReviewDiffList, { type HunkAction, type ReviewListContext } from "./ReviewDiffList";
import ReviewMenu, { type MenuRow } from "./ReviewMenus";
import ReviewNotesPanel from "./ReviewNotesPanel";
import {
  anchorFor,
  anchorLineIndex,
  anchorRange,
  fileRows,
  fileStructure,
  hunkPatch,
  quoteFor,
  reviewRepoFolder,
  shortLocation,
  type DraftAnchor,
  type FileGroup,
  type LineSelection,
  type NoteAnchor,
  type ReviewRow,
} from "./review-model";
import {
  addReviewNote,
  changeReviewNotes,
  clearReviewNotes,
  deleteReviewNote,
  removeDeliveredNotes,
  reviewNotesError,
  updateReviewNote,
  useReviewNotes,
} from "./review-notes-store";
import {
  defaultReviewDestination,
  newAgentCommand,
  REVIEW_GROUP_TITLES,
  reviewDeliveryTarget,
  reviewDestinations,
  type ReviewDestination,
} from "./review-send";
import "./review.css";

// The review tab: every change of the workspace in one scrolling diff, with
// notes on lines that go to an agent as one batch. Per-file staging stays in
// the single-file diff tab; here hunks stage, unstage and discard only where
// the combined diff is exactly one side of the index (see hunkModeFor).

interface Props {
  cwd: string;
  status: GitStatus | null;
  gitVersion: number;
  visible: boolean;
  onOpenFile: (absolutePath: string) => void;
  onOpenFileDiff?: (path: string, staged: boolean) => void;
  onChanged: () => void;
  /** Starts an agent CLI in a new terminal tab of the workspace. */
  onLaunchAgent?: (command: string, cwd: string) => void;
}

interface Draft extends NoteAnchor {
  quote: string;
}

interface ViewPrefs {
  mode: ReviewDiffMode;
  base: string | null;
}

const PREFS_KEY = "codara.review.view:";
const PANEL_KEY = "codara.review.notesPanel";
const NO_NOTES: ReviewNote[] = [];
/** Loaded sections read again on a refresh, at most. */
const MAX_RELOAD_PATHS = 200;

function readPrefs(workspaceId: string | null): ViewPrefs {
  try {
    const raw = workspaceId ? localStorage.getItem(PREFS_KEY + workspaceId) : null;
    const value = raw ? (JSON.parse(raw) as Partial<ViewPrefs>) : null;
    return { mode: value?.mode === "base" ? "base" : "uncommitted", base: typeof value?.base === "string" ? value.base : null };
  } catch {
    return { mode: "uncommitted", base: null };
  }
}

function writePrefs(workspaceId: string | null, prefs: ViewPrefs): void {
  if (!workspaceId) return;
  try {
    localStorage.setItem(PREFS_KEY + workspaceId, JSON.stringify(prefs));
  } catch {
    // The choice just is not remembered.
  }
}

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinPath(root: string, relative: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${sep === "\\" ? relative.replace(/\//g, "\\") : relative}`;
}

/** Each path's notes, keeping the previous list object when its notes did not change, so unchanged files keep their rows. */
function stableNotesByPath(previous: Map<string, ReviewNote[]>, notes: readonly ReviewNote[]): Map<string, ReviewNote[]> {
  const next = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    if (note.source !== "diff") continue;
    const list = next.get(note.filePath) ?? [];
    list.push(note);
    next.set(note.filePath, list);
  }
  for (const [path, list] of next) {
    list.sort((a, b) => a.endLine - b.endLine || a.startLine - b.startLine || a.createdAt - b.createdAt);
    const before = previous.get(path);
    if (before && before.length === list.length && before.every((note, index) => note === list[index])) next.set(path, before);
  }
  return next;
}

/** Where the review's hunks can be staged from: the files whose whole change sits on one side of the index. */
function hunkModeFor(file: ReviewDiffFile, mode: ReviewDiffMode, status: GitStatus | null, conflicted: ReadonlySet<string>): "stage" | "unstage" | null {
  if (mode !== "uncommitted" || !status?.isRepo) return null;
  if (file.status !== "modified" || file.binary || file.truncated || !file.lines || conflicted.has(file.path)) return null;
  if (fileStructure(file).conflicted) return null;
  const unstaged = status.unstaged.some((change) => change.path === file.path && !change.untracked);
  const staged = status.staged.some((change) => change.path === file.path);
  if (unstaged && !staged) return "stage";
  if (staged && !unstaged) return "unstage";
  return null;
}

function statusSignature(status: GitStatus | null): string {
  if (!status) return "";
  const side = (list: GitStatus["staged"]) => list.map((change) => `${change.status}:${change.path}`).join("|");
  return `${status.branch ?? ""}#${side(status.staged)}#${side(status.unstaged)}`;
}

export default function ReviewTabHost({ cwd, status, gitVersion, visible, onOpenFile, onOpenFileDiff, onChanged, onLaunchAgent }: Props): React.ReactElement {
  const routing = useOptionalSelectionRouting();
  const workspaceId = routing?.workspaceId ?? null;
  const { notes, error: notesError } = useReviewNotes(workspaceId);

  const [prefs, setPrefs] = useState<ViewPrefs>(() => readPrefs(workspaceId));
  useEffect(() => setPrefs(readPrefs(workspaceId)), [workspaceId]);
  const { mode } = prefs;
  const updatePrefs = useCallback(
    (next: ViewPrefs) => {
      setPrefs(next);
      writePrefs(workspaceId, next);
    },
    [workspaceId],
  );

  const [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(1);
  const generation = useRef(0);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, ReviewDiffFile>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set());
  const forced = useRef(new Set<string>());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone?: "error"; undo?: ReviewNote } | null>(null);
  const [panelOpen, setPanelOpen] = useState(readPanelOpen);
  const [menu, setMenu] = useState<{ kind: "send" | "base"; anchor: HTMLElement } | null>(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef<GroupedVirtuosoHandle>(null);

  // ── Loading ────────────────────────────────────────────────────────────

  const requestKey = `${cwd}\n${mode}\n${mode === "base" ? prefs.base ?? "" : ""}`;
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const load = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    let result: ReviewDiff;
    try {
      result = await window.spark.review.diff({ cwd, mode, base: mode === "base" ? prefs.base : null, listBases: mode === "base" });
    } catch (err) {
      result = { mode, isRepo: true, base: null, files: [], error: (err as Error).message };
    }
    if (gen !== generation.current) return;
    // Sections already on screen, and the ones the user asked to see in
    // full, are read again with the rest and swapped in together, so a
    // refresh never flashes them back to placeholders.
    const shown = overridesRef.current;
    const deferred = result.files.filter((file) => file.deferred).map((file) => file.path);
    const asked = deferred.filter((path) => forced.current.has(path)).slice(0, MAX_RELOAD_PATHS);
    const seen = deferred.filter((path) => !forced.current.has(path) && shown.has(path)).slice(0, MAX_RELOAD_PATHS);
    const read = (paths: string[], force: boolean) =>
      paths.length
        ? window.spark.review
            .diff({ cwd, mode, base: result.base, paths, force })
            .then((extra) => extra.files.filter((file) => paths.includes(file.path)))
            .catch(() => [] as ReviewDiffFile[])
        : Promise.resolve([] as ReviewDiffFile[]);
    const again = (await Promise.all([read(asked, true), read(seen, false)])).flat();
    if (gen !== generation.current) return;
    setDiff(result);
    setOverrides(new Map(again.map((file) => [file.path, file])));
    setLoadingPaths(new Set());
    setLoading(false);
  }, [cwd, mode, prefs.base]);

  // The view changed: load now, whatever is open.
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastKey.current === requestKey) return;
    const first = lastKey.current === null;
    lastKey.current = requestKey;
    // The first view loads through the initial dirty mark.
    if (first) return;
    forced.current.clear();
    setOverrides(new Map());
    setSelection(null);
    setDraft(null);
    setDirty((value) => value + 1);
  }, [requestKey]);

  // Anything that may have changed the diff marks it dirty; it reloads once
  // the tab is on screen and no note is being written, so a refresh never
  // moves lines under the user's pointer mid-sentence.
  const composing = draft !== null || editingId !== null;
  const loadedFor = useRef(0);
  useEffect(() => {
    if (!visible || composing || dirty === loadedFor.current) return;
    // Marks that arrive together (a git action bumps the status and the
    // version) make one read.
    const timer = setTimeout(
      () => {
        loadedFor.current = dirty;
        void load();
      },
      loadedFor.current === 0 ? 0 : 150,
    );
    return () => clearTimeout(timer);
  }, [composing, dirty, load, visible]);

  // A refresh the user asks for runs even with a note open.
  const refresh = useCallback(() => {
    const next = dirty + 1;
    loadedFor.current = next;
    setDirty(next);
    void load();
  }, [dirty, load]);

  // Coming back to the tab reads the diff again: an agent may have changed
  // files that were already changed, which moves neither the status nor the
  // git version, and the file watcher only runs while the file tree is open.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) setDirty((value) => value + 1);
    wasVisible.current = visible;
  }, [visible]);

  const signature = statusSignature(status);
  const firstSignal = useRef(true);
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false;
      return;
    }
    setDirty((value) => value + 1);
  }, [gitVersion, signature]);

  const root = reviewRepoFolder(diff?.root, cwd);
  useEffect(() => {
    const top = norm(root);
    const under = (path: string) => {
      const value = norm(path);
      return value === top || value.startsWith(`${top}/`) || top.startsWith(`${value}/`);
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Dependency folders change in bursts during installs and builds and are
    // ignored by git anyway.
    const relevant = (dir: string) => !/(^|\/)node_modules(\/|$)/.test(norm(dir));
    const off = window.spark.fs.onChanged((event) => {
      if (!under(event.root) && !event.dirs.some(under)) return;
      if (event.dirs.length && !event.dirs.some(relevant)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setDirty((value) => value + 1), 1000);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [root]);

  // Deferred sections load in small batches as they scroll into view.
  const queue = useRef(new Map<string, boolean>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diffRef = useRef(diff);
  diffRef.current = diff;
  const fetchPaths = useCallback(
    (current: ReviewDiff, paths: string[], force: boolean) => {
      const gen = generation.current;
      setLoadingPaths((prev) => new Set([...prev, ...paths]));
      const settle = (loaded: ReadonlyMap<string, ReviewDiffFile>, error: string | null) => {
        if (gen !== generation.current) return;
        setOverrides((prev) => {
          const next = new Map(prev);
          for (const path of paths) {
            const file = loaded.get(path);
            const original = current.files.find((candidate) => candidate.path === path);
            if (file) next.set(path, file);
            else if (original) next.set(path, { ...original, deferred: undefined, lines: [], ...(error ? { error } : {}) });
          }
          return next;
        });
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          for (const path of paths) next.delete(path);
          return next;
        });
      };
      void window.spark.review
        .diff({ cwd, mode: current.mode, base: current.base, paths, force })
        .then((result) => settle(new Map(result.files.map((file) => [file.path, file])), result.error ?? null))
        .catch((err: Error) => settle(new Map(), err.message));
    },
    [cwd],
  );
  const onLoadFile = useCallback(
    (path: string, force: boolean) => {
      if (force) forced.current.add(path);
      queue.current.set(path, force || queue.current.get(path) === true);
      if (flushTimer.current) return;
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        const queued = [...queue.current];
        queue.current.clear();
        const current = diffRef.current;
        if (!current) return;
        const asked = queued.filter(([, force]) => force).map(([path]) => path);
        const shown = queued.filter(([, force]) => !force).map(([path]) => path);
        if (asked.length) fetchPaths(current, asked, true);
        if (shown.length) fetchPaths(current, shown, false);
      }, 40);
    },
    // A new diff gives placeholders a new loader, so the ones still on screen ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diff, fetchPaths],
  );
  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  // ── Rows ───────────────────────────────────────────────────────────────

  const files = useMemo(() => (diff?.files ?? []).map((file) => overrides.get(file.path) ?? file), [diff, overrides]);
  const fileByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

  const notesRef = useRef(new Map<string, ReviewNote[]>());
  const byPath = useMemo(() => {
    const next = stableNotesByPath(notesRef.current, notes);
    notesRef.current = next;
    return next;
  }, [notes]);

  const draftAnchorFor = useCallback(
    (file: ReviewDiffFile, current: Draft): DraftAnchor => {
      if (current.startLine === 0 && current.endLine === 0) return { ...current, afterLineIndex: -1 };
      return { ...current, afterLineIndex: file.lines ? anchorLineIndex(file, current) : -1 };
    },
    [],
  );

  const rowCache = useRef(new Map<string, { file: ReviewDiffFile; collapsed: boolean; notes: ReviewNote[]; draftAt: number | null; loading: boolean; rows: ReviewRow[] }>());
  const groups = useMemo((): FileGroup[] => {
    const next = new Map<string, { file: ReviewDiffFile; collapsed: boolean; notes: ReviewNote[]; draftAt: number | null; loading: boolean; rows: ReviewRow[] }>();
    const out: FileGroup[] = [];
    for (const file of files) {
      const isCollapsed = collapsed.has(file.path);
      const fileNotes = byPath.get(file.path) ?? NO_NOTES;
      const anchor = draft && draft.path === file.path ? draftAnchorFor(file, draft) : null;
      const draftAt = anchor ? anchor.afterLineIndex : null;
      const isLoading = loadingPaths.has(file.path);
      const cached = rowCache.current.get(file.path);
      const rows =
        cached &&
        cached.file === file &&
        cached.collapsed === isCollapsed &&
        cached.notes === fileNotes &&
        cached.draftAt === draftAt &&
        cached.loading === isLoading
          ? cached.rows
          : fileRows(file, { collapsed: isCollapsed, notes: fileNotes, draft: anchor, loading: isLoading });
      next.set(file.path, { file, collapsed: isCollapsed, notes: fileNotes, draftAt, loading: isLoading, rows });
      out.push({ file, collapsed: isCollapsed, noteCount: fileNotes.length, rows });
    }
    rowCache.current = next;
    return out;
  }, [byPath, collapsed, draft, draftAnchorFor, files, loadingPaths]);

  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const keys = useMemo(() => groups.flatMap((group) => [`g:${group.file.path}`, ...group.rows.map((row) => row.key)]), [groups]);

  const notedRanges = useMemo(() => {
    const out = new Map<string, Array<readonly [number, number]>>();
    for (const [path, list] of byPath) {
      const file = fileByPath.get(path);
      if (!file?.lines) continue;
      const ranges: Array<readonly [number, number]> = [];
      for (const note of list) {
        if (note.startLine === 0 && note.endLine === 0) continue;
        const range = anchorRange(file, note);
        if (range) ranges.push(range);
      }
      if (ranges.length) out.set(path, ranges);
    }
    return out;
  }, [byPath, fileByPath]);

  const conflicted = useMemo(() => {
    const out = new Set<string>();
    for (const change of [...(status?.staged ?? []), ...(status?.unstaged ?? [])]) if (change.status === "conflicted") out.add(change.path);
    return out;
  }, [status]);

  // ── Notes ──────────────────────────────────────────────────────────────

  const openDraft = useCallback(
    (path: string, range: LineSelection) => {
      const file = fileByPath.get(path);
      if (!file) return;
      const anchor = anchorFor(file, range);
      if (!anchor) {
        setSelection(null);
        return;
      }
      setEditingId(null);
      setDraft({ ...anchor, quote: quoteFor(file, range) });
    },
    [fileByPath],
  );

  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const onLineDown = useCallback((path: string, lineIndex: number, shift: boolean) => {
    const current = selectionRef.current;
    const next = shift && current && current.path === path ? { ...current, to: lineIndex } : { path, from: lineIndex, to: lineIndex };
    setSelection(next);
    setDragging(true);
  }, []);
  const onLineEnter = useCallback((path: string, lineIndex: number) => {
    setSelection((current) => (current && current.path === path && current.to !== lineIndex ? { ...current, to: lineIndex } : current));
  }, []);
  useEffect(() => {
    if (!dragging) return;
    const up = () => {
      setDragging(false);
      const current = selectionRef.current;
      if (current) openDraft(current.path, current);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [dragging, openDraft]);
  const onLineKey = useCallback(
    (path: string, lineIndex: number, shift: boolean) => {
      const current = selectionRef.current;
      const next = shift && current && current.path === path ? { ...current, to: lineIndex } : { path, from: lineIndex, to: lineIndex };
      setSelection(next);
      openDraft(path, next);
    },
    [openDraft],
  );

  const closeDraft = useCallback(() => {
    setDraft(null);
    setSelection(null);
  }, []);

  const onSaveDraft = useCallback(
    async (text: string) => {
      if (!workspaceId || !draft) return;
      const saved = await addReviewNote(workspaceId, {
        source: "diff",
        filePath: draft.path,
        side: draft.side,
        startLine: draft.startLine,
        endLine: draft.endLine,
        quote: draft.quote,
        body: text,
      });
      if (!saved) {
        const why = reviewNotesError(workspaceId);
        setMessage({ text: why ? `The note was not saved. ${why}` : "The note was not saved. There may be too many notes already.", tone: "error" });
        return;
      }
      closeDraft();
    },
    [closeDraft, draft, workspaceId],
  );

  const onFileNote = useCallback((path: string) => {
    setCollapsed((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    setSelection(null);
    setEditingId(null);
    setDraft({ path, side: "new", startLine: 0, endLine: 0, quote: "" });
  }, []);

  const onEditNote = useCallback((id: string) => {
    setDraft(null);
    setSelection(null);
    setEditingId(id);
  }, []);
  const onSaveEdit = useCallback(
    async (id: string, text: string) => {
      if (workspaceId) await updateReviewNote(workspaceId, id, text);
      setEditingId(null);
    },
    [workspaceId],
  );
  const onCancelEdit = useCallback(() => setEditingId(null), []);

  const notesById = useRef(new Map<string, ReviewNote>());
  notesById.current = new Map(notes.map((note) => [note.id, note]));
  const deleteNote = useCallback(
    (note: ReviewNote) => {
      if (!workspaceId) return;
      void deleteReviewNote(workspaceId, note.id);
      setEditingId((current) => (current === note.id ? null : current));
      setMessage({ text: `Deleted the note on ${shortLocation(note).toLowerCase()}.`, undo: note });
    },
    [workspaceId],
  );
  const onDeleteNote = useCallback(
    (id: string) => {
      const note = notesById.current.get(id);
      if (note) deleteNote(note);
    },
    [deleteNote],
  );
  const undoDelete = useCallback(
    (note: ReviewNote) => {
      if (!workspaceId) return;
      setMessage(null);
      void changeReviewNotes(workspaceId, (current) => (current.some((candidate) => candidate.id === note.id) ? current : [...current, note]));
    },
    [workspaceId],
  );

  // Jumping to a note: open its file if it is collapsed, then scroll once the
  // rows include it.
  const jumpTo = useCallback(
    (note: ReviewNote) => {
      if (note.source === "markdown") {
        onOpenFile(note.filePath);
        return;
      }
      if (!fileByPath.has(note.filePath)) {
        setMessage({ text: `${note.filePath} is not in this diff.` });
        return;
      }
      setCollapsed((prev) => {
        if (!prev.has(note.filePath)) return prev;
        const next = new Set(prev);
        next.delete(note.filePath);
        return next;
      });
      setPendingJump(note.id);
    },
    [fileByPath, onOpenFile],
  );
  useEffect(() => {
    if (!pendingJump) return;
    const index = rows.findIndex((row) => row.kind === "note" && row.note.id === pendingJump);
    if (index < 0) return;
    setPendingJump(null);
    listRef.current?.scrollToIndex({ index, align: "center" });
    setFlashId(pendingJump);
  }, [pendingJump, rows]);
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(timer);
  }, [flashId]);

  // ── Git actions ────────────────────────────────────────────────────────

  const run = useCallback(
    async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
      if (busy) return;
      setBusy(id);
      setMessage(null);
      try {
        const result = await fn();
        if (result.ok) {
          setConfirmDiscard(null);
          onChanged();
          setDirty((value) => value + 1);
        } else setMessage({ text: result.error ?? "That did not work.", tone: "error" });
      } catch (err) {
        setMessage({ text: (err as Error).message, tone: "error" });
      } finally {
        setBusy(null);
      }
    },
    [busy, onChanged],
  );

  const hunkMode = useCallback((file: ReviewDiffFile) => hunkModeFor(file, mode, status, conflicted), [conflicted, mode, status]);

  const onHunk = useCallback(
    (path: string, hunkIndex: number, action: HunkAction) => {
      const file = fileByPath.get(path);
      const hunk = file?.lines ? fileStructure(file).hunks[hunkIndex] : undefined;
      if (!file || !hunk) return;
      const id = `${path}:${hunkIndex}`;
      if (action === "discard" && confirmDiscard !== id) {
        setConfirmDiscard(id);
        return;
      }
      const patch = hunkPatch(file, hunk);
      const options =
        action === "stage" ? { cached: true, reverse: false } : action === "unstage" ? { cached: true, reverse: true } : { cached: false, reverse: true };
      void run(`hunk:${id}:${action}`, () => window.spark.git.applyPatch(root, patch, options));
    },
    [confirmDiscard, fileByPath, root, run],
  );

  const onResolve = useCallback(
    (path: string, side: "ours" | "theirs") => {
      void run(`conflict:${path}:${side}`, () => window.spark.git.resolveConflict(root, path, side));
    },
    [root, run],
  );

  const changeOf = useCallback(
    (file: ReviewDiffFile) => {
      const unstaged = status?.unstaged.find((change) => change.path === file.path);
      if (unstaged) return { staged: false };
      const staged = status?.staged.find((change) => change.path === file.path);
      return staged ? { staged: true } : null;
    },
    [status],
  );
  const canOpenFileDiff = useCallback((file: ReviewDiffFile) => Boolean(onOpenFileDiff) && changeOf(file) !== null, [changeOf, onOpenFileDiff]);
  const openFileDiff = useCallback(
    (file: ReviewDiffFile) => {
      const change = changeOf(file);
      if (change && onOpenFileDiff) onOpenFileDiff(file.path, change.staged);
    },
    [changeOf, onOpenFileDiff],
  );
  const openFile = useCallback((file: ReviewDiffFile) => onOpenFile(joinPath(root, file.path)), [onOpenFile, root]);

  const onToggleFile = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // ── Sending ────────────────────────────────────────────────────────────

  const destinations = useMemo((): { list: ReviewDestination[]; defaultId: string | null } => {
    if (!menu || menu.kind !== "send") return { list: [], defaultId: null };
    const routed = routing ? routing.destinationsFor(null) : { destinations: [], defaultId: "" };
    const list = reviewDestinations(routed.destinations, Boolean(workspaceId), { remote: isRemotePath(cwd) });
    return { list, defaultId: defaultReviewDestination(list, routed.defaultId) };
  }, [cwd, menu, routing, workspaceId]);

  const scope = useMemo(() => {
    if (notes.some((note) => note.source !== "diff")) return null;
    if (mode === "uncommitted") return "uncommitted changes";
    return diff?.base ? `changes against ${diff.base}` : "branch changes";
  }, [diff?.base, mode, notes]);

  const send = useCallback(
    async (destination: ReviewDestination) => {
      if (!workspaceId || !notes.length || sending) return;
      const batch = sortReviewNotes(notes);
      const text = formatReviewNotes(batch, { scope, workspaceCwd: cwd });
      setSending(true);
      setMessage(null);
      try {
        if (destination.kind === "agent-new") {
          if (!onLaunchAgent || !destination.runtime) throw new Error("A new agent cannot be started from here.");
          const path = await window.spark.review.handoff(workspaceId, text);
          const command = newAgentCommand(destination.runtime, path);
          if (!command) throw new Error("The notes file is in a folder whose name a shell would change. Send to an open agent instead.");
          onLaunchAgent(command, cwd);
        } else if (destination.kind === "chat-new") {
          if (!routing) throw new Error("Cora is not available here.");
          await routing.route({ source: "tab", text }, "chat-new");
        } else {
          const target = reviewDeliveryTarget(destination);
          if (!target) throw new Error("That destination is gone.");
          await window.spark.agentDelivery.deliver({ workspaceId, target, text, submit: destination.submit === true, source: "review" });
        }
        await removeDeliveredNotes(workspaceId, batch);
        setMessage({ text: `Sent ${batch.length === 1 ? "1 note" : `${batch.length} notes`} to ${destination.label}.` });
      } catch (err) {
        setMessage({ text: (err as Error).message || "The notes were not sent.", tone: "error" });
      } finally {
        setSending(false);
      }
    },
    [cwd, notes, onLaunchAgent, routing, scope, sending, workspaceId],
  );

  const copyAll = useCallback(() => {
    if (!notes.length) return;
    const text = formatReviewNotes(sortReviewNotes(notes), { scope, workspaceCwd: cwd });
    void window.spark.clipboard
      .writeText(text)
      .then(() => setMessage({ text: `Copied ${notes.length === 1 ? "1 note" : `${notes.length} notes`}.` }))
      .catch((err: Error) => setMessage({ text: err.message, tone: "error" }));
  }, [cwd, notes, scope]);

  const clearAll = useCallback(() => {
    if (!workspaceId) return;
    void clearReviewNotes(workspaceId);
    setEditingId(null);
    setMessage({ text: "Cleared every note." });
  }, [workspaceId]);

  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      try {
        localStorage.setItem(PANEL_KEY, open ? "closed" : "open");
      } catch {
        // Only this window remembers it.
      }
      return !open;
    });
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────

  const draftWhere = draft ? shortLocation(draft) : null;
  const draftKey = draft ? `diff:${workspaceId ?? ""}:${draft.path}:${draft.side}:${draft.startLine}-${draft.endLine}` : null;
  const context = useMemo(
    (): ReviewListContext => ({
      selection,
      notedRanges,
      draftWhere,
      draftKey,
      editingId,
      flashId,
      busy,
      confirmDiscard,
      hunkMode,
      conflicted,
      canOpenFileDiff,
      onToggleFile,
      onFileNote,
      onOpenFile: openFile,
      onOpenFileDiff: openFileDiff,
      onResolve,
      onSaveDraft,
      onCancelDraft: closeDraft,
      onEditNote,
      onSaveEdit,
      onCancelEdit,
      onDeleteNote,
      onHunk,
      onCancelDiscard: () => setConfirmDiscard(null),
      onLoadFile,
    }),
    [
      busy,
      canOpenFileDiff,
      closeDraft,
      confirmDiscard,
      conflicted,
      draftKey,
      draftWhere,
      editingId,
      flashId,
      hunkMode,
      notedRanges,
      onDeleteNote,
      onEditNote,
      onFileNote,
      onHunk,
      onLoadFile,
      onResolve,
      onSaveDraft,
      onSaveEdit,
      onCancelEdit,
      onToggleFile,
      openFile,
      openFileDiff,
      selection,
    ],
  );

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { additions, deletions };
  }, [files]);
  const allCollapsed = files.length > 0 && files.every((file) => collapsed.has(file.path));

  const baseRows = useMemo((): MenuRow[] => (diff?.bases ?? []).map((name) => ({ id: name, label: name })), [diff?.bases]);
  const baseLabel = mode === "base" ? diff?.base ?? prefs.base ?? "base" : null;

  let body: React.ReactNode;
  if (!diff) {
    body = (
      <div className="rv-empty">
        <Spinner size={14} />
        <span>Reading the changes…</span>
      </div>
    );
  } else if (!diff.isRepo) {
    body = <div className="rv-empty">{diff.error ?? "This workspace is not a git repository."}</div>;
  } else if (files.length === 0) {
    body = (
      <div className="rv-empty">
        {diff.error ? (
          <span style={{ color: "var(--danger)" }}>{diff.error}</span>
        ) : (
          <span>{mode === "uncommitted" ? "No uncommitted changes." : `No changes against ${diff.base ?? "the base branch"}.`}</span>
        )}
      </div>
    );
  } else {
    body = (
      <ReviewDiffList
        groups={groups}
        rows={rows}
        keys={keys}
        context={context}
        dragging={dragging}
        listRef={listRef}
        onLineDown={onLineDown}
        onLineEnter={onLineEnter}
        onLineKey={onLineKey}
      />
    );
  }

  return (
    <div className="rv-root" data-testid="review-tab">
      <div className="rv-toolbar">
        <div className="spark-segmented" role="group" aria-label="Which changes">
          <button
            type="button"
            className={`spark-segmented-item${mode === "uncommitted" ? " is-selected" : ""}`}
            aria-pressed={mode === "uncommitted"}
            onClick={() => updatePrefs({ ...prefs, mode: "uncommitted" })}
            title="Changes not committed yet, staged or not, and new files"
          >
            Uncommitted
          </button>
          <button
            type="button"
            className={`spark-segmented-item${mode === "base" ? " is-selected" : ""}`}
            aria-pressed={mode === "base"}
            onClick={() => updatePrefs({ ...prefs, mode: "base" })}
            title="Everything this branch changes since it left its base branch, committed or not"
          >
            Branch
          </button>
        </div>
        {mode === "base" ? (
          <button
            type="button"
            className="rv-chip-btn"
            aria-haspopup="listbox"
            aria-expanded={menu?.kind === "base"}
            data-testid="review-base"
            onClick={(event) => setMenu(menu?.kind === "base" ? null : { kind: "base", anchor: event.currentTarget })}
            title={diff?.mergeBase ? `Compared from ${diff.mergeBase}, where this branch left ${baseLabel}` : "Pick the branch to compare against"}
          >
            <span className="rv-chip-btn__label">vs {baseLabel}</span>
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M2.5 3.8 5 6.3l2.5-2.5" />
            </svg>
          </button>
        ) : null}
        <span className="rv-toolbar__summary" data-testid="review-summary">
          {files.length ? (
            <>
              {files.length === 1 ? "1 file" : `${files.length} files`}, <span className="rv-add-count">+{totals.additions}</span>{" "}
              <span className="rv-del-count">-{totals.deletions}</span>
            </>
          ) : null}
        </span>
        {loading ? <Spinner size={11} /> : null}
        {composing && dirty !== loadedFor.current ? (
          <button type="button" className="rv-chip-btn" onClick={refresh} title="Files changed on disk since this diff was read">
            Changed on disk, refresh
          </button>
        ) : null}
        <span className="rv-toolbar__spacer" />
        {message ? (
          <span className="rv-toolbar__summary" role="status" data-testid="review-status" style={message.tone === "error" ? { color: "var(--danger)" } : undefined}>
            {message.text}
            {message.undo ? (
              <>
                {" "}
                <button type="button" className="rv-textbtn" onClick={() => message.undo && undoDelete(message.undo)}>
                  Undo
                </button>
              </>
            ) : null}
          </span>
        ) : null}
        <span className="rv-toolbar__group">
          {files.length > 0 ? (
            <button
              type="button"
              className="rv-chip-btn"
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map((file) => file.path)))}
            >
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          ) : null}
          <IconButton title="Refresh" onClick={refresh} disabled={loading}>
            <RefreshIcon />
          </IconButton>
          <button type="button" className="rv-chip-btn" aria-pressed={panelOpen} onClick={togglePanel} title="Show or hide the notes list">
            Notes
            {notes.length ? <span className="rv-count" data-testid="review-note-count">{notes.length}</span> : null}
          </button>
          <button
            type="button"
            className="rv-chip-btn"
            aria-haspopup="listbox"
            aria-expanded={menu?.kind === "send"}
            disabled={!notes.length || sending || !workspaceId}
            data-testid="review-send"
            onClick={(event) => setMenu(menu?.kind === "send" ? null : { kind: "send", anchor: event.currentTarget })}
            style={notes.length ? { borderColor: "var(--accent-edge)", color: "var(--ink)" } : undefined}
          >
            {sending ? "Sending…" : "Send to agent"}
          </button>
        </span>
      </div>
      {diff?.error && files.length > 0 ? (
        <div className="rv-banner" data-tone="error">
          {diff.error}
        </div>
      ) : null}
      {notesError ? (
        <div className="rv-banner" data-tone="error" role="alert" data-testid="review-notes-error">
          {notesError}
        </div>
      ) : null}
      <div className="rv-body">
        {body}
        {panelOpen ? (
          <ReviewNotesPanel
            notes={notes}
            cwd={cwd}
            sending={sending}
            onJump={jumpTo}
            onUpdate={(id, text) => (workspaceId ? updateReviewNote(workspaceId, id, text) : Promise.resolve())}
            onDelete={deleteNote}
            onCopy={copyAll}
            onClearAll={clearAll}
            onSend={(anchor) => setMenu({ kind: "send", anchor })}
          />
        ) : null}
      </div>
      {menu?.kind === "send" ? (
        <ReviewMenu
          anchor={menu.anchor}
          label="Send the notes to"
          testId="review-send-menu"
          rows={destinations.list.map((destination) => ({
            id: destination.id,
            label: destination.label,
            sublabel: destination.sublabel,
            group: destination.group,
            disabled: destination.disabled,
            disabledReason: destination.disabledReason,
          }))}
          groups={(Object.keys(REVIEW_GROUP_TITLES) as Array<keyof typeof REVIEW_GROUP_TITLES>).map((id) => ({ id, title: REVIEW_GROUP_TITLES[id] }))}
          selectedId={destinations.defaultId}
          onChoose={(id) => {
            const destination = destinations.list.find((candidate) => candidate.id === id);
            setMenu(null);
            if (destination && !destination.disabled) void send(destination);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {menu?.kind === "base" ? (
        <ReviewMenu
          anchor={menu.anchor}
          label="Compare against"
          testId="review-base-menu"
          rows={baseRows}
          selectedId={diff?.base ?? null}
          filterPlaceholder="Filter branches"
          width={280}
          align="start"
          onChoose={(id) => {
            setMenu(null);
            updatePrefs({ mode: "base", base: id });
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
