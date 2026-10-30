import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { FsEntry, HomeFileHit, PathQueryHit } from "@shared/types";
import { isPathQuery } from "@shared/path-query";
import { CloseIcon } from "../icons";
import FileNodeIcon from "../file-icons/LazyFileNodeIcon";
import { basename, dirname } from "../../path-utils";
import { usePreferences } from "../../preferences/usePreferences";
import { homeQueryQualifies, useHomeFileSearch } from "./useHomeFileSearch";
import { usePathQuery } from "./usePathQuery";

interface Props {
  open: boolean;
  cwd: string | null;
  onClose: () => void;
  onOpenFile: (entry: FsEntry) => void;
  /** A folder picked by its path; it becomes a workspace. */
  onOpenFolder?: (path: string) => void;
}

interface FileRow {
  entry: FsEntry;
  relativePath: string;
  lowerPath: string;
  directory: string;
  score: number;
}

// One line of the result list. Workspace files come first; files found in
// the home folder follow under their own heading. `pick` is the row's place
// among the rows that open something (what the arrow keys move through).
type ListItem =
  | { kind: "file"; row: FileRow; pick: number }
  | { kind: "heading" }
  | { kind: "home"; hit: HomeFileHit; pick: number }
  | { kind: "path"; hit: PathQueryHit; pick: number }
  | { kind: "status"; text: string; danger?: boolean };

type Pick = { kind: "file"; row: FileRow } | { kind: "home"; hit: HomeFileHit } | { kind: "path"; hit: PathQueryHit };

const DISPLAY_LIMIT = 250;
const DEBOUNCE_MS = 250;
const FILE_LIST_CACHE_MS = 30_000;

