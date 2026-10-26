// Tab and group links in chat answers (shared/tab-links.ts). GFM autolinks
// only web and mail addresses, and react-markdown blanks any other scheme, so
// a bare codara://tab/... an agent wrote would render as dead text.

import { defaultUrlTransform } from "react-markdown";
import { isTabLink, parseTabLink, TAB_LINK_TEXT_PATTERN } from "@shared/tab-links";

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

function splitText(value: string): MdNode[] {
  const parts: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(TAB_LINK_TEXT_PATTERN)) {
    const index = match.index ?? 0;
    if (!parseTabLink(match[0])) continue;
    if (index > last) parts.push({ type: "text", value: value.slice(last, index) });
    parts.push({ type: "link", url: match[0], children: [{ type: "text", value: match[0] }] });
    last = index + match[0].length;
  }
  if (parts.length === 0) return [{ type: "text", value }];
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}

function linkify(node: MdNode): void {
  // Code keeps its text in `value` and has no children, so it is left alone.
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("codara://")) next.push(...splitText(child.value));
    else {
      linkify(child);
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkTabLinks() {
  return (tree: MdNode) => linkify(tree);
}

export function chatUrlTransform(url: string): string {
  return isTabLink(url) ? url : defaultUrlTransform(url);
}
