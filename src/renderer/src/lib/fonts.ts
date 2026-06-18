// Nerd Font detection for terminal panes, so terminals render glyph icons
// (powerline, devicons) when the user has a Nerd Font installed system-wide.
// Falls back to JetBrains Mono / SFMono / Menlo otherwise.
//
// Detection renders Nerd glyphs to a canvas with each candidate family and
// compares pixels against the generic-monospace rendering. We deliberately do
// NOT use document.fonts.check(): in Electron it returns true for ANY family
// name (even nonexistent ones — the generic fallback "covers" the probe), so
// it would always select the first candidate whether or not it is installed,
// leaving the icons as tofu boxes when it isn't. Width probes also fail —
// Nerd Fonts are metric-compatible with the system fallbacks (e.g. MesloLGS
// vs Menlo), so a missing glyph's notdef box has the same advance as the real
// glyph. Pixel comparison is the only signal that survives both traps.
//
// Result is cached in-process: detection renders a handful of small canvases,
// and the answer cannot change without a page reload (font installation
// requires a full app restart to be visible to Chromium anyway).

const NERD_FONT_CANDIDATES = [
  "JetBrainsMono Nerd Font",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMonoNL Nerd Font",
  "FiraCode Nerd Font",
  "FiraCode Nerd Font Mono",
  "MesloLGS NF",
  "MesloLGS Nerd Font",
  "MesloLGM Nerd Font",
  "MesloLGL Nerd Font",
  "Hack Nerd Font",
  "Hack Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "Iosevka Nerd Font",
  "Iosevka Term Nerd Font",
  "SauceCodePro Nerd Font",
  "Hasklug Nerd Font",
];

const FALLBACK_CHAIN = '"JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace';

// Glyphs only a Nerd Font carries: powerline arrow U+E0B0, apple logo U+F179,
// folder U+F07B. Several glyphs so a single coincidental notdef match can't
// produce a false negative.
const PROBE_GLYPHS = "\ue0b0\uf179\uf07b";

let detected: string | null = null;

export function detectMonoFontFamily(): string {
  if (detected) return detected;
  if (typeof document === "undefined") {
    detected = FALLBACK_CHAIN;
    return detected;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 40;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      detected = FALLBACK_CHAIN;
      return detected;
    }
    const render = (font: string): string => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.fillText(PROBE_GLYPHS, 0, 20);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data.join();
    };
    // If the candidate is not installed, the canvas falls back to generic
    // monospace and the pixels match this baseline exactly; if it IS
    // installed, the real glyphs (or at worst its own notdef shape) differ.
    const baseline = render("24px monospace");
    for (const f of NERD_FONT_CANDIDATES) {
      if (render(`24px "${f}", monospace`) !== baseline) {
        detected = `"${f}", ${FALLBACK_CHAIN}`;
        return detected;
      }
    }
  } catch {
    // Canvas unavailable (test envs) — fall through to the plain chain.
  }
  detected = FALLBACK_CHAIN;
  return detected;
}
