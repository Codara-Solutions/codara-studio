import type { PaneNode, TerminalLeaf, TerminalSplit } from "./types";

// Sequence of "a" / "b" choices describing how to walk the tree from root to
// a specific subtree. Used by the recursive renderer to update the ratio of
// a specific split without naming it — splits are anonymous, so we identify
// them by structural location.
export type PanePath = Array<"a" | "b">;

// Pure helpers for the recursive PaneNode tree backing each terminal tab.
// Kept separate from useTabs so the operations can be unit-tested without a
// React harness, and so the React store stays focused on ids + persistence.

export function leaf(paneId: string, cwd?: string, autorun?: string): TerminalLeaf {
  return { kind: "leaf", paneId, cwd, autorun };
}

export function findLeaf(node: PaneNode, paneId: string): TerminalLeaf | null {
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return findLeaf(node.a, paneId) ?? findLeaf(node.b, paneId);
}

export function collectLeaves(node: PaneNode): TerminalLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...collectLeaves(node.a), ...collectLeaves(node.b)];
}

// Replace the leaf carrying `paneId` with a split holding the original leaf
// plus a new leaf. Returns the unchanged tree if `paneId` is not found, so
// callers can safely call this on any tab without a precondition check.
export function splitAtLeaf(
  node: PaneNode,
  paneId: string,
  direction: TerminalSplit["direction"],
  newPane: TerminalLeaf,
): PaneNode {
  if (node.kind === "leaf") {
    if (node.paneId !== paneId) return node;
    return {
      kind: "split",
      direction,
      ratio: 0.5,
      a: node,
      b: newPane,
    };
  }
  const a = splitAtLeaf(node.a, paneId, direction, newPane);
  const b = splitAtLeaf(node.b, paneId, direction, newPane);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

// Insert an existing leaf next to `paneId`. `position` controls whether the
// moving pane lands before/above (`a`) or after/below (`b`) the target.
export function insertLeafAtLeaf(
  node: PaneNode,
  paneId: string,
  direction: TerminalSplit["direction"],
  movingPane: TerminalLeaf,
  position: "before" | "after",
): PaneNode {
  if (node.kind === "leaf") {
    if (node.paneId !== paneId) return node;
    return {
      kind: "split",
      direction,
      ratio: 0.5,
      a: position === "before" ? movingPane : node,
      b: position === "before" ? node : movingPane,
    };
  }
  const a = insertLeafAtLeaf(node.a, paneId, direction, movingPane, position);
  const b = insertLeafAtLeaf(node.b, paneId, direction, movingPane, position);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

// Drop the leaf carrying `paneId`. If it was one half of a split, the split
// is replaced by the surviving sibling (collapsing the tree upward). Returns
// `null` if the entire tree was the removed leaf, signalling the caller to
// close the tab.
export function removeLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === "leaf") return node.paneId === paneId ? null : node;
  const a = removeLeaf(node.a, paneId);
  const b = removeLeaf(node.b, paneId);
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

// Update the ratio on the split located at `path`. Path of length 0 means
// the root node itself.
export function setRatioAtPath(
  node: PaneNode,
  path: PanePath,
  ratio: number,
): PaneNode {
  if (path.length === 0) {
    if (node.kind !== "split") return node;
    return { ...node, ratio: clamp(ratio, 0.05, 0.95) };
  }
  if (node.kind !== "split") return node;
  const [head, ...rest] = path;
  if (head === "a") {
    const a = setRatioAtPath(node.a, rest, ratio);
    return a === node.a ? node : { ...node, a };
  }
  const b = setRatioAtPath(node.b, rest, ratio);
  return b === node.b ? node : { ...node, b };
}

export function setLeafField<K extends keyof TerminalLeaf>(
  node: PaneNode,
  paneId: string,
  key: K,
  value: TerminalLeaf[K],
): PaneNode {
  if (node.kind === "leaf") {
    if (node.paneId !== paneId) return node;
    return { ...node, [key]: value };
  }
  const a = setLeafField(node.a, paneId, key, value);
  const b = setLeafField(node.b, paneId, key, value);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

// Returns the leaf "to the right" of the given leaf in a depth-first walk,
// wrapping to the first leaf when the cursor falls off the end. Used to
// pick the next active pane after a close.
export function nextLeafAfter(root: PaneNode, paneId: string): TerminalLeaf | null {
  const leaves = collectLeaves(root);
  if (leaves.length === 0) return null;
  const idx = leaves.findIndex((l) => l.paneId === paneId);
  if (idx < 0) return leaves[0];
  return leaves[(idx + 1) % leaves.length] ?? leaves[0];
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// Per-leaf width/height as a fraction of the root container (each in [0,1]).
// Doesn't account for the 4px split-handle thickness — that's a rounding
// error at typical pane counts and not worth the complication for the
// "pick the largest leaf" decision.
export interface LeafMetric {
  paneId: string;
  widthFrac: number;
  heightFrac: number;
}

export function leafMetrics(
  node: PaneNode,
  widthFrac = 1,
  heightFrac = 1,
): LeafMetric[] {
  if (node.kind === "leaf") {
    return [{ paneId: node.paneId, widthFrac, heightFrac }];
  }
  const r = node.ratio;
  if (node.direction === "horizontal") {
    return [
      ...leafMetrics(node.a, widthFrac * r, heightFrac),
      ...leafMetrics(node.b, widthFrac * (1 - r), heightFrac),
    ];
  }
  return [
    ...leafMetrics(node.a, widthFrac, heightFrac * r),
    ...leafMetrics(node.b, widthFrac, heightFrac * (1 - r)),
  ];
}

// Picks the leaf with the largest rendered area and the split direction that
// halves its longer side, so the new pane lands where there's the most room.
// Returns null only when the tree is empty (impossible in normal use).
export function smartAddTarget(
  root: PaneNode,
  rootWidth: number,
  rootHeight: number,
): { paneId: string; direction: TerminalSplit["direction"] } | null {
  const metrics = leafMetrics(root);
  if (metrics.length === 0) return null;
  let bestPaneId = metrics[0].paneId;
  let bestW = metrics[0].widthFrac * rootWidth;
  let bestH = metrics[0].heightFrac * rootHeight;
  let bestArea = bestW * bestH;
  for (let i = 1; i < metrics.length; i++) {
    const m = metrics[i];
    const w = m.widthFrac * rootWidth;
    const h = m.heightFrac * rootHeight;
    const area = w * h;
    if (area > bestArea) {
      bestArea = area;
      bestPaneId = m.paneId;
      bestW = w;
      bestH = h;
    }
  }
  return {
    paneId: bestPaneId,
    direction: bestW >= bestH ? "horizontal" : "vertical",
  };
}
