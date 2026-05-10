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
}

export interface UseDocumentResult {
  doc: DocumentState;
  dirty: boolean;
  onChange: (next: string) => void;
  save: () => Promise<void>;
  reload: () => boolean;
}

// useDocument — reads `path` once on mount (and on path change), tracks the
// saved buffer vs in-flight content, and exposes save/reload primitives.
// The save call goes through `fs:writeText` (which now does an atomic write
// in the main process). Dirty flag is bubbled up to the workbench so tabs
// can show the unsaved-modification dot.
export function useDocument({ path, onDirtyChange }: Options): UseDocumentResult {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);

  const savedRef = useRef<string>("");
  const bufferRef = useRef<string>("");
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  // Bubble dirty transitions to the parent. Use both `dirty` and `path` so
  // the parent always knows which file the flip applies to.
  useEffect(() => {
    onDirtyChangeRef.current?.(path, dirty);
  }, [dirty, path]);

  // Load on path change or explicit reload.
  useEffect(() => {
    let cancelled = false;
    setDoc({ status: "loading" });
    setDirty(false);
    savedRef.current = "";
    bufferRef.current = "";

    void window.spark.fs
      .readEx(path)
      .then((res: FsReadResult) => {
        if (cancelled) return;
        if (res.kind === "text") {
          savedRef.current = res.content;
          bufferRef.current = res.content;
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
    };
  }, [path, reloadCounter]);

  // Re-read the file from disk. No-op (silent) if the buffer is dirty —
  // callers shouldn't clobber unsaved user edits. Returns whether reload ran.
  const reload = useCallback((): boolean => {
    if (dirtyRef.current) return false;
    setReloadCounter((n) => n + 1);
    return true;
  }, []);

  const onChange = useCallback((next: string) => {
    bufferRef.current = next;
    setDirty(next !== savedRef.current);
  }, []);

  const save = useCallback(async () => {
    if (!dirtyRef.current) return;
    const content = bufferRef.current;
    await window.spark.fs.writeText(path, content);
    savedRef.current = content;
    setDirty(false);
  }, [path]);

  return { doc, dirty, onChange, save, reload };
}
