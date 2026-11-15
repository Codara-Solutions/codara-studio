import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import FindBar from "../find/FindBar";
import { useWebviewFind } from "../find/useWebviewFind";

// Ctrl/Cmd+F over a browser tab's page: Chromium's find in page, as in the
// HTML file preview. A key typed in the page reaches the find router through
// the guest chord forwarding, unless the page handled it itself. Loaded on
// its own (BrowserPane imports it lazily) so the find engine stays out of the
// renderer's entry chunk.

export default function BrowserPageFind({
  hostRef,
  webviewRef,
  ready,
}: {
  hostRef: RefObject<HTMLDivElement>;
  webviewRef: RefObject<Electron.WebviewTag | null>;
  ready: boolean;
}) {
  const find = useWebviewFind({ hostRef, webviewRef, ready });
  const { onKeyDown } = find;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const listener = (event: KeyboardEvent) =>
      onKeyDown(event as unknown as ReactKeyboardEvent<HTMLElement>);
    host.addEventListener("keydown", listener);
    return () => host.removeEventListener("keydown", listener);
  }, [hostRef, onKeyDown]);
  return find.bar ? <FindBar {...find.bar} /> : null;
}
