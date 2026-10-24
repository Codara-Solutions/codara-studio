import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  IDLE_FIND_STATUS,
  compileFind,
  emptyMatches,
  findAllMatches,
  firstMatchFrom,
  stepMatch,
  type FindStatus,
  type MatchList,
} from "./find-engine";
import {
  FindHighlights,
  firstVisibleOffset,
  indexDomText,
  rangeForMatch,
  revealCollapsed,
  scrollRangeIntoView,
  selectRange,
  selectionTextWithin,
} from "./dom-find";
import type { TextIndex } from "./text-index";
import { IS_MAC } from "../../shortcuts/platform";
import { useFindSession, type FindSession } from "./useFindSession";
import type { FindBarProps } from "./FindBar";

// Find in a rendered document (Markdown preview, Word, PowerPoint): the text
// is indexed straight from the DOM, every match is painted with a CSS
// highlight, and the current one is scrolled to. The index is rebuilt when
// the document re-renders under an open bar (a file reload, a late diagram).

/** Above this much text, re-searching waits for a pause in typing. */
const DEBOUNCE_CHARS = 250_000;

export interface DomFindConfig {
  /** Holds both the document and its bar; Ctrl+F inside it opens this find. */
  hostRef: RefObject<HTMLElement>;
  /** The rendered document whose text is searched. */
  contentRef: RefObject<HTMLElement>;
  /** The scroll container the current match is brought into view in. */
  scrollerRef: RefObject<HTMLElement>;
  enabled?: boolean;
  label: string;
}

export interface SurfaceFind {
  session: FindSession;
  /** Props for <FindBar>, or null while the bar is closed. */
  bar: FindBarProps | null;
  /** F3, Ctrl+G and Escape for focus inside the document itself. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** Space the bar takes over the top of the scroller, so a match never lands under it. */
export function barInset(host: HTMLElement | null, scroller: HTMLElement | null): number {
  const bar = host?.querySelector(".codara-find");
  if (!bar || !scroller) return 0;
  return Math.max(0, bar.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top);
}

export function useDomFind({ hostRef, contentRef, scrollerRef, enabled = true, label }: DomFindConfig): SurfaceFind {
  // The selection when Ctrl+F was pressed: the search starts there. Read at
  // the keypress, before the bar takes focus and the selection with it.
  const selectionAtOpen = useRef<Range | null>(null);
  const session = useFindSession({
    rootRef: hostRef,
    enabled,
    readSelection: () => {
      const text = selectionTextWithin(contentRef.current);
      const selection = window.getSelection();
      selectionAtOpen.current =
        text !== null && selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      return text;
    },
    fallbackFocus: () => scrollerRef.current,
  });
  const { open, query, options, openToken } = session;
  const highlights = useMemo(() => new FindHighlights(), []);
  const [status, setStatus] = useState<FindStatus>(IDLE_FIND_STATUS);
  const [domVersion, setDomVersion] = useState(0);
  const state = useRef<{
    index: TextIndex<Text> | null;
    indexVersion: number;
    matches: MatchList;
    ranges: (Range | null)[];
    current: number;
    anchor: number;
    searched: { query: string; options: typeof options; domVersion: number; openToken: number } | null;
  }>({
    index: null,
    indexVersion: -1,
    matches: emptyMatches(),
    ranges: [],
    current: -1,
    anchor: 0,
    searched: null,
  });

  const reveal = useCallback(
    (range: Range | null) => {
      const scroller = scrollerRef.current;
      if (!range || !scroller) return;
      revealCollapsed(range);
      scrollRangeIntoView(range, scroller, barInset(hostRef.current, scroller));
    },
    [hostRef, scrollerRef],
  );

  const setCurrent = useCallback(
    (next: number, scroll: boolean) => {
      const s = state.current;
      s.current = next;
      const range = next >= 0 ? s.ranges[next] ?? null : null;
      highlights.setCurrent(range);
      if (next >= 0) s.anchor = s.matches.starts[next];
      if (scroll) reveal(range);
      setStatus((prev) => (prev.current === next ? prev : { ...prev, current: next }));
    },
    [highlights, reveal],
  );

  // A re-render of the document under an open bar invalidates the index.
  useEffect(() => {
    if (!open) return;
    const root = contentRef.current;
    if (!root) return;
    let timer = 0;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setDomVersion((version) => version + 1), 120);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [open, contentRef]);

  useEffect(() => {
    const s = state.current;
    if (!open) {
      highlights.clear();
      s.searched = null;
      return;
    }
    const run = () => {
      const root = contentRef.current;
      const scroller = scrollerRef.current;
      if (!s.index || s.indexVersion !== domVersion) {
        s.index = root ? indexDomText(root) : null;
        s.indexVersion = domVersion;
      }
      const index = s.index;
      const previous = s.searched;
      const reopened = !previous || previous.openToken !== openToken;
      const queryChanged =
        !previous || previous.query !== query || previous.options !== options;
      s.searched = { query, options, domVersion, openToken };
      if (reopened && index) {
        // Ctrl+F starts from the selection, else from the top of the view.
        const range = selectionAtOpen.current;
        selectionAtOpen.current = null;
        let anchor = -1;
        if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
          const at = index.nodes.indexOf(range.startContainer as Text);
          if (at >= 0) anchor = index.starts[at] + range.startOffset;
        }
        s.anchor = anchor >= 0 ? anchor : scroller ? firstVisibleOffset(index, scroller, barInset(hostRef.current, scroller)) : 0;
      }
      const compiled = compileFind(query, options, { collapseWhitespace: true });
      if (!index || !compiled || !compiled.ok) {
        s.matches = emptyMatches();
        s.ranges = [];
        highlights.clear();
        s.current = -1;
        setStatus({ ...IDLE_FIND_STATUS, error: compiled && !compiled.ok ? compiled.error : null });
        return;
      }
      const matches = findAllMatches(index.text, compiled);
      const ranges = matches.starts.map((start, i) => rangeForMatch(index, start, matches.ends[i]));
      s.matches = matches;
      s.ranges = ranges;
      highlights.setMatches(ranges.filter((range): range is Range => range !== null));
      setStatus({ total: matches.starts.length, current: -1, capped: matches.capped, pending: false, error: null });
      // Typing keeps the search where it was; a re-render keeps the current
      // match in place without scrolling the reader away.
      setCurrent(firstMatchFrom(matches.starts, s.anchor), queryChanged || reopened);
    };
    const size = s.index?.text.length ?? 0;
    if (size < DEBOUNCE_CHARS || s.searched?.query === query) {
      run();
      return;
    }
    setStatus((prev) => ({ ...prev, pending: true }));
    const timer = window.setTimeout(run, 120);
    return () => window.clearTimeout(timer);
  }, [open, query, options, domVersion, openToken, contentRef, scrollerRef, hostRef, highlights, setCurrent]);

