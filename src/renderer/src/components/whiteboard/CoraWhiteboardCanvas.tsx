import { MOD_KEY, SHIFT_KEY, fmtShortcut } from "../../shortcuts/platform";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from "@xyflow/react";
import type {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  NodeProps,
  Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CoraWhiteboard,
  CoraWhiteboardEdge,
  CoraWhiteboardEdgeTone,
  CoraWhiteboardNode,
  CoraWhiteboardNodeKind,
} from "@shared/types";
import {
  CORA_WHITEBOARD_NODE_DEFAULT_SIZES,
  whiteboardNodeSizeLimits,
} from "@shared/cora-whiteboard-file";

interface BoardNodeData extends Record<string, unknown> {
  item: CoraWhiteboardNode;
  editable: boolean;
}

interface BoardEdgeData extends Record<string, unknown> {
  item: CoraWhiteboardEdge;
}

type BoardFlowNode = Node<BoardNodeData, "cora-card">;
type BoardFlowEdge = Edge<BoardEdgeData, "default">;

interface Props {
  board: CoraWhiteboard;
  editable?: boolean;
  onCommit?: (board: CoraWhiteboard) => void;
  onAskCora?: (prompt: string) => void;
}

const NODE_KINDS: CoraWhiteboardNodeKind[] = [
  "topic",
  "group",
  "file",
  "symbol",
  "flow",
  "condition",
  "decision",
  "risk",
  "note",
];

const NODE_PRESENTATION: Record<
  CoraWhiteboardNodeKind,
  { label: string; description: string; width: number; height: number }
> = {
  topic: {
    label: "Topic",
    description: "Central subject",
    ...CORA_WHITEBOARD_NODE_DEFAULT_SIZES.topic,
  },
  group: {
    label: "Group",
    description: "Container that clusters related cards",
    ...CORA_WHITEBOARD_NODE_DEFAULT_SIZES.group,
  },
  file: {
    label: "File",
    description: "Repository document or artifact",
    ...CORA_WHITEBOARD_NODE_DEFAULT_SIZES.file,
  },
  symbol: {
    label: "Symbol",
    description: "Code symbol or component",
    ...CORA_WHITEBOARD_NODE_DEFAULT_SIZES.symbol,
  },
  flow: {
    label: "Process",
    description: "Action, stage, or transformation",
    ...CORA_WHITEBOARD_NODE_DEFAULT_SIZES.flow,
  },
  condition: {
    label: "Condition",
    description: "Branch point with multiple outcomes",
    ...CORA_WHITEBOARD_NODE_DEFAULT_SIZES.condition,
  },
  decision: {
    label: "Decision",
    description: "Resolved choice or verdict",
    ...CORA_WHITEBOARD_NODE_DEFAULT_SIZES.decision,
  },
  risk: {
    label: "Risk",
    description: "Warning, blocker, or uncertainty",
    ...CORA_WHITEBOARD_NODE_DEFAULT_SIZES.risk,
  },
  note: {
    label: "Note",
    description: "Loose thought or annotation",
    ...CORA_WHITEBOARD_NODE_DEFAULT_SIZES.note,
  },
};

const EDGE_TONES: CoraWhiteboardEdgeTone[] = [
  "default",
  "accent",
  "success",
  "warning",
  "danger",
];

const NODE_TONE_LABELS: Record<CoraWhiteboardEdgeTone, string> = {
  default: "Default",
  accent: "Accent",
  success: "Green",
  warning: "Amber",
  danger: "Red",
};

// Kind colors are defined as CSS variables on .cora-board-editor so both
// themes can tune them in one place. An explicit node tone overrides the kind.
function nodeTone(kind: CoraWhiteboardNodeKind, tone?: CoraWhiteboardEdgeTone): string {
  if (tone && tone !== "default") return toneColor(tone);
  return `var(--wb-${kind})`;
}

function toneColor(tone?: CoraWhiteboardEdgeTone): string {
  if (tone === "success") return "var(--ok)";
  if (tone === "warning") return "var(--warn)";
  if (tone === "danger") return "var(--danger)";
  if (tone === "accent") return "var(--accent)";
  return "var(--muted)";
}

function edgeTone(tone?: CoraWhiteboardEdgeTone): string {
  return tone && tone !== "default" ? toneColor(tone) : "var(--wb-edge)";
}

// ── Kind icons ───────────────────────────────────────────────────────────────
// A small stroke-based set (14px viewBox) so cards read as product UI rather
// than dingbat glyphs. Rendered in the card header and the inspector picker.

function KindIcon({ kind, size = 12 }: { kind: CoraWhiteboardNodeKind; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 14 14",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "topic":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5.1" />
          <circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "group":
      return (
        <svg {...common}>
          <path d="M2 4.6V3.2A1.2 1.2 0 0 1 3.2 2h1.4M9.4 2h1.4A1.2 1.2 0 0 1 12 3.2v1.4M12 9.4v1.4a1.2 1.2 0 0 1-1.2 1.2H9.4M4.6 12H3.2A1.2 1.2 0 0 1 2 10.8V9.4" />
        </svg>
      );
    case "file":
      return (
        <svg {...common}>
          <path d="M3.4 1.8h4.8L10.6 4v8.2H3.4z" />
          <path d="M8 2v2.2h2.4" />
        </svg>
      );
    case "symbol":
      return (
        <svg {...common}>
          <path d="M5.2 3.4 2.2 7l3 3.6M8.8 3.4 11.8 7l-3 3.6" />
        </svg>
      );
    case "flow":
      return (
        <svg {...common}>
          <path d="M2.2 7h9M8.4 4.2 11.4 7l-3 2.8" />
        </svg>
      );
    case "condition":
      return (
        <svg {...common}>
          <path d="M7 1.9 12.1 7 7 12.1 1.9 7z" />
        </svg>
      );
    case "decision":
      return (
        <svg {...common}>
          <path d="M7 1.9 12.1 7 7 12.1 1.9 7z" />
          <path d="M5 7l1.4 1.5L9.2 5.6" />
        </svg>
      );
    case "risk":
      return (
        <svg {...common}>
          <path d="M7 2.2 12.6 11.6H1.4z" />
          <path d="M7 6v2.3" />
          <circle cx="7" cy="9.9" r=".7" fill="currentColor" stroke="none" />
        </svg>
      );
    case "note":
    default:
      return (
        <svg {...common}>
          <path d="M2.6 3.6h8.8M2.6 7h8.8M2.6 10.4h5.4" />
        </svg>
      );
  }
}

function nodeSize(item: CoraWhiteboardNode): { width: number; height: number } {
  const fallback = CORA_WHITEBOARD_NODE_DEFAULT_SIZES[item.kind] ?? CORA_WHITEBOARD_NODE_DEFAULT_SIZES.note;
  return {
    width: item.width ?? fallback.width,
    height: item.height ?? fallback.height,
  };
}

// Live rendered size of a flow node — same fallback chain as snapshot().
function liveNodeSize(node: BoardFlowNode): { width: number; height: number } {
  const fallback = nodeSize(node.data.item);
  return {
    width: Number(node.measured?.width ?? node.width ?? node.style?.width ?? fallback.width),
    height: Number(node.measured?.height ?? node.height ?? node.style?.height ?? fallback.height),
  };
}

function flowNodes(board: CoraWhiteboard, editable: boolean): BoardFlowNode[] {
  // Groups render first (and below) so member cards always sit on top of and
  // drag independently from their container.
  const ordered = [...board.nodes].sort((a, b) =>
    Number(a.kind === "group" ? 0 : 1) - Number(b.kind === "group" ? 0 : 1));
  return ordered.map((item) => {
    const size = nodeSize(item);
    return {
      id: item.id,
      type: "cora-card" as const,
      position: { x: item.x, y: item.y },
      data: { item, editable },
      zIndex: item.kind === "group" ? -1 : 0,
      style: { width: size.width, height: size.height },
    };
  });
}

// Pick the source/target sides per edge from the nodes' relative geometry so
// wires leave and enter on the facing sides instead of looping around cards.
function edgeHandles(
  edge: CoraWhiteboardEdge,
  byId: Map<string, CoraWhiteboardNode>,
): { sourceHandle: string; targetHandle: string } {
  const source = byId.get(edge.from);
  const target = byId.get(edge.to);
  if (!source || !target) return { sourceHandle: "h-right", targetHandle: "h-left" };
  const sourceSize = nodeSize(source);
  const targetSize = nodeSize(target);
  const dx = target.x + targetSize.width / 2 - (source.x + sourceSize.width / 2);
  const dy = target.y + targetSize.height / 2 - (source.y + sourceSize.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: "h-right", targetHandle: "h-left" }
      : { sourceHandle: "h-left", targetHandle: "h-right" };
  }
  return dy >= 0
    ? { sourceHandle: "h-bottom", targetHandle: "h-top" }
    : { sourceHandle: "h-top", targetHandle: "h-bottom" };
}

