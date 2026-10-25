// CDP keyboard input reaches a preview guest without requiring OS window focus.
// Keep DOM key names and virtual key codes together: the latter drive Chromium's
// default actions, such as inserting newlines and moving focus with Tab.

const NAMED_KEYS: Record<string, [string, string, number]> = {
  enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13],
  escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  tab: ["Tab", "Tab", 9], backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46], del: ["Delete", "Delete", 46],
  insert: ["Insert", "Insert", 45], home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37],
  arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38],
  arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
  arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40],
  space: [" ", "Space", 32], spacebar: [" ", "Space", 32],
  shift: ["Shift", "ShiftLeft", 16], control: ["Control", "ControlLeft", 17],
  alt: ["Alt", "AltLeft", 18], meta: ["Meta", "MetaLeft", 91],
};

// Punctuation a chord commonly names (Mod+/, Mod+,, Ctrl+Shift+.): Chromium
// needs the US-layout code and virtual key, or shortcuts keyed on event.code
// never fire.
const PUNCTUATION: Record<string, [string, number]> = {
  "/": ["Slash", 191], "?": ["Slash", 191], ",": ["Comma", 188], "<": ["Comma", 188],
  ".": ["Period", 190], ">": ["Period", 190], ";": ["Semicolon", 186], ":": ["Semicolon", 186],
  "'": ["Quote", 222], "\"": ["Quote", 222], "[": ["BracketLeft", 219], "{": ["BracketLeft", 219],
  "]": ["BracketRight", 221], "}": ["BracketRight", 221], "\\": ["Backslash", 220], "|": ["Backslash", 220],
  "-": ["Minus", 189], "_": ["Minus", 189], "=": ["Equal", 187], "+": ["Equal", 187], "`": ["Backquote", 192], "~": ["Backquote", 192],
};

const MODIFIER_ALIASES: Record<string, "control" | "shift" | "alt" | "meta" | "mod"> = {
  control: "control", ctrl: "control", ctl: "control",
  shift: "shift",
  alt: "alt", option: "alt", opt: "alt",
  meta: "meta", cmd: "meta", command: "meta", super: "meta", win: "meta",
  mod: "mod", cmdorctrl: "mod", commandorcontrol: "mod",
};

export type KeyModifier = "control" | "shift" | "alt" | "meta";

/** Fold modifier names (ctrl, cmd, option, Mod, ...) to the four CDP knows. Mod is Meta on macOS and Control elsewhere. */
export function normalizeKeyModifiers(raw: unknown, platform: NodeJS.Platform = process.platform): KeyModifier[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<KeyModifier>();
  for (const name of raw) {
    if (typeof name !== "string") continue;
    const alias = MODIFIER_ALIASES[name.trim().toLowerCase()];
    if (!alias) continue;
    out.add(alias === "mod" ? (platform === "darwin" ? "meta" : "control") : alias);
  }
  return [...out];
}

/**
 * Split a chord written as one string ("Control+K", "Mod+Shift+P", "Cmd+,")
 * into its key and modifiers, so agents can pass the notation other browser
 * tools use. A lone "+" or a key ending in "++" keeps "+" as the key.
 */
export function parseKeyChord(
  key: string,
  modifiers: unknown,
  platform: NodeJS.Platform = process.platform,
): { key: string; modifiers: KeyModifier[] } {
  const names = Array.isArray(modifiers) ? [...modifiers] : [];
  let base = key;
  if (key.length > 1 && key.includes("+")) {
    const parts = key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
    const last = parts.pop() ?? "";
    const unknown = parts.filter((part) => !MODIFIER_ALIASES[part.trim().toLowerCase()]);
    if (unknown.length || !last) {
      throw new Error(`Unsupported key chord: ${key}. Write it like Control+K or Mod+Shift+P (modifiers: Control, Shift, Alt, Meta, Mod).`);
    }
    names.push(...parts);
    base = last.trim() || last;
  }
  return { key: base, modifiers: normalizeKeyModifiers(names, platform) };
}

export function previewKeyEvents(key: string, modifiers: string[], text: string | null): Record<string, unknown>[] {
  const named = NAMED_KEYS[key.toLowerCase()];
  const functionKey = /^F([1-9]|1\d|2[0-4])$/i.exec(key);
  const printable = Array.from(key).length === 1;
  if (!named && !functionKey && !printable) throw new Error(`Unsupported preview key: ${key}`);
  const modifierBits = modifiers.reduce((mask, modifier) => mask | ({
    alt: 1, control: 2, meta: 4, shift: 8,
  }[modifier] ?? 0), 0);
  const chord = (modifierBits & 7) !== 0;
  // A real keyboard reports Ctrl+K as key "k" and Ctrl+Shift+K as "K"; pages
  // that compare event.key against one case ignore the other.
  const letter = /^[a-z]$/i.test(key) && !named;
  const caseFolded = letter && chord ? ((modifierBits & 8) ? key.toUpperCase() : key.toLowerCase()) : key;
  const domKey = named?.[0] ?? (functionKey ? key.toUpperCase() : caseFolded);
  const punctuation = PUNCTUATION[key];
  const code = named?.[1] ?? (functionKey ? key.toUpperCase() : letter ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key === " " ? "Space" : punctuation?.[0] ?? "");
  const virtualCode = named?.[2] ?? (functionKey ? 111 + Number(functionKey[1]) : /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : key === " " ? 32 : punctuation?.[1] ?? 0);
  const typedText = text ?? (!chord ? (domKey === "Enter" ? "\r" : Array.from(domKey).length === 1 ? domKey : "") : "");
  const event = { key: domKey, code, windowsVirtualKeyCode: virtualCode, modifiers: modifierBits };
  return [
    { ...event, type: typedText ? "keyDown" : "rawKeyDown", ...(typedText ? { text: typedText, unmodifiedText: typedText } : {}) },
    { ...event, type: "keyUp" },
  ];
}
