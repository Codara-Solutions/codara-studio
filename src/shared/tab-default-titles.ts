// The titles a terminal tab gets until someone renames it ("terminals",
// "terminals 2", "split", "split 3"). One source for the tab hook that makes
// them and for anything that must not mistake one for a name a person chose.
export const TERMINAL_TITLE_BASE = "terminals";
export const SPLIT_TITLE_BASE = "split";

/** True for a title Studio generated itself, as opposed to one a person typed. */
export function isDefaultTabTitle(title: string): boolean {
  return [TERMINAL_TITLE_BASE, SPLIT_TITLE_BASE].some((base) => {
    const t = title.trim().toLowerCase();
    return t === base || new RegExp(`^${base} [2-9]\\d*$|^${base} 1\\d+$`).test(t);
  });
}
