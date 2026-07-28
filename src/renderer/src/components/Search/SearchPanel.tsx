import {
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
      // Each group touched by this batch is copied once, on first touch; later
      // hits push into that batch-local copy. The previous state's arrays are
      // never mutated.
      const copied = new Set<number>();
      for (const hit of action.hits) {
        const existingIndex = pathToIndex.get(hit.path);
        if (existingIndex !== undefined) {
          const target = groups[existingIndex];
          if (copied.has(existingIndex)) {
            target.hits.push(hit);
          } else {
            groups[existingIndex] = { path: target.path, hits: [...target.hits, hit] };
            copied.add(existingIndex);
          }
        } else {
          groups.push({ path: hit.path, hits: [hit] });
          pathToIndex.set(hit.path, groups.length - 1);
          copied.add(groups.length - 1);
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
        fontFamily: "var(--font-sans)",
        padding: "60px 24px 24px",
      }}
      className="spark-fade-in"
      onMouseDown={onClose}
    >
      {/* Scrim + dialog face come from the shared glass classes (frosted in
          glass mode, opaque panel look otherwise) so both honor the
          data-glass kill switch, reduced-transparency, and the user tuning. */}
      <div className="spark-scrim" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Search in files"
        className="spark-glass--strong"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (running) cancel();
            else onClose();
          }
        }}
        style={{
          zIndex: 1,
          width: "min(720px, calc(100vw - 44px))",
          maxHeight: "calc(100vh - 88px)",
          display: "flex",
          flexDirection: "column",
          borderRadius: 12,
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
            <div style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}>
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
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "var(--accent-edge)";
                  e.currentTarget.style.boxShadow = "var(--focus-ring)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "var(--rule-soft)";
                  e.currentTarget.style.boxShadow = "var(--well)";
                }}
                placeholder={cwd ? "Search in files…" : "Open a workspace first"}
                spellCheck={false}
                disabled={!cwd}
                style={{
                  flex: 1,
                  minWidth: 0,
                  appearance: "none",
                  background: "var(--bg)",
                  border: "1px solid var(--rule-soft)",
                  borderRadius: 7,
                  color: "var(--ink)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  padding: "6px 28px 6px 10px",
                  outline: "none",
                  boxShadow: "var(--well)",
                  transition:
                    "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
                }}
              />
              {query.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    inputRef.current?.focus();
                  }}
                  title="Clear query"
                  aria-label="Clear query"
                  style={{
                    position: "absolute",
                    top: "50%",
                    right: 6,
                    transform: "translateY(-50%)",
                    appearance: "none",
                    width: 18,
                    height: 18,
                    border: "none",
                    borderRadius: 5,
                    background: "transparent",
                    color: "var(--muted)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "default",
                    transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--hover)";
                    e.currentTarget.style.color = "var(--ink-dim)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "var(--muted)";
                  }}
                >
                  <CloseIcon size={9} />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              title="Close"
              aria-label="Close"
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
                transition:
                  "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--hover)";
                e.currentTarget.style.color = "var(--ink-dim)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--muted)";
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
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "var(--danger-soft)",
                  border: "1px solid var(--danger)",
                  borderRadius: 6,
                  color: "var(--ink)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "4px 10px",
                  cursor: "default",
                  transition: "background var(--motion-fast) var(--ease-out)",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "var(--danger)",
                    animation: "spark-pulse 1.4s var(--ease-out) infinite",
                  }}
                />
                Cancel
              </button>
            ) : null}
          </div>
        </header>

        <div
          style={{
            // Give the results area a DEFINITE height. react-virtuoso measures
            // its scroller against the parent's resolved height; a bare
            // `flex: 1` here collapses to ~0 because the overlay uses
            // `align-items: flex-start` (so the section is content-sized, not
            // stretched) and the section only sets `maxHeight`. With a
            // zero-height viewport the virtualized rows never render even
            // though hits were found — the empty-state text still showed
            // because it has real content height. Mirrors FileSearchPanel,
            // which sizes its list the same way. The larger viewport
            // subtraction accounts for this panel's taller two-row header.
            height: "min(520px, calc(100vh - 210px))",
            minHeight: 180,
            display: "flex",
            flexDirection: "column",
            background: "var(--bg)",
          }}
        >
          {error ? (
            <Empty eyebrow="Search error" text={error} danger />
          ) : !cwd ? (
            <Empty eyebrow="No workspace" text="Open a workspace to search across its files." />
          ) : query.trim().length === 0 ? (
            <Empty eyebrow="Find in files" text="Type to search the workspace. Click a hit to open that file." />
          ) : rows.length === 0 ? (
            running ? (
              <Empty eyebrow="Searching" text="Scanning the workspace…" loading />
            ) : (
              <Empty eyebrow="No results" text="Nothing matched. Try a different query or adjust the filters." />
            )
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
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                aria-hidden
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 999,
                  background: "var(--accent)",
                  boxShadow: "0 0 6px var(--accent-glow)",
                  animation: "spark-pulse 1.4s var(--ease-out) infinite",
                }}
              />
              <span style={{ color: "var(--ink-dim)" }}>{results.totalHits}</span> hits in{" "}
              <span style={{ color: "var(--ink-dim)" }}>{filesCount}</span> files
            </span>
          ) : summary ? (
            <span>
              <span style={{ color: "var(--ink-dim)" }}>{summary.totalHits}</span> hits in{" "}
              <span style={{ color: "var(--ink-dim)" }}>{filesCount}</span> files ·{" "}
              {(summary.durationMs / 1000).toFixed(2)}s
            </span>
          ) : (
            <span>
              <span style={{ color: "var(--ink-dim)" }}>{results.totalHits}</span> hits in{" "}
              <span style={{ color: "var(--ink-dim)" }}>{filesCount}</span> files
            </span>
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
          ? "1px solid var(--accent-edge)"
          : "1px solid var(--rule-soft)",
        borderRadius: 6,
        background: active ? "var(--accent-soft)" : "color-mix(in oklab, var(--ink) 2%, transparent)",
        color: active ? "var(--ink)" : "var(--muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 700,
        cursor: "default",
        boxShadow: active ? "var(--shadow-glow)" : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = "var(--hover)";
          e.currentTarget.style.color = "var(--ink-dim)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "color-mix(in oklab, var(--ink) 2%, transparent)";
          e.currentTarget.style.color = "var(--muted)";
        }
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
      onFocus={(e) => {
        e.currentTarget.style.borderColor = "var(--accent-edge)";
        e.currentTarget.style.boxShadow = "var(--focus-ring)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "var(--rule-soft)";
        e.currentTarget.style.boxShadow = "var(--well)";
      }}
      style={{
        flex: "1 1 160px",
        minWidth: 140,
        maxWidth: 220,
        appearance: "none",
        background: "var(--bg)",
        border: "1px solid var(--rule-soft)",
        borderRadius: 6,
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        padding: "4px 8px",
        outline: "none",
        boxShadow: "var(--well)",
        transition:
          "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
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
        boxShadow: "var(--lift-hi)",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        cursor: "default",
        position: "sticky",
        top: 0,
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--panel-2)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--panel)";
      }}
    >
      <span
        aria-hidden
        style={{
          width: 12,
          color: "var(--muted)",
          fontWeight: 800,
          fontVariantNumeric: "tabular-nums",
        }}
      >
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
          background: "color-mix(in oklab, var(--ink) 3%, transparent)",
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
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
        transition: "background var(--motion-fast) var(--ease-out)",
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
        <span style={{ color: "var(--muted)" }}>{truncateLeft(hit.preMatch, 80)}</span>
        <mark
          style={{
            background: "var(--accent-soft)",
            boxShadow: "inset 0 0 0 1px var(--accent-edge)",
            color: "var(--ink)",
            borderRadius: 3,
            padding: "0 2px",
          }}
        >
          {hit.matchText}
        </mark>
        <span style={{ color: "var(--muted)" }}>{truncateRight(hit.postMatch, 160)}</span>
      </span>
    </div>
  );
}

function Empty({
  eyebrow,
  text,
  danger = false,
  loading = false,
}: {
  eyebrow: string;
  text: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <div
      className="spark-fade-in"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        padding: 32,
        textAlign: "center",
      }}
    >
      <span
        className="spark-eyebrow"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          color: danger ? "var(--danger)" : "var(--muted)",
        }}
      >
        {loading ? (
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: "var(--accent)",
              boxShadow: "0 0 6px var(--accent-glow)",
              animation: "spark-pulse 1.4s var(--ease-out) infinite",
            }}
          />
        ) : null}
        {eyebrow}
      </span>
      <span
        style={{
          maxWidth: 360,
          color: danger ? "var(--danger)" : "var(--muted-2)",
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        {text}
      </span>
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
