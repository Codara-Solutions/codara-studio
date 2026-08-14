// Pure geometry + index math for the workspace rail's drag-to-reorder.
//
// This is the vertical twin of tabs/tabReorder.ts, and it keeps the same two
// rules that make the tab strip feel right:
//
//   1. Indices are ALWAYS computed against the list with the dragged item
//      REMOVED. That list is what the drop actually splices into, so a
//      downward move can't pick up the classic off-by-one from indices
//      shifting after the removal.
//   2. Hit-testing uses each surviving row's own MIDPOINT, never whole-row
//      bounds, so variable-height items (a 32px workspace row next to a
//      multi-row folder card) each own exactly half of their box. The caller
//      measures the slots ONCE per gesture, in list content coordinates, so
//      the numbers stay valid while the rail auto-scrolls under the pointer
//      and never pick up the live transforms the preview applies.
//
// It adds one thing the tab strip never needed: the dragged item may come from
// a DIFFERENT list (a workspace being dragged out of a folder and into the top
// level, or vice versa). That is the `fromIndex === null` case throughout —
// nothing slides shut behind the item because it was never in this list, so
// every row at or past the insert point slides DOWN to open a full slot.
//
// Coordinates: every y here is "list content space" — viewport y minus the
// list container's top edge plus its scrollTop. Content space is scroll
// invariant, which is what lets one measurement survive a whole gesture.

/** Layout box of one rail item in its list, in list content coordinates. */
export interface VerticalReorderSlot {
  id: string;
  /** Top edge, content-space px. */
  start: number;
  /** Bottom edge, content-space px. */
  end: number;
}

export interface VerticalReorderPlan {
  draggedId: string;
  /**
   * Where the dragged item sits now in the FULL slot list, or null when it
   * lives in another list entirely (a cross-folder move).
   */
  fromIndex: number | null;
  /**
   * Where it lands, indexed into the list WITHOUT the dragged item. For a
   * same-list move it is also the item's final index once the move is applied.
   */
  insertIndex: number;
  /** False when releasing here leaves the order untouched (a "home" drop). */
  changed: boolean;
  /**
   * Top edge of the ghost slot: the placeholder that fills the hole the
   * displaced neighbours open, sitting exactly one list gap from each of them.
   * At the ends of the list the hole is only one gap tall on the outer side,
   * so this follows the neighbour it lands behind rather than assuming the
   * hole is symmetric.
   */
  ghostStart: number;
  /** Height of the ghost slot — exactly the dragged item's own height. */
  ghostHeight: number;
  /**
   * translateY px for each slot, in the same order as the input slots. The
   * dragged slot is always 0 (it stays put and dims; the drag image is what
   * follows the cursor). Non-zero entries slide their row far enough to open a
   * hole exactly as tall as the dragged item plus its gap.
   */
  offsets: number[];
}

/**
 * Resolve a pointer position to a drop plan.
 *
 * `draggedHeight` is only consulted for a cross-list drag, where this list has
 * no slot to measure the incoming item from. Returns null when the item is
 * neither in this list nor measurable — the caller then shows no preview and
 * accepts no drop, rather than guessing a destination.
 */
export function planVerticalReorder(
  slots: readonly VerticalReorderSlot[],
  draggedId: string,
  pointerY: number,
  draggedHeight?: number,
  fallbackGap = 4,
): VerticalReorderPlan | null {
  const foundIndex = slots.findIndex((slot) => slot.id === draggedId);
  const fromIndex = foundIndex === -1 ? null : foundIndex;
  const source = fromIndex === null ? null : slots[fromIndex];
  const ghostHeight = Math.max(0, source ? source.end - source.start : draggedHeight ?? 0);
  // Nothing to preview: the drag came from outside and nobody measured it.
  if (!source && ghostHeight === 0) return null;

  // The list the drop splices into. Every index below is an index INTO THIS,
  // which is what makes upward and downward moves symmetric.
  const others = slots.filter((_, index) => index !== fromIndex);

  // Midpoint scan: the pointer sits after every surviving row whose centre it
  // has passed. Counting (rather than breaking on the first miss) keeps the
  // result well-defined even if two boxes were to overlap by a sub-pixel.
  let insertIndex = 0;
  for (const slot of others) {
    if (pointerY >= (slot.start + slot.end) / 2) insertIndex += 1;
  }

  const gap = gapFor(slots, fromIndex, fallbackGap);
  // How far the list collapses when the dragged item leaves the flow — the
  // exact distance each displaced neighbour has to travel.
  const advance = ghostHeight + gap;
  const offsets = slots.map(() => 0);

  if (fromIndex === null) {
    // Arriving from another list: nothing closes up behind it, so everything
    // from the insert point down slides away to open a full slot.
    for (let index = insertIndex; index < slots.length; index += 1) offsets[index] = advance;
  } else if (insertIndex > fromIndex) {
    // Moving down: everything from the old slot to the new one slides up.
    // others[k] is full index k+1 for k >= fromIndex.
    for (let index = fromIndex + 1; index <= insertIndex; index += 1) offsets[index] = -advance;
  } else if (insertIndex < fromIndex) {
    // Moving up: the rows it jumps over slide down. others[k] is full index k
    // for k < fromIndex.
    for (let index = insertIndex; index < fromIndex; index += 1) offsets[index] = advance;
  }

  return {
    draggedId,
    fromIndex,
    insertIndex,
    // A cross-list drop always changes something (at minimum the item's
    // parent), even when the index happens to match.
    changed: fromIndex === null || insertIndex !== fromIndex,
    ghostStart: ghostStartFor(slots, others, offsets, fromIndex, insertIndex, gap),
    ghostHeight,
    offsets,
  };
}

