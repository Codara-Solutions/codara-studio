import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  getBezierPath,
} from "@xyflow/react";
import type { Edge, EdgeProps, Node, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  AutomationWorkerInfo,
  RunState,
  ScheduledJob,
} from "@shared/types";
import {
  automationDotColor,
  capLabel,
  fmtClock,
  fmtElapsed,
  fmtUsd,
  loopSummary,
  statusWord,
  triggerSummary,
  jobWorkerSummary,
} from "./presentation";
import { TRIGGER_ID, flowFromGraph, graphForJob } from "./flow/model";
import { LoomIcon, Medallion, TopRule, WORKER_TONE } from "./flow/FlowNodes";
import { workerModelLabel } from "./worker-models";
import { describeWorkerLogFailure } from "./worker-log-tail";

// LiveBoard — the "whiteboard" view of ONE running loom: the loom graph on a
// full read-only ReactFlow canvas with LIVE execution state. Live edges carry
// the house "electricity" (the run-graph's travelling accent dash — see
// .spark-wire-flow in styles.css); the executing node holds a steady accent
// glow. No breathing/scale pulses anywhere on the board. Clicking a worker
// node opens its ordered structured activity stream inside the board.
//
// The sheet is an untransformed overlay positioned within the canvas
// CONTAINER (never inside ReactFlow's zoom/pan transform layer — scaled
// transforms break xterm rendering and mouse targeting). It is full-bleed
// horizontally so the mirror xterm is at least as wide as any canonical grid
// cell / focus pane (same hub rect minus identical 4px body padding), keeping
// mirror cols >= pty cols in every layout — a narrower floating card would
// wrap the TUI's full-width frame lines. Closing the sheet hides it via
// visibility (geometry kept), so hidden mirrors are never resized; and
// because mirrors are readOnly, even a sheet drag-resize can only ever re-fit
// the mirrors locally — the pty itself is never SIGWINCH'd from here.

// Mirrors WorkersView's LIVE_ATTEMPT (module-private there): attempt statuses
// that mean the worker process is still going.
const LIVE_ATTEMPT = new Set(["preparing", "prompt_ready", "launching", "running", "finishing"]);

const SHEET_BAR_H = 34;
const SHEET_MIN_H = 160;

type LiveNodeStatus =
  | "pending"
  | "skipped"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked";

interface LiveNodeDatum extends Record<string, unknown> {
  kind: "trigger" | "worker" | "guard" | "merge";
  glyph: string;
  eyebrow: string;
  title: string;
  sub: string;
  status: LiveNodeStatus;
  // Trigger-only: the loom is mid-pass, so the trigger has fired.
  fired?: boolean;
  // This node's worker is the one focused in the terminal sheet.
  docked?: boolean;
}

export interface LiveBoardProps {
  job: ScheduledJob;
  // The loom's live run (job.state.currentRunId). Null once the pass settles —
  // the board retains the last-seen run so the final state stays viewable.
  liveRun: RunState | null;
  // Workers of THIS automation only (live + briefly-lingering exited ones).
  workers: AutomationWorkerInfo[];
  // Optional: open the terminal sheet focused on this worker (by attemptId) the
  // moment the board is shown. Set when the board is opened by clicking a worker
  // row in the loom detail; null/undefined for a plain "Board" open (sheet stays
  // closed). Non-breaking — the plain-open path passes nothing.
  initialFocusWorkerId?: string | null;
  // On screen right now (hub tab active + looms sub-tab + view mode). Drives
  // terminal visibility and the ticking clock; the board stays mounted while
  // hidden so the canvas viewport and mirror xterms survive sub-tab flips.
  shown: boolean;
  onClose: () => void;
  onOpenWorkersGrid: () => void;
  onStop: () => void;
  onAnswer: (runId: string, questionMessageId: string, answer: string) => void;
}

