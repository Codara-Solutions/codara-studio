import { ctrl, mod, type Chord } from "./chord";

// The command registry. Every keyboard-triggerable action is an entry here:
// an `id` for handler dispatch, a human label for the cheat sheet / settings
// UI, the group it falls under, and a list of default chords (multiple so
// `Ctrl+=` and `Ctrl++` can both resolve to "Zoom in" without inventing a
// special matcher).
//
// User overrides live in AppPreferences.keybindings; see ./bindings.ts for
// how defaults merge with overrides. The dispatcher in useGlobalShortcuts
// consults the effective table built by `buildBindingTable`.

export type CommandId =
  | "shortcuts.open"
  | "settings.open"
  | "session.openInspector"
  | "composer.focus"
  | "sidebar.toggle"
  | "search.open"
  | "terminal.toggle"
  | "terminal.newBalancedPane"
  | "terminal.splitRight"
  | "terminal.splitDown"
  | "terminal.closePane"
  | "terminal.toggleZoom"
  | "view.selectByIndex"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "tab.newTerminal"
  | "tab.newEditor"
  | "tab.newPreview"
  | "tab.close"
  | "tab.closeOthers"
  | "tab.cycleNext"
  | "tab.cyclePrev"
  | "worker.newClaude"
  | "worker.newCodex"
  | "worker.newCursor";

export type CommandGroup = "General" | "Navigation" | "View" | "Tabs" | "Terminal" | "Workers";

export type Command = {
  id: CommandId;
  label: string;
  group: CommandGroup;
  defaultChords: Chord[];
  // When true, the chord can't be rebound from the Keybindings UI — used
  // for commands whose key portion varies at runtime (e.g. "Switch tab 1–9").
  // The cheat sheet still shows the default chord; the settings UI marks
  // the row as fixed.
  fixed?: boolean;
  // Optional custom matcher used INSTEAD of the chord list. Only set on
  // `fixed` commands where the chord shape can't be expressed as a fixed
  // key (e.g. variable digit). The dispatcher calls this directly.
  customMatch?: (e: KeyboardEvent) => boolean;
};

export const COMMAND_GROUPS: CommandGroup[] = [
  "General",
  "Navigation",
  "View",
  "Tabs",
  "Terminal",
  "Workers",
];

