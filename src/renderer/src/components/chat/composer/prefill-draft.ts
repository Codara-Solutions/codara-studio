// How `spark:prefill-composer` text combines with what the user already typed.
// Appending is the default so a half-typed thought is never lost; `replace`
// restores a message verbatim (undo), and `prepend` puts a framing starter in
// front of the draft.
export function prefillDraft(
  current: string,
  text: string,
  mode: { replace?: boolean; prepend?: boolean } = {},
): string {
  if (mode.replace) return text;
  if (!current.trim()) return text;
  if (mode.prepend) {
    // A lead-in ("Investigate and fix this bug: ") runs into the draft; a
    // complete starter ("... the best place to start working.") does not, so
    // the draft after it starts a new paragraph.
    return `${text}${/\s$/.test(text) ? "" : "\n\n"}${current.trimStart()}`;
  }
  return current.endsWith("\n") ? `${current}${text}` : `${current}\n${text}`;
}
