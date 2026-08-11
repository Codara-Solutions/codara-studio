// Pure geometry + index math for the top tab strip's drag-to-reorder.
//
// Everything the strip needs to decide "where does this tab land?" lives here
// so it can be unit-tested without a DOM (scripts/test-tab-reorder.cjs) and so
// TabBar keeps only the event plumbing. Two rules carry the whole design:
//
//   1. Indices are ALWAYS computed against the list with the dragged tab
//      REMOVED. That list is what the drop actually splices into, so a
//      rightward move can't pick up the classic off-by-one from indices
//      shifting after the removal.
//   2. Hit-testing uses each surviving tab's own MIDPOINT, never whole-tab
//      bounds, so variable-width tabs (a short "terminals" pill next to a long
//      file name) each own exactly half of their box. The caller measures the
//      slots ONCE at dragstart, in strip content coordinates, so the numbers
//      stay valid while the strip auto-scrolls under the pointer and never
//      pick up the live transforms the preview applies.
//
// Coordinates: every x here is "strip content space" — viewport x minus the
// scroll container's left edge plus its scrollLeft. Content space is scroll
// invariant, which is what lets one measurement survive a whole gesture.

import type { TabId } from "./types";

/** Layout box of one tab in the strip, in strip content coordinates. */
export interface TabSlot {
  id: TabId;
  /** Left edge, content-space px. */
  start: number;
  /** Right edge, content-space px. */
  end: number;
}

export interface TabReorderPlan {
  draggedId: TabId;
  /** Where the dragged tab sits now, in the FULL slot list. */
  fromIndex: number;
  /**
   * Where it lands, indexed into the list WITHOUT the dragged tab. It is also
   * the dragged tab's final index in the full list once the move is applied.
   */
  insertIndex: number;
  /** False when releasing here leaves the order untouched (a "home" drop). */
  changed: boolean;
  /**
   * Content-space x of the dragged tab's future centre — the middle of the
   * ghost slot below. Only meaningful when `changed`: a home drop has no gap
   * to point at, and showing a placeholder there would promise a move the drop
   * won't make.
   */
  markerX: number;
  /**
   * Left edge of the ghost slot: the placeholder that fills the hole the
   * displaced neighbours open, sitting exactly one strip gap from each of
   * them. At the ends of the strip the hole is only one gap wide on the outer
   * side, so this is computed from the neighbour it follows rather than
   * assumed symmetric around the centre.
   */
  ghostStart: number;
  /** Width of the ghost slot — exactly the dragged tab's own width. */
  ghostWidth: number;
  /**
   * translateX px for each slot, in the same order as the input slots. The
   * dragged slot is always 0 (it stays put and dims; the drag ghost is what
   * follows the cursor). Non-zero entries slide their tab far enough to open a
   * hole exactly as wide as the dragged tab plus its gaps.
   */
  offsets: number[];
}

export interface TabReorderTarget {
  toId: TabId;
  position: "before" | "after";
}

/** Viewport x → strip content x. */
export function toStripContentX(
  clientX: number,
  stripClientLeft: number,
  scrollLeft: number,
): number {
  return clientX - stripClientLeft + scrollLeft;
}

/**
 * Resolve a pointer position to a drop plan. Returns null when the dragged id
 * isn't in the strip (a drag from another window, or a tab an agent closed
 * mid-gesture) — the caller then shows no preview and accepts no drop.
 */
export function planTabReorder(
  slots: readonly TabSlot[],
  draggedId: TabId,
  pointerX: number,
): TabReorderPlan | null {
  const fromIndex = slots.findIndex((slot) => slot.id === draggedId);
  if (fromIndex === -1) return null;

  const dragged = slots[fromIndex];
  // The list the drop splices into. Every index below is an index INTO THIS,
  // which is what makes leftward and rightward moves symmetric.
  const others = slots.filter((_, index) => index !== fromIndex);

  // Midpoint scan: the pointer sits after every surviving tab whose centre it
  // has passed. Counting (rather than breaking on the first miss) keeps the
  // result well-defined even if two boxes were to overlap by a sub-pixel.
  let insertIndex = 0;
  for (const slot of others) {
    if (pointerX >= (slot.start + slot.end) / 2) insertIndex += 1;
  }

  const gap = gapAround(slots, fromIndex);
  // How far the strip collapses when the dragged tab leaves the flow — the
  // exact distance each displaced neighbour has to travel.
  const advance = Math.max(0, dragged.end - dragged.start) + gap;

  const offsets = slots.map(() => 0);
  if (insertIndex > fromIndex) {
    // Moving right: everything from the old slot up to the new one slides left.
    // others[k] is full index k+1 for k >= fromIndex.
    for (let i = fromIndex + 1; i <= insertIndex; i += 1) offsets[i] = -advance;
  } else if (insertIndex < fromIndex) {
    // Moving left: the tabs it jumps over slide right. others[k] is full index
    // k for k < fromIndex.
    for (let i = insertIndex; i < fromIndex; i += 1) offsets[i] = advance;
  }

  const ghostWidth = Math.max(0, dragged.end - dragged.start);
  const ghostStart = ghostStartFor(slots, others, offsets, fromIndex, insertIndex, gap);

  return {
    draggedId,
    fromIndex,
    insertIndex,
    changed: insertIndex !== fromIndex,
    markerX: ghostStart + ghostWidth / 2,
    ghostStart,
    ghostWidth,
    offsets,
  };
}