export default function LiveBoard({
  job,
  liveRun,
  workers,
  initialFocusWorkerId,
  shown,
  onClose,
  onOpenWorkersGrid,
  onStop,
  onAnswer,
}: LiveBoardProps): React.ReactElement {
  // Retain the last non-null run so a finished pass keeps its final node
  // states on the board (the hub's liveRun drops to null when the scheduler
  // clears currentRunId). Reset naturally: the board is keyed on job.id, and a
  // new pass delivers a fresh liveRun that replaces the retained one.
  const lastRunRef = useRef<RunState | null>(null);
  if (liveRun) lastRunRef.current = liveRun;
  const run = liveRun ?? lastRunRef.current;

  const status = job.state.status;
  const loomLive = status === "running" || status === "blocked";

  // ── terminal sheet state ────────────────────────────────────────────────
  // Closed until the user clicks a worker node — the whiteboard opens clean.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetH, setSheetH] = useState(320);
  // Track the canvas height so the sheet can be CLAMPED at render time —
  // without this, shrinking the window after a tall drag would leave the
  // absolutely-positioned sheet covering the whole canvas.
  // (visibility:hidden keeps the canvas measurable, so this works while the
  // board is mounted-but-hidden too.)
  const [canvasH, setCanvasH] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCanvasH(el.clientHeight));
    ro.observe(el);
    setCanvasH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const maxSheetH = canvasH > 0 ? Math.max(SHEET_MIN_H, canvasH - 88) : null;
  // Effective sheet height: the user's dragged height, window-shrink-clamped.
  // Clamping resizes the mirrors, but they are readOnly — only a local xterm
  // re-fit, never a SIGWINCH to the worker pty.
  const sheetBodyH = maxSheetH === null ? sheetH : Math.min(sheetH, maxSheetH);
  const sheetSizedRef = useRef(false);
  // Size the sheet once from the real canvas height (~46%). Never re-derived
  // on later resizes — the user's drag height wins from then on.
  useEffect(() => {
    if (sheetSizedRef.current || canvasH <= 0) return;
    sheetSizedRef.current = true;
    setSheetH(Math.max(SHEET_MIN_H, Math.round(canvasH * 0.46)));
  }, [canvasH]);

  const [pickedAttemptId, setPickedAttemptId] = useState<string | null>(null);
  // Focused sheet worker: explicit pick while it still exists, else blocked
  // first (needs the user), else first live, else the newest lingering one.
  const current = useMemo<AutomationWorkerInfo | null>(() => {
    const picked = workers.find((w) => w.attemptId === pickedAttemptId);
    if (picked) return picked;
    return (
      workers.find((w) => w.blocked) ??
      workers.find((w) => LIVE_ATTEMPT.has(w.status)) ??
      workers[0] ??
      null
    );
  }, [workers, pickedAttemptId]);

  // Board opened via a loom-detail worker row: focus the sheet on that worker
  // and reveal it. Fires on each new request (the hub clears the id on close /
  // selection change, so re-clicking the same worker is a fresh null→id change).
  // A plain "Board" open passes null and leaves the sheet as-is.
  useEffect(() => {
    if (!initialFocusWorkerId) return;
    setPickedAttemptId(initialFocusWorkerId);
    setSheetOpen(true);
  }, [initialFocusWorkerId]);

  const anyLive = workers.some((w) => LIVE_ATTEMPT.has(w.status));

  // One shared 1s clock for elapsed readouts, ticking only while watchable.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!shown || !anyLive) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [shown, anyLive]);

  // Sheet height drag. Applies to the VISIBLE mirror only in effect — hidden
  // sibling mirrors share the same box and re-fit locally, but being readOnly
  // they can never push a resize to the pty.
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Drag from the VISUAL height (clamped), so a window-shrunk sheet
      // doesn't jump to its stored pre-shrink height on the first pointer move.
      dragRef.current = { startY: e.clientY, startH: sheetBodyH };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [sheetBodyH],
  );
  const onDragMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const s = dragRef.current;
      if (!s) return;
      const maxH = maxSheetH ?? Math.max(SHEET_MIN_H, 600 - 88);
      const next = Math.min(maxH, Math.max(SHEET_MIN_H, s.startH + (s.startY - e.clientY)));
      setSheetH(next);
    },
    [maxSheetH],
  );
  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  // ── live graph → ReactFlow nodes/edges ──────────────────────────────────
  const statuses = useMemo(
    () => deriveNodeStatuses(job, run, workers),
    [job, run, workers],
  );

  const { nodes, edges } = useMemo(() => {
    const flow = flowFromGraph(job);
    const liveNodes: Node<LiveNodeDatum>[] = flow.nodes.map((n) => {
      const d = n.data;
      let datum: LiveNodeDatum;
      if (n.id === TRIGGER_ID || d.kind === "trigger") {
        datum = {
          kind: "trigger",
          glyph: "⚡",
          eyebrow: "Trigger",
          title: triggerSummary(job.trigger),
          sub: loomLive ? `pass ${Math.max(1, job.state.iteration)} in flight` : "armed",
          status: "pending",
          fired: loomLive,
        };
      } else if (d.kind === "worker") {
        const w = d.worker;
        const modelLine = [workerModelLabel(w.model), w.effort].filter(Boolean).join(" · ");
        datum = {
          kind: "worker",
          glyph: "◇",
          eyebrow: "Worker",
          title: d.label || "Worker",
          sub: modelLine,
          status: statuses.get(n.id) ?? "pending",
          docked: current?.nodeId === n.id,
        };
      } else if (d.kind === "guard") {
        datum = {
          kind: "guard",
          glyph: "◈",
          eyebrow: "Guard",
          title: d.label || "Guard",
          sub: d.predicate.type,
          status: statuses.get(n.id) ?? "pending",
        };
      } else {
        datum = {
          kind: "merge",
          glyph: "⊕",
          eyebrow: "Merge",
          title: d.kind === "merge" ? d.label || "Merge" : "Merge",
          sub: d.kind === "merge" && d.joinMode === "all" ? "wait for all" : "first wins",
          status: statuses.get(n.id) ?? "pending",
        };
      }
      return {
        id: n.id,
        type: "live",
        position: n.position,
        data: datum,
        draggable: false,
        connectable: false,
        selectable: false,
        deletable: false,
      };
    });

    // The house electricity treatment (not xyflow's stock dashdraw): each
    // edge is a custom "flow" edge — a static base path plus, while live, the
    // run-graph's travelling accent dash overlay (.spark-wire-flow).
    const liveEdges: Edge[] = flow.edges.map((e) => {
      const src = statuses.get(e.source);
      const tgt = statuses.get(e.target);
      const active =
        src === "running" || src === "blocked" || tgt === "running" || tgt === "blocked";
      const branch = e.data?.branch;
      // tone: the color the live pulse travels in; rest: the static stroke.
      const tone =
        branch === "pass" ? "var(--ok)" : branch === "fail" ? "var(--danger)" : "var(--accent)";
      const rest =
        branch === "pass"
          ? "var(--ok)"
          : branch === "fail"
            ? "var(--danger)"
            : "var(--rule-strong)";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        type: "flow",
        data: { live: active, backEdge: e.data?.backEdge, tone, rest },
        focusable: false,
        selectable: false,
      };
    });

    return { nodes: liveNodes, edges: liveEdges };
  }, [job, statuses, loomLive, current?.nodeId]);

  // Clicking a running node opens its worker's mirror terminal in the sheet.
  const workersRef = useRef(workers);
  workersRef.current = workers;
  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    const ws = workersRef.current;
    const w =
      ws.find((x) => x.nodeId === node.id) ??
      // Single-node legacy looms carry no node attribution — any node click
      // focuses the lone worker.
      (ws.length === 1 ? ws[0] : undefined);
    if (!w) return;
    setPickedAttemptId(w.attemptId);
    setSheetOpen(true);
  }, []);

  // Esc closes the sheet first, then the board. CAPTURE + stopPropagation for
  // the same reason as WorkersView's focus mode: a focused sheet xterm would
  // otherwise swallow Escape and forward it to the agent as an interrupt (the
  // mirror is readOnly, so claiming Esc from it costs nothing). Exempt INPUTs
  // and contenteditables: Esc mid-answer in the blocked strip (or the terminal
  // find overlay) must act on THAT field, not unmount the whole board and
  // discard the draft. xterm's hidden helper is a TEXTAREA, so it stays
  // claimed by this handler.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      if (sheetOpen) setSheetOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, sheetOpen, onClose]);

  const [confirmStop, setConfirmStop] = useState(false);
  const dot = automationDotColor(status);

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
      }}
    >
      {/* ── header — the ONE header: back, identity, stats, actions ──────── */}
      <div
        style={{
          flex: "0 0 48px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 12px",
          borderBottom: "1px solid var(--rule)",
          background: "var(--panel)",
        }}
      >
        <button
          type="button"
          className="spark-btn"
          style={{ height: 26, padding: "0 10px", fontSize: 11.5, flex: "0 0 auto" }}
          onClick={onClose}
          title="Back to the loom detail (Esc)"
        >
          ← Detail
        </button>
        <span
          aria-hidden
          style={{
            flex: "0 0 8px",
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dot,
            boxShadow: loomLive
              ? `0 0 0 3px color-mix(in oklch, ${dot} 18%, transparent), 0 0 10px ${dot}`
              : `0 0 0 3px color-mix(in oklch, ${dot} 18%, transparent)`,
          }}
        />
        <div style={{ flex: "1 1 auto", minWidth: 60, display: "flex", flexDirection: "column", gap: 1 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={job.name}
          >
            {job.name}
          </span>
          <span
            className="spark-mono"
            style={{
              fontSize: 10,
              color: "var(--muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={`${triggerSummary(job.trigger)} · ${loopSummary(job.loop)} · ${jobWorkerSummary(job)}`}
          >
            {triggerSummary(job.trigger)} · {loopSummary(job.loop)} · {jobWorkerSummary(job)}
          </span>
        </div>
        {/* compact stats — one quiet mono line; shrinks with ellipsis, so the
            header can never overlap at narrow widths. */}
        <span
          className="spark-mono spark-num"
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 10.5,
            color: "var(--muted)",
          }}
        >
          <span style={{ color: dot }}>{statusWord(status)}</span>
          {` · pass ${job.state.iteration}/${capLabel(job)} · est. ${fmtUsd(job.state.spentUsd)}`}
          {workers.length > 0 ? ` · ${workers.length} worker${workers.length === 1 ? "" : "s"}` : ""}
          {anyLive && current?.startedAt ? ` · ${fmtElapsed(current.startedAt, now)}` : ""}
          {run && !loomLive ? ` · last run ${run.status}` : ""}
        </span>
        <button
          type="button"
          className="spark-btn"
          style={{ height: 26, padding: "0 10px", fontSize: 11.5, flex: "0 0 auto" }}
          onClick={onOpenWorkersGrid}
          title="Open the full multi-automation worker activity grid"
        >
          Workers grid →
        </button>
        <button
          type="button"
          className="spark-btn is-danger"
          style={{ height: 26, padding: "0 10px", fontSize: 11.5, flex: "0 0 auto" }}
          disabled={!loomLive}
          onClick={() => {
            if (confirmStop) {
              setConfirmStop(false);
              onStop();
            } else {
              setConfirmStop(true);
            }
          }}
          onMouseLeave={() => setConfirmStop(false)}
          title="Stop the loop and kill the live worker"
        >
          {confirmStop ? "Confirm stop" : "Stop"}
        </button>
      </div>

      {/* ── canvas + worker activity sheet ────────────────────────────── */}
      {/* position:relative container: the sheet is an absolute overlay HERE —
          outside ReactFlow's zoom/pan transform layer — so xterm never renders
          under a scaled transform. */}
      <div ref={canvasRef} style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative" }}>
        <div className="loom-flow" style={{ position: "absolute", inset: 0 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={liveNodeTypes}
            edgeTypes={liveEdgeTypes}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            minZoom={0.3}
            maxZoom={1.75}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--rule)" />
            {/* top-right: the bottom slots sit under the terminal sheet. */}
            <Controls position="top-right" showInteractive={false} />
          </ReactFlow>
        </div>

        {/* ── floating worker terminal sheet ─────────────────────────────── */}
        {/* Opened by clicking a worker node; closed via ✕ or Esc. Full-bleed
            horizontally (width invariant — see module comment) but floating:
            rounded top corners + shadow over the canvas, no permanent dock.
            Hidden via visibility with geometry preserved, so hidden mirrors
            are never resized and reopening shows the accumulated frame.
            pointerEvents discipline: nothing here sets an explicit
            "auto"/"visible" that could punch through the hidden board overlay
            (values inherit); only the TerminalPane manages its own pair, and
            its `visible` prop is false whenever the sheet is off screen. */}
        <div
          aria-hidden={!sheetOpen}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: sheetBodyH,
            zIndex: 7,
            display: "flex",
            flexDirection: "column",
            background: "var(--panel)",
            border: "1px solid var(--rule)",
            borderBottom: "none",
            borderRadius: "14px 14px 0 0",
            boxShadow: "var(--lift-hi), 0 -14px 36px color-mix(in oklab, var(--bg) 60%, transparent)",
            overflow: "hidden",
            visibility: sheetOpen ? "inherit" : "hidden",
            pointerEvents: sheetOpen ? "inherit" : "none",
          }}
        >
          {/* drag handle — inside the sheet so overflow:hidden can't clip it */}
          <div
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize the terminal sheet"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 8,
              cursor: "ns-resize",
              zIndex: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 44,
                height: 3,
                borderRadius: 999,
                background: "var(--rule-strong)",
              }}
            />
          </div>

          {/* sheet bar: worker switcher + close */}
          <div
            style={{
              flex: `0 0 ${SHEET_BAR_H}px`,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 10px",
              borderBottom: "1px solid var(--rule)",
            }}
          >
            <span className="spark-eyebrow" style={{ flex: "0 0 auto" }}>
              Worker
            </span>
            <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 6, overflowX: "auto" }}>
              {workers.map((w) => {
                const live = LIVE_ATTEMPT.has(w.status);
                const isCurrent = w.attemptId === current?.attemptId;
                const cdot = w.blocked ? "var(--danger)" : live ? "var(--accent)" : "var(--muted)";
                return (
                  <button
                    key={w.attemptId}
                    type="button"
                    onClick={() => setPickedAttemptId(w.attemptId)}
                    title={`${w.nodeLabel ?? w.automationName} · pass ${w.iteration + 1}${w.blocked ? " · needs you" : ""}`}
                    style={{
                      appearance: "none",
                      flex: "0 0 auto",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      height: 22,
                      padding: "0 9px",
                      borderRadius: 999,
                      border: isCurrent
                        ? "1px solid color-mix(in oklch, var(--accent) 45%, transparent)"
                        : "1px solid var(--rule-soft)",
                      background: isCurrent ? "var(--accent-soft)" : "var(--panel-2)",
                      color: isCurrent ? "var(--ink)" : "var(--ink-dim)",
                      cursor: "default",
                    }}
                    onMouseEnter={(e) => {
                      if (!isCurrent) e.currentTarget.style.background = "var(--hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isCurrent) e.currentTarget.style.background = "var(--panel-2)";
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        flex: "0 0 7px",
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: cdot,
                        // Steady glow while live — no breathing pulse.
                        boxShadow: live && !w.blocked ? `0 0 6px ${cdot}` : undefined,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: isCurrent ? 600 : 500,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: 180,
                      }}
                    >
                      {w.nodeLabel ?? workerModelLabel(w.model)} · p{w.iteration + 1}
                    </span>
                    {w.blocked && (
                      <span className="spark-badge is-danger" style={{ height: 14, fontSize: 8.5 }}>
                        needs you
                      </span>
                    )}
                  </button>
                );
              })}
              {workers.length === 0 && (
                <span className="spark-mono" style={{ fontSize: 10, color: "var(--muted-2)", alignSelf: "center" }}>
                  none yet
                </span>
              )}
            </div>
            {current && (
              <span
                className="spark-mono spark-num"
                style={{ flex: "0 0 auto", fontSize: 10, color: "var(--muted-2)" }}
                title={current.startedAt ? `started ${fmtClock(current.startedAt)}` : undefined}
              >
                {LIVE_ATTEMPT.has(current.status) ? fmtElapsed(current.startedAt, now) : "finished"}
              </span>
            )}
            <button
              type="button"
              className="spark-icon-btn"
              aria-label="Close the worker terminal"
              title="Close the worker activity (Esc)"
              style={{ ["--spark-icon-btn-size"]: "22px", flex: "0 0 auto" } as React.CSSProperties}
              onClick={() => setSheetOpen(false)}
            >
              ✕
            </button>
          </div>

          {/* blocked question strip for the focused worker */}
          {current?.blocked && current.question && current.questionMessageId && (
            <BlockedAnswerStrip
              key={`${current.attemptId}:${current.questionMessageId}`}
              question={current.question}
              onSend={(text) =>
                onAnswer(current.runId, current.questionMessageId as string, text)
              }
            />
          )}

          {/* Structured activity views stay mounted and visibility-switched so
              changing workers preserves scroll and streaming state. */}
          <div style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--bg)" }}>
            {workers.length === 0 ? (
              <div
                className="spark-mono"
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  color: "var(--muted-2)",
                }}
              >
                {loomLive ? "Worker starting…" : "No live worker. Run the automation to see it here."}
              </div>
            ) : (
              workers.map((w) => (
                <div
                  key={w.attemptId}
                  style={{
                    position: "absolute",
                    inset: 0,
                    padding: 4,
                    visibility: w.attemptId === current?.attemptId ? "inherit" : "hidden",
                    pointerEvents: w.attemptId === current?.attemptId ? "inherit" : "none",
                  }}
                >
                  <WorkerActivityLog
                    worker={w}
                    visible={shown && sheetOpen && w.attemptId === current?.attemptId}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── sheet structured worker activity ────────────────────────────────────────

function WorkerActivityLog({
  worker,
  visible,
}: {
  worker: AutomationWorkerInfo;
  visible: boolean;
}): React.ReactElement {
  const live = LIVE_ATTEMPT.has(worker.status);
  const [content, setContent] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!worker.stdoutLogPath) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const file = await window.spark.fs.readTextTail(worker.stdoutLogPath!, 80_000);
        if (disposed) return;
        setContent(file.content);
        setFailure(null);
      } catch (err) {
        // Launch can precede log creation by one render, which is the only
        // failure worth hiding; anything else surfaces in the pane.
        const described = describeWorkerLogFailure(err);
        if (!disposed && described) setFailure(described);
      }
    };
    void refresh();
    if (!visible || !live) return () => { disposed = true; };
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [live, visible, worker.stdoutLogPath]);

  if (!content.trim()) {
    return (
      <div
        className="spark-mono"
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 16px",
          textAlign: "center",
          fontSize: 11,
          color: failure ? "var(--danger)" : "var(--muted-2)",
        }}
      >
        {failure ?? (live ? "Worker starting…" : "No activity was recorded.")}
      </div>
    );
  }
  return (
    <pre
      className="spark-mono"
      style={{
        position: "absolute",
        inset: 0,
        margin: 0,
        padding: "14px 16px",
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "var(--ink-dim)",
        fontSize: 11.5,
        lineHeight: 1.58,
      }}
    >
      {content}
    </pre>
  );
}