/**
 * Translate a plan into the `beforeItemId` the rail's move/reorder callbacks
 * take: an item id to land in front of, or null to append at the end.
 *
 * `undefined` means "no-op" — a home drop — so the caller can skip the state
 * write entirely instead of committing a move that changes nothing.
 */
export function beforeItemForVerticalPlan(
  slots: readonly VerticalReorderSlot[],
  plan: VerticalReorderPlan,
): string | null | undefined {
  if (!plan.changed) return undefined;
  const others = slots.filter((_, index) => index !== plan.fromIndex);
  return others[plan.insertIndex]?.id ?? null;
}

/**
 * Apply a (draggedId, beforeItemId) move to a list. Returns null when the move
 * is a no-op or the id is missing.
 *
 * The rail commits through App's reducers rather than this helper, so this
 * exists to let the reorder tests assert that the order the preview PROMISES
 * and the order those reducers produce are the same — the two can't drift
 * apart without a test failing.
 */
export function moveItemBefore<T extends { id: string }>(
  list: readonly T[],
  draggedId: string,
  beforeItemId: string | null,
): T[] | null {
  const fromIndex = list.findIndex((item) => item.id === draggedId);
  if (fromIndex === -1 || beforeItemId === draggedId) return null;
  const next = list.slice();
  const [moving] = next.splice(fromIndex, 1);
  const insertIndex = beforeItemId === null
    ? next.length
    : next.findIndex((item) => item.id === beforeItemId);
  if (insertIndex === -1 || insertIndex === fromIndex) return null;
  next.splice(insertIndex, 0, moving);
  return next;
}

/** Height of the edge band that auto-scrolls an overflowing rail, in px. */
export const RAIL_AUTOSCROLL_ZONE = 28;
/** Peak auto-scroll speed, px per animation frame. */
export const RAIL_AUTOSCROLL_MAX = 12;

/**
 * Auto-scroll speed for a drag hovering near the rail's top/bottom edges: 0 in
 * the calm middle, ramping to the cap at (and past) the edge. Negative scrolls
 * up. Without this a rail taller than its section can only be reordered inside
 * the visible window — the slot the user wants is off-screen and unreachable,
 * because HTML5 drag events never scroll a container themselves.
 *
 * Same shape as the tab strip's horizontal band, retuned for a rail: the
 * section is short, so the bands and the speed are both smaller.
 */
export function railAutoScrollDelta(
  pointerClientY: number,
  listTop: number,
  listBottom: number,
  zone: number = RAIL_AUTOSCROLL_ZONE,
  max: number = RAIL_AUTOSCROLL_MAX,
): number {
  const height = listBottom - listTop;
  if (height <= 0) return 0;
  // Never let the two bands meet in a short list: each gets at most a quarter
  // of the height, leaving a dead middle the user can rest in.
  const band = Math.min(zone, height / 4);
  if (band <= 0) return 0;
  const topRamp = (listTop + band - pointerClientY) / band;
  if (topRamp > 0) return -max * Math.min(1, topRamp);
  const bottomRamp = (pointerClientY - (listBottom - band)) / band;
  if (bottomRamp > 0) return max * Math.min(1, bottomRamp);
  return 0;
}

// Vertical gap between two stacked items — the row's own bottom margin, read
// off the live layout so a spacing change never needs a code change.
//
// For a same-list move it is the gap around the dragged row (falling back to
// its other neighbour for the last row). For a cross-list insert there is no
// dragged row here, so it comes from the destination's own first pair; a list
// with fewer than two items has no measurable gap at all and takes the
// caller's fallback.
function gapFor(
  slots: readonly VerticalReorderSlot[],
  fromIndex: number | null,
  fallback: number,
): number {
  if (fromIndex === null) {
    return slots.length >= 2 ? Math.max(0, slots[1].start - slots[0].end) : Math.max(0, fallback);
  }
  if (fromIndex + 1 < slots.length) {
    return Math.max(0, slots[fromIndex + 1].start - slots[fromIndex].end);
  }
  if (fromIndex > 0) return Math.max(0, slots[fromIndex].start - slots[fromIndex - 1].end);
  return Math.max(0, fallback);
}

// Top edge of the hole the displaced neighbours open. Computed on the
// DISPLACED boxes (layout position + the offset this plan applies) so the
// placeholder lands exactly where the dragged item will come to rest, not
// where the rows were before they slid.
//
// Landing first means taking over the flow origin — the list's content start,
// which no displacement moves. Every other position follows the item it lands
// behind, one list gap along. Deriving it from a neighbour (rather than
// centring between two) is what keeps a full-height placeholder from
// overlapping the first row at the top of the list, where the hole is one gap
// shorter than in the middle.
function ghostStartFor(
  slots: readonly VerticalReorderSlot[],
  others: readonly VerticalReorderSlot[],
  offsets: readonly number[],
  fromIndex: number | null,
  insertIndex: number,
  gap: number,
): number {
  if (others.length === 0) return slots[0]?.start ?? 0;
  if (insertIndex <= 0) return slots[0].start;
  const previous = Math.min(insertIndex, others.length) - 1;
  // others[k] is full index k below the dragged row and k+1 at or above it;
  // a cross-list drag has no dragged row here, so the lists line up 1:1.
  const fullIndex = fromIndex === null || previous < fromIndex ? previous : previous + 1;
  return others[previous].end + offsets[fullIndex] + gap;
}
