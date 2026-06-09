import React, { useCallback, useEffect, useRef, useState } from "react";
import SelectionRouteMenu from "./SelectionRouteMenu";
import type { SelectionPayload } from "../../routing/SelectionRoutingContext";

// Transparent canvas overlay used by the browser pane's "Draw" mode. The
// user sketches freehand strokes on top of the embedded page; clicking
// "Send to…" asks the parent to capture the page (via `webview.capturePage`),
// composite the strokes over it, save the PNG, and hand back a
// SelectionPayload so the routing menu can ship it to any chat or worker.
// The canvas only steals pointer events while active — the pane below stays
// fully interactive when draw mode is off.

interface Props {
  active: boolean;
  busy: boolean;
  // Parent runs the async capture + save and returns the payload (or null
  // when the capture failed). Called once per "Send to…" click before the
  // routing menu opens.
  preparePayload: (drawingDataUrl: string, note: string) => Promise<SelectionPayload | null>;
  onClose: () => void;
}

const STROKE_COLOR = "#ff3b30";
const STROKE_WIDTH = 3;
// User-painted pigments. These are the one sanctioned literal-color exception:
// the strokes are written straight into a <canvas> 2D context
// (ctx.strokeStyle = stroke.color), which cannot resolve CSS custom
// properties, and the swatch must display the exact pigment it paints — so
// these stay as literal hex rather than design tokens. The hues echo the
// status/accent palette (red / yellow / green / blue / purple / paper) so the
// annotation colors feel of-a-piece with the app.
const STROKE_COLORS = ["#ff3b30", "#f0c419", "#35c759", "#2f80ed", "#af52de", "#f7f2e8"];

type Stroke = { points: Array<{ x: number; y: number }>; color: string; width: number };

