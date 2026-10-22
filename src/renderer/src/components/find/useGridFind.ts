import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  IDLE_FIND_STATUS,
  compileFind,
  firstCellMatchFrom,
  scanCells,
  stepMatch,
  type CellMatch,
  type CellSource,
  type FindStatus,
} from "./find-engine";
import { FindHighlights, scrollRangeIntoView, selectRange, selectionTextWithin } from "./dom-find";
import { useFindSession } from "./useFindSession";
import { barInset, useFindKeys, type SurfaceFind } from "./useDomFind";

// Find in a table (CSV, spreadsheets). Rows are virtualized, so matching runs
// over the cell values in display order (after any sort or filter), and only
// the cells on screen are painted: every mounted cell carries
// data-cell=<cellId>, and the paint runs again whenever rows mount. A big
// table is searched in slices so typing never freezes the window.

export interface GridSource extends CellSource {
  /** The data-cell attribute of the cell at a display position. */
  cellId: (row: number, column: number) => string;
}

export interface GridFindConfig {
  /** Root of the surface: Ctrl+F with focus anywhere inside opens this find. */
  hostRef: RefObject<HTMLElement>;
  /** The virtualized table's scroll container. */
  scrollerRef: RefObject<HTMLElement | null>;
  /** Where focus goes on close when nothing inside the surface had it. */
  focusRef?: RefObject<HTMLElement | null>;
  /** Memoized: a new object means the cells or their order changed. */
  grid: GridSource | null;
  /** Mounts the row at a display position (the virtualizer's scrollToIndex). */
  scrollToRow: (row: number) => void;
  /** The cell a search starts from (a selected cell), else the first row in view. */
  anchorCell?: () => { row: number; column: number } | null;
  label: string;
}

/** Cells scanned per slice before yielding to the window. */
const SLICE_MS = 12;

/** The cell's text nodes, to map a match's offsets onto. */
function cellRange(cell: HTMLElement, expected: string, match: CellMatch): Range | null {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    text += (node as Text).data;
  }
  const range = document.createRange();
  if (text !== expected || nodes.length === 0) {
    // The cell shows something other than its value: mark the whole cell.
    range.selectNodeContents(cell);
    return range;
  }
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const end = offset + node.data.length;
    if (!started && match.start < end) {
      range.setStart(node, match.start - offset);
      started = true;
    }
    if (started && match.end <= end) {
      range.setEnd(node, match.end - offset);
      return range;
    }
    offset = end;
  }
  return null;
}

