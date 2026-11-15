import type { RefObject } from "react";
import FindBar from "../find/FindBar";
import { useWebviewFind } from "../find/useWebviewFind";

// Ctrl/Cmd+F in a browser tab: Chromium's find in page, as in the HTML file
// preview. The whole pane is the find surface, address bar and toolbar
// included, as in a browser. A key typed in the page reaches the find router
// through the guest chord forwarding, unless the page handled it itself;
// keys typed in the page never reach this document, so the bar's own field
// does the stepping and closing. Loaded on its own (BrowserPane imports it
// lazily) so the find engine stays out of the renderer's entry chunk.

export default function BrowserPageFind({
  rootRef,
  webviewRef,
  ready,
}: {
  rootRef: RefObject<HTMLDivElement>;
  webviewRef: RefObject<Electron.WebviewTag | null>;
  ready: boolean;
}) {
  const find = useWebviewFind({ hostRef: rootRef, webviewRef, ready });
  return find.bar ? <FindBar {...find.bar} /> : null;
}
