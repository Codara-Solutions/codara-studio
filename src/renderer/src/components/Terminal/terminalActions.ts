import { emitLocalToast } from "../../notifications/local-toast";
import { paneOverlaysSnapshot } from "./paneOverlays";
import { formatTerminalContext, readTerminalContext } from "./terminalContext";
import { shortenLinkForDisplay, type TerminalLinkActionId } from "./terminalLinks";

// The side effects behind the terminal actions: the clipboard, toasts and the
// browser routes. Kept apart from the pure rules in terminalContext.ts and
// terminalLinks.ts.

/**
 * Copies the context of a pane, or of the overlay covering it, since that is
 * the terminal the user is looking at. Says what happened either way.
 */
export async function copyTerminalContext(paneId: string): Promise<boolean> {
  const target = paneOverlaysSnapshot().get(paneId)?.paneId ?? paneId;
  const snapshot = readTerminalContext(target) ?? readTerminalContext(paneId);
  if (!snapshot) {
    emitLocalToast("Nothing to copy", "Open a terminal pane first.", "warning");
    return false;
  }
  try {
    await window.spark.clipboard.writeText(formatTerminalContext(snapshot));
  } catch {
    emitLocalToast("Could not copy", "The clipboard did not accept the text.", "danger");
    return false;
  }
  const lines = snapshot.output ? snapshot.output.split("\n").length : 0;
  const what = snapshot.fromSelection
    ? "The selection"
    : lines === 0
      ? "The working directory"
      : `${lines} ${lines === 1 ? "line" : "lines"} of output`;
  emitLocalToast(
    "Terminal context copied",
    `${what}${snapshot.cwd && lines > 0 ? " and the working directory" : ""}, ready to paste into an agent.`,
  );
  return true;
}

export function runTerminalLinkAction(id: TerminalLinkActionId, url: string): void {
  if (id === "codara") {
    // The same route a plain click takes when links open in Codara: it reuses
    // a tab already showing this page in the current workspace.
    window.dispatchEvent(new CustomEvent("spark:open-browser-url", { detail: { url } }));
    return;
  }
  if (id === "system") {
    void window.spark.openInSystemBrowser(url);
    return;
  }
  void Promise.resolve(window.spark.clipboard.writeText(url))
    .then(() => emitLocalToast("Link copied", shortenLinkForDisplay(url)))
    .catch(() => emitLocalToast("Could not copy", "The clipboard did not accept the link.", "danger"));
}
