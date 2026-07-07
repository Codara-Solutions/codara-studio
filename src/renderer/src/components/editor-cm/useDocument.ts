import { useCallback, useEffect, useRef, useState } from "react";
import type { FsReadResult } from "@shared/types";

// Document state mirrors the discriminated read result: text/binary/toolarge
// are first-class so the editor can render a banner instead of opening with
// garbage. `error` covers IPC + filesystem failures.
export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

interface Options {
  path: string;
  onDirtyChange?: (path: string, dirty: boolean) => void;
  // Live autosave preferences, read at schedule time (not captured) so a
  // Settings toggle applies to already-open tabs without remounting them.
  getAutosavePrefs?: () => { enabled: boolean; delayMs: number };
  // Fired after a successful AUTOSAVE write (manual saves notify at the
  // keymap call sites). Lets the workbench refresh git state promptly.
  onAutosaved?: (path: string) => void;
  // True for files rendered by a visual previewer (image/pdf/media): the
  // text-read IPC round-trip is skipped entirely and `doc` stays "loading",
  // which no preview-only render branch ever consults.
  skip?: boolean;
}

export interface UseDocumentResult {
  doc: DocumentState;
  dirty: boolean;
  // True when the last autosave attempt found the file changed (or deleted)
  // on disk since load — autosave is paused until the user reloads or
  // force-saves. Manual save is never blocked.
  conflict: boolean;
  onChange: (next: string) => void;
  save: () => Promise<void>;
  reload: (force?: boolean) => boolean;
  // Fire a pending autosave debounce immediately (window blur / tab switch).
  flush: () => void;
}

