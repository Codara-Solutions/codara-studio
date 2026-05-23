import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { FsEntry } from "@shared/types";
import { CloseIcon } from "../icons";
import { FileNodeIcon } from "../file-icons/FileNodeIcon";
import { basename, dirname } from "../../path-utils";

interface Props {
  open: boolean;
  cwd: string | null;
  onClose: () => void;
  onOpenFile: (entry: FsEntry) => void;
}

interface FileRow {
  entry: FsEntry;
  relativePath: string;
  directory: string;
  score: number;
}

const DISPLAY_LIMIT = 500;

export default function FileSearchPanel({ open, cwd, onClose, onOpenFile }: Props) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open || !cwd) return;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setLoading(true);
    setError(null);
    setFiles([]);
    setTruncated(false);

    void window.spark.fs.listFiles(cwd).then(
      (result) => {
        if (loadGenerationRef.current !== generation) return;
        setFiles(result.files);
        setTruncated(result.truncated);
        setLoading(false);
      },
      (err) => {
        if (loadGenerationRef.current !== generation) return;
        setError((err as Error).message || String(err));
        setLoading(false);
      },
    );
  }, [open, cwd]);

  const rows = useMemo(() => {
    if (!cwd) return [];
    const tokens = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const matched: FileRow[] = [];
    for (const entry of files) {
      const relativePath = relativePathFrom(cwd, entry.path);
      const score = scoreFile(relativePath, entry.name, tokens);
      if (score === null) continue;
      const dir = dirname(relativePath);
      matched.push({
        entry,
        relativePath,
        directory: dir === relativePath ? "" : dir,
        score,
      });
    }

    if (tokens.length > 0) {
      matched.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.relativePath.length !== b.relativePath.length) {
          return a.relativePath.length - b.relativePath.length;
        }
        return a.relativePath.localeCompare(b.relativePath, undefined, {
          sensitivity: "base",
        });
      });
    }

    return matched.slice(0, DISPLAY_LIMIT);
  }, [cwd, files, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, cwd]);

  useEffect(() => {
    if (selectedIndex < 0) {
      setSelectedIndex(0);
    } else if (selectedIndex >= rows.length) {
      setSelectedIndex(Math.max(0, rows.length - 1));
    }
  }, [rows.length, selectedIndex]);

  useEffect(() => {
    if (!open || rows.length === 0) return;
    virtuosoRef.current?.scrollToIndex({
      index: selectedIndex,
      align: "center",
      behavior: "auto",
    });
  }, [open, selectedIndex, rows.length]);

  const openRow = useCallback(
    (row: FileRow | undefined) => {
      if (!row) return;
      onOpenFile(row.entry);
      onClose();
    },
    [onClose, onOpenFile],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement | HTMLElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (rows.length === 0) return;
        setSelectedIndex((index) => Math.min(rows.length - 1, index + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        openRow(rows[selectedIndex]);
      }
    },
    [onClose, openRow, rows, selectedIndex],
  );

  if (!open) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 101,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.45)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        fontFamily: "var(--font-sans)",
        padding: "60px 24px 24px",
      }}
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Open file"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          width: "min(720px, calc(100vw - 44px))",
          maxHeight: "calc(100vh - 88px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--rule-soft)",
          borderRadius: 12,
          boxShadow: "var(--shadow-2)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            flex: "0 0 auto",
            padding: "12px 14px",
            borderBottom: "1px solid var(--rule-soft)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "var(--accent)",
              boxShadow: "0 0 9px var(--accent-glow)",
              flex: "0 0 7px",
            }}
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={cwd ? "Open file..." : "Open a workspace first"}
            spellCheck={false}
            disabled={!cwd}
            style={{
              flex: 1,
              minWidth: 0,
              appearance: "none",
              background: "color-mix(in oklch, var(--ink) 3%, transparent)",
              border: "1px solid var(--rule-soft)",
              borderRadius: 7,
              color: "var(--ink)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              padding: "6px 10px",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={onClose}
            title="Close"
            style={{
              appearance: "none",
              width: 26,
              height: 26,
              border: "1px solid var(--rule-soft)",
              borderRadius: 6,
              background: "transparent",
              color: "var(--muted)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "default",
              flex: "0 0 26px",
            }}
          >
            <CloseIcon size={11} />
          </button>
        </header>

        <div
          style={{
            height: "min(520px, calc(100vh - 170px))",
            minHeight: 180,
            background: "var(--bg)",
          }}
        >
          {error ? (
            <Empty text={`File search error: ${error}`} danger />
          ) : !cwd ? (
            <Empty text="Open a workspace to search its files." />
          ) : loading ? (
            <Empty text="Loading files..." />
          ) : rows.length === 0 ? (
            <Empty text={files.length === 0 ? "No files found." : "No matching files."} />
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              style={{ height: "100%", width: "100%" }}
              totalCount={rows.length}
              overscan={400}
              itemContent={(index) => {
                const row = rows[index];
                if (!row) return null;
                return (
                  <FileResultRow
                    row={row}
                    active={index === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => openRow(row)}
                  />
                );
              }}
            />
          )}
        </div>

        <footer
          style={{
            flex: "0 0 auto",
            padding: "8px 14px",
            borderTop: "1px solid var(--rule-soft)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span>
            {rows.length} shown of {files.length} files
          </span>
          <span style={{ flex: 1 }} />
          {truncated ? (
            <span style={{ color: "var(--warn)" }}>
              File list capped, refine the query
            </span>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function FileResultRow({
  row,
  active,
  onMouseEnter,
  onClick,
}: {
  row: FileRow;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={-1}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      title={row.entry.path}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 14px",
        minHeight: 28,
        background: active ? "var(--hover)" : "transparent",
        color: "var(--ink-dim)",
        cursor: "default",
      }}
    >
      <FileNodeIcon name={row.entry.name} isDir={false} size={15} />
      <span
        style={{
          flex: "0 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: active ? "var(--ink)" : "var(--ink-dim)",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
        }}
      >
        {row.entry.name}
      </span>
      {row.directory ? (
        <span
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        >
          {row.directory}
        </span>
      ) : null}
    </div>
  );
}

function Empty({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        color: danger ? "var(--danger)" : "var(--muted)",
        fontSize: 12,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}

function relativePathFrom(cwd: string, target: string): string {
  if (!cwd) return target;
  const normCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const norm = target.replace(/\\/g, "/");
  const lower = norm.toLowerCase();
  if (lower.startsWith(`${normCwd}/`)) {
    return norm.slice(normCwd.length + 1);
  }
  if (lower === normCwd) return basename(target);
  return target;
}

function scoreFile(relativePath: string, name: string, tokens: string[]): number | null {
  if (tokens.length === 0) return 0;
  const path = relativePath.toLowerCase();
  const lowerName = name.toLowerCase();
  let score = 0;

  for (const token of tokens) {
    if (lowerName === token) {
      score += 1200;
      continue;
    }
    if (lowerName.startsWith(token)) {
      score += 900 - token.length;
      continue;
    }
    const nameIndex = lowerName.indexOf(token);
    if (nameIndex >= 0) {
      score += 650 - nameIndex;
      continue;
    }
    const pathIndex = path.indexOf(token);
    if (pathIndex >= 0) {
      score += 400 - pathIndex;
      continue;
    }
    const fuzzy = fuzzyScore(path, token);
    if (fuzzy === null) return null;
    score += fuzzy;
  }

  return score;
}

function fuzzyScore(path: string, token: string): number | null {
  let lastIndex = -1;
  let gapPenalty = 0;
  for (const char of token) {
    const nextIndex = path.indexOf(char, lastIndex + 1);
    if (nextIndex < 0) return null;
    gapPenalty += nextIndex - lastIndex - 1;
    lastIndex = nextIndex;
  }
  return Math.max(40, 220 - gapPenalty);
}
