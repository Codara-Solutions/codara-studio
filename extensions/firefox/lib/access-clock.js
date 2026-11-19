// When what decides a tab's access last changed, so a read's answer never
// leaves once that changed after the read began, even if the same access
// was given back meanwhile (lib/cookies.js, cookieGate). One clock ticks on
// every change; each change is stamped with its tick on what it reaches:
// every tab (sharing everything, the blocked sites, Firefox's site access,
// the link), one window (sharing it), or one tab (its page, its window,
// attaching it, sharing or stopping it, its cookie switch, closing it). A
// read notes the tick before its first look at the tab and asks whether
// any stamp that reaches the tab is later. So a busy browser (other tabs
// loading, moving or closing, another window unshared) never ends a read of
// this tab, and any change to this tab does.
// No browser.* here, so the tests run it in Node.

// Lists in the extension's state whose members are tab ids: a change
// reaches only the tabs added or removed (a read of a tab checks only that
// tab's membership). The cookie switch is one: closing another tab whose
// switch was on must not end this tab's read.
const PER_TAB_KEYS = ["attached", "shareTabs", "stopped", "storageTabs"];
// Window ids: a change reaches the tabs of the windows added or removed.
const PER_WINDOW_KEYS = ["shareWindows"];
// Everything else that decides what a tab may share reaches every tab.
const ALL_TABS_KEYS = ["shareAll", "blockedSites"];

export const ACCESS_KEYS = Object.freeze([...PER_TAB_KEYS, ...PER_WINDOW_KEYS, ...ALL_TABS_KEYS]);

export class AccessClock {
  #ticks = 0;
  #all = 0;
  #tabs = new Map();
  #windows = new Map();

  /** The tick a read notes before its first look at the tab. */
  now() {
    return this.#ticks;
  }

  /** Something that reaches every tab changed. */
  all() {
    this.#all = ++this.#ticks;
  }

  /** Something that reaches only this tab changed. */
  tab(tabId) {
    this.#tabs.set(tabId, ++this.#ticks);
  }

  /** Something that reaches the tabs of this window changed. */
  window(windowId) {
    this.#windows.set(windowId, ++this.#ticks);
  }

  /**
   * Whether anything that reaches the tab changed after tick `since`: every
   * tab's stamp, the tab's own, or that of the window it is in now (a tab
   * that moved since has its own stamp later).
   */
  changedSince(since, tabId, windowId) {
    return this.#all > since || (this.#tabs.get(tabId) ?? 0) > since || (this.#windows.get(windowId) ?? 0) > since;
  }

  /** Stamps a change of the extension's state from `before` by `patch` (see accessMoves). */
  save(before, patch) {
    const moves = accessMoves(before, patch);
    if (moves.all) this.all();
    for (const tabId of moves.tabs) this.tab(tabId);
    for (const windowId of moves.windows) this.window(windowId);
  }
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The members one list has and the other has not. */
function changedMembers(before, after) {
  const old = new Set(Array.isArray(before) ? before : []);
  const now = new Set(Array.isArray(after) ? after : []);
  return [...[...old].filter((id) => !now.has(id)), ...[...now].filter((id) => !old.has(id))];
}

/**
 * What a change of the extension's state reaches: `all` tabs, these `tabs`
 * and the tabs of these `windows`. A key written with the value it had
 * reaches nothing, so closing an unshared tab ends no read.
 */
export function accessMoves(before, patch) {
  const tabs = new Set();
  const windows = new Set();
  let all = false;
  for (const key of ALL_TABS_KEYS) {
    if (key in patch && !sameValue(before?.[key], patch[key])) all = true;
  }
  for (const key of PER_TAB_KEYS) if (key in patch) for (const id of changedMembers(before?.[key], patch[key])) tabs.add(id);
  for (const key of PER_WINDOW_KEYS) if (key in patch) for (const id of changedMembers(before?.[key], patch[key])) windows.add(id);
  return { all, tabs: [...tabs], windows: [...windows] };
}
