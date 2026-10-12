// Where every Settings page lives in the nav, what it is called at the top of
// its page, and the settings search index. The search index names rows by
// the exact title they render with (their data-setting-anchor), so a result
// can scroll to its row; keywords add the words people search with that the
// title itself does not contain. scripts/test-settings-search.cjs fails when
// a page renders a row this index does not name, or the index names a row
// no page renders, so the two cannot drift apart.

import type { CapabilityTab } from "../capabilities/model";
import { COMMANDS } from "../../shortcuts/commands";
import type { PreferenceToggleId } from "./setting-toggles";

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
    description: "Sign-ins for Cora and the terminals Codara opens, and their limits.",
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

/** Settings found outside the dialog: the Capability Center's own pages. */
export const CAPABILITY_PAGE_LABEL: Record<CapabilityTab, string> = {
  mcp: "MCP servers",
  skills: "Skills",
  profiles: "Profiles",
  memory: "Memory",
  workers: "Worker models",
  policy: "Behavior",
};

/** An on/off setting a search result can flip in place. */
export type SettingsToggleId = PreferenceToggleId | "fastMode";

export interface SettingsSearchEntry {
  /** The page that shows it; "capabilities" is the Capability Center. */
  tab: SettingsTab | "capabilities";
  /** The row or section title, exactly as rendered (its data-setting-anchor). */
  title: string;
  /** Shown instead of the title when the title alone is only a group name. */
  label?: string;
  /** One line under the result saying what the setting does. */
  desc: string;
  /** The section the row sits in, shown as the result's context. */
  section?: string;
  keywords?: string;
  /** The disclosure row that must open before this row exists. */
  reveal?: string;
  /** The Capability Center page, for entries with tab "capabilities". */
  capabilityTab?: CapabilityTab;
  /** The result carries a switch that flips the setting in place. */
  toggle?: SettingsToggleId;
  /** A keyboard shortcut of the Keybindings page. */
  shortcut?: boolean;
}

