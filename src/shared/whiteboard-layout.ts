import dagre from "@dagrejs/dagre";
import type { CoraWhiteboardEdge, CoraWhiteboardNode } from "./types";
import { containsWhiteboardNode, whiteboardRect } from "./whiteboard-quality";

/** Lay out modules independently before routing the graph between modules. */
export function arrangeWhiteboard(nodes: CoraWhiteboardNode[], edges: CoraWhiteboardEdge[]): CoraWhiteboardNode[] {
  const groups = nodes.filter((node) => node.kind === "group");
  const members = new Map<string, CoraWhiteboardNode[]>();
  const owner = new Map<string, string>();
  for (const card of nodes.filter((node) => node.kind !== "group")) {
    const group = groups.filter((group) => containsWhiteboardNode(group, card))
      .sort((a, b) => whiteboardRect(a).width * whiteboardRect(a).height - whiteboardRect(b).width * whiteboardRect(b).height)[0];
    if (group) {
      owner.set(card.id, group.id);
      members.set(group.id, [...(members.get(group.id) ?? []), card]);
    }
  }
  const positioned = new Map<string, CoraWhiteboardNode>();
  const layout = (items: CoraWhiteboardNode[], links: CoraWhiteboardEdge[]) => {
    const graph = new dagre.graphlib.Graph({ multigraph: true });
    graph.setGraph({ rankdir: "LR", ranksep: 120, nodesep: 64, marginx: 32, marginy: 32 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const item of items) graph.setNode(item.id, whiteboardRect(item));
    const ids = new Set(items.map((item) => item.id));
    for (const link of links) {
      if (link.from !== link.to && ids.has(link.from) && ids.has(link.to)) graph.setEdge(link.from, link.to, {}, link.id);
    }
    dagre.layout(graph);
    return items.map((item) => {
      const placed = graph.node(item.id);
      return { ...item, x: Math.round(placed.x - placed.width / 2), y: Math.round(placed.y - placed.height / 2) };
    });
  };
  const containers = groups.map((group) => {
    const children = members.get(group.id) ?? [];
    if (!children.length) return group;
    const arranged = layout(children, edges).map((node) => ({ ...node, y: node.y + 40 }));
    for (const node of arranged) positioned.set(node.id, node);
    return { ...group,
      width: Math.max(220, ...arranged.map((node) => node.x + whiteboardRect(node).width + 32)),
      height: Math.max(140, ...arranged.map((node) => node.y + whiteboardRect(node).height + 32)),
    };
  });
  const outer = [...containers, ...nodes.filter((node) => node.kind !== "group" && !owner.has(node.id))];
  const outerEdges = edges.map((edge) => ({ ...edge, from: owner.get(edge.from) ?? edge.from, to: owner.get(edge.to) ?? edge.to }));
  for (const node of layout(outer, outerEdges)) {
    positioned.set(node.id, node);
    for (const member of members.get(node.id) ?? []) {
      const inner = positioned.get(member.id)!;
      positioned.set(member.id, { ...inner, x: inner.x + node.x, y: inner.y + node.y });
    }
  }
  return nodes.map((node) => positioned.get(node.id) ?? node);
}
