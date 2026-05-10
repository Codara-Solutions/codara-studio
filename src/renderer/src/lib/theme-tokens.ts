/**
 * Runtime resolution of Spark's CSS custom properties into concrete rgb strings.
 *
 * styles.css declares tokens in oklch() / color-mix(), which xterm.js (WebGL),
 * Monaco, and CodeMirror's static theme builders can't consume directly. We
 * resolve each token through the browser: setting `color: var(--x)` on a
 * detached element forces computation into rgb form, which all three
 * consumers accept.
 *
 * This module is forward-compatible: the same probe handles hsl/hex/named
 * colors, so it keeps working if the design system migrates off oklch.
 *
 * Tokens are read once per call. Use `subscribeAppTokens` to react to theme
 * changes (e.g. dark/light class toggles on <html>).
 */

/** Mapping from a logical key to the underlying CSS variable name. */
const TOKEN_VARS = {
  background: "bg",
  panel: "panel",
  panel2: "panel-2",
  panel3: "panel-3",
  foreground: "ink",
  foregroundDim: "ink-dim",
  muted: "muted",
  mutedForeground: "muted-2",
  border: "rule",
  borderStrong: "rule-strong",
  borderSoft: "rule-soft",
  accent: "accent",
  accentForeground: "accent-ink",
  accentSoft: "accent-soft",
  accentEdge: "accent-edge",
  primary: "accent",
  primaryForeground: "accent-ink",
  popover: "panel-2",
  popoverForeground: "ink",
  ring: "accent-edge",
  danger: "danger",
  ok: "ok",
  info: "info",
  warn: "warn",
} as const;

export type TokenKey = keyof typeof TOKEN_VARS;

export type AppTokens = Record<TokenKey, string>;

const TOKEN_KEYS = Object.keys(TOKEN_VARS) as TokenKey[];

let probe: HTMLDivElement | null = null;

function ensureProbe(): HTMLDivElement {
  if (probe && probe.isConnected) return probe;
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.position = "fixed";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  el.style.left = "-9999px";
  el.style.top = "0";
  el.style.width = "0";
  el.style.height = "0";
  document.body.appendChild(el);
  probe = el;
  return el;
}

function resolve(el: HTMLDivElement, varName: string): string {
  el.style.color = `var(--${varName})`;
  // Reading `.color` (not `.backgroundColor`) lets the browser convert
  // oklch / color-mix into the canonical rgb()/rgba() string form.
  return getComputedStyle(el).color;
}

/**
 * Reads every Spark theme token and returns the resolved rgb strings.
 *
 * WHY: xterm WebGL, Monaco, and CodeMirror need rgb() — they can't parse
 * oklch() or color-mix(). This bridges the design tokens to those consumers.
 */
export function readAppTokens(): AppTokens {
  const el = ensureProbe();
  const out = {} as AppTokens;
  for (const key of TOKEN_KEYS) {
    out[key] = resolve(el, TOKEN_VARS[key]);
  }
  return out;
}

/**
 * Subscribes to theme-token changes. Re-reads tokens whenever the
 * `class` or `data-theme` attribute changes on <html> (covers dark/light
 * toggles and custom theme switches). Fires once synchronously with the
 * current tokens, then on every relevant mutation.
 *
 * Returns an unsubscribe function.
 */
export function subscribeAppTokens(
  callback: (tokens: AppTokens) => void,
): () => void {
  // Fire synchronously so callers don't need a separate initial read.
  try {
    callback(readAppTokens());
  } catch {
    // DOM may not be ready in tests / SSR; ignore — observer still attaches.
  }

  const observer = new MutationObserver(() => {
    callback(readAppTokens());
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });

  return () => observer.disconnect();
}
