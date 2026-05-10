import { atomone } from "@uiw/codemirror-theme-atomone";
import { aura } from "@uiw/codemirror-theme-aura";
import { copilot } from "@uiw/codemirror-theme-copilot";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { nord } from "@uiw/codemirror-theme-nord";
import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { xcodeDark, xcodeLight } from "@uiw/codemirror-theme-xcode";
import type { Extension } from "@codemirror/state";
import type { EditorThemeId } from "@shared/types";

// 9 named themes mapped to ready-to-use Extensions. The settings UI offers
// these as a dropdown; the editor swaps the entry via themeCompartment so
// no full state rebuild happens.
export const EDITOR_THEME_EXT: Record<EditorThemeId, Extension> = {
  atomone,
  aura,
  copilot,
  "github-dark": githubDark,
  "github-light": githubLight,
  nord,
  "tokyo-night": tokyoNight,
  "xcode-dark": xcodeDark,
  "xcode-light": xcodeLight,
};

export const EDITOR_THEME_LABEL: Record<EditorThemeId, string> = {
  atomone: "Atom One",
  aura: "Aura",
  copilot: "Copilot",
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  nord: "Nord",
  "tokyo-night": "Tokyo Night",
  "xcode-dark": "Xcode Dark",
  "xcode-light": "Xcode Light",
};
