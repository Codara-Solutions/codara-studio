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
  | "runSwitcher.open"
  | "settings.open"
  | "automations.open"
  | "session.openInspector"
  | "composer.focus"
  | "chat.new"
  | "sidebar.toggleLeft"
  | "sidebar.toggleRight"
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
  | "tab.newWhiteboard"
  | "tab.close"
  | "tab.closeOthers"
  | "tab.cycleNext"
  | "tab.cyclePrev"
  | "worker.newClaude"
  | "worker.newCodex"
  | "worker.claudeSessions"
  | "worker.codexSessions"
  | "markdown.togglePreview";

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
    // Mod+? (Shift+/) — the keyboard cheat sheet. Mod+K belongs to the run
    // switcher; Mod+/ is free again (composer.focus moved to Mod+L).
    defaultChords: [mod("/", { shift: true })],
  },
  {
    id: "runSwitcher.open",
    label: "Open run switcher",
    group: "Navigation",
    // Mod+K — command-palette-style switcher over every run across all
    // workspaces.
    defaultChords: [mod("k")],
  },
  {
    id: "settings.open",
    label: "Open settings",
    group: "General",
    defaultChords: [mod(",")],
  },
  {
    id: "automations.open",
    label: "Open Automations",
    group: "Navigation",
    // Mod+Shift+A — jump to the Automations Hub. Free chord (no built-in or
    // browser binding collides with it). The same view is reachable from the
    // tray menu and a matching global accelerator in main.
    defaultChords: [mod("a", { shift: true })],
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
    // Mod+L — a familiar "focus AI chat" convention. Frees Mod+/
    // for the universal Toggle Line Comment chord that editors expect.
    defaultChords: [mod("l")],
  },
  {
    id: "sidebar.toggleLeft",
    label: "Toggle left sidebar",
    group: "View",
    // Mod+B toggles the left rail (workspaces / source control / explorer),
    // mirroring VS Code's primary-sidebar chord.
    defaultChords: [mod("b")],
  },
  {
    id: "sidebar.toggleRight",
    label: "Toggle right sidebar",
    group: "View",
    // Mod+Alt+B toggles the right panel — VS Code's "Toggle Secondary Side
    // Bar" chord (Cmd+Opt+B / Ctrl+Alt+B). Frees Mod+Shift+B (VS Code's Run
    // Build Task muscle memory).
    defaultChords: [mod("b", { alt: true })],
  },
  {
    id: "search.open",
    label: "Search in files",
    group: "Navigation",
    // Mod+Shift+F is the established project-wide content-search chord.
    // Unshifted Mod+F remains local Find in the active terminal/editor.
    defaultChords: [mod("f", { shift: true })],
  },
  {
    id: "terminal.toggle",
    label: "Toggle terminal",
    group: "View",
    // Physical Ctrl+` on every platform — VS Code's terminal-toggle chord.
    // Cmd+` on macOS is the OS "next window" shortcut, so we avoid Mod here.
    defaultChords: [ctrl("`")],
  },
  {
    id: "terminal.newBalancedPane",
    label: "New terminal pane (equal sizes)",
    group: "Terminal",
    // Mod+Alt+D — Windows Terminal's "split pane, automatic". Frees Mod+Shift+T
    // (Reopen Closed Tab in Chrome/VS Code, New Tab in Windows Terminal).
    defaultChords: [mod("d", { alt: true })],
  },
  {
    id: "terminal.splitRight",
    label: "Split terminal pane right",
    group: "Terminal",
    // Native macOS terminal convention: Cmd+D splits right. `mod` keeps the
    // same discoverable default on other platforms while still allowing a
    // user override in Settings.
    defaultChords: [mod("d")],
  },
  {
    id: "terminal.splitDown",
    label: "Split terminal pane down",
    group: "Terminal",
    defaultChords: [mod("d", { shift: true })],
  },
  {
    id: "terminal.closePane",
    label: "Close active terminal pane",
    group: "Terminal",
    // Mod+W is context-aware through tab.close: when a terminal tab has more
    // than one pane it closes the selected pane. Keep this command available
    // for custom bindings without imposing a second default close chord.
    defaultChords: [],
  },
  {
    id: "terminal.toggleZoom",
    label: "Toggle terminal pane zoom",
    group: "Terminal",
    // Mod+Shift+Enter — iTerm2's "Toggle Maximize Pane". Frees Mod+Shift+Z,
    // which is the universal Redo chord an editor must not consume.
    defaultChords: [mod("Enter", { shift: true })],
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
    id: "chat.new",
    label: "New chat",
    group: "Tabs",
    // Mod+N opens a fresh chat tab (the top "+" picker advertises ⌘N).
    defaultChords: [mod("n")],
  },
  {
    id: "tab.newTerminal",
    label: "New terminal tab",
    group: "Tabs",
    defaultChords: [mod("t")],
  },
  {
    id: "tab.newEditor",
    label: "Quick Open file",
    group: "Tabs",
    // Mod+P — the dominant Quick Open / Go to File chord (VS Code, Sublime).
    // This filters file names and paths; it is deliberately distinct from
    // Mod+F local Find and Mod+Shift+F project-wide content search.
    defaultChords: [mod("p")],
  },
  {
    id: "tab.newPreview",
    label: "New preview tab",
    group: "Tabs",
    // Mod+E — swapped with Open File (which took the standard Mod+P quick-open).
    defaultChords: [mod("e")],
  },
  {
    id: "tab.newWhiteboard",
    label: "New whiteboard",
    group: "Tabs",
    // Mod+Shift+W — free chord: Mod+W is Close tab, and nothing binds the
    // shifted variant by default (terminal.closePane ships unbound; no main-
    // process accelerator claims it either).
    defaultChords: [mod("w", { shift: true })],
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
    // Mod+Alt+T — VS Code mac "Close Other Editors". Vacates Mod+Shift+W for
    // terminal.closePane (Windows Terminal's Close-pane chord).
    defaultChords: [mod("t", { alt: true })],
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
  //
  // "New … worker pane" launches a fresh session immediately; the
  // "… worker sessions" variants open the resume picker over the recent
  // sessions in the launch directory. Split on purpose — muscle-memory
  // fresh-session bindings must not grow a dialog in front of them.
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
    id: "worker.claudeSessions",
    label: "Open Claude worker sessions…",
    group: "Workers",
    defaultChords: [],
  },
  {
    id: "worker.codexSessions",
    label: "Open Codex worker sessions…",
    group: "Workers",
    defaultChords: [],
  },
  {
    // Mirrors VS Code's "Markdown: Open Preview" (Cmd/Ctrl+Shift+V). Only the
    // active editor tab reacts — App.tsx broadcasts a window event that
    // EditorPane filters on its own `active` prop.
    id: "markdown.togglePreview",
    label: "Toggle markdown preview",
    group: "View",
    defaultChords: [mod("v", { shift: true })],
  },
];

const COMMAND_BY_ID = new Map<CommandId, Command>(COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: CommandId): Command | undefined {
  return COMMAND_BY_ID.get(id);
}

export const COMMAND_IDS: CommandId[] = COMMANDS.map((c) => c.id);
