/**
 * Runtime resolution of Codara's CSS custom properties into concrete rgb strings.
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
 * changes (e.g. named theme class toggles on <html>).
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
 * Reads every Codara theme token and returns the resolved rgb strings.
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
 * Shared subscription machinery.
 *
 * WHY a single observer: every live terminal pane (plus Monaco/CodeMirror)
 * subscribes to token changes. A naive design gives each subscriber its own
 * MutationObserver + its own readAppTokens() (22 getComputedStyle calls =
 * 22 forced style recalcs). The accent-color effect writes `--accent` onto
 * <html>'s inline style — which our `style` attributeFilter watches — so one
 * color tick used to cost O(N_subscribers × 22) synchronous reflows.
 *
 * Instead we keep ONE module-level observer and ONE subscriber Set. Mutations
 * within a single frame are coalesced via requestAnimationFrame, so a burst of
 * `--accent` writes triggers exactly one readAppTokens() per frame; the cached
 * result is then fanned out to every callback. Cost is now O(22) per frame,
 * shared across all subscribers, regardless of how many terminals are open.
 */
const subscribers = new Set<(tokens: AppTokens) => void>();
let sharedObserver: MutationObserver | null = null;
let rafHandle = 0;

/** Re-read tokens once, then fan the cached result out to every subscriber. */
function flushTokens(): void {
  rafHandle = 0;
  const tokens = readAppTokens();
  // Iterate a snapshot: a callback may unsubscribe (or subscribe) mid-flush.
  for (const cb of [...subscribers]) {
    try {
      cb(tokens);
    } catch {
      // A misbehaving subscriber must not starve the others.
    }
  }
}

/** Coalesce any number of mutations in one frame into a single token read. */
function handleMutations(): void {
  if (rafHandle !== 0) return;
  rafHandle = requestAnimationFrame(flushTokens);
}

/**
 * Subscribes to theme-token changes. Re-reads tokens whenever the
 * `class`, `data-theme`, or inline `style` attribute changes on <html>
 * (covers named theme switches and live `--accent`
 * writes). Fires once synchronously with the current tokens, then once per
 * animation frame in which a relevant mutation occurred.
 *
 * All subscribers share a single MutationObserver and a single per-frame
 * token read — see the block comment above — so cost stays O(1) in the
 * number of subscribers. The observer is lazily created on the first
 * subscribe and disconnected when the last subscriber unsubscribes.
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

  subscribers.add(callback);

  // Lazily create + connect the shared observer on the first subscriber.
  if (!sharedObserver) {
    sharedObserver = new MutationObserver(handleMutations);
    sharedObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
  }

  return () => {
    subscribers.delete(callback);
    // Tear everything down once nobody is listening, so the observer doesn't
    // keep running (and a queued frame doesn't fire into an empty Set).
    if (subscribers.size === 0) {
      sharedObserver?.disconnect();
      sharedObserver = null;
      if (rafHandle !== 0) {
        cancelAnimationFrame(rafHandle);
        rafHandle = 0;
      }
    }
  };
}
