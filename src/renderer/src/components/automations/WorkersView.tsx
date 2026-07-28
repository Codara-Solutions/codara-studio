import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AutomationStatus,
  AutomationWorkerInfo,
  ScheduledJob,
} from "@shared/types";
import { automationDotColor, fmtClock, fmtElapsed } from "./presentation";

// The Workers sub-tab: every live automation worker as an ordered activity
// stream from Claude Agent SDK or Codex App Server. Ordinary Cora workers keep
// their visible native CLI panes; unattended looms use structured transports.
//
// Two clarity layers on top of the raw grid:
//   • panes are GROUPED into a collapsible section per automation, so a busy
//     workspace reads as "which loom is doing what" instead of a wall of cells;
//   • a FOCUS mode blows one pane up to fill the view while the rest shrink to a
//     chip strip. Both are pure layout/visibility changes — every WorkerPane
//     stays mounted the whole time so its live Ink TUI never has to reattach.

const LIVE_ATTEMPT = new Set(["preparing", "prompt_ready", "launching", "running", "finishing"]);

interface WorkerGroup {
  automationId: string;
  workers: AutomationWorkerInfo[];
}

export interface WorkersViewProps {
  workers: AutomationWorkerInfo[];
  jobs: ScheduledJob[];
  scrollbackLineLimit: number;
  visible: boolean;
  onStopLoom: (automationId: string) => void;
  onSelectLoom: (automationId: string) => void;
  onNewLoom: () => void;
}