/**
 * Translate a plan into the (toId, position) pair the tab model's reorder takes.
 * Null when the drop is a no-op, so the caller can skip the state write.
 */
export function reorderTargetFor(
  slots: readonly TabSlot[],
  plan: TabReorderPlan,
): TabReorderTarget | null {
  if (!plan.changed) return null;
  const others = slots.filter((_, index) => index !== plan.fromIndex);
  if (others.length === 0) return null;
  // Past the last survivor: append. Anywhere else: land in front of the tab
  // that currently holds the target index.
  if (plan.insertIndex >= others.length) {
    return { toId: others[others.length - 1].id, position: "after" };
  }
  return { toId: others[plan.insertIndex].id, position: "before" };
}

/**
 * Apply a (fromId, toId, position) move to a tab list. Returns null when the
 * move is a no-op or either id is missing, so callers can keep the previous
 * array identity instead of re-rendering the strip for nothing.
 *
 * Shared by useTabs (production) and the reorder tests, so the index the strip
 * previews and the index the model commits can never drift apart.
 */
export function moveTabInList<T extends { id: TabId }>(
  list: readonly T[],
  fromId: TabId,
  toId: TabId,
  position: "before" | "after",
): T[] | null {
  if (fromId === toId) return null;
  const fromIndex = list.findIndex((item) => item.id === fromId);
  const toIndex = list.findIndex((item) => item.id === toId);
  if (fromIndex === -1 || toIndex === -1) return null;
  const next = list.slice();
  const [moving] = next.splice(fromIndex, 1);
  // After the splice, indices to the right of fromIndex shifted left by one.
  const adjustedToIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
  const insertIndex = position === "after" ? adjustedToIndex + 1 : adjustedToIndex;
  if (insertIndex === fromIndex) return null;
  next.splice(insertIndex, 0, moving);
  return next;
}

/** Width of the edge band that auto-scrolls an overflowing strip, in px. */
export const TAB_STRIP_AUTOSCROLL_ZONE = 44;
/** Peak auto-scroll speed, px per animation frame. */
export const TAB_STRIP_AUTOSCROLL_MAX = 16;

/**
 * Auto-scroll speed for a drag hovering near the strip's edges: 0 in the calm
 * middle, ramping to the cap at (and past) the edge. Negative scrolls left.
 * Without this an overflowing strip can only be reordered within the visible
 * window — the destination you want is off-screen and unreachable.
 */
export function edgeAutoScrollDelta(
  pointerClientX: number,
  stripLeft: number,
  stripRight: number,
  zone: number = TAB_STRIP_AUTOSCROLL_ZONE,
  max: number = TAB_STRIP_AUTOSCROLL_MAX,
): number {
  const width = stripRight - stripLeft;
  if (width <= 0) return 0;
  // Never let the two bands meet in a narrow strip: each gets at most a
  // quarter of the width, leaving a dead middle the user can rest in.
  const band = Math.min(zone, width / 4);
  if (band <= 0) return 0;
  const leftRamp = (stripLeft + band - pointerClientX) / band;
  if (leftRamp > 0) return -max * Math.min(1, leftRamp);
  const rightRamp = (pointerClientX - (stripRight - band)) / band;
  if (rightRamp > 0) return max * Math.min(1, rightRamp);
  return 0;
}

// Gap between the dragged tab and its neighbour — the flex `gap` of the strip,
// read off the live layout so a token change never needs a code change. Falls
// back to the left neighbour for the last tab, and to 0 for a lone tab.
function gapAround(slots: readonly TabSlot[], index: number): number {
  if (index + 1 < slots.length) {
    return Math.max(0, slots[index + 1].start - slots[index].end);
  }
  if (index > 0) return Math.max(0, slots[index].start - slots[index - 1].end);
  return 0;
}

// Left edge of the hole the displaced neighbours open. Computed on the
// DISPLACED boxes (layout position + the offset this plan applies) so the
// placeholder lands exactly where the dragged tab will come to rest, not where
// the tabs were before they slid.
//
// Landing first means taking over the flow origin — the strip's content start,
// which no displacement moves. Every other position follows the tab it lands
// behind, one strip gap along. Deriving it from a neighbour (rather than
// centring on the midpoint between two) is what keeps a full-width placeholder
// from overlapping the first tab at the left end, where the hole is one gap
// narrower than in the middle of the strip.
function ghostStartFor(
  slots: readonly TabSlot[],
  others: readonly TabSlot[],
  offsets: readonly number[],
  fromIndex: number,
  insertIndex: number,
  gap: number,
): number {
  if (others.length === 0) return slots[fromIndex].start;
  if (insertIndex <= 0) return slots[0].start;
  const previous = Math.min(insertIndex, others.length) - 1;
  const offsetOf = (k: number): number => offsets[k < fromIndex ? k : k + 1];
  return others[previous].end + offsetOf(previous) + gap;
}
