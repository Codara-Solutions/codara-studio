import { createContext, useCallback, useContext, useEffect, useRef, useState, type RefObject } from "react";
import { DEFAULT_FIND_OPTIONS, seedFromSelection, type FindOptions } from "./find-engine";
import { isShown, registerFindTarget } from "./find-router";

// The state every document find bar shares: open or closed, the query and
// toggles, and where focus goes back to. The query and toggles carry over
// from the last bar used, as in an editor, so Ctrl+F in the next document
// starts from the same search.

/**
 * Whether the document a surface belongs to is on screen and is the focused
 * pane (EditorPane provides it). Without a provider a surface counts as
 * shown but never as the focused document.
 */
export const DocumentFindContext = createContext<{ active: boolean; focused: boolean }>({
  active: true,
  focused: false,
});

const OPTIONS_KEY = "codara.find.options.v1";

function loadOptions(): FindOptions {
  try {
    const stored = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
    if (stored && typeof stored === "object") {
      return {
        caseSensitive: stored.caseSensitive === true,
        wholeWord: stored.wholeWord === true,
        regex: stored.regex === true,
      };
    }
  } catch {
    // Private storage or a corrupt entry: start from the defaults.
  }
  return { ...DEFAULT_FIND_OPTIONS };
}

const shared = { query: "", options: null as FindOptions | null };

function sharedOptions(): FindOptions {
  if (!shared.options) shared.options = loadOptions();
  return shared.options;
}

export interface FindSession {
  open: boolean;
  query: string;
  options: FindOptions;
  /** Bumps on every Ctrl+F; the bar focuses and selects its field. */
  focusToken: number;
  /** Bumps when Ctrl+F (re)opened the bar, so a surface can jump to the nearest match. */
  openToken: number;
  setQuery: (query: string) => void;
  setOptions: (options: FindOptions) => void;
  openFind: () => void;
  /** Hides the bar and returns focus to where it was before Ctrl+F. */
  close: () => void;
}

export interface FindSessionConfig {
  /** Root of the surface: the content and its bar. */
  rootRef: RefObject<HTMLElement>;
  /** False while the surface has nothing to search (still loading, an error). */
  enabled?: boolean;
  /** The current selection's text, to seed the query with. */
  readSelection?: () => string | null;
  /** Where focus goes on close when nothing inside the surface had it. */
  fallbackFocus?: () => HTMLElement | null;
}

export function useFindSession({ rootRef, enabled = true, readSelection, fallbackFocus }: FindSessionConfig): FindSession {
  const documentState = useContext(DocumentFindContext);
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState(() => shared.query);
  const [options, setOptionsState] = useState<FindOptions>(sharedOptions);
  const [focusToken, setFocusToken] = useState(0);
  const [openToken, setOpenToken] = useState(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const latest = useRef({ open, enabled, documentState, readSelection, fallbackFocus });
  latest.current = { open, enabled, documentState, readSelection, fallbackFocus };

  const setQuery = useCallback((next: string) => {
    shared.query = next;
    setQueryState(next);
  }, []);

  const setOptions = useCallback((next: FindOptions) => {
    shared.options = next;
    setOptionsState(next);
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable: the toggles still hold for this session.
    }
  }, []);

  const openFind = useCallback(() => {
    const root = rootRef.current;
    const active = document.activeElement as HTMLElement | null;
    const inBar = Boolean(active?.closest(".codara-find"));
    if (!latest.current.open) {
      returnFocusRef.current = active && active !== document.body && root?.contains(active) ? active : null;
      // A fresh bar starts from the search last used anywhere.
      setQueryState(shared.query);
      setOptionsState(sharedOptions());
    }
    if (!inBar) {
      const seed = seedFromSelection(latest.current.readSelection?.() ?? null);
      if (seed !== null) setQuery(seed);
    }
    setOpen(true);
    setFocusToken((token) => token + 1);
    if (!latest.current.open || !inBar) setOpenToken((token) => token + 1);
  }, [rootRef, setQuery]);

  const close = useCallback(() => {
    setOpen(false);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    const target = back && back.isConnected ? back : latest.current.fallbackFocus?.() ?? null;
    target?.focus({ preventScroll: true });
  }, []);

  useEffect(
    () =>
      registerFindTarget({
        root: () => rootRef.current,
        eligible: () =>
          latest.current.enabled && latest.current.documentState.active && isShown(rootRef.current),
        primary: () => latest.current.documentState.focused,
        open: openFind,
      }),
    [rootRef, openFind],
  );

  return { open, query, options, focusToken, openToken, setQuery, setOptions, openFind, close };
}
