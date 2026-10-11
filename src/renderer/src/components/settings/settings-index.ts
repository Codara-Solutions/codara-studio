// Where every Settings page lives in the nav, what it is called at the top of
// its page, and the settings search index. The search index names rows by
// the exact title they render with (their data-setting-anchor), so a result
// can scroll to its row; keywords add the words people search with that the
// title itself does not contain.

export type SettingsTab =
  | "general"
  | "editor"
  | "terminal"
  | "api"
  | "agents"
  | "sessions"
  | "remote-access"
  | "keybindings"
  | "runs"
  | "about";

export interface SettingsTabMeta {
  id: SettingsTab;
  /** Nav label, the same words as the page title. Specs click these by exact name. */
  label: string;
  /** Page title shown in the dialog's top bar. */
  title: string;
  /** One line under the title. */
  description: string;
}

export const SETTINGS_TABS: ReadonlyArray<SettingsTabMeta> = [
  {
    id: "general",
    label: "General",
    title: "General",
    description: "Appearance, the window, notifications and git.",
  },
  {
    id: "editor",
    label: "Editor",
    title: "Editor",
    description: "How the file editor edits, saves and suggests.",
  },
  {
    id: "terminal",
    label: "Terminal",
    title: "Terminal",
    description: "The shell new terminals open with, and how much output they keep.",
  },
  {
    id: "api",
    label: "API and model",
    title: "API and model",
    description: "Your OpenRouter key and the models behind inline edits and commit messages.",
  },
  {
    id: "agents",
    label: "Accounts",
    title: "Accounts",
    description: "The accounts Cora and your terminal agents sign in with, and their limits.",
  },
  {
    id: "sessions",
    label: "Sessions",
    title: "Sessions",
    description: "Find, resume and clean up local Claude and Codex sessions from any project.",
  },
  {
    id: "remote-access",
    label: "Remote access",
    title: "Remote access",
    description: "Reach this computer from the Codara phone app.",
  },
  {
    id: "keybindings",
    label: "Keybindings",
    title: "Keybindings",
    description: "Click a shortcut to record a new key combination. Changes apply immediately.",
  },
  {
    id: "runs",
    label: "Runs",
    title: "Runs",
    description: "Every Cora run on this computer, across all workspaces.",
  },
  {
    id: "about",
    label: "About",
    title: "About",
    description: "Version, platform and updates.",
  },
];

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  label: string;
  tabs: ReadonlyArray<SettingsTab>;
}> = [
  { label: "Workspace", tabs: ["general", "editor", "terminal", "keybindings"] },
  { label: "Agents and models", tabs: ["agents", "api", "sessions", "runs"] },
  { label: "System", tabs: ["remote-access", "about"] },
];

export function tabMeta(tab: SettingsTab): SettingsTabMeta {
  return SETTINGS_TABS.find((entry) => entry.id === tab) ?? SETTINGS_TABS[0];
}

export interface SettingsSearchEntry {
  tab: SettingsTab;
  /** The row or section title, exactly as rendered. */
  title: string;
  /** The section the row sits in, shown as the result's context. */
  section?: string;
  keywords?: string;
}