// ── blocked-worker answer strip ──────────────────────────────────────────────

function BlockedAnswerStrip({
  question,
  onSend,
}: {
  question: string;
  onSend: (text: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState("");
  const send = (): void => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        background: "var(--danger-soft)",
        borderBottom: "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          color: "var(--ink)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={question}
      >
        {question}
      </span>
      <input
        className="spark-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Answer the worker…"
        style={{ flex: "0 0 260px", height: 24, fontSize: 11 }}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
        }}
      />
      <button
        type="button"
        className="spark-btn is-primary"
        style={{ height: 24, fontSize: 10.5 }}
        disabled={!draft.trim()}
        onClick={send}
      >
        Send
      </button>
    </div>
  );
}

// ── live edge renderer ───────────────────────────────────────────────────────

// The board's "electricity": a static base path plus, while the edge is live,
// the run-graph's travelling dash overlay (same .spark-wire-flow keyframes as
// GraphWires — the house convention for "this wire is carrying work").
function LiveFlowEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps): React.ReactElement {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const live = data?.live === true;
  const tone = (data?.tone as string) ?? "var(--accent)";
  const rest = (data?.rest as string) ?? "var(--rule-strong)";
  return (
    <g style={{ pointerEvents: "none" }}>
      <path
        d={path}
        fill="none"
        stroke={live ? `color-mix(in oklch, ${tone} 32%, transparent)` : rest}
        strokeWidth={live ? 1.8 : 1.6}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        strokeDasharray={data?.backEdge && !live ? "5 4" : undefined}
      />
      {live && (
        <path
          d={path}
          className="spark-wire-flow"
          fill="none"
          stroke={tone}
          strokeWidth={2}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{ filter: "drop-shadow(0 0 3px var(--accent-glow))" }}
        />
      )}
    </g>
  );
}

