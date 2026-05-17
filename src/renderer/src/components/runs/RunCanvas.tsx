import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RunState } from "@shared/types";
import { buildRunMaps, useRunReports } from "./run-format";
import RunGraph from "./RunGraph";
import Inspector from "./Inspector";
import { ResizeHandle } from "../../panels/ResizeHandle";

// The run canvas: a pan + zoom viewport holding the node graph, with a docked,
// selection-driven inspector on the right edge. The transform engine writes
// straight to the DOM (translate on the pan layer, CSS `zoom` on the content)
// so panning and the eased wheel-zoom never block on React.

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.2;
const DEFAULT_ZOOM = 1;
const WHEEL_SENS = 0.0014;
const ZOOM_EASE = 0.32;

const MIN_INSPECTOR = 300;
const MAX_INSPECTOR = 560;
const INSPECTOR_STORAGE_KEY = "spark.runs.inspector:v1";

interface InspectorPrefs {
  width: number;
  collapsed: boolean;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function clampInspector(width: number): number {
  if (!Number.isFinite(width)) return 372;
  return Math.min(MAX_INSPECTOR, Math.max(MIN_INSPECTOR, Math.round(width)));
}

function loadInspectorPrefs(): InspectorPrefs {
  try {
    const raw = window.localStorage.getItem(INSPECTOR_STORAGE_KEY);
    if (!raw) return { width: 372, collapsed: false };
    const parsed = JSON.parse(raw) as Partial<InspectorPrefs>;
    return { width: clampInspector(Number(parsed.width ?? 372)), collapsed: Boolean(parsed.collapsed) };
  } catch {
    return { width: 372, collapsed: false };
  }
}

export default function RunCanvas({ run }: { run: RunState }) {
  const maps = useMemo(() => buildRunMaps(run), [run]);
  const reportByAttempt = useRunReports(run);

  // Selecting a step and selecting a worker are mutually exclusive — one
  // "what's open" signal keeps the inspector from competing with itself.
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedWorkerTaskId, setSelectedWorkerTaskId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<InspectorPrefs>(loadInspectorPrefs);

  const [zoomLabel, setZoomLabel] = useState(`${Math.round(DEFAULT_ZOOM * 100)}%`);
  const [isPanning, setIsPanning] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Live transform — x/y translate the pan layer, z is CSS zoom on the content
  // so text re-lays-out crisply at every scale instead of bitmap-scaling.
  const xRef = useRef(0);
  const yRef = useRef(0);
  const zRef = useRef(DEFAULT_ZOOM);
  const targetZRef = useRef(DEFAULT_ZOOM);
  const anchorRef = useRef<{ worldX: number; worldY: number; cursorX: number; cursorY: number } | null>(null);
  const animationRef = useRef<number | null>(null);
  const panStartRef = useRef<{
    pointerId: number;
    startCx: number;
    startCy: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const centeredRunIdRef = useRef<string | null>(null);
  const inspectorResizeRef = useRef(inspector.width);

  // ── Transform plumbing ─────────────────────────────────────────────────────

  const applyTransform = useCallback(() => {
    const pan = panRef.current;
    const content = contentRef.current;
    if (!pan || !content) return;
    pan.style.transform = `translate(${Math.round(xRef.current)}px, ${Math.round(yRef.current)}px)`;
    content.style.setProperty("zoom", String(zRef.current));
  }, []);

  const updateZoomLabel = useCallback(() => {
    const next = `${Math.round(zRef.current * 100)}%`;
    setZoomLabel((current) => (current === next ? current : next));
  }, []);

  const stopAnimation = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const startAnimation = useCallback(() => {
    if (animationRef.current !== null) return;
    const tick = () => {
      const dz = targetZRef.current - zRef.current;
      const anchor = anchorRef.current;
      if (Math.abs(dz) < 0.0008) {
        zRef.current = targetZRef.current;
        if (anchor) {
          xRef.current = anchor.cursorX - anchor.worldX * zRef.current;
          yRef.current = anchor.cursorY - anchor.worldY * zRef.current;
        }
        applyTransform();
        updateZoomLabel();
        animationRef.current = null;
        return;
      }
      zRef.current += dz * ZOOM_EASE;
      if (anchor) {
        xRef.current = anchor.cursorX - anchor.worldX * zRef.current;
        yRef.current = anchor.cursorY - anchor.worldY * zRef.current;
      }
      applyTransform();
      updateZoomLabel();
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  }, [applyTransform, updateZoomLabel]);

  const zoomToward = useCallback(
    (nextTargetZ: number, cursorX: number, cursorY: number) => {
      const clamped = clampZoom(nextTargetZ);
      if (clamped === targetZRef.current && clamped === zRef.current) return;
      anchorRef.current = {
        worldX: (cursorX - xRef.current) / zRef.current,
        worldY: (cursorY - yRef.current) / zRef.current,
        cursorX,
        cursorY,
      };
      targetZRef.current = clamped;
      startAnimation();
    },
    [startAnimation],
  );

  const zoomBy = useCallback(
    (delta: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      zoomToward(targetZRef.current + delta, viewport.clientWidth / 2, viewport.clientHeight / 2);
    },
    [zoomToward],
  );

  // Fit the whole graph into the viewport (never magnifying past 100%, so text
  // stays crisp) and centre it.
  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const rect = content.getBoundingClientRect();
    const naturalW = rect.width / zRef.current;
    const naturalH = rect.height / zRef.current;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (naturalW <= 0 || naturalH <= 0) return;
    const z = clampZoom(Math.min(1, (vw - 96) / naturalW, (vh - 96) / naturalH));
    stopAnimation();
    anchorRef.current = null;
    zRef.current = z;
    targetZRef.current = z;
    xRef.current = (vw - naturalW * z) / 2;
    yRef.current = (vh - naturalH * z) / 2;
    applyTransform();
    updateZoomLabel();
  }, [applyTransform, stopAnimation, updateZoomLabel]);

  // Native, non-passive wheel listener so preventDefault always lands.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const deltaScale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      const factor = Math.exp(-event.deltaY * deltaScale * WHEEL_SENS);
      if (panStartRef.current) {
        if (viewport.hasPointerCapture(panStartRef.current.pointerId)) {
          viewport.releasePointerCapture(panStartRef.current.pointerId);
        }
        panStartRef.current = null;
        setIsPanning(false);
      }
      zoomToward(targetZRef.current * factor, cursorX, cursorY);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [zoomToward]);

