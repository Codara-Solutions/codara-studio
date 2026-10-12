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
  /** Shown instead of the title when the title alone is only a group name. */
  label?: string;
  /** One line under the result saying what the setting does. */
  desc: string;
  /** The section the row sits in, shown as the result's context. */
  section?: string;
  keywords?: string;
}

export const SETTINGS_SEARCH_INDEX: ReadonlyArray<SettingsSearchEntry> = [
  { tab: "general", title: "Setup and guided tour", desc: "Set up local tools, connect an account and take the tour.", section: "Getting started", keywords: "onboarding tour welcome install guide" },
  { tab: "general", title: "Theme", desc: "The colors of the whole app, dark or light.", section: "Appearance", keywords: "dark light mode colors palette dracula catppuccin github rose pine one dark daylight" },
  { tab: "general", title: "Liquid glass surfaces", desc: "Frosted, translucent menus, popovers and toasts.", section: "Appearance", keywords: "transparency translucent frosted blur opaque" },
  { tab: "general", title: "Glass tuning", desc: "Tint, blur and refraction of the glass material.", section: "Appearance", keywords: "tint blur refraction chromatic fringe" },
  { tab: "general", title: "Keep running in the background", desc: "Closing the window hides to the tray so automations keep running.", section: "Window", keywords: "tray quit close minimize automations" },
  { tab: "general", title: "Open local dev servers automatically", desc: "Open a preview tab when a dev server starts.", section: "Window", keywords: "browser preview localhost vite next url" },
  { tab: "general", title: "Workspace switch badge", desc: "Show the workspace and branch after a switch.", section: "Window", keywords: "hud overlay workspace name branch" },
  { tab: "general", title: "Middle-click to close tabs", desc: "Close a tab with the middle mouse button.", section: "Tabs", keywords: "mouse wheel button" },
  { tab: "general", title: "In-app toast", desc: "A card in the top right while the app is focused.", section: "Notifications", keywords: "alert popup notify" },
  { tab: "general", title: "Toast duration", desc: "How long a toast stays on screen.", section: "Notifications", keywords: "seconds timeout stay" },
  { tab: "general", title: "Native OS notification", desc: "A system notification when the window is in the background.", section: "Notifications", keywords: "system notification center alert" },
  { tab: "general", title: "Sound", desc: "A short sound with each notification.", section: "Notifications", keywords: "chime audio mute embedded sound clip" },
  { tab: "general", title: "Dock badge and taskbar flash", desc: "The macOS dock badge or Windows taskbar flash.", section: "Notifications", keywords: "os-specific cues macos windows" },
  { tab: "general", title: "Fetch remotes in the background", desc: "Keep ahead and behind counts current.", section: "Git", keywords: "auto-fetch pull ahead behind network" },
  { tab: "general", title: "Fetch interval", desc: "How often remotes are fetched.", section: "Git", keywords: "minutes cadence" },
  { tab: "general", title: "Notify me when teammates push", desc: "One quiet alert per repository when others push.", section: "Git", keywords: "github push alert gh" },
  { tab: "general", title: "Notify me when a pull request is opened", desc: "A notification for new pull requests.", section: "Git", keywords: "github pr review" },
  { tab: "general", title: "Instant git triggers", desc: "Pushes reach automations in seconds through the GitHub App.", section: "Git", keywords: "github app webhook install push automations" },
  { tab: "general", title: "Copy-branch setup command", desc: "What runs in a new copy of a branch.", section: "Git", keywords: "worktree pnpm npm install" },
  { tab: "editor", title: "Vim mode", desc: "Modal editing in the file editor.", section: "Editing", keywords: "modal keys" },
  { tab: "editor", title: "Editor theme", desc: "Syntax colors in the file editor.", section: "Editing", keywords: "syntax colors highlighting" },
  { tab: "editor", title: "Autosave", desc: "Save the active file after you stop typing.", section: "Saving", keywords: "save automatically delay" },
  { tab: "editor", title: "Inline AI autocomplete", desc: "Ghost-text suggestions as you type.", section: "Inline AI", keywords: "ghost text completion suggestions copilot" },
  { tab: "editor", title: "Suggestion timing", desc: "How soon a suggestion is requested.", section: "Inline AI", keywords: "delay wait live" },
  { tab: "terminal", title: "Default shell", desc: "The shell new terminals open with.", section: "Shell", keywords: "zsh bash fish powershell terminal" },
  { tab: "terminal", title: "Scrollback lines", desc: "Lines of output each terminal keeps.", section: "Output history", keywords: "buffer memory history" },
  { tab: "terminal", title: "Resource overview", desc: "Live terminals and the output they buffer.", keywords: "memory streams parked live" },
  { tab: "terminal", title: "Run panes", desc: "When worker panes close.", section: "Resource overview", keywords: "worker panes close lifecycle run terminal" },
  { tab: "api", title: "OpenRouter API key", desc: "The key behind inline edits and OpenRouter models.", section: "OpenRouter", keywords: "key token openrouter" },
  { tab: "api", title: "Inline edit and commit model", desc: "The OpenRouter model for inline edits.", section: "OpenRouter", keywords: "model gemini" },
  { tab: "api", title: "Models for Cora", desc: "OpenRouter models offered in the Cora picker.", section: "OpenRouter", keywords: "model picker openrouter" },
  { tab: "api", title: "Commit message model", desc: "The model that drafts commit messages.", section: "Git commit messages", keywords: "commit draft model" },
  { tab: "agents", title: "Add account", desc: "Sign in to another Claude, ChatGPT or xAI account.", keywords: "new sign in login another account connect claude codex grok" },
  { tab: "agents", title: "How switching works", desc: "What a switch moves, and which sessions follow.", keywords: "switch account active use change sessions" },
  { tab: "agents", title: "Anthropic", label: "Anthropic accounts", desc: "Claude accounts for Cora and Claude Code.", keywords: "claude code claude login account email limits switch" },
  { tab: "agents", title: "OpenAI", label: "OpenAI accounts", desc: "ChatGPT accounts for Cora and Codex.", keywords: "codex chatgpt codex login account email limits switch" },
  { tab: "agents", title: "xAI", label: "xAI accounts", desc: "SuperGrok accounts for Cora and Grok.", keywords: "grok supergrok grok login account email switch" },
  { tab: "agents", title: "Usage limits", desc: "Re-read every account's limits now.", section: "Limits and runtime", keywords: "quota rate limit refresh" },
  { tab: "agents", title: "Pi runtime", desc: "The coding agent Cora runs on.", section: "Limits and runtime", keywords: "pi install version" },
  { tab: "agents", title: "Capability Center", desc: "MCP servers, skills, profiles, memory and worker models.", section: "Tools", keywords: "mcp servers skills memory profiles worker models" },
  { tab: "sessions", title: "Resume running agent sessions when Codara reopens", desc: "Bring back agent sessions after a restart.", section: "Restore", keywords: "restore relaunch restart resume" },
  { tab: "sessions", title: "Agent sessions", desc: "Find, resume and delete Claude and Codex sessions.", keywords: "history transcripts delete claude codex" },
  { tab: "remote-access", title: "Allow remote access", desc: "Pair the Codara phone app with this computer.", section: "Connection", keywords: "phone mobile app pair qr" },
  { tab: "remote-access", title: "Paired devices", desc: "Phones that can reach this computer.", keywords: "revoke phone device" },
  { tab: "keybindings", title: "Keybindings", desc: "Record new shortcuts for any command.", keywords: "shortcuts keyboard hotkeys keys" },
  { tab: "runs", title: "All runs", desc: "Every Cora run on this computer.", keywords: "history delete open" },
  { tab: "about", title: "Version", desc: "The Codara Studio build you are running.", section: "Details", keywords: "about build" },
  { tab: "about", title: "Software update", desc: "Check for a newer version.", section: "Details", keywords: "check for updates upgrade" },
];

export function searchSettings(query: string): SettingsSearchEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_SEARCH_INDEX.filter((entry) => {
    const haystack = [
      entry.title,
      entry.label ?? "",
      entry.desc,
      entry.section ?? "",
      entry.keywords ?? "",
      tabMeta(entry.tab).title,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
