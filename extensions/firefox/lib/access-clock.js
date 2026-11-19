// What a read of a tab was allowed by, stamped, so its answer never leaves
// once that changed, even if the same access was given back meanwhile
// (lib/cookies.js, cookieGate). One counter moves for what reaches every
// tab: sharing a window or everything, the blocked sites, Firefox's site
// access and the link. Each tab has its own for what reaches only that
// tab: its page, its window, attaching it, sharing or stopping it, its
// cookie switch, closing it. So a busy browser (other tabs loading, moving,
// closing) never ends a read of this tab, and any change to this tab does.
// No browser.* here, so the tests run it in Node.

// Lists in the extension's state whose members are tab ids: a change
// reaches only the tabs added or removed (a read of a tab checks only that
// tab's membership). The cookie switch is one: closing another tab whose
// switch was on must not end this tab's read.
const PER_TAB_KEYS = ["attached", "shareTabs", "stopped", "storageTabs"];
// Everything else that decides what a tab may share reaches every tab.
const ALL_TABS_KEYS = ["shareAll", "shareWindows", "blockedSites"];

export const ACCESS_KEYS = Object.freeze([...PER_TAB_KEYS, ...ALL_TABS_KEYS]);

export class AccessClock {
  #ticks = 0;
  #all = 0;
  // Never deleted: a closed tab's stamp must not fall back to one a read holds.
  #tabs = new Map();

  /** Something that reaches every tab changed. */
  all() {
    this.#all = ++this.#ticks;
  }

  /** Something that reaches only this tab changed. */
  tab(tabId) {
    this.#tabs.set(tabId, ++this.#ticks);
  }

  /** The stamp a read of the tab holds: it differs after any change that reaches the tab, and never comes back. */
  of(tabId) {
    return `${this.#all}:${this.#tabs.get(tabId) ?? 0}`;
  }

  /** Moves the counters for a change of the extension's state from `before` by `patch` (see accessMoves). */
  save(before, patch) {
    const moves = accessMoves(before, patch);
    if (moves.all) this.all();
    for (const tabId of moves.tabs) this.tab(tabId);
  }
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Which access a change of the extension's state moves: `all` when it
 * reaches every tab, and the tabs it reaches. A key written with the value
 * it had moves nothing, so closing an unshared tab ends no read.
 */
export function accessMoves(before, patch) {
  const tabs = new Set();
  let all = false;
  for (const key of ALL_TABS_KEYS) {
    if (key in patch && !sameValue(before?.[key], patch[key])) all = true;
  }
  for (const key of PER_TAB_KEYS) {
    if (!(key in patch)) continue;
    const old = new Set(Array.isArray(before?.[key]) ? before[key] : []);
    const now = new Set(Array.isArray(patch[key]) ? patch[key] : []);
    for (const id of old) if (!now.has(id)) tabs.add(id);
    for (const id of now) if (!old.has(id)) tabs.add(id);
  }
  return { all, tabs: [...tabs] };
}
