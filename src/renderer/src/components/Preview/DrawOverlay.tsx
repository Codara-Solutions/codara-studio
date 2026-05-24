import React, { useCallback, useEffect, useRef, useState } from "react";

// Transparent canvas overlay used by the browser pane's "Draw" mode. The
// user sketches freehand strokes on top of the embedded page; clicking
// "Send" asks the parent to capture the page (via `webview.capturePage`),
// composite the strokes over it, and ship the result to chat as a file path.
// The canvas only steals pointer events while active — the pane below stays
// fully interactive when draw mode is off.

interface Props {
  active: boolean;
  busy: boolean;
  onSend: (drawingDataUrl: string, note: string) => void;
  onClose: () => void;
}

const STROKE_COLOR = "#ff3b30";
const STROKE_WIDTH = 3;

type Stroke = { points: Array<{ x: number; y: number }>; color: string; width: number };

export default function DrawOverlay({ active, busy, onSend, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const [, setStrokeTick] = useState(0);
  const [note, setNote] = useState("");

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
    }
  }, [active]);

  if (!active) return null;

  const startStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (busy) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    currentStrokeRef.current = {
      points: [{ x: e.clientX - rect.left, y: e.clientY - rect.top }],
      color: STROKE_COLOR,
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

  const send = () => {
    if (busy) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    onSend(dataUrl, note.trim());
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
          pointerEvents: "auto",
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
          background: "color-mix(in oklch, var(--panel-2) 92%, transparent)",
          border: "1px solid var(--rule-strong)",
          borderRadius: 8,
          boxShadow: "var(--shadow-2)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              flex: 1,
              fontSize: 11,
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Draw mode {busy ? "— capturing…" : ""}
          </span>
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
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (hasStrokes) send();
            }
          }}
          disabled={busy}
          placeholder="Optional note — describe what you sketched."
          style={{
            height: 28,
            padding: "0 10px",
            background: "color-mix(in oklch, var(--ink) 4%, transparent)",
            border: "1px solid var(--rule-soft)",
            borderRadius: 6,
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            outline: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={send}
            disabled={busy || !hasStrokes}
            style={{
              appearance: "none",
              border: "none",
              borderRadius: 6,
              background:
                busy || !hasStrokes
                  ? "color-mix(in oklch, var(--ink) 8%, transparent)"
                  : "var(--accent)",
              color: busy || !hasStrokes ? "var(--muted)" : "var(--accent-ink)",
              padding: "0 14px",
              height: 30,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "var(--font-sans)",
              cursor: "default",
            }}
          >
            {busy ? "Sending…" : "Send to chat"}
          </button>
        </div>
      </div>
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
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: "none",
        border: "1px solid var(--rule-soft)",
        borderRadius: 6,
        background: "transparent",
        color: disabled ? "var(--muted)" : "var(--ink-dim)",
        height: 24,
        padding: "0 8px",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        cursor: "default",
      }}
    >
      {children}
    </button>
  );
}
