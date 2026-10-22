// Flattens a document's text nodes into one searchable string while keeping
// a map back to the nodes, so a match found in the string becomes a DOM
// Range. Generic over the node type so the mapping is testable without a DOM.
//
// The flat string keeps every character at the same offset as in its node,
// which is what makes the mapping a binary search: outside preformatted
// blocks, tabs and line breaks (rendered as spaces) are written as spaces,
// and a "\n" separator is inserted between blocks, so a match never runs
// from one paragraph or table cell into the next.

export interface TextIndex<N> {
  text: string;
  nodes: N[];
  /** Flat offset of each node's first character. */
  starts: number[];
  /** Flat offset just past each node's last character. */
  ends: number[];
}

export class TextIndexBuilder<N> {
  private parts: string[] = [];
  private length = 0;
  private lastBlock: unknown = undefined;
  private atBreak = true;
  private readonly nodes: N[] = [];
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];

  addText(node: N, raw: string, block: unknown, preformatted: boolean): void {
    if (!raw) return;
    if (this.lastBlock !== undefined && block !== this.lastBlock) this.lineBreak();
    this.lastBlock = block;
    const text = preformatted ? raw : raw.replace(/[\t\n\r\f]/g, " ");
    this.nodes.push(node);
    this.starts.push(this.length);
    this.parts.push(text);
    this.length += text.length;
    this.ends.push(this.length);
    this.atBreak = false;
  }

  /** A hard break (a <br>, the end of a block). Never doubled. */
  lineBreak(): void {
    if (this.atBreak) return;
    this.parts.push("\n");
    this.length += 1;
    this.atBreak = true;
  }

  finish(): TextIndex<N> {
    return { text: this.parts.join(""), nodes: this.nodes, starts: this.starts, ends: this.ends };
  }
}

export interface NodePoint<N> {
  node: N;
  offset: number;
}

/**
 * The node and in-node offset of a flat offset. A match's start resolves to
 * the node it begins in; its end to the node it finishes in, so an end that
 * falls exactly on a node boundary stays in the earlier node. An offset on an
 * inserted separator moves to the nearest real character on that side.
 */
export function locateOffset<N>(
  index: TextIndex<N>,
  offset: number,
  edge: "start" | "end",
): NodePoint<N> | null {
  const { starts, ends, nodes } = index;
  if (nodes.length === 0) return null;
  if (edge === "start") {
    // First node whose end is past the offset.
    let lo = 0;
    let hi = nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ends[mid] <= offset) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= nodes.length) return { node: nodes[nodes.length - 1], offset: ends[nodes.length - 1] - starts[nodes.length - 1] };
    return { node: nodes[lo], offset: Math.max(0, offset - starts[lo]) };
  }
  // Last node whose start is before the offset.
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  const at = lo - 1;
  if (at < 0) return { node: nodes[0], offset: 0 };
  return { node: nodes[at], offset: Math.min(ends[at], offset) - starts[at] };
}