  useEffect(() => () => highlights.clear(), [highlights]);

  const step = useCallback(
    (delta: number) => {
      const s = state.current;
      const count = s.matches.starts.length;
      if (count === 0) return;
      setCurrent(stepMatch(s.current, delta, count), true);
    },
    [setCurrent],
  );
  const next = useCallback(() => step(1), [step]);
  const previous = useCallback(() => step(-1), [step]);

  const close = useCallback(() => {
    const s = state.current;
    const range = s.current >= 0 ? s.ranges[s.current] ?? null : null;
    highlights.clear();
    session.close();
    // As in a browser, the last match stays selected after Escape.
    selectRange(range);
  }, [highlights, session]);

  const onKeyDown = useFindKeys(open, next, previous, close);

  const bar: FindBarProps | null = open
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
    : null;
  return { session, bar, onKeyDown };
}

/** F3 / Shift+F3, Ctrl+G and Escape while focus is in the document, not the bar. */
export function useFindKeys(
  open: boolean,
  next: () => void,
  previous: () => void,
  close: () => void,
): (event: KeyboardEvent<HTMLElement>) => void {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!open || event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target.closest(".codara-find")) return;
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      if (event.key === "Escape") {
        if (target.closest("input, textarea, [contenteditable='true']")) return;
        event.preventDefault();
        close();
      } else if (event.key === "F3" || (mod && !event.altKey && event.key.toLowerCase() === "g")) {
        event.preventDefault();
        if (event.shiftKey) previous();
        else next();
      }
    },
    [open, next, previous, close],
  );
}
