import type { Terminal } from "@xterm/xterm";
import { emitLocalToast } from "../../notifications/local-toast";
import { createOsc52Handler, OSC52_MAX_BASE64_CHARS, type Osc52Block } from "./osc52";
import { terminalOsc52Enabled } from "./terminalPrefs";

// Connects OSC 52 (osc52.ts) to one pane. Copies go through the same main
// process clipboard bridge as Ctrl+Shift+C, write only. A refused copy says
// why once, so a user who turned the setting off is not told on every yank.

const TOO_LARGE_NOTICE_GAP_MS = 15_000;
let disabledNoticeShown = false;
let lastTooLargeNoticeAt = 0;

export interface Osc52PaneState {
  /** Pane-level reason to refuse, before the setting is consulted. */
  paneBlock: () => Exclude<Osc52Block, "unknown" | "disabled"> | null;
}

export function registerOsc52Clipboard(term: Terminal, pane: Osc52PaneState): () => void {
  const handler = createOsc52Handler({
    blockedBy: () => {
      const block = pane.paneBlock();
      if (block) return block;
      const enabled = terminalOsc52Enabled();
      if (enabled === null) return "unknown";
      return enabled ? null : "disabled";
    },
    writeText: (text) => window.spark.clipboard.writeText(text),
    onDisabled: () => {
      if (disabledNoticeShown) return;
      disabledNoticeShown = true;
      emitLocalToast(
        "Terminal copy blocked",
        "A program in the terminal tried to copy text. Turn on Let programs copy to the clipboard in Settings, Terminal.",
        "warning",
      );
    },
    onTooLarge: (base64Chars) => {
      const now = Date.now();
      if (now - lastTooLargeNoticeAt < TOO_LARGE_NOTICE_GAP_MS) return;
      lastTooLargeNoticeAt = now;
      emitLocalToast(
        "Terminal copy too large",
        `A program tried to copy about ${formatKilobytes(base64Chars * 0.75)}. Codara takes up to ${formatKilobytes(OSC52_MAX_BASE64_CHARS * 0.75)} this way. Select the text and copy it instead.`,
        "warning",
      );
    },
  });
  const disposable = term.parser.registerOscHandler(52, handler);
  return () => disposable.dispose();
}

function formatKilobytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
