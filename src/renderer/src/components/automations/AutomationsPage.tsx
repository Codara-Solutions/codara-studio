import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AutomationRunRecord,
  AutomationSkipRecord,
  AutomationWorkerInfo,
  CreateScheduledJobInput,
  GuardPredicate,
  LoomGraph,
  LoomNodeDef,
  RunState,
  ScheduledJob,
  UpdateScheduledJobInput,
} from "@shared/types";
import { AUTOMATION_HISTORY_CAP } from "@shared/types";
import { resolveOpenRunQuestion, runQuestionDraftScopeKey } from "@shared/run-questions";
import { isLiveOnlyEvent } from "@shared/live-events";
import {
  STOP_REASON_LABEL,
  fmtClock,
  fmtElapsed,
  fmtTime,
  fmtUsd,
  loopSummary,
  triggerSummary,
  jobWorkerSummary,
  workerSummary,
} from "./presentation";
import {
  fixWithCoraPrompt,
  fmtSpan,
  fmtWhen,
  groupJobs,
  inboxGroup,
  monthStats,
  monthTotals,
  plainSchedule,
  plainSentence,
  recentRuns,
  recentRunsLabel,
  recordFailed,
  resultCard,
  rowSchedule,
  runMarkOf,
  statusWord,
  type RecentRun,
  type RunMark,
} from "./inbox-model";
import { consumePendingAutomationFocus, consumePendingWorkflowRunFocus } from "./focus-request";
import { reportViewedAutomation } from "../../notifications/viewed-automation";
import WorkflowsView from "../workflows/WorkflowsView";
import { LoomIcon, WORKER_TONE } from "./flow/FlowNodes";
import { graphForJob } from "./flow/model";
import { STEP_TONE, stepActionLine, stepTitle } from "./flow/step-meta";
import { useAutomationWorkers } from "./useAutomationWorkers";
import WorkersView from "./WorkersView";
import RunPeek from "./RunPeek";
import RunIdChip from "../RunIdChip";
import MiniFlow from "./MiniFlow";
import LiveBoard from "./LiveBoard";
import LiveRunHero from "./LiveRunHero";
import NodeFlowEditor from "./flow/NodeFlowEditor";
import SkippedHistoryRow, { mergeTimeline } from "./SkippedHistoryRow";
import { missedRunsSummary, precheckSummary } from "@shared/automation-catchup";

// AutomationsPage — the operations console for this workspace's automations.
// An automation is a TRIGGER (when to start) + a LOOP (how it repeats) +
// WORKER nodes that run on the bundled Pi runtime (model + effort are the only
// worker knobs). Layout: a permanent rail on the left (an inbox: what needs you
// first, then failed, running, scheduled and paused), and a STAGE on the right
// that swaps between the detail, the node-flow editor, and the live workers
// grid. Words on this page describe what happens in plain language; see
// inbox-model.ts and the "Automations" section of DESIGN.md.
// Automations are CREATED by asking Cora in any normal chat, or manually via
// the flow editor here; there is no separate design-with-Cora surface.

export interface Props {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  // Whether the Automations tab is the active top-level tab (drives the
  // workers poll + activity-stream visibility).
  active: boolean;
  // Opens a run's ordinary chat surface, used by "Open chat" on an
  // automation's creator run.
  onOpenRunChat?: (runId: string) => void;
  // Opens a Cora chat with this text waiting in its message box.
  onAskCora?: (prompt: string) => void;
}

// view: rail + detail. create/edit: the node-flow editor owns the stage.
type Mode = { kind: "view" } | { kind: "create" } | { kind: "edit"; job: ScheduledJob };
type SubTab = "looms" | "workers" | "workflows";

const SUBTAB_STORAGE_KEY = "spark.automations.subtab";
const RECENT_RUNS_IN_ROW = 10;
const RECENT_RUNS_ON_PAGE = 20;
// Rows and stats say "next in 10h" and "Running 3m": a minute hand is enough.
const CLOCK_TICK_MS = 30_000;

const RUN_WORD: Record<RunMark, string> = {
  ok: "Finished",
  failed: "Failed",
  needs: "Waiting for your answer",
  running: "Running",
  skipped: "Skipped",
};

function firstLine(text: string | undefined): string {
  return (text ?? "").trim().split("\n", 1)[0].trim();
}

function subTabStorageKey(workspaceId: string): string {
  return `${SUBTAB_STORAGE_KEY}:${workspaceId}`;
}

// Attempt statuses that mean the worker process is still going. Mirrors the
// module-private set in WorkersView / LiveBoard, one live-vs-done rule.
const LIVE_ATTEMPT = new Set(["preparing", "prompt_ready", "launching", "running", "finishing"]);

