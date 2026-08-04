import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RunState } from "@shared/types";
import {
  buildRunMaps,
  isAutoCollapsibleStepStatus,
  isTerminalStepStatus,
  useRunReports,
} from "./run-format";
import RunGraph from "./RunGraph";
import Inspector from "./Inspector";
import { ResizeHandle } from "../../panels/ResizeHandle";
import { useRunExecutionRecord } from "../../lib/useRunExecutionRecord";

// The run canvas: a pan + zoom viewport holding the node graph, with a docked,
// selection-driven inspector on the right edge. The transform engine writes
// straight to the DOM (translate on the pan layer, CSS `zoom` on the content)
// so panning and the eased wheel-zoom never block on React.

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.2;
const DEFAULT_ZOOM = 1;
const WHEEL_SENS = 0.0014;
const ZOOM_EASE = 0.32;

const MIN_INSPECTOR = 340;
const MAX_INSPECTOR = 640;
const DEFAULT_INSPECTOR = 448;
const INSPECTOR_STORAGE_KEY = "spark.runs.inspector:v2";

interface InspectorPrefs {
  width: number;
  collapsed: boolean;
}

// Shared identity for "no overrides yet", so resetting on a run change does
// not hand the layout memo a new Set that means the same thing.
const NO_OVERRIDES: ReadonlySet<string> = new Set<string>();

function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (set.has(id)) return set;
  const next = new Set(set);
  next.add(id);
  return next;
}

function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function clampInspector(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_INSPECTOR;
  return Math.min(MAX_INSPECTOR, Math.max(MIN_INSPECTOR, Math.round(width)));
}

function loadInspectorPrefs(): InspectorPrefs {
  try {
    const raw = window.localStorage.getItem(INSPECTOR_STORAGE_KEY);
    if (!raw) return { width: DEFAULT_INSPECTOR, collapsed: false };
    const parsed = JSON.parse(raw) as Partial<InspectorPrefs>;
    return { width: clampInspector(Number(parsed.width ?? DEFAULT_INSPECTOR)), collapsed: Boolean(parsed.collapsed) };
  } catch {
    return { width: DEFAULT_INSPECTOR, collapsed: false };
  }
}

