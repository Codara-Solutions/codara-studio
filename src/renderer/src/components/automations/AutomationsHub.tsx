import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRuntimeDiagnostic,
  AutomationRunRecord,
  CreateScheduledJobInput,
  RunState,
  ScheduledJob,
  UpdateScheduledJobInput,
} from "@shared/types";
import { runStatusColor } from "../../lib/run-status";
import {
  STOP_REASON_LABEL,
  automationDotColor,
  capLabel,
  fmtTime,
  fmtUsd,
  liveCue,
  loopSummary,
  statusWord,
  triggerSummary,
  workerSummary,
} from "./presentation";
import { useAutomationWorkers } from "./useAutomationWorkers";
import WorkersView from "./WorkersView";
import RunPeek from "./RunPeek";
import MiniFlow from "./MiniFlow";
import NodeFlowEditor from "./flow/NodeFlowEditor";

// AutomationsHub — the dedicated home for "Looms": automations that are a
// TRIGGER (when to start) + a LOOP (how it repeats) + a WORKER (which CLI
// agent runs each pass — no API manager anywhere). Two sub-tabs:
//   Looms   — list + detail (pipeline strip, live state, history, config)
//   Workers — every live worker as a real terminal pane
// Built on the shared .spark-* kit + design tokens. Loom runs never open
// chat/terminal tabs — everything renders here.

export interface Props {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  // Whether the Automations tab is the active top-level tab (drives the
  // workers poll + terminal pane visibility).
  active: boolean;
  terminalScrollbackLineLimit: number;
}

type Mode = { kind: "view" } | { kind: "create" } | { kind: "edit"; job: ScheduledJob };
type SubTab = "looms" | "workers";

const SUBTAB_STORAGE_KEY = "spark.automations.subtab";