export default function AutomationsPage({
  workspaceId,
  workspaceName,
  cwd,
  active,
  onOpenRunChat,
  onAskCora,
}: Props): React.ReactElement {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [search, setSearch] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const clock = window.setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(clock);
  }, [active]);
  const names = useMemo(() => new Map(jobs.map((job) => [job.id, job.name])), [jobs]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [liveRun, setLiveRun] = useState<RunState | null>(null);
  const [subTab, setSubTab] = useState<SubTab>(() => {
    try {
      const remembered =
        window.localStorage.getItem(subTabStorageKey(workspaceId)) ??
        window.localStorage.getItem(SUBTAB_STORAGE_KEY);
      return remembered === "workers" || remembered === "workflows" ? remembered : "looms";
    } catch {
      return "looms";
    }
  });
  // Inline feedback when an action (Run now / Pause / Save) fails; there is no
  // renderer-callable toast API, so errors surface locally.
  const [actionError, setActionError] = useState<string | null>(null);
  // Live board: the whiteboard view of the selected automation's run. Never
  // auto-opens; only the explicit Board buttons open it, and closing it is
  // always manual too.
  const [boardOpen, setBoardOpen] = useState(false);
  // When the board is opened from a worker row, the attemptId to focus the
  // board's activity sheet on. Cleared on close / selection change so the same
  // worker clicked twice re-fires LiveBoard's focus effect.
  const [boardFocusWorkerId, setBoardFocusWorkerId] = useState<string | null>(null);

  const workers = useAutomationWorkers(active);
  const workspaceWorkers = useMemo(
    () => workers.filter((w) => jobs.some((j) => j.id === w.automationId)),
    [workers, jobs],
  );
  const anyBlocked = workspaceWorkers.some((w) => w.blocked);
  // Holds the Workers overlay mounted across top-level tab switches while any
  // of this workspace's workers is still running (see the overlay gate below).
  const anyLiveWorkspaceWorker = workspaceWorkers.some((w) => LIVE_ATTEMPT.has(w.status));

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const switchSubTab = useCallback(
    (next: SubTab) => {
      setSubTab(next);
      try {
        window.localStorage.setItem(subTabStorageKey(workspaceId), next);
      } catch {
        /* persistence is a nicety */
      }
    },
    [workspaceId],
  );

  const refresh = useCallback(async () => {
    try {
      const list = await window.spark.scheduler.list();
      // Only this workspace's automations.
      setJobs(list.filter((j) => j.input.workspaceId === workspaceId));
    } catch {
      /* best-effort: keep last good view */
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // Looms v3: the loom's most recent SETTLED run, for when nothing is live —
  // a steps-only pass is born terminal (never observed live), so the board
  // and the pass card would otherwise have no run to paint outputs from.
  const [settledRun, setSettledRun] = useState<RunState | null>(null);
  const refreshDetail = useCallback(async () => {
    const id = selectedIdRef.current;
    if (!id) {
      setLiveRun(null);
      setSettledRun(null);
      return;
    }
    try {
      const detail = await window.spark.scheduler.getDetail?.(id);
      setLiveRun(detail?.liveRun ?? null);
      const job = detail?.job;
      const lastId = job?.lastRunId ?? job?.history[job.history.length - 1]?.runId;
      if (!detail?.liveRun && lastId) {
        const run = await window.spark.orchestration.getRun(lastId);
        if (selectedIdRef.current === id) setSettledRun(run ?? null);
      } else {
        setSettledRun(null);
      }
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
      } else if (event.runId && event.runId === liveRun?.id && !isLiveOnlyEvent(event)) {
        void refreshDetail();
      }
    });
    return () => unsubscribe();
  }, [refresh, refreshDetail, liveRun?.id]);

  // Keep the selection valid; auto-select the top of the inbox when nothing is
  // chosen.
  useEffect(() => {
    if (jobs.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !jobs.some((j) => j.id === selectedId)) {
      if (mode.kind === "view") setSelectedId(groupJobs(jobs, Date.now())[0]?.jobs[0]?.id ?? jobs[0].id);
    }
  }, [jobs, selectedId, mode.kind]);

  // Re-resolve the detail run when the selection changes.
  useEffect(() => {
    void refreshDetail();
  }, [selectedId, refreshDetail]);

  // "Jump to this automation" from the Cora Hub. Two arrival paths (see
  // focus-request.ts): the live spark:open-automation event when this page is
  // already mounted, and the pending slot consumed on mount when the click had
  // to create the tab first. The request is staged, not applied inline: on a
  // fresh mount jobs is still [] and the selection-keeper effect would wipe a
  // premature setSelectedId, so it waits for the first list load below.
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  useEffect(() => {
    const pending = consumePendingAutomationFocus();
    if (pending !== null) setFocusRequest(pending);
    const handler = (event: Event) => {
      // Clear the one-shot slot too; it holds this same id, and leaving it
      // would replay the jump on the page's next mount.
      consumePendingAutomationFocus();
      const id = (event as CustomEvent<{ automationId?: unknown }>).detail?.automationId;
      if (typeof id === "string") setFocusRequest(id);
    };
    window.addEventListener("spark:open-automation", handler);
    return () => window.removeEventListener("spark:open-automation", handler);
  }, []);

  // "Show this workflow run" jumps, through the same two channels.
  const [workflowFocus, setWorkflowFocus] = useState<string | null>(null);
  useEffect(() => {
    const pending = consumePendingWorkflowRunFocus();
    if (pending !== null) {
      setWorkflowFocus(pending);
      switchSubTab("workflows");
    }
    const handler = (event: Event) => {
      consumePendingWorkflowRunFocus();
      const id = (event as CustomEvent<{ runId?: unknown }>).detail?.runId;
      if (typeof id !== "string") return;
      setWorkflowFocus(id);
      switchSubTab("workflows");
    };
    window.addEventListener("spark:open-workflow-run", handler);
    return () => window.removeEventListener("spark:open-workflow-run", handler);
  }, [switchSubTab]);
  const clearWorkflowFocus = useCallback(() => setWorkflowFocus(null), []);
  useEffect(() => {
    if (focusRequest === null || loading) return;
    setFocusRequest(null);
    // Deleted (or another workspace's) automation: nothing to focus.
    if (!jobs.some((j) => j.id === focusRequest)) return;
    // Leaving an in-flight create/edit draft is deliberate: the user
    // explicitly asked for this automation. Drafts are ephemeral by design.
    switchSubTab("looms");
    setMode({ kind: "view" });
    setSelectedId(focusRequest);
  }, [focusRequest, loading, jobs, switchSubTab]);

  const selected = useMemo(() => jobs.find((j) => j.id === selectedId) ?? null, [jobs, selectedId]);

  // While this automation's page is on screen, its own finished, failed and
  // blocked alerts count as seen (isTargetViewed). The editor, the other
  // sub-tabs and a hidden tab show no automation.
  const viewedJobId = active && subTab === "looms" && mode.kind === "view" ? (selected?.id ?? null) : null;
  useEffect(() => {
    if (!viewedJobId) return;
    return reportViewedAutomation(workspaceId, viewedJobId);
  }, [workspaceId, viewedJobId]);

  // ── live board open/close ───────────────────────────────────────────────
  // Selection change always closes the board (a different automation's board
  // is a different surface); the new selection's board waits for an explicit
  // open.
  useEffect(() => {
    setBoardOpen(false);
    setBoardFocusWorkerId(null);
  }, [selectedId]);

  const openLiveBoard = useCallback(() => {
    switchSubTab("looms");
    setBoardFocusWorkerId(null);
    setBoardOpen(true);
  }, [switchSubTab]);

  // Open the board AND focus its activity sheet on one specific worker.
  const openBoardFocused = useCallback(
    (attemptId: string) => {
      switchSubTab("looms");
      setBoardFocusWorkerId(attemptId);
      setBoardOpen(true);
    },
    [switchSubTab],
  );

  const closeLiveBoard = useCallback(() => {
    setBoardOpen(false);
    setBoardFocusWorkerId(null);
  }, []);

  const boardWorkers = useMemo(
    () => (selected ? workspaceWorkers.filter((w) => w.automationId === selected.id) : []),
    [workspaceWorkers, selected],
  );

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
        setActionError(e instanceof Error ? e.message : "Couldn't create the automation. Try again.");
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
        setActionError(e instanceof Error ? e.message : "Couldn't save the automation. Try again.");
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
        setActionError(e instanceof Error ? e.message : "Action failed. Try again.");
      } finally {
        await refresh();
        await refreshDetail();
      }
    },
    [refresh, refreshDetail],
  );

  const openDetail = useCallback(
    (automationId: string) => {
      setSelectedId(automationId);
      switchSubTab("looms");
      // Preserve an in-progress editor draft: only drop to the view when
      // nothing is being authored (this is reachable while editing via a
      // Workers-pane automation button).
      setMode((m) => (m.kind === "create" || m.kind === "edit" ? m : { kind: "view" }));
    },
    [switchSubTab],
  );

  const startCreate = useCallback(() => {
    setActionError(null);
    switchSubTab("looms");
    setMode((m) => (m.kind === "create" || m.kind === "edit" ? m : { kind: "create" }));
  }, [switchSubTab]);

  const stopAutomation = useCallback(
    (automationId: string) => {
      void act(() => window.spark.scheduler.stop!(automationId));
    },
    [act],
  );

  // Jump from an automation's detail to the chat that created it.
  const openCreatorChat = useCallback(
    (runId: string) => {
      setActionError(null);
      onOpenRunChat?.(runId);
    },
    [onOpenRunChat],
  );

  // "editing" = the node-flow editor owns the stage (create/edit draft).
  const editing = mode.kind === "create" || mode.kind === "edit";
  // Live board on screen: it owns the detail area while open, but yields to
  // the editor overlay and to the Workers sub-tab (kept mounted under the same
  // visibility contract so the canvas viewport survives).
  const boardShowing = boardOpen && selected !== null && subTab === "looms" && !editing;

  // The rail: always on screen. What needs the user comes first, then what
  // failed, what is running, what is scheduled and what is paused. The footer
  // swaps the stage to workflows and to the global workers grid.
  const query = search.trim().toLowerCase();
  const found = query
    ? jobs.filter((job) =>
        `${job.name} ${plainSchedule(job.trigger, names)} ${jobWorkerSummary(job)}`.toLowerCase().includes(query),
      )
    : jobs;
  const shelves = groupJobs(found, nowMs);
  const rail = (
    <aside className="automation-rail">
      <div className="automation-rail__head">
        <input
          className="spark-input"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSearch("");
          }}
          placeholder="Find an automation"
          aria-label="Find an automation"
          style={{ flex: 1, minWidth: 0, height: 24 }}
        />
        <button
          type="button"
          className="spark-btn is-primary"
          style={{ flex: "0 0 auto", height: 24, padding: "0 9px", fontSize: 11 }}
          disabled={editing}
          onClick={startCreate}
          aria-label="New automation"
          title={editing ? "The editor is already open" : "Open the flow editor"}
        >
          New
        </button>
      </div>

      <div className="automation-rail__list">
        {loading ? (
          <div className="automation-quiet" style={{ padding: "10px 8px" }}>Loading…</div>
        ) : jobs.length === 0 ? (
          <div style={{ padding: "26px 10px", fontSize: 11.5, lineHeight: 1.6, color: "var(--ink-dim)" }}>
            Nothing here yet. Ask Cora in any chat to automate something recurring, or create one
            with the button above.
          </div>
        ) : shelves.length === 0 ? (
          <div className="automation-quiet" style={{ padding: "10px 8px" }}>No automation matches.</div>
        ) : (
          shelves.map((shelf) => (
            <React.Fragment key={shelf.id}>
              <div className="automation-group" data-testid={`automation-group-${shelf.id}`}>
                {shelf.label}
                <span className="automation-group__count spark-num">{shelf.jobs.length}</span>
              </div>
              {shelf.jobs.map((job) => (
                <AutomationRow
                  key={job.id}
                  job={job}
                  selected={job.id === selectedId && subTab === "looms"}
                  nowMs={nowMs}
                  names={names}
                  onSelect={() => {
                    setActionError(null);
                    setSelectedId(job.id);
                    switchSubTab("looms");
                  }}
                  onToggleEnabled={(enabled) =>
                    void act(() => window.spark.scheduler.setEnabled(job.id, enabled))
                  }
                />
              ))}
            </React.Fragment>
          ))
        )}
      </div>

      {/* Workflows: saved scripts that fan work out to many agents, and
          their runs. */}
      <button
        type="button"
        data-testid="automations-workflows-tab"
        onClick={() => switchSubTab(subTab === "workflows" ? "looms" : "workflows")}
        aria-pressed={subTab === "workflows"}
        style={{
          appearance: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          border: "none",
          borderTop: "1px solid var(--rule)",
          background:
            subTab === "workflows" ? "color-mix(in oklch, var(--accent) 10%, var(--panel))" : "transparent",
          textAlign: "left",
          cursor: "default",
        }}
        onMouseEnter={(e) => {
          if (subTab !== "workflows") e.currentTarget.style.background = "var(--hover)";
        }}
        onMouseLeave={(e) => {
          if (subTab !== "workflows") e.currentTarget.style.background = "transparent";
        }}
        title={subTab === "workflows" ? "Back to the automation detail" : "Saved workflows and their runs"}
      >
        <span
          style={{
            flex: 1,
            fontSize: 12,
            fontWeight: 650,
            color: subTab === "workflows" ? "var(--ink)" : "var(--muted)",
          }}
        >
          Workflows
        </span>
        <span aria-hidden className="spark-mono" style={{ fontSize: 11, color: "var(--muted-2)" }}>
          {subTab === "workflows" ? "‹" : "›"}
        </span>
      </button>

      {/* Footer: the global workers grid. Click to flip the stage there and
          back; never automatic. */}
      <button
        type="button"
        onClick={() => switchSubTab(subTab === "workers" ? "looms" : "workers")}
        aria-pressed={subTab === "workers"}
        style={{
          appearance: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          border: "none",
          borderTop: "1px solid var(--rule)",
          background:
            subTab === "workers" ? "color-mix(in oklch, var(--accent) 10%, var(--panel))" : "transparent",
          textAlign: "left",
          cursor: "default",
        }}
        onMouseEnter={(e) => {
          if (subTab !== "workers") e.currentTarget.style.background = "var(--hover)";
        }}
        onMouseLeave={(e) => {
          if (subTab !== "workers") e.currentTarget.style.background = "transparent";
        }}
        title={subTab === "workers" ? "Back to the automation detail" : "Every live worker's activity, live"}
      >
        <span
          style={{
            flex: 1,
            fontSize: 12,
            fontWeight: 650,
            color: subTab === "workers" ? "var(--ink)" : "var(--muted)",
          }}
        >
          Workers
        </span>
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
        <span aria-hidden className="spark-mono" style={{ fontSize: 11, color: "var(--muted-2)" }}>
          {subTab === "workers" ? "‹" : "›"}
        </span>
      </button>
    </aside>
  );

  return (
    <div
      className="automation-page"
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

      {/* ── Body: rail + stage ───────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex" }}>
        {rail}

        {/* The STAGE: a position:relative flex container to the right of the
            rail. Editor / workers grid mount here as absolute overlays kept
            MOUNTED while hidden, using visibility:hidden + pointer-events:none
            (never display:none) because the ReactFlow canvas measures its
            container and would collapse under display:none. */}
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative", display: "flex" }}>
          {editing && (
            <div
              aria-hidden={subTab !== "looms"}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                // "inherit", not "visible"/"auto": an explicit visible/auto
                // child punches through the visibility:hidden the tab stack
                // puts on this page when another top-level tab is active.
                visibility: subTab === "looms" ? "inherit" : "hidden",
                pointerEvents: subTab === "looms" ? "inherit" : "none",
              }}
            >
              <NodeFlowEditor
                initial={mode.kind === "edit" ? mode.job : undefined}
                jobs={jobs}
                workspaceId={workspaceId}
                workspaceName={workspaceName}
                cwd={cwd}
                onCreate={mode.kind === "create" ? handleCreate : undefined}
                onSave={mode.kind === "edit" ? handleSaveEdit : undefined}
                onCancel={() => setMode({ kind: "view" })}
              />
            </div>
          )}

          {/* Workers sub-tab: kept MOUNTED behind the looms sub-tab (same
              visibility contract as the editor overlay) so a flip never tears
              down the live activity streams. Gated on `active` OR a live
              workspace worker so returning to a running worker never forces a
              cold re-read; once nothing is live an inactive tab still tears
              the overlay down. */}
          {(active || anyLiveWorkspaceWorker) && (
            <div
              aria-hidden={subTab !== "workers"}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                visibility: subTab === "workers" ? "inherit" : "hidden",
                pointerEvents: subTab === "workers" ? "inherit" : "none",
              }}
            >
              <WorkersView
                workers={workspaceWorkers}
                jobs={jobs}
                visible={active && subTab === "workers"}
                onStopLoom={stopAutomation}
                onSelectLoom={openDetail}
                onNewLoom={startCreate}
              />
            </div>
          )}

          {subTab === "workflows" && (
            <WorkflowsView
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              cwd={cwd}
              visible={active}
              focusRunId={workflowFocus}
              onFocusConsumed={clearWorkflowFocus}
            />
          )}

          {!editing && subTab === "looms" && (
            <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
              {!selected ? (
                loading ? null : jobs.length === 0 ? (
                  <AutomationsEmptyState onCreate={startCreate} />
                ) : (
                  <div className="spark-empty" style={{ flex: 1, gap: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 650, color: "var(--ink-dim)" }}>
                      Select an automation
                    </div>
                    <div className="spark-empty__body">
                      Pick one on the left to see its state, workers, and history.
                    </div>
                  </div>
                )
              ) : (
                <AutomationDetail
                  job={selected}
                  liveRun={liveRun}
                  workers={boardWorkers}
                  heroShown={active && !boardOpen}
                  nowMs={nowMs}
                  names={names}
                  onAskCora={onAskCora}
                  onEdit={() => setMode({ kind: "edit", job: selected })}
                  onOpenCreatorChat={
                    selected.createdByRunId && onOpenRunChat
                      ? () => openCreatorChat(selected.createdByRunId as string)
                      : undefined
                  }
                  onRunNow={() => void act(() => window.spark.scheduler.runNow(selected.id))}
                  onPause={() => void act(() => window.spark.scheduler.pause!(selected.id))}
                  onResume={() => void act(() => window.spark.scheduler.resume!(selected.id))}
                  onStop={() => stopAutomation(selected.id)}
                  onToggleEnabled={(enabled) =>
                    void act(() => window.spark.scheduler.setEnabled(selected.id, enabled))
                  }
                  onDelete={() =>
                    void act(async () => {
                      await window.spark.scheduler.remove(selected.id);
                      setSelectedId(null);
                    })
                  }
                  onOpenLiveBoard={openLiveBoard}
                  onOpenBoardFocused={openBoardFocused}
                  onAnswer={(runId, questionMessageId, answer) =>
                    void act(() =>
                      window.spark.orchestration.answerRunQuestion({
                        runId,
                        questionMessageId,
                        message: answer,
                      }),
                    )
                  }
                />
              )}
            </section>
          )}

          {/* Live board overlay: the automation's run as a full whiteboard.
              Kept MOUNTED across sub-tab flips and editor excursions (same
              visibility contract as the other overlays). Painted last so it
              sits above the in-flow detail while showing. */}
          {boardOpen && selected && (
            <div
              aria-hidden={!boardShowing}
              style={{
                position: "absolute",
                inset: 0,
                // Above the detail's sticky header (zIndex 2).
                zIndex: 5,
                display: "flex",
                visibility: boardShowing ? "inherit" : "hidden",
                pointerEvents: boardShowing ? "inherit" : "none",
              }}
            >
              <LiveBoard
                key={selected.id}
                job={selected}
                liveRun={liveRun ?? settledRun}
                workers={boardWorkers}
                initialFocusWorkerId={boardFocusWorkerId}
                shown={active && boardShowing}
                onClose={closeLiveBoard}
                onOpenWorkersGrid={() => switchSubTab("workers")}
                onStop={() => stopAutomation(selected.id)}
                onAnswer={(runId, questionMessageId, answer) =>
                  void act(() =>
                    window.spark.orchestration.answerRunQuestion({
                      runId,
                      questionMessageId,
                      message: answer,
                    }),
                  )
                }
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

// The zero-automations stage. An invitation, not a shrug: it teaches that
// automations grow out of ordinary Cora chats, with manual creation as the
// secondary path. Deliberately quiet; one primary action.
function AutomationsEmptyState({ onCreate }: { onCreate: () => void }): React.ReactElement {
  return (
    <div className="automations-empty spark-fade-in">
      <span className="automations-empty__mark" aria-hidden>
        <LoomIcon kind="trigger" tone="var(--warn)" size={18} />
      </span>
      <h2 className="automations-empty__title">This project can keep working while you're away</h2>
      <p className="automations-empty__body">
        Ask Cora in any chat to automate something recurring, like "run the tests every night and
        fix what breaks". She sets up the trigger, the loop, and the workers, and it appears here,
        running on your schedule.
      </p>
      <div className="automations-empty__actions">
        <button type="button" className="spark-btn is-primary" onClick={onCreate}>
          New automation
        </button>
        <span className="automations-empty__alt">or wire the flow yourself in the editor</span>
      </div>
      <p className="automations-empty__anatomy spark-mono">trigger · loop · workers · guards</p>
    </div>
  );
}

// ── Rail row ─────────────────────────────────────────────────────────────────

const AutomationRow = React.memo(function AutomationRow({
  job,
  selected,
  nowMs,
  names,
  onSelect,
  onToggleEnabled,
}: {
  job: ScheduledJob;
  selected: boolean;
  nowMs: number;
  names: ReadonlyMap<string, string>;
  onSelect: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}): React.ReactElement {
  const group = inboxGroup(job);
  const status = statusWord(job, nowMs);
  const schedule = rowSchedule(job, nowMs, names);
  const runs = recentRuns(job, RECENT_RUNS_IN_ROW, nowMs);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-group={group}
      className="automation-row"
    >
      <span aria-hidden className={`automation-dot is-${group}`} />
      <span className="automation-row__main">
        <span className="automation-row__name">
          <span className="automation-row__title" title={job.name}>
            {job.name}
          </span>
          <span className={`automation-row__word is-${status.tone}`}>{status.word}</span>
        </span>
        <span className="automation-row__sub" title={`${schedule} · ${jobWorkerSummary(job)}`}>
          {schedule}
        </span>
        {runs.length > 0 && <RunTicks runs={runs} />}
      </span>
      {/* Quick pause, in the status word's place while the row is hovered or
          this control has focus. A span with role=button because the row itself
          is already a <button>. */}
      <span
        role="button"
        tabIndex={0}
        aria-label={job.enabled ? "Pause this automation" : "Turn this automation on"}
        title={job.enabled ? "Pause: nothing new starts by itself" : "Turn on: it starts by itself again"}
        className="automation-row__toggle"
        onClick={(e) => {
          e.stopPropagation();
          onToggleEnabled(!job.enabled);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            onToggleEnabled(!job.enabled);
          }
        }}
      >
        {job.enabled ? "Pause" : "Turn on"}
      </span>
    </button>
  );
});

