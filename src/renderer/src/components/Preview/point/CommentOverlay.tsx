import { useCallback, useEffect, useRef, useState } from "react";
import { formatCommentText, type PointAnnotation } from "@shared/point-format";
import type { PointRegionInput } from "@shared/preview-point";
import type { SelectionPayload } from "../../../routing/SelectionRoutingContext";
import { CloseIcon, MoveEdgeIcon } from "../../icons";
import type { RunInPage } from "./pageScripts";
import SendControls, { type SendOutcome } from "./SendControls";

// Comments on the page: boxes, arrows and freehand marks drawn over the live
// page or over a frozen screenshot of it, each with its own note. Sending
// gives the agent one annotated screenshot (numbers match the list), each
// mark's place in page coordinates, the elements under it and the notes
// (formatCommentText in src/shared/point-format.ts).

type Tool = "box" | "arrow" | "pen";
type Point = { x: number; y: number };

interface Mark {
  id: number;
  kind: Tool;
  color: string;
  /** Bounding box in the layer's pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  from?: Point;
  to?: Point;
  points?: Point[];
  note: string;
}

interface Frozen {
  dataUrl: string;
  scroll: Point;
}

interface Props {
  tabId: string;
  workspaceId: string | null;
  run: RunInPage;
  /** The page's visible viewport as a PNG data URL, painted even in the background. */
  capture: () => Promise<string>;
  onClose: () => void;
  onDone: (outcome: SendOutcome) => void;
}

// User-painted pigments. A canvas 2D context cannot resolve CSS custom
// properties, and the swatch must show the exact pigment it paints, so these
// stay literal; the hues echo the status palette so marks feel of the app.
const COLORS = ["#ff3b30", "#f0c419", "#35c759", "#2f80ed", "#af52de"];
const MAX_IMAGE_WIDTH = 1600;
const ARROW_TARGET = 12;

