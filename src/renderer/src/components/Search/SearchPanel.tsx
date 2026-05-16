import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Virtuoso } from "react-virtuoso";
import type { FsEntry, SearchHit, SearchOptions, SearchSummary } from "@shared/types";
import { CloseIcon } from "../icons";
import { basename } from "../../path-utils";

// Project-wide find-in-files panel rendered as a centered overlay. Hits
// stream in from the main process via `window.spark.search.start` in
// batches and are appended through a reducer so React only diffs the new
// tail once per batch rather than re-virtualizing the whole list per match.
// Files are grouped under a header row that the user can collapse, so the
// virtualized list mixes header rows and hit rows in a single flat sequence.

interface Props {
  open: boolean;
  cwd: string | null;
  onClose: () => void;
  onOpenFile: (entry: FsEntry, location: { line: number; column: number }) => void;
}

const HIT_CAP = 2000;
const DEBOUNCE_MS = 200;

interface FileGroup {
  path: string;
  hits: SearchHit[];
}

interface ResultsState {
  groups: FileGroup[];
  pathToIndex: Map<string, number>;
  totalHits: number;
}

type ResultsAction =
  | { kind: "reset" }
  | { kind: "append"; hits: SearchHit[] };

function resultsReducer(state: ResultsState, action: ResultsAction): ResultsState {
  switch (action.kind) {
    case "reset":
      return { groups: [], pathToIndex: new Map(), totalHits: 0 };
    case "append": {
      // Hits arrive in batches from the main process; fold the whole batch
      // into the grouped state in one reducer pass so React diffs the tail
      // once per batch rather than once per hit.
      if (action.hits.length === 0) return state;
      const groups = state.groups.slice();
      const pathToIndex = new Map(state.pathToIndex);
      for (const hit of action.hits) {
        const existingIndex = pathToIndex.get(hit.path);
        if (existingIndex !== undefined) {
          const target = groups[existingIndex];
          groups[existingIndex] = { path: target.path, hits: [...target.hits, hit] };
        } else {
          groups.push({ path: hit.path, hits: [hit] });
          pathToIndex.set(hit.path, groups.length - 1);
        }
      }
      return { groups, pathToIndex, totalHits: state.totalHits + action.hits.length };
    }
    default:
      return state;
  }
}

type Row =
  | { kind: "header"; group: FileGroup; collapsed: boolean }
  | { kind: "hit"; hit: SearchHit };

function buildRows(state: ResultsState, collapsed: Set<string>): Row[] {
  const rows: Row[] = [];
  for (const group of state.groups) {
    const isCollapsed = collapsed.has(group.path);
    rows.push({ kind: "header", group, collapsed: isCollapsed });
    if (!isCollapsed) {
      for (const hit of group.hits) rows.push({ kind: "hit", hit });
    }
  }
  return rows;
}