export default function FileSearchPanel({ open, cwd, onClose, onOpenFile, onOpenFolder }: Props) {
  const [query, setQuery] = useState("");
  // The scoring pass below walks every file in the workspace (up to the
  // listFiles cap of 10k) with a fuzzy character walk, so it must not run per
  // keystroke. The input stays bound to `query` and repaints instantly; only
  // the scoring waits for a pause in typing. Same window as SearchPanel.
  const [scoredQuery, setScoredQuery] = useState("");
  const [files, setFiles] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const loadGenerationRef = useRef(0);
  const loadedWorkspaceRef = useRef<{ cwd: string; at: number } | null>(null);
  const keyboardMoveRef = useRef(false);
  // Deferred Enter: the keydown handler flushed the scoring debounce and
  // parked the query it wants opened; the effect below `openPick` completes
  // the open on the first render where the rows reflect exactly that query.
  // Any later keystroke re-parks or (via onChange) cancels, so a stale
  // pending open can never fire.
  const pendingOpenQueryRef = useRef<string | null>(null);
  const { preferences } = usePreferences();
  const anywhereEnabled = preferences.quickOpenAnywhere !== false;
  // A preload from before path mode (`npm run dev` keeps it across a fast
  // forward) has no such call: the query stays plain text.
  const pathReady = typeof window.spark.fs.searchPath === "function";
  const pathMode = anywhereEnabled && pathReady && isPathQuery(scoredQuery, cwd);
  const pathResult = usePathQuery(open, pathMode, scoredQuery, cwd);
  const home = useHomeFileSearch(open, anywhereEnabled && Boolean(cwd) && !pathMode, scoredQuery, cwd);
  const [pickError, setPickError] = useState<string | null>(null);
  const pickGenerationRef = useRef(0);

  useEffect(() => {
    // A deferred Enter, or a pick main is still checking, must not open a
    // tab once the panel has closed (Escape) or opened again.
    pickGenerationRef.current += 1;
    pendingOpenQueryRef.current = null;
    if (!open) return;
    setPickError(null);
    setQuery("");
    setScoredQuery("");
    setSelectedIndex(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open || !cwd) return;
    const cached = loadedWorkspaceRef.current;
    if (cached?.cwd === cwd && Date.now() - cached.at < FILE_LIST_CACHE_MS) return;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const refreshingCurrentWorkspace = cached?.cwd === cwd;
    setLoading(!refreshingCurrentWorkspace);
    setError(null);
    if (!refreshingCurrentWorkspace) {
      setFiles([]);
      setTruncated(false);
    }

    void window.spark.fs.listFiles(cwd).then(
      (result) => {
        if (loadGenerationRef.current !== generation) return;
        loadedWorkspaceRef.current = { cwd, at: Date.now() };
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

  useEffect(() => {
    if (query === scoredQuery) return;
    const id = window.setTimeout(() => setScoredQuery(query), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query, scoredQuery]);

  const rows = useMemo(() => {
    if (!cwd) return [];
    const tokens = scoredQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    // The empty picker only needs a short recent/alphabetical window. Avoid
    // normalizing all 10k possible files before the user has typed anything.
    if (tokens.length === 0) {
      return files.slice(0, DISPLAY_LIMIT).map((entry) => {
        const relativePath = relativePathFrom(cwd, entry.path);
        const directory = dirname(relativePath);
        return {
          entry,
          relativePath,
          lowerPath: relativePath.toLowerCase(),
          directory: directory === relativePath ? "" : directory,
          score: 0,
        };
      });
    }

    const matched: FileRow[] = [];
    for (const entry of files) {
      const relativePath = relativePathFrom(cwd, entry.path);
      const lowerPath = relativePath.toLowerCase();
      const score = scoreFile(lowerPath, entry.name, tokens);
      if (score === null) continue;
      const dir = dirname(relativePath);
      matched.push({
        entry,
        relativePath,
        lowerPath,
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
        // Case-insensitive ordinal on the already-lowered path: the same order
        // localeCompare's "base" sensitivity gives for the ASCII paths this
        // sees, without the collator on a tiebreak that runs per comparison.
        if (a.lowerPath === b.lowerPath) return 0;
        return a.lowerPath < b.lowerPath ? -1 : 1;
      });
    }

    return matched.slice(0, DISPLAY_LIMIT);
  }, [cwd, files, scoredQuery]);

  const homeVisible = anywhereEnabled && Boolean(cwd) && !pathMode && homeQueryQualifies(scoredQuery);
  // Home hits answer `home.query`; while a newer query is searching they stay
  // on screen, but they never open from a deferred Enter for the new query.
  const homeHits = homeVisible ? home.hits : [];
  const pathSettled = !pathMode || (pathResult.query === scoredQuery && pathResult.status !== "searching");
  const homeSettled = pathMode ? pathSettled : !homeVisible || (home.query === scoredQuery && home.status !== "searching");
  // "/index.ts" may be a path or a piece of one in the workspace: when nothing
  // on disk answers to it, it is searched as text, as it always was.
  const pathFellThrough = pathMode && pathSettled && pathResult.hits.length === 0 && scoredQuery.trimStart().startsWith("/");
  const shownRows = pathMode && !pathFellThrough ? EMPTY_ROWS : rows;
  const pathHits = pathMode ? pathResult.hits : EMPTY_PATH_HITS;

  const { items, picks, pickToItem } = useMemo(() => {
    const items: ListItem[] = [];
    const picks: Pick[] = [];
    const pickToItem: number[] = [];
    for (const row of shownRows) {
      pickToItem.push(items.length);
      items.push({ kind: "file", row, pick: picks.length });
      picks.push({ kind: "file", row });
    }
    if (pathMode) {
      if (pickError) items.push({ kind: "status", text: pickError, danger: true });
      for (const hit of pathHits) {
        pickToItem.push(items.length);
        items.push({ kind: "path", hit, pick: picks.length });
        picks.push({ kind: "path", hit });
      }
      if (pathHits.length === 0 && shownRows.length === 0) {
        if (pathResult.status === "error") items.push({ kind: "status", text: pathResult.error ?? "The path could not be read.", danger: true });
        else if (pathResult.message) items.push({ kind: "status", text: pathResult.message, danger: true });
        else if (pathSettled) items.push({ kind: "status", text: pathResult.missing ? "No such folder." : "Nothing here matches." });
        else items.push({ kind: "status", text: "Looking…" });
      } else if (pathResult.message) {
        items.push({ kind: "status", text: pathResult.message, danger: true });
      }
    }
    if (homeVisible) {
      if (rows.length === 0) {
        items.push({ kind: "status", text: files.length === 0 ? "This workspace has no files to open." : "Nothing in this workspace matches." });
      }
      items.push({ kind: "heading" });
      if (pickError) items.push({ kind: "status", text: pickError, danger: true });
      for (const hit of homeHits) {
        pickToItem.push(items.length);
        items.push({ kind: "home", hit, pick: picks.length });
        picks.push({ kind: "home", hit });
      }
      if (homeHits.length === 0) {
        if (home.status === "error") items.push({ kind: "status", text: home.error ?? "The search failed.", danger: true });
        else if (home.status === "done" && home.query === scoredQuery) items.push({ kind: "status", text: "No other files match." });
        else items.push({ kind: "status", text: "Searching your home folder…" });
      }
    }
    return { items, picks, pickToItem };
  }, [
    shownRows,
    rows.length,
    files.length,
    homeVisible,
    homeHits,
    home.status,
    home.error,
    home.query,
    scoredQuery,
    pickError,
    pathMode,
    pathHits,
    pathResult.status,
    pathResult.error,
    pathResult.message,
    pathResult.missing,
    pathSettled,
  ]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [scoredQuery, cwd]);

  useEffect(() => {
    pendingOpenQueryRef.current = null;
    pickGenerationRef.current += 1;
    setPickError(null);
  }, [cwd]);

  useEffect(() => {
    if (selectedIndex < 0) {
      setSelectedIndex(0);
    } else if (selectedIndex >= picks.length) {
      setSelectedIndex(Math.max(0, picks.length - 1));
    }
  }, [picks.length, selectedIndex]);

  useEffect(() => {
    if (!open || picks.length === 0 || !keyboardMoveRef.current) return;
    keyboardMoveRef.current = false;
    virtuosoRef.current?.scrollToIndex({
      index: pickToItem[selectedIndex] ?? 0,
      align: "center",
      behavior: "auto",
    });
  }, [open, selectedIndex, picks.length, pickToItem]);

  const completeTo = useCallback((completion: string) => {
    pendingOpenQueryRef.current = null;
    pickGenerationRef.current += 1;
    setPickError(null);
    setQuery(completion);
    // No debounce: the list follows the step at once, as a shell's does.
    setScoredQuery(completion);
  }, []);

  const openPath = useCallback(
    (hit: PathQueryHit) => {
      const generation = pickGenerationRef.current + 1;
      pickGenerationRef.current = generation;
      setPickError(null);
      void window.spark.fs.openPathPick(hit.path).then(
        (result) => {
          if (pickGenerationRef.current !== generation) return;
          if (!result.ok) {
            setPickError(result.message);
            return;
          }
          if (result.kind === "folder") onOpenFolder?.(result.path);
          else onOpenFile(entryFromName(hit.name, result.path));
          onClose();
        },
        (error) => {
          if (pickGenerationRef.current !== generation) return;
          setPickError((error as Error)?.message || String(error));
        },
      );
    },
    [onClose, onOpenFile, onOpenFolder],
  );

  const openPick = useCallback(
    (pick: Pick | undefined) => {
      if (!pick) return;
      if (pick.kind === "file") {
        onOpenFile(pick.row.entry);
        onClose();
        return;
      }
      if (pick.kind === "path") {
        // A folder is stepped into; the row for the folder itself opens it.
        if (pick.hit.isDir && pick.hit.kind !== "folder") completeTo(pick.hit.completion);
        else openPath(pick.hit);
        return;
      }
      // Main checks the file and lets the editor read it (it is outside every
      // workspace); only then does the tab open.
      const generation = pickGenerationRef.current + 1;
      pickGenerationRef.current = generation;
      setPickError(null);
      void window.spark.fs.openHomeSearchPick(pick.hit.path).then(
        (result) => {
          if (pickGenerationRef.current !== generation) return;
          if (!result.ok) {
            setPickError(result.message);
            return;
          }
          onOpenFile(entryFromHit(pick.hit, result.path));
          onClose();
        },
        (error) => {
          if (pickGenerationRef.current !== generation) return;
          setPickError((error as Error)?.message || String(error));
        },
      );
    },
    [completeTo, onClose, onOpenFile, openPath],
  );

  useEffect(() => {
    if (pendingOpenQueryRef.current === null) return;
    if (scoredQuery !== pendingOpenQueryRef.current) return;
    // With no workspace match the best pick is the first home hit, which
    // arrives after the workspace rows; wait for it.
    if (shownRows.length === 0 && !homeSettled) return;
    pendingOpenQueryRef.current = null;
    // Selection was reset to 0 by the scoredQuery-change effect, so this
    // opens the best match for the query the user pressed Enter on.
    openPick(picks[0]);
  }, [scoredQuery, shownRows.length, homeSettled, picks, openPick]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement | HTMLElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (picks.length === 0) return;
        keyboardMoveRef.current = true;
        setSelectedIndex((index) => Math.min(picks.length - 1, index + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        keyboardMoveRef.current = true;
        setSelectedIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (e.key === "Tab" && anywhereEnabled && pathReady && isPathQuery(query, cwd)) {
        e.preventDefault();
        if (query !== scoredQuery) {
          setScoredQuery(query);
          return;
        }
        const pick = picks[selectedIndex];
        if (pick?.kind === "path" && pathSettled) completeTo(pick.hit.completion);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        // The list after a step into a folder is still coming: a second press
        // must not land on the row for the folder and open it as a workspace.
        if (pathMode && query === scoredQuery && !pathSettled) return;
        // A fast Enter can land inside the scoring debounce window, when
        // `rows` still reflects the PREVIOUS query — opening an arbitrary
        // file. Flush the debounce and defer the open: the effect below fires
        // it once the scoring memo has re-run against the real query.
        if (query !== scoredQuery || (shownRows.length === 0 && !homeSettled)) {
          pendingOpenQueryRef.current = query;
          setScoredQuery(query);
          return;
        }
        openPick(picks[selectedIndex]);
      }
    },
    [
      onClose,
      openPick,
      completeTo,
      picks,
      shownRows.length,
      homeSettled,
      anywhereEnabled,
      pathReady,
      cwd,
      pathMode,
      pathSettled,
      selectedIndex,
      query,
      scoredQuery,
    ],
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
        fontFamily: "var(--font-sans)",
        padding: "60px 24px 24px",
      }}
      className="spark-fade-in"
      onMouseDown={onClose}
    >
      {/* Liquid glass belongs on the card, not across the entire workbench. */}
      <div className="spark-scrim spark-scrim--clear spark-scrim--palette" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Open file"
        className="spark-glass--strong spark-overlay-surface"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
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
          <div style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                // Typing after a deferred Enter supersedes it, and a pick
                // still being checked.
                pendingOpenQueryRef.current = null;
                pickGenerationRef.current += 1;
                setPickError(null);
                setQuery(e.currentTarget.value);
              }}
              onKeyDown={handleKeyDown}
              placeholder={cwd ? "Open file..." : "Open a workspace first"}
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
                // The run switcher's field: the palette's one input, focused
                // the whole time it is open, so it needs no ring to say so.
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                padding: "8px 28px 8px 10px",
                outline: "none",
                boxShadow: "var(--well)",
              }}
            />
            {query.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  pendingOpenQueryRef.current = null;
                  pickGenerationRef.current += 1;
                  setPickError(null);
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
        </header>

        <div
          className="spark-quick-open__results"
          style={{
            // Sized to the results, like Spotlight: a short list stays a short
            // card instead of a tall panel with one row at the top.
            height:
              items.length > 0 && cwd && !loading && !error
                ? `min(${items.length * RESULT_ROW_HEIGHT + 8}px, 520px, calc(100vh - 170px))`
                : 150,
          }}
        >
          {error ? (
            <Empty eyebrow="File search error" text={error} danger />
          ) : !cwd ? (
            <Empty eyebrow="No workspace" text="Open a workspace to search its files." />
          ) : loading ? (
            <Empty eyebrow="Loading" text="Indexing the workspace…" loading />
          ) : items.length === 0 ? (
            files.length === 0 ? (
              <Empty eyebrow="No files" text="This workspace has no files to open." />
            ) : (
              <Empty eyebrow="No matches" text="Nothing matched. Try a different name or path fragment." />
            )
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              style={{ height: "100%", width: "100%" }}
              fixedItemHeight={RESULT_ROW_HEIGHT}
              totalCount={items.length}
              overscan={400}
              itemContent={(index) => {
                const item = items[index];
                if (!item) return null;
                if (item.kind === "heading") return <SectionHeading />;
                if (item.kind === "status") return <SectionStatus text={item.text} danger={item.danger} />;
                const pick = item.pick;
                if (item.kind === "path") {
                  const openHere = item.hit.kind === "folder";
                  return (
                    <FileResultRow
                      name={item.hit.name}
                      isDir={item.hit.isDir}
                      directory={openHere ? "Open as workspace" : item.hit.label}
                      title={item.hit.path}
                      active={pick === selectedIndex}
                      onMouseEnter={() => setSelectedIndex(pick)}
                      onClick={() => openPick(picks[pick])}
                    />
                  );
                }
                return item.kind === "file" ? (
                  <FileResultRow
                    name={item.row.entry.name}
                    directory={item.row.directory}
                    title={item.row.entry.path}
                    active={pick === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(pick)}
                    onClick={() => openPick(picks[pick])}
                  />
                ) : (
                  <FileResultRow
                    name={item.hit.name}
                    directory={homeDirectoryLabel(item.hit.rel)}
                    title={item.hit.path}
                    active={pick === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(pick)}
                    onClick={() => openPick(picks[pick])}
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
            {pathMode ? (
              <>
                <span style={{ color: "var(--ink-dim)" }}>{pathHits.length}</span> {pathHits.length === 1 ? "path" : "paths"}
              </>
            ) : (
              <>
                <span style={{ color: "var(--ink-dim)" }}>{rows.length}</span> shown of{" "}
                <span style={{ color: "var(--ink-dim)" }}>{files.length}</span> files
              </>
            )}
            {homeVisible && homeHits.length > 0 ? (
              <>
                {" "}· <span style={{ color: "var(--ink-dim)" }}>{homeHits.length}</span> elsewhere
              </>
            ) : null}
          </span>
          <span style={{ flex: 1 }} />
          {pathMode && pathResult.truncated ? (
            <span style={{ color: "var(--warn)" }}>Long folder. Keep typing to filter</span>
          ) : pathMode ? (
            <span>Enter opens · Tab completes</span>
          ) : truncated || (homeVisible && home.truncated) ? (
            <span style={{ color: "var(--warn)" }}>
              {truncated ? "File list capped" : "Home search stopped early"}. Refine the query
            </span>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

const RESULT_ROW_HEIGHT = 28;
const EMPTY_ROWS: FileRow[] = [];
const EMPTY_PATH_HITS: PathQueryHit[] = [];

function entryFromName(name: string, path: string): FsEntry {
  const dot = name.lastIndexOf(".");
  return { name, path, isDir: false, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined };
}

function entryFromHit(hit: HomeFileHit, path: string): FsEntry {
  return entryFromName(hit.name, path);
}

/** "~/Documents/notes" for a file at ~/Documents/notes/x.md; "~" at the top. */
function homeDirectoryLabel(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash < 0 ? "~" : `~/${rel.slice(0, slash)}`;
}

function SectionHeading() {
  return (
    <div
      role="presentation"
      className="spark-eyebrow"
      style={{
        display: "flex",
        alignItems: "flex-end",
        height: RESULT_ROW_HEIGHT,
        boxSizing: "border-box",
        margin: "0 6px",
        padding: "0 10px 5px",
      }}
    >
      Elsewhere on this computer
    </div>
  );
}

function SectionStatus({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        height: RESULT_ROW_HEIGHT,
        boxSizing: "border-box",
        margin: "0 6px",
        padding: "0 10px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: danger ? "var(--danger)" : "var(--muted-2)",
        fontSize: 12,
      }}
    >
      {text}
    </div>
  );
}

function FileResultRow({
  name,
  isDir = false,
  directory,
  title,
  active,
  onMouseEnter,
  onClick,
}: {
  name: string;
  isDir?: boolean;
  directory: string;
  title: string;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-selected={active}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      title={title}
      // The selected row is the inset capsule every palette and glass menu
      // uses (the run switcher's row), not a full-width bar.
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "0 6px",
        padding: "0 10px",
        height: RESULT_ROW_HEIGHT,
        boxSizing: "border-box",
        borderRadius: 7,
        background: active ? "var(--hover-strong)" : "transparent",
        boxShadow: active ? "inset 0 0 0 1px color-mix(in oklab, var(--ink) 7%, transparent)" : "none",
        color: "var(--ink-dim)",
        cursor: "default",
      }}
    >
      <FileNodeIcon name={name} isDir={isDir} size={15} />
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
        {name}
      </span>
      {directory ? (
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
          {directory}
        </span>
      ) : null}
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
        height: "100%",
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

// `path` is the relative path already lowered by the caller, which needs it for
// the sort tiebreak anyway — lowering it once per file rather than twice.
function scoreFile(path: string, name: string, tokens: string[]): number | null {
  if (tokens.length === 0) return 0;
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