export default function WorkersView({
  workers,
  jobs,
  scrollbackLineLimit,
  visible,
  onStopLoom,
  onSelectLoom,
  onNewLoom,
}: WorkersViewProps): React.ReactElement {
  // Focus mode: one pane fills the view, the rest collapse to a chip strip.
  // Held by attemptId so it survives a list refresh; cleared if that worker
  // drops off (below).
  const [focusedAttemptId, setFocusedAttemptId] = useState<string | null>(null);
  // Component-local collapse per automation id (no persistence). Default
  // expanded — a Set of the collapsed ids.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const groups = useMemo<WorkerGroup[]>(() => {
    const map = new Map<string, AutomationWorkerInfo[]>();
    for (const w of workers) {
      const arr = map.get(w.automationId);
      if (arr) arr.push(w);
      else map.set(w.automationId, [w]);
    }
    return [...map.entries()].map(([automationId, ws]) => ({ automationId, workers: ws }));
  }, [workers]);

  const anyLive = useMemo(() => workers.some((w) => LIVE_ATTEMPT.has(w.status)), [workers]);

  // Drop focus if the focused worker exited and fell off the list, so we don't
  // strand the view in an empty focus mode.
  useEffect(() => {
    if (focusedAttemptId && !workers.some((w) => w.attemptId === focusedAttemptId)) {
      setFocusedAttemptId(null);
    }
  }, [workers, focusedAttemptId]);

  // Esc leaves focus mode. CAPTURE phase + stopPropagation: the maximized pane's
  // xterm holds keyboard focus and would otherwise swallow Escape (its handler
  // preventDefaults it and forwards it to the agent as an interrupt), so a plain
  // bubble listener never fires. Capturing lets us claim Escape first and keep
  // it from reaching the terminal. Bound only while on screen AND focused so it
  // never eats an Esc meant for another surface.
  useEffect(() => {
    if (!visible || focusedAttemptId === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setFocusedAttemptId(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, focusedAttemptId]);

  // One shared clock for every elapsed readout (section headers + pane
  // headers), ticking only while visible and something is live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible || !anyLive) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [visible, anyLive]);

  const toggleCollapse = useCallback((automationId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(automationId)) next.delete(automationId);
      else next.add(automationId);
      return next;
    });
  }, []);

  if (workers.length === 0) {
    return <EmptyWorkers jobs={jobs} onSelectLoom={onSelectLoom} onNewLoom={onNewLoom} />;
  }

  const focusMode = focusedAttemptId !== null;

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {focusMode && (
        <FocusStrip
          workers={workers}
          focusedAttemptId={focusedAttemptId}
          onPick={setFocusedAttemptId}
          onExit={() => setFocusedAttemptId(null)}
        />
      )}
      {/* content-area: the positioned, NON-scrolling containing block for the
          focused pane. `position:relative` makes it the abspos containing block;
          `isolation:isolate` gives the focused pane's z-index a local stacking
          context. Because this layer never scrolls, a focused pane anchored here
          stays put no matter how far the grid below is scrolled. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          position: "relative",
          isolation: "isolate",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* scroll-layer: the grid scroller. STATIC position, so a focused pane's
            absolute box resolves to content-area above — it is therefore neither
            clipped by nor scrolled with this layer. overflow-y and
            scrollbar-gutter are CONSTANT across grid/focus mode, and the grid
            cells are held by fixed-size wrappers (AutomationSection), so the
            grid's cell widths never change when focus toggles — an already-laid-
            out pane's terminal is never re-fit/SIGWINCH'd on the transition. (A
            pane inside a collapsed section is display:none until focus reveals
            it; its FIRST measure then is expected, and the ResizeObserver's
            zero-size + cols/rows dedupe drops it unless the size truly changed.) */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: "auto",
            scrollbarGutter: "stable",
            padding: 12,
          }}
        >
          {groups.map((group) => (
            <AutomationSection
              key={group.automationId}
              group={group}
              collapsed={collapsed.has(group.automationId)}
              onToggleCollapse={() => toggleCollapse(group.automationId)}
              focusMode={focusMode}
              focusedAttemptId={focusedAttemptId}
              onSetFocus={setFocusedAttemptId}
              viewVisible={visible}
              now={now}
              scrollbackLineLimit={scrollbackLineLimit}
              onStopLoom={onStopLoom}
              onSelectLoom={onSelectLoom}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Per-automation section ───────────────────────────────────────────────────

function AutomationSection({
  group,
  collapsed,
  onToggleCollapse,
  focusMode,
  focusedAttemptId,
  onSetFocus,
  viewVisible,
  now,
  scrollbackLineLimit,
  onStopLoom,
  onSelectLoom,
}: {
  group: WorkerGroup;
  collapsed: boolean;
  onToggleCollapse: () => void;
  focusMode: boolean;
  focusedAttemptId: string | null;
  onSetFocus: (id: string | null) => void;
  viewVisible: boolean;
  now: number;
  scrollbackLineLimit: number;
  onStopLoom: (automationId: string) => void;
  onSelectLoom: (automationId: string) => void;
}): React.ReactElement {
  const { workers } = group;
  const name = workers[0]?.automationName ?? "Automation";
  const anyBlocked = workers.some((w) => w.blocked);
  const anyLive = workers.some((w) => LIVE_ATTEMPT.has(w.status));
  const derivedStatus: AutomationStatus = anyBlocked ? "blocked" : anyLive ? "running" : "stopped";
  const dot = automationDotColor(derivedStatus);
  const pass = Math.max(...workers.map((w) => w.iteration)) + 1;
  const engine = workers[0]?.engine ?? "auto";
  const model = workers[0]?.model;
  // Elapsed from the earliest still-live worker (ISO strings sort chronologically).
  const startTimes = workers
    .filter((w) => LIVE_ATTEMPT.has(w.status))
    .map((w) => w.startedAt)
    .filter((s): s is string => Boolean(s));
  const earliest = startTimes.length ? startTimes.reduce((a, b) => (a < b ? a : b)) : undefined;

  // Focus mode hides the section chrome (the chip strip drives navigation), but
  // the bodies stay mounted so terminals never reattach. Collapse only bites in
  // grid mode — in focus mode every body must stay laid out so a chip can bring
  // ANY pane (even one from a would-be-collapsed section) to the front.
  const showHeader = !focusMode;
  const bodyHidden = !focusMode && collapsed;

  return (
    <section style={{ marginBottom: focusMode ? 0 : 10 }}>
      {showHeader && (
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          style={{
            appearance: "none",
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            borderRadius: "var(--radius-control)",
            border: "1px solid var(--rule-soft)",
            background: "var(--panel-2)",
            cursor: "default",
            textAlign: "left",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--panel-2)")}
        >
          <span
            aria-hidden
            style={{
              flex: "0 0 auto",
              fontSize: 10,
              color: "var(--muted-2)",
              transform: collapsed ? "rotate(-90deg)" : "none",
              transition: "transform var(--motion-fast) var(--ease-out)",
            }}
          >
            ▾
          </span>
          <span
            aria-hidden
            style={{
              flex: "0 0 8px",
              width: 8,
              height: 8,
              borderRadius: 999,
              background: dot,
              boxShadow: `0 0 0 3px color-mix(in oklch, ${dot} 18%, transparent)`,
              animation: anyLive && !anyBlocked ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
            }}
          />
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 260,
            }}
            title={name}
          >
            {name}
          </span>
          <span className="spark-mono spark-num" style={{ flex: "0 0 auto", fontSize: 10, color: "var(--muted)" }}>
            pass {pass}
          </span>
          <span
            className={`spark-badge ${engine === "claude" ? "is-accent" : "is-info"}`}
            style={{ flex: "0 0 auto" }}
            title={model ?? "CLI default model"}
          >
            {engine.toUpperCase()}
          </span>
          {anyLive && (
            <span
              className="spark-mono spark-num"
              style={{ flex: "0 0 auto", fontSize: 10, color: "var(--muted-2)" }}
              title={earliest ? `started ${fmtClock(earliest)}` : undefined}
            >
              {fmtElapsed(earliest, now)}
            </span>
          )}
          {anyBlocked && (
            <span className="spark-badge is-danger" style={{ flex: "0 0 auto" }}>
              needs you
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span className="spark-mono spark-num" style={{ flex: "0 0 auto", fontSize: 10, color: "var(--muted-2)" }}>
            {String(workers.length).padStart(2, "0")}
          </span>
        </button>
      )}
      <div
        style={{
          display: bodyHidden ? "none" : "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(520px, 100%), 1fr))",
          gap: 8,
          alignContent: "start",
          marginTop: showHeader ? 8 : 0,
        }}
      >
        {workers.map((worker) => {
          const isFocused = worker.attemptId === focusedAttemptId;
          // The pane is on screen when the tab is showing AND (focus mode: it's
          // the focused one; grid mode: its section is expanded). Drives
          // useTerminalSession's reveal-refit when it swings back into view.
          const paneVisible = viewVisible && (focusMode ? isFocused : !collapsed);
          // Fixed-size grid-item wrapper. It stays in flow at the SAME size in
          // every mode (even when its card is the focused pane and lifts out via
          // position:absolute), so the grid track count / cell widths never
          // change and the other panes' terminals are never resized. The card
          // fills this box in grid mode and escapes it when focused.
          return (
            <div key={worker.attemptId} style={{ minWidth: 0, height: 420 }}>
              <WorkerPane
                worker={worker}
                scrollbackLineLimit={scrollbackLineLimit}
                visible={paneVisible}
                now={now}
                focusMode={focusMode}
                isFocused={isFocused}
                onToggleFocus={() => onSetFocus(isFocused ? null : worker.attemptId)}
                onStopLoom={onStopLoom}
                onSelectLoom={onSelectLoom}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Single worker pane ───────────────────────────────────────────────────────

function WorkerPane({
  worker,
  scrollbackLineLimit,
  visible,
  now,
  focusMode,
  isFocused,
  onToggleFocus,
  onStopLoom,
  onSelectLoom,
}: {
  worker: AutomationWorkerInfo;
  scrollbackLineLimit: number;
  visible: boolean;
  now: number;
  focusMode: boolean;
  isFocused: boolean;
  onToggleFocus: () => void;
  onStopLoom: (automationId: string) => void;
  onSelectLoom: (automationId: string) => void;
}): React.ReactElement {
  const [confirmStop, setConfirmStop] = useState(false);
  const live = LIVE_ATTEMPT.has(worker.status);
  const blocked = worker.blocked;
  const dot = blocked ? "var(--danger)" : live ? "var(--accent)" : "var(--muted)";

  // Focused pane lifts out of its grid-cell wrapper to fill the whole content
  // area (position:absolute, anchored to the non-scrolling content-area, so it
  // is unaffected by the grid's scroll offset). Every other pane in focus mode
  // stays mounted, filling its still-present fixed-size wrapper but hidden — an
  // already-laid-out sibling's container keeps its exact size on the toggle
  // (no spurious SIGWINCH); it reveal-refits when focus lifts.
  const focusedFill = focusMode && isFocused;
  const background = focusMode && !isFocused;

  // Auto-clear the two-step stop confirmation.
  useEffect(() => {
    if (!confirmStop) return;
    const t = window.setTimeout(() => setConfirmStop(false), 2500);
    return () => window.clearTimeout(t);
  }, [confirmStop]);

  return (
    <div
      className="spark-fade-in"
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        borderRadius: "var(--radius-surface)",
        border: "1px solid var(--rule-soft)",
        background: "var(--panel)",
        overflow: "hidden",
        boxShadow: blocked
          ? "0 0 0 2px color-mix(in oklch, var(--danger) 35%, transparent)"
          : "var(--shadow-1)",
        ...(focusedFill ? { position: "absolute", inset: 0, zIndex: 2 } : { height: "100%" }),
        ...(background ? { visibility: "hidden", pointerEvents: "none" } : {}),
      }}
    >
      {/* Header — double-click toggles focus; inner buttons stop that bubbling. */}
      <div
        onDoubleClick={onToggleFocus}
        style={{
          flex: "0 0 34px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          borderBottom: "1px solid var(--rule-soft)",
          background: "var(--panel-2)",
        }}
      >
        <span
          aria-hidden
          style={{
            flex: "0 0 8px",
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dot,
            boxShadow: `0 0 0 3px color-mix(in oklch, ${dot} 18%, transparent)`,
            animation: live && !blocked ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
        <button
          type="button"
          onClick={() => onSelectLoom(worker.automationId)}
          onDoubleClick={(e) => e.stopPropagation()}
          title="Open this loom's detail"
          style={{
            appearance: "none",
            border: "none",
            background: "transparent",
            padding: 0,
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--ink)",
            cursor: "default",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 220,
          }}
        >
          {worker.automationName}
        </button>
        <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted)" }}>
          pass {worker.iteration + 1}
        </span>
        <span
          className={`spark-badge ${worker.engine === "claude" ? "is-accent" : "is-info"}`}
          title={worker.model ?? "Default model"}
        >
          {worker.engine.toUpperCase()}
          {worker.model ? ` · ${worker.model}` : ""}
        </span>
        <span className="spark-badge" title="Structured automation transport">
          {worker.transport === "agent-sdk" ? "AGENT SDK" : "APP SERVER"}
        </span>
        <span style={{ flex: 1 }} />
        <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted-2)" }} title={`started ${fmtClock(worker.startedAt)}`}>
          {live ? fmtElapsed(worker.startedAt, now) : "finished"}
        </span>
        <button
          type="button"
          onClick={onToggleFocus}
          onDoubleClick={(e) => e.stopPropagation()}
          title={focusedFill ? "Back to grid (Esc)" : "Focus this worker"}
          aria-label={focusedFill ? "Restore grid view" : "Focus this worker"}
          style={{
            appearance: "none",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            padding: 0,
            borderRadius: "var(--radius-control)",
            border: "1px solid var(--rule-soft)",
            background: focusedFill ? "var(--accent-soft)" : "transparent",
            color: "var(--muted)",
            cursor: "default",
            fontSize: 12,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = focusedFill ? "var(--accent-soft)" : "transparent")}
        >
          {focusedFill ? "⤡" : "⤢"}
        </button>
        <button
          type="button"
          className="spark-btn is-danger"
          style={{ height: 22, padding: "0 8px", fontSize: 10.5 }}
          disabled={!live}
          onClick={() => {
            if (confirmStop) {
              setConfirmStop(false);
              onStopLoom(worker.automationId);
            } else {
              setConfirmStop(true);
            }
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseLeave={() => setConfirmStop(false)}
          title="Stop this loom (kills the worker)"
        >
          {confirmStop ? "stop?" : "Stop"}
        </button>
      </div>

      {blocked && (
        <div
          style={{
            flex: "0 0 auto",
            padding: "6px 10px",
            fontSize: 11,
            color: "var(--ink)",
            background: "var(--danger-soft)",
            borderBottom: "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
          }}
        >
          Waiting for you — answer via the question card in the loom's detail.
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--bg)" }}>
        <StructuredWorkerActivity worker={worker} visible={visible} live={live} />
      </div>
    </div>
  );
}

function StructuredWorkerActivity({
  worker,
  visible,
  live,
}: {
  worker: AutomationWorkerInfo;
  visible: boolean;
  live: boolean;
}): React.ReactElement {
  const [content, setContent] = useState("");
  useEffect(() => {
    if (!worker.stdoutLogPath) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const file = await window.spark.fs.readTextTail(worker.stdoutLogPath!, 80_000);
        if (!disposed) setContent(file.content);
      } catch {
        /* The file may not exist during the first launch tick. */
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
        style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--muted-2)", fontSize: 11 }}
      >
        {live ? `Starting ${worker.transport === "agent-sdk" ? "Claude Agent SDK" : "Codex App Server"}…` : "No activity was recorded."}
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

// ── Focus-mode chip strip ────────────────────────────────────────────────────

function FocusStrip({
  workers,
  focusedAttemptId,
  onPick,
  onExit,
}: {
  workers: AutomationWorkerInfo[];
  focusedAttemptId: string | null;
  onPick: (attemptId: string) => void;
  onExit: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderBottom: "1px solid var(--rule)",
        background: "var(--panel)",
      }}
    >
      <span className="spark-eyebrow" style={{ flex: "0 0 auto" }}>
        Focus
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 6, overflowX: "auto" }}>
        {workers.map((w) => {
          const live = LIVE_ATTEMPT.has(w.status);
          const active = w.attemptId === focusedAttemptId;
          const cdot = w.blocked ? "var(--danger)" : live ? "var(--accent)" : "var(--muted)";
          return (
            <button
              key={w.attemptId}
              type="button"
              onClick={() => onPick(w.attemptId)}
              title={`${w.automationName} · pass ${w.iteration + 1}`}
              style={{
                appearance: "none",
                flex: "0 0 auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 24,
                padding: "0 9px",
                borderRadius: 999,
                border: active
                  ? "1px solid color-mix(in oklch, var(--accent) 45%, transparent)"
                  : "1px solid var(--rule-soft)",
                background: active ? "var(--accent-soft)" : "var(--panel-2)",
                color: active ? "var(--ink)" : "var(--ink-dim)",
                cursor: "default",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = "var(--hover)";
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = "var(--panel-2)";
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
                  animation: live && !w.blocked ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: active ? 600 : 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 160,
                }}
              >
                {w.automationName}
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="spark-icon-btn"
        aria-label="Back to grid"
        title="Back to grid (Esc)"
        style={{ ["--spark-icon-btn-size"]: "22px", flex: "0 0 auto" } as React.CSSProperties}
        onClick={onExit}
      >
        ✕
      </button>
    </div>
  );
}

function EmptyWorkers({
  jobs,
  onSelectLoom,
  onNewLoom,
}: {
  jobs: ScheduledJob[];
  onSelectLoom: (automationId: string) => void;
  onNewLoom: () => void;
}): React.ReactElement {
  const armed = jobs.filter((j) => j.enabled && j.state.status !== "stopped");
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div className="spark-empty" style={{ padding: "42px 16px 18px", gap: 8 }}>
        <div className="spark-eyebrow">No workers running</div>
        <div className="spark-empty__body">When a loom fires, its worker runs here — live.</div>
        {jobs.length === 0 && (
          <button type="button" className="spark-btn is-primary" style={{ marginTop: 4 }} onClick={onNewLoom}>
            New loom
          </button>
        )}
      </div>
      {armed.length > 0 && (
        <div style={{ maxWidth: 460, margin: "0 auto", padding: "0 16px 24px" }}>
          <div className="spark-eyebrow" style={{ marginBottom: 8 }}>
            Armed looms
          </div>
          {armed.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => onSelectLoom(job.id)}
              style={{
                appearance: "none",
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 10px",
                marginBottom: 4,
                borderRadius: "var(--radius-control)",
                border: "1px solid var(--rule-soft)",
                background: "var(--panel)",
                cursor: "default",
                textAlign: "left",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "var(--panel)")}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--ink-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {job.name}
              </span>
              <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted-2)" }}>
                {job.state.nextFireAt ? `next ${fmtClock(job.state.nextFireAt)}` : job.state.status}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
