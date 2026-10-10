import type { SettingsTab } from "../components/SettingsDialog";

// Sections a `spark:open-settings` event may deep-link to with
// `detail.section`. Kept out of SettingsDialog so the eager App bundle can
// validate a request without loading the lazily split dialog.
const SETTINGS_SECTIONS: ReadonlySet<string> = new Set<SettingsTab>([
  "general",
  "editor",
  "terminal",
  "api",
  "agents",
  "sessions",
  "remote-access",
  "keybindings",
  "runs",
  "about",
]);

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && SETTINGS_SECTIONS.has(value);
}