// useDocument — reads `path` once on mount (and on path change), tracks the
// saved buffer vs in-flight content, and exposes save/reload primitives.
// The save call goes through `fs:writeText` (which now does an atomic write
// in the main process). Dirty flag is bubbled up to the workbench so tabs
// can show the unsaved-modification dot.
//
// Autosave: when enabled via preferences, edits schedule a debounced write
// that passes the mtime captured at load/last-save. The main process refuses
// the write if the disk copy changed underneath us (agent edit, git op,
// checkpoint restore) — that flips `conflict` on and autosave stays paused
// for this document until reload(force) or a manual save() resolves it.
export function useDocument({
  path,
  onDirtyChange,
  getAutosavePrefs,
  onAutosaved,
  skip = false,
}: Options): UseDocumentResult {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);

  const savedRef = useRef<string>("");
  const bufferRef = useRef<string>("");
  const dirtyRef = useRef(false);
  const conflictRef = useRef(false);
  const docStatusRef = useRef<DocumentState["status"]>("loading");
  // mtime of the disk copy the buffer was loaded from / last written to.
  // This is what autosave sends as expectedMtimeMs.
  const mtimeRef = useRef<number | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    docStatusRef.current = doc.status;
  }, [doc.status]);

  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  const getAutosavePrefsRef = useRef(getAutosavePrefs);
  useEffect(() => {
    getAutosavePrefsRef.current = getAutosavePrefs;
  }, [getAutosavePrefs]);
  const onAutosavedRef = useRef(onAutosaved);
  useEffect(() => {
    onAutosavedRef.current = onAutosaved;
  }, [onAutosaved]);
  // Bubble dirty transitions to the parent. Use both `dirty` and `path` so
  // the parent always knows which file the flip applies to.
  useEffect(() => {
    onDirtyChangeRef.current?.(path, dirty);
  }, [dirty, path]);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const setConflictState = useCallback((value: boolean) => {
    conflictRef.current = value;
    setConflict(value);
  }, []);

  // Load on path change or explicit reload.
  useEffect(() => {
    let cancelled = false;
    setDoc({ status: "loading" });
    setDirty(false);
    setConflictState(false);
    savedRef.current = "";
    bufferRef.current = "";
    mtimeRef.current = null;
    if (skip) return;

    void window.spark.fs
      .readEx(path)
      .then((res: FsReadResult) => {
        if (cancelled) return;
        if (res.kind === "text") {
          savedRef.current = res.content;
          bufferRef.current = res.content;
          mtimeRef.current = res.mtimeMs;
          setDoc({ status: "ready", content: res.content, size: res.size });
        } else if (res.kind === "binary") {
          setDoc({ status: "binary", size: res.size });
        } else if (res.kind === "toolarge") {
          setDoc({ status: "toolarge", size: res.size, limit: res.limit });
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setDoc({ status: "error", message: (e as Error)?.message ?? String(e) });
      });

    return () => {
      cancelled = true;
      // Covers both tab dispose (unmount) and rename-mid-debounce (path
      // change re-runs this effect): a pending autosave for the old path
      // must never fire against the new one.
      clearAutosaveTimer();
    };
  }, [path, reloadCounter, skip, clearAutosaveTimer, setConflictState]);

  // Re-read the file from disk. No-op (silent) if the buffer is dirty —
  // callers shouldn't clobber unsaved user edits — unless `force` is set
  // (the conflict strip's "Reload from disk" explicitly discards the buffer).
  const reload = useCallback(
    (force = false): boolean => {
      if (dirtyRef.current && !force) return false;
      clearAutosaveTimer();
      setConflictState(false);
      setReloadCounter((n) => n + 1);
      return true;
    },
    [clearAutosaveTimer, setConflictState],
  );

  const attemptAutosave = useCallback(async () => {
    autosaveTimerRef.current = null;
    if (!dirtyRef.current || docStatusRef.current !== "ready" || conflictRef.current) return;
    const content = bufferRef.current;
    const expected = mtimeRef.current;
    try {
      const result = await window.spark.fs.writeText(
        path,
        content,
        expected != null ? { expectedMtimeMs: expected } : undefined,
      );
      if (result.kind === "conflict") {
        setConflictState(true);
        return;
      }
      savedRef.current = content;
      mtimeRef.current = result.mtimeMs;
      setDirty(bufferRef.current !== content);
      onAutosavedRef.current?.(path);
    } catch {
      // Transient IO/IPC failure — stay dirty; the next keystroke reschedules
      // and a manual save can always force the issue.
    }
  }, [path, setConflictState]);

  const scheduleAutosave = useCallback(() => {
    const prefs = getAutosavePrefsRef.current?.();
    if (!prefs?.enabled || conflictRef.current) return;
    clearAutosaveTimer();
    autosaveTimerRef.current = setTimeout(() => {
      void attemptAutosave();
    }, Math.max(0, prefs.delayMs));
  }, [attemptAutosave, clearAutosaveTimer]);

  const flush = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      clearAutosaveTimer();
      void attemptAutosave();
    }
  }, [attemptAutosave, clearAutosaveTimer]);

  const onChange = useCallback(
    (next: string) => {
      bufferRef.current = next;
      const isDirty = next !== savedRef.current;
      dirtyRef.current = isDirty;
      setDirty(isDirty);
      if (isDirty) {
        scheduleAutosave();
      } else {
        // Undo back to the saved content — a pending stale write must not fire.
        clearAutosaveTimer();
      }
    },
    [scheduleAutosave, clearAutosaveTimer],
  );

  // Manual save: unconditional (no expectedMtimeMs) — explicit user intent
  // always wins over whatever is on disk. Also the conflict strip's
  // "Keep my edits" action.
  const save = useCallback(async () => {
    if (!dirtyRef.current && !conflictRef.current) return;
    clearAutosaveTimer();
    const content = bufferRef.current;
    const result = await window.spark.fs.writeText(path, content);
    savedRef.current = content;
    if (result.kind === "ok") mtimeRef.current = result.mtimeMs;
    setConflictState(false);
    setDirty(bufferRef.current !== content);
  }, [path, clearAutosaveTimer, setConflictState]);

  return { doc, dirty, conflict, onChange, save, reload, flush };
}