export const SETTINGS_SEARCH_INDEX: ReadonlyArray<SettingsSearchEntry> = [
  { tab: "general", title: "Setup and guided tour", section: "Getting started", keywords: "onboarding tour welcome install guide" },
  { tab: "general", title: "Theme", section: "Appearance", keywords: "dark light mode colors palette dracula catppuccin github rose pine one dark daylight" },
  { tab: "general", title: "Liquid glass surfaces", section: "Appearance", keywords: "transparency translucent frosted blur opaque" },
  { tab: "general", title: "Glass tuning", section: "Appearance", keywords: "tint blur refraction chromatic fringe" },
  { tab: "general", title: "Keep running in the background", section: "Window", keywords: "tray quit close minimize automations" },
  { tab: "general", title: "Open local dev servers automatically", section: "Window", keywords: "browser preview localhost vite next url" },
  { tab: "general", title: "Workspace switch badge", section: "Window", keywords: "hud overlay workspace name branch" },
  { tab: "general", title: "Middle-click to close tabs", section: "Tabs", keywords: "mouse wheel button" },
  { tab: "general", title: "In-app toast", section: "Notifications", keywords: "alert popup notify" },
  { tab: "general", title: "Toast duration", section: "Notifications", keywords: "seconds timeout stay" },
  { tab: "general", title: "Native OS notification", section: "Notifications", keywords: "system notification center alert" },
  { tab: "general", title: "Sound", section: "Notifications", keywords: "chime audio mute embedded sound clip" },
  { tab: "general", title: "Dock badge and taskbar flash", section: "Notifications", keywords: "os-specific cues macos windows" },
  { tab: "general", title: "Fetch remotes in the background", section: "Git", keywords: "auto-fetch pull ahead behind network" },
  { tab: "general", title: "Fetch interval", section: "Git", keywords: "minutes cadence" },
  { tab: "general", title: "Notify me when teammates push", section: "Git", keywords: "github push alert gh" },
  { tab: "general", title: "Notify me when a pull request is opened", section: "Git", keywords: "github pr review" },
  { tab: "general", title: "Instant git triggers", section: "Git", keywords: "github app webhook install push automations" },
  { tab: "general", title: "Copy-branch setup command", section: "Git", keywords: "worktree pnpm npm install" },
  { tab: "editor", title: "Vim mode", section: "Editing", keywords: "modal keys" },
  { tab: "editor", title: "Editor theme", section: "Editing", keywords: "syntax colors highlighting" },
  { tab: "editor", title: "Autosave", section: "Saving", keywords: "save automatically delay" },
  { tab: "editor", title: "Inline AI autocomplete", section: "Inline AI", keywords: "ghost text completion suggestions copilot" },
  { tab: "editor", title: "Suggestion timing", section: "Inline AI", keywords: "delay wait live" },
  { tab: "terminal", title: "Default shell", section: "Shell", keywords: "zsh bash fish powershell terminal" },
  { tab: "terminal", title: "Scrollback lines", section: "Output history", keywords: "buffer memory history" },
  { tab: "terminal", title: "Resource overview", keywords: "memory streams parked live" },
  { tab: "terminal", title: "Run terminal lifecycle", keywords: "worker panes close" },
  { tab: "api", title: "OpenRouter API key", section: "OpenRouter", keywords: "key token openrouter" },
  { tab: "api", title: "Inline edit and commit model", section: "OpenRouter", keywords: "model gemini" },
  { tab: "api", title: "Models for Cora", section: "OpenRouter", keywords: "model picker openrouter" },
  { tab: "api", title: "Commit message model", section: "Git commit messages", keywords: "commit draft model" },
  { tab: "agents", title: "Add account", section: "Accounts", keywords: "new sign in login another account connect claude codex grok" },
  { tab: "agents", title: "How switching works", section: "Accounts", keywords: "switch account active use change sessions" },
  { tab: "agents", title: "Anthropic", section: "Accounts", keywords: "claude code claude login account email limits switch" },
  { tab: "agents", title: "OpenAI", section: "Accounts", keywords: "codex chatgpt codex login account email limits switch" },
  { tab: "agents", title: "xAI", section: "Accounts", keywords: "grok supergrok grok login account email switch" },
  { tab: "agents", title: "Usage limits", section: "Limits and runtime", keywords: "quota rate limit refresh" },
  { tab: "agents", title: "Pi runtime", section: "Limits and runtime", keywords: "pi install version" },
  { tab: "agents", title: "Capability Center", section: "Tools", keywords: "mcp servers skills memory profiles worker models" },
  { tab: "sessions", title: "Resume running agent sessions when Codara reopens", section: "Restore", keywords: "restore relaunch restart resume" },
  { tab: "sessions", title: "Agent sessions", keywords: "history transcripts delete claude codex" },
  { tab: "remote-access", title: "Allow remote access", section: "Connection", keywords: "phone mobile app pair qr" },
  { tab: "remote-access", title: "Paired devices", keywords: "revoke phone device" },
  { tab: "keybindings", title: "Keybindings", keywords: "shortcuts keyboard hotkeys keys" },
  { tab: "runs", title: "All runs", keywords: "history delete open" },
  { tab: "about", title: "Version", section: "Details", keywords: "about build" },
  { tab: "about", title: "Software update", section: "Details", keywords: "check for updates upgrade" },
];

export function searchSettings(query: string): SettingsSearchEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_SEARCH_INDEX.filter((entry) => {
    const haystack = [
      entry.title,
      entry.section ?? "",
      entry.keywords ?? "",
      tabMeta(entry.tab).title,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