// ── Detail ───────────────────────────────────────────────────────────────────

function AutomationDetail({
  job,
  liveRun,
  workers,
  heroShown,
  nowMs,
  names,
  onEdit,
  onOpenCreatorChat,
  onRunNow,
  onPause,
  onResume,
  onStop,
  onToggleEnabled,
  onDelete,
  onOpenLiveBoard,
  onOpenBoardFocused,
  onAnswer,
  onAskCora,
}: {
  job: ScheduledJob;
  liveRun: RunState | null;
  // This automation's workers only (live + briefly-lingering exited ones).
  workers: AutomationWorkerInfo[];
  // The detail is on screen and unobstructed (tab active, board closed) —
  // gates the live hero's 1s clock and activity poll.
  heroShown: boolean;
  nowMs: number;
  names: ReadonlyMap<string, string>;
  onEdit: () => void;
  // Present only when this automation carries a createdByRunId; the button is
  // further gated below on the run still existing.
  onOpenCreatorChat?: () => void;
  onRunNow: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  // Opens the live board, the flow canvas with live worker activity docked in.
  onOpenLiveBoard: () => void;
  // Opens the board focused on one worker (by attemptId).
  onOpenBoardFocused: (attemptId: string) => void;
  onAnswer: (runId: string, questionMessageId: string, answer: string) => void;
  onAskCora?: (prompt: string) => void;
}): React.ReactElement {
  const status = job.state.status;
  const running = status === "running" || status === "blocked";
  // Resolve whether the creator chat still exists so a deleted run doesn't
  // leave a dead "Open chat" button. One cheap getRun per automation that has
  // a back-pointer; re-checked when the pointer changes.
  const creatorRunId = job.createdByRunId;
  const [creatorRunExists, setCreatorRunExists] = useState(false);
  // Keyed on the run id ONLY: onOpenCreatorChat is a fresh closure each render
  // (frequent while a run streams), so depending on it would re-fire getRun
  // every render. The button is separately gated on onOpenCreatorChat below,
  // and the two always move together (both derive from job.createdByRunId).
  useEffect(() => {
    if (!creatorRunId) {
      setCreatorRunExists(false);
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const run = await window.spark.orchestration.getRun(creatorRunId);
        if (!disposed) setCreatorRunExists(run !== null);
      } catch {
        if (!disposed) setCreatorRunExists(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [creatorRunId]);
  const canOpenCreatorChat = creatorRunExists && !!onOpenCreatorChat;
  return (
    // flex:"1 0 auto": fill the scroll pane's height so the last section's
    // background runs to the bottom instead of leaving a dead void.
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 0 auto" }}>
      <div className="automation-head">
        <div className="automation-head__main">
          <div className="automation-head__title">
            <span aria-hidden className={`automation-dot is-${inboxGroup(job)}`} />
            <span className="automation-head__name" title={job.name}>{job.name}</span>
          </div>
          <p className="automation-sentence" data-testid="automation-sentence">
            {plainSentence(job, names).map((part, i) =>
              part.strong ? <b key={i}>{part.text}</b> : <React.Fragment key={i}>{part.text}</React.Fragment>,
            )}
          </p>
        </div>
        <ActionBar
          job={job}
          onRunNow={onRunNow}
          onPause={onPause}
          onResume={onResume}
          onStop={onStop}
          onEdit={onEdit}
          onToggleEnabled={onToggleEnabled}
          onOpenLiveBoard={onOpenLiveBoard}
        />
      </div>

      {/* THE LIVE MOMENT: while a pass is in flight the detail leads with the
          machine actually working — wire electricity, comet arc, ticking
          readout, and the worker's live activity stream. Quiet automations get
          the last result instead. */}
      <div style={{ padding: "12px 16px 0" }}>
        {running ? (
          <LiveRunHero
            job={job}
            liveRun={liveRun}
            workers={workers}
            shown={heroShown}
            onOpenLiveBoard={onOpenLiveBoard}
            onAnswer={onAnswer}
          />
        ) : (
          <ResultCard job={job} liveRun={liveRun} nowMs={nowMs} onAnswer={onAnswer} onAskCora={onAskCora} />
        )}
      </div>

      <RecentRunsBar job={job} nowMs={nowMs} />

      {/* Workers: THIS automation's live/lingering workers, surfaced inside
          the detail (not only on the global Workers grid). Hidden when none. */}
      {workers.length > 0 && (
        <Section label="Workers" count={workers.length}>
          <DetailWorkersList workers={workers} onOpenBoardFocused={onOpenBoardFocused} />
        </Section>
      )}

      <Section label="Runs" count={job.history.length + (job.skips?.length ?? 0)}>
        <HistoryTimeline jobId={job.id} history={job.history} skips={job.skips} liveRunId={job.state.currentRunId} onOpenLiveBoard={onOpenLiveBoard} nowMs={nowMs} />
      </Section>

      <Section label="How it runs">
        <MiniFlow job={job} liveRun={liveRun} onOpenEditor={onEdit} />
      </Section>

      {/* Read-only settings, then the actions a reader reaches for rarely:
          destructive last and well away from Run now. Grows to absorb the
          leftover height so the page reads as one composed surface. */}
      <Section label="Details" grow>
        <ConfigSummary job={job} names={names} />
        <DetailFooter onOpenCreatorChat={canOpenCreatorChat ? onOpenCreatorChat : undefined} onDelete={onDelete} />
      </Section>
    </div>
  );
}

function DetailFooter({
  onOpenCreatorChat,
  onDelete,
}: {
  onOpenCreatorChat?: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const btn: React.CSSProperties = { height: 24, fontSize: 11 };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
      {onOpenCreatorChat && (
        <button
          type="button"
          className="spark-btn"
          style={btn}
          onClick={onOpenCreatorChat}
          title="Open the Cora chat that created this automation"
        >
          ✦ Open chat
        </button>
      )}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        className="spark-btn is-danger"
        style={btn}
        onClick={() => {
          if (confirmDelete) {
            setConfirmDelete(false);
            onDelete();
          } else {
            setConfirmDelete(true);
          }
        }}
        onMouseLeave={() => setConfirmDelete(false)}
        title="Delete this automation (its run history stays on disk)"
      >
        {confirmDelete ? "Confirm delete" : "Delete"}
      </button>
    </div>
  );
}

// ── Action bar ───────────────────────────────────────────────────────────────

function ActionBar({
  job,
  onRunNow,
  onPause,
  onResume,
  onStop,
  onEdit,
  onToggleEnabled,
  onOpenLiveBoard,
}: {
  job: ScheduledJob;
  onRunNow: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onEdit: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onOpenLiveBoard: () => void;
}): React.ReactElement {
  const [confirmStop, setConfirmStop] = useState(false);
  const status = job.state.status;
  const running = status === "running" || status === "blocked";
  const btn: React.CSSProperties = { height: 26, fontSize: 11.5 };
  return (
    <div className="automation-actions">
      <button
        type="button"
        className={`spark-btn${!running ? " is-primary" : ""}`}
        style={btn}
        onClick={onRunNow}
        title={running ? "Stop the current run and start over" : "Start a fresh run now"}
      >
        {running ? "Restart" : "Run now"}
      </button>
      {status === "paused" ? (
        <button type="button" className="spark-btn" style={btn} onClick={onResume} title="Carry on with the run on hold">
          Resume
        </button>
      ) : running ? (
        <button type="button" className="spark-btn" style={btn} onClick={onPause} title="Hold this run; resume it any time">
          Hold run
        </button>
      ) : null}
      {running && (
        <button
          type="button"
          className="spark-btn is-danger"
          style={btn}
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
      )}
      <button
        type="button"
        className="spark-btn"
        style={btn}
        onClick={() => onToggleEnabled(!job.enabled)}
        title={
          job.enabled
            ? "Pause the automation: nothing new starts by itself (a live run keeps going)"
            : "Turn the automation back on: it starts by itself again"
        }
      >
        {job.enabled ? "Pause" : "Turn on"}
      </button>
      <button type="button" className="spark-btn" style={btn} onClick={onEdit} title="Open this automation in the flow editor">
        Edit
      </button>
      {/* The board's ONLY entry points are explicit clicks like this one; it
          never auto-opens. */}
      <button
        type="button"
        className="spark-btn"
        style={
          running
            ? { ...btn, borderColor: "var(--accent-edge)", background: "var(--accent-soft)" }
            : btn
        }
        onClick={onOpenLiveBoard}
        title={
          running
            ? "Watch this run on the whiteboard: live graph and worker activity"
            : "Open the whiteboard with the last run's state"
        }
      >
        {running ? "Live board" : "Board"}
      </button>
    </div>
  );
}

function Section({
  label,
  count,
  grow,
  children,
}: {
  label: string;
  count?: number;
  // Grow to fill the leftover column height (for the LAST section, so the
  // detail never ends in a dead void).
  grow?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={
        grow
          ? { flex: "1 0 auto", display: "flex", flexDirection: "column" }
          : { borderBottom: "1px solid var(--rule-soft)" }
      }
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "12px 16px 4px" }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: "var(--ink-dim)" }}>{label}</span>
        {typeof count === "number" && (
          <span className="spark-num automation-quiet">{count}</span>
        )}
      </div>
      <div style={{ padding: "4px 16px 14px", ...(grow ? { flex: 1 } : {}) }}>{children}</div>
    </div>
  );
}