export default function RunCanvas({
  run,
  onOpenWorkerTerminal,
}: {
  run: RunState;
  // Returns whether a terminal pane was actually focused; the Inspector's
  // Open terminal button uses the miss to show a notice instead of dead-air.
  onOpenWorkerTerminal?: (workerTaskId: string) => boolean;
}) {
  const maps = useMemo(() => buildRunMaps(run), [run]);
  const reportByAttempt = useRunReports(run);
  const execution = useRunExecutionRecord(run);

  // Selecting a step and selecting a worker are mutually exclusive — one
  // "what's open" signal keeps the inspector from competing with itself.
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedWorkerTaskId, setSelectedWorkerTaskId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<InspectorPrefs>(loadInspectorPrefs);

  // Which finished steps are folded. The auto rule (a cleanly finished step
  // folds itself) is derived below; these two sets record the user overriding
  // it in either direction, and a manual choice always beats the rule. Kept in
  // memory only and per run — a fold is a way of reading THIS graph right now,
  // not a preference worth outliving the run.
  const [userExpanded, setUserExpanded] = useState<ReadonlySet<string>>(NO_OVERRIDES);
  const [userCollapsed, setUserCollapsed] = useState<ReadonlySet<string>>(NO_OVERRIDES);

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
  const suppressNextNodeClickRef = useRef(false);
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

  // Frame the graph the first time a given run is shown: fit the whole
  // orchestration so parallel branches read at a glance, but never below a
  // legibility floor — a graph still wider than the floor allows stays
  // left-anchored so the spine is entered from its start.
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
    const FIT_FLOOR = 0.45;
    const fit = Math.min(DEFAULT_ZOOM, (vw - 96) / naturalW, (vh - 96) / naturalH);
    const z = clampZoom(Math.max(FIT_FLOOR, fit));
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
    // NB: do not setPointerCapture here. Capturing the pointer on pointerdown
    // makes the browser retarget the follow-up `click` to this viewport, so a
    // node's onClick never fires and selecting a card silently does nothing.
    // Capture is taken lazily in movePanning once a real drag passes the
    // threshold (see below).
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
    if (!start.moved && Math.hypot(dx, dy) > 4) {
      start.moved = true;
      // Now that it's a genuine drag (not a click), capture the pointer so the
      // pan keeps tracking even if the cursor leaves the viewport. Deferring
      // capture to here is what keeps plain clicks reaching the nodes.
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Pointer already gone; in-viewport panning still works without it.
        }
      }
    }
    // Below the threshold this is still a potential click — don't pan yet.
    if (!start.moved) return;
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
    if (start.moved) {
      suppressNextNodeClickRef.current = true;
      window.setTimeout(() => {
        suppressNextNodeClickRef.current = false;
      }, 0);
    }
    // A press that never moved is a click on empty canvas — clear selection.
    else {
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
      if (suppressNextNodeClickRef.current) {
        suppressNextNodeClickRef.current = false;
        return;
      }
      setSelectedWorkerTaskId(null);
      setSelectedStepId((current) => (current === id ? null : id));
      revealInspector();
    },
    [revealInspector],
  );

  const handleSelectWorker = useCallback(
    (id: string) => {
      if (suppressNextNodeClickRef.current) {
        suppressNextNodeClickRef.current = false;
        return;
      }
      setSelectedStepId(null);
      // Single click selects and opens the inspector only. The terminal is
      // reached deliberately — the card's arrow, the inspector's "Open
      // terminal" action, or a double click — never as a click side effect.
      setSelectedWorkerTaskId(id);
      revealInspector();
    },
    [revealInspector],
  );

  const handleOpenWorker = useCallback(
    (id: string) => {
      if (suppressNextNodeClickRef.current) {
        suppressNextNodeClickRef.current = false;
        return;
      }
      // Keep legacy double-click routing equivalent to the new single-click
      // path. The selection survives so returning to Runs preserves context.
      setSelectedStepId(null);
      setSelectedWorkerTaskId(id);
      revealInspector();
      onOpenWorkerTerminal?.(id);
    },
    [onOpenWorkerTerminal, revealInspector],
  );

  // The step the selected worker belongs to. Auto-collapse must never fold a
  // card the user is currently looking inside of.
  const selectedWorkerStepId = selectedWorkerTaskId
    ? maps.taskById.get(selectedWorkerTaskId)?.stepId
    : undefined;

  // The effective fold set: the auto rule, then the user's overrides on top.
  const collapsedStepIds = useMemo(() => {
    const next = new Set<string>();
    for (const step of run.steps) {
      if (!isTerminalStepStatus(step.status)) continue;
      // A hand-folded step stays folded even if it holds the selection — the
      // toggle handler clears that selection rather than refusing the fold.
      if (userCollapsed.has(step.id)) {
        next.add(step.id);
        continue;
      }
      if (!isAutoCollapsibleStepStatus(step.status)) continue;
      if (userExpanded.has(step.id)) continue;
      if (step.id === selectedWorkerStepId) continue;
      next.add(step.id);
    }
    return next;
  }, [run.steps, userCollapsed, userExpanded, selectedWorkerStepId]);

  const handleToggleStepCollapse = useCallback(
    (stepId: string) => {
      const step = run.steps.find((candidate) => candidate.id === stepId);
      if (!step || !isTerminalStepStatus(step.status)) return;
      if (collapsedStepIds.has(stepId)) {
        setUserCollapsed((prev) => withoutId(prev, stepId));
        setUserExpanded((prev) => withId(prev, stepId));
        return;
      }
      setUserExpanded((prev) => withoutId(prev, stepId));
      setUserCollapsed((prev) => withId(prev, stepId));
      // Folding the card the selected worker lives in would leave the
      // inspector open on something no longer in the picture.
      setSelectedWorkerTaskId((current) =>
        current && maps.taskById.get(current)?.stepId === stepId ? null : current,
      );
    },
    [run.steps, collapsedStepIds, maps.taskById],
  );

  // Overrides belong to the run they were made in.
  useEffect(() => {
    setUserExpanded(NO_OVERRIDES);
    setUserCollapsed(NO_OVERRIDES);
  }, [run.id]);

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
          data-testid="run-canvas-viewport"
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
                collapsedStepIds={collapsedStepIds}
                onToggleStepCollapse={handleToggleStepCollapse}
                onSelectStep={handleSelectStep}
                onSelectWorker={handleSelectWorker}
                onOpenWorker={handleOpenWorker}
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
                execution={execution}
                selectedStepId={selectedStepId}
                selectedWorkerTaskId={selectedWorkerTaskId}
                onSelectStep={handleSelectStep}
                onSelectWorker={handleSelectWorker}
                onOpenWorkerTerminal={onOpenWorkerTerminal}
                onClear={clearSelection}
              />
            </div>
            <CollapseButton
              onClick={() => setInspector((prev) => ({ ...prev, collapsed: true }))}
            />
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
      className="spark-glass"
      style={{
        position: "absolute",
        left: 14,
        bottom: 14,
        zIndex: 3,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 3,
        borderRadius: 9,
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
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

// Inspector collapse toggle — a quiet chrome glyph button docked top-right of
// the inspector pane, with a coherent rest / hover state.
function CollapseButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
        border: `1px solid ${hover ? "var(--rule)" : "var(--rule-soft)"}`,
        borderRadius: 6,
        background: hover ? "var(--hover-strong)" : "var(--panel)",
        color: hover ? "var(--ink-dim)" : "var(--muted)",
        cursor: "default",
        zIndex: 2,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
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
        background: hover ? "color-mix(in oklab, var(--ink) 3%, var(--panel))" : "var(--panel)",
        color: hover ? "var(--ink-dim)" : "var(--muted)",
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
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
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Inspector
      </span>
    </button>
  );
}
