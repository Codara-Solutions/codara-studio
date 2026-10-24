// Byte searches that run on every PTY chunk. Each jumps between occurrences
// of one needle byte with the native Uint8Array.indexOf instead of comparing
// byte by byte in JavaScript. The jump byte should be the needle's rarest in
// terminal output: TUI frames put an ESC every few bytes, so anchoring a
// search for an escape sequence on its ESC saves nothing.

export function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, anchor = 0): number {
  const length = needle.length;
  if (length === 0) return 0;
  const jump = needle[anchor];
  const last = haystack.length - length;
  let at = haystack.indexOf(jump, anchor);
  while (at !== -1) {
    const start = at - anchor;
    if (start > last) return -1;
    let matched = 0;
    while (matched < length && haystack[start + matched] === needle[matched]) matched += 1;
    if (matched === length) return start;
    at = haystack.indexOf(jump, at + 1);
  }
  return -1;
}
