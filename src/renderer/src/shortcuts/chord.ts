import { IS_MAC } from "./platform";

// A keyboard chord captured as the four modifier booleans plus a normalized
// key. We match against the *physical* modifier state (ctrlKey, metaKey,
// altKey, shiftKey) rather than a "logical Mod" key so cross-platform
// defaults stay explicit and the recorder can faithfully store whatever the
// user pressed.
//
// `key` holds the normalized e.key:
//   - Single letters are lowercased so Shift+A and 'a' resolve to the same
//     base ("a"). Shift state is tracked separately in `shift`.
//   - Named keys (Tab, Enter, Escape, ArrowUp, F1, …) are kept verbatim.
//   - Symbols are kept verbatim too. We rely on layout-independent symbol
//     keys plus a few aliasing entries (see `KEY_ALIASES`) for the common
//     "Ctrl+= vs Ctrl++" case.
export type Chord = {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
};

// Modifier keys are never the "key" of a chord — we should ignore standalone
// modifier keydowns so the recorder doesn't capture an incomplete chord
// while the user is mid-press.
const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "ContextMenu",
  "OS",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
]);

export function normalizeKey(key: string): string {
  if (key.length === 1 && /[A-Za-z]/.test(key)) return key.toLowerCase();
  if (key === " ") return "Space";
  return key;
}

// Aliases group physically-identical chords that produce different `e.key`
// values depending on Shift state. The canonical key is stored; matchers
// resolve incoming events through this table before comparing.
//
// Example: on US layouts the same physical key produces "=" without Shift
// and "+" with Shift. We canonicalize both to "=" so Ctrl+= and Ctrl++ are
// recognized as the same chord (with shift differing — the matcher still
// requires shift state to match exactly).
const KEY_ALIASES: Record<string, string> = {
  "+": "=",
  _: "-",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`",
};

export function canonicalKey(key: string): string {
  const normalized = normalizeKey(key);
  return KEY_ALIASES[normalized] ?? normalized;
}

export function chordFromEvent(e: KeyboardEvent): Chord | null {
  if (!e.key || MODIFIER_KEYS.has(e.key)) return null;
  return {
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: canonicalKey(e.key),
  };
}

export function chordMatches(chord: Chord, e: KeyboardEvent): boolean {
  if (e.ctrlKey !== chord.ctrl) return false;
  if (e.metaKey !== chord.meta) return false;
  if (e.altKey !== chord.alt) return false;
  if (e.shiftKey !== chord.shift) return false;
  return canonicalKey(e.key) === chord.key;
}

export function chordEquals(a: Chord, b: Chord): boolean {
  return (
    a.ctrl === b.ctrl &&
    a.meta === b.meta &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.key === b.key
  );
}

// Stable on-disk serialization. Modifier order is fixed (ctrl, meta, alt,
// shift) followed by the key. We use lower-case modifier tokens and keep
// the key verbatim (already normalized).
export function chordToStorage(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.meta) parts.push("meta");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.key);
  return parts.join("+");
}

export function chordFromStorage(serialized: string): Chord | null {
  if (typeof serialized !== "string" || !serialized) return null;
  // Split on "+" but treat a trailing "+" as the key itself so chords like
  // "ctrl++" (which our canonicalizer would never produce, but defensive)
  // don't decode to an empty key.
  const trimmed = serialized.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split("+");
  if (tokens.length === 0) return null;
  // The last non-empty token is the key. Defensive against trailing
  // separators.
  let key = tokens.pop();
  while (key === "" && tokens.length > 0) key = tokens.pop();
  if (!key) return null;
  const chord: Chord = { ctrl: false, meta: false, alt: false, shift: false, key };
  for (const tok of tokens) {
    switch (tok) {
      case "ctrl":
        chord.ctrl = true;
        break;
      case "meta":
        chord.meta = true;
        break;
      case "alt":
        chord.alt = true;
        break;
      case "shift":
        chord.shift = true;
        break;
      default:
        return null;
    }
  }
  return chord;
}

// Chip array for cheat sheet / settings UI. Mac uses Apple's canonical
// glyph order (⌃⌥⇧⌘); other platforms read left-to-right Ctrl+Alt+Shift+Win.
const NAMED_KEY_DISPLAY: Record<string, string> = {
  Tab: IS_MAC ? "⇥" : "Tab",
  Enter: IS_MAC ? "↵" : "Enter",
  Escape: "Esc",
  Backspace: IS_MAC ? "⌫" : "Backspace",
  Delete: IS_MAC ? "⌦" : "Del",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Space: "Space",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Home: "Home",
  End: "End",
};

export function displayKey(key: string): string {
  const named = NAMED_KEY_DISPLAY[key];
  if (named) return named;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function chordToDisplay(chord: Chord): string[] {
  const parts: string[] = [];
  if (IS_MAC) {
    if (chord.ctrl) parts.push("⌃");
    if (chord.alt) parts.push("⌥");
    if (chord.shift) parts.push("⇧");
    if (chord.meta) parts.push("⌘");
  } else {
    if (chord.ctrl) parts.push("Ctrl");
    if (chord.alt) parts.push("Alt");
    if (chord.shift) parts.push("Shift");
    if (chord.meta) parts.push("Win");
  }
  parts.push(displayKey(chord.key));
  return parts;
}

// Single-string hint for inline affordances (menu rows, button tooltips):
// mac glyphs are concatenated tight ("⌘⇧A"), other platforms join the parts
// with "+" ("Ctrl+Shift+A") — matching the KEY_SEP convention in platform.ts.
export function chordToHint(chord: Chord): string {
  return chordToDisplay(chord).join(IS_MAC ? "" : "+");
}

// Constructor helpers used by the command registry to declare defaults.
// `mod()` resolves to Cmd on Mac and Ctrl elsewhere — the standard
// "CommandOrControl" abstraction. `ctrl()` is always physical Ctrl,
// regardless of platform (used for chords like Ctrl+Tab that are
// conventionally Ctrl-only even on Mac).
type ChordExtras = { shift?: boolean; alt?: boolean };

export function mod(key: string, extras: ChordExtras = {}): Chord {
  return {
    ctrl: !IS_MAC,
    meta: IS_MAC,
    alt: extras.alt ?? false,
    shift: extras.shift ?? false,
    key: canonicalKey(key),
  };
}

export function ctrl(key: string, extras: ChordExtras = {}): Chord {
  return {
    ctrl: true,
    meta: false,
    alt: extras.alt ?? false,
    shift: extras.shift ?? false,
    key: canonicalKey(key),
  };
}
