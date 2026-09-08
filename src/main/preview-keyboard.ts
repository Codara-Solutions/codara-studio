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

export function previewKeyEvents(key: string, modifiers: string[], text: string | null): Record<string, unknown>[] {
  const named = NAMED_KEYS[key.toLowerCase()];
  const functionKey = /^F([1-9]|1\d|2[0-4])$/i.exec(key);
  const printable = Array.from(key).length === 1;
  if (!named && !functionKey && !printable) throw new Error(`Unsupported preview key: ${key}`);
  const modifierBits = modifiers.reduce((mask, modifier) => mask | ({
    alt: 1, control: 2, meta: 4, shift: 8,
  }[modifier] ?? 0), 0);
  const domKey = named?.[0] ?? (functionKey ? key.toUpperCase() : key);
  const code = named?.[1] ?? (functionKey ? key.toUpperCase() : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key === " " ? "Space" : "");
  const virtualCode = named?.[2] ?? (functionKey ? 111 + Number(functionKey[1]) : /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : key === " " ? 32 : 0);
  const typedText = text ?? ((modifierBits & 7) === 0 ? (domKey === "Enter" ? "\r" : Array.from(domKey).length === 1 ? domKey : "") : "");
  const event = { key: domKey, code, windowsVirtualKeyCode: virtualCode, modifiers: modifierBits };
  return [
    { ...event, type: typedText ? "keyDown" : "rawKeyDown", ...(typedText ? { text: typedText, unmodifiedText: typedText } : {}) },
    { ...event, type: "keyUp" },
  ];
}