export default function SearchPanel({ open, cwd, onClose, onOpenFile }: Props) {
  const [query, setQuery] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [includeGlobs, setIncludeGlobs] = useState("");
  const [excludeGlobs, setExcludeGlobs] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [results, dispatch] = useReducer(resultsReducer, undefined, () => ({
    groups: [],
    pathToIndex: new Map<string, number>(),
    totalHits: 0,
  }));
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<SearchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  // Track the live search handle in a ref so subsequent dispatches can cancel
  // the previous search synchronously without waiting on an async setState.
  const handleRef = useRef<{ cancel: () => Promise<void>; searchId: string } | null>(null);
  const debounceRef = useRef<number | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  // Focus the input every time the panel opens. The `spark:open-search`
  // event also bumps the panel open from the App-level shortcut handler.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Cancel any in-flight search when the panel closes or unmounts so we do
  // not keep an rg process alive in the main process for nothing.
  useEffect(() => {
    if (open) return;
    const current = handleRef.current;
    if (current) {
      void current.cancel();
      handleRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    return () => {
      const current = handleRef.current;
      if (current) void current.cancel();
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, []);

  const splitGlobs = useCallback((value: string): string[] => {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }, []);

  const startSearch = useCallback(
    async (rawQuery: string) => {
      if (!cwd) return;
      const trimmed = rawQuery.trim();
      // Cancel whatever was running first; resetting state before the new
      // call avoids a stray late hit from the previous search slipping into
      // the new result list.
      const previous = handleRef.current;
      handleRef.current = null;
      if (previous) {
        try {
          await previous.cancel();
        } catch {
          // ignore — main side will clean up regardless
        }
      }
      dispatch({ kind: "reset" });
      setSummary(null);
      setError(null);
      setCollapsed(new Set());
      if (trimmed.length === 0) {
        setRunning(false);
        return;
      }
      setRunning(true);
      const options: SearchOptions = {
        root: cwd,
        query: trimmed,
        isRegex,
        caseSensitive,
        wholeWord,
        includeGlobs: splitGlobs(includeGlobs),
        excludeGlobs: splitGlobs(excludeGlobs),
        maxHits: HIT_CAP,
      };
      try {
        const handle = await window.spark.search.start(options, {
          onHit: (hits) => {
            // Hits arrive batched from main; the reducer folds the whole
            // batch into the grouped state in one pass. setRunning stays
            // true while batches keep arriving.
            dispatch({ kind: "append", hits });
          },
          onDone: (s) => {
            // If a newer search has been kicked off between start and done
            // we ignore this summary so the panel does not report stale
            // counts for the active query.
            if (handleRef.current && handleRef.current.searchId !== handle.searchId) return;
            setSummary(s);
            setRunning(false);
            handleRef.current = null;
            if (s.error) setError(s.error);
          },
        });
        handleRef.current = handle;
      } catch (err) {
        setError((err as Error).message || String(err));
        setRunning(false);
      }
    },
    [cwd, isRegex, caseSensitive, wholeWord, includeGlobs, excludeGlobs, splitGlobs],
  );

  // Debounce on every dependency that affects the search. Toggling case or
  // regex triggers an immediate search via the same code path so the user
  // does not have to hit Enter to refresh.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void startSearch(queryRef.current);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [query, isRegex, caseSensitive, wholeWord, includeGlobs, excludeGlobs, open, startSearch]);

  const cancel = useCallback(() => {
    const current = handleRef.current;
    handleRef.current = null;
    if (current) void current.cancel();
    setRunning(false);
  }, []);

  const handleHitClick = useCallback(
    (hit: SearchHit) => {
      const ext = (hit.path.split(/[\\/]/).pop() ?? "").split(".").pop() ?? undefined;
      const entry: FsEntry = {
        name: basename(hit.path) || hit.path,
        path: hit.path,
        isDir: false,
        ext: ext && ext.length > 0 && ext !== hit.path ? ext : undefined,
      };
      onOpenFile(entry, { line: hit.line, column: hit.column });
      // Also broadcast for any future listener that wants to seek inside
      // an editor we have not wired up yet (wave 3 integration point).
      window.dispatchEvent(
        new CustomEvent("spark:open-file", {
          detail: { path: hit.path, line: hit.line, column: hit.column },
        }),
      );
    },
    [onOpenFile],
  );

  const toggleGroup = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const rows = useMemo(() => buildRows(results, collapsed), [results, collapsed]);

  const filesCount = results.groups.length;
  const hitCap = summary?.hitCap === true || results.totalHits >= HIT_CAP;

  if (!open) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 100,
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
        aria-label="Search in files"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (running) cancel();
            else onClose();
          }
        }}
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
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (debounceRef.current !== null) {
                    window.clearTimeout(debounceRef.current);
                    debounceRef.current = null;
                  }
                  void startSearch(query);
                }
              }}
              placeholder={cwd ? "Search in files…" : "Open a workspace first"}
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
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Toggle label="Aa" title="Case sensitive" active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} />
            <Toggle label="W" title="Whole word" active={wholeWord} onClick={() => setWholeWord((v) => !v)} />
            <Toggle label=".*" title="Regex" active={isRegex} onClick={() => setIsRegex((v) => !v)} />
            <span style={{ width: 8 }} />
            <GlobInput
              placeholder="files to include (e.g. src/**/*.ts)"
              value={includeGlobs}
              onChange={setIncludeGlobs}
            />
            <GlobInput
              placeholder="files to exclude"
              value={excludeGlobs}
              onChange={setExcludeGlobs}
            />
            <span style={{ flex: 1 }} />
            {running ? (
              <button
                type="button"
                onClick={cancel}
                style={{
                  appearance: "none",
                  background: "var(--danger-soft)",
                  border: "1px solid var(--danger)",
                  borderRadius: 6,
                  color: "var(--ink)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "4px 10px",
                  cursor: "default",
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </header>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            background: "var(--bg)",
          }}
        >
          {error ? (
            <Empty text={`Search error: ${error}`} danger />
          ) : !cwd ? (
            <Empty text="Open a workspace to search across its files." />
          ) : query.trim().length === 0 ? (
            <Empty text="Type a query to search the active workspace." />
          ) : rows.length === 0 ? (
            <Empty text={running ? "Searching…" : "No results."} />
          ) : (
            <Virtuoso
              style={{ height: "100%", width: "100%" }}
              totalCount={rows.length}
              overscan={400}
              itemContent={(index) => {
                const row = rows[index];
                if (!row) return null;
                if (row.kind === "header") {
                  return (
                    <FileHeader
                      group={row.group}
                      collapsed={row.collapsed}
                      onToggle={() => toggleGroup(row.group.path)}
                      cwd={cwd}
                    />
                  );
                }
                return <HitRow hit={row.hit} onClick={() => handleHitClick(row.hit)} />;
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
          {running ? (
            <span>Searching… {results.totalHits} hits in {filesCount} files</span>
          ) : summary ? (
            <span>
              {summary.totalHits} hits in {filesCount} files ·{" "}
              {(summary.durationMs / 1000).toFixed(2)}s
            </span>
          ) : (
            <span>{results.totalHits} hits in {filesCount} files</span>
          )}
          <span style={{ flex: 1 }} />
          {hitCap && (
            <span style={{ color: "var(--warn)" }}>
              {HIT_CAP}+ hits — refine the query
            </span>
          )}
        </footer>
      </section>
    </div>
  );
}

function Toggle({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        appearance: "none",
        minWidth: 26,
        height: 24,
        padding: "0 8px",
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 54%, var(--rule-strong))"
          : "1px solid var(--rule-soft)",
        borderRadius: 6,
        background: active ? "var(--accent-soft)" : "color-mix(in oklch, var(--ink) 2%, transparent)",
        color: active ? "var(--ink)" : "var(--muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 700,
        cursor: "default",
      }}
    >
      {label}
    </button>
  );
}

function GlobInput({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      placeholder={placeholder}
      spellCheck={false}
      style={{
        flex: "1 1 160px",
        minWidth: 140,
        maxWidth: 220,
        appearance: "none",
        background: "color-mix(in oklch, var(--ink) 2%, transparent)",
        border: "1px solid var(--rule-soft)",
        borderRadius: 6,
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        padding: "4px 8px",
        outline: "none",
      }}
    />
  );
}

function FileHeader({
  group,
  collapsed,
  onToggle,
  cwd,
}: {
  group: FileGroup;
  collapsed: boolean;
  onToggle: () => void;
  cwd: string;
}) {
  const rel = relativePath(cwd, group.path);
  return (
    <div
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 14px",
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule-soft)",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        cursor: "default",
        position: "sticky",
        top: 0,
      }}
    >
      <span style={{ width: 12, color: "var(--muted)", fontWeight: 800 }}>
        {collapsed ? "▸" : "▾"}
      </span>
      <span
        title={group.path}
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {rel}
      </span>
      <span
        style={{
          minWidth: 22,
          textAlign: "center",
          padding: "1px 6px",
          border: "1px solid var(--rule-soft)",
          borderRadius: 4,
          background: "color-mix(in oklch, var(--ink) 3%, transparent)",
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
        }}
      >
        {group.hits.length}
      </span>
    </div>
  );
}

function HitRow({ hit, onClick }: { hit: SearchHit; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        padding: "3px 14px 3px 30px",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.45,
        cursor: "default",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
      title={`${hit.line}:${hit.column}  ${hit.text}`}
    >
      <span
        style={{
          color: "var(--muted)",
          fontVariantNumeric: "tabular-nums",
          flex: "0 0 auto",
          minWidth: 56,
        }}
      >
        {hit.line}:{hit.column}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <span>{truncateLeft(hit.preMatch, 80)}</span>
        <mark
          style={{
            background: "var(--accent-soft)",
            color: "var(--ink)",
            borderRadius: 2,
            padding: "0 1px",
          }}
        >
          {hit.matchText}
        </mark>
        <span>{truncateRight(hit.postMatch, 160)}</span>
      </span>
    </div>
  );
}

function Empty({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <div
      style={{
        flex: 1,
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

function relativePath(cwd: string, target: string): string {
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

function truncateLeft(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max)}`;
}

function truncateRight(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