const liveEdgeTypes = { flow: LiveFlowEdge };

// ── live node renderer ───────────────────────────────────────────────────────

const HANDLE_STYLE: React.CSSProperties = {
  width: 9,
  height: 9,
  background: "var(--panel-3)",
  border: "1.5px solid var(--rule-strong)",
  pointerEvents: "none",
};

interface StatusLook {
  border: string;
  background: string;
  // Steady glow tone for the actively-working states — never a scale/opacity
  // pulse (the user rejected "breathing" boxes; electricity + glow instead).
  glow: "accent" | "danger" | null;
  badge?: { text: string; color: string; borderColor?: string };
  dashed?: boolean;
  dim?: boolean;
}

function lookFor(status: LiveNodeStatus): StatusLook {
  switch (status) {
    case "running":
      return {
        border: "var(--accent-edge)",
        background: "color-mix(in oklch, var(--accent) 10%, var(--panel))",
        glow: "accent",
        badge: {
          text: "running",
          color: "var(--accent-text)",
          borderColor: "var(--accent)",
        },
      };
    case "blocked":
      return {
        border: "color-mix(in oklch, var(--danger) 55%, transparent)",
        // Opaque (mixed onto the panel, not transparent) so chamfered shapes
        // can layer it over their border backing without bleed-through.
        background: "color-mix(in oklch, var(--danger) 12%, var(--panel))",
        glow: "danger",
        badge: { text: "needs you", color: "var(--danger)" },
      };
    case "succeeded":
      return {
        border: "color-mix(in oklch, var(--ok) 38%, transparent)",
        background: "color-mix(in oklch, var(--ok) 6%, var(--panel))",
        glow: null,
        badge: { text: "done", color: "var(--ok)" },
      };
    case "failed":
      return {
        border: "color-mix(in oklch, var(--danger) 45%, transparent)",
        background: "color-mix(in oklch, var(--danger) 7%, var(--panel))",
        glow: null,
        badge: { text: "failed", color: "var(--danger)" },
      };
    case "skipped":
      return {
        border: "var(--rule-soft)",
        background: "var(--panel)",
        glow: null,
        badge: { text: "skipped", color: "var(--muted-2)" },
        dashed: true,
        dim: true,
      };
    default:
      return { border: "var(--rule-soft)", background: "var(--panel)", glow: null };
  }
}