export const SETTINGS_SEARCH_INDEX: ReadonlyArray<SettingsSearchEntry> = [
  { tab: "general", title: "Setup and guided tour", desc: "Set up local tools, connect an account and take the tour.", section: "Getting started", keywords: "onboarding tour welcome install guide help" },
  { tab: "general", title: "Theme", desc: "The colors of the whole app, dark or light.", section: "Appearance", keywords: "dark light mode colors palette appearance dracula catppuccin github rose pine one dark daylight" },
  { tab: "general", title: "Liquid glass", desc: "Translucent glass for the frame, tabs, buttons, composer, menus, dialogs and toasts.", section: "Appearance", keywords: "transparency translucent frosted blur opaque glass solid", toggle: "glassEffects" },
  { tab: "general", title: "Fine-tune glass", desc: "Tint, blur, refraction and fringe of the glass material.", section: "Appearance", keywords: "tint blur refraction chromatic fringe tuning strength sliders adjust" },
  { tab: "general", title: "Tint", label: "Glass tint", desc: "How tinted the glass is. Lower is clearer.", section: "Appearance", keywords: "glass veil clear opacity slider", reveal: "Fine-tune glass" },
  { tab: "general", title: "Blur", label: "Glass blur", desc: "Frost behind floating surfaces.", section: "Appearance", keywords: "glass frost blurry slider", reveal: "Fine-tune glass" },
  { tab: "general", title: "Refraction", label: "Glass refraction", desc: "How much menu edges bend light.", section: "Appearance", keywords: "glass bend lens edge slider", reveal: "Fine-tune glass" },
  { tab: "general", title: "Fringe", label: "Glass fringe", desc: "Color split along the edge of the glass.", section: "Appearance", keywords: "glass chroma chromatic aberration rainbow slider", reveal: "Fine-tune glass" },
  { tab: "general", title: "Keep running in the background", desc: "Closing the window hides to the tray so automations keep running.", section: "Window", keywords: "tray quit close minimize automations background", toggle: "keepRunningInBackground" },
  { tab: "general", title: "Open local dev servers automatically", desc: "Open a preview tab when a dev server starts.", section: "Window", keywords: "browser preview localhost vite next url port", toggle: "autoOpenPreview" },
  { tab: "general", title: "Open links in", desc: "Open clicked links in your default browser or a Codara browser tab.", section: "Window", keywords: "link url external system browser default chrome firefox safari web" },
  { tab: "general", title: "Workspace switch badge", desc: "Show the workspace and branch after a switch.", section: "Window", keywords: "hud overlay workspace name branch duration" },
  { tab: "general", title: "Let agents create and remove worktrees", desc: "Agents may create worktrees and remove merged ones.", section: "Agent worktrees", keywords: "worktree branch git agent claude codex cora merged remove", toggle: "agentWorktreesEnabled" },
  { tab: "general", title: "Let agents remove worktrees I created", desc: "Agents may also remove merged worktrees you created.", section: "Agent worktrees", keywords: "worktree branch git agent delete merged", toggle: "agentsMayRemoveUserWorktrees" },
  { tab: "general", title: "Middle-click to close tabs", desc: "Close a tab with the middle mouse button.", section: "Tabs", keywords: "mouse wheel button middle click", toggle: "closeTabsOnMiddleClick" },
  { tab: "general", title: "In-app toast", desc: "A card in the top right while the app is focused.", section: "Notifications", keywords: "alert popup notify notification", toggle: "notifyInApp" },
  { tab: "general", title: "Toast duration", desc: "How long a toast stays on screen.", section: "Notifications", keywords: "seconds timeout stay notification" },
  { tab: "general", title: "Native OS notification", desc: "A system notification when the window is in the background.", section: "Notifications", keywords: "system notification center alert desktop", toggle: "notifyNative" },
  { tab: "general", title: "Sound", desc: "A short chime with each notification.", section: "Notifications", keywords: "chime audio mute sound notification", toggle: "notifySound" },
  { tab: "general", title: "Dock badge and taskbar flash", desc: "The macOS dock badge or Windows taskbar flash.", section: "Notifications", keywords: "os-specific cues macos windows badge", toggle: "notifyOsCues" },
  { tab: "general", title: "Fetch remotes in the background", desc: "Keep ahead and behind counts current.", section: "Git", keywords: "auto-fetch autofetch pull ahead behind network", toggle: "gitAutoFetchEnabled" },
  { tab: "general", title: "Fetch interval", desc: "How often remotes are fetched.", section: "Git", keywords: "minutes cadence auto-fetch" },
  { tab: "general", title: "Notify me when teammates push", desc: "One quiet alert per repository when others push.", section: "Git", keywords: "github push alert gh notification", toggle: "notifyTeammatePushes" },
  { tab: "general", title: "Notify me when a pull request is opened", desc: "A notification for new pull requests.", section: "Git", keywords: "github pr review notification", toggle: "notifyPullRequests" },
  { tab: "general", title: "Instant git triggers", desc: "Pushes reach automations in seconds through the GitHub App.", section: "Git", keywords: "github app webhook install push automations" },
  { tab: "general", title: "Copy-branch setup command", desc: "What runs in a new copy of a branch.", section: "Git", keywords: "worktree pnpm npm install setup" },
  { tab: "general", title: "Agent worktrees: also regenerable", desc: "Ignored files an agent may delete with a merged worktree.", section: "Git", keywords: "worktree ignored gitignore cache build regenerable" },
  { tab: "editor", title: "Vim mode", desc: "Modal editing in the file editor.", section: "Editing", keywords: "modal keys vi", toggle: "vimMode" },
  { tab: "editor", title: "Editor theme", desc: "Syntax colors in the file editor.", section: "Editing", keywords: "syntax colors highlighting" },
  { tab: "editor", title: "Autosave", desc: "Save the active file after you stop typing.", section: "Saving", keywords: "save automatically auto-save", toggle: "autosaveEnabled" },
  { tab: "editor", title: "Autosave delay", desc: "How long after typing the file is saved.", section: "Saving", keywords: "save wait seconds" },
  { tab: "editor", title: "Custom delay", label: "Custom autosave delay", desc: "Fine-tune the wait before an autosave.", section: "Saving", keywords: "autosave save wait slider" },
  { tab: "editor", title: "Inline AI autocomplete", desc: "Ghost-text suggestions as you type.", section: "Inline AI", keywords: "ghost text completion suggestions copilot", toggle: "inlineAutocompleteEnabled" },
  { tab: "editor", title: "Suggestion timing", desc: "How soon a suggestion is requested.", section: "Inline AI", keywords: "delay wait live autocomplete" },
  { tab: "editor", title: "Custom wait", label: "Custom suggestion wait", desc: "How long a pause in typing lasts before a suggestion.", section: "Inline AI", keywords: "autocomplete delay slider" },
  { tab: "terminal", title: "Default shell", desc: "The shell new terminals open with.", section: "Shell", keywords: "zsh bash fish powershell pwsh cmd terminal" },
  { tab: "terminal", title: "Scrollback lines", desc: "Lines of output each terminal keeps.", section: "Output history", keywords: "buffer memory history scroll" },
  { tab: "terminal", title: "Resource overview", desc: "Live terminals and the output they buffer.", keywords: "memory streams parked live resources" },
  { tab: "terminal", title: "Live terminals", desc: "How many terminals are running.", section: "Resource overview", keywords: "count running pty" },
  { tab: "terminal", title: "Visible streams", desc: "Terminals drawing on screen right now.", section: "Resource overview", keywords: "attached streams" },
  { tab: "terminal", title: "Parked or headless", desc: "Terminals running without a visible pane.", section: "Resource overview", keywords: "detached hidden background" },
  { tab: "terminal", title: "Buffered output", desc: "Output held in memory for all terminals.", section: "Resource overview", keywords: "memory bytes buffer" },
  { tab: "terminal", title: "Run panes", desc: "When worker panes close.", section: "Resource overview", keywords: "worker panes close lifecycle run terminal" },
  { tab: "api", title: "OpenRouter API key", desc: "The key behind inline edits and OpenRouter models.", section: "OpenRouter", keywords: "key token openrouter secret" },
  { tab: "api", title: "Inline edit and commit model", desc: "The OpenRouter model for inline edits.", section: "OpenRouter", keywords: "model gemini autocomplete" },
  { tab: "api", title: "Models for Cora", desc: "OpenRouter models offered in the Cora picker.", section: "OpenRouter", keywords: "model picker openrouter favorite" },
  { tab: "api", title: "Commit message model", desc: "The model that drafts commit messages.", section: "Git commit messages", keywords: "commit draft model git" },
  { tab: "agents", title: "Add account", desc: "Sign in to another Claude, ChatGPT or xAI account.", keywords: "new sign in login another account connect claude codex grok" },
  { tab: "agents", title: "How switching works", desc: "What a switch moves, and which sessions follow.", keywords: "switch account active use change sessions" },
  { tab: "agents", title: "Anthropic", label: "Anthropic accounts", desc: "Claude accounts for Cora and Claude Code.", keywords: "claude code claude login account email limits switch system own login" },
  { tab: "agents", title: "OpenAI", label: "OpenAI accounts", desc: "ChatGPT accounts for Cora and Codex.", keywords: "codex chatgpt codex login account email limits switch system own login" },
  { tab: "agents", title: "xAI", label: "xAI accounts", desc: "SuperGrok accounts for Cora and Grok.", keywords: "grok supergrok grok login account email switch system own login" },
  { tab: "agents", title: "Usage limits", desc: "Re-read every account's limits now.", section: "Limits and runtime", keywords: "quota rate limit refresh" },
  { tab: "agents", title: "Fast mode", desc: "Cora and her workers answer faster on models that support it, at a higher price.", section: "Limits and runtime", keywords: "speed faster priority service tier premium lightning flash", toggle: "fastMode" },
  { tab: "agents", title: "Pi runtime", desc: "The coding agent Cora runs on.", section: "Limits and runtime", keywords: "pi install version" },
  { tab: "agents", title: "Claude Extra Usage", desc: "Paid usage on top of a Pro or Max plan.", section: "Limits and runtime", keywords: "billing extra usage overage api key cost" },
  { tab: "agents", title: "Capability Center", desc: "MCP servers, skills, profiles, memory and worker models.", section: "Tools", keywords: "mcp servers skills memory profiles worker models tools" },
  { tab: "capabilities", title: "Always verify edits with a worker", desc: "Every change goes through a worker and a verifier.", section: "Behavior", capabilityTab: "policy", keywords: "cora verify verifier review edits" },
  { tab: "capabilities", title: "Auto-compact context at", desc: "How full the context window gets before Cora and her workers compact.", section: "Behavior", capabilityTab: "policy", keywords: "compaction compact context window limit tokens percent summarize" },
  { tab: "capabilities", title: "Mention available MCP servers in worker prompts", desc: "Workers learn the MCP servers configured for their CLI.", section: "Behavior", capabilityTab: "policy", keywords: "mcp worker prompt tools" },
  { tab: "capabilities", title: "Mention available skills in worker prompts", desc: "Workers learn which skills exist.", section: "Behavior", capabilityTab: "policy", keywords: "skills worker prompt" },
  { tab: "capabilities", title: "Codara tools in other apps", desc: "Add the codara-studio MCP server to your global Claude Code and Codex config.", section: "Behavior", capabilityTab: "policy", keywords: "mcp global claude code codex config outside" },
  { tab: "capabilities", title: "MCP servers", desc: "Extra tools for Cora, its workers and your CLIs.", capabilityTab: "mcp", keywords: "mcp tools server database browser" },
  { tab: "capabilities", title: "Skills", desc: "Instructions an agent loads when a task needs them.", capabilityTab: "skills", keywords: "skill instructions checklist" },
  { tab: "capabilities", title: "Profiles", desc: "Separate Coras, each with its own instructions and memory.", capabilityTab: "profiles", keywords: "cora profile persona instructions" },
  { tab: "capabilities", title: "Memory", desc: "What Cora remembers between chats.", capabilityTab: "memory", keywords: "remember memories notes" },
  { tab: "capabilities", title: "Worker models", desc: "The models Cora may hand work to.", capabilityTab: "workers", keywords: "models worker roster switch on" },
  { tab: "sessions", title: "Resume running agent sessions when Codara reopens", desc: "Bring back agent sessions after a restart.", section: "Restore", keywords: "restore relaunch restart resume reopen", toggle: "restoreAgentSessions" },
  { tab: "sessions", title: "Agent sessions", desc: "Find, resume and delete Claude and Codex sessions.", keywords: "history transcripts delete claude codex conversations" },
  { tab: "remote-access", title: "Allow remote access", desc: "Pair the Codara phone app with this computer.", section: "Connection", keywords: "phone mobile app pair qr" },
  { tab: "remote-access", title: "Pair a new device", desc: "Show a code to pair another phone.", section: "Connection", keywords: "phone mobile qr code pairing" },
  { tab: "remote-access", title: "Paired devices", desc: "Phones that can reach this computer.", keywords: "revoke phone device mobile" },
  { tab: "keybindings", title: "Keybindings", desc: "Record new shortcuts for any command.", keywords: "shortcuts keyboard hotkeys keys" },
  { tab: "runs", title: "All runs", desc: "Every Cora run on this computer.", keywords: "history delete open runs" },
  { tab: "about", title: "Version", desc: "The Codara Studio build you are running.", section: "Details", keywords: "about build release" },
  { tab: "about", title: "Platform", desc: "The operating system Codara runs on.", section: "Details", keywords: "os macos windows linux" },
  { tab: "about", title: "App ID", desc: "The application identifier.", section: "Details", keywords: "bundle identifier" },
  { tab: "about", title: "Software update", desc: "Check for a newer version.", section: "Details", keywords: "check for updates upgrade new version" },
  { tab: "about", title: "Earlier versions", desc: "Space freed from versions an update replaced.", section: "Details", keywords: "cleanup old versions disk" },
];