export default function AutomationsHub({
  workspaceId,
  workspaceName,
  cwd,
  active,
  terminalScrollbackLineLimit,
}: Props): React.ReactElement {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [liveRun, setLiveRun] = useState<RunState | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeDiagnostic[]>([]);
  const [subTab, setSubTab] = useState<SubTab>(() => {
    try {
      return window.localStorage.getItem(SUBTAB_STORAGE_KEY) === "workers" ? "workers" : "looms";
    } catch {
      return "looms";
    }
  });
  // Inline feedback when an action (Run now / Pause / Save / …) fails — there is
  // no renderer-callable toast API, so we surface errors locally.
  const [actionError, setActionError] = useState<string | null>(null);

  const workers = useAutomationWorkers(active);
  const workspaceWorkers = useMemo(
    () => workers.filter((w) => jobs.some((j) => j.id === w.automationId)),
    [workers, jobs],
  );
  const anyBlocked = workspaceWorkers.some((w) => w.blocked);

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const switchSubTab = useCallback((next: SubTab) => {
    setSubTab(next);
    try {
      window.localStorage.setItem(SUBTAB_STORAGE_KEY, next);
    } catch {
      /* persistence is a nicety */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await window.spark.scheduler.list();
      // Only this workspace's looms.
      setJobs(list.filter((j) => j.input.workspaceId === workspaceId));
    } catch {
      /* best-effort: keep last good view */
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const refreshDetail = useCallback(async () => {
    const id = selectedIdRef.current;
    if (!id) {
      setLiveRun(null);
      return;
    }
    try {
      const detail = await window.spark.scheduler.getDetail?.(id);
      setLiveRun(detail?.liveRun ?? null);
    } catch {
      /* best-effort */
    }
  }, []);

  // Initial load + live event stream (automation registry, per-iteration ticks,
  // and the live run's own orchestration events while one is selected).
  useEffect(() => {
    void refresh();
    void refreshDetail();
    const unsubscribe = window.spark.orchestration.onEvent((event) => {
      if (event.type === "automation.updated" || event.type === "automation.iteration") {
        void refresh();
        void refreshDetail();
      } else if (event.runId && event.runId === liveRun?.id) {
        void refreshDetail();
      }
    });
    return () => unsubscribe();
  }, [refresh, refreshDetail, liveRun?.id]);

  // Installed CLI runtimes for the Worker node + handoff explainers.
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const list = await window.spark.agents.runtimes();
        if (!disposed) setRuntimes(list);
      } catch {
        /* editor falls back to Auto-only */
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // Keep the selection valid; auto-select the first loom when nothing is chosen.
  useEffect(() => {
    if (jobs.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !jobs.some((j) => j.id === selectedId)) {
      if (mode.kind === "view") setSelectedId(jobs[0].id);
    }
  }, [jobs, selectedId, mode.kind]);

  // Re-resolve the detail run when the selection changes.
  useEffect(() => {
    void refreshDetail();
  }, [selectedId, refreshDetail]);

  const selected = useMemo(() => jobs.find((j) => j.id === selectedId) ?? null, [jobs, selectedId]);

  const handleCreate = useCallback(
    async (input: CreateScheduledJobInput) => {
      setActionError(null);
      try {
        const job = await window.spark.scheduler.create(input);
        await refresh();
        setSelectedId(job.id);
        setMode({ kind: "view" });
      } catch (e) {
        // Keep the form so the user can retry; tell them why it failed.
        setActionError(e instanceof Error ? e.message : "Couldn't create the automation — try again.");
      }
    },
    [refresh],
  );

  const handleSaveEdit = useCallback(
    async (input: UpdateScheduledJobInput) => {
      setActionError(null);
      try {
        await window.spark.scheduler.update?.(input);
        await refresh();
        setMode({ kind: "view" });
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Couldn't save the automation — try again.");
      }
    },
    [refresh],
  );

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await fn();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Action failed — try again.");
      } finally {
        await refresh();
        await refreshDetail();
      }
    },
    [refresh, refreshDetail],
  );

  const openLoomDetail = useCallback(
    (automationId: string) => {
      setSelectedId(automationId);
      switchSubTab("looms");
      // Preserve an in-progress editor draft: only drop to the view list when
      // nothing is being authored. Mirrors the onNewLoom guard — unconditionally
      // setting {kind:"view"} here would clobber an open create/edit draft (this
      // is reachable while editing via a Workers-pane loom button / armed row).
      setMode((m) => (m.kind === "view" ? { kind: "view" } : m));
    },
    [switchSubTab],
  );

  const stopLoom = useCallback(
    (automationId: string) => {
      void act(() => window.spark.scheduler.stop!(automationId));
    },
    [act],
  );

  const editing = mode.kind !== "view";

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--ink)",
      }}
    >
      {/* ── Sub-tab strip ─────────────────────────────────────────────────── */}
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
        <div className="spark-segmented" role="tablist" aria-label="Automations views">
          <button
            type="button"
            role="tab"
            aria-selected={subTab === "looms"}
            className={`spark-segmented-item${subTab === "looms" ? " is-selected" : ""}`}
            onClick={() => switchSubTab("looms")}
          >
            Looms
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === "workers"}
            className={`spark-segmented-item${subTab === "workers" ? " is-selected" : ""}`}
            onClick={() => switchSubTab("workers")}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            Workers
            {workspaceWorkers.length > 0 && (
              <span
                className={`spark-badge ${anyBlocked ? "is-danger" : "is-accent"}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "currentColor",
                    animation: anyBlocked ? undefined : "spark-pulse 1.4s ease-in-out infinite",
                  }}
                />
                {anyBlocked ? "needs you" : workspaceWorkers.length}
              </span>
            )}
          </button>
        </div>
        <span style={{ flex: 1 }} />
        {subTab === "looms" && !editing && (
          <button
            type="button"
            className="spark-btn is-primary"
            style={{ height: 26, padding: "0 12px", fontSize: 11.5 }}
            onClick={() => {
              setActionError(null);
              setMode({ kind: "create" });
            }}
          >
            + New loom
          </button>
        )}
      </div>

      {actionError && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            margin: "10px 16px 0",
            padding: "9px 12px",
            borderRadius: "var(--radius-control)",
            border: "1px solid color-mix(in oklch, var(--danger) 32%, transparent)",
            background: "var(--danger-soft)",
            color: "var(--ink)",
            fontSize: 11.5,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{actionError}</span>
          <button
            type="button"
            className="spark-icon-btn"
            aria-label="Dismiss"
            style={{ ["--spark-icon-btn-size"]: "18px" } as React.CSSProperties}
            onClick={() => setActionError(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {/* A position:relative flex container so the editor can be kept MOUNTED
          (absolute inset 0) while hidden behind the Workers sub-tab. We hide it
          with visibility:hidden + pointer-events:none — NEVER display:none —
          because the ReactFlow canvas inside the editor measures its container
          and would collapse to a zero-size, non-interactive canvas under
          display:none. visibility:hidden survives the round-trip so the draft
          and zoom/pan state stay intact when the user flips back to Looms. */}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative", display: "flex" }}>
        {editing && (
          <div
            aria-hidden={subTab !== "looms"}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              // "inherit", not "visible"/"auto": an explicit visible/auto child
              // punches through the visibility:hidden + pointer-events:none the
              // tab stack puts on this hub when another top-level tab is active,
              // leaking the editor's floating controls over that tab.
              visibility: subTab === "looms" ? "inherit" : "hidden",
              pointerEvents: subTab === "looms" ? "inherit" : "none",
            }}
          >
            <NodeFlowEditor
              initial={mode.kind === "edit" ? mode.job : undefined}
              jobs={jobs}
              runtimes={runtimes}
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              cwd={cwd}
              onCreate={mode.kind === "create" ? handleCreate : undefined}
              onSave={mode.kind === "edit" ? handleSaveEdit : undefined}
              onCancel={() => setMode({ kind: "view" })}
            />
          </div>
        )}

        {subTab === "workers" && (
          <WorkersView
            workers={workspaceWorkers}
            jobs={jobs}
            scrollbackLineLimit={terminalScrollbackLineLimit}
            visible={active && subTab === "workers"}
            onStopLoom={stopLoom}
            onSelectLoom={openLoomDetail}
            onNewLoom={() => {
              // Switching back to Looms must reveal whatever editor is already
              // open. Only start a fresh create when nothing is being authored;
              // if an edit draft is open, just unhide it (don't double-mount or
              // clobber the in-progress edit with a blank create form).
              switchSubTab("looms");
              setMode((m) => (m.kind === "view" ? { kind: "create" } : m));
            }}
          />
        )}

        {!editing && subTab === "looms" && (
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex" }}>
          {/* LEFT: list */}
          <aside
            style={{
              flex: "0 0 300px",
              width: 300,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              background: "var(--panel)",
              borderRight: "1px solid var(--rule)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                borderBottom: "1px solid var(--rule)",
              }}
            >
              <span className="spark-eyebrow" style={{ flex: 1 }}>
                Looms
              </span>
              <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted-2)" }}>
                {String(jobs.length).padStart(2, "0")}
              </span>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 8px 12px" }}>
              {loading ? (
                <div style={{ padding: "10px 8px", color: "var(--muted-2)", fontSize: 11 }}>Loading…</div>
              ) : jobs.length === 0 ? (
                <div className="spark-empty" style={{ padding: "26px 8px", gap: 8 }}>
                  <div className="spark-eyebrow">No looms yet</div>
                  <div className="spark-empty__body">
                    Author a loop that prompts Claude or Codex on your schedule.
                  </div>
                  <button
                    type="button"
                    className="spark-btn is-primary"
                    style={{ marginTop: 4 }}
                    onClick={() => setMode({ kind: "create" })}
                  >
                    New loom
                  </button>
                </div>
              ) : (
                jobs.map((job) => (
                  <AutomationRow
                    key={job.id}
                    job={job}
                    selected={job.id === selectedId}
                    onSelect={() => {
                      setActionError(null);
                      setSelectedId(job.id);
                    }}
                  />
                ))
              )}
            </div>
          </aside>

          {/* RIGHT: detail */}
          <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
            {!selected ? (
              <div className="spark-empty" style={{ flex: 1 }}>
                <div className="spark-eyebrow">Select a loom</div>
                <div className="spark-empty__body">Pick a loom on the left to see its worker and history.</div>
              </div>
            ) : (
              <AutomationDetail
                job={selected}
                liveRun={liveRun}
                runtimes={runtimes}
                onEdit={() => setMode({ kind: "edit", job: selected })}
                onRunNow={() => void act(() => window.spark.scheduler.runNow(selected.id))}
                onPause={() => void act(() => window.spark.scheduler.pause!(selected.id))}
                onResume={() => void act(() => window.spark.scheduler.resume!(selected.id))}
                onStop={() => stopLoom(selected.id)}
                onToggleEnabled={(enabled) =>
                  void act(() => window.spark.scheduler.setEnabled(selected.id, enabled))
                }
                onDelete={() =>
                  void act(async () => {
                    await window.spark.scheduler.remove(selected.id);
                    setSelectedId(null);
                  })
                }
                onViewWorker={() => switchSubTab("workers")}
                onAnswer={(runId, answer) =>
                  void act(() =>
                    window.spark.orchestration.addRunMessage({
                      runId,
                      author: "user",
                      kind: "note",
                      message: answer,
                    }),
                  )
                }
              />
            )}
          </section>
        </div>
        )}
      </div>
    </div>
  );
}

// ── Left-list row ────────────────────────────────────────────────────────────

const AutomationRow = React.memo(function AutomationRow({
  job,
  selected,
  onSelect,
}: {
  job: ScheduledJob;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const dot = automationDotColor(job.state.status);
  const live = job.state.status === "running";
  return (
    <button
      type="button"
      onClick={onSelect}
      className="spark-fade-in"
      style={{
        appearance: "none",
        textAlign: "left",
        width: "100%",
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        padding: "9px 10px",
        marginBottom: 4,
        borderRadius: "var(--radius-surface)",
        border: "1px solid transparent",
        background: selected ? "color-mix(in oklch, var(--accent) 13%, var(--panel))" : "transparent",
        boxShadow: selected ? "var(--lift-hi)" : "none",
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 8px",
          width: 8,
          height: 8,
          marginTop: 4,
          borderRadius: 999,
          background: dot,
          boxShadow: `0 0 0 3px color-mix(in oklch, ${dot} 18%, transparent)`,
          // Match the house pulse convention (inline animation referencing the
          // @keyframes spark-pulse in styles.css), not a non-existent class.
          animation: live ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
        }}
      />
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: selected ? "var(--ink)" : "var(--ink-dim)",
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
          style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          title={`${triggerSummary(job.trigger)} · ${loopSummary(job.loop)} · ${workerSummary(job.worker)}`}
        >
          {triggerSummary(job.trigger)} · {loopSummary(job.loop)}
        </span>
        <span className="spark-mono spark-num" style={{ fontSize: 9.5, color: "var(--muted-2)" }}>
          {liveCue(job)}
        </span>
      </span>
      {!job.enabled && (
        <span className="spark-badge" style={{ flex: "0 0 auto" }}>
          off
        </span>
      )}
    </button>
  );
});

// ── Right detail ─────────────────────────────────────────────────────────────

function AutomationDetail({
  job,
  liveRun,
  runtimes,
  onEdit,
  onRunNow,
  onPause,
  onResume,
  onStop,
  onToggleEnabled,
  onDelete,
  onViewWorker,
  onAnswer,
}: {
  job: ScheduledJob;
  liveRun: RunState | null;
  runtimes: AgentRuntimeDiagnostic[];
  onEdit: () => void;
  onRunNow: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  onViewWorker: () => void;
  onAnswer: (runId: string, answer: string) => void;
}): React.ReactElement {
  const status = job.state.status;
  // Install hint when the loop stopped because no engine is available.
  const installHint =
    job.state.lastStopReason === "engine-missing"
      ? runtimes.find((r) => r.kind === "claude")?.installHint ??
        "Install Claude Code or Codex, then run the loom again."
      : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Sticky header */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          background: "var(--bg)",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <span
          aria-hidden
          style={{
            flex: "0 0 9px",
            width: 9,
            height: 9,
            borderRadius: 999,
            background: automationDotColor(status),
            boxShadow: `0 0 0 3px color-mix(in oklch, ${automationDotColor(status)} 18%, transparent)`,
            animation: status === "running" ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {job.name}
          </div>
          <div className="spark-mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
            {triggerSummary(job.trigger)} · {loopSummary(job.loop)} · {workerSummary(job.worker)}
          </div>
        </div>
        <span
          className="spark-badge"
          style={{
            color: automationDotColor(status),
            borderColor: `color-mix(in oklch, ${automationDotColor(status)} 32%, transparent)`,
          }}
        >
          {statusWord(status)}
        </span>
      </div>

      {/* Pipeline strip */}
      <div style={{ padding: "12px 16px 4px" }}>
        <MiniFlow job={job} onOpenEditor={onEdit} />
      </div>

      {installHint && (
        <div style={{ padding: "8px 16px 0" }}>
          <span className="spark-badge is-danger">engine not installed</span>
          <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 8 }}>{installHint}</span>
        </div>
      )}

      {/* Live worker */}
      <Section label="Worker">
        <LiveWorkerCard
          job={job}
          liveRun={liveRun}
          onRunNow={onRunNow}
          onPause={onPause}
          onResume={onResume}
          onStop={onStop}
          onEdit={onEdit}
          onToggleEnabled={onToggleEnabled}
          onViewWorker={onViewWorker}
          onAnswer={onAnswer}
        />
      </Section>

      {/* History */}
      <Section label="History" count={job.history.length}>
        <HistoryTimeline history={job.history} liveRunId={job.state.currentRunId} onViewWorker={onViewWorker} />
      </Section>

      {/* Loop config */}
      <Section label="Loop">
        <LoopConfigSummary job={job} onEdit={onEdit} onDelete={onDelete} />
      </Section>
    </div>
  );
}

function Section({
  label,
  count,
  children,
}: {
  label: string;
  count?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ borderBottom: "1px solid var(--rule-soft)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px 4px" }}>
        <span className="spark-eyebrow">{label}</span>
        {typeof count === "number" && (
          <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted-2)" }}>
            {String(count).padStart(2, "0")}
          </span>
        )}
      </div>
      <div style={{ padding: "4px 16px 14px" }}>{children}</div>
    </div>
  );
}

// ── Live worker card ─────────────────────────────────────────────────────────

function LiveWorkerCard({
  job,
  liveRun,
  onRunNow,
  onPause,
  onResume,
  onStop,
  onEdit,
  onToggleEnabled,
  onViewWorker,
  onAnswer,
}: {
  job: ScheduledJob;
  liveRun: RunState | null;
  onRunNow: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onEdit: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onViewWorker: () => void;
  onAnswer: (runId: string, answer: string) => void;
}): React.ReactElement {
  const [confirmStop, setConfirmStop] = useState(false);
  const [answerDraft, setAnswerDraft] = useState("");
  const status = job.state.status;
  const running = status === "running" || status === "blocked";
  const edge = liveRun ? runStatusColor(liveRun.status) : automationDotColor(status);
  const budget = job.loop.stop.budgetUsd;

  // The blocked iteration's pending question (last spark question), if any.
  const pendingQuestion =
    liveRun && liveRun.status === "blocked"
      ? [...liveRun.humanMessages].reverse().find((m) => m.author === "spark" && m.kind === "question")?.message
      : undefined;

  return (
    <div
      style={{
        borderRadius: "var(--radius-surface)",
        background: "var(--notify-surface)",
        border: "1px solid var(--rule)",
        boxShadow: `inset 3px 0 0 ${edge}, var(--shadow-1)`,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>
          {running ? `Iteration ${job.state.iteration}` : status === "stopped" ? "Loop finished" : "Idle"}
        </span>
        <span className="spark-mono spark-num" style={{ fontSize: 10.5, color: "var(--muted)" }}>
          {job.state.iteration}/{capLabel(job)} iters
        </span>
        <span style={{ flex: 1 }} />
        <span className="spark-mono spark-num" style={{ fontSize: 10.5, color: "var(--muted)" }}>
          est. {fmtUsd(job.state.spentUsd)}
          {typeof budget === "number" ? ` / ${fmtUsd(budget)}` : ""}
        </span>
      </div>

      {liveRun ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="spark-mono" style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--ink-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <span style={{ color: runStatusColor(liveRun.status) }}>●</span> {liveRun.title || "run"} —{" "}
            {liveRun.status}
          </span>
          {running && (
            <button
              type="button"
              className="spark-btn"
              style={{ height: 24, padding: "0 10px", fontSize: 11 }}
              onClick={onViewWorker}
              title="Watch the live worker terminal"
            >
              View terminal →
            </button>
          )}
        </div>
      ) : (
        <div className="spark-mono" style={{ fontSize: 11, color: "var(--muted)" }}>
          No live run. {status === "stopped" && job.state.lastStopReason
            ? `Stopped: ${STOP_REASON_LABEL[job.state.lastStopReason]}.`
            : "Run it now or wait for the trigger."}
        </div>
      )}

      {pendingQuestion && liveRun && (
        <div
          style={{
            borderRadius: "var(--radius-control)",
            border: "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
            background: "var(--danger-soft)",
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 11.5, color: "var(--ink)", whiteSpace: "pre-wrap" }}>{pendingQuestion}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="spark-input"
              value={answerDraft}
              onChange={(e) => setAnswerDraft(e.target.value)}
              placeholder="Answer the worker…"
              style={{ flex: 1, height: 26 }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && answerDraft.trim()) {
                  onAnswer(liveRun.id, answerDraft.trim());
                  setAnswerDraft("");
                }
              }}
            />
            <button
              type="button"
              className="spark-btn is-primary"
              style={{ height: 26, fontSize: 11 }}
              disabled={!answerDraft.trim()}
              onClick={() => {
                onAnswer(liveRun.id, answerDraft.trim());
                setAnswerDraft("");
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className={`spark-btn${!running ? " is-primary" : ""}`}
          style={{ height: 26, fontSize: 11.5 }}
          onClick={onRunNow}
          title={
            running
              ? "Stop the current pass and start the loom over from pass 1"
              : "Start a fresh run of this loom now"
          }
        >
          {running ? "Restart" : "Run now"}
        </button>
        {status === "paused" ? (
          <button type="button" className="spark-btn" style={{ height: 26, fontSize: 11.5 }} onClick={onResume}>
            Resume
          </button>
        ) : (
          <button
            type="button"
            className="spark-btn"
            style={{ height: 26, fontSize: 11.5 }}
            onClick={onPause}
            disabled={status === "stopped" || status === "idle"}
          >
            Pause
          </button>
        )}
        <button type="button" className="spark-btn" style={{ height: 26, fontSize: 11.5 }} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className="spark-btn"
          style={{ height: 26, fontSize: 11.5 }}
          onClick={() => onToggleEnabled(!job.enabled)}
          title={job.enabled ? "Disable (disarm trigger)" : "Enable (arm trigger)"}
        >
          {job.enabled ? "Disable" : "Enable"}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="spark-btn is-danger"
          style={{ height: 26, fontSize: 11.5 }}
          onClick={() => {
            if (confirmStop) {
              setConfirmStop(false);
              onStop();
            } else {
              setConfirmStop(true);
            }
          }}
          onMouseLeave={() => setConfirmStop(false)}
          disabled={!running}
          title="Stop the loop and kill the live worker"
        >
          {confirmStop ? "Confirm stop" : "Stop"}
        </button>
      </div>
    </div>
  );
}

// ── History timeline (accordion + run peek) ──────────────────────────────────

function HistoryTimeline({
  history,
  liveRunId,
  onViewWorker,
}: {
  history: AutomationRunRecord[];
  liveRunId?: string;
  onViewWorker: () => void;
}): React.ReactElement {
  // Keyed iteration+runId — iteration alone collides across loop cycles
  // ("Run now" resets the counter while history is retained), which would
  // expand both records together.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [peekRunId, setPeekRunId] = useState<string | null>(null);

  if (history.length === 0) {
    return <div style={{ fontSize: 11, color: "var(--muted-2)" }}>No iterations yet.</div>;
  }
  const rows = [...history].reverse();
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((rec) => {
        const recKey = `${rec.iteration}-${rec.runId}`;
        const dot = rec.status === "running" ? "var(--accent)" : runStatusColor(rec.status);
        const isExpanded = expanded === recKey;
        const isLive = rec.runId === liveRunId && rec.status === "running";
        return (
          <React.Fragment key={recKey}>
            <button
              type="button"
              onClick={() => {
                setExpanded(isExpanded ? null : recKey);
                if (isExpanded) setPeekRunId(null);
              }}
              aria-expanded={isExpanded}
              style={{
                appearance: "none",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 4px",
                border: "none",
                borderBottom: isExpanded ? "none" : "1px solid var(--rule-soft)",
                background: isExpanded ? "var(--hover)" : "transparent",
                cursor: "default",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = isExpanded ? "var(--hover)" : "transparent")}
            >
              <span
                aria-hidden
                style={{ flex: "0 0 7px", width: 7, height: 7, borderRadius: 999, background: dot }}
              />
              <span className="spark-mono spark-num" style={{ flex: "0 0 auto", fontSize: 10.5, color: "var(--ink-dim)" }}>
                #{rec.iteration}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={rec.summary}>
                {rec.summary || rec.status}
              </span>
              <span className="spark-mono spark-num" style={{ flex: "0 0 auto", fontSize: 9.5, color: "var(--muted-2)" }}>
                {fmtUsd(rec.costUsd)}
              </span>
              <span className="spark-mono" style={{ flex: "0 0 auto", fontSize: 9.5, color: "var(--muted-2)" }}>
                {fmtTime(rec.finishedAt ?? rec.startedAt)}
              </span>
              {rec.stopReason && (
                <span
                  className={`spark-badge${
                    rec.stopReason === "iteration-failed" || rec.stopReason === "budget" || rec.stopReason === "engine-missing"
                      ? " is-danger"
                      : rec.stopReason === "agent-done" || rec.stopReason === "tests-pass" || rec.stopReason === "once"
                        ? " is-ok"
                        : ""
                  }`}
                  style={{ flex: "0 0 auto" }}
                >
                  {STOP_REASON_LABEL[rec.stopReason]}
                </span>
              )}
            </button>
            {isExpanded && (
              <div
                style={{
                  padding: "4px 4px 10px 21px",
                  borderBottom: "1px solid var(--rule-soft)",
                  background: "var(--hover)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {rec.summary && (
                  <div className="spark-mono" style={{ fontSize: 10.5, color: "var(--ink-dim)", whiteSpace: "pre-wrap", maxHeight: 140, overflow: "auto", lineHeight: 1.5 }}>
                    {rec.summary}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="spark-mono" style={{ fontSize: 9.5, color: "var(--muted-2)" }}>
                    {rec.continuationSource ? `started by ${rec.continuationSource}` : ""}
                  </span>
                  <span style={{ flex: 1 }} />
                  {isLive ? (
                    <button type="button" className="spark-btn" style={{ height: 22, padding: "0 9px", fontSize: 10.5 }} onClick={onViewWorker}>
                      View terminal →
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="spark-btn"
                      style={{ height: 22, padding: "0 9px", fontSize: 10.5 }}
                      onClick={() => setPeekRunId(peekRunId === rec.runId ? null : rec.runId)}
                    >
                      {peekRunId === rec.runId ? "Close peek" : "Peek run"}
                    </button>
                  )}
                </div>
                {peekRunId === rec.runId && <RunPeek runId={rec.runId} onClose={() => setPeekRunId(null)} />}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Loop config summary ──────────────────────────────────────────────────────

function LoopConfigSummary({ job, onEdit, onDelete }: { job: ScheduledJob; onEdit: () => void; onDelete: () => void }): React.ReactElement {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const stop = job.loop.stop;
  const chips: string[] = [];
  if (typeof stop.maxIterations === "number") chips.push(`max ${stop.maxIterations}`);
  if (typeof stop.budgetUsd === "number") chips.push(`est. ${fmtUsd(stop.budgetUsd)}`);
  if (stop.untilTestsPass) chips.push("tests pass");
  if (stop.untilGitClean) chips.push("git clean");
  if (stop.untilPhrase) chips.push(`phrase: ${stop.untilPhrase}`);
  if (stop.untilCommand) chips.push("custom cmd");
  const template = job.prompt?.template ?? job.input.initialUserNote ?? "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <KeyVal k="Trigger" v={triggerSummary(job.trigger)} />
      <KeyVal k="Loop" v={loopSummary(job.loop)} />
      <KeyVal k="Worker" v={workerSummary(job.worker)} />
      <div style={{ display: "flex", gap: 8 }}>
        <span className="spark-eyebrow" style={{ flex: "0 0 72px", paddingTop: 3 }}>
          Stops
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {chips.length === 0 ? (
            <span style={{ fontSize: 11, color: "var(--muted-2)" }}>safety caps only</span>
          ) : (
            chips.map((c) => (
              <span key={c} className="spark-badge">
                {c}
              </span>
            ))
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <span className="spark-eyebrow" style={{ flex: "0 0 72px", paddingTop: 3 }}>
          Prompt
        </span>
        <div
          className="spark-mono"
          style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--ink-dim)", whiteSpace: "pre-wrap", maxHeight: 96, overflow: "auto" }}
        >
          {template || <span style={{ color: "var(--muted-2)" }}>—</span>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <button type="button" className="spark-btn" style={{ height: 26, fontSize: 11.5 }} onClick={onEdit}>
          Edit
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="spark-btn is-danger"
          style={{ height: 26, fontSize: 11.5 }}
          onClick={() => {
            if (confirmDelete) {
              setConfirmDelete(false);
              onDelete();
            } else {
              setConfirmDelete(true);
            }
          }}
          onMouseLeave={() => setConfirmDelete(false)}
        >
          {confirmDelete ? "Confirm delete" : "Delete"}
        </button>
      </div>
    </div>
  );
}

function KeyVal({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
      <span className="spark-eyebrow" style={{ flex: "0 0 72px" }}>
        {k}
      </span>
      <span className="spark-mono" style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--ink-dim)", wordBreak: "break-word" }}>
        {v}
      </span>
    </div>
  );
}