function bounds(points: readonly Point[]): { x: number; y: number; width: number; height: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The part of the page a mark is about: a box's area, an arrow's tip, a drawing's extent. */
function regionOf(mark: Mark): { x: number; y: number; width: number; height: number } {
  if (mark.kind === "arrow" && mark.to) return { x: mark.to.x - ARROW_TARGET, y: mark.to.y - ARROW_TARGET, width: ARROW_TARGET * 2, height: ARROW_TARGET * 2 };
  return { x: mark.x, y: mark.y, width: Math.max(1, mark.width), height: Math.max(1, mark.height) };
}

function badgeAt(mark: Mark): Point {
  if (mark.kind === "arrow" && mark.from) return mark.from;
  return { x: mark.x, y: mark.y };
}

function arrowHead(from: Point, to: Point, size: number): string {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const a = { x: to.x - size * Math.cos(angle - Math.PI / 7), y: to.y - size * Math.sin(angle - Math.PI / 7) };
  const b = { x: to.x - size * Math.cos(angle + Math.PI / 7), y: to.y - size * Math.sin(angle + Math.PI / 7) };
  return `${to.x},${to.y} ${a.x},${a.y} ${b.x},${b.y}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read the page screenshot."));
    image.src = src;
  });
}

/** The screenshot with every mark and its number drawn on it, as JPEG base64. */
async function annotate(base: string, marks: readonly Mark[], hostWidth: number): Promise<string> {
  const image = await loadImage(base);
  const fit = Math.min(1, MAX_IMAGE_WIDTH / image.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * fit);
  canvas.height = Math.round(image.naturalHeight * fit);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not draw the annotated screenshot.");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const k = canvas.width / Math.max(1, hostWidth);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  marks.forEach((mark, index) => {
    ctx.strokeStyle = mark.color;
    ctx.fillStyle = mark.color;
    ctx.lineWidth = 3 * k;
    if (mark.kind === "box") {
      ctx.strokeRect(mark.x * k, mark.y * k, mark.width * k, mark.height * k);
    } else if (mark.kind === "arrow" && mark.from && mark.to) {
      ctx.beginPath();
      ctx.moveTo(mark.from.x * k, mark.from.y * k);
      ctx.lineTo(mark.to.x * k, mark.to.y * k);
      ctx.stroke();
      const head = arrowHead({ x: mark.from.x * k, y: mark.from.y * k }, { x: mark.to.x * k, y: mark.to.y * k }, 14 * k)
        .split(" ").map((pair) => pair.split(",").map(Number));
      ctx.beginPath();
      ctx.moveTo(head[0][0], head[0][1]);
      ctx.lineTo(head[1][0], head[1][1]);
      ctx.lineTo(head[2][0], head[2][1]);
      ctx.closePath();
      ctx.fill();
    } else if (mark.points?.length) {
      ctx.beginPath();
      ctx.moveTo(mark.points[0].x * k, mark.points[0].y * k);
      for (const point of mark.points.slice(1)) ctx.lineTo(point.x * k, point.y * k);
      ctx.stroke();
    }
    const at = badgeAt(mark);
    const r = 10 * k;
    ctx.beginPath();
    ctx.arc(at.x * k, at.y * k, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5 * k;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.round(11 * k)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(index + 1), at.x * k, at.y * k + 0.5 * k);
  });
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
}

export default function CommentOverlay({ tabId, workspaceId, run, capture, onClose, onDone }: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<Tool>("box");
  const [color, setColor] = useState(COLORS[0]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [freezing, setFreezing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);
  const sendRef = useRef<(() => void) | null>(null);
  const [dockEdge, setDockEdge] = useState<"top" | "bottom">("bottom");
  const dockRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    layerRef.current?.focus();
  }, []);

  const pointFor = (event: { clientX: number; clientY: number }): Point | null => {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: Math.min(Math.max(0, event.clientX - rect.left), rect.width), y: Math.min(Math.max(0, event.clientY - rect.top), rect.height) };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const point = pointFor(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setEditing(null);
    setDraft({ id: 0, kind: tool, color, x: point.x, y: point.y, width: 0, height: 0, from: point, to: point, points: [point], note: "" });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!draft) return;
    const point = pointFor(event);
    if (!point || !draft.from) return;
    // A mark drawn under the bar would be hidden while it is drawn.
    const dock = dockRef.current?.getBoundingClientRect();
    if (dock && event.clientX >= dock.left && event.clientX <= dock.right && event.clientY >= dock.top && event.clientY <= dock.bottom) {
      const layer = layerRef.current?.getBoundingClientRect();
      if (layer) setDockEdge(dock.top > layer.top + layer.height / 2 ? "top" : "bottom");
    }
    if (draft.kind === "pen") {
      const points = [...(draft.points ?? []), point];
      setDraft({ ...draft, ...bounds(points), points });
    } else {
      setDraft({ ...draft, ...bounds([draft.from, point]), to: point });
    }
  };

  const onPointerUp = () => {
    if (!draft) return;
    const big = draft.kind === "pen"
      ? (draft.points?.length ?? 0) > 2
      : draft.kind === "arrow"
        ? Math.hypot((draft.to?.x ?? 0) - (draft.from?.x ?? 0), (draft.to?.y ?? 0) - (draft.from?.y ?? 0)) > 10
        : draft.width > 6 && draft.height > 6;
    setDraft(null);
    if (!big) return;
    const mark = { ...draft, id: nextId.current++ };
    setMarks((list) => [...list, mark]);
    setEditing(mark.id);
  };

  const updateNote = (id: number, text: string) => setMarks((list) => list.map((mark) => (mark.id === id ? { ...mark, note: text } : mark)));
  const remove = (id: number) => {
    setMarks((list) => list.filter((mark) => mark.id !== id));
    setEditing(null);
  };

  const toggleFreeze = async () => {
    if (frozen) {
      setFrozen(null);
      return;
    }
    setFreezing(true);
    setError(null);
    try {
      const [dataUrl, scroll] = await Promise.all([capture(), run("({ x: scrollX, y: scrollY })") as Promise<Point>]);
      setFrozen({ dataUrl, scroll });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFreezing(false);
    }
  };

  const prepare = useCallback(
    async (purpose: "deliver" | "copy"): Promise<SelectionPayload> => {
      if (!marks.length) throw new Error("Draw a box, an arrow or a mark first.");
      if (!workspaceId) throw new Error("Open a workspace first.");
      const hostWidth = layerRef.current?.clientWidth ?? 1;
      const live = (await run("({ width: innerWidth, x: scrollX, y: scrollY })")) as { width: number; x: number; y: number };
      // Marks on a frozen frame name what was under them then; put the page
      // back where it was so the elements found under them are the same ones.
      if (frozen && (frozen.scroll.x !== live.x || frozen.scroll.y !== live.y)) {
        await run(`(scrollTo(${frozen.scroll.x}, ${frozen.scroll.y}), new Promise((r) => requestAnimationFrame(() => r(true))))`);
      }
      const scale = live.width > 0 ? live.width / hostWidth : 1;
      const toPage = (p: Point): Point => ({ x: p.x * scale, y: p.y * scale });
      const regions: PointRegionInput[] = marks.map((mark) => {
        const region = regionOf(mark);
        return { x: region.x * scale, y: region.y * scale, width: region.width * scale, height: region.height * scale };
      });
      const [inspection, image] = await Promise.all([
        window.spark.point.inspect({ workspaceId, tabId, regions, crops: "none" }),
        frozen ? Promise.resolve(frozen.dataUrl) : capture(),
      ]);
      const annotated = await annotate(image, marks, hostWidth);
      const annotations: PointAnnotation[] = marks.map((mark) => ({
        kind: mark.kind,
        x: mark.x * scale,
        y: mark.y * scale,
        width: mark.width * scale,
        height: mark.height * scale,
        ...(mark.kind === "arrow" && mark.from && mark.to ? { from: toPage(mark.from), to: toPage(mark.to) } : {}),
        note: mark.note,
      }));
      const scroll = frozen?.scroll ?? { x: live.x, y: live.y };
      const text = formatCommentText(inspection, annotations, note, scroll, { frozen: Boolean(frozen) });
      if (purpose === "deliver") {
        return { source: "draw", text, attachments: [{ name: "comments.jpg", mimeType: "image/jpeg", data: annotated }], tabId: inspection.tabId, url: inspection.url };
      }
      const path = await window.spark.point.saveImage({ workspaceId, label: "comments", mimeType: "image/jpeg", data: annotated });
      return { source: "draw", text: `${text}\nAttached: ${path}`, tabId: inspection.tabId, url: inspection.url };
    },
    [capture, frozen, marks, note, run, tabId, workspaceId],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (editing !== null) {
        // The note that had focus goes away; the layer keeps the keys
        // (Escape, B, A, P, Mod+Z) working without a click.
        setEditing(null);
        layerRef.current?.focus();
      } else {
        onClose();
      }
      return;
    }
    if (typing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      setMarks((list) => list.slice(0, -1));
      setEditing(null);
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      const next = ({ b: "box", a: "arrow", p: "pen" } as Record<string, Tool>)[event.key.toLowerCase()];
      if (next) setTool(next);
    }
  };

  const shown = draft ? [...marks, draft] : marks;
  const editingMark = marks.find((mark) => mark.id === editing) ?? null;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div ref={layerRef} className="cp-layer" data-testid="comment-overlay" tabIndex={0} onKeyDown={onKeyDown} style={{ cursor: "crosshair" }}>
      {frozen ? <img className="cp-frozen" src={frozen.dataUrl} alt="" /> : null}
      <div className="cp-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          {shown.map((mark) => {
            if (mark.kind === "box") {
              return <rect key={mark.id} x={mark.x} y={mark.y} width={mark.width} height={mark.height} rx={3} fill={`${mark.color}14`} stroke={mark.color} strokeWidth={2.5} />;
            }
            if (mark.kind === "arrow" && mark.from && mark.to) {
              return (
                <g key={mark.id}>
                  <line x1={mark.from.x} y1={mark.from.y} x2={mark.to.x} y2={mark.to.y} stroke={mark.color} strokeWidth={2.5} strokeLinecap="round" />
                  <polygon points={arrowHead(mark.from, mark.to, 13)} fill={mark.color} />
                </g>
              );
            }
            return <polyline key={mark.id} points={(mark.points ?? []).map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={mark.color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />;
          })}
        </svg>
        {marks.map((mark, index) => {
          const at = badgeAt(mark);
          return (
            <button
              key={mark.id}
              type="button"
              className="cp-badge"
              style={{ left: at.x, top: at.y, background: mark.color, pointerEvents: "auto", border: 0, cursor: "default" }}
              title={mark.note || "Add a note"}
              onPointerDown={stop}
              onClick={() => setEditing(mark.id)}
            >
              {index + 1}
            </button>
          );
        })}
      </div>
      {editingMark ? (
        <MarkNote
          mark={editingMark}
          index={marks.indexOf(editingMark)}
          host={layerRef.current}
          onChange={(text) => updateNote(editingMark.id, text)}
          onDone={() => {
            setEditing(null);
            layerRef.current?.focus();
          }}
          onRemove={() => remove(editingMark.id)}
        />
      ) : null}
      <div ref={dockRef} className="cp-panel cp-dock spark-glass--strong spark-overlay-surface" data-testid="comment-dock" data-edge={dockEdge} onPointerDown={stop} onKeyDown={(event) => event.key !== "Escape" && stop(event)}>
        <div className="cp-toolbar">
          <div className="cp-seg" role="group" aria-label="Mark">
            {(["box", "arrow", "pen"] as Tool[]).map((value) => (
              <button key={value} type="button" aria-pressed={tool === value} onClick={() => setTool(value)} title={`${value === "box" ? "Box (B)" : value === "arrow" ? "Arrow (A)" : "Pen (P)"}`}>
                {value === "box" ? "Box" : value === "arrow" ? "Arrow" : "Pen"}
              </button>
            ))}
          </div>
          <div style={{ display: "inline-flex", gap: 5, padding: "0 4px" }} role="group" aria-label="Color">
            {COLORS.map((value) => (
              <button key={value} type="button" className="cp-swatch" aria-label={`Color ${value}`} aria-pressed={color === value} style={{ background: value }} onClick={() => setColor(value)} />
            ))}
          </div>
          <button
            type="button"
            className={`spark-btn cp-btn${frozen ? " is-primary" : ""}`}
            aria-pressed={Boolean(frozen)}
            disabled={freezing}
            onClick={() => void toggleFreeze()}
            title={frozen ? "Back to the live page" : "Freeze the page as a screenshot and draw on that"}
          >
            {freezing ? "Freezing…" : frozen ? "Frozen" : "Freeze"}
          </button>
          <span className="cp-spacer" />
          <button type="button" className="spark-btn cp-btn" disabled={!marks.length} onClick={() => setMarks((list) => list.slice(0, -1))} title="Undo the last mark (Ctrl/Cmd+Z)">
            Undo
          </button>
          <button type="button" className="spark-btn cp-btn" disabled={!marks.length} onClick={() => setMarks([])}>
            Clear
          </button>
          <button
            type="button"
            className="spark-icon-btn"
            onClick={() => setDockEdge((edge) => (edge === "top" ? "bottom" : "top"))}
            title={dockEdge === "top" ? "Move this bar to the bottom" : "Move this bar to the top"}
            aria-label="Move this bar"
            style={{ ["--spark-icon-btn-size" as string]: "24px" }}
          >
            <MoveEdgeIcon size={13} />
          </button>
          <button type="button" className="spark-icon-btn" onClick={onClose} title="Stop commenting (Esc)" aria-label="Stop commenting" style={{ ["--spark-icon-btn-size" as string]: "24px" }}>
            <CloseIcon size={12} />
          </button>
        </div>
        {marks.length ? (
          <div className="cp-marks">
            {marks.map((mark, index) => (
              <div key={mark.id} className="cp-mark" onClick={() => setEditing(mark.id)}>
                <span className="cp-element__num" style={{ background: mark.color }}>{index + 1}</span>
                <span className="cp-mark__text" data-empty={!mark.note}>{mark.note || "No note yet, click to add one"}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="cp-status">Drag on the page to mark what you mean. Each mark gets its own note.</div>
        )}
        <input
          className="cp-note cp-note--line"
          value={note}
          placeholder="Overall note (optional)"
          aria-label="Overall note"
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              sendRef.current?.();
            }
          }}
        />
        {error ? <div className="cp-status" data-tone="error" role="alert">{error}</div> : null}
        <SendControls tabId={tabId} disabled={!marks.length || freezing} prepare={prepare} onDone={onDone} sendRef={sendRef} />
      </div>
    </div>
  );
}

function MarkNote({
  mark,
  index,
  host,
  onChange,
  onDone,
  onRemove,
}: {
  mark: Mark;
  index: number;
  host: HTMLElement | null;
  onChange: (text: string) => void;
  onDone: () => void;
  onRemove: () => void;
}) {
  const width = 260;
  const hostWidth = host?.clientWidth ?? 800;
  const hostHeight = host?.clientHeight ?? 600;
  const left = Math.min(Math.max(8, mark.x + mark.width + 8 > hostWidth - width ? mark.x - width - 8 : mark.x + mark.width + 8), hostWidth - width - 8);
  const top = Math.min(Math.max(8, mark.y), hostHeight - 60);
  return (
    <div
      className="cp-panel cp-mark-note spark-glass--strong spark-overlay-surface"
      data-testid="comment-note"
      style={{ left, top, width }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="cp-element__num" style={{ background: mark.color, flex: "0 0 18px" }}>{index + 1}</span>
      <input
        className="cp-note cp-note--line"
        autoFocus
        value={mark.note}
        placeholder="What about this?"
        aria-label={`Note for mark ${index + 1}`}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onDone();
          }
        }}
      />
      <button type="button" className="spark-icon-btn" onClick={onRemove} title="Delete this mark" aria-label="Delete this mark" style={{ ["--spark-icon-btn-size" as string]: "22px" }}>
        <CloseIcon size={11} />
      </button>
    </div>
  );
}
