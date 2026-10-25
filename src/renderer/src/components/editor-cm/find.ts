import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorSelection, Prec, type EditorState, type Extension, type SelectionRange } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  gotoLine,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  selectNextOccurrence,
  selectSelectionMatches,
  setSearchQuery,
} from "@codemirror/search";
import {
  IDLE_FIND_STATUS,
  MAX_FIND_MATCHES,
  compileFind,
  seedFromSelection,
  type FindOptions,
  type FindStatus,
} from "../find/find-engine";
import type { FindBarProps } from "../find/FindBar";
import type { FindSession } from "../find/useFindSession";
import { IS_MAC } from "../../shortcuts/platform";

// The editor's find bar drives @codemirror/search instead of showing its
// panel: the query lives in CodeMirror's search state, so its own match
// highlighting (current match marked apart), find next / previous with
// wrap-around, and regex-aware replace all keep working. CodeMirror only
// highlights while its panel is "open", so the panel it opens is an empty,
// hidden element and the real bar floats above the editor.

/** Above this many characters, counting waits for a pause in typing. */
const DEBOUNCE_CHARS = 400_000;

export interface EditorFindBridge {
  open: boolean;
  next(): void;
  previous(): void;
  close(): void;
  openReplace(): void;
  /** Height of the bar over the top of the editor, so a match never hides under it. */
  topInset(): number;
  onUpdate(update: ViewUpdate): void;
}

function hiddenPanel() {
  const dom = document.createElement("div");
  dom.className = "codara-cm-find-anchor";
  dom.hidden = true;
  return { dom, top: true };
}

/** Centre a match that is off screen (or under the bar); leave a visible one where it is. */
function revealMatch(view: EditorView, range: SelectionRange, topInset: number) {
  const box = view.scrollDOM.getBoundingClientRect();
  const start = view.coordsAtPos(range.from);
  const end = view.coordsAtPos(range.to);
  const visible =
    start !== null &&
    end !== null &&
    start.top >= box.top + topInset &&
    end.bottom <= box.bottom - 4;
  return EditorView.scrollIntoView(range, { y: visible ? "nearest" : "center", x: "nearest", xMargin: 24 });
}

export function editorFindExtension(bridge: { current: EditorFindBridge }): Extension {
  const whenOpen = (run: () => void) => () => {
    if (!bridge.current.open) return false;
    run();
    return true;
  };
  return [
    search({
      top: true,
      createPanel: hiddenPanel,
      scrollToMatch: (range, view) => revealMatch(view, range, bridge.current.topInset()),
    }),
    // Above the default keymap, whose Escape would otherwise only collapse
    // the selected match.
    Prec.high(
      keymap.of([
        { key: "Escape", run: whenOpen(() => bridge.current.close()) },
        { key: "F3", run: whenOpen(() => bridge.current.next()), shift: whenOpen(() => bridge.current.previous()), preventDefault: true },
        { key: "Mod-g", run: whenOpen(() => bridge.current.next()), shift: whenOpen(() => bridge.current.previous()), preventDefault: true },
        {
          key: IS_MAC ? "Mod-Alt-f" : "Mod-h",
          run: () => {
            bridge.current.openReplace();
            return true;
          },
          preventDefault: true,
        },
      ]),
    ),
    // The rest of the stock search keymap; its Mod-f panel is replaced by
    // the find bar, which Ctrl+F reaches through the find router.
    keymap.of([
      { key: "Mod-Shift-l", run: selectSelectionMatches },
      { key: "Mod-Alt-g", run: gotoLine },
      { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
    ]),
    EditorView.updateListener.of((update) => bridge.current.onUpdate(update)),
    EditorView.theme({
      ".cm-searchMatch": {
        backgroundColor: "var(--find-match-bg) !important",
        borderRadius: "2px",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "var(--find-current-code-bg) !important",
        boxShadow: "0 0 0 1px var(--find-current-edge)",
      },
    }),
  ];
}

function buildQuery(query: string, options: FindOptions, replace: string): SearchQuery {
  return new SearchQuery({
    search: query,
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    regexp: options.regex,
    // A literal search means what was typed: "\n" stays two characters.
    literal: !options.regex,
    replace,
  });
}

interface MatchCache {
  doc: EditorState["doc"] | null;
  query: SearchQuery | null;
  starts: number[];
  ends: number[];
  capped: boolean;
}

function countMatches(state: EditorState, query: SearchQuery): Omit<MatchCache, "doc" | "query"> {
  const starts: number[] = [];
  const ends: number[] = [];
  let capped = false;
  const cursor = query.getCursor(state);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    if (starts.length >= MAX_FIND_MATCHES) {
      capped = true;
      break;
    }
    starts.push(step.value.from);
    ends.push(step.value.to);
  }
  return { starts, ends, capped };
}

