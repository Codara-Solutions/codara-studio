import type { TabId } from "./types";

// Geometry channel between the terminal split grid (which OWNS the layout) and
// the Stacks that own the docked content (which must never re-parent it, or a
// <webview> guest reloads and editor/chat state is lost).
//
// The grid publishes each dock cell's fractional rect; the owning Stack has
// registered its per-tab wrapper element, and the rect is written straight to
// that element's inline style. Nothing here goes through React: rect changes
// during a ratio drag are style writes, not renders. Only `shown` — which
// content components consume as a prop — is exposed to React.
//
// Rects stay fractional and are emitted as CSS calc() strings, so window,
// sidebar and panel resizes are handled by the browser with no ResizeObserver
// and no idle cost.

export interface FracRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DockPlacement {
  tabId: TabId;
  hostTabId: TabId;
  leafId: string;
  // null while the cell is parked (its own drag is in flight) or before the
  // host has laid out.
  rect: FracRect | null;
  // Host tab is on screen, this cell is not hidden by a zoomed sibling, and
  // the cell is not parked.
  shown: boolean;
}

interface Registration {
  el: HTMLElement;
  // Extra top offset for surfaces that do not start at the cell's top edge —
  // the chat backend terminal layer sits below the chat panel header.
  insetTop: number;
}

interface ReactSnapshot {
  hostTabId: TabId;
  shown: boolean;
}

const GAP = "var(--terminal-pane-gap, 3px)";

// Height of the title strip DockedPaneChrome paints along a docked cell's top
// edge. The content frame starts BELOW it rather than under it: every dockable
// surface has a header of its own (the chat's ✦ CORA bar, a browser's address
// bar, an editor's file row), all of them with controls in the top-right —
// exactly where the cell's own undock/zoom/close buttons sit. Overlaying the
// two drew the labels through each other and stacked two ✕ buttons on the same
// pixels. A reserved band is also what makes the cell draggable by its title,
// the way a docked pane is expected to behave.
export const DOCK_CHROME_H = 26;

// Content z-index. Sits above `.spark-terminal-tab` (2), which paints an opaque
// panel background over the whole tab, and below the grid's chrome layer (4),
// which must stay clickable over a docked webview.
export const DOCK_CONTENT_Z = 3;

// The grid's chrome layer: resize handles, drop slot and dock-cell controls.
// Must out-rank DOCK_CONTENT_Z or a docked webview swallows them. Still far
// below the app's compact-mode side panels (30), which keep overlaying
// everything.
export const DOCK_CHROME_Z = 4;

const placements = new Map<TabId, DockPlacement>();
const byHost = new Map<TabId, Set<TabId>>();
const elements = new Map<TabId, Registration[]>();
const subscribers = new Map<TabId, Set<() => void>>();
const snapshots = new Map<TabId, ReactSnapshot | null>();

function pct(fraction: number): string {
  return `${fraction * 100}%`;
}

// Byte-for-byte the same frame TerminalStack's paneFrameStyle() gives a
// terminal pane, so a docked cell and a terminal cell of the same fractional
// rect land on the same pixels.
//
// No correction is needed for `.spark-terminal-tab`'s `padding:
// var(--terminal-pane-pad)`: an absolutely positioned child resolves
// percentages against its containing block's PADDING box, which *includes*
// that padding (only a border would shrink it, and there is none). The grid's
// own cells and this frame therefore share an identical 0..100% space, even
// though the two elements sit in different Stacks. Measured in
// tests/e2e/dock-panes.spec.ts, which asserts the two boxes to within 3px.
function frameStyle(rect: FracRect, insetTop: number): Record<string, string> {
  // The chrome band is reserved for every docked surface; `insetTop` is the
  // caller's own extra offset on top of it (the chat's backend-terminal layer
  // starts below the chat panel header).
  const offset = DOCK_CHROME_H + insetTop;
  return {
    left: `calc(${pct(rect.left)} + ${GAP})`,
    top: `calc(${pct(rect.top)} + ${GAP} + ${offset}px)`,
    width: `calc(${pct(rect.width)} - 2 * ${GAP})`,
    height: `calc(${pct(rect.height)} - 2 * ${GAP} - ${offset}px)`,
  };
}

function applyTo(reg: Registration, placement: DockPlacement | undefined): void {
  const { style } = reg.el;
  if (!placement) {
    // Undocked: restore the full-bleed frame EXPLICITLY rather than clearing
    // to "". The Stacks declare their resting geometry as `inset: 0`, and that
    // shorthand is identical either side of an undock — so React diffs it as
    // unchanged and never re-writes it, leaving a cleared element with
    // left/top/right/bottom: auto (collapsed to its static position).
    // `insetTop` is how far below the cell's top edge this surface starts
    // (the chat backend terminal sits under the panel header).
    style.left = "0px";
    style.right = "0px";
    style.bottom = "0px";
    style.top = reg.insetTop > 0 ? `${reg.insetTop}px` : "0px";
    style.width = "";
    style.height = "";
    // These are recomputed from `visible` on the same render that undocks, so
    // React does re-write them.
    style.visibility = "";
    style.pointerEvents = "";
    style.zIndex = "";
    return;
  }
  if (placement.rect) {
    const frame = frameStyle(placement.rect, reg.insetTop);
    style.left = frame.left;
    style.top = frame.top;
    style.width = frame.width;
    style.height = frame.height;
    // inset:0 in the Stack's base style would otherwise fight the frame.
    style.right = "auto";
    style.bottom = "auto";
  }
  // Hidden cells keep their last rect: resizing a webview to zero (or
  // display:none) makes the guest reflow, which is exactly what the mounted-
  // always contract exists to avoid.
  style.visibility = placement.shown ? "visible" : "hidden";
  style.pointerEvents = placement.shown ? "auto" : "none";
  style.zIndex = String(DOCK_CONTENT_Z);
}

