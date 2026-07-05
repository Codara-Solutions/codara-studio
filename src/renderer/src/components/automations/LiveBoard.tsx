import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow } from "@xyflow/react";
import type { Edge, Node, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  AutomationWorkerInfo,
  RunState,
  ScheduledJob,
  ShellInfo,
} from "@shared/types";
import { TerminalPane } from "../Terminal/TerminalPane";
import {
  automationDotColor,
  capLabel,
  fmtClock,
  fmtElapsed,
  fmtUsd,
  statusWord,
  triggerSummary,
} from "./presentation";
import { TRIGGER_ID, flowFromGraph, graphForJob } from "./flow/model";
import {
  hasCanonicalWorkerPane,
  subscribeCanonicalWorkerPanes,
} from "./worker-pane-registry";

// LiveBoard — the "whiteboard" view of ONE running loom: the loom graph on a
// full read-only ReactFlow canvas with LIVE execution state (the executing
// node pulses, settled nodes tint, the active edges animate), plus a worker
// dock INSIDE the canvas viewport hosting the live worker terminal(s).
//
// Terminal hosting: the dock panes are READ-ONLY MIRRORS of the same pty the
// Workers grid's canonical WorkerPane is attached to (TerminalPane readOnly +
// the pty.spawn `mirror` flag). A mirror provably cannot garble the TUI: it
// forwards no keystrokes, sends no pty.resize (neither renderer-side nor via
// main's existing-session spawn branch — the mirror flag skips that resize),
// never pauses/detaches the session on unmount, and never captures/replays a
// flattened snapshot. The canonical pane's behavior is bit-identical whether
// or not a mirror exists. Mount is gated on worker-pane-registry so the
// canonical pane always attaches FIRST (it owns the raw-tail replay and the
// pty's dimensions). Trade-off accepted: a mirror that attaches mid-session
// starts from the TUI's next repaint rather than the full frame — the full
// canonical terminal is one click away ("Workers grid →").
//
// The dock is an untransformed overlay positioned within the canvas CONTAINER
// (never inside ReactFlow's zoom/pan transform layer — scaled transforms break
// xterm rendering and mouse targeting). It is full-bleed horizontally so the
// mirror xterm is at least as wide as any canonical grid cell / focus pane
// (same hub rect minus identical 4px body padding), keeping mirror cols >=
// pty cols in every layout — a narrower mirror would wrap the TUI's full-width
// frame lines. Collapsing the dock hides it via visibility (geometry kept), so
// hidden mirrors are never resized; and because mirrors are readOnly, even a
// dock drag-resize can only ever re-fit the mirrors locally — the pty itself
// is never SIGWINCH'd from here.

// Same attach-only placeholder shell contract as WorkersView / ChatPanel: the
// pty already exists; with the readOnly mirror flag main refuses to spawn
// anything for this shell, so a stale id can never launch a real process.
const MIRROR_SHELL: ShellInfo = {
  id: "spark-loom-worker-mirror",
  label: "Loom worker mirror",
  exe: "noop",
  args: [],
  family: "other",
};

// Mirrors WorkersView's LIVE_ATTEMPT (module-private there): attempt statuses
// that mean the worker process is still going.
const LIVE_ATTEMPT = new Set(["preparing", "prompt_ready", "launching", "running", "finishing"]);

const DOCK_BAR_H = 34;
const DOCK_MIN_H = 140;

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
  // This node's worker is the one focused in the dock.
  docked?: boolean;
}

export interface LiveBoardProps {
  job: ScheduledJob;
  // The loom's live run (job.state.currentRunId). Null once the pass settles —
  // the board retains the last-seen run so the final state stays viewable.
  liveRun: RunState | null;
  // Workers of THIS automation only (live + briefly-lingering exited ones).
  workers: AutomationWorkerInfo[];
  // On screen right now (hub tab active + looms sub-tab + view mode). Drives
  // terminal visibility and the ticking clock; the board stays mounted while
  // hidden so the canvas viewport and mirror xterms survive sub-tab flips.
  shown: boolean;
  scrollbackLineLimit: number;
  onClose: () => void;
  onOpenWorkersGrid: () => void;
  onStop: () => void;
  onAnswer: (runId: string, answer: string) => void;
}

