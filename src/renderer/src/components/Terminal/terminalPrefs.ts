import type { AppSettings } from "@shared/types";
import { onSettingsChanged } from "../../lib/useOpenAiFastMode";

// The two terminal behaviors a setting can change while panes are open: OSC 52
// copies (AppSettings, saved from the Terminal page) and the menu a plain
// click on a terminal link opens (a preference, applied as it is flipped).
// Read on the event itself, never captured when a pane mounts, so a change
// reaches every open terminal at once without re-running its setup.

let osc52Enabled: boolean | null = null;
let linkMenuEnabled: boolean | null = null;
let started = false;

function start(): void {
  if (started || typeof window === "undefined" || !window.spark) return;
  started = true;
  // A change broadcast before the first load resolves is newer than what the
  // load read, so the load only fills a value nothing has set yet.
  const adoptSettings = (settings: AppSettings) => {
    osc52Enabled = settings.terminalOsc52Clipboard !== false;
  };
  try {
    onSettingsChanged(adoptSettings);
    void window.spark.settings
      .load()
      .then((settings) => {
        if (osc52Enabled === null) adoptSettings(settings);
      })
      .catch(() => undefined);
    window.spark.preferences.onChanged((change) => {
      if (change.key === "terminalLinkMenu") linkMenuEnabled = change.value !== false;
    });
    void window.spark.preferences
      .load()
      .then((preferences) => {
        if (linkMenuEnabled === null) linkMenuEnabled = preferences.terminalLinkMenu !== false;
      })
      .catch(() => undefined);
  } catch {
    /* a stale preload without these channels keeps the defaults */
  }
}

/** Whether OSC 52 copies may reach the clipboard; null until settings load. */
export function terminalOsc52Enabled(): boolean | null {
  start();
  return osc52Enabled;
}

/** Whether a plain click on a terminal link opens the link menu (default on). */
export function terminalLinkMenuEnabled(): boolean {
  start();
  return linkMenuEnabled !== false;
}

/** Start loading before the first pane needs an answer. */
export function preloadTerminalPrefs(): void {
  start();
}
