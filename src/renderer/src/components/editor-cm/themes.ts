import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import type { Extension } from "@codemirror/state";
import type { EditorThemeId } from "@shared/types";

// 9 named themes mapped to lazy theme loaders. The settings UI offers these
// as a dropdown; the editor swaps the resolved Extension via themeCompartment
// so no full state rebuild happens.
//
// Each entry is a `() => Promise<Extension>` so the 6 non-default theme
// packages stay out of the eager bundle — mirrors the dynamic-import pattern
// in editor-cm/languageResolver.ts. Only `@uiw/codemirror-theme-github`
// (which backs the DEFAULT_PREFERENCES theme `github-dark`, plus
// `github-light`) is imported eagerly so the active theme is on the very
// first paint with no unthemed flash.
export const EDITOR_THEME_EXT: Record<
  EditorThemeId,
  () => Promise<Extension>
> = {
  atomone: () =>
    import("@uiw/codemirror-theme-atomone").then((m) => m.atomone),
  aura: () => import("@uiw/codemirror-theme-aura").then((m) => m.aura),
  copilot: () =>
    import("@uiw/codemirror-theme-copilot").then((m) => m.copilot),
  // Eagerly bundled — resolved synchronously, no extra network/chunk.
  "github-dark": () => Promise.resolve(githubDark),
  "github-light": () => Promise.resolve(githubLight),
  nord: () => import("@uiw/codemirror-theme-nord").then((m) => m.nord),
  "tokyo-night": () =>
    import("@uiw/codemirror-theme-tokyo-night").then((m) => m.tokyoNight),
  "xcode-dark": () =>
    import("@uiw/codemirror-theme-xcode").then((m) => m.xcodeDark),
  "xcode-light": () =>
    import("@uiw/codemirror-theme-xcode").then((m) => m.xcodeLight),
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