// ── This automation's workers (inside the detail) ────────────────────────────

function DetailWorkersList({
  workers,
  onOpenBoardFocused,
}: {
  workers: AutomationWorkerInfo[];
  onOpenBoardFocused: (attemptId: string) => void;
}): React.ReactElement {
  const anyLive = useMemo(() => workers.some((w) => LIVE_ATTEMPT.has(w.status)), [workers]);
  // One shared 1s clock for the elapsed readouts, ticking only while a worker
  // is live (a settled row's "finished" label needs no ticking).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyLive) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [anyLive]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {workers.map((w) => (
        <DetailWorkerRow key={w.attemptId} worker={w} now={now} onOpenBoardFocused={onOpenBoardFocused} />
      ))}
    </div>
  );
}

function DetailWorkerRow({
  worker,
  now,
  onOpenBoardFocused,
}: {
  worker: AutomationWorkerInfo;
  now: number;
  onOpenBoardFocused: (attemptId: string) => void;
}): React.ReactElement {
  const live = LIVE_ATTEMPT.has(worker.status);
  const blocked = worker.blocked;
  // Steady dot: accent live, danger blocked, muted otherwise. No pulse.
  const dot = blocked ? "var(--danger)" : live ? "var(--accent)" : "var(--muted)";
  const meta = workerSummary(worker);
  const title = worker.nodeLabel ?? "Worker";

  const body = (
    <>
      <span
        aria-hidden
        style={{
          flex: "0 0 8px",
          width: 8,
          height: 8,
          borderRadius: 999,
          background: dot,
          boxShadow: `0 0 0 3px color-mix(in oklch, ${dot} 18%, transparent)`,
        }}
      />
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={title}
        >
          {title}
          <span className="spark-mono spark-num" style={{ marginLeft: 8, fontWeight: 400, fontSize: 10, color: "var(--muted)" }}>
            pass {worker.iteration + 1}
          </span>
        </span>
        <span
          className="spark-mono"
          style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          title={worker.model ?? "Default model"}
        >
          {meta}
        </span>
      </span>
      {blocked && (
        <span className="spark-badge is-danger" style={{ flex: "0 0 auto" }}>
          needs you
        </span>
      )}
      <span
        className="spark-mono spark-num"
        style={{ flex: "0 0 auto", fontSize: 10, color: "var(--muted-2)" }}
        title={worker.startedAt ? `started ${fmtClock(worker.startedAt)}` : undefined}
      >
        {live ? fmtElapsed(worker.startedAt, now) : "finished"}
      </span>
    </>
  );

  const shared: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "7px 10px",
    borderRadius: "var(--radius-control)",
    border: "1px solid var(--rule-soft)",
    background: "var(--panel)",
    textAlign: "left",
  };

  // Live rows open the board focused on this worker; a lingering exited row is
  // not interactive (its activity stream is released).
  if (!live) {
    return <div style={shared}>{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpenBoardFocused(worker.attemptId)}
      title="Open the board on this worker's activity"
      style={{ ...shared, appearance: "none", width: "100%", cursor: "default" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--panel)")}
    >
      {body}
    </button>
  );
}

