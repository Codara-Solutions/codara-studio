import { TextIndexBuilder, locateOffset, type TextIndex } from "./text-index";

// DOM side of find: index a rendered document's text, paint matches with the
// CSS Custom Highlight API, and scroll one into view. Highlights never touch
// the DOM, so React keeps owning the markup and a highlight can't be torn
// out by a re-render.

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CAPTION", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE",
  "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "CANVAS",
  "IFRAME", "OBJECT", "VIDEO", "AUDIO",
]);
const SVG_NS = "http://www.w3.org/2000/svg";

/** Marks chrome inside a document root (a notes bar) that find must ignore. */
export const FIND_SKIP_ATTR = "data-find-skip";

function skipped(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName) || el.namespaceURI === SVG_NS) return true;
  if (el.hasAttribute(FIND_SKIP_ATTR) || el.getAttribute("aria-hidden") === "true") return true;
  return (el as HTMLElement).hidden === true;
}

interface Context {
  block: Element;
  pre: boolean;
}

export function indexDomText(root: Element): TextIndex<Text> {
  const builder = new TextIndexBuilder<Text>();
  const contexts = new Map<Element, Context>();
  const contextOf = (el: Element): Context => {
    const hit = contexts.get(el);
    if (hit) return hit;
    let context: Context;
    if (el === root || !el.parentElement) {
      context = { block: el, pre: el.tagName === "PRE" };
    } else {
      const parent = contextOf(el.parentElement);
      context = {
        block: BLOCK_TAGS.has(el.tagName) ? el : parent.block,
        pre: parent.pre || el.tagName === "PRE",
      };
    }
    contexts.set(el, context);
    return context;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      const el = node as Element;
      if (skipped(el)) return NodeFilter.FILTER_REJECT;
      return el.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType !== Node.TEXT_NODE) {
      builder.lineBreak();
      continue;
    }
    const parent = node.parentElement;
    if (!parent) continue;
    const context = contextOf(parent);
    builder.addText(node as Text, node.nodeValue ?? "", context.block, context.pre);
  }
  return builder.finish();
}

export function rangeForMatch<N extends Node>(
  index: TextIndex<N>,
  start: number,
  end: number,
): Range | null {
  const from = locateOffset(index, start, "start");
  const to = locateOffset(index, end, "end");
  if (!from || !to) return null;
  try {
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  } catch {
    return null;
  }
}

// One pair of named highlights for the whole window; each open find bar
// adds and removes only its own ranges, so two documents side by side (a
// split) can both show their matches.
export const FIND_MATCH_HIGHLIGHT = "codara-find-match";
export const FIND_CURRENT_HIGHLIGHT = "codara-find-current";

let registry: { match: Highlight; current: Highlight } | null | undefined;

function highlights(): { match: Highlight; current: Highlight } | null {
  if (registry !== undefined) return registry;
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") {
    registry = null;
    return registry;
  }
  const match = new Highlight();
  const current = new Highlight();
  current.priority = 1;
  CSS.highlights.set(FIND_MATCH_HIGHLIGHT, match);
  CSS.highlights.set(FIND_CURRENT_HIGHLIGHT, current);
  registry = { match, current };
  return registry;
}

/** One find bar's share of the window's highlights. */
export class FindHighlights {
  private ranges: Range[] = [];
  private currentRange: Range | null = null;

  setMatches(ranges: Range[]): void {
    const shared = highlights();
    if (shared) {
      for (const range of this.ranges) shared.match.delete(range);
      for (const range of ranges) shared.match.add(range);
    }
    this.ranges = ranges;
  }

  setCurrent(range: Range | null): void {
    const shared = highlights();
    if (shared) {
      if (this.currentRange) shared.current.delete(this.currentRange);
      if (range) shared.current.add(range);
    }
    this.currentRange = range;
  }

  clear(): void {
    this.setMatches([]);
    this.setCurrent(null);
  }
}

function scrollable(el: Element, axis: "x" | "y"): boolean {
  const style = getComputedStyle(el);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") return false;
  return axis === "y" ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
}

/** Opens closed <details> around a match so it has a box to scroll to. */
export function revealCollapsed(range: Range): void {
  let el: Element | null =
    range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  for (; el; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
  }
}

/**
 * Scroll every scroll container between the match and `outer` so the match
 * shows, centred on any axis it is cut off on: wide code blocks and tables
 * scroll sideways too. In `outer` the visible band starts `topInset` px down
 * (under the find bar or a sticky header) and `leftInset` px in (under a
 * sticky first column).
 */
export function scrollRangeIntoView(range: Range, outer: Element, topInset = 0, leftInset = 0): void {
  const rectOf = () => {
    const rects = range.getClientRects();
    return rects.length > 0 ? rects[0] : range.getBoundingClientRect();
  };
  const start =
    range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const margin = 24;
  for (let el: Element | null = start; el; el = el.parentElement) {
    const isOuter = el === outer;
    if (scrollable(el, "x")) {
      const rect = rectOf();
      const box = el.getBoundingClientRect();
      const inset = isOuter ? leftInset : 0;
      if (rect.left < box.left + inset + margin || rect.right > box.right - margin) {
        el.scrollLeft += rect.left + rect.width / 2 - (box.left + inset + (box.width - inset) / 2);
      }
    }
    if (scrollable(el, "y")) {
      const rect = rectOf();
      const box = el.getBoundingClientRect();
      const inset = isOuter ? topInset : 0;
      if (rect.top < box.top + inset + 8 || rect.bottom > box.bottom - 8) {
        const band = box.top + inset + (box.height - inset) / 2;
        el.scrollTop += rect.top + rect.height / 2 - band;
      }
    }
    if (isOuter) break;
  }
}

/** Text a selection inside `root` holds, for seeding the find query. */
export function selectionTextWithin(root: Element | null): string | null {
  if (!root) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  return selection.toString();
}

/** Leaves the document selection on a match, as a browser does on Escape. */
export function selectRange(range: Range | null): void {
  if (!range) return;
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Offset in `index` where the visible part of `scroller` starts. */
export function firstVisibleOffset(index: TextIndex<Text>, scroller: Element, topInset = 0): number {
  const top = scroller.getBoundingClientRect().top + topInset;
  const { nodes, starts } = index;
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const node = nodes[mid];
    const parent = node.parentElement;
    const rect = parent ? parent.getBoundingClientRect() : null;
    if (!rect || rect.bottom < top) lo = mid + 1;
    else hi = mid;
  }
  return lo < nodes.length ? starts[lo] : 0;
}
