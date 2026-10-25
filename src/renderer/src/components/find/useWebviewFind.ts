import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { IDLE_FIND_STATUS, type FindStatus } from "./find-engine";
import { useFindSession } from "./useFindSession";
import { useFindKeys, type SurfaceFind } from "./useDomFind";

// Find in a rendered HTML page. The page runs in a <webview> guest, out of
// reach of the DOM finder, so the bar drives Chromium's own find in page
// (Electron's findInPage): its highlighting, its count and its wrap-around.
// That engine has no whole-word or regex mode, so those toggles are off here.

const UNSUPPORTED = "Not available in web page previews";

export function useWebviewFind({
  hostRef,
  webviewRef,
  ready,
}: {
  hostRef: RefObject<HTMLElement>;
  webviewRef: RefObject<Electron.WebviewTag | null>;
  ready: boolean;
}): SurfaceFind {
  const session = useFindSession({
    rootRef: hostRef,
    enabled: ready,
    fallbackFocus: () => webviewRef.current,
  });
  const { open, query, options } = session;
  const [status, setStatus] = useState<FindStatus>(IDLE_FIND_STATUS);
  const requestRef = useRef(0);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !ready) return;
    const onFound = (event: Electron.FoundInPageEvent) => {
      const { result } = event;
      if (result.requestId !== requestRef.current) return;
      setStatus({
        total: result.matches,
        current: result.matches > 0 ? Math.max(0, result.activeMatchOrdinal - 1) : -1,
        capped: false,
        pending: !result.finalUpdate && result.matches === 0,
        error: null,
      });
    };
    webview.addEventListener("found-in-page", onFound);
    return () => {
      webview.removeEventListener("found-in-page", onFound);
    };
  }, [webviewRef, ready]);

  const matchCase = options.caseSensitive;
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !ready || !open) return;
    try {
      if (!query) {
        webview.stopFindInPage("clearSelection");
        setStatus(IDLE_FIND_STATUS);
        return;
      }
      setStatus((prev) => ({ ...prev, pending: true }));
      requestRef.current = webview.findInPage(query, { matchCase, findNext: true });
    } catch {
      // The guest is between loads; the next keystroke searches again.
    }
  }, [webviewRef, ready, open, query, matchCase]);

  const step = useCallback(
    (forward: boolean) => {
      const webview = webviewRef.current;
      if (!webview || !ready || !query) return;
      try {
        requestRef.current = webview.findInPage(query, { forward, matchCase, findNext: false });
      } catch {
        // See above.
      }
    },
    [webviewRef, ready, query, matchCase],
  );
  const next = useCallback(() => step(true), [step]);
  const previous = useCallback(() => step(false), [step]);

  const close = useCallback(() => {
    try {
      // The last match stays selected in the page, as in a browser.
      webviewRef.current?.stopFindInPage("keepSelection");
    } catch {
      // Guest gone: nothing to stop.
    }
    setStatus(IDLE_FIND_STATUS);
    session.close();
  }, [webviewRef, session]);

  const onKeyDown = useFindKeys(open, next, previous, close);

  return {
    session,
    onKeyDown,
    bar: open
      ? {
          label: "Find in page",
          query,
          onQueryChange: session.setQuery,
          options,
          onOptionsChange: session.setOptions,
          status,
          onNext: next,
          onPrevious: previous,
          onClose: close,
          focusToken: session.focusToken,
          unsupported: { wholeWord: UNSUPPORTED, regex: UNSUPPORTED },
        }
      : null,
  };
}
