// Standalone image export for Cora whiteboards. Renders the board data model
// (not the DOM) to a self-contained SVG string so exports work offline, at any
// scale, and independent of the canvas viewport. Layout constants mirror the
// .cora-board-card CSS so the image matches what the user sees on screen.
import type {
  CoraWhiteboard,
  CoraWhiteboardEdge,
  CoraWhiteboardEdgeTone,
  CoraWhiteboardNode,
  CoraWhiteboardNodeKind,
} from "@shared/types";
import { CORA_WHITEBOARD_NODE_DEFAULT_SIZES } from "@shared/cora-whiteboard-file";

export type BoardImageTheme = "light" | "dark";

// Exports need concrete colors, not CSS vars. These are the resolved token
// values of the default dark theme and codara-daylight (oklch tokens baked to
// hex); per-theme accent overrides deliberately don't apply — the image uses
// the product's base palette.
interface BoardPalette {
  bg: string;
  panel: string;
  ink: string;
  inkDim: string;
  muted: string;
  muted2: string;
  rule: string;
  accent: string;
  ok: string;
  warn: string;
  danger: string;
  file: string;
  symbol: string;
}

const PALETTES: Record<BoardImageTheme, BoardPalette> = {
  dark: {
    bg: "#0e0d0b",
    panel: "#171513",
    ink: "#f4f3f1",
    inkDim: "#bdbcb8",
    muted: "#7c7a75",
    muted2: "#5a5853",
    rule: "#34332f",
    accent: "#2aa298",
    ok: "#6ed274",
    warn: "#f3b01d",
    danger: "#ff5f5b",
    file: "#5b94dd",
    symbol: "#9e7fd3",
  },
  light: {
    bg: "#faf9f5",
    panel: "#f3f0e9",
    ink: "#211f1a",
    inkDim: "#4a473f",
    muted: "#7a766b",
    muted2: "#9c978a",
    rule: "#dcd7c9",
    accent: "#2aa298",
    ok: "#4e8a3c",
    warn: "#b8790a",
    danger: "#c0392b",
    file: "#2863ab",
    symbol: "#6a499b",
  },
};

const KIND_LABELS: Record<CoraWhiteboardNodeKind, string> = {
  topic: "Topic",
  group: "Group",
  file: "File",
  symbol: "Symbol",
  flow: "Process",
  condition: "Condition",
  decision: "Decision",
  risk: "Risk",
  note: "Note",
};

const PADDING = 48;
const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const ARROW_LENGTH = 7;
const ARROW_HALF_WIDTH = 3.5;

function kindColor(kind: CoraWhiteboardNodeKind, palette: BoardPalette): string {
  switch (kind) {
    case "topic": return palette.accent;
    case "group": return palette.muted2;
    case "file": return palette.file;
    case "symbol": return palette.symbol;
    case "flow": return palette.ok;
    case "condition":
    case "decision": return palette.warn;
    case "risk": return palette.danger;
    default: return palette.muted;
  }
}

function toneColor(tone: CoraWhiteboardEdgeTone, palette: BoardPalette): string {
  switch (tone) {
    case "accent": return palette.accent;
    case "success": return palette.ok;
    case "warning": return palette.warn;
    case "danger": return palette.danger;
    default: return palette.muted;
  }
}

function nodeAccent(node: CoraWhiteboardNode, palette: BoardPalette): string {
  return node.tone && node.tone !== "default"
    ? toneColor(node.tone, palette)
    : kindColor(node.kind, palette);
}