export const COMMANDS: Command[] = [
  {
    id: "shortcuts.open",
    label: "Show keyboard shortcuts",
    group: "General",
    defaultChords: [mod("k")],
  },
  {
    id: "settings.open",
    label: "Open settings",
    group: "General",
    defaultChords: [mod(",")],
  },
  {
    id: "session.openInspector",
    label: "Open session inspector",
    group: "General",
    // Mod+Shift+I — overlay with cost / events / context window / failure
    // tabs against the active chat run. Mod+I alone often triggers DevTools
    // in Chromium contexts, so the inspector lives on its Shifted variant.
    defaultChords: [mod("i", { shift: true })],
  },
  {
    id: "composer.focus",
    label: "Focus chat composer",
    group: "Navigation",
    defaultChords: [mod("/")],
  },
  {
    id: "sidebar.toggle",
    label: "Toggle sidebar",
    group: "View",
    defaultChords: [mod("b")],
  },
  {
    id: "search.open",
    label: "Search in files",
    group: "Navigation",
    defaultChords: [mod("f", { shift: true })],
  },
  {
    id: "terminal.toggle",
    label: "Toggle terminal",
    group: "View",
    defaultChords: [mod("`")],
  },
  {
    id: "terminal.newBalancedPane",
    label: "New terminal pane (equal sizes)",
    group: "Terminal",
    defaultChords: [mod("t", { shift: true })],
  },
  {
    id: "terminal.splitRight",
    label: "Split terminal pane right",
    group: "Terminal",
    // App.tsx checks the active tab kind before dispatching. We still
    // intercept the keystroke so it doesn't fall through to xterm.
    defaultChords: [mod("\\")],
  },
  {
    id: "terminal.splitDown",
    label: "Split terminal pane down",
    group: "Terminal",
    defaultChords: [mod("\\", { shift: true })],
  },
  {
    id: "terminal.closePane",
    label: "Close active terminal pane",
    group: "Terminal",
    // Mod+Shift+W is already tab.closeOthers; Mod+W closes the whole tab.
    // Mod+Shift+K mirrors VS Code's "kill terminal" chord and stays clear
    // of shell readline (Ctrl+K).
    defaultChords: [mod("k", { shift: true })],
  },
  {
    id: "terminal.toggleZoom",
    label: "Toggle terminal pane zoom",
    group: "Terminal",
    // Mod+Shift+Z mirrors the tmux/iTerm "zoom pane" convention; stays out
    // of the way of the shell's literal Ctrl+Z (suspend).
    defaultChords: [mod("z", { shift: true })],
  },
  {
    id: "view.selectByIndex",
    label: "Switch tab 1–9",
    group: "Tabs",
    // Variable-key chord — the digit is the tab index. Not rebindable.
    defaultChords: [mod("1")],
    fixed: true,
    customMatch: (e) =>
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      !e.altKey &&
      /^[1-9]$/.test(e.key),
  },
  {
    id: "view.zoomIn",
    label: "Zoom in",
    group: "View",
    // On most layouts `+` requires Shift (Shift+= → "+") while Ctrl+= alone
    // produces "=". Our key canonicalizer aliases "+" → "=", so the two
    // defaults below differ only in their shift state.
    defaultChords: [mod("="), mod("=", { shift: true })],
  },
  {
    id: "view.zoomOut",
    label: "Zoom out",
    group: "View",
    defaultChords: [mod("-"), mod("-", { shift: true })],
  },
  {
    id: "view.zoomReset",
    label: "Reset zoom",
    group: "View",
    defaultChords: [mod("0")],
  },
  {
    id: "tab.newTerminal",
    label: "New terminal tab",
    group: "Tabs",
    defaultChords: [mod("t")],
  },
  {
    id: "tab.newEditor",
    label: "Open file (search)",
    group: "Tabs",
    defaultChords: [mod("e")],
  },
  {
    id: "tab.newPreview",
    label: "New preview tab",
    group: "Tabs",
    defaultChords: [mod("p")],
  },
  {
    id: "tab.close",
    label: "Close active tab",
    group: "Tabs",
    defaultChords: [mod("w")],
  },
  {
    id: "tab.closeOthers",
    label: "Close other tabs",
    group: "Tabs",
    defaultChords: [mod("w", { shift: true })],
  },
  {
    id: "tab.cycleNext",
    label: "Cycle to next tab",
    group: "Tabs",
    // Cross-app convention is literal Ctrl+Tab even on Mac — Cmd+Tab is
    // the system app switcher.
    defaultChords: [ctrl("Tab")],
  },
  {
    id: "tab.cyclePrev",
    label: "Cycle to previous tab",
    group: "Tabs",
    defaultChords: [ctrl("Tab", { shift: true })],
  },
  // CLI worker spawners. No default chord — the chord-space we'd want
  // (Mod+Shift+C/Mod+Alt+C/…) all collide with built-in or browser
  // bindings. Users bind their own from Settings → Keybindings.
  {
    id: "worker.newClaude",
    label: "New Claude worker pane",
    group: "Workers",
    defaultChords: [],
  },
  {
    id: "worker.newCodex",
    label: "New Codex worker pane",
    group: "Workers",
    defaultChords: [],
  },
  {
    id: "worker.newCursor",
    label: "New Cursor worker pane",
    group: "Workers",
    defaultChords: [],
  },
];

const COMMAND_BY_ID = new Map<CommandId, Command>(COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: CommandId): Command | undefined {
  return COMMAND_BY_ID.get(id);
}

export const COMMAND_IDS: CommandId[] = COMMANDS.map((c) => c.id);