// ── The last result ──────────────────────────────────────────────────────────

// What the automation did last: the first thing a reader wants when nothing is
// running. Running work has the live hero instead.
function ResultCard({
  job,
  liveRun,
  nowMs,
  onAnswer,
  onAskCora,
}: {
  job: ScheduledJob;
  liveRun: RunState | null;
  nowMs: number;
  onAnswer: (runId: string, questionMessageId: string, answer: string) => void;
  onAskCora?: (prompt: string) => void;
}): React.ReactElement {
  const card = resultCard(job, nowMs);
  const [peeking, setPeeking] = useState(false);
  useEffect(() => {
    setPeeking(false);
  }, [card.runId]);
  const [answerDraft, setAnswerDraft] = useState("");
  // The held iteration's exact unresolved question. Its id must travel with
  // every answer; a historical same-text question is not interchangeable.
  const pendingQuestion = liveRun ? resolveOpenRunQuestion(liveRun) : null;
  const answerDraftScope = runQuestionDraftScopeKey(liveRun?.id, pendingQuestion?.id);
  // The card stays mounted while runs/questions change. Clear local text on
  // both identity boundaries, including question -> undefined when another
  // surface answers the currently displayed question.
  useEffect(() => {
    setAnswerDraft("");
  }, [answerDraftScope]);
  const send = (): void => {
    if (!liveRun || !pendingQuestion || !answerDraft.trim()) return;
    onAnswer(liveRun.id, pendingQuestion.id, answerDraft.trim());
    setAnswerDraft("");
  };
  return (
    <div className={`automation-result${card.failed ? " is-failed" : ""}`} data-testid="automation-result">
      <div className="automation-result__headline">{card.headline}</div>
      <div className="automation-result__body">{card.body}</div>
      {pendingQuestion && liveRun && (
        <div className="automation-ask">
          <span style={{ whiteSpace: "pre-wrap" }}>{pendingQuestion.message}</span>
          <div className="automation-ask__row">
            <input
              className="spark-input"
              value={answerDraft}
              onChange={(e) => setAnswerDraft(e.target.value)}
              placeholder="Answer the worker…"
              style={{ flex: 1, height: 26 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
            />
            <button
              type="button"
              className="spark-btn is-primary"
              style={{ height: 26, fontSize: 11 }}
              disabled={!answerDraft.trim()}
              onClick={send}
            >
              Send
            </button>
          </div>
        </div>
      )}
      {card.branch?.note && <div className="automation-result__body">{card.branch.note}</div>}
      {(card.facts.length > 0 || card.runId) && (
        <div className="automation-facts">
          {card.facts.map((fact) => (
            <span key={fact} className="automation-chip spark-num">
              {fact}
            </span>
          ))}
          <span style={{ flex: 1 }} />
          {card.branch?.prUrl && (
            <button
              type="button"
              className="spark-btn"
              style={{ height: 22, padding: "0 8px", fontSize: 11 }}
              title={card.branch.branch}
              onClick={() => void window.spark.openExternal(card.branch?.prUrl ?? "")}
            >
              Open draft pull request
            </button>
          )}
          {card.failed && onAskCora && (
            <button
              type="button"
              className="spark-btn"
              style={{ height: 22, padding: "0 8px", fontSize: 11 }}
              title="Open a Cora chat with this failure in the message box. Nothing is sent until you send it."
              onClick={() => onAskCora(fixWithCoraPrompt(job))}
            >
              Fix with Cora
            </button>
          )}
          {card.runId && (
            <button
              type="button"
              className="spark-btn"
              style={{ height: 22, padding: "0 8px", fontSize: 11 }}
              aria-expanded={peeking}
              onClick={() => setPeeking((open) => !open)}
            >
              {peeking ? "Hide what it did" : "See what it did"}
            </button>
          )}
        </div>
      )}
      {peeking && card.runId && <RunPeek runId={card.runId} onClose={() => setPeeking(false)} />}
    </div>
  );
}

// ── Recent runs ──────────────────────────────────────────────────────────────

function RunTicks({ runs, large }: { runs: RecentRun[]; large?: boolean }): React.ReactElement {
  return (
    <span className={`automation-ticks${large ? " is-large" : ""}`} aria-hidden={!large} role={large ? "img" : undefined} aria-label={large ? recentRunsLabel(runs) : undefined}>
      {runs.map((run, i) => (
        <i key={`${run.at}-${i}`} className={`is-${run.mark}`} title={large ? run.label : undefined} />
      ))}
    </span>
  );
}

function RecentRunsBar({ job, nowMs }: { job: ScheduledJob; nowMs: number }): React.ReactElement {
  const runs = recentRuns(job, RECENT_RUNS_ON_PAGE, nowMs);
  const partial = monthTotals(job, nowMs).partial;
  return (
    <div className="automation-health" data-testid="automation-health">
      {runs.length > 0 && (
        <div className="automation-health__bar">
          <RunTicks runs={runs} large />
          <span className="automation-quiet">{recentRunsLabel(runs)}</span>
        </div>
      )}
      <div
        className="automation-stats spark-num"
        title={partial ? `Only the last ${AUTOMATION_HISTORY_CAP} runs are kept, so the month's real totals can be higher.` : undefined}
      >
        {monthStats(job, nowMs).map((stat) => (
          <span key={stat}>{stat}</span>
        ))}
      </div>
    </div>
  );
}

// ── History timeline (accordion + run peek) ──────────────────────────────────

function HistoryTimeline({
  jobId,
  history,
  skips,
  liveRunId,
  onOpenLiveBoard,
  nowMs,
}: {
  jobId: string;
  history: AutomationRunRecord[];
  skips?: AutomationSkipRecord[];
  liveRunId?: string;
  onOpenLiveBoard: () => void;
  nowMs: number;
}): React.ReactElement {
  // Keyed iteration+runId: iteration alone collides across loop cycles
  // ("Run now" resets the counter while history is retained), which would
  // expand both records together.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [peekRunId, setPeekRunId] = useState<string | null>(null);

  if (history.length === 0 && !skips?.length) {
    return <div className="automation-quiet">No runs yet.</div>;
  }
  const rows = mergeTimeline(history, skips);
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((rec) => {
        if ("skip" in rec) return <SkippedHistoryRow key={`skip-${rec.skip.id}`} jobId={jobId} skip={rec.skip} />;
        const recKey = `${rec.iteration}-${rec.runId}`;
        const dot = runMarkOf(rec);
        const isExpanded = expanded === recKey;
        const isLive = rec.runId === liveRunId && rec.status === "running";
        return (
          <React.Fragment key={recKey}>
            {/* The row's hover/rule live on this wrapper so the copy control
                can sit beside the accordion button instead of inside it. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                paddingRight: 4,
                borderBottom: isExpanded ? "none" : "1px solid var(--rule-soft)",
                background: isExpanded ? "var(--hover)" : "transparent",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = isExpanded ? "var(--hover)" : "transparent")}
            >
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
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 4px",
                  border: "none",
                  background: "transparent",
                  cursor: "default",
                }}
              >
                <span aria-hidden className={`automation-dot is-${dot}`} />
                <span className="spark-mono spark-num automation-runs__when">
                  {fmtWhen(rec.startedAt, nowMs)}
                </span>
                <span className="automation-runs__text" title={rec.summary}>
                  {firstLine(rec.summary) || RUN_WORD[dot]}
                </span>
                {rec.catchUp && (
                  <span
                    className="spark-badge"
                    style={{ flex: "0 0 auto" }}
                    title={`Ran to catch up the scheduled time ${fmtTime(rec.catchUp.scheduledFor)}, which was missed`}
                  >
                    caught up
                  </span>
                )}
                {rec.stopReason && rec.stopReason !== "once" && rec.stopReason !== "agent-done" && (
                  <span
                    className={`spark-badge automation-runs__badge${
                      recordFailed(rec) ? " is-danger" : rec.stopReason === "tests-pass" ? " is-ok" : ""
                    }`}
                    style={{ flex: "0 0 auto" }}
                  >
                    {STOP_REASON_LABEL[rec.stopReason]}
                  </span>
                )}
                <span
                  className="spark-mono spark-num automation-runs__meta"
                  title={
                    (rec.costUsd ?? 0) > (rec.measuredCostUsd ?? 0)
                      ? "Includes estimated value of subscription usage priced at public list rates; billed spend: " +
                        fmtUsd(rec.measuredCostUsd ?? 0)
                      : "Billed spend"
                  }
                >
                  {rec.finishedAt ? `${fmtSpan(Date.parse(rec.finishedAt) - Date.parse(rec.startedAt))} · ` : ""}
                  {(rec.costUsd ?? 0) > (rec.measuredCostUsd ?? 0) ? "est. " : ""}
                  {fmtUsd(rec.costUsd)}
                </span>
              </button>
              <RunIdChip runId={rec.runId} compact />
            </div>
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
                  <RunIdChip runId={rec.runId} maxChars={24} />
                  <span style={{ flex: 1 }} />
                  {isLive ? (
                    <button type="button" className="spark-btn" style={{ height: 22, padding: "0 9px", fontSize: 10.5 }} onClick={onOpenLiveBoard}>
                      Live board →
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="spark-btn"
                        style={{ height: 22, padding: "0 9px", fontSize: 10.5, color: "var(--danger)" }}
                        title="Remove this pass from the history. The run record on disk is untouched."
                        onClick={() => {
                          setExpanded(null);
                          setPeekRunId(null);
                          void window.spark.scheduler.deleteHistoryEntry(jobId, rec.runId, rec.startedAt);
                        }}
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        className="spark-btn"
                        style={{ height: 22, padding: "0 9px", fontSize: 10.5 }}
                        onClick={() => setPeekRunId(peekRunId === rec.runId ? null : rec.runId)}
                      >
                        {peekRunId === rec.runId ? "Close peek" : "Peek run"}
                      </button>
                    </>
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

// ── Configuration summary ────────────────────────────────────────────────────

// Entry-first walk (BFS along forward edges, back-edges skipped, unreachable
// leftovers appended) so the config cards read in execution order.
function orderedNodes(graph: LoomGraph): LoomNodeDef[] {
  const seen = new Set<string>();
  const out: LoomNodeDef[] = [];
  const queue = [...graph.entryNodeIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) continue;
    out.push(node);
    for (const e of graph.edges) {
      if (e.from === id && !e.backEdge) queue.push(e.to);
    }
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) out.push(n);
  return out;
}

function predicateSummary(p: GuardPredicate): string {
  switch (p.type) {
    case "phrase":
      return `phrase "${p.phrase}"`;
    case "tests":
      return p.command ? `tests · ${p.command}` : "tests pass";
    case "gitClean":
      return "git clean";
    case "command":
      return `command · ${p.command}`;
    case "agentSignal":
      return p.want === "done" ? "agent says done" : "agent says continue";
  }
}

// One card per graph node: a multi-worker automation has one prompt and one
// model PER worker, so a single flat "Prompt" row would lie about what runs.
function NodeConfigCard({ node }: { node: LoomNodeDef }): React.ReactElement {
  const tone =
    node.kind === "worker"
      ? WORKER_TONE
      : node.kind === "guard"
        ? "var(--ok)"
        : node.kind === "step"
          ? STEP_TONE
          : "var(--info)";
  const title =
    node.kind === "step"
      ? stepTitle(node)
      : node.label || (node.kind === "worker" ? "Worker" : node.kind === "guard" ? "Guard" : "Merge");
  const meta =
    node.kind === "worker"
      ? workerSummary(node.worker)
      : node.kind === "guard"
        ? predicateSummary(node.predicate)
        : node.kind === "step"
          ? stepActionLine(node.action)
          : node.joinMode === "all"
            ? "waits for all branches"
            : "first branch wins";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "9px 12px",
        borderRadius: "var(--radius-surface)",
        border: "1px solid var(--rule-soft)",
        background: "var(--panel)",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 20px",
          width: 20,
          height: 20,
          marginTop: 1,
          borderRadius: 6,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: `1px solid color-mix(in oklch, ${tone} 26%, var(--rule-soft))`,
          background: `color-mix(in oklch, ${tone} 9%, var(--panel-2))`,
        }}
      >
        <LoomIcon kind={node.kind} stepType={node.kind === "step" ? node.action.type : undefined} tone={tone} size={12} />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <span
            style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            title={title}
          >
            {title}
          </span>
          <span className="spark-mono" style={{ flex: "0 0 auto", fontSize: 10, color: "var(--muted)" }}>
            {meta}
          </span>
        </div>
        {node.kind === "worker" && (
          <div
            className="spark-mono"
            style={{ fontSize: 11, color: "var(--ink-dim)", whiteSpace: "pre-wrap", maxHeight: 132, overflow: "auto" }}
          >
            {node.prompt || <span style={{ color: "var(--muted-2)" }}>none</span>}
          </div>
        )}
        {node.kind === "step" && node.action.type === "script" && (
          <div
            className="spark-mono"
            style={{ fontSize: 11, color: "var(--ink-dim)", whiteSpace: "pre-wrap", maxHeight: 132, overflow: "auto" }}
          >
            {node.action.code}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigSummary({ job, names }: { job: ScheduledJob; names: ReadonlyMap<string, string> }): React.ReactElement {
  // Tolerate malformed persisted jobs (loop without stop): the scheduler
  // backfills on read, but a bad record must never take down the renderer.
  const stop = job.loop?.stop ?? {};
  // Every chip says what it IS in words and explains itself on hover — the
  // old `est. $0.00` badge read as noise and hid where the setting lives
  // (the Loop node's "Safety caps" in the editor).
  const chips: { label: string; hint: string }[] = [];
  if (typeof stop.maxIterations === "number") {
    chips.push({
      label: `at most ${stop.maxIterations} run${stop.maxIterations === 1 ? "" : "s"}`,
      hint: "Hard stop after this many runs each time it starts. Edit: Loop node → Safety caps.",
    });
  }
  // budgetUsd <= 0 means "no cap" (engine semantics) — showing $0.00 as a
  // stop would be a lie.
  if (typeof stop.budgetUsd === "number" && stop.budgetUsd > 0) {
    chips.push({
      label: `budget ${fmtUsd(stop.budgetUsd)}`,
      hint: "Hard stop once the loop's estimated AI spend reaches this. Edit: Loop node → Safety caps → Est. budget.",
    });
  }
  if (stop.untilTestsPass) {
    chips.push({
      label: `until tests pass${stop.testCommand ? ` (${stop.testCommand})` : ""}`,
      hint: "The loop ends once the test command exits 0. Edit: Loop node → Stop when.",
    });
  }
  if (stop.untilGitClean) {
    chips.push({
      label: "until git is clean",
      hint: "The loop ends once the working tree has no changes. Edit: Loop node → Stop when.",
    });
  }
  if (stop.untilPhrase) {
    chips.push({
      label: `until phrase: ${stop.untilPhrase}`,
      hint: "The loop ends when the worker's summary contains this phrase. Edit: Loop node → Stop when.",
    });
  }
  if (stop.untilCommand) {
    chips.push({
      label: `until command passes (${stop.untilCommand})`,
      hint: "The loop ends once this shell command exits 0. Edit: Loop node → Stop when.",
    });
  }
  const nodes = orderedNodes(graphForJob(job));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <KeyVal
        k="Starts"
        v={job.trigger.kind === "cron" ? `${plainSchedule(job.trigger, names)} · ${triggerSummary(job.trigger)}` : plainSchedule(job.trigger, names)}
      />
      {precheckSummary(job.precheck) && <KeyVal k="Check first" v={precheckSummary(job.precheck) as string} />}
      {missedRunsSummary(job) && <KeyVal k="If missed" v={missedRunsSummary(job) as string} />}
      <KeyVal k="Repeats" v={loopSummary(job.loop)} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <ConfigKey label="Id" />
        <RunIdChip runId={job.id} label="automation id" maxChars={24} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <ConfigKey label="Stops" />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {chips.length === 0 ? (
            <span
              style={{ fontSize: 11, color: "var(--muted-2)" }}
              title="No stop conditions set. The loop runs its natural course. Add caps in the editor: Loop node → Safety caps."
            >
              no caps, engine defaults
            </span>
          ) : (
            chips.map((c) => (
              <span key={c.label} className="spark-badge" title={c.hint}>
                {c.label}
              </span>
            ))
          )}
        </div>
      </div>
      {/* The pipeline, node by node in execution order, each worker with ITS
          model and ITS prompt. */}
      <div style={{ display: "flex", gap: 8 }}>
        <ConfigKey label="Steps" />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {nodes.map((n) => (
            <NodeConfigCard key={n.id} node={n} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ConfigKey({ label }: { label: string }): React.ReactElement {
  return (
    <span
      style={{
        flex: "0 0 72px",
        paddingTop: 3,
        fontSize: 11,
        fontWeight: 600,
        color: "var(--muted)",
      }}
    >
      {label}
    </span>
  );
}

function KeyVal({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
      <ConfigKey label={k} />
      <span className="spark-mono" style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--ink-dim)", wordBreak: "break-word" }}>
        {v}
      </span>
    </div>
  );
}