// Every command on the Keybindings page, derived from the command registry
// so a new command is searchable without an entry here.
const SHORTCUT_ENTRIES: ReadonlyArray<SettingsSearchEntry> = COMMANDS.map((command) => ({
  tab: "keybindings" as const,
  title: command.label,
  desc: command.fixed ? "A built-in keyboard shortcut." : "Keyboard shortcut. Record a new key combination.",
  section: command.group,
  keywords: `shortcut keyboard hotkey key ${command.id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\./g, " ")}`,
  shortcut: true,
}));

export function allSettingsSearchEntries(): ReadonlyArray<SettingsSearchEntry> {
  return [...SETTINGS_SEARCH_INDEX, ...SHORTCUT_ENTRIES];
}

/** The page and section a result lives on, for its breadcrumb. */
export function entryLocation(entry: SettingsSearchEntry): string[] {
  if (entry.tab === "capabilities") {
    const page = entry.capabilityTab ? CAPABILITY_PAGE_LABEL[entry.capabilityTab] : undefined;
    return ["Capability Center", ...(page && page !== entry.title ? [page] : [])];
  }
  return [tabMeta(entry.tab).title, ...(entry.section ? [entry.section] : [])];
}

// ── Matching ──────────────────────────────────────────────────────────────
//
// Every query word must match a word of the entry, in any order: exactly, as
// the start of a word, inside a longer word, through a synonym, or with a
// small typo. Filler words ("the", "how", "to") may match nothing. Results
// rank by where the words matched (the title counts most) and how well.

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "do", "does", "for", "how", "i", "in", "is",
  "it", "me", "my", "of", "on", "or", "set", "the", "to", "turn", "what",
  "when", "where", "with",
]);