/** sRGB approximation of the app's color-mix() — good enough for export. */
function mix(a: string, b: string, weightOfA: number): string {
  const parse = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const channel = (x: number, y: number): string =>
    Math.round(x * weightOfA + y * (1 - weightOfA)).toString(16).padStart(2, "0");
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// ── Text measurement ─────────────────────────────────────────────────────────
// Per-character advance estimate for the system sans stack. Exact metrics need
// a DOM; a class-based table keeps wrapping close enough that lines neither
// overflow the card nor waste obvious room.

function charFactor(ch: string): number {
  if (ch === " ") return 0.28;
  if (/[ijltf.,:;!'`|()[\]{}]/.test(ch)) return 0.33;
  if (/[mwMW@]/.test(ch)) return 0.85;
  if (/[A-Z0-9_+=<>~%&#$]/.test(ch)) return 0.64;
  return 0.52;
}

function measure(text: string, fontSize: number): number {
  let total = 0;
  for (const ch of text) total += charFactor(ch);
  return total * fontSize;
}

function ellipsize(text: string, fontSize: number, maxWidth: number): string {
  let out = text;
  while (out.length > 1 && measure(`${out}…`, fontSize) > maxWidth) {
    out = out.slice(0, -1).trimEnd();
  }
  return `${out}…`;
}

function wrapLines(
  text: string,
  fontSize: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  if (words.length === 0 || maxLines <= 0 || maxWidth <= 0) return lines;
  let line = "";
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    const word = words[index];
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, fontSize) <= maxWidth) {
      line = candidate;
      index += 1;
    } else if (!line) {
      // A single word wider than the card: hard-break it.
      let cut = Math.max(1, word.length - 1);
      while (cut > 1 && measure(word.slice(0, cut), fontSize) > maxWidth) cut -= 1;
      lines.push(word.slice(0, cut));
      words[index] = word.slice(cut);
    } else {
      lines.push(line);
      line = "";
    }
  }
  let truncated = index < words.length;
  if (line) {
    if (lines.length < maxLines) lines.push(line);
    else truncated = true;
  }
  if (truncated && lines.length > 0) {
    lines[lines.length - 1] = ellipsize(lines[lines.length - 1], fontSize, maxWidth);
  }
  return lines;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

interface NodeGeom {
  node: CoraWhiteboardNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

function geometry(node: CoraWhiteboardNode): NodeGeom {
  const fallback =
    CORA_WHITEBOARD_NODE_DEFAULT_SIZES[node.kind] ?? CORA_WHITEBOARD_NODE_DEFAULT_SIZES.note;
  return {
    node,
    x: node.x,
    y: node.y,
    w: node.width ?? fallback.width,
    h: node.height ?? fallback.height,
  };
}

interface Anchor {
  x: number;
  y: number;
  /** Outward normal of the side the edge attaches to. */
  nx: number;
  ny: number;
}

// Mirrors edgeHandles() in CoraWhiteboardCanvas: edges leave and enter on the
// facing sides so exported wires route like the live board.
function anchors(source: NodeGeom, target: NodeGeom): { from: Anchor; to: Anchor } {
  const dx = target.x + target.w / 2 - (source.x + source.w / 2);
  const dy = target.y + target.h / 2 - (source.y + source.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? {
          from: { x: source.x + source.w, y: source.y + source.h / 2, nx: 1, ny: 0 },
          to: { x: target.x, y: target.y + target.h / 2, nx: -1, ny: 0 },
        }
      : {
          from: { x: source.x, y: source.y + source.h / 2, nx: -1, ny: 0 },
          to: { x: target.x + target.w, y: target.y + target.h / 2, nx: 1, ny: 0 },
        };
  }
  return dy >= 0
    ? {
        from: { x: source.x + source.w / 2, y: source.y + source.h, nx: 0, ny: 1 },
        to: { x: target.x + target.w / 2, y: target.y, nx: 0, ny: -1 },
      }
    : {
        from: { x: source.x + source.w / 2, y: source.y, nx: 0, ny: -1 },
        to: { x: target.x + target.w / 2, y: target.y + target.h, nx: 0, ny: 1 },
      };
}

function cubicPoint(
  t: number,
  p0: [number, number],
  c1: [number, number],
  c2: [number, number],
  p3: [number, number],
): [number, number] {
  const u = 1 - t;
  const pick = (axis: 0 | 1): number =>
    u * u * u * p0[axis] + 3 * u * u * t * c1[axis] + 3 * u * t * t * c2[axis] + t * t * t * p3[axis];
  return [pick(0), pick(1)];
}

// ── Rendering ────────────────────────────────────────────────────────────────

function textEl(
  x: number,
  y: number,
  content: string,
  options: {
    size: number;
    color: string;
    weight?: number;
    anchor?: "middle";
    letterSpacing?: number;
  },
): string {
  const attrs = [
    `x="${fmt(x)}"`,
    `y="${fmt(y)}"`,
    `font-size="${options.size}"`,
    `fill="${options.color}"`,
  ];
  if (options.weight) attrs.push(`font-weight="${options.weight}"`);
  if (options.anchor) attrs.push(`text-anchor="${options.anchor}"`);
  if (options.letterSpacing) attrs.push(`letter-spacing="${options.letterSpacing}"`);
  return `<text ${attrs.join(" ")}>${esc(content)}</text>`;
}

function baseline(lineTop: number, fontSize: number, lineHeight: number): number {
  return lineTop + fontSize * 0.8 + (lineHeight - fontSize) / 2;
}

function renderGroup(geom: NodeGeom, palette: BoardPalette): string {
  const tone = nodeAccent(geom.node, palette);
  const parts: string[] = [];
  parts.push(
    `<rect x="${fmt(geom.x)}" y="${fmt(geom.y)}" width="${fmt(geom.w)}" height="${fmt(geom.h)}" rx="12" ` +
      `fill="${tone}" fill-opacity="0.05" stroke="${mix(tone, palette.rule, 0.46)}" stroke-dasharray="5 4"/>`,
  );
  const textX = geom.x + 14;
  const maxWidth = geom.w - 28;
  parts.push(
    textEl(textX, baseline(geom.y + 12, 10, 12), KIND_LABELS.group, {
      size: 10,
      weight: 600,
      color: mix(tone, palette.ink, 0.84),
      letterSpacing: 0.3,
    }),
  );
  const title = wrapLines(geom.node.title, 12, maxWidth, 1);
  if (title.length > 0) {
    parts.push(
      textEl(textX, baseline(geom.y + 27, 12, 16), title[0], {
        size: 12,
        weight: 600,
        color: palette.inkDim,
      }),
    );
  }
  return parts.join("");
}

function renderCard(
  geom: NodeGeom,
  palette: BoardPalette,
  clipId: string,
  defs: string[],
): string {
  const { node } = geom;
  const tone = nodeAccent(node, palette);
  const isTopic = node.kind === "topic";
  const fill = node.kind === "risk" ? mix(palette.danger, palette.panel, 0.04) : palette.panel;
  const stroke = isTopic ? mix(tone, palette.rule, 0.34) : palette.rule;
  const parts: string[] = [];
  defs.push(
    `<clipPath id="${clipId}"><rect x="${fmt(geom.x)}" y="${fmt(geom.y)}" width="${fmt(geom.w)}" height="${fmt(geom.h)}" rx="9"/></clipPath>`,
  );
  parts.push(
    `<rect x="${fmt(geom.x)}" y="${fmt(geom.y)}" width="${fmt(geom.w)}" height="${fmt(geom.h)}" rx="9" ` +
      `fill="${fill}" stroke="${stroke}"/>`,
  );
  // The 3px kind bar, clipped to the card's rounded corners.
  parts.push(
    `<rect x="${fmt(geom.x)}" y="${fmt(geom.y)}" width="3" height="${fmt(geom.h)}" ` +
      `fill="${tone}" fill-opacity="0.78" clip-path="url(#${clipId})"/>`,
  );

  const headColor = mix(tone, palette.ink, 0.84);
  const label = KIND_LABELS[node.kind] ?? KIND_LABELS.note;
  const maxWidth = geom.w - 24;
  const titleSize = isTopic ? 14.5 : 13;
  const titleLineHeight = isTopic ? 19 : 17;
  const titleLines = wrapLines(node.title, titleSize, maxWidth, 2);
  const body = node.body?.trim() ?? "";

  if (isTopic) {
    // Topic cards are hubs: the whole block centers in the card.
    const bodyBudget = Math.min(
      4,
      Math.floor((geom.h - 21 - 18 - titleLines.length * titleLineHeight - (body ? 5 : 0)) / 16),
    );
    const bodyLines = body ? wrapLines(body, 11, maxWidth, Math.max(0, bodyBudget)) : [];
    const blockH =
      12 + 6 + titleLines.length * titleLineHeight + (bodyLines.length > 0 ? 5 + bodyLines.length * 16 : 0);
    const cx = geom.x + geom.w / 2;
    let top = geom.y + Math.max(10, (geom.h - blockH) / 2);
    parts.push(
      textEl(cx, baseline(top, 10, 12), label, {
        size: 10,
        weight: 600,
        color: headColor,
        anchor: "middle",
        letterSpacing: 0.3,
      }),
    );
    top += 12 + 6;
    for (const line of titleLines) {
      parts.push(
        textEl(cx, baseline(top, titleSize, titleLineHeight), line, {
          size: titleSize,
          weight: 620,
          color: palette.ink,
          anchor: "middle",
        }),
      );
      top += titleLineHeight;
    }
    top += 5;
    for (const line of bodyLines) {
      parts.push(
        textEl(cx, baseline(top, 11, 16), line, { size: 11, color: palette.muted, anchor: "middle" }),
      );
      top += 16;
    }
    return parts.join("");
  }

  const textX = geom.x + 12;
  parts.push(
    textEl(textX, baseline(geom.y + 10, 10, 12), label, {
      size: 10,
      weight: 600,
      color: headColor,
      letterSpacing: 0.3,
    }),
  );
  let top = geom.y + 10 + 12 + 6;
  for (const line of titleLines) {
    parts.push(
      textEl(textX, baseline(top, titleSize, titleLineHeight), line, {
        size: titleSize,
        weight: 620,
        color: palette.ink,
      }),
    );
    top += titleLineHeight;
  }
  if (body) {
    top += 5;
    const bodyBudget = Math.min(4, Math.floor((geom.y + geom.h - 11 - top) / 16));
    for (const line of wrapLines(body, 11, maxWidth, Math.max(0, bodyBudget))) {
      parts.push(textEl(textX, baseline(top, 11, 16), line, { size: 11, color: palette.muted }));
      top += 16;
    }
  }
  return parts.join("");
}

function renderEdge(
  edge: CoraWhiteboardEdge,
  byId: Map<string, NodeGeom>,
  palette: BoardPalette,
): string {
  const source = byId.get(edge.from);
  const target = byId.get(edge.to);
  if (!source || !target) return "";
  const { from, to } = anchors(source, target);
  const toned = Boolean(edge.tone && edge.tone !== "default");
  const stroke = toned ? toneColor(edge.tone!, palette) : palette.muted;
  const strokeOpacity = toned ? 1 : 0.78;
  const width = toned ? 1.8 : 1.5;

  // The curve stops at the arrow's base so the line never pokes past the tip.
  const tipX = to.x;
  const tipY = to.y;
  const endX = tipX + to.nx * ARROW_LENGTH;
  const endY = tipY + to.ny * ARROW_LENGTH;
  const dist = Math.hypot(endX - from.x, endY - from.y);
  const offset = Math.max(36, Math.min(150, dist * 0.4));
  const p0: [number, number] = [from.x, from.y];
  const c1: [number, number] = [from.x + from.nx * offset, from.y + from.ny * offset];
  const c2: [number, number] = [endX + to.nx * offset, endY + to.ny * offset];
  const p3: [number, number] = [endX, endY];

  const parts: string[] = [];
  const dash = edge.style === "dashed" ? ' stroke-dasharray="6 5"' : "";
  parts.push(
    `<path d="M ${fmt(p0[0])} ${fmt(p0[1])} C ${fmt(c1[0])} ${fmt(c1[1])}, ${fmt(c2[0])} ${fmt(c2[1])}, ${fmt(p3[0])} ${fmt(p3[1])}" ` +
      `fill="none" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="${width}"${dash}/>`,
  );
  // Arrowhead: a closed triangle aligned with the target side's normal.
  const px = -to.ny;
  const py = to.nx;
  parts.push(
    `<path d="M ${fmt(tipX)} ${fmt(tipY)} L ${fmt(endX + px * ARROW_HALF_WIDTH)} ${fmt(endY + py * ARROW_HALF_WIDTH)} ` +
      `L ${fmt(endX - px * ARROW_HALF_WIDTH)} ${fmt(endY - py * ARROW_HALF_WIDTH)} Z" ` +
      `fill="${stroke}" fill-opacity="${strokeOpacity}"/>`,
  );

  const label = edge.label?.trim();
  if (label) {
    const [mx, my] = cubicPoint(0.5, p0, c1, c2, p3);
    const maxLabelWidth = 208;
    const text = measure(label, 10.5) > maxLabelWidth ? ellipsize(label, 10.5, maxLabelWidth) : label;
    const pillW = measure(text, 10.5) + 12;
    const pillH = 17;
    parts.push(
      `<rect x="${fmt(mx - pillW / 2)}" y="${fmt(my - pillH / 2)}" width="${fmt(pillW)}" height="${fmt(pillH)}" rx="5" ` +
        `fill="${palette.panel}" fill-opacity="0.94"/>`,
    );
    parts.push(
      textEl(mx, my + 3.5, text, {
        size: 10.5,
        weight: 550,
        color: palette.inkDim,
        anchor: "middle",
      }),
    );
  }
  return parts.join("");
}

/** Render the board to a standalone SVG document string. */
export function renderBoardSvg(board: CoraWhiteboard, theme: BoardImageTheme): string {
  const palette = PALETTES[theme];
  const geoms = board.nodes.map(geometry);
  const byId = new Map(geoms.map((geom) => [geom.node.id, geom]));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const geom of geoms) {
    minX = Math.min(minX, geom.x);
    minY = Math.min(minY, geom.y);
    maxX = Math.max(maxX, geom.x + geom.w);
    maxY = Math.max(maxY, geom.y + geom.h);
  }
  if (geoms.length === 0) {
    minX = 0;
    minY = 0;
    maxX = 320;
    maxY = 200;
  }

  const width = Math.ceil(maxX - minX + PADDING * 2);
  const height = Math.ceil(maxY - minY + PADDING * 2);
  const viewX = minX - PADDING;
  const viewY = minY - PADDING;

  // Paint order matches the live board: groups sit behind, edges above them,
  // cards on top.
  const groups = geoms.filter((geom) => geom.node.kind === "group");
  const cards = geoms.filter((geom) => geom.node.kind !== "group");
  const defs: string[] = [];
  const body: string[] = [];
  for (const geom of groups) body.push(renderGroup(geom, palette));
  for (const edge of board.edges) body.push(renderEdge(edge, byId, palette));
  cards.forEach((geom, index) => body.push(renderCard(geom, palette, `wb-clip-${index}`, defs)));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${fmt(viewX)} ${fmt(viewY)} ${width} ${height}" font-family="${FONT_STACK}">` +
    `<defs>${defs.join("")}</defs>` +
    `<rect x="${fmt(viewX)}" y="${fmt(viewY)}" width="${width}" height="${height}" fill="${palette.bg}"/>` +
    body.join("") +
    `</svg>`
  );
}

/** Rasterize an SVG string to a PNG data URL, fully offline (Image + canvas). */
export async function svgToPngDataUrl(svg: string, scale = 2): Promise<string> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The board image could not be rasterized."));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  // Chromium caps canvas dimensions around 32k (and areas well below
  // 32k x 32k); past the cap toDataURL silently returns an empty payload.
  // Shrink the scale to fit and refuse boards that cannot fit at all.
  const MAX_CANVAS_SIDE = 16_384;
  const largestSide = Math.max(image.naturalWidth, image.naturalHeight, 1);
  const effectiveScale = Math.min(scale, MAX_CANVAS_SIDE / largestSide);
  if (effectiveScale < 0.2) {
    throw new Error("This board is too large to rasterize — export it as SVG instead.");
  }
  const width = Math.max(1, Math.round(image.naturalWidth * effectiveScale));
  const height = Math.max(1, Math.round(image.naturalHeight * effectiveScale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable.");
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}
