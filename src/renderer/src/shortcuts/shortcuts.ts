import { MOD_KEY } from "./platform";

// One row per binding: an `id` for handler dispatch, a human label for the
// cheat-sheet, the chord rendered as glyph chips, the group it falls under,
// and the predicate that decides whether a real KeyboardEvent matches it.
// Keeping the predicate next to the label means there is exactly one place
// to edit when a chord moves.

export type ShortcutId =
  | "shortcuts.open"
  | "settings.open"
  | "composer.focus"
  | "sidebar.toggle"
  | "search.open"
  | "terminal.toggle"
  | "terminal.splitRight"
  | "terminal.splitDown"
  | "terminal.closePane"
  | "view.selectByIndex"
  | "tab.newTerminal"
  | "tab.newEditor"
  | "tab.newPreview"
  | "tab.close"
  | "tab.closeOthers"
  | "tab.cycleNext"
  | "tab.cyclePrev";

export type ShortcutGroup = "General" | "Navigation" | "View" | "Tabs" | "Terminal";

export type Shortcut = {
  id: ShortcutId;
  label: string;
  keys: string[];
  group: ShortcutGroup;
  match: (e: KeyboardEvent) => boolean;
};

const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

export const SHORTCUTS: Shortcut[] = [
  {
    id: "shortcuts.open",
    label: "Show keyboard shortcuts",
    keys: [MOD_KEY, "K"],
    group: "General",
    match: (e) => isMod(e) && !e.shiftKey && e.key.toLowerCase() === "k",
  },
  {
    id: "settings.open",
    label: "Open settings",
    keys: [MOD_KEY, ","],
    group: "General",
    match: (e) => isMod(e) && e.key === ",",
  },
  {
    id: "composer.focus",
    label: "Focus chat composer",
    keys: [MOD_KEY, "/"],
    group: "Navigation",
    match: (e) => isMod(e) && e.key === "/",
  },
  {
    id: "sidebar.toggle",
    label: "Toggle sidebar",
    keys: [MOD_KEY, "B"],
    group: "View",
    match: (e) => isMod(e) && !e.shiftKey && e.key.toLowerCase() === "b",
  },
  {
    id: "search.open",
    label: "Search in files",
    keys: [MOD_KEY, "Shift", "F"],
    group: "Navigation",
    match: (e) => isMod(e) && e.shiftKey && e.key.toLowerCase() === "f",
  },
  {
    id: "terminal.toggle",
    label: "Toggle terminal",
    keys: [MOD_KEY, "`"],
    group: "View",
    match: (e) => isMod(e) && (e.key === "`" || e.code === "Backquote"),
  },
  {
    id: "terminal.splitRight",
    label: "Split terminal pane right",
    keys: [MOD_KEY, "\\"],
    group: "Terminal",
    // The chord is intentionally blocked from running outside terminal tabs;
    // App.tsx checks the active tab kind before dispatching. We still
    // intercept the keystroke so it doesn't fall through to xterm.
    match: (e) => isMod(e) && !e.shiftKey && (e.key === "\\" || e.code === "Backslash"),
  },
  {
    id: "terminal.splitDown",
    label: "Split terminal pane down",
    keys: [MOD_KEY, "Shift", "\\"],
    group: "Terminal",
    match: (e) => isMod(e) && e.shiftKey && (e.key === "\\" || e.code === "Backslash"),
  },
  {
    id: "terminal.closePane",
    label: "Close active terminal pane",
    keys: [MOD_KEY, "Shift", "K"],
    group: "Terminal",
    // Mod+Shift+W is already taken by tab.closeOthers, and Mod+W closes the
    // whole tab (which still works for closing the last pane). Mod+Shift+K
    // mirrors VS Code's "kill terminal" chord and stays out of the way of
    // shell readline (Ctrl+K).
    match: (e) => isMod(e) && e.shiftKey && e.key.toLowerCase() === "k",
  },
  {
    id: "view.selectByIndex",
    label: "Switch tab 1–9",
    keys: [MOD_KEY, "1…9"],
    group: "Tabs",
    match: (e) => isMod(e) && !e.shiftKey && /^[1-9]$/.test(e.key),
  },
  {
    id: "tab.newTerminal",
    label: "New terminal tab",
    keys: [MOD_KEY, "T"],
    group: "Tabs",
    match: (e) => isMod(e) && !e.shiftKey && e.key.toLowerCase() === "t",
  },
  {
    id: "tab.newEditor",
    label: "New editor tab",
    keys: [MOD_KEY, "E"],
    group: "Tabs",
    match: (e) => isMod(e) && !e.shiftKey && e.key.toLowerCase() === "e",
  },
  {
    id: "tab.newPreview",
    label: "New preview tab",
    keys: [MOD_KEY, "P"],
    group: "Tabs",
    // Mod+Shift+P is reserved for the (future) command palette; keep this
    // unshifted so the chord is accessible without a stretch.
    match: (e) => isMod(e) && !e.shiftKey && e.key.toLowerCase() === "p",
  },
  {
    id: "tab.close",
    label: "Close active tab",
    keys: [MOD_KEY, "W"],
    group: "Tabs",
    match: (e) => isMod(e) && !e.shiftKey && e.key.toLowerCase() === "w",
  },
  {
    id: "tab.closeOthers",
    label: "Close other tabs",
    keys: [MOD_KEY, "Shift", "W"],
    group: "Tabs",
    match: (e) => isMod(e) && e.shiftKey && e.key.toLowerCase() === "w",
  },
  {
    id: "tab.cycleNext",
    label: "Cycle to next tab",
    keys: ["Ctrl", "Tab"],
    group: "Tabs",
    // Use Ctrl explicitly (not Mod) so this works the same way on macOS,
    // where Ctrl+Tab is the cross-app convention. Avoids stomping on
    // Cmd+Tab (system app switcher).
    match: (e) => e.ctrlKey && !e.shiftKey && e.key === "Tab",
  },
  {
    id: "tab.cyclePrev",
    label: "Cycle to previous tab",
    keys: ["Ctrl", "Shift", "Tab"],
    group: "Tabs",
    match: (e) => e.ctrlKey && e.shiftKey && e.key === "Tab",
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "General",
  "Navigation",
  "View",
  "Tabs",
  "Terminal",
];
