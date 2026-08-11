export interface TabStripOverflow {
  left: boolean;
  right: boolean;
}

const SCROLL_EDGE_EPSILON = 1;

export function tabStripOverflow(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): TabStripOverflow {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  const clampedScrollLeft = Math.max(0, Math.min(maxScrollLeft, scrollLeft));
  return {
    left: clampedScrollLeft > SCROLL_EDGE_EPSILON,
    right: clampedScrollLeft < maxScrollLeft - SCROLL_EDGE_EPSILON,
  };
}