  useEffect(() => () => stopAnimation(), [stopAnimation]);

  // Frame the graph the first time a given run is shown: 100% zoom, the start
  // of the spine kept in view at the left, vertically centred.
  useLayoutEffect(() => {
    if (centeredRunIdRef.current === run.id) return;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const rect = content.getBoundingClientRect();
    const naturalW = rect.width / zRef.current;
    const naturalH = rect.height / zRef.current;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (naturalW <= 0 || naturalH <= 0 || vw <= 0 || vh <= 0) return;
    centeredRunIdRef.current = run.id;
    const z = clampZoom(DEFAULT_ZOOM);
    stopAnimation();
    zRef.current = z;
    targetZRef.current = z;
    xRef.current = naturalW * z <= vw ? (vw - naturalW * z) / 2 : 40;
    yRef.current = naturalH * z <= vh ? (vh - naturalH * z) / 2 : 36;
    anchorRef.current = null;
    applyTransform();
    updateZoomLabel();
  }, [run.id, applyTransform, stopAnimation, updateZoomLabel]);

  // ── Panning ────────────────────────────────────────────────────────────────

  const startPanning = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    stopAnimation();
    targetZRef.current = zRef.current;
    anchorRef.current = null;
    panStartRef.current = {
      pointerId: event.pointerId,
      startCx: event.clientX,
      startCy: event.clientY,
      startX: xRef.current,
      startY: yRef.current,
      moved: false,
    };
    setIsPanning(true);
  };

  const movePanning = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.startCx;
    const dy = event.clientY - start.startCy;
    if (!start.moved && Math.hypot(dx, dy) > 4) start.moved = true;
    xRef.current = start.startX + dx;
    yRef.current = start.startY + dy;
    applyTransform();
  };

  const stopPanning = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // A press that never moved is a click on empty canvas — clear selection.
    if (!start.moved) {
      setSelectedStepId(null);
      setSelectedWorkerTaskId(null);
    }
    panStartRef.current = null;
    setIsPanning(false);
  };

  // ── Selection ──────────────────────────────────────────────────────────────

  const revealInspector = useCallback(() => {
    setInspector((prev) => (prev.collapsed ? { ...prev, collapsed: false } : prev));
  }, []);

  const handleSelectStep = useCallback(
    (id: string) => {
      setSelectedWorkerTaskId(null);
      setSelectedStepId((current) => (current === id ? null : id));
      revealInspector();
    },
    [revealInspector],
  );

  const handleSelectWorker = useCallback(
    (id: string) => {
      setSelectedStepId(null);
      setSelectedWorkerTaskId((current) => (current === id ? null : id));
      revealInspector();
    },
    [revealInspector],
  );

  const clearSelection = useCallback(() => {
    setSelectedStepId(null);
    setSelectedWorkerTaskId(null);
  }, []);

  // Persist inspector width / collapsed on a trailing debounce.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(INSPECTOR_STORAGE_KEY, JSON.stringify(inspector));
      } catch {
        /* best-effort */
      }
    }, 300);
    return () => window.clearTimeout(id);
  }, [inspector]);

  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex" }}>
      {/* Canvas area — grid backdrop, viewport, zoom control. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
          background: "var(--bg)",
          backgroundImage:
            "radial-gradient(circle, color-mix(in oklch, var(--muted) 24%, transparent) 0.9px, transparent 1.6px)",
          backgroundSize: "24px 24px",
        }}
      >
        <div
          ref={viewportRef}
          onPointerDown={startPanning}
          onPointerMove={movePanning}
          onPointerUp={stopPanning}
          onPointerCancel={stopPanning}
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            cursor: isPanning ? "grabbing" : "grab",
            userSelect: "none",
            touchAction: "none",
          }}
        >
          <div ref={panRef} style={{ position: "absolute", top: 0, left: 0, transformOrigin: "0 0" }}>
            <div
              ref={contentRef}
              style={{
                display: "inline-block",
                textRendering: "geometricPrecision",
                WebkitFontSmoothing: "antialiased",
              }}
            >
              <RunGraph
                run={run}
                maps={maps}
                reportByAttempt={reportByAttempt}
                selectedStepId={selectedStepId}
                selectedWorkerTaskId={selectedWorkerTaskId}
                onSelectStep={handleSelectStep}
                onSelectWorker={handleSelectWorker}
              />
            </div>
          </div>
        </div>

        <ZoomControl
          label={zoomLabel}
          onOut={() => zoomBy(-0.16)}
          onIn={() => zoomBy(0.16)}
          onFit={fitToView}
        />
      </div>

      {/* Docked inspector — or a collapsed rail. */}
      {inspector.collapsed ? (
        <CollapsedRail onExpand={revealInspector} />
      ) : (
        <>
          <ResizeHandle
            orientation="col"
            ariaLabel="Resize inspector"
            onResizeStart={() => {
              inspectorResizeRef.current = inspector.width;
            }}
            onResize={(delta) => {
              // Handle sits left of the inspector: dragging left widens it.
              setInspector((prev) => ({
                ...prev,
                width: clampInspector(inspectorResizeRef.current - delta),
              }));
            }}
          />
          <div
            style={{
              flex: `0 0 ${inspector.width}px`,
              width: inspector.width,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              position: "relative",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <Inspector
                run={run}
                maps={maps}
                reportByAttempt={reportByAttempt}
                selectedStepId={selectedStepId}
                selectedWorkerTaskId={selectedWorkerTaskId}
                onSelectStep={handleSelectStep}
                onSelectWorker={handleSelectWorker}
                onClear={clearSelection}
              />
            </div>
            <button
              type="button"
              onClick={() => setInspector((prev) => ({ ...prev, collapsed: true }))}
              title="Collapse inspector"
              style={{
                position: "absolute",
                top: 9,
                right: 10,
                width: 24,
                height: 24,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid var(--rule-soft)",
                borderRadius: 6,
                background: "var(--panel)",
                color: "var(--muted)",
                cursor: "pointer",
                zIndex: 2,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path
                  d="M4.5 2 L8 6 L4.5 10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Zoom control ─────────────────────────────────────────────────────────────

function ZoomControl({
  label,
  onOut,
  onIn,
  onFit,
}: {
  label: string;
  onOut: () => void;
  onIn: () => void;
  onFit: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 14,
        bottom: 14,
        zIndex: 3,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 3,
        background: "var(--panel-2)",
        border: "1px solid var(--rule)",
        borderRadius: 9,
        boxShadow: "var(--shadow-1)",
      }}
    >
      <ZoomButton title="Zoom out" onClick={onOut}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </ZoomButton>
      <span
        style={{
          minWidth: 42,
          textAlign: "center",
          color: "var(--ink-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {label}
      </span>
      <ZoomButton title="Zoom in" onClick={onIn}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </ZoomButton>
      <span style={{ width: 1, height: 16, background: "var(--rule-soft)", margin: "0 2px" }} />
      <ZoomButton title="Fit graph to view" onClick={onFit} wide>
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path
            d="M2 5V2.6h2.4M12 5V2.6H9.6M2 9v2.4h2.4M12 9v2.4H9.6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ZoomButton>
    </div>
  );
}

function ZoomButton({
  title,
  onClick,
  wide,
  children,
}: {
  title: string;
  onClick: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: wide ? 30 : 24,
        height: 24,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        borderRadius: 6,
        background: hover ? "var(--hover-strong)" : "transparent",
        color: hover ? "var(--ink)" : "var(--ink-dim)",
        cursor: "pointer",
        transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

// ── Collapsed inspector rail ─────────────────────────────────────────────────

function CollapsedRail({ onExpand }: { onExpand: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onExpand}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Open inspector"
      style={{
        appearance: "none",
        flex: "0 0 36px",
        width: 36,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        paddingTop: 11,
        borderLeft: "1px solid var(--rule)",
        background: hover ? "color-mix(in oklch, var(--ink) 3%, var(--panel))" : "var(--panel)",
        color: hover ? "var(--ink-dim)" : "var(--muted)",
        cursor: "pointer",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          d="M7.5 2 L4 6 L7.5 10"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span
        style={{
          writingMode: "vertical-rl",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
        }}
      >
        Inspector
      </span>
    </button>
  );
}