function currentIndex(cache: MatchCache, state: EditorState): number {
  const { from, to } = state.selection.main;
  let lo = 0;
  let hi = cache.starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cache.starts[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < cache.starts.length && cache.starts[lo] === from && cache.ends[lo] === to ? lo : -1;
}

/** First match at or after `anchor`, wrapping to the top. */
function nearestMatch(state: EditorState, query: SearchQuery, anchor: number) {
  const after = query.getCursor(state, anchor).next();
  if (!after.done) return after.value;
  const before = query.getCursor(state, 0, anchor).next();
  return before.done ? null : before.value;
}

let sharedReplace = "";

export interface EditorFind {
  extension: Extension;
  bar: FindBarProps | null;
  /** Call from CodeMirror's onCreateEditor: a remounted view needs the search state again. */
  onViewCreated: () => void;
}

export function useEditorFind(
  session: FindSession,
  getView: () => EditorView | null,
  hostRef: { current: HTMLElement | null },
  label: string,
): EditorFind {
  const { open, query, options, openToken } = session;
  const [status, setStatus] = useState<FindStatus>(IDLE_FIND_STATUS);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceFocus, setReplaceFocus] = useState(0);
  const [replaceValue, setReplaceValue] = useState(() => sharedReplace);
  const [docVersion, setDocVersion] = useState(0);
  const [viewVersion, setViewVersion] = useState(0);
  const cache = useRef<MatchCache>({ doc: null, query: null, starts: [], ends: [], capped: false });
  const anchor = useRef(0);
  const applied = useRef<{ query: string; options: FindOptions; openToken: number; viewVersion: number } | null>(null);

  const refreshCurrent = useCallback(() => {
    const view = getView();
    if (!view || !cache.current.query) return;
    const current = currentIndex(cache.current, view.state);
    setStatus((prev) => (prev.current === current ? prev : { ...prev, current }));
  }, [getView]);

  const step = useCallback(
    (forward: boolean) => {
      const view = getView();
      if (!view) return;
      if (forward) findNext(view);
      else findPrevious(view);
      anchor.current = view.state.selection.main.from;
    },
    [getView],
  );

  const bridgeClose = useRef<() => void>(() => undefined);
  const bridge = useRef<EditorFindBridge>(null as unknown as EditorFindBridge);
  bridge.current = {
    open,
    next: () => step(true),
    previous: () => step(false),
    close: () => bridgeClose.current(),
    openReplace: () => {
      // As in VS Code: with something to find (the selection or the last
      // query) the caret goes to the replace field, else to the find field.
      const view = getView();
      const selected = view
        ? seedFromSelection(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to))
        : null;
      setReplaceOpen(true);
      session.openFind();
      if (selected || query) setReplaceFocus((token) => token + 1);
    },
    topInset: () => {
      const view = getView();
      const bar = hostRef.current?.querySelector(".codara-find");
      if (!view || !bar) return 0;
      return Math.max(0, bar.getBoundingClientRect().bottom - view.scrollDOM.getBoundingClientRect().top + 6);
    },
    onUpdate: (update) => {
      if (!open) return;
      if (update.docChanged) setDocVersion((version) => version + 1);
      else if (update.selectionSet) refreshCurrent();
    },
  };

  const extension = useMemo(() => editorFindExtension(bridge), []);

  // Push the query into CodeMirror; on a new query, select the nearest
  // match from where the search started, as typing does in an editor.
  useEffect(() => {
    const view = getView();
    if (!view) return;
    if (!open) {
      applied.current = null;
      if (searchPanelOpen(view.state)) closeSearchPanel(view);
      return;
    }
    if (!searchPanelOpen(view.state)) openSearchPanel(view);
    const spec = buildQuery(query, options, replaceValue);
    view.dispatch({ effects: setSearchQuery.of(spec) });
    const previous = applied.current;
    const reopened = !previous || previous.openToken !== openToken || previous.viewVersion !== viewVersion;
    const moved = reopened || previous.query !== query || previous.options !== options;
    applied.current = { query, options, openToken, viewVersion };
    if (reopened) anchor.current = view.state.selection.main.from;
    if (!moved || !spec.valid) return;
    const select = () => {
      const match = nearestMatch(view.state, spec, anchor.current);
      if (!match) return;
      const range = EditorSelection.range(match.from, match.to);
      view.dispatch({
        selection: EditorSelection.create([range]),
        effects: revealMatch(view, range, bridge.current.topInset()),
        userEvent: "select.search",
      });
    };
    if (view.state.doc.length < DEBOUNCE_CHARS) {
      select();
      return;
    }
    const timer = window.setTimeout(select, 140);
    return () => window.clearTimeout(timer);
  }, [open, query, options, replaceValue, openToken, viewVersion, getView]);

  // Count every match (up to the cap) for "3 of 41". Large documents count
  // after a pause in typing; the highlighting itself never waits, since
  // CodeMirror only paints the visible lines.
  useEffect(() => {
    const view = getView();
    if (!view || !open) {
      cache.current = { doc: null, query: null, starts: [], ends: [], capped: false };
      setStatus(IDLE_FIND_STATUS);
      return;
    }
    const spec = buildQuery(query, options, "");
    if (!query) {
      cache.current = { doc: null, query: null, starts: [], ends: [], capped: false };
      setStatus(IDLE_FIND_STATUS);
      return;
    }
    if (!spec.valid) {
      const compiled = compileFind(query, options);
      cache.current = { doc: null, query: null, starts: [], ends: [], capped: false };
      setStatus({
        ...IDLE_FIND_STATUS,
        error: compiled && !compiled.ok ? compiled.error : "Invalid regular expression",
      });
      return;
    }
    const count = () => {
      const result = countMatches(view.state, spec);
      cache.current = { doc: view.state.doc, query: spec, ...result };
      setStatus({
        total: result.starts.length,
        current: currentIndex(cache.current, view.state),
        capped: result.capped,
        pending: false,
        error: null,
      });
    };
    if (view.state.doc.length < DEBOUNCE_CHARS) {
      count();
      return;
    }
    setStatus((prev) => ({ ...prev, pending: true }));
    const timer = window.setTimeout(count, 180);
    return () => window.clearTimeout(timer);
  }, [open, query, options, docVersion, viewVersion, getView]);

  const close = useCallback(() => {
    const view = getView();
    if (view && searchPanelOpen(view.state)) closeSearchPanel(view);
    applied.current = null;
    // The next Ctrl+F opens plain find; Ctrl+H brings replace back.
    setReplaceOpen(false);
    setReplaceFocus(0);
    session.close();
  }, [getView, session]);
  bridgeClose.current = close;

  const onViewCreated = useCallback(() => setViewVersion((version) => version + 1), []);

  const replace = useCallback(
    (all: boolean) => {
      const view = getView();
      if (!view) return;
      if (all) replaceAll(view);
      else replaceNext(view);
      anchor.current = view.state.selection.main.from;
    },
    [getView],
  );

  const bar: FindBarProps | null = open
    ? {
        label,
        query,
        onQueryChange: session.setQuery,
        options,
        onOptionsChange: session.setOptions,
        status,
        onNext: () => step(true),
        onPrevious: () => step(false),
        onClose: close,
        focusToken: session.focusToken,
        replace: {
          open: replaceOpen,
          onOpenChange: setReplaceOpen,
          value: replaceValue,
          onValueChange: (value) => {
            sharedReplace = value;
            setReplaceValue(value);
          },
          onReplace: () => replace(false),
          onReplaceAll: () => replace(true),
          focusToken: replaceFocus,
        },
      }
    : null;

  return { extension, bar, onViewCreated };
}
