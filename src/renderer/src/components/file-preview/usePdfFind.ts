import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  IDLE_FIND_STATUS,
  compileFind,
  findAllMatches,
  firstMatchFrom,
  stepMatch,
  type FindStatus,
} from "../find/find-engine";
import { FindHighlights, scrollRangeIntoView, selectRange, selectionTextWithin } from "../find/dom-find";
import { TextIndexBuilder, locateOffset, type TextIndex } from "../find/text-index";
import { useFindSession } from "../find/useFindSession";
import { barInset, useFindKeys, type SurfaceFind } from "../find/useDomFind";

// Find in a PDF. Pages render lazily, so matching runs over the text pdf.js
// extracts for every page (the same TextContent the text layers are built
// from), and a match is painted only once its page's text layer exists. The
// current match on a page not rendered yet scrolls that page into view; its
// text layer then reports in and the match is centred precisely.

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

interface PdfItem {
  page: number;
  /** Index among the page's text items (marked-content entries excluded), as TextLayer.textDivs. */
  item: number;
}

interface PdfMatch {
  page: number;
  from: { item: number; offset: number };
  to: { item: number; offset: number };
  start: number;
}

export interface PdfFind extends SurfaceFind {
  /** A page's text layer finished rendering (divs) or went away (null). */
  onTextLayer: (page: number, divs: HTMLElement[] | null) => void;
}

function isTextItem(item: TextContent["items"][number]): item is Extract<TextContent["items"][number], { str: string }> {
  return "str" in item;
}