function flowEdges(board: CoraWhiteboard): BoardFlowEdge[] {
  const byId = new Map(board.nodes.map((node) => [node.id, node]));
  return board.edges.map((edge) => {
    const stroke = edgeTone(edge.tone);
    const handles = edgeHandles(edge, byId);
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      ...handles,
      type: "default" as const,
      label: edge.label,
      data: { item: edge },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
      style: {
        stroke,
        strokeWidth: edge.tone && edge.tone !== "default" ? 1.8 : 1.5,
        ...(edge.style === "dashed" ? { strokeDasharray: "6 5" } : {}),
      },
      labelStyle: {
        fill: "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 10.5,
        fontWeight: 550,
      },
      labelBgStyle: {
        fill: "var(--panel)",
        fillOpacity: 0.94,
      },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 5,
    };
  });
}

const HISTORY_LIMIT = 100;
// Matches WHITEBOARD_COORDINATE_LIMIT in run-store.ts.
const COORDINATE_LIMIT = 100_000;
// Match WHITEBOARD_MAX_NODES / WHITEBOARD_MAX_EDGES in run-store.ts.
const MAX_BOARD_NODES = 500;
const MAX_BOARD_EDGES = 1_000;
const PASTE_OFFSET = 24;
// Snap guides: pointer-space snap radius, and the node-count ceiling past
// which the per-frame candidate scan is skipped entirely.
const SNAP_DISTANCE = 6;
const SNAP_MAX_NODES = 150;

interface BoardClipboardPayload {
  nodes: CoraWhiteboardNode[];
  edges: CoraWhiteboardEdge[];
}

// In-app clipboard for board cards. Module-level so a copy survives board
// switches and canvas remounts; deliberately not the OS clipboard — the
// payload is internal flow state, not a useful text representation.
let boardClipboard: BoardClipboardPayload | null = null;

// Screen-space (flow-wrapper-local) guide segment drawn while a dragged node
// is snapped to a neighbor's edge or center.
interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function cleanText(value: string | undefined, maxLength: number): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cloneBoard(board: CoraWhiteboard): CoraWhiteboard {
  return {
    ...board,
    nodes: board.nodes.map((node) => ({ ...node })),
    edges: board.edges.map((edge) => ({ ...edge })),
  };
}

function boardSignature(board: CoraWhiteboard): string {
  // Order-insensitive: positions are explicit, so array order carries no
  // meaning — flowNodes sorts groups first, and a signature that noticed
  // would mint phantom "edited by you" commits on no-op blurs.
  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  return JSON.stringify({
    title: board.title,
    summary: board.summary,
    nodes: [...board.nodes].sort(byId),
    edges: [...board.edges].sort(byId),
  });
}

// ── Auto-arrange ─────────────────────────────────────────────────────────────
// A dependency-free layered layout: cards flow left-to-right by edge direction
// (Kahn layering, cycle-tolerant), rows within a column are ordered by the
// barycenter of their neighbors, and groups are re-fitted around the members
// they geometrically contained before the pass — so Cora's clustering intent
// survives a tidy-up.

const ARRANGE_COL_GAP = 150;
const ARRANGE_ROW_GAP = 56;
const GROUP_PAD = { top: 56, right: 28, bottom: 28, left: 28 };

function arrangePositions(
  items: CoraWhiteboardNode[],
  links: CoraWhiteboardEdge[],
): Map<string, { x: number; y: number; width?: number; height?: number }> {
  const result = new Map<string, { x: number; y: number; width?: number; height?: number }>();
  const cards = items.filter((item) => item.kind !== "group");
  const groups = items.filter((item) => item.kind === "group");
  if (cards.length === 0) return result;

  // Geometric membership before anything moves.
  const membership = new Map<string, string[]>();
  for (const group of groups) {
    const size = nodeSize(group);
    const inside = cards.filter((card) => {
      const cardSize = nodeSize(card);
      const cx = card.x + cardSize.width / 2;
      const cy = card.y + cardSize.height / 2;
      return cx >= group.x && cx <= group.x + size.width && cy >= group.y && cy <= group.y + size.height;
    });
    membership.set(group.id, inside.map((card) => card.id));
  }

  const cardIds = new Set(cards.map((card) => card.id));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const link of links) {
    if (!cardIds.has(link.from) || !cardIds.has(link.to) || link.from === link.to) continue;
    outgoing.set(link.from, [...(outgoing.get(link.from) ?? []), link.to]);
    incoming.set(link.to, [...(incoming.get(link.to) ?? []), link.from]);
  }

  // Kahn layering; nodes trapped in cycles fall back to one past their
  // deepest already-layered predecessor.
  const layer = new Map<string, number>();
  const degree = new Map(cards.map((card) => [card.id, incoming.get(card.id)?.length ?? 0]));
  const queue = cards.filter((card) => (degree.get(card.id) ?? 0) === 0).map((card) => card.id);
  queue.forEach((id) => layer.set(id, 0));
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of outgoing.get(current) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(current) ?? 0) + 1));
      const remaining = (degree.get(next) ?? 0) - 1;
      degree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  for (const card of cards) {
    if (layer.has(card.id)) continue;
    const preds = incoming.get(card.id) ?? [];
    const known = preds.map((id) => layer.get(id)).filter((value): value is number => value !== undefined);
    layer.set(card.id, known.length > 0 ? Math.max(...known) + 1 : 0);
  }

  const byId = new Map(cards.map((card) => [card.id, card]));
  const columns = new Map<number, string[]>();
  for (const card of cards) {
    const index = layer.get(card.id) ?? 0;
    columns.set(index, [...(columns.get(index) ?? []), card.id]);
  }
  const columnIndexes = [...columns.keys()].sort((a, b) => a - b);
  // Initial in-column order: current y keeps whatever intent the author had.
  for (const index of columnIndexes) {
    columns.get(index)!.sort((a, b) => (byId.get(a)?.y ?? 0) - (byId.get(b)?.y ?? 0));
  }
  // Two barycenter sweeps reduce crossings without a heavyweight solver.
  const rowOf = new Map<string, number>();
  const refreshRows = () => {
    for (const index of columnIndexes) {
      columns.get(index)!.forEach((id, row) => rowOf.set(id, row));
    }
  };
  refreshRows();
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const index of columnIndexes) {
      const ids = columns.get(index)!;
      const keyed = ids.map((id) => {
        const neighbors = [...(incoming.get(id) ?? []), ...(outgoing.get(id) ?? [])]
          .map((neighbor) => rowOf.get(neighbor))
          .filter((value): value is number => value !== undefined);
        const key = neighbors.length > 0
          ? neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length
          : rowOf.get(id) ?? 0;
        return { id, key };
      });
      keyed.sort((a, b) => a.key - b.key);
      columns.set(index, keyed.map((entry) => entry.id));
      refreshRows();
    }
  }

  let x = 0;
  for (const index of columnIndexes) {
    const ids = columns.get(index)!;
    const width = Math.max(...ids.map((id) => nodeSize(byId.get(id)!).width));
    const totalHeight = ids.reduce((sum, id) => sum + nodeSize(byId.get(id)!).height, 0)
      + ARRANGE_ROW_GAP * Math.max(0, ids.length - 1);
    let y = -totalHeight / 2;
    for (const id of ids) {
      const size = nodeSize(byId.get(id)!);
      result.set(id, { x: x + (width - size.width) / 2, y });
      y += size.height + ARRANGE_ROW_GAP;
    }
    x += width + ARRANGE_COL_GAP;
  }

  // Re-fit each group around where its members landed.
  for (const group of groups) {
    const memberIds = (membership.get(group.id) ?? []).filter((id) => result.has(id));
    if (memberIds.length === 0) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of memberIds) {
      const placed = result.get(id)!;
      const size = nodeSize(byId.get(id)!);
      minX = Math.min(minX, placed.x);
      minY = Math.min(minY, placed.y);
      maxX = Math.max(maxX, placed.x + size.width);
      maxY = Math.max(maxY, placed.y + size.height);
    }
    const groupLimits = whiteboardNodeSizeLimits("group");
    result.set(group.id, {
      x: minX - GROUP_PAD.left,
      y: minY - GROUP_PAD.top,
      width: Math.min(groupLimits.maxWidth,
        Math.round(maxX - minX + GROUP_PAD.left + GROUP_PAD.right)),
      height: Math.min(groupLimits.maxHeight,
        Math.round(maxY - minY + GROUP_PAD.top + GROUP_PAD.bottom)),
    });
  }
  return result;
}

// ── Node component ───────────────────────────────────────────────────────────

