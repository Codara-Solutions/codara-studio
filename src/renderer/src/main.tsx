import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./theme/ThemeProvider";
import { registerPreviewRpcHandler } from "./components/Preview/previewRpc";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

registerPreviewRpcHandler();

// Safety net for external file drag-and-drop. Chromium's default action for an
// unhandled file drop is to navigate the window to that file (file://…), which
// would blow away the whole app. The Explorer's own drop zone handles (and
// preventDefaults) real imports; this swallows every *other* file drop so a
// near-miss outside the drop zone is a no-op instead of a navigation. Scoped to
// file drags only ("Files" in dataTransfer.types) so internal drag-and-drop —
// terminal panes, tab reorder, panel sections, which use custom MIME types — is
// left completely untouched.
const isExternalFileDrag = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");
window.addEventListener("dragover", (event) => {
  if (isExternalFileDrag(event)) event.preventDefault();
});
window.addEventListener("drop", (event) => {
  if (isExternalFileDrag(event)) event.preventDefault();
});

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