// Steady status glow as a box-shadow list (accent = the house --shadow-glow).
function statusShadow(look: StatusLook, docked?: boolean): string {
  const parts: string[] = [];
  if (look.glow === "accent") parts.push("var(--shadow-glow)");
  else if (look.glow === "danger")
    parts.push(
      "0 0 0 1px color-mix(in oklch, var(--danger) 45%, transparent)",
      "0 0 24px color-mix(in oklch, var(--danger) 26%, transparent)",
    );
  else parts.push("var(--shadow-1)");
  if (docked) parts.push("0 0 0 2px var(--accent-soft)");
  return parts.join(", ");
}


function NodeBadge({ badge }: { badge: NonNullable<StatusLook["badge"]> }): React.ReactElement {
  return (
    <span
      className="spark-badge"
      style={{
        color: badge.color,
        borderColor: `color-mix(in oklch, ${badge.borderColor ?? badge.color} 32%, transparent)`,
      }}
    >
      {badge.text}
    </span>
  );
}

function LiveNode({ data }: NodeProps): React.ReactElement {
  const d = data as LiveNodeDatum;
  switch (d.kind) {
    case "trigger":
      return <TriggerCard d={d} />;
    case "guard":
      return <GuardCard d={d} />;
    case "merge":
      return <MergeCard d={d} />;
    default:
      return <WorkerCard d={d} />;
  }
}