// One universal handle per side; ConnectionMode.Loose lets any of them start
// or finish a connection, and flowEdges assigns the facing sides per edge from
// node geometry so wires never loop around a card.
const HANDLES: { position: Position; id: string }[] = [
  { position: Position.Left, id: "h-left" },
  { position: Position.Top, id: "h-top" },
  { position: Position.Right, id: "h-right" },
  { position: Position.Bottom, id: "h-bottom" },
];

function BoardCard({ data, selected }: NodeProps<BoardFlowNode>) {
  const { item, editable } = data;
  const tone = nodeTone(item.kind, item.tone);
  const presentation = NODE_PRESENTATION[item.kind] ?? NODE_PRESENTATION.note;
  const limits = whiteboardNodeSizeLimits(item.kind);
  const isGroup = item.kind === "group";
  return (
    <article
      className={`cora-board-card kind-${item.kind}${selected ? " is-selected" : ""}`}
      style={{ "--board-tone": tone } as React.CSSProperties}
      data-whiteboard-node={item.id}
      data-node-kind={item.kind}
    >
      {editable && (
        <NodeResizer
          minWidth={limits.minWidth}
          minHeight={limits.minHeight}
          maxWidth={limits.maxWidth}
          maxHeight={limits.maxHeight}
          color={"var(--accent)"}
          lineStyle={{ borderWidth: 1 }}
          handleStyle={{ width: 7, height: 7, borderRadius: 2 }}
          isVisible={selected}
        />
      )}
      {HANDLES.map((handle) => (
        <Handle key={handle.id} type="source" position={handle.position} id={handle.id} />
      ))}
      <div className="cora-board-card__head">
        <span className="cora-board-card__icon">
          <KindIcon kind={item.kind} />
        </span>
        <span className="cora-board-card__kind">{presentation.label}</span>
      </div>
      <div className="cora-board-card__title">{item.title}</div>
      {!isGroup && item.body && <div className="cora-board-card__body">{item.body}</div>}
    </article>
  );
}

const NODE_TYPES = { "cora-card": BoardCard };

// ── Canvas ───────────────────────────────────────────────────────────────────

export default function CoraWhiteboardCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <WhiteboardCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

type ZoomBand = "near" | "mid" | "far";

function zoomBandFor(zoom: number): ZoomBand {
  if (zoom < 0.45) return "far";
  if (zoom < 0.75) return "mid";
  return "near";
}

