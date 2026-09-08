import type { CoraWhiteboard, CoraWhiteboardNode } from "./types";
import { CORA_WHITEBOARD_NODE_DEFAULT_SIZES } from "./cora-whiteboard-file";

export interface WhiteboardIssue {
  code: string;
  severity: "error" | "warning";
  ids: string[];
  message: string;
}

export function whiteboardRect(node: CoraWhiteboardNode) {
  const size = CORA_WHITEBOARD_NODE_DEFAULT_SIZES[node.kind];
  return { x: node.x, y: node.y, width: node.width ?? size.width, height: node.height ?? size.height };
}

export function containsWhiteboardNode(group: CoraWhiteboardNode, node: CoraWhiteboardNode): boolean {
  const a = whiteboardRect(group);
  const b = whiteboardRect(node);
  return b.x >= a.x && b.y >= a.y + 40 && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
}

export function whiteboardIssues(board: CoraWhiteboard): WhiteboardIssue[] {
  const issues: WhiteboardIssue[] = [];
  let omitted = 0;
  let omittedErrors = 0;
  const cards = board.nodes.filter((node) => node.kind !== "group");
  const ids = new Set(board.nodes.map((node) => node.id));
  const linked = new Set(board.edges.flatMap((edge) => [edge.from, edge.to]));
  const issue = (code: string, severity: WhiteboardIssue["severity"], ids: string[], message: string) => {
    if (issues.length < 200) issues.push({ code, severity, ids, message });
    else { omitted += 1; if (severity === "error") omittedErrors += 1; }
  };
  if (!cards.length) issue("empty", "error", [], "The board has no explanatory cards.");
  for (let i = 0; i < board.nodes.length; i++) {
    const node = board.nodes[i];
    const a = whiteboardRect(node);
    for (const other of board.nodes.slice(i + 1)) {
      const b = whiteboardRect(other);
      if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <= 2 ||
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <= 2) continue;
      if (node.kind === "group" && containsWhiteboardNode(node, other)) continue;
      if (other.kind === "group" && containsWhiteboardNode(other, node)) continue;
      issue("overlap", "error", [node.id, other.id], `${node.title} overlaps ${other.title}. Separate cards or contain them fully inside a group.`);
    }
    if ((node.kind === "file" || node.kind === "symbol") && !node.sources?.length) {
      issue("missing-source", "warning", [node.id], `${node.title} has no source reference. Add repository path:line evidence.`);
    }
    if (cards.length > 1 && node.kind !== "group" && node.kind !== "note" && !linked.has(node.id)) {
      issue("disconnected", "warning", [node.id], `${node.title} has no connection. Explain its role or remove it from this view.`);
    }
    if (node.kind === "condition") {
      const branches = board.edges.filter((edge) => edge.from === node.id);
      if (branches.length < 2 || branches.some((edge) => !edge.label?.trim())) {
        issue("branches", "warning", [node.id], `${node.title} needs at least two labeled outcomes.`);
      }
    }
  }
  for (const edge of board.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) issue("missing-endpoint", "error", [edge.id], `Connection ${edge.id} references a missing card.`);
    if (edge.confidence === "confirmed" && !edge.sources?.length) issue("missing-source", "warning", [edge.id], `Confirmed connection ${edge.id} has no source evidence.`);
  }
  if (cards.length > 35) issue("density", "warning", [], "This overview has more than 35 cards. Prefer an overview plus focused detail views.");
  if (omitted) issues.push({ code: "more-issues", severity: omittedErrors ? "error" : "warning", ids: [], message: `${omitted} additional issues omitted. Fix the reported issues, then inspect again.` });
  return issues;
}