export function usePdfFind({
  doc,
  hostRef,
  scrollerRef,
  getTextContent,
}: {
  doc: PDFDocumentProxy | null;
  hostRef: RefObject<HTMLElement>;
  scrollerRef: RefObject<HTMLElement>;
  getTextContent: (page: number) => Promise<TextContent>;
}): PdfFind {
  const selectionAtOpen = useRef<Range | null>(null);
  const session = useFindSession({
    rootRef: hostRef,
    enabled: doc !== null,
    readSelection: () => {
      const text = selectionTextWithin(scrollerRef.current);
      const selection = window.getSelection();
      selectionAtOpen.current =
        text !== null && selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      return text;
    },
    fallbackFocus: () => scrollerRef.current,
  });
  const { open, query, options, openToken } = session;
  const highlights = useMemo(() => new FindHighlights(), []);
  const [index, setIndex] = useState<{ doc: PDFDocumentProxy; index: TextIndex<PdfItem> } | null>(null);
  const [status, setStatus] = useState<FindStatus>(IDLE_FIND_STATUS);
  const layers = useRef(new Map<number, HTMLElement[]>());
  const state = useRef<{
    matches: PdfMatch[];
    current: number;
    anchor: number;
    revealPending: boolean;
    searched: { query: string; options: typeof options; openToken: number; index: unknown } | null;
  }>({ matches: [], current: -1, anchor: 0, revealPending: false, searched: null });

  // Extract every page's text the first time find opens on this document.
  useEffect(() => {
    if (!open || !doc || index?.doc === doc) return;
    let cancelled = false;
    setStatus({ ...IDLE_FIND_STATUS, pending: true });
    void (async () => {
      const builder = new TextIndexBuilder<PdfItem>();
      try {
        for (let page = 1; page <= doc.numPages; page++) {
          const content = await getTextContent(page);
          if (cancelled) return;
          let item = 0;
          for (const entry of content.items) {
            if (!isTextItem(entry)) continue;
            builder.addText({ page, item }, entry.str, page, true);
            if (entry.hasEOL) builder.lineBreak();
            item += 1;
          }
        }
      } catch {
        // A page whose text cannot be read searches as empty.
      }
      if (!cancelled) setIndex({ doc, index: builder.finish() });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, doc, index, getTextContent]);

  const rangeFor = useCallback((match: PdfMatch): Range | null => {
    const divs = layers.current.get(match.page);
    const start = divs?.[match.from.item]?.firstChild;
    const end = divs?.[match.to.item]?.firstChild;
    if (!start || !end) return null;
    try {
      const range = document.createRange();
      range.setStart(start, match.from.offset);
      range.setEnd(end, match.to.offset);
      return range;
    } catch {
      return null;
    }
  }, []);

  const paint = useCallback(() => {
    const s = state.current;
    const ranges: Range[] = [];
    let currentRange: Range | null = null;
    s.matches.forEach((match, i) => {
      if (!layers.current.has(match.page)) return;
      const range = rangeFor(match);
      if (!range) return;
      ranges.push(range);
      if (i === s.current) currentRange = range;
    });
    highlights.setMatches(ranges);
    highlights.setCurrent(currentRange);
    return currentRange as Range | null;
  }, [highlights, rangeFor]);

  const reveal = useCallback(() => {
    const s = state.current;
    const scroller = scrollerRef.current;
    const match = s.matches[s.current];
    if (!scroller || !match) return;
    const inset = barInset(hostRef.current, scroller);
    const range = layers.current.has(match.page) ? rangeFor(match) : null;
    if (range) {
      s.revealPending = false;
      scrollRangeIntoView(range, scroller, inset);
      return;
    }
    // Not rendered yet: bring the page in; its text layer finishes the job.
    s.revealPending = true;
    const pageEl = scroller.querySelector<HTMLElement>(`[data-pdf-page="${match.page}"]`);
    if (pageEl) {
      scroller.scrollTop += pageEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top - inset;
    }
  }, [hostRef, scrollerRef, rangeFor]);

  const setCurrent = useCallback(
    (next: number, scroll: boolean) => {
      const s = state.current;
      s.current = next;
      if (next >= 0) s.anchor = s.matches[next].start;
      paint();
      if (scroll && next >= 0) reveal();
      setStatus((prev) => (prev.current === next ? prev : { ...prev, current: next }));
    },
    [paint, reveal],
  );

  const offsetOf = useCallback((pdfIndex: TextIndex<PdfItem>, page: number, item: number, offset: number) => {
    const { nodes, starts } = pdfIndex;
    let lo = 0;
    let hi = nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const node = nodes[mid];
      if (node.page < page || (node.page === page && node.item < item)) lo = mid + 1;
      else hi = mid;
    }
    return lo < nodes.length ? starts[lo] + (nodes[lo].page === page && nodes[lo].item === item ? offset : 0) : 0;
  }, []);

  // Where a fresh search starts: the selection, else the first page in view.
  const anchorAtOpen = useCallback(
    (pdfIndex: TextIndex<PdfItem>): number => {
      const range = selectionAtOpen.current;
      selectionAtOpen.current = null;
      const span = range?.startContainer.parentElement;
      const pageEl = span?.closest<HTMLElement>("[data-pdf-page]");
      if (range && span && pageEl) {
        const page = Number(pageEl.dataset.pdfPage);
        const item = layers.current.get(page)?.indexOf(span) ?? -1;
        if (item >= 0) return offsetOf(pdfIndex, page, item, range.startOffset);
      }
      const scroller = scrollerRef.current;
      if (!scroller) return 0;
      const top = scroller.getBoundingClientRect().top + barInset(hostRef.current, scroller);
      for (const pageEl of scroller.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
        if (pageEl.getBoundingClientRect().bottom > top) return offsetOf(pdfIndex, Number(pageEl.dataset.pdfPage), 0, 0);
      }
      return 0;
    },
    [hostRef, scrollerRef, offsetOf],
  );

  useEffect(() => {
    const s = state.current;
    if (!open) {
      highlights.clear();
      s.searched = null;
      return;
    }
    if (!index || index.doc !== doc) return;
    const previous = s.searched;
    const reopened = !previous || previous.openToken !== openToken || previous.index !== index;
    s.searched = { query, options, openToken, index };
    if (reopened) s.anchor = anchorAtOpen(index.index);
    const compiled = compileFind(query, options, { collapseWhitespace: true });
    if (!compiled || !compiled.ok) {
      s.matches = [];
      s.current = -1;
      highlights.clear();
      setStatus({ ...IDLE_FIND_STATUS, error: compiled && !compiled.ok ? compiled.error : null });
      return;
    }
    const found = findAllMatches(index.index.text, compiled);
    const matches: PdfMatch[] = [];
    found.starts.forEach((start, i) => {
      const from = locateOffset(index.index, start, "start");
      const to = locateOffset(index.index, found.ends[i], "end");
      // A pattern spanning two pages has nothing to paint on either.
      if (!from || !to || from.node.page !== to.node.page) return;
      matches.push({
        page: from.node.page,
        from: { item: from.node.item, offset: from.offset },
        to: { item: to.node.item, offset: to.offset },
        start,
      });
    });
    s.matches = matches;
    setStatus({ total: matches.length, current: -1, capped: found.capped, pending: false, error: null });
    setCurrent(
      firstMatchFrom(
        matches.map((match) => match.start),
        s.anchor,
      ),
      true,
    );
  }, [open, query, options, openToken, index, doc, highlights, anchorAtOpen, setCurrent]);

  useEffect(() => () => highlights.clear(), [highlights]);

  const onTextLayer = useCallback(
    (page: number, divs: HTMLElement[] | null) => {
      if (divs) layers.current.set(page, divs);
      else layers.current.delete(page);
      const s = state.current;
      if (!s.searched) return;
      paint();
      if (divs && s.revealPending && s.matches[s.current]?.page === page) reveal();
    },
    [paint, reveal],
  );

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
    const s = state.current;
    const match = s.matches[s.current];
    const range = match && layers.current.has(match.page) ? rangeFor(match) : null;
    highlights.clear();
    session.close();
    selectRange(range);
  }, [highlights, rangeFor, session]);

  const onKeyDown = useFindKeys(open, next, previous, close);

  return {
    session,
    onKeyDown,
    onTextLayer,
    bar: open
      ? {
          label: "Find in PDF",
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