export function useGridFind({
  hostRef,
  scrollerRef,
  focusRef,
  grid,
  scrollToRow,
  anchorCell,
  label,
}: GridFindConfig): SurfaceFind {
  const anchorAtOpen = useRef<{ row: number; column: number } | null>(null);
  const session = useFindSession({
    rootRef: hostRef,
    enabled: grid !== null,
    readSelection: () => {
      anchorAtOpen.current = anchorCell?.() ?? null;
      return selectionTextWithin(scrollerRef.current);
    },
    fallbackFocus: () => focusRef?.current ?? scrollerRef.current,
  });
  const { open, query, options, openToken } = session;
  const highlights = useMemo(() => new FindHighlights(), []);
  const [status, setStatus] = useState<FindStatus>(IDLE_FIND_STATUS);
  const state = useRef<{
    /** The table `matches` were found in. */
    grid: GridSource | null;
    matches: CellMatch[];
    byCell: Map<string, number[]>;
    current: number;
    anchor: { row: number; column: number };
    revealPending: boolean;
    searched: { query: string; options: typeof options; openToken: number } | null;
  }>({
    grid: null,
    matches: [],
    byCell: new Map(),
    current: -1,
    anchor: { row: 0, column: 0 },
    revealPending: false,
    searched: null,
  });
  const latest = useRef({ scrollToRow });
  latest.current = { scrollToRow };

  /** Sticky header and row-number column, which a match must not land under. */
  const insets = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return { top: 0, left: 0 };
    const box = scroller.getBoundingClientRect();
    const head = scroller.querySelector("thead");
    const rowHeader = scroller.querySelector("tbody th");
    return {
      top: Math.max(barInset(hostRef.current, scroller), head ? head.getBoundingClientRect().bottom - box.top : 0),
      left: rowHeader ? Math.max(0, rowHeader.getBoundingClientRect().right - box.left) : 0,
    };
  }, [hostRef, scrollerRef]);

  const paint = useCallback((): Range | null => {
    const s = state.current;
    const scroller = scrollerRef.current;
    if (!scroller || !s.grid || s.matches.length === 0) {
      highlights.clear();
      return null;
    }
    const ranges: Range[] = [];
    let currentRange: Range | null = null;
    for (const cell of scroller.querySelectorAll<HTMLElement>("[data-cell]")) {
      const hits = s.byCell.get(cell.dataset.cell ?? "");
      if (!hits) continue;
      const first = s.matches[hits[0]];
      const expected = s.grid.text(first.row, first.column);
      for (const i of hits) {
        const range = cellRange(cell, expected, s.matches[i]);
        if (!range) continue;
        ranges.push(range);
        if (i === s.current) currentRange = range;
      }
    }
    highlights.setMatches(ranges);
    highlights.setCurrent(currentRange);
    return currentRange;
  }, [highlights, scrollerRef]);

  const reveal = useCallback(() => {
    const s = state.current;
    const scroller = scrollerRef.current;
    const match = s.matches[s.current];
    if (!scroller || !match) return;
    const range = paint();
    if (range) {
      s.revealPending = false;
      const { top, left } = insets();
      scrollRangeIntoView(range, scroller, top, left);
      return;
    }
    // Not mounted: bring the row in; the paint after it mounts centres it.
    s.revealPending = true;
    latest.current.scrollToRow(match.row);
  }, [scrollerRef, paint, insets]);

  const setCurrent = useCallback(
    (next: number, scroll: boolean) => {
      const s = state.current;
      s.current = next;
      if (next >= 0) s.anchor = { row: s.matches[next].row, column: s.matches[next].column };
      if (scroll && next >= 0) reveal();
      else paint();
      setStatus((prev) => (prev.current === next ? prev : { ...prev, current: next }));
    },
    [paint, reveal],
  );

  // Rows mount and unmount as the table scrolls: repaint what is on screen.
  useEffect(() => {
    const host = hostRef.current;
    if (!open || !host) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const s = state.current;
        const range = paint();
        if (range && s.revealPending) {
          s.revealPending = false;
          const scroller = scrollerRef.current;
          const { top, left } = insets();
          if (scroller) scrollRangeIntoView(range, scroller, top, left);
        }
      });
    });
    observer.observe(host, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [open, hostRef, scrollerRef, paint, insets]);

  useEffect(() => {
    const s = state.current;
    if (!open) {
      highlights.clear();
      s.searched = null;
      s.revealPending = false;
      return;
    }
    const previous = s.searched;
    const reopened = !previous || previous.openToken !== openToken;
    const queryChanged = !previous || previous.query !== query || previous.options !== options;
    s.searched = { query, options, openToken };
    if (reopened) {
      const picked = anchorAtOpen.current;
      anchorAtOpen.current = null;
      s.anchor = picked ?? { row: firstRowInView(scrollerRef.current, insets().top), column: 0 };
    }
    const compiled = compileFind(query, options, { collapseWhitespace: true });
    if (!grid || !compiled || !compiled.ok) {
      s.grid = grid;
      s.matches = [];
      s.byCell = new Map();
      s.current = -1;
      s.revealPending = false;
      highlights.clear();
      setStatus({ ...IDLE_FIND_STATUS, error: compiled && !compiled.ok ? compiled.error : null });
      return;
    }
    const matches: CellMatch[] = [];
    let row = 0;
    let capped = false;
    let timer = 0;
    const finish = () => {
      const byCell = new Map<string, number[]>();
      matches.forEach((match, i) => {
        const id = grid.cellId(match.row, match.column);
        const list = byCell.get(id);
        if (list) list.push(i);
        else byCell.set(id, [i]);
      });
      s.grid = grid;
      s.matches = matches;
      s.byCell = byCell;
      setStatus({ total: matches.length, current: -1, capped, pending: false, error: null });
      // A sort, filter or edit keeps the current match without scrolling.
      setCurrent(firstCellMatchFrom(matches, s.anchor.row, s.anchor.column), queryChanged || reopened);
    };
    const slice = () => {
      const until = performance.now() + SLICE_MS;
      while (row < grid.rows && !capped && performance.now() < until) {
        capped = scanCells(grid, compiled, row, row + 1, matches);
        row += 1;
      }
      if (row < grid.rows && !capped) {
        setStatus((prev) => ({ ...prev, pending: true }));
        timer = window.setTimeout(slice, 0);
        return;
      }
      timer = 0;
      finish();
    };
    slice();
    return () => window.clearTimeout(timer);
  }, [open, query, options, openToken, grid, scrollerRef, highlights, insets, setCurrent]);

  useEffect(() => () => highlights.clear(), [highlights]);

  const step = useCallback(
    (delta: number) => {
      const s = state.current;
      if (s.matches.length === 0) return;
      setCurrent(stepMatch(s.current, delta, s.matches.length), true);
    },
    [setCurrent],
  );
  const next = useCallback(() => step(1), [step]);
  const previous = useCallback(() => step(-1), [step]);

  const close = useCallback(() => {
    const range = paint();
    highlights.clear();
    session.close();
    selectRange(range);
  }, [paint, highlights, session]);

  const onKeyDown = useFindKeys(open, next, previous, close);

  return {
    session,
    onKeyDown,
    bar: open
      ? {
          label,
          query,
          onQueryChange: session.setQuery,
          options,
          onOptionsChange: session.setOptions,
          status,
          onNext: next,
          onPrevious: previous,
          onClose: close,
          focusToken: session.focusToken,
        }
      : null,
  };
}

/** Display index of the first row below the sticky header (virtualizers tag rows with data-index). */
function firstRowInView(scroller: HTMLElement | null, topInset: number): number {
  if (!scroller) return 0;
  const top = scroller.getBoundingClientRect().top + topInset;
  for (const row of scroller.querySelectorAll<HTMLElement>("tbody tr[data-index]")) {
    if (row.getBoundingClientRect().bottom > top + 4) return Number(row.dataset.index) || 0;
  }
  return 0;
}