// ── node cards — the editor's silhouette language + live status jewelry ─────
// Role is told the same way the editor tells it (icon tile, role-toned top
// rule, trigger's rounded-left edge); STATUS is told by the border color,
// a steady glow, and a badge — never a pulse.

function cardBase(look: StatusLook, docked?: boolean): React.CSSProperties {
  return {
    // No overflow:hidden — the card is the containing block for its xyflow
    // handles (right/left: -4px), which would be half-clipped otherwise.
    position: "relative",
    fontFamily: "var(--font-sans)",
    cursor: "default",
    boxSizing: "border-box",
    borderRadius: "var(--radius-surface)",
    border: `1px ${look.dashed ? "dashed" : "solid"} ${look.border}`,
    background: look.background,
    opacity: look.dim ? 0.6 : undefined,
    boxShadow: statusShadow(look, docked),
  };
}

function CardTitle({ text }: { text: string }): React.ReactElement {
  return (
    <span
      title={text}
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: "var(--ink)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {text}
    </span>
  );
}

function CardMeta({ text }: { text: string }): React.ReactElement {
  return (
    <span
      className="spark-mono"
      title={text}
      style={{
        fontSize: 9.5,
        color: "var(--muted)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {text}
    </span>
  );
}

// Trigger — rounded left edge: the pass flows out of here (same silhouette as
// the editor's trigger card).
const LIVE_TRIGGER_RADIUS = "999px var(--radius-surface) var(--radius-surface) 999px";

function TriggerCard({ d }: { d: LiveNodeDatum }): React.ReactElement {
  // Fired = a pass is in flight somewhere downstream. The trigger itself is
  // never "the one running", so it must NOT light up (only the executing
  // node glows) — a fired trigger gets a modest warm tint, no glow, no badge.
  const look: StatusLook = d.fired
    ? {
        border: "color-mix(in oklch, var(--warn) 38%, var(--rule-soft))",
        background: "color-mix(in oklch, var(--warn) 6%, var(--panel))",
        glow: null,
      }
    : lookFor("pending");
  return (
    <div
      style={{
        ...cardBase(look),
        width: 212,
        borderRadius: LIVE_TRIGGER_RADIUS,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 13px 10px 15px",
      }}
    >
      <TopRule tone="var(--warn)" left={34} />
      <Medallion icon={<LoomIcon kind="trigger" tone="var(--warn)" size={16} />} tone="var(--warn)" size={32} />
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
        <span className="spark-eyebrow" style={{ fontSize: 8.5 }}>
          {d.eyebrow}
        </span>
        <CardTitle text={d.title} />
        <CardMeta text={d.sub} />
      </div>
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
}

// Worker — icon tile + role-toned top rule (same silhouette as the editor).
function WorkerCard({ d }: { d: LiveNodeDatum }): React.ReactElement {
  const look = lookFor(d.status);
  const tone = WORKER_TONE;
  return (
    <div style={{ ...cardBase(look, d.docked), width: 232 }}>
      <TopRule tone={tone} />
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 12px 8px 13px" }}>
        <Medallion icon={<LoomIcon kind="worker" tone={tone} size={16} />} tone={tone} size={32} />
        <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="spark-eyebrow" style={{ fontSize: 8.5 }}>
              {d.eyebrow}
            </span>
            <span style={{ flex: 1 }} />
            {look.badge && <NodeBadge badge={look.badge} />}
          </div>
          <CardTitle text={d.title} />
          <CardMeta text={d.sub} />
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
}

// Guard — a decision: labelled pass port exits high, fail port exits low
// (the editor's guard anatomy, plus live status).
function GuardCard({ d }: { d: LiveNodeDatum }): React.ReactElement {
  const look = lookFor(d.status);
  return (
    <div
      style={{
        ...cardBase(look),
        width: 224,
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "11px 44px 11px 13px",
      }}
    >
      <TopRule tone="var(--ok)" />
      <Medallion icon={<LoomIcon kind="guard" tone="var(--ok)" size={16} />} tone="var(--ok)" size={32} />
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="spark-eyebrow" style={{ fontSize: 8.5 }}>
            {d.eyebrow}
          </span>
          {look.badge && <NodeBadge badge={look.badge} />}
        </div>
        <CardTitle text={d.title} />
        <CardMeta text={d.sub} />
      </div>
      {(["pass", "fail"] as const).map((port) => (
        <span
          key={port}
          className="spark-mono"
          aria-hidden
          style={{
            position: "absolute",
            right: 9,
            top: port === "pass" ? "32%" : "68%",
            transform: "translateY(-50%)",
            fontSize: 8,
            fontWeight: 600,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: `color-mix(in oklch, ${port === "pass" ? "var(--ok)" : "var(--danger)"} 75%, var(--muted))`,
          }}
        >
          {port}
        </span>
      ))}
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />
      <Handle
        id="pass"
        type="source"
        position={Position.Right}
        style={{
          ...HANDLE_STYLE,
          top: "32%",
          borderColor: "var(--ok)",
          background: "color-mix(in oklch, var(--ok) 40%, var(--panel-3))",
        }}
        isConnectable={false}
      />
      <Handle
        id="fail"
        type="source"
        position={Position.Right}
        style={{
          ...HANDLE_STYLE,
          top: "68%",
          borderColor: "var(--danger)",
          background: "color-mix(in oklch, var(--danger) 40%, var(--panel-3))",
        }}
        isConnectable={false}
      />
    </div>
  );
}

// Merge — branches come back together.
function MergeCard({ d }: { d: LiveNodeDatum }): React.ReactElement {
  const look = lookFor(d.status);
  return (
    <div
      style={{
        ...cardBase(look),
        width: 200,
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "11px 13px",
      }}
    >
      <TopRule tone="var(--info)" />
      <Medallion icon={<LoomIcon kind="merge" tone="var(--info)" size={16} />} tone="var(--info)" size={32} />
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="spark-eyebrow" style={{ fontSize: 8.5 }}>
            {d.eyebrow}
          </span>
          {look.badge && <NodeBadge badge={look.badge} />}
        </div>
        <CardTitle text={d.title} />
        <CardMeta text={d.sub} />
      </div>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
}

const liveNodeTypes = { live: LiveNode };

// ── live status derivation ───────────────────────────────────────────────────

/** Per-node execution status for the board: the run's loomPass is the source
 *  of truth when present; live workers overlay "running"/"blocked" (they are
 *  fresher than the 'blocked' status commit); a settled legacy run without a
 *  loomPass falls back to painting its worker nodes with the run outcome. */
function deriveNodeStatuses(
  job: ScheduledJob,
  run: RunState | null,
  workers: AutomationWorkerInfo[],
): Map<string, LiveNodeStatus> {
  const graph = graphForJob(job);
  const map = new Map<string, LiveNodeStatus>();
  for (const n of graph.nodes) map.set(n.id, "pending");

  const pass = run?.loomPass;
  if (pass) {
    for (const [id, st] of Object.entries(pass.nodeStates)) {
      if (map.has(id)) map.set(id, st.status);
    }
  } else if (run && !workers.some((w) => LIVE_ATTEMPT.has(w.status))) {
    // Pre-loomPass single-node runs: settle the worker nodes by run outcome.
    const settled: LiveNodeStatus | null =
      run.status === "complete" ? "succeeded" : run.status === "failed" ? "failed" : null;
    if (settled) {
      for (const n of graph.nodes) {
        if (n.kind === "worker") map.set(n.id, settled);
      }
    }
  }

  // Live workers are the freshest signal for "executing right now".
  const soleNodeId = graph.nodes.length === 1 ? graph.nodes[0].id : undefined;
  for (const w of workers) {
    if (!LIVE_ATTEMPT.has(w.status)) continue;
    const id = w.nodeId ?? soleNodeId;
    if (id && map.has(id)) map.set(id, w.blocked ? "blocked" : "running");
  }
  return map;
}
