/// <reference lib="dom" />
import { ipcRenderer } from "electron";

// Tells main whether the page handled each chord the user pressed, so only a
// chord the page left alone reaches Codara's shortcuts (src/main/browser/
// guest-chords.ts). Runs in the isolated world: the page cannot report for
// itself, and a key it synthesizes (isTrusted false) is never reported.

const READY_CHANNEL = "preview-guest:chord-reporter";
const REPORT_CHANNEL = "preview-guest:chord";

export function installChordReporter(): void {
  // Registered before any page script, so this capture listener runs first;
  // the verdict is read after the whole dispatch, once every page listener
  // had its chance to call preventDefault.
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || !(event.ctrlKey || event.altKey || event.metaKey)) return;
      const { key, code } = event;
      setTimeout(() => ipcRenderer.send(REPORT_CHANNEL, { key, code, handled: event.defaultPrevented }), 0);
    },
    true,
  );
  ipcRenderer.send(READY_CHANNEL);
}