export default function LiveBoard({
  job,
  liveRun,
  workers,
  shown,
  scrollbackLineLimit,
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

  // ── dock state ──────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dockH, setDockH] = useState(300);
  // Track the canvas height so the dock body can be CLAMPED at render time —
  // without this, shrinking the window after a tall drag would leave the
  // absolutely-positioned body poking above the canvas over the header.
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
  const maxDockH = canvasH > 0 ? Math.max(DOCK_MIN_H, canvasH - DOCK_BAR_H - 90) : null;
  // Effective body height: the user's dragged height, window-shrink-clamped.
  // Clamping resizes the mirrors, but they are readOnly — only a local xterm
  // re-fit, never a SIGWINCH to the worker pty.
  const dockBodyH = maxDockH === null ? dockH : Math.min(dockH, maxDockH);
  const dockSizedRef = useRef(false);
  // Size the dock once from the real canvas height (~42%). Never re-derived on
  // later resizes — the user's drag height wins from then on.
  useEffect(() => {
    if (dockSizedRef.current || canvasH <= 0) return;
    dockSizedRef.current = true;
    setDockH(Math.max(DOCK_MIN_H, Math.round(canvasH * 0.42)));
  }, [canvasH]);

  const [pickedAttemptId, setPickedAttemptId] = useState<string | null>(null);
  // Focused dock worker: explicit pick while it still exists, else blocked
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

  const anyLive = workers.some((w) => LIVE_ATTEMPT.has(w.status));

  // One shared 1s clock for elapsed readouts, ticking only while watchable.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!shown || !anyLive) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [shown, anyLive]);

  // Dock height drag. Applies to the VISIBLE mirror only in effect — hidden
  // sibling mirrors share the same box and re-fit locally, but being readOnly
  // they can never push a resize to the pty.
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Drag from the VISUAL height (clamped), so a window-shrunk dock doesn't
      // jump to its stored pre-shrink height on the first pointer move.
      dragRef.current = { startY: e.clientY, startH: dockBodyH };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [dockBodyH],
  );
  const onDragMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const s = dragRef.current;
      if (!s) return;
      const maxH = maxDockH ?? Math.max(DOCK_MIN_H, 600 - DOCK_BAR_H - 90);
      const next = Math.min(maxH, Math.max(DOCK_MIN_H, s.startH + (s.startY - e.clientY)));
      setDockH(next);
    },
    [maxDockH],
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
        const engineLine =
          w.engine === "auto"
            ? "Auto · agent picks"
            : [w.engine === "claude" ? "Claude" : "Codex", w.model, w.effort]
                .filter(Boolean)
                .join(" · ");
        datum = {
          kind: "worker",
          glyph: w.engine === "codex" ? "◆" : w.engine === "claude" ? "◇" : "⟲",
          eyebrow: "Worker",
          title: d.label || "Worker",
          sub: engineLine,
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

    const liveEdges: Edge[] = flow.edges.map((e) => {
      const src = statuses.get(e.source);
      const tgt = statuses.get(e.target);
      const active =
        src === "running" || src === "blocked" || tgt === "running" || tgt === "blocked";
      const branch = e.data?.branch;
      const stroke =
        branch === "pass"
          ? "var(--ok)"
          : branch === "fail"
            ? "var(--danger)"
            : active
              ? "var(--accent)"
              : "var(--rule-strong)";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        // Default bezier edge; `animated` rides xyflow's stock dashdraw CSS,
        // so live edges must NOT set an inline strokeDasharray (inline wins
        // over the animation's dasharray). Back-edges keep their static dash.
        animated: active,
        style: {
          stroke,
          strokeWidth: active ? 2.25 : 1.75,
          ...(e.data?.backEdge && !active ? { strokeDasharray: "5 4" } : {}),
        },
        focusable: false,
        selectable: false,
      };
    });

    return { nodes: liveNodes, edges: liveEdges };
  }, [job, statuses, loomLive, current?.nodeId]);

  // Clicking a running node focuses its worker's terminal in the dock.
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
    setCollapsed(false);
  }, []);

  // Esc closes the board. CAPTURE + stopPropagation for the same reason as
  // WorkersView's focus mode: a focused dock xterm would otherwise swallow
  // Escape and forward it to the agent as an interrupt (the mirror is
  // readOnly, so claiming Esc from it costs nothing). Exempt INPUTs and
  // contenteditables: Esc mid-answer in the blocked strip (or the terminal
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
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, onClose]);

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
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div
        style={{
          flex: "0 0 40px",
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
          style={{ height: 26, padding: "0 10px", fontSize: 11.5 }}
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
            boxShadow: `0 0 0 3px color-mix(in oklch, ${dot} 18%, transparent)`,
            animation: status === "running" ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
          title={job.name}
        >
          {job.name}
        </span>
        <span className="spark-eyebrow" style={{ flex: "0 0 auto" }}>
          Live board
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="spark-btn"
          style={{ height: 26, padding: "0 10px", fontSize: 11.5 }}
          onClick={onOpenWorkersGrid}
          title="Open the full multi-automation Workers grid (the canonical, interactive terminals)"
        >
          Workers grid →
        </button>
        <button
          type="button"
          className="spark-btn is-danger"
          style={{ height: 26, padding: "0 10px", fontSize: 11.5 }}
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

      {/* ── canvas + overlays ──────────────────────────────────────────── */}
      {/* position:relative container: the chip row and the dock are absolute
          overlays HERE — outside ReactFlow's zoom/pan transform layer — so
          xterm never renders under a scaled transform. */}
      <div ref={canvasRef} style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative" }}>
        <div className="loom-flow" style={{ position: "absolute", inset: 0 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={liveNodeTypes}
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
            {/* top-right: the default bottom-left slot sits under the dock. */}
            <Controls position="top-right" showInteractive={false} />
          </ReactFlow>
        </div>

        {/* status chip row (top-left, above the canvas) */}
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            zIndex: 6,
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            paddingRight: 56, // keep clear of nothing in particular; breathing room
          }}
        >
          <BoardChip>
            <span aria-hidden style={{ color: dot }}>●</span> {statusWord(status)}
          </BoardChip>
          <BoardChip mono>
            pass {job.state.iteration}/{capLabel(job)}
          </BoardChip>
          <BoardChip mono>est. {fmtUsd(job.state.spentUsd)}</BoardChip>
          {workers.length > 0 && (
            <BoardChip mono>
              {workers.length} worker{workers.length === 1 ? "" : "s"}
            </BoardChip>
          )}
          {anyLive && current?.startedAt && (
            <BoardChip mono>{fmtElapsed(current.startedAt, now)}</BoardChip>
          )}
          {run && !loomLive && (
            <BoardChip mono>
              last run · {run.status}
            </BoardChip>
          )}
        </div>

        {/* ── worker dock ────────────────────────────────────────────────── */}
        {/* Bottom overlay. The chip BAR is always at the bottom edge; the
            terminal BODY floats above it at a fixed height and hides via
            visibility when collapsed (geometry preserved → hidden mirrors are
            never resized; the whiteboard shows through, workers one click
            away). pointerEvents discipline: nothing here sets an explicit
            "auto"/"visible" that could punch through the hidden board overlay
            (values inherit); only the TerminalPane manages its own pair, and
            its `visible` prop is false whenever the board is off screen. */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 7 }}>
          {/* body */}
          <div
            aria-hidden={collapsed}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: DOCK_BAR_H,
              height: dockBodyH,
              display: "flex",
              flexDirection: "column",
              background: "var(--panel)",
              borderTop: "1px solid var(--rule)",
              boxShadow: "0 -8px 24px color-mix(in oklch, var(--bg) 55%, transparent)",
              visibility: collapsed ? "hidden" : "inherit",
              pointerEvents: collapsed ? "none" : "inherit",
            }}
          >
            {/* drag handle */}
            <div
              role="separator"
              aria-orientation="horizontal"
              title="Drag to resize the terminal dock"
              onPointerDown={onDragStart}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onPointerCancel={onDragEnd}
              style={{
                position: "absolute",
                top: -4,
                left: 0,
                right: 0,
                height: 9,
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

            {/* blocked question strip for the focused worker */}
            {current?.blocked && current.question && (
              <BlockedAnswerStrip
                key={current.attemptId}
                question={current.question}
                onSend={(text) => onAnswer(current.runId, text)}
              />
            )}

            {/* mirror terminals — ALL mounted, visibility-switched, sharing the
                same box so a chip switch never resizes anything. */}
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
                  {loomLive ? "Worker starting…" : "No live worker — run the loom to see it here."}
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
                    <MirrorTerminal
                      worker={w}
                      visible={shown && !collapsed && w.attemptId === current?.attemptId}
                      scrollbackLineLimit={scrollbackLineLimit}
                    />
                  </div>
                ))
              )}
            </div>
          </div>

          {/* bar (always visible at the bottom edge) */}
          <div
            style={{
              position: "relative",
              height: DOCK_BAR_H,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 10px",
              background: "var(--panel)",
              borderTop: "1px solid var(--rule)",
            }}
          >
            <span className="spark-eyebrow" style={{ flex: "0 0 auto" }}>
              Workers
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
                    onClick={() => {
                      setPickedAttemptId(w.attemptId);
                      setCollapsed(false);
                    }}
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
                        animation:
                          live && !w.blocked ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
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
                      {w.nodeLabel ?? (w.engine === "codex" ? "Codex" : "Claude")} · p{w.iteration + 1}
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
              aria-label={collapsed ? "Expand worker dock" : "Collapse worker dock"}
              aria-expanded={!collapsed}
              title={collapsed ? "Show the worker terminal" : "Collapse — whiteboard unobstructed"}
              style={{ ["--spark-icon-btn-size"]: "22px", flex: "0 0 auto" } as React.CSSProperties}
              onClick={() => setCollapsed((c) => !c)}
            >
              {collapsed ? "▴" : "▾"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── dock terminal (read-only mirror) ─────────────────────────────────────────

function MirrorTerminal({
  worker,
  visible,
  scrollbackLineLimit,
}: {
  worker: AutomationWorkerInfo;
  visible: boolean;
  scrollbackLineLimit: number;
}): React.ReactElement {
  // Gate on the CANONICAL pane being mounted (WorkersView's WorkerPane, which
  // is kept alive whenever the Automations tab is active). This both prevents
  // the mirror from ever being the first attacher (the canonical pane must win
  // the raw-tail replay + own the pty size) and guarantees the pty exists, so
  // the mirror spawn's session-must-exist check can't trip in practice.
  const canonicalMounted = useSyncExternalStore(
    subscribeCanonicalWorkerPanes,
    () => hasCanonicalWorkerPane(worker.attemptId),
  );
  const live = LIVE_ATTEMPT.has(worker.status);
  if (!canonicalMounted) {
    return (
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
        {live ? "Connecting to worker terminal…" : "Worker exited — terminal released."}
      </div>
    );
  }
  return (
    <TerminalPane
      key={`loom-mirror:${worker.attemptId}`}
      sessionId={worker.attemptId}
      shell={MIRROR_SHELL}
      visible={visible}
      scrollbackLineLimit={scrollbackLineLimit}
      initialCwd={worker.cwd}
      // readOnly = mirror mode: no keystrokes, no pty.resize (renderer-side
      // AND main's spawn-branch resize via the mirror flag), no pause/detach
      // on unmount, no snapshot capture/replay, no runtime-state reports. The
      // canonical WorkerPane's pty stream is bit-identical with or without
      // this pane. NOT rawTailReattach — that unmount path calls pty.detach,
      // which would null main's renderer sink out from under the canonical
      // pane and freeze it.
      readOnly
      // Keep the mirror's own buffer complete while the board is hidden or the
      // dock shows a sibling, so a reveal shows the accumulated frame instead
      // of a capped hidden-buffer remnant. Same contract as the worker panes.
      writeWhileHidden
    />
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

// ── chip ─────────────────────────────────────────────────────────────────────

function BoardChip({
  mono,
  children,
}: {
  mono?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      className={mono ? "spark-mono spark-num" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 24,
        padding: "0 10px",
        borderRadius: 999,
        border: "1px solid var(--rule)",
        background: "var(--panel)",
        boxShadow: "var(--shadow-1)",
        fontSize: 10.5,
        color: "var(--ink-dim)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

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
  pulse: boolean;
  badge?: { text: string; color: string };
  dashed?: boolean;
  dim?: boolean;
}

function lookFor(status: LiveNodeStatus): StatusLook {
  switch (status) {
    case "running":
      return {
        border: "var(--accent-edge)",
        background: "color-mix(in oklch, var(--accent) 10%, var(--panel))",
        pulse: true,
        badge: { text: "running", color: "var(--accent)" },
      };
    case "blocked":
      return {
        border: "color-mix(in oklch, var(--danger) 55%, transparent)",
        background: "var(--danger-soft)",
        pulse: true,
        badge: { text: "needs you", color: "var(--danger)" },
      };
    case "succeeded":
      return {
        border: "color-mix(in oklch, var(--ok) 38%, transparent)",
        background: "color-mix(in oklch, var(--ok) 6%, var(--panel))",
        pulse: false,
        badge: { text: "done", color: "var(--ok)" },
      };
    case "failed":
      return {
        border: "color-mix(in oklch, var(--danger) 45%, transparent)",
        background: "color-mix(in oklch, var(--danger) 7%, var(--panel))",
        pulse: false,
        badge: { text: "failed", color: "var(--danger)" },
      };
    case "skipped":
      return {
        border: "var(--rule-soft)",
        background: "var(--panel)",
        pulse: false,
        badge: { text: "skipped", color: "var(--muted-2)" },
        dashed: true,
        dim: true,
      };
    default:
      return { border: "var(--rule-soft)", background: "var(--panel)", pulse: false };
  }
}

function LiveNode({ data }: NodeProps): React.ReactElement {
  const d = data as LiveNodeDatum;
  const isTrigger = d.kind === "trigger";
  const look = isTrigger
    ? d.fired
      ? lookFor("running")
      : lookFor("pending")
    : lookFor(d.status);
  const badge = isTrigger ? undefined : look.badge;
  return (
    <div
      className="loom-node"
      style={{
        width: 210,
        borderRadius: "var(--radius-surface)",
        fontFamily: "var(--font-sans)",
        overflow: "hidden",
        cursor: "default",
        border: `1px ${look.dashed ? "dashed" : "solid"} ${look.border}`,
        background: look.background,
        opacity: look.dim ? 0.6 : undefined,
        boxShadow: d.docked
          ? "var(--lift-hi), 0 0 0 2px var(--accent-soft)"
          : "var(--shadow-1)",
        animation: look.pulse ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
      }}
    >
      {!isTrigger && <Handle type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />}
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 9px 5px" }}>
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: 6,
            fontSize: 11,
            background: isTrigger
              ? "color-mix(in oklch, var(--warn) 16%, var(--panel-2))"
              : "color-mix(in oklch, var(--accent) 14%, var(--panel-2))",
            color: isTrigger ? "var(--warn)" : "var(--accent)",
            flex: "0 0 auto",
          }}
        >
          {d.glyph}
        </span>
        <span className="spark-eyebrow" style={{ fontSize: 8.5 }}>{d.eyebrow}</span>
        <span style={{ flex: 1 }} />
        {badge && (
          <span
            className="spark-badge"
            style={{
              color: badge.color,
              borderColor: `color-mix(in oklch, ${badge.color} 32%, transparent)`,
            }}
          >
            {badge.text}
          </span>
        )}
      </div>
      <div style={{ padding: "0 9px 8px", display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={d.title}
        >
          {d.title}
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
          title={d.sub}
        >
          {d.sub}
        </span>
      </div>
      {d.kind === "guard" ? (
        <>
          <Handle
            id="pass"
            type="source"
            position={Position.Right}
            style={{ ...HANDLE_STYLE, top: "34%", borderColor: "var(--ok)" }}
            isConnectable={false}
          />
          <Handle
            id="fail"
            type="source"
            position={Position.Right}
            style={{ ...HANDLE_STYLE, top: "66%", borderColor: "var(--danger)" }}
            isConnectable={false}
          />
        </>
      ) : (
        <Handle type="source" position={Position.Right} style={HANDLE_STYLE} isConnectable={false} />
      )}
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
