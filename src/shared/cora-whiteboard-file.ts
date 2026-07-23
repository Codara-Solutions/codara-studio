import type {
  CoraWhiteboard,
  CoraWhiteboardEdge,
  CoraWhiteboardFile,
  CoraWhiteboardNode,
} from "./types";

const MAX_FILE_NODES = 500;
const MAX_FILE_EDGES = 1_000;

export const CORA_WHITEBOARD_NODE_DEFAULT_SIZES: Record<
  CoraWhiteboardNode["kind"],
  { width: number; height: number }
> = {
  note: { width: 230, height: 140 },
  topic: { width: 260, height: 120 },
  group: { width: 560, height: 380 },
  file: { width: 240, height: 138 },
  symbol: { width: 250, height: 142 },
  flow: { width: 250, height: 124 },
  condition: { width: 260, height: 140 },
  decision: { width: 260, height: 140 },
  risk: { width: 260, height: 140 },
};

export const CORA_WHITEBOARD_NODE_KINDS: readonly CoraWhiteboardNode["kind"][] = [
  "topic", "group", "file", "symbol", "flow", "condition", "decision", "risk", "note",
];

/** Groups are background containers, so they may be far larger than cards. */
export function whiteboardNodeSizeLimits(kind: CoraWhiteboardNode["kind"]): {
  minWidth: number; maxWidth: number; minHeight: number; maxHeight: number;
} {
  return kind === "group"
    ? { minWidth: 220, maxWidth: 2400, minHeight: 140, maxHeight: 1600 }
    : { minWidth: 180, maxWidth: 520, minHeight: 96, maxHeight: 520 };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const WHITEBOARD_TONES = new Set(["default", "accent", "success", "warning", "danger"]);

function parseNode(value: unknown): CoraWhiteboardNode | null {
  const source = record(value);
  if (!source || typeof source.id !== "string" || typeof source.title !== "string") return null;
  const kinds = new Set(CORA_WHITEBOARD_NODE_KINDS);
  const kind = kinds.has(String(source.kind) as CoraWhiteboardNode["kind"])
    ? source.kind as CoraWhiteboardNode["kind"]
    : "note";
  const defaultSize = CORA_WHITEBOARD_NODE_DEFAULT_SIZES[kind];
  return {
    id: source.id,
    kind,
    title: source.title,
    body: typeof source.body === "string" ? source.body : undefined,
    x: finite(source.x, 80),
    y: finite(source.y, 80),
    width: finite(source.width, defaultSize.width),
    height: finite(source.height, defaultSize.height),
    tone: WHITEBOARD_TONES.has(String(source.tone))
      ? source.tone as CoraWhiteboardNode["tone"]
      : undefined,
  };
}

function parseEdge(value: unknown): CoraWhiteboardEdge | null {
  const source = record(value);
  if (
    !source ||
    typeof source.id !== "string" ||
    typeof source.from !== "string" ||
    typeof source.to !== "string"
  ) return null;
  return {
    id: source.id,
    from: source.from,
    to: source.to,
    label: typeof source.label === "string" ? source.label : undefined,
    tone: WHITEBOARD_TONES.has(String(source.tone))
      ? source.tone as CoraWhiteboardEdge["tone"]
      : undefined,
    style: source.style === "dashed" ? "dashed" : undefined,
  };
}

export function parseCoraWhiteboard(value: unknown): CoraWhiteboard {
  const source = record(value);
  if (!source || !Array.isArray(source.nodes) || !Array.isArray(source.edges)) {
    throw new Error("This is not a valid Codara whiteboard.");
  }
  const nodes = source.nodes.slice(0, MAX_FILE_NODES).map(parseNode).filter(Boolean) as CoraWhiteboardNode[];
  const ids = new Set(nodes.map((node) => node.id));
  const edges = source.edges
    .slice(0, MAX_FILE_EDGES)
    .map(parseEdge)
    .filter((edge): edge is CoraWhiteboardEdge =>
      Boolean(edge && ids.has(edge.from) && ids.has(edge.to)));
  return {
    version: 1,
    revision: Math.max(0, Math.floor(finite(source.revision, 0))),
    lastEditedBy:
      source.lastEditedBy === "user" ||
      source.lastEditedBy === "import" ||
      source.lastEditedBy === "cora"
        ? source.lastEditedBy
        : "import",
    title: typeof source.title === "string" && source.title.trim()
      ? source.title
      : "Imported whiteboard",
    summary: typeof source.summary === "string" ? source.summary : undefined,
    nodes,
    edges,
    updatedAt: typeof source.updatedAt === "string"
      ? source.updatedAt
      : new Date().toISOString(),
  };
}

export function parseCoraWhiteboardFile(text: string): CoraWhiteboard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The whiteboard file is not valid JSON.");
  }
  const wrapper = record(parsed);
  if (wrapper?.format === "codara.whiteboard") return parseCoraWhiteboard(wrapper.board);
  // Also accept a raw board so repositories can generate the format directly.
  return parseCoraWhiteboard(parsed);
}

export function serializeCoraWhiteboardFile(board: CoraWhiteboard): string {
  const file: CoraWhiteboardFile = {
    format: "codara.whiteboard",
    version: 1,
    exportedAt: new Date().toISOString(),
    board,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function whiteboardFileName(title: string): string {
  const stem = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "cora-whiteboard";
  return `${stem}.coraboard`;
}