// Stacks render every tab of their kind in one pass, so they subscribe once
// here rather than once per tab (hooks can't be called inside a .map). The
// version only moves when a React-visible bit changes — never on a rect write.
let version = 0;
const globalSubscribers = new Set<() => void>();

export function subscribeDockChanges(cb: () => void): () => void {
  globalSubscribers.add(cb);
  return () => {
    globalSubscribers.delete(cb);
  };
}

export function getDockVersion(): number {
  return version;
}

function notify(tabId: TabId): void {
  version += 1;
  for (const cb of globalSubscribers) cb();
  const subs = subscribers.get(tabId);
  if (!subs) return;
  for (const cb of subs) cb();
}

// Replaces the React-visible snapshot only when its contents actually change,
// so useSyncExternalStore sees a stable identity across rect-only updates.
function syncSnapshot(tabId: TabId, next: ReactSnapshot | null): void {
  const prev = snapshots.get(tabId) ?? null;
  if (prev === next) return;
  if (prev && next && prev.hostTabId === next.hostTabId && prev.shown === next.shown) return;
  snapshots.set(tabId, next);
  notify(tabId);
}

function applyToAll(tabId: TabId): void {
  const placement = placements.get(tabId);
  for (const reg of elements.get(tabId) ?? []) applyTo(reg, placement);
}

function dropPlacement(tabId: TabId): void {
  placements.delete(tabId);
  applyToAll(tabId);
  syncSnapshot(tabId, null);
}

// Called from the host tab's layout effect on every render. `next` is the
// complete set of cells that host currently owns; anything it published before
// and no longer lists has been undocked or moved away.
export function publishDockPlacements(hostTabId: TabId, next: DockPlacement[]): void {
  const previous = byHost.get(hostTabId);
  const live = new Set<TabId>();

  for (const placement of next) {
    live.add(placement.tabId);
    const existing = placements.get(placement.tabId);
    // First writer wins across hosts: a tab can only be docked once, and a
    // stale host must not steal a cell from the host that now owns it.
    if (existing && existing.hostTabId !== hostTabId) continue;
    placements.set(placement.tabId, placement);
    applyToAll(placement.tabId);
    syncSnapshot(placement.tabId, { hostTabId, shown: placement.shown });
  }

  if (previous) {
    for (const tabId of previous) {
      if (live.has(tabId)) continue;
      if (placements.get(tabId)?.hostTabId !== hostTabId) continue;
      dropPlacement(tabId);
    }
  }
  byHost.set(hostTabId, live);
}

export function clearDockPlacementsForHost(hostTabId: TabId): void {
  const owned = byHost.get(hostTabId);
  byHost.delete(hostTabId);
  if (!owned) return;
  for (const tabId of owned) {
    if (placements.get(tabId)?.hostTabId !== hostTabId) continue;
    dropPlacement(tabId);
  }
}

// Owning Stacks call this as a stable per-tab callback ref. Registering before
// or after the first publish both converge: whichever happens second applies
// the current placement.
export function registerDockElement(
  tabId: TabId,
  el: HTMLElement | null,
  opts?: { insetTop?: number },
): void {
  const list = elements.get(tabId) ?? [];
  if (!el) {
    elements.delete(tabId);
    return;
  }
  const insetTop = opts?.insetTop ?? 0;
  const existing = list.find((reg) => reg.el === el);
  if (existing) {
    existing.insetTop = insetTop;
  } else {
    list.push({ el, insetTop });
  }
  elements.set(tabId, list);
  // Apply only when a placement exists. Running the "undocked restore" branch
  // here would CLEAR the visibility/pointerEvents inline styles React applied
  // on this very render — and React's style diffing never re-writes a value it
  // believes is already set, so a freshly-mounted (never-docked) pane would be
  // left inheriting pointer-events:none from its Stack root: visible but
  // click-dead until the next visible-flip re-render (tab switch away+back).
  // The restore branch is only for genuine undocks, where dropPlacement runs
  // applyToAll on the same render that recomputes those styles from `visible`.
  const placement = placements.get(tabId);
  if (placement) applyTo({ el, insetTop }, placement);
}

export function unregisterDockElement(tabId: TabId, el: HTMLElement): void {
  const list = elements.get(tabId);
  if (!list) return;
  const next = list.filter((reg) => reg.el !== el);
  if (next.length === 0) elements.delete(tabId);
  else elements.set(tabId, next);
}

export function subscribeDockPlacement(tabId: TabId, cb: () => void): () => void {
  const subs = subscribers.get(tabId) ?? new Set<() => void>();
  subs.add(cb);
  subscribers.set(tabId, subs);
  return () => {
    subs.delete(cb);
    if (subs.size === 0) subscribers.delete(tabId);
  };
}

export function peekDockPlacementSnapshot(tabId: TabId): ReactSnapshot | null {
  return snapshots.get(tabId) ?? null;
}

export function peekDockPlacement(tabId: TabId): DockPlacement | null {
  return placements.get(tabId) ?? null;
}
