import type { SettingsTab } from "../components/SettingsDialog";

// Sections a `spark:open-settings` event may deep-link to with
// `detail.section`. Kept out of SettingsDialog so the eager App bundle can
// validate a request without loading the lazily split dialog. A Record, so a
// tab added to SettingsTab fails the typecheck here until it is listed.
const SETTINGS_SECTIONS: Record<SettingsTab, true> = {
  general: true,
  editor: true,
  terminal: true,
  api: true,
  agents: true,
  sessions: true,
  "remote-access": true,
  keybindings: true,
  runs: true,
  about: true,
};

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && Object.hasOwn(SETTINGS_SECTIONS, value);
}