export default function DrawOverlay({ active, busy, preparePayload, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const [, setStrokeTick] = useState(0);
  const [note, setNote] = useState("");
  const [strokeColor, setStrokeColor] = useState(STROKE_COLOR);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [pendingPayload, setPendingPayload] = useState<SelectionPayload | null>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokesRef.current) {
      if (stroke.points.length < 1) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
    }
    const current = currentStrokeRef.current;
    if (current && current.points.length > 1) {
      ctx.strokeStyle = current.color;
      ctx.lineWidth = current.width;
      ctx.beginPath();
      ctx.moveTo(current.points[0].x, current.points[0].y);
      for (let i = 1; i < current.points.length; i++) {
        ctx.lineTo(current.points[i].x, current.points[i].y);
      }
      ctx.stroke();
    }
  }, []);

  // Resize the canvas's backing store to its display size. Without this the
  // canvas would stretch its 300×150 default bitmap to the container size,
  // which makes strokes look blurry and breaks pointer coordinate mapping.
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const host = containerRef.current;
    if (!canvas || !host) return;
    const resize = () => {
      const rect = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, [active, redraw]);

  // Reset strokes when draw mode is toggled off so the next session starts blank.
  useEffect(() => {
    if (!active) {
      strokesRef.current = [];
      currentStrokeRef.current = null;
      setNote("");
      setStrokeTick((n) => n + 1);
      setMenuOpen(false);
      setPendingPayload(null);
    }
  }, [active]);

  if (!active) return null;

  const startStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (busy) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    currentStrokeRef.current = {
      points: [{ x: e.clientX - rect.left, y: e.clientY - rect.top }],
      color: strokeColor,
      width: STROKE_WIDTH,
    };
    redraw();
  };

  const extendStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!currentStrokeRef.current) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    currentStrokeRef.current.points.push({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    redraw();
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!currentStrokeRef.current) return;
    try {
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    if (currentStrokeRef.current.points.length > 1) {
      strokesRef.current.push(currentStrokeRef.current);
    }
    currentStrokeRef.current = null;
    setStrokeTick((n) => n + 1);
  };

  const undo = () => {
    if (busy) return;
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeTick((n) => n + 1);
    redraw();
  };

  const clearAll = () => {
    if (busy) return;
    strokesRef.current = [];
    currentStrokeRef.current = null;
    setStrokeTick((n) => n + 1);
    redraw();
  };

  const requestSend = async () => {
    if (busy) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    const payload = await preparePayload(dataUrl, note.trim());
    if (!payload) return;
    const button = sendButtonRef.current;
    const anchor = button
      ? { x: button.getBoundingClientRect().right - 264, y: button.getBoundingClientRect().top }
      : { x: window.innerWidth - 280, y: window.innerHeight - 80 };
    setPendingPayload(payload);
    setMenuAnchor(anchor);
    setMenuOpen(true);
  };

  const hasStrokes = strokesRef.current.length > 0 || currentStrokeRef.current != null;

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 55,
        // Canvas alone catches pointer events; the toolbar handles its own.
        pointerEvents: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={startStroke}
        onPointerMove={extendStroke}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          cursor: "crosshair",
          // While the routing menu is open, let clicks fall through instead
          // of starting a stray stroke — the user dismissing the menu
          // shouldn't pepper their drawing with dots.
          pointerEvents: menuOpen ? "none" : "auto",
          touchAction: "none",
          background: "transparent",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 12,
          right: 12,
          bottom: 12,
          pointerEvents: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 10,
          // Floating chrome over live content: a semi-translucent panel face
          // with a blur, per the worker-chip reference for floating clusters.
          background: "color-mix(in oklch, var(--panel-2) 92%, transparent)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          border: "1px solid var(--rule)",
          borderRadius: "var(--radius-popover, 9px)",
          boxShadow: "var(--shadow-2)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="spark-eyebrow"
            style={{ flex: 1, display: "inline-flex", alignItems: "baseline", gap: 6 }}
          >
            Draw mode
            {busy ? (
              <span
                style={{
                  color: "var(--accent)",
                  animation: "spark-pulse 1.4s ease-in-out infinite",
                }}
              >
                Capturing…
              </span>
            ) : null}
          </span>
          <div
            aria-label="Stroke color"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              height: 24,
              padding: "0 5px",
              background: "color-mix(in oklch, var(--ink) 5%, transparent)",
              border: "1px solid var(--rule-soft)",
              borderRadius: 999,
              boxShadow: "var(--well)",
            }}
          >
            {STROKE_COLORS.map((color) => {
              const selected = strokeColor.toLowerCase() === color.toLowerCase();
              return (
                <button
                  key={color}
                  type="button"
                  aria-label={`Use ${color}`}
                  aria-pressed={selected}
                  onClick={() => setStrokeColor(color)}
                  disabled={busy}
                  style={{
                    appearance: "none",
                    width: 16,
                    height: 16,
                    padding: 0,
                    borderRadius: 999,
                    // Border width is held constant (1px) in both states so the
                    // pigment circle never resizes on select — selection is
                    // signalled purely by the outer ring below. (Was 1px<->2px,
                    // which shrank the swatch: the one true layout shift.)
                    border: "1px solid color-mix(in oklch, var(--ink) 25%, transparent)",
                    background: color,
                    // Selected: a crisp accent ring hugging the swatch, no
                    // size change. The 1px panel-tinted gap separates the ring
                    // from the pigment so it reads on dark and bright swatches
                    // alike. Border width stays 1px in both states.
                    boxShadow: selected
                      ? "0 0 0 1px var(--panel-2), 0 0 0 2px var(--accent)"
                      : "none",
                    cursor: "default",
                    transition:
                      "box-shadow var(--motion-fast) var(--ease-out)",
                  }}
                />
              );
            })}
            <label
              title="Custom color"
              style={{
                width: 18,
                height: 18,
                borderRadius: 999,
                overflow: "hidden",
                border: "1px solid var(--rule)",
                background: strokeColor,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <input
                type="color"
                value={strokeColor}
                disabled={busy}
                onChange={(e) => setStrokeColor(e.target.value)}
                style={{
                  width: 26,
                  height: 26,
                  opacity: 0,
                  cursor: "default",
                }}
              />
            </label>
          </div>
          <ToolButton onClick={undo} disabled={busy || !hasStrokes}>
            Undo
          </ToolButton>
          <ToolButton onClick={clearAll} disabled={busy || !hasStrokes}>
            Clear
          </ToolButton>
          <ToolButton onClick={onClose} disabled={busy}>
            Exit
          </ToolButton>
        </div>
        <label
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr)",
            alignItems: "center",
            gap: 9,
            minHeight: 34,
            padding: "4px 5px 4px 10px",
            background: "var(--bg)",
            border: "1px solid var(--rule-soft)",
            borderRadius: "var(--radius-surface, 7px)",
            boxShadow: "var(--well)",
          }}
        >
          <span className="spark-eyebrow" style={{ whiteSpace: "nowrap" }}>
            Note
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (hasStrokes) void requestSend();
              }
            }}
            disabled={busy}
            placeholder="Add context for the agent"
            style={{
              minWidth: 0,
              height: 24,
              padding: "0 6px",
              background: "transparent",
              border: "none",
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              outline: "none",
            }}
          />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          {/* The committing action: .spark-btn.is-primary earns the one accent.
              Disabled state is opacity-based (from the utility); hover is a
              token color-mix, not filter:brightness. */}
          <button
            ref={sendButtonRef}
            type="button"
            className="spark-btn is-primary"
            onClick={() => void requestSend()}
            disabled={busy || !hasStrokes}
            style={{ height: 30, padding: "0 14px" }}
          >
            {busy ? "Sending…" : "Send to…"}
          </button>
        </div>
      </div>

      {menuOpen && menuAnchor && pendingPayload && (
        <SelectionRouteMenu
          payload={pendingPayload}
          anchor={menuAnchor}
          mode="above"
          onClose={() => setMenuOpen(false)}
          onRouted={() => {
            // Leave draw mode after a successful route so the user gets a
            // clean slate; matches the behaviour the old "Send to chat"
            // button had.
            onClose();
          }}
        />
      )}
    </div>
  );
}

function ToolButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  // Built on .spark-btn for consistent radius, tactile press (translateY +
  // well), opacity-based disabled, and the focus-visible ring. Compacted to a
  // 24px height + 11px text to fit the draw toolbar's dense cluster.
  return (
    <button
      type="button"
      className="spark-btn"
      onClick={onClick}
      disabled={disabled}
      style={{ height: 24, padding: "0 9px", fontSize: 11 }}
    >
      {children}
    </button>
  );
}
