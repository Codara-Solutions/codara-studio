// Platform detection for keyboard-shortcut display + dispatch.
//
// Codara runs in an Electron renderer, so `navigator.platform` is reliable
// enough to choose between macOS-style glyphs (⌘ ⌃ ⇧ ⌥ ↵ ⇥) and the cross-
// platform `Ctrl/Alt/Shift/Tab/Enter` words used elsewhere. We export the
// glyph constants used by the shortcuts table so the cheat-sheet renders
// the same characters the user actually types.
const PLATFORM = (() => {
  if (typeof navigator === "undefined") return "";
  const p = navigator.platform || "";
  if (/^Mac/i.test(p)) return "macos";
  if (/Win/i.test(p)) return "windows";
  if (/Linux/i.test(p)) return "linux";
  return "";
})();

export const IS_MAC = PLATFORM === "macos";
export const IS_LINUX = PLATFORM === "linux";
export const IS_WINDOWS = PLATFORM === "windows";

export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
export const CTRL_KEY = IS_MAC ? "⌃" : "Ctrl";
export const ALT_KEY = IS_MAC ? "⌥" : "Alt";
export const SHIFT_KEY = IS_MAC ? "⇧" : "Shift";
export const TAB_KEY = IS_MAC ? "⇥" : "Tab";
export const ENTER_KEY = IS_MAC ? "↵" : "Enter";

export const KEY_SEP = IS_MAC ? "" : "+";

export function fmtShortcut(...parts: string[]): string {
  return parts.join(KEY_SEP);
}