// Words people search with that name the same thing as an indexed word.
const SYNONYMS: Record<string, ReadonlyArray<string>> = {
  alert: ["notification", "notify"],
  alerts: ["notification", "notify"],
  appearance: ["theme"],
  beep: ["sound"],
  colour: ["color", "colors"],
  colours: ["color", "colors"],
  compaction: ["compact"],
  dark: ["theme"],
  hotkey: ["shortcut", "keybindings"],
  hotkeys: ["shortcut", "keybindings"],
  keyboard: ["shortcut", "keybindings"],
  light: ["theme"],
  login: ["account", "sign"],
  logout: ["account"],
  mobile: ["phone", "remote"],
  notifications: ["notification", "notify"],
  password: ["key"],
  shortcut: ["keybindings", "shortcut"],
  shortcuts: ["keybindings", "shortcut"],
  signin: ["sign", "account"],
  speed: ["fast"],
  translucent: ["glass"],
  transparency: ["glass"],
  transparent: ["glass"],
  upgrade: ["update"],
};

const FIELD_WEIGHTS = {
  title: 10,
  keywords: 5,
  section: 4,
  page: 3,
  desc: 2.5,
} as const;
type Field = keyof typeof FIELD_WEIGHTS;

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function words(text: string): string[] {
  return fold(text).split(/[^a-z0-9]+/).filter(Boolean);
}