function WhiteboardCanvasInner({
  board,
  editable = false,
  onCommit,
  onAskCora,
}: Props) {
  const [nodes, setNodes] = useState<BoardFlowNode[]>(() => flowNodes(board, editable));
  const [edges, setEdges] = useState<BoardFlowEdge[]>(() => flowEdges(board));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 });
  const [search, setSearch] = useState("");
  const [zoomBand, setZoomBand] = useState<ZoomBand>("near");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const boardRef = useRef(cloneBoard(board));
  const historyRef = useRef<{ past: CoraWhiteboard[]; future: CoraWhiteboard[] }>({
    past: [],
    future: [],
  });
  const { fitView, screenToFlowPosition, getViewport, setViewport } = useReactFlow();

  useEffect(() => {
    const current = boardRef.current;
    const incomingRevision = board.revision ?? 0;
    const currentRevision = current.revision ?? 0;
    const sameContent = boardSignature(board) === boardSignature(current);
    if (sameContent) {
      // Our own save echoing back: adopt the metadata without rebuilding the
      // flow state, so uncommitted inspector typing and selection survive.
      boardRef.current = cloneBoard(board);
      return;
    }
    // A lower revision that is user-edited and non-empty can only be a stale
    // echo of our own optimistic commits. Everything else — Cora edits, a
    // clear (the revision-0 empty fallback), a rebuilt board that restarts
    // its revision counter — is authoritative and must land.
    if (
      incomingRevision < currentRevision &&
      incomingRevision > 0 &&
      board.lastEditedBy === "user"
    ) return;
    if (board.lastEditedBy !== "user") {
      historyRef.current = { past: [], future: [] };
      setHistoryState({ undo: 0, redo: 0 });
    }
    boardRef.current = cloneBoard(board);
    const selectedNodeIds = new Set(
      nodesRef.current.filter((node) => node.selected).map((node) => node.id),
    );
    const selectedEdgeIds = new Set(
      edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id),
    );
    const nextNodes = flowNodes(board, editable).map((node) =>
      selectedNodeIds.has(node.id) ? { ...node, selected: true } : node);
    const nextEdges = flowEdges(board).map((edge) =>
      selectedEdgeIds.has(edge.id) ? { ...edge, selected: true } : edge);
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, [board.updatedAt, board.revision, editable]);

  const replaceNodes = useCallback((next: BoardFlowNode[]) => {
    nodesRef.current = next;
    setNodes(next);
  }, []);
  const replaceEdges = useCallback((next: BoardFlowEdge[]) => {
    edgesRef.current = next;
    setEdges(next);
  }, []);

  const snapshot = useCallback((
    nextNodes = nodesRef.current,
    nextEdges = edgesRef.current,
  ): CoraWhiteboard => {
    // Mirrors run-store's normalizeWhiteboardNode/Edge so a save can never be
    // rejected server-side and the persisted echo matches this board exactly
    // (a drifting echo would needlessly rebuild the canvas).
    const items = nextNodes.map((node) => {
      const item = node.data.item;
      const limits = whiteboardNodeSizeLimits(item.kind);
      const width = Number(node.measured?.width ?? node.width ?? node.style?.width ?? 240);
      const height = Number(node.measured?.height ?? node.height ?? node.style?.height ?? 124);
      return {
        ...item,
        title: cleanText(item.title, 120) || "Untitled",
        body: cleanText(item.body, 900) || undefined,
        x: clampNumber(Math.round(node.position.x), -COORDINATE_LIMIT, COORDINATE_LIMIT),
        y: clampNumber(Math.round(node.position.y), -COORDINATE_LIMIT, COORDINATE_LIMIT),
        width: clampNumber(Math.round(width), limits.minWidth, limits.maxWidth),
        height: clampNumber(Math.round(height), limits.minHeight, limits.maxHeight),
      };
    });
    const links: CoraWhiteboardEdge[] = nextEdges.map((edge) => {
      const item = edge.data?.item;
      const label = typeof edge.label === "string" ? edge.label : item?.label;
      return {
        id: edge.id,
        from: edge.source,
        to: edge.target,
        label: cleanText(label, 100) || undefined,
        tone: item?.tone,
        style: item?.style,
      };
    });
    return {
      ...boardRef.current,
      nodes: items,
      edges: links,
      revision: (boardRef.current.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
  }, []);

  const commit = useCallback((
    nextNodes = nodesRef.current,
    nextEdges = edgesRef.current,
  ) => {
    if (!editable || !onCommit) return;
    const previousBoard = cloneBoard(boardRef.current);
    const nextBoard = snapshot(nextNodes, nextEdges);
    if (boardSignature(previousBoard) === boardSignature(nextBoard)) return;
    const past = [...historyRef.current.past, previousBoard].slice(-HISTORY_LIMIT);
    historyRef.current = { past, future: [] };
    setHistoryState({ undo: past.length, redo: 0 });
    boardRef.current = nextBoard;
    onCommit(nextBoard);
  }, [editable, onCommit, snapshot]);

  const restoreBoard = useCallback((stored: CoraWhiteboard) => {
    if (!editable || !onCommit) return;
    const restored: CoraWhiteboard = {
      ...cloneBoard(stored),
      revision: (boardRef.current.revision ?? 0) + 1,
      lastEditedBy: "user",
      updatedAt: new Date().toISOString(),
    };
    boardRef.current = restored;
    replaceNodes(flowNodes(restored, editable));
    replaceEdges(flowEdges(restored));
    setSelectedNodeId((id) => id && restored.nodes.some((node) => node.id === id) ? id : null);
    setSelectedEdgeId((id) => id && restored.edges.some((edge) => edge.id === id) ? id : null);
    onCommit(restored);
  }, [editable, onCommit, replaceEdges, replaceNodes]);

  const undo = useCallback(() => {
    const previous = historyRef.current.past.at(-1);
    if (!previous) return;
    const past = historyRef.current.past.slice(0, -1);
    const future = [cloneBoard(boardRef.current), ...historyRef.current.future].slice(0, HISTORY_LIMIT);
    historyRef.current = { past, future };
    setHistoryState({ undo: past.length, redo: future.length });
    restoreBoard(previous);
  }, [restoreBoard]);

  const redo = useCallback(() => {
    const next = historyRef.current.future[0];
    if (!next) return;
    const past = [...historyRef.current.past, cloneBoard(boardRef.current)].slice(-HISTORY_LIMIT);
    const future = historyRef.current.future.slice(1);
    historyRef.current = { past, future };
    setHistoryState({ undo: past.length, redo: future.length });
    restoreBoard(next);
  }, [restoreBoard]);

  // Re-pick each edge's facing sides from live geometry. Handles are baked in
  // at build time, so after a drag or resize a wire could still leave the old
  // side and wrap around its cards.
  const recomputeEdgeHandles = useCallback((
    nextNodes: BoardFlowNode[] = nodesRef.current,
    nextEdges: BoardFlowEdge[] = edgesRef.current,
  ): BoardFlowEdge[] => {
    const boardShape: CoraWhiteboard = {
      ...boardRef.current,
      nodes: nextNodes.map((node) => ({
        ...node.data.item,
        x: node.position.x,
        y: node.position.y,
        width: Number(node.measured?.width ?? node.width ?? node.style?.width ?? node.data.item.width ?? 240),
        height: Number(node.measured?.height ?? node.height ?? node.style?.height ?? node.data.item.height ?? 124),
      })),
      edges: nextEdges
        .map((edge) => edge.data?.item)
        .filter((item): item is CoraWhiteboardEdge => Boolean(item)),
    };
    const selectedIds = new Set(nextEdges.filter((edge) => edge.selected).map((edge) => edge.id));
    return flowEdges(boardShape).map((edge) =>
      selectedIds.has(edge.id) ? { ...edge, selected: true } : edge);
  }, []);

  const commitWithFreshHandles = useCallback((nextNodes = nodesRef.current) => {
    const nextEdges = recomputeEdgeHandles(nextNodes, edgesRef.current);
    replaceEdges(nextEdges);
    commit(nextNodes, nextEdges);
  }, [commit, recomputeEdgeHandles, replaceEdges]);

  const onNodesChange = useCallback((changes: NodeChange<BoardFlowNode>[]) => {
    const next = applyNodeChanges(changes, nodesRef.current);
    replaceNodes(next);
    const resizeEnded = changes.some((change) =>
      change.type === "dimensions" && change.resizing === false);
    if (resizeEnded) commitWithFreshHandles(next);
  }, [commitWithFreshHandles, replaceNodes]);

  const onEdgesChange = useCallback((changes: EdgeChange<BoardFlowEdge>[]) => {
    replaceEdges(applyEdgeChanges(changes, edgesRef.current));
  }, [replaceEdges]);

  const connect = useCallback((connection: Connection) => {
    if (!editable || !connection.source || !connection.target) return;
    // Loose mode lets a drag end on the card it started from; a self-loop is
    // never a meaningful relation on this board.
    if (connection.source === connection.target) return;
    const id = `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const item: CoraWhiteboardEdge = {
      id,
      from: connection.source,
      to: connection.target,
      tone: "accent",
    };
    const next = addEdge(
      {
        ...connection,
        id,
        type: "default",
        data: { item },
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeTone("accent"), width: 16, height: 16 },
        style: { stroke: edgeTone("accent"), strokeWidth: 1.8 },
      },
      edgesRef.current,
    ) as BoardFlowEdge[];
    replaceEdges(next);
    commit(nodesRef.current, next);
  }, [commit, editable, replaceEdges]);

  const deleteNodes = useCallback((deleted: BoardFlowNode[]) => {
    if (!editable || deleted.length === 0) return;
    const ids = new Set(deleted.map((node) => node.id));
    const nextNodes = nodesRef.current.filter((node) => !ids.has(node.id));
    const nextEdges = edgesRef.current.filter((edge) =>
      !ids.has(edge.source) && !ids.has(edge.target));
    replaceNodes(nextNodes);
    replaceEdges(nextEdges);
    setSelectedNodeId(null);
    commit(nextNodes, nextEdges);
  }, [commit, editable, replaceEdges, replaceNodes]);

  const deleteEdges = useCallback((deleted: BoardFlowEdge[]) => {
    if (!editable || deleted.length === 0) return;
    const ids = new Set(deleted.map((edge) => edge.id));
    const next = edgesRef.current.filter((edge) => !ids.has(edge.id));
    replaceEdges(next);
    setSelectedEdgeId(null);
    commit(nodesRef.current, next);
  }, [commit, editable, replaceEdges]);

  // ── Clipboard ──────────────────────────────────────────────────────────────

  const selectionPayload = useCallback((): BoardClipboardPayload | null => {
    const selected = nodesRef.current.filter((node) => node.selected);
    if (selected.length === 0) return null;
    const ids = new Set(selected.map((node) => node.id));
    return {
      nodes: selected.map((node) => ({
        ...node.data.item,
        x: node.position.x,
        y: node.position.y,
        ...liveNodeSize(node),
      })),
      // Internal edges only: a wire to an unselected card has no meaning once
      // the copy lands somewhere else.
      edges: edgesRef.current
        .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        .map((edge) => edge.data?.item)
        .filter((item): item is CoraWhiteboardEdge => Boolean(item))
        .map((item) => ({ ...item })),
    };
  }, []);

  const copySelection = useCallback((): boolean => {
    const payload = selectionPayload();
    if (!payload) return false;
    boardClipboard = payload;
    return true;
  }, [selectionPayload]);

  const cutSelection = useCallback((): boolean => {
    if (!editable) return false;
    const payload = selectionPayload();
    if (!payload) return false;
    boardClipboard = payload;
    deleteNodes(nodesRef.current.filter((node) => node.selected));
    return true;
  }, [deleteNodes, editable, selectionPayload]);

  // Materialize copies with fresh ids at a +24/+24 offset, preserving relative
  // layout and internal wires, and move the selection onto them.
  const insertCopies = useCallback((
    items: CoraWhiteboardNode[],
    links: CoraWhiteboardEdge[],
  ): boolean => {
    if (!editable || items.length === 0) return false;
    // Stay inside the store's board limits — exceeding them would make every
    // subsequent save fail server-side.
    if (
      nodesRef.current.length + items.length > MAX_BOARD_NODES ||
      edgesRef.current.length + links.length > MAX_BOARD_EDGES
    ) return false;
    const stamp = Date.now().toString(36);
    const mintedIds = new Map<string, string>();
    for (const item of items) {
      mintedIds.set(item.id, `user-${stamp}-${Math.random().toString(36).slice(2, 7)}`);
    }
    const newItems = items.map((item) => ({
      ...item,
      id: mintedIds.get(item.id)!,
      x: item.x + PASTE_OFFSET,
      y: item.y + PASTE_OFFSET,
    }));
    const newLinks = links
      .filter((link) => mintedIds.has(link.from) && mintedIds.has(link.to))
      .map((link) => ({
        ...link,
        id: `link-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
        from: mintedIds.get(link.from)!,
        to: mintedIds.get(link.to)!,
      }));
    const shape = { ...boardRef.current, nodes: newItems, edges: newLinks };
    const addedNodes = flowNodes(shape, true).map((node) => ({ ...node, selected: true }));
    const addedEdges = flowEdges(shape);
    const nextNodes = [
      ...nodesRef.current.map((node) => (node.selected ? { ...node, selected: false } : node)),
      ...addedNodes,
    ];
    const nextEdges = [
      ...edgesRef.current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)),
      ...addedEdges,
    ];
    replaceNodes(nextNodes);
    replaceEdges(nextEdges);
    setSelectedEdgeId(null);
    commit(nextNodes, nextEdges);
    return true;
  }, [commit, editable, replaceEdges, replaceNodes]);

  const pasteClipboard = useCallback((): boolean => {
    const entry = boardClipboard;
    if (!entry || !insertCopies(entry.nodes, entry.edges)) return false;
    // Bump the stored positions so repeated pastes cascade instead of stacking.
    boardClipboard = {
      nodes: entry.nodes.map((item) => ({
        ...item,
        x: item.x + PASTE_OFFSET,
        y: item.y + PASTE_OFFSET,
      })),
      edges: entry.edges,
    };
    return true;
  }, [insertCopies]);

  const duplicateSelection = useCallback((): boolean => {
    const payload = selectionPayload();
    if (!payload) return false;
    return insertCopies(payload.nodes, payload.edges);
  }, [insertCopies, selectionPayload]);

  useEffect(() => {
    if (!editable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const target = event.target as HTMLElement | null;
      if (
        !root ||
        root.closest('[aria-hidden="true"]') ||
        getComputedStyle(root).visibility === "hidden" ||
        target?.matches("input, textarea, select") ||
        target?.isContentEditable ||
        event.defaultPrevented
      ) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      // Copy/cut defer to a live text selection so native copy still works.
      const textSelection = window.getSelection();
      const hasTextSelection = Boolean(textSelection && !textSelection.isCollapsed);
      const key = event.key.toLowerCase();
      // Clipboard chords require the board to actually hold focus (a click on
      // the canvas claims it) — the Explorer binds the same chords for file
      // operations and both listen window-wide.
      const engaged = root.contains(document.activeElement);
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (key === "z") {
        event.preventDefault();
        undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      } else if (event.shiftKey || event.altKey || !engaged) {
        return;
      } else if (key === "c") {
        if (!hasTextSelection && copySelection()) event.preventDefault();
      } else if (key === "x") {
        if (!hasTextSelection && cutSelection()) event.preventDefault();
      } else if (key === "v") {
        if (pasteClipboard()) event.preventDefault();
      } else if (key === "d") {
        if (duplicateSelection()) event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelection, cutSelection, duplicateSelection, editable, pasteClipboard, redo, undo]);

  const addNode = useCallback((kind: CoraWhiteboardNodeKind = "note") => {
    if (!editable || nodesRef.current.length >= MAX_BOARD_NODES) return;
    const presentation = NODE_PRESENTATION[kind];
    const rect = canvasRef.current?.getBoundingClientRect();
    const position = screenToFlowPosition({
      x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
    });
    const id = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const item: CoraWhiteboardNode = {
      id,
      kind,
      title: kind === "note" ? "New note" : `New ${kind}`,
      body: kind === "group" ? undefined : "Select this card to edit its details.",
      x: position.x - presentation.width / 2,
      y: position.y - presentation.height / 2,
      width: presentation.width,
      height: presentation.height,
    };
    const next = [...nodesRef.current, flowNodes({
      ...boardRef.current,
      nodes: [item],
      edges: [],
    }, true)[0]];
    replaceNodes(next);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    commit(next, edgesRef.current);
  }, [commit, editable, replaceNodes, screenToFlowPosition]);

  const addBranch = useCallback(() => {
    if (!editable || nodesRef.current.length + 3 > MAX_BOARD_NODES) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const center = screenToFlowPosition({
      x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
    });
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const conditionId = `condition-${stamp}`;
    const yesId = `case-yes-${stamp}`;
    const noId = `case-no-${stamp}`;
    const branchNodes: CoraWhiteboardNode[] = [
      {
        id: conditionId,
        kind: "condition",
        title: "If…?",
        body: "Describe the condition that chooses the next path.",
        x: center.x - 300,
        y: center.y - NODE_PRESENTATION.condition.height / 2,
        width: NODE_PRESENTATION.condition.width,
        height: NODE_PRESENTATION.condition.height,
      },
      {
        id: yesId,
        kind: "flow",
        title: "True path",
        body: "What happens when the condition is true?",
        x: center.x + 100,
        y: center.y - 160,
        width: NODE_PRESENTATION.flow.width,
        height: NODE_PRESENTATION.flow.height,
      },
      {
        id: noId,
        kind: "flow",
        title: "Otherwise",
        body: "What happens for every other case?",
        x: center.x + 100,
        y: center.y + 48,
        width: NODE_PRESENTATION.flow.width,
        height: NODE_PRESENTATION.flow.height,
      },
    ];
    const branchEdges: CoraWhiteboardEdge[] = [
      {
        id: `link-yes-${stamp}`,
        from: conditionId,
        to: yesId,
        label: "Yes",
        tone: "success",
      },
      {
        id: `link-no-${stamp}`,
        from: conditionId,
        to: noId,
        label: "No",
        tone: "warning",
      },
    ];
    const nextNodes = [
      ...nodesRef.current,
      ...flowNodes({ ...boardRef.current, nodes: branchNodes, edges: [] }, true),
    ];
    const nextEdges = [
      ...edgesRef.current,
      ...flowEdges({ ...boardRef.current, nodes: branchNodes, edges: branchEdges }),
    ];
    replaceNodes(nextNodes);
    replaceEdges(nextEdges);
    setSelectedNodeId(conditionId);
    setSelectedEdgeId(null);
    commit(nextNodes, nextEdges);
  }, [commit, editable, replaceEdges, replaceNodes, screenToFlowPosition]);

  const addOutcome = useCallback((sourceId: string) => {
    if (!editable || nodesRef.current.length >= MAX_BOARD_NODES) return;
    const source = nodesRef.current.find((node) => node.id === sourceId);
    if (!source) return;
    const outgoing = edgesRef.current.filter((edge) => edge.source === sourceId);
    const number = outgoing.length + 1;
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const id = `case-${stamp}`;
    const item: CoraWhiteboardNode = {
      id,
      kind: "flow",
      title: `Case ${number}`,
      body: "Describe this outcome.",
      x: source.position.x
        + Number(source.measured?.width ?? source.width ?? source.style?.width ?? 250) + 110,
      y: source.position.y + (number - 2) * 150,
      width: NODE_PRESENTATION.flow.width,
      height: NODE_PRESENTATION.flow.height,
    };
    const edgeItem: CoraWhiteboardEdge = {
      id: `link-${stamp}`,
      from: sourceId,
      to: id,
      label: `Case ${number}`,
      tone: "accent",
    };
    const nextNodes = [
      ...nodesRef.current,
      flowNodes({ ...boardRef.current, nodes: [item], edges: [] }, true)[0],
    ];
    const nextEdges = [
      ...edgesRef.current,
      flowEdges({ ...boardRef.current, nodes: [item, ...(source ? [source.data.item] : [])], edges: [edgeItem] })[0],
    ];
    replaceNodes(nextNodes);
    replaceEdges(nextEdges);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    commit(nextNodes, nextEdges);
  }, [commit, editable, replaceEdges, replaceNodes]);

  const arrange = useCallback(() => {
    if (!editable) return;
    const items = nodesRef.current.map((node) => ({
      ...node.data.item,
      x: node.position.x,
      y: node.position.y,
      width: Number(node.measured?.width ?? node.width ?? node.style?.width ?? undefined) || node.data.item.width,
      height: Number(node.measured?.height ?? node.height ?? node.style?.height ?? undefined) || node.data.item.height,
    }));
    const links = edgesRef.current
      .map((edge) => edge.data?.item)
      .filter((item): item is CoraWhiteboardEdge => Boolean(item));
    const placed = arrangePositions(items, links);
    if (placed.size === 0) return;
    const nextItems = items.map((item) => {
      const target = placed.get(item.id);
      if (!target) return item;
      return {
        ...item,
        x: Math.round(target.x),
        y: Math.round(target.y),
        ...(target.width !== undefined ? { width: target.width } : {}),
        ...(target.height !== undefined ? { height: target.height } : {}),
      };
    });
    const nextBoardShape = { ...boardRef.current, nodes: nextItems, edges: links };
    const nextNodes = flowNodes(nextBoardShape, true);
    const nextEdges = flowEdges(nextBoardShape);
    replaceNodes(nextNodes);
    replaceEdges(nextEdges);
    commit(nextNodes, nextEdges);
    // Fit after React Flow has re-measured the moved nodes — a bare rAF can
    // fire between commit and measure and frame the stale extent.
    window.setTimeout(() => {
      void fitView({ padding: 0.16, duration: 320 });
    }, 90);
  }, [commit, editable, fitView, replaceEdges, replaceNodes]);

  const updateNode = useCallback((id: string, patch: Partial<CoraWhiteboardNode>, persist = false) => {
    const next = nodesRef.current.map((node) =>
      node.id === id
        ? {
            ...node,
            measured: {
              ...node.measured,
              ...(patch.width === undefined ? {} : { width: patch.width }),
              ...(patch.height === undefined ? {} : { height: patch.height }),
            },
            style: {
              ...node.style,
              ...(patch.width === undefined ? {} : { width: patch.width }),
              ...(patch.height === undefined ? {} : { height: patch.height }),
            },
            zIndex: (patch.kind ?? node.data.item.kind) === "group" ? -1 : 0,
            data: { ...node.data, item: { ...node.data.item, ...patch } },
          }
        : node);
    replaceNodes(next);
    if (persist) commit(next, edgesRef.current);
  }, [commit, replaceNodes]);

  const updateEdge = useCallback((id: string, patch: Partial<CoraWhiteboardEdge>, persist = false) => {
    const boardShape = {
      ...boardRef.current,
      nodes: nodesRef.current.map((node) => ({
        ...node.data.item,
        x: node.position.x,
        y: node.position.y,
      })),
    };
    const next = edgesRef.current.map((edge) => {
      if (edge.id !== id) return edge;
      const item: CoraWhiteboardEdge = {
        ...(edge.data?.item ?? {
          id: edge.id,
          from: edge.source,
          to: edge.target,
        }),
        ...patch,
      };
      return flowEdges({ ...boardShape, edges: [item] })[0];
    });
    replaceEdges(next);
    if (persist) commit(nodesRef.current, next);
  }, [commit, replaceEdges]);

  // ── Multi-selection: align + distribute ────────────────────────────────────

  const alignSelection = useCallback((
    side: "left" | "center" | "right" | "top" | "middle" | "bottom",
  ) => {
    if (!editable) return;
    const selected = nodesRef.current.filter((node) => node.selected);
    if (selected.length < 2) return;
    const boxes = selected.map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      ...liveNodeSize(node),
    }));
    const minX = Math.min(...boxes.map((box) => box.x));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxY = Math.max(...boxes.map((box) => box.y + box.height));
    const placed = new Map<string, { x: number; y: number }>();
    for (const box of boxes) {
      let { x, y } = box;
      if (side === "left") x = minX;
      else if (side === "center") x = (minX + maxX - box.width) / 2;
      else if (side === "right") x = maxX - box.width;
      else if (side === "top") y = minY;
      else if (side === "middle") y = (minY + maxY - box.height) / 2;
      else y = maxY - box.height;
      placed.set(box.id, { x, y });
    }
    const next = nodesRef.current.map((node) => {
      const position = placed.get(node.id);
      return position ? { ...node, position } : node;
    });
    replaceNodes(next);
    commitWithFreshHandles(next);
  }, [commitWithFreshHandles, editable, replaceNodes]);

  // Equal gaps between cards; the outermost two stay put.
  const distributeSelection = useCallback((axis: "x" | "y") => {
    if (!editable) return;
    const selected = nodesRef.current.filter((node) => node.selected);
    if (selected.length < 3) return;
    const boxes = selected.map((node) => {
      const size = liveNodeSize(node);
      return {
        id: node.id,
        start: axis === "x" ? node.position.x : node.position.y,
        extent: axis === "x" ? size.width : size.height,
      };
    });
    boxes.sort((a, b) => a.start + a.extent / 2 - (b.start + b.extent / 2));
    const min = Math.min(...boxes.map((box) => box.start));
    const max = Math.max(...boxes.map((box) => box.start + box.extent));
    const gap = (max - min - boxes.reduce((sum, box) => sum + box.extent, 0))
      / (boxes.length - 1);
    let cursor = min;
    const placed = new Map<string, number>();
    for (const box of boxes) {
      placed.set(box.id, cursor);
      cursor += box.extent + gap;
    }
    const next = nodesRef.current.map((node) => {
      const start = placed.get(node.id);
      if (start === undefined) return node;
      return {
        ...node,
        position: axis === "x"
          ? { x: start, y: node.position.y }
          : { x: node.position.x, y: start },
      };
    });
    replaceNodes(next);
    commitWithFreshHandles(next);
  }, [commitWithFreshHandles, editable, replaceNodes]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId)?.data?.item ?? null;
  const multiSelectedNodes = useMemo(() => nodes.filter((node) => node.selected), [nodes]);

  // Keep the click-tracked id in step with flag-based (rubber-band/Ctrl-click)
  // selection: 2+ flagged cards swap the single-card inspector for the
  // selection toolbar, and lassoing exactly one card opens its inspector just
  // like a click would.
  useEffect(() => {
    if (multiSelectedNodes.length >= 2) {
      if (selectedNodeId !== null) setSelectedNodeId(null);
      if (selectedEdgeId !== null) setSelectedEdgeId(null);
    } else if (multiSelectedNodes.length === 1 && selectedNodeId !== multiSelectedNodes[0].id) {
      setSelectedNodeId(multiSelectedNodes[0].id);
    }
  }, [multiSelectedNodes, selectedEdgeId, selectedNodeId]);

  // Focus + search emphasis: with a selection, unrelated cards and wires step
  // back; with a search query, only matches keep full presence.
  const query = search.trim().toLowerCase();
  const neighborIds = useMemo(() => {
    if (!selectedNodeId || query) return null;
    const set = new Set([selectedNodeId]);
    for (const edge of edges) {
      if (edge.source === selectedNodeId) set.add(edge.target);
      if (edge.target === selectedNodeId) set.add(edge.source);
    }
    return set;
  }, [selectedNodeId, edges, query]);

  const displayNodes = useMemo(() => {
    if (!query && !neighborIds) return nodes;
    return nodes.map((node) => {
      let className: string | undefined;
      if (query) {
        const item = node.data.item;
        const hit = item.title.toLowerCase().includes(query)
          || (item.body ?? "").toLowerCase().includes(query);
        className = hit ? "is-hit" : "is-dim";
      } else if (neighborIds && !neighborIds.has(node.id) && node.data.item.kind !== "group") {
        className = "is-dim";
      }
      return className ? { ...node, className } : node;
    });
  }, [nodes, neighborIds, query]);

  const displayEdges = useMemo(() => {
    if (!query && !neighborIds) return edges;
    return edges.map((edge) => {
      let className: string | undefined;
      if (query) {
        className = "is-dim";
      } else if (neighborIds) {
        className = edge.source === selectedNodeId || edge.target === selectedNodeId
          ? "is-related"
          : "is-dim";
      }
      return className ? { ...edge, className } : edge;
    });
  }, [edges, neighborIds, query, selectedNodeId]);

  const matchCount = useMemo(() => {
    if (!query) return null;
    return nodes.filter((node) => {
      const item = node.data.item;
      return item.title.toLowerCase().includes(query)
        || (item.body ?? "").toLowerCase().includes(query);
    }).length;
  }, [nodes, query]);

  const handleMove = useCallback((_event: unknown, viewport: Viewport) => {
    const band = zoomBandFor(viewport.zoom);
    setZoomBand((current) => (current === band ? current : band));
  }, []);

  // Hold-to-pan (Figma/Excalidraw style): while Ctrl or Space is held,
  // dragging anywhere — including over cards — moves the view, never the
  // cards. Space stays available for typing inside inspector fields.
  const [panKeyHeld, setPanKeyHeld] = useState(false);
  const panSessionRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewport: Viewport;
  } | null>(null);
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return Boolean(
        element && (element.matches?.("input, textarea, select") || element.isContentEditable),
      );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control" || (event.key === " " && !isTyping(event.target))) {
        setPanKeyHeld(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === " ") setPanKeyHeld(false);
    };
    const onWindowBlur = () => setPanKeyHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  // ── Snap alignment guides ──────────────────────────────────────────────────
  // While dragging, the node under the pointer magnetizes to nearby edges and
  // centers of the other cards; matching guide lines render in an overlay.

  const [guides, setGuides] = useState<GuideLine[]>([]);
  const snapRef = useRef<{ positions: Map<string, { x: number; y: number }> } | null>(null);

  const clearSnap = useCallback(() => {
    snapRef.current = null;
    setGuides((current) => (current.length === 0 ? current : []));
  }, []);

  const handleNodeDrag = useCallback((
    _event: MouseEvent | TouchEvent,
    node: BoardFlowNode,
    draggedNodes: BoardFlowNode[],
  ) => {
    if (!editable || panKeyHeld || nodesRef.current.length > SNAP_MAX_NODES) {
      clearSnap();
      return;
    }
    const dragged = draggedNodes.length > 0 ? draggedNodes : [node];
    const draggedIds = new Set(dragged.map((entry) => entry.id));
    const size = liveNodeSize(node);
    const left = node.position.x;
    const top = node.position.y;
    const xEdges = [left, left + size.width / 2, left + size.width];
    const yEdges = [top, top + size.height / 2, top + size.height];
    const { x: viewX, y: viewY, zoom } = getViewport();
    // Constant feel on screen: the radius grows in flow units as you zoom out.
    const threshold = SNAP_DISTANCE / Math.max(zoom, 0.05);
    type Candidate = { delta: number; at: number; from: number; to: number };
    let bestX: Candidate | null = null;
    let bestY: Candidate | null = null;
    for (const other of nodesRef.current) {
      if (draggedIds.has(other.id)) continue;
      const otherSize = liveNodeSize(other);
      const otherLeft = other.position.x;
      const otherTop = other.position.y;
      for (const at of [otherLeft, otherLeft + otherSize.width / 2, otherLeft + otherSize.width]) {
        for (const edge of xEdges) {
          const delta = at - edge;
          if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
            bestX = {
              delta,
              at,
              from: Math.min(top, otherTop),
              to: Math.max(top + size.height, otherTop + otherSize.height),
            };
          }
        }
      }
      for (const at of [otherTop, otherTop + otherSize.height / 2, otherTop + otherSize.height]) {
        for (const edge of yEdges) {
          const delta = at - edge;
          if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
            bestY = {
              delta,
              at,
              from: Math.min(left, otherLeft),
              to: Math.max(left + size.width, otherLeft + otherSize.width),
            };
          }
        }
      }
    }
    if (!bestX && !bestY) {
      clearSnap();
      return;
    }
    const dx = bestX?.delta ?? 0;
    const dy = bestY?.delta ?? 0;
    const positions = new Map<string, { x: number; y: number }>();
    for (const entry of dragged) {
      positions.set(entry.id, { x: entry.position.x + dx, y: entry.position.y + dy });
    }
    snapRef.current = { positions };
    replaceNodes(nodesRef.current.map((entry) => {
      const snapped = positions.get(entry.id);
      return snapped ? { ...entry, position: snapped } : entry;
    }));
    const nextGuides: GuideLine[] = [];
    if (bestX) {
      const x = bestX.at * zoom + viewX;
      nextGuides.push({ x1: x, y1: bestX.from * zoom + viewY, x2: x, y2: bestX.to * zoom + viewY });
    }
    if (bestY) {
      const y = bestY.at * zoom + viewY;
      nextGuides.push({ x1: bestY.from * zoom + viewX, y1: y, x2: bestY.to * zoom + viewX, y2: y });
    }
    setGuides(nextGuides);
  }, [clearSnap, editable, getViewport, panKeyHeld, replaceNodes]);

  const finishNodeDrag = useCallback(() => {
    const snap = snapRef.current;
    clearSnap();
    if (!snap) {
      commitWithFreshHandles();
      return;
    }
    // React Flow's drag-stop dispatch restores the raw pointer position, which
    // would undo the visible snap right at release — re-assert it so what the
    // user saw is what persists.
    const next = nodesRef.current.map((entry) => {
      const snapped = snap.positions.get(entry.id);
      return snapped ? { ...entry, position: snapped } : entry;
    });
    replaceNodes(next);
    commitWithFreshHandles(next);
  }, [clearSnap, commitWithFreshHandles, replaceNodes]);

  // Guides normally clear in finishNodeDrag, but React Flow skips the stop
  // callback when it aborts a drag (multitouch, node deleted mid-drag). Sweep
  // on release: d3's capture-phase mouseup runs the stop path first, so this
  // bubble-phase listener only ever catches the aborted cases.
  useEffect(() => {
    if (!editable) return;
    window.addEventListener("mouseup", clearSnap);
    window.addEventListener("blur", clearSnap);
    return () => {
      window.removeEventListener("mouseup", clearSnap);
      window.removeEventListener("blur", clearSnap);
    };
  }, [clearSnap, editable]);

  return (
    <div
      ref={rootRef}
      className={`cora-board-editor${editable ? "" : " is-readonly"}${panKeyHeld ? " is-pan-mode" : ""}`}
      data-zoom={zoomBand}
      data-testid="cora-whiteboard-canvas"
      // Clicking the board claims keyboard engagement — the clipboard chords
      // only act while focus is inside the canvas.
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, select, [contenteditable=\"true\"]")) return;
        if (!rootRef.current?.contains(document.activeElement)) {
          rootRef.current?.focus({ preventScroll: true });
        }
        // Hold-to-pan must win no matter what sits under the cursor: a card,
        // a resize handle, the minimap. React Flow's own pan filter refuses
        // drags that start on nodes, so the pan is driven manually here —
        // stopping propagation keeps every deeper drag/select handler out.
        if (
          panKeyHeld &&
          event.button === 0 &&
          target?.closest(".cora-board-editor__flow")
        ) {
          event.preventDefault();
          event.stopPropagation();
          rootRef.current?.setPointerCapture(event.pointerId);
          panSessionRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startViewport: getViewport(),
          };
        }
      }}
      onPointerMoveCapture={(event) => {
        const session = panSessionRef.current;
        if (!session || session.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        void setViewport({
          x: session.startViewport.x + (event.clientX - session.startClientX),
          y: session.startViewport.y + (event.clientY - session.startClientY),
          zoom: session.startViewport.zoom,
        });
      }}
      onPointerUpCapture={(event) => {
        const session = panSessionRef.current;
        if (!session || session.pointerId !== event.pointerId) return;
        event.stopPropagation();
        if (rootRef.current?.hasPointerCapture(event.pointerId)) {
          rootRef.current.releasePointerCapture(event.pointerId);
        }
        panSessionRef.current = null;
      }}
      onPointerCancelCapture={(event) => {
        if (panSessionRef.current?.pointerId !== event.pointerId) return;
        panSessionRef.current = null;
      }}
    >
      <div className="cora-board-editor__toolbar">
        {editable && (
          <>
            <button type="button" onClick={() => addNode("note")} title="Add a new card" aria-label="Add card">
              <ToolbarIcon path="M7 2.8v8.4M2.8 7h8.4" />
              <span className="cora-board-editor__btn-label">Add card</span>
            </button>
            <button type="button" onClick={() => addNode("group")} title="Add a group container that clusters related cards" aria-label="Group">
              <KindIcon kind="group" size={12} />
              <span className="cora-board-editor__btn-label">Group</span>
            </button>
            <button type="button" onClick={addBranch} title="Add an if/case branch with two outcomes" aria-label="Branch">
              <KindIcon kind="condition" size={12} />
              <span className="cora-board-editor__btn-label">Branch</span>
            </button>
            <span className="cora-board-editor__separator" />
            <button
              type="button"
              onClick={arrange}
              title="Automatically arrange the board left-to-right"
              aria-label="Arrange"
            >
              <ToolbarIcon path="M2.6 3.6h3.4v3.4H2.6zM8 7h3.4v3.4H8zM6 5.3h2M7 5.3v3.4" />
              <span className="cora-board-editor__btn-label">Arrange</span>
            </button>
            <span className="cora-board-editor__separator" />
            <button
              type="button"
              onClick={undo}
              disabled={historyState.undo === 0}
              title={`Undo (${fmtShortcut(MOD_KEY, "Z")})`}
              aria-label="Undo whiteboard change"
            >
              <ToolbarIcon path="M5.4 3.2 2.6 6l2.8 2.8M2.9 6h5.2a3.2 3.2 0 0 1 0 6.4H6" />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={historyState.redo === 0}
              title={`Redo (${fmtShortcut(MOD_KEY, SHIFT_KEY, "Z")})`}
              aria-label="Redo whiteboard change"
            >
              <ToolbarIcon path="M8.6 3.2 11.4 6 8.6 8.8M11.1 6H5.9a3.2 3.2 0 0 0 0 6.4H8" />
            </button>
            <span className="cora-board-editor__separator" />
          </>
        )}
        <div className="cora-board-editor__search" role="search">
          <ToolbarIcon path="M6.2 10a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6zM9 9l2.8 2.8" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearch("");
            }}
            placeholder="Find on board"
            aria-label="Find on board"
          />
          {query && (
            <span className="cora-board-editor__search-count">
              {matchCount}
            </span>
          )}
          {query && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear board search"
            >
              ×
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => void fitView({ padding: 0.18, duration: 300 })}
          title="Fit the whole board in view"
          aria-label="Fit board"
        >
          <ToolbarIcon path="M2 5V2.6h2.4M12 5V2.6H9.6M2 9v2.4h2.4M12 9v2.4H9.6" />
          <span className="cora-board-editor__btn-label">Fit board</span>
        </button>
        {onAskCora && (
          <button
            type="button"
            onClick={() => onAskCora(
              "Read the current whiteboard, including every manual edit I made, and explain what changed or improve it without overwriting my choices.",
            )}
            title="Ask Cora about this board in chat"
            aria-label="Ask Cora"
          >
            <ToolbarIcon path="M7 1.8 8.3 5.7 12.2 7 8.3 8.3 7 12.2 5.7 8.3 1.8 7 5.7 5.7z" />
            <span className="cora-board-editor__btn-label">Ask Cora</span>
          </button>
        )}
      </div>

      <div ref={canvasRef} className="cora-board-editor__flow">
        <ReactFlow<BoardFlowNode, BoardFlowEdge>
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={editable ? onNodesChange : undefined}
          onEdgesChange={editable ? onEdgesChange : undefined}
          onNodeDrag={editable ? handleNodeDrag : undefined}
          onNodeDragStop={editable ? finishNodeDrag : undefined}
          onSelectionDragStop={editable ? finishNodeDrag : undefined}
          onConnect={editable ? connect : undefined}
          onNodesDelete={editable ? deleteNodes : undefined}
          onEdgesDelete={editable ? deleteEdges : undefined}
          onMove={handleMove}
          onNodeClick={(_, node) => {
            setSelectedNodeId(node.id);
            setSelectedEdgeId(null);
          }}
          onEdgeClick={(_, edge) => {
            setSelectedEdgeId(edge.id);
            setSelectedNodeId(null);
          }}
          onPaneClick={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
          }}
          nodesDraggable={editable && !panKeyHeld}
          nodesConnectable={editable && !panKeyHeld}
          elementsSelectable
          panOnDrag
          panOnScroll={false}
          zoomOnScroll
          zoomOnPinch
          minZoom={0.12}
          maxZoom={2.5}
          connectionMode={ConnectionMode.Loose}
          elevateNodesOnSelect={false}
          // Shift adds to the selection (and draws the rubber band); Ctrl is
          // reserved for hold-to-pan and must not double as a selection key.
          multiSelectionKeyCode="Shift"
          deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          connectionLineStyle={{ stroke: "var(--accent)", strokeWidth: 1.6 }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1}
            color="color-mix(in oklab, var(--ink) 14%, transparent)"
          />
          <MiniMap<BoardFlowNode>
            pannable
            zoomable
            style={{ width: 164, height: 104 }}
            nodeColor={(node) =>
              `color-mix(in oklab, ${nodeTone(node.data.item.kind, node.data.item.tone)} 52%, var(--panel-3))`}
            nodeStrokeColor="transparent"
            nodeBorderRadius={3}
            maskColor="color-mix(in oklab, var(--bg) 72%, transparent)"
            maskStrokeColor="var(--accent)"
            maskStrokeWidth={1}
            offsetScale={8}
          />
          <Controls showInteractive={false} />
        </ReactFlow>
        {guides.length > 0 && (
          <svg className="cora-board-guides" aria-hidden>
            {guides.map((line, index) => (
              <line key={index} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
            ))}
          </svg>
        )}
      </div>

      {nodes.length === 0 && (
        <div className="cora-board-editor__empty">
          <strong>Blank whiteboard</strong>
          <span>Add a card, or ask Cora to sketch the picture for you.</span>
          {editable && <button type="button" onClick={() => addNode("topic")}>Create first card</button>}
        </div>
      )}

      {editable && multiSelectedNodes.length >= 2 && (
        <aside className="cora-board-selection" aria-label="Whiteboard selection actions">
          <span className="cora-board-selection__count">
            {multiSelectedNodes.length} selected
          </span>
          <span className="cora-board-editor__separator" />
          <button type="button" onClick={() => alignSelection("left")} title="Align left" aria-label="Align left">
            <ToolbarIcon path="M2.6 2.2v9.6M4.9 5h6.5M4.9 9h4.3" />
          </button>
          <button type="button" onClick={() => alignSelection("center")} title="Align center" aria-label="Align center">
            <ToolbarIcon path="M7 2.2v9.6M3.2 5h7.6M4.5 9h5" />
          </button>
          <button type="button" onClick={() => alignSelection("right")} title="Align right" aria-label="Align right">
            <ToolbarIcon path="M11.4 2.2v9.6M2.9 5h6.5M6.2 9h4.3" />
          </button>
          <span className="cora-board-editor__separator" />
          <button type="button" onClick={() => alignSelection("top")} title="Align top" aria-label="Align top">
            <ToolbarIcon path="M2.2 2.6h9.6M5 4.9v6.5M9 4.9v4.3" />
          </button>
          <button type="button" onClick={() => alignSelection("middle")} title="Align middle" aria-label="Align middle">
            <ToolbarIcon path="M2.2 7h9.6M5 3.2v7.6M9 4.5v5" />
          </button>
          <button type="button" onClick={() => alignSelection("bottom")} title="Align bottom" aria-label="Align bottom">
            <ToolbarIcon path="M2.2 11.4h9.6M5 2.9v6.5M9 6.2v4.3" />
          </button>
          <span className="cora-board-editor__separator" />
          <button
            type="button"
            onClick={() => distributeSelection("x")}
            disabled={multiSelectedNodes.length < 3}
            title="Distribute horizontally"
            aria-label="Distribute horizontally"
          >
            <ToolbarIcon path="M2.4 2.6v8.8M11.6 2.6v8.8M5.7 4.9h2.6v4.2H5.7z" />
          </button>
          <button
            type="button"
            onClick={() => distributeSelection("y")}
            disabled={multiSelectedNodes.length < 3}
            title="Distribute vertically"
            aria-label="Distribute vertically"
          >
            <ToolbarIcon path="M2.6 2.4h8.8M2.6 11.6h8.8M4.9 5.7h4.2v2.6H4.9z" />
          </button>
        </aside>
      )}

      {editable && multiSelectedNodes.length < 2 && selectedNode && (
        <aside className="cora-board-inspector" aria-label="Whiteboard card inspector">
          <InspectorHeader
            label="Card"
            onDelete={() => deleteNodes([selectedNode])}
            onClose={() => setSelectedNodeId(null)}
          />
          <div className="cora-board-kind-field">
            <span>Type</span>
            <div
              className="cora-board-kind-picker"
              role="radiogroup"
              aria-label="Card type"
            >
              {NODE_KINDS.map((kind) => {
                const presentation = NODE_PRESENTATION[kind];
                const active = selectedNode.data.item.kind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? "is-active" : undefined}
                    title={presentation.description}
                    onClick={() => {
                      if (active) return;
                      const changingGroupness =
                        (kind === "group") !== (selectedNode.data.item.kind === "group");
                      updateNode(selectedNode.id, {
                        kind,
                        ...(changingGroupness
                          ? { width: presentation.width, height: presentation.height }
                          : {}),
                      }, true);
                    }}
                  >
                    <i className={`kind-${kind}`} aria-hidden>
                      <KindIcon kind={kind} size={12} />
                    </i>
                    <span>{presentation.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <label>
            <span>Title</span>
            <input
              value={selectedNode.data.item.title}
              maxLength={120}
              onChange={(event) => updateNode(selectedNode.id, { title: event.target.value })}
              onBlur={() => {
                const trimmed = selectedNode.data.item.title.trim();
                if (trimmed !== selectedNode.data.item.title || !trimmed) {
                  updateNode(selectedNode.id, { title: trimmed || "Untitled" });
                }
                commit();
              }}
            />
          </label>
          <label>
            <span>Details</span>
            <textarea
              value={selectedNode.data.item.body ?? ""}
              maxLength={900}
              onChange={(event) => updateNode(selectedNode.id, { body: event.target.value })}
              onBlur={() => commit()}
              rows={5}
            />
          </label>
          <div className="cora-board-kind-field">
            <span>Accent</span>
            <div className="cora-board-tone-picker" role="radiogroup" aria-label="Card accent">
              {EDGE_TONES.map((tone) => {
                const active = (selectedNode.data.item.tone ?? "default") === tone;
                return (
                  <button
                    key={tone}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? "is-active" : undefined}
                    title={tone === "default"
                      ? "Use the card type's color"
                      : `${NODE_TONE_LABELS[tone]} status accent`}
                    onClick={() => updateNode(selectedNode.id, {
                      tone: tone === "default" ? undefined : tone,
                    }, true)}
                  >
                    <i
                      aria-hidden
                      style={{
                        background: tone === "default"
                          ? nodeTone(selectedNode.data.item.kind)
                          : toneColor(tone),
                      }}
                    />
                    <span>{NODE_TONE_LABELS[tone]}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {selectedNode.data.item.kind === "condition" && (
            <button
              type="button"
              className="cora-board-inspector__action"
              onClick={() => addOutcome(selectedNode.id)}
            >
              Add another outcome
            </button>
          )}
          <div className="cora-board-inspector__meta">
            <span>x {Math.round(selectedNode.position.x)}</span>
            <span>y {Math.round(selectedNode.position.y)}</span>
            <span>{selectedNode.data.item.id}</span>
          </div>
        </aside>
      )}

      {editable && multiSelectedNodes.length < 2 && selectedEdge && (
        <aside className="cora-board-inspector" aria-label="Whiteboard connection inspector">
          <InspectorHeader
            label="Connection"
            onDelete={() => {
              const edge = edgesRef.current.find((candidate) => candidate.id === selectedEdge.id);
              if (edge) deleteEdges([edge]);
            }}
            onClose={() => setSelectedEdgeId(null)}
          />
          <label>
            <span>Label</span>
            <input
              value={selectedEdge.label ?? ""}
              maxLength={100}
              onChange={(event) => updateEdge(selectedEdge.id, { label: event.target.value })}
              onBlur={() => commit()}
              placeholder="Describe this relationship"
            />
          </label>
          <label>
            <span>Color</span>
            <select
              value={selectedEdge.tone ?? "default"}
              onChange={(event) => updateEdge(selectedEdge.id, {
                tone: event.target.value as CoraWhiteboardEdgeTone,
              }, true)}
            >
              {EDGE_TONES.map((tone) => (
                <option key={tone} value={tone}>{NODE_TONE_LABELS[tone]}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Style</span>
            <select
              value={selectedEdge.style ?? "solid"}
              onChange={(event) => updateEdge(selectedEdge.id, {
                style: event.target.value === "dashed" ? "dashed" : undefined,
              }, true)}
            >
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
            </select>
          </label>
          <div className="cora-board-inspector__meta">
            <span>{selectedEdge.from}</span>
            <span aria-hidden>→</span>
            <span>{selectedEdge.to}</span>
          </div>
        </aside>
      )}
    </div>
  );
}

function ToolbarIcon({ path }: { path: string }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={path} />
    </svg>
  );
}

function InspectorHeader({
  label,
  onDelete,
  onClose,
}: {
  label: string;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <header className="cora-board-inspector__header">
      <span>{label}</span>
      <div>
        <button type="button" onClick={onDelete} title="Delete selection">Delete</button>
        <button type="button" onClick={onClose} aria-label="Close inspector">×</button>
      </div>
    </header>
  );
}
