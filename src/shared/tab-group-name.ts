// Tab group names as agents and users type them. Shared by main, which reads
// the `group` argument of the tab-opening tools, and the renderer, which owns
// the groups. Two names are the same group when they match after this
// cleanup, ignoring case.

export const TAB_GROUP_NAME_MAX = 48;

// `cora tool --group 2024` arrives as the number 2024 (its CLI parses every
// value as JSON), so a finite number is read as the name it was typed as.
export function normalizeTabGroupName(raw: unknown): string {
  const text =
    typeof raw === "string" ? raw : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TAB_GROUP_NAME_MAX)
    .trim();
}

export function tabGroupNameKey(raw: unknown): string {
  return normalizeTabGroupName(raw).toLowerCase();
}
