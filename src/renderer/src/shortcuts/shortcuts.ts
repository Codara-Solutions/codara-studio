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
  | "view.selectByIndex";

export type ShortcutGroup = "General" | "Navigation" | "View";

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
    id: "view.selectByIndex",
    label: "Switch run / view 1–9",
    keys: [MOD_KEY, "1…9"],
    group: "Navigation",
    match: (e) => isMod(e) && /^[1-9]$/.test(e.key),
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = ["General", "Navigation", "View"];