/** Optimal string alignment distance, cut off early past `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) {
    rows.push(new Array<number>(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}

function typoBudget(term: string): number {
  if (term.length >= 8) return 2;
  if (term.length >= 4) return 1;
  return 0;
}

type MatchKind = "exact" | "prefix" | "inner" | "typo";

interface WordMatch {
  kind: MatchKind;
  quality: number;
  /** Matched span inside the word, for highlighting. */
  start: number;
  end: number;
}

function matchWord(term: string, word: string): WordMatch | null {
  if (word === term) return { kind: "exact", quality: 1, start: 0, end: word.length };
  if (word.startsWith(term)) {
    return { kind: "prefix", quality: term.length === 1 ? 0.5 : 0.85, start: 0, end: term.length };
  }
  if (term.length >= 3) {
    const at = word.indexOf(term);
    if (at > 0) return { kind: "inner", quality: 0.6, start: at, end: at + term.length };
  }
  // A typo keeps its first letter: without that, "glas" would find "flash".
  const budget = term[0] === word[0] ? typoBudget(term) : 0;
  if (budget > 0) {
    if (editDistance(term, word, budget) <= budget) {
      return { kind: "typo", quality: 0.55, start: 0, end: word.length };
    }
    // A typo in a word still being typed: "notifc" against "notification".
    if (
      term.length >= 5 &&
      word.length > term.length &&
      editDistance(term, word.slice(0, term.length), budget) <= budget
    ) {
      return { kind: "typo", quality: 0.45, start: 0, end: term.length };
    }
  }
  return null;
}

interface QueryTerm {
  text: string;
  optional: boolean;
  alternatives: ReadonlyArray<string>;
}

function parseQuery(query: string): QueryTerm[] {
  const seen = new Set<string>();
  const terms = words(query).filter((term) => {
    if (seen.has(term)) return false;
    seen.add(term);
    return true;
  });
  const allStop = terms.every((term) => STOP_WORDS.has(term));
  return terms.map((text) => ({
    text,
    optional: !allStop && STOP_WORDS.has(text),
    alternatives: SYNONYMS[text] ?? [],
  }));
}

/** How well a term matches a word, synonyms included, or 0. */
function termQuality(term: QueryTerm, word: string): number {
  const direct = matchWord(term.text, word)?.quality ?? 0;
  let best = direct;
  for (const alternative of term.alternatives) {
    const viaSynonym = (matchWord(alternative, word)?.quality ?? 0) * 0.8;
    if (viaSynonym > best) best = viaSynonym;
  }
  return best;
}

function entryFields(entry: SettingsSearchEntry): Record<Field, string> {
  const location = entryLocation(entry);
  return {
    title: `${entry.label ?? ""} ${entry.title}`,
    keywords: entry.keywords ?? "",
    section: location.slice(1).join(" "),
    page: location[0] ?? "",
    desc: entry.desc,
  };
}

export interface SettingsSearchHit {
  entry: SettingsSearchEntry;
  score: number;
}

export function rankSettings(
  query: string,
  entries: ReadonlyArray<SettingsSearchEntry> = allSettingsSearchEntries(),
): SettingsSearchHit[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  const phrase = words(query).join(" ");
  const hits: Array<SettingsSearchHit & { order: number }> = [];
  entries.forEach((entry, order) => {
    const fields = entryFields(entry);
    const fieldWords = (Object.keys(fields) as Field[]).map((field) => ({
      weight: FIELD_WEIGHTS[field],
      words: words(fields[field]),
      // "middleclick" finds "Middle-click", "autofetch" finds "auto-fetch".
      joined: words(fields[field]).join(""),
    }));
    let score = 0;
    for (const term of terms) {
      let best = 0;
      for (const field of fieldWords) {
        for (const word of field.words) {
          const quality = termQuality(term, word) * field.weight;
          if (quality > best) best = quality;
        }
        if (term.text.length >= 5 && field.joined.includes(term.text)) {
          best = Math.max(best, 0.5 * field.weight);
        }
      }
      if (best === 0 && !term.optional) return;
      score += best;
    }
    const title = words(entry.label ?? entry.title).join(" ");
    if (phrase && title === phrase) score += 20;
    else if (phrase && title.startsWith(phrase)) score += 12;
    else if (phrase && title.includes(phrase)) score += 6;
    // A setting outranks a shortcut that matches as well, and a row folded
    // under another ranks below the row that unfolds it.
    if (entry.shortcut) score *= 0.85;
    if (entry.reveal) score *= 0.6;
    hits.push({ entry, score, order });
  });
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return hits.map(({ entry, score }) => ({ entry, score }));
}

export function searchSettings(query: string): SettingsSearchEntry[] {
  return rankSettings(query).map((hit) => hit.entry);
}

/**
 * The spans of `text` a query matched, as [start, end) pairs in order, for
 * marking a result's title and description.
 */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  const wordPattern = /[a-z0-9]+/g;
  let found: RegExpExecArray | null;
  while ((found = wordPattern.exec(lower))) {
    const word = found[0];
    let span: [number, number] | null = null;
    for (const term of terms) {
      const direct = matchWord(term.text, word);
      // A filler word marks only itself, never every word it begins.
      if (term.optional && direct?.kind !== "exact") continue;
      if (direct && (!span || direct.end - direct.start > span[1] - span[0])) {
        span = [direct.start, direct.end];
      }
      if (!span && term.alternatives.some((alternative) => matchWord(alternative, word))) {
        span = [0, word.length];
      }
    }
    if (span) ranges.push([found.index + span[0], found.index + span[1]]);
  }
  return ranges;
}
