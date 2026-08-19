import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AutomationRunRecord,
  AutomationWorkerInfo,
  CreateScheduledJobInput,
  GuardPredicate,
  LoomGraph,
  LoomNodeDef,
  RunState,
  ScheduledJob,
  UpdateScheduledJobInput,
} from "@shared/types";
import { resolveOpenRunQuestion, runQuestionDraftScopeKey } from "@shared/run-questions";
import { runStatusColor } from "../../lib/run-status";
import {
  STOP_REASON_LABEL,
  automationDotColor,
  capLabel,
  fmtClock,
  fmtElapsed,
  fmtTime,
  fmtUsd,
  liveCue,
  loomState,
  loopSummary,
  triggerSummary,
  jobWorkerSummary,
  workerSummary,
} from "./presentation";
import { consumePendingAutomationFocus } from "./focus-request";
import { LoomIcon, WORKER_TONE } from "./flow/FlowNodes";
import { graphForJob } from "./flow/model";
import { useAutomationWorkers } from "./useAutomationWorkers";
import WorkersView from "./WorkersView";
import RunPeek from "./RunPeek";
import RunIdChip from "../RunIdChip";
import MiniFlow from "./MiniFlow";
import LiveBoard from "./LiveBoard";
import LiveRunHero from "./LiveRunHero";
import NodeFlowEditor from "./flow/NodeFlowEditor";

// AutomationsPage — the operations console for this workspace's automations.
// An automation is a TRIGGER (when to start) + a LOOP (how it repeats) +
// WORKER nodes that run on the bundled Pi runtime (model + effort are the only
// worker knobs). Layout: a permanent rail on the left (every automation with
// its armed/paused state and a quick toggle), and a STAGE on the right that
// swaps between the detail, the node-flow editor, and the live workers grid.
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
}

// view: rail + detail. create/edit: the node-flow editor owns the stage.
type Mode = { kind: "view" } | { kind: "create" } | { kind: "edit"; job: ScheduledJob };
type SubTab = "looms" | "workers";

const SUBTAB_STORAGE_KEY = "spark.automations.subtab";

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
}: Props): React.ReactElement {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [liveRun, setLiveRun] = useState<RunState | null>(null);
  const [subTab, setSubTab] = useState<SubTab>(() => {
    try {
      const remembered =
        window.localStorage.getItem(subTabStorageKey(workspaceId)) ??
        window.localStorage.getItem(SUBTAB_STORAGE_KEY);
      return remembered === "workers" ? "workers" : "looms";
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

  // Keep the selection valid; auto-select the first automation when nothing is
  // chosen.
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

  // The rail: always on screen. The header carries the create action, each row
  // carries its armed/paused state + a quick toggle, and the footer swaps the
  // stage to the global workers grid.
  const rail = (
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
          gap: 8,
          padding: "9px 10px 9px 12px",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <span
          style={{
            flex: "0 0 auto",
            fontSize: 12,
            fontWeight: 650,
            color: "var(--ink)",
          }}
        >
          Automations
        </span>
        <span className="spark-mono spark-num" style={{ flex: 1, fontSize: 10, color: "var(--muted-2)" }}>
          {String(jobs.length).padStart(2, "0")}
        </span>
        <button
          type="button"
          className="spark-btn is-primary"
          style={{ height: 24, padding: "0 9px", fontSize: 11 }}
          disabled={editing}
          onClick={startCreate}
          title={editing ? "The editor is already open" : "Open the flow editor"}
        >
          + New automation
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 8px 12px" }}>
        {loading ? (
          <div style={{ padding: "10px 8px", color: "var(--muted-2)", fontSize: 11 }}>Loading…</div>
        ) : jobs.length === 0 ? (
          <div style={{ padding: "26px 10px", fontSize: 11.5, lineHeight: 1.6, color: "var(--muted)" }}>
            Nothing here yet. Ask Cora in any chat to automate something recurring, or create one
            with the button above.
          </div>
        ) : (
          jobs.map((job) => (
            <AutomationRow
              key={job.id}
              job={job}
              selected={job.id === selectedId && subTab === "looms"}
              onSelect={() => {
                setActionError(null);
                setSelectedId(job.id);
                switchSubTab("looms");
              }}
              onToggleEnabled={(enabled) =>
                void act(() => window.spark.scheduler.setEnabled(job.id, enabled))
              }
            />
          ))
        )}
      </div>

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

          {!editing && subTab === "looms" && (
            <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
              {/* Another automation just went live while you look at this one:
                  a slim jump strip so a running machine is never off-screen
                  without a signpost. */}
              {(() => {
                const runningElsewhere = jobs.find(
                  (j) =>
                    (j.state.status === "running" || j.state.status === "blocked") &&
                    j.id !== (selected?.id ?? ""),
                );
                if (!runningElsewhere) return null;
                const heldUp = runningElsewhere.state.status === "blocked";
                return (
                  <button
                    type="button"
                    className={`loom-live-strip${heldUp ? " is-blocked" : ""}`}
                    onClick={() => openDetail(runningElsewhere.id)}
                    title={`Show ${runningElsewhere.name}`}
                  >
                    <span className="loom-live-strip__glyph" aria-hidden>
                      {heldUp ? (
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 999,
                            background: "var(--danger)",
                            boxShadow: "0 0 7px color-mix(in oklch, var(--danger) 55%, transparent)",
                          }}
                        />
                      ) : (
                        <span
                          className="spark-activity-spin"
                          style={{
                            width: 11,
                            height: 11,
                            borderRadius: 999,
                            background:
                              "conic-gradient(from 0deg, transparent 0deg 90deg, var(--accent) 360deg)",
                            WebkitMask:
                              "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
                            mask: "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
                          }}
                        />
                      )}
                    </span>
                    <span className="loom-live-strip__text">
                      <strong>{runningElsewhere.name}</strong>{" "}
                      {heldUp ? "needs you" : "is running"}
                    </span>
                    <span className="loom-live-strip__action">Watch</span>
                  </button>
                );
              })()}
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
                liveRun={liveRun}
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

// Two-bar pause mark, sized to sit inside the row's state tile.
function PauseBars({ color, size = 10 }: { color: string; size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden>
      <rect x="2" y="1.5" width="2.2" height="7" rx="1" fill={color} />
      <rect x="5.8" y="1.5" width="2.2" height="7" rx="1" fill={color} />
    </svg>
  );
}

// The row's 18px state tile. The shape tells the automation's disposition at a
// glance: amber bolt = armed (trigger live, will fire), muted bars = paused,
// accent pulse = running, red = needs you, info bars = the live pass is held.
// Status is COLOR + GLYPH here, never a moving box.
function StateTile({ job }: { job: ScheduledJob }): React.ReactElement {
  const st = loomState(job);
  const tile: React.CSSProperties = {
    flex: "0 0 18px",
    width: 18,
    height: 18,
    marginTop: 1,
    borderRadius: 6,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid color-mix(in oklch, ${st.color} 26%, var(--rule-soft))`,
    background: `color-mix(in oklch, ${st.color} 9%, var(--panel-2))`,
  };
  if (st.kind === "running") {
    // The comet arc: the same rotation the live surfaces use, so "running"
    // reads identically from rail glance to detail hero.
    return (
      <span aria-hidden style={tile}>
        <span
          className="spark-activity-spin"
          style={{
            width: 11,
            height: 11,
            borderRadius: 999,
            background: `conic-gradient(from 0deg, transparent 0deg 90deg, ${st.color} 360deg)`,
            WebkitMask:
              "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
            mask: "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
          }}
        />
      </span>
    );
  }
  if (st.kind === "blocked") {
    return (
      <span aria-hidden style={tile}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: st.color,
            boxShadow: `0 0 6px color-mix(in oklch, ${st.color} 55%, transparent)`,
          }}
        />
      </span>
    );
  }
  if (st.kind === "paused" || st.kind === "passPaused") {
    return (
      <span aria-hidden style={tile}>
        <PauseBars color={st.color} />
      </span>
    );
  }
  // armed: the trigger's own bolt, in its warm trigger amber.
  return (
    <span aria-hidden style={tile}>
      <LoomIcon kind="trigger" tone={st.color} size={11} />
    </span>
  );
}

const AutomationRow = React.memo(function AutomationRow({
  job,
  selected,
  onSelect,
  onToggleEnabled,
}: {
  job: ScheduledJob;
  selected: boolean;
  onSelect: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}): React.ReactElement {
  const st = loomState(job);
  const paused = st.kind === "paused";
  const live = st.kind === "running";
  const [hover, setHover] = useState(false);
  const cue = liveCue(job);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`spark-fade-in automation-row${live ? " is-live" : ""}`}
      onMouseEnter={(e) => {
        setHover(true);
        if (!selected) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        setHover(false);
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
      style={{
        appearance: "none",
        position: "relative",
        overflow: "hidden",
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
        // A paused automation recedes as a WHOLE row, so armed vs paused reads
        // even in peripheral vision. spark-fade-in's fill-forwards animation
        // would override an inline opacity, so the entrance is dropped while
        // paused.
        opacity: paused ? 0.68 : 1,
        animation: paused ? "none" : undefined,
        transition:
          "background var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      <StateTile job={job} />
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
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
            style={{
              flex: "0 0 auto",
              fontSize: 9.5,
              color: st.kind === "running" ? "var(--accent-text)" : st.color,
              letterSpacing: "0.04em",
            }}
          >
            {st.label}
          </span>
        </span>
        <span
          className="spark-mono"
          style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          title={`${triggerSummary(job.trigger)} · ${loopSummary(job.loop)} · ${jobWorkerSummary(job)}`}
        >
          {triggerSummary(job.trigger)} · {loopSummary(job.loop)}
        </span>
        {cue !== "idle" && (
          <span className="spark-mono spark-num" style={{ fontSize: 9.5, color: "var(--muted-2)" }}>
            {cue}
          </span>
        )}
      </span>
      {/* Quick arm/pause, revealed on hover (and always for a paused
          automation so re-arming never needs discovery). A span with
          role=button because the row itself is already a <button>. */}
      <span
        role="button"
        tabIndex={0}
        aria-label={job.enabled ? "Pause this automation" : "Arm this automation"}
        title={job.enabled ? "Pause: the trigger stops firing" : "Arm: the trigger fires again"}
        className="spark-icon-btn"
        style={{
          ["--spark-icon-btn-size"]: "20px",
          flex: "0 0 auto",
          marginTop: 0,
          opacity: hover || paused ? 1 : 0,
          pointerEvents: hover || paused ? "auto" : "none",
          transition: "opacity var(--motion-fast) var(--ease-out)",
        } as React.CSSProperties}
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
        // Keyboard focus must reveal the control; otherwise tab lands on an
        // invisible, still-operable toggle.
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        {job.enabled ? (
          <PauseBars color="currentColor" size={9} />
        ) : (
          <LoomIcon kind="trigger" tone="var(--warn)" size={10} />
        )}
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
}: {
  job: ScheduledJob;
  liveRun: RunState | null;
  // This automation's workers only (live + briefly-lingering exited ones).
  workers: AutomationWorkerInfo[];
  // The detail is on screen and unobstructed (tab active, board closed) —
  // gates the live hero's 1s clock and activity poll.
  heroShown: boolean;
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
}): React.ReactElement {
  const status = job.state.status;
  const running = status === "running" || status === "blocked";
  const st = loomState(job);
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
        <StateTile job={job} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {job.name}
            </span>
            <span
              className="spark-badge"
              style={{
                flex: "0 0 auto",
                color: st.kind === "running" ? "var(--accent-text)" : st.color,
                borderColor: `color-mix(in oklch, ${st.color} 32%, transparent)`,
                background: `color-mix(in oklch, ${st.color} 8%, transparent)`,
              }}
            >
              {st.label}
            </span>
          </div>
          <div className="spark-mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
            {triggerSummary(job.trigger)} · {loopSummary(job.loop)} · {jobWorkerSummary(job)}
          </div>
        </div>
        {/* The board's ONLY entry points are explicit clicks like this one; it
            never auto-opens. Glowing while live so a running automation
            invites you in; plain "Board" otherwise. */}
        <button
          type="button"
          className="spark-btn"
          style={
            running
              ? {
                  height: 26,
                  padding: "0 12px",
                  fontSize: 11.5,
                  borderColor: "var(--accent-edge)",
                  background: "var(--accent-soft)",
                  boxShadow: "0 0 14px var(--accent-glow)",
                }
              : { height: 26, padding: "0 12px", fontSize: 11.5 }
          }
          onClick={onOpenLiveBoard}
          title={
            running
              ? "Watch this run on the whiteboard: live graph and worker activity"
              : "Open the whiteboard with the last run's state"
          }
        >
          {running ? (
            <>
              <span aria-hidden style={{ color: "var(--accent-text)", marginRight: 6 }}>
                ●
              </span>
              Live board
            </>
          ) : (
            "Board"
          )}
        </button>
      </div>

      {/* Action bar: every control in ONE place, run-scoped first, then
          automation-scoped, destructive last. */}
      <ActionBar
        job={job}
        onRunNow={onRunNow}
        onPause={onPause}
        onResume={onResume}
        onStop={onStop}
        onEdit={onEdit}
        onOpenCreatorChat={canOpenCreatorChat ? onOpenCreatorChat : undefined}
        onToggleEnabled={onToggleEnabled}
        onDelete={onDelete}
      />

      {/* THE LIVE MOMENT: while a pass is in flight the detail leads with the
          machine actually working — wire electricity, comet arc, ticking
          readout, and the worker's live activity stream. Idle automations get
          the quieter status card below instead. */}
      {running ? (
        <div style={{ padding: "12px 16px 2px" }}>
          <LiveRunHero
            job={job}
            liveRun={liveRun}
            workers={workers}
            shown={heroShown}
            onOpenLiveBoard={onOpenLiveBoard}
            onAnswer={onAnswer}
          />
        </div>
      ) : null}

      {/* Pipeline strip */}
      <div style={{ padding: "10px 16px 4px" }}>
        <MiniFlow job={job} onOpenEditor={onEdit} />
      </div>

      {/* Status card only while idle — the hero above owns the live state. */}
      {!running && (
        <Section label="Last pass">
          <LivePassCard job={job} liveRun={liveRun} onOpenLiveBoard={onOpenLiveBoard} onAnswer={onAnswer} />
        </Section>
      )}

      {/* Workers: THIS automation's live/lingering workers, surfaced inside
          the detail (not only on the global Workers grid). Hidden when none. */}
      {workers.length > 0 && (
        <Section label="Workers" count={workers.length}>
          <DetailWorkersList workers={workers} onOpenBoardFocused={onOpenBoardFocused} />
        </Section>
      )}

      {/* History */}
      <Section label="History" count={job.history.length}>
        <HistoryTimeline history={job.history} liveRunId={job.state.currentRunId} onOpenLiveBoard={onOpenLiveBoard} />
      </Section>

      {/* Read-only configuration; the actions for it (Edit / Delete) live in
          the action bar up top with everything else. Grows to absorb the
          leftover height so the page reads as one composed surface. */}
      <Section label="Configuration" grow>
        <ConfigSummary job={job} />
      </Section>
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
  onOpenCreatorChat,
  onToggleEnabled,
  onDelete,
}: {
  job: ScheduledJob;
  onRunNow: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onEdit: () => void;
  onOpenCreatorChat?: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
}): React.ReactElement {
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = job.state.status;
  const running = status === "running" || status === "blocked";
  const btn: React.CSSProperties = { height: 26, fontSize: 11.5 };
  const divider = (
    <span aria-hidden style={{ width: 1, height: 16, background: "var(--rule)", margin: "0 2px" }} />
  );
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        padding: "10px 16px",
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
      }}
    >
      {/* Run-scoped controls */}
      <button
        type="button"
        className={`spark-btn${!running ? " is-primary" : ""}`}
        style={btn}
        onClick={onRunNow}
        title={
          running
            ? "Stop the current pass and start over from pass 1"
            : "Start a fresh run now"
        }
      >
        {running ? "Restart" : "Run now"}
      </button>
      {status === "paused" ? (
        <button type="button" className="spark-btn" style={btn} onClick={onResume} title="Resume the held pass">
          Resume
        </button>
      ) : running ? (
        <button type="button" className="spark-btn" style={btn} onClick={onPause} title="Hold the live pass; resume it any time">
          Pause pass
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

      {divider}

      {/* Automation-scoped controls */}
      <button
        type="button"
        className="spark-btn"
        style={
          job.enabled
            ? btn
            : {
                ...btn,
                color: "var(--warn)",
                borderColor: "color-mix(in oklch, var(--warn) 34%, transparent)",
                background: "color-mix(in oklch, var(--warn) 9%, transparent)",
              }
        }
        onClick={() => onToggleEnabled(!job.enabled)}
        title={
          job.enabled
            ? "Pause the automation: its trigger stops firing (a live pass keeps going)"
            : "Arm the automation: its trigger fires again"
        }
      >
        {job.enabled ? "Pause automation" : "⚡ Arm automation"}
      </button>
      <button type="button" className="spark-btn" style={btn} onClick={onEdit} title="Open this automation in the flow editor">
        Edit
      </button>
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
          <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted-2)" }}>
            {String(count).padStart(2, "0")}
          </span>
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

// ── Live pass card ───────────────────────────────────────────────────────────

// Status-only: what the automation is doing this instant (iteration, live
// run, spend, a blocked worker's question). Every BUTTON lives in the
// ActionBar.
function LivePassCard({
  job,
  liveRun,
  onOpenLiveBoard,
  onAnswer,
}: {
  job: ScheduledJob;
  liveRun: RunState | null;
  onOpenLiveBoard: () => void;
  onAnswer: (runId: string, questionMessageId: string, answer: string) => void;
}): React.ReactElement {
  const [answerDraft, setAnswerDraft] = useState("");
  const status = job.state.status;
  const running = status === "running" || status === "blocked";
  const edge = liveRun ? runStatusColor(liveRun.status) : automationDotColor(status);
  const budget = job.loop?.stop?.budgetUsd;
  // The pass on show: the live run while one is in flight, otherwise the most
  // recent recorded iteration, so the card always names a run you can inspect.
  const shownRunId = liveRun?.id ?? job.history[job.history.length - 1]?.runId;

  // The blocked iteration's exact unresolved question. Its id must travel with
  // every answer; a historical same-text question is not interchangeable.
  const pendingQuestion = liveRun ? resolveOpenRunQuestion(liveRun) : null;
  const answerDraftScope = runQuestionDraftScopeKey(liveRun?.id, pendingQuestion?.id);
  // The card stays mounted while runs/questions change. Clear local text on
  // both identity boundaries, including question -> undefined when another
  // surface answers the currently displayed question.
  useEffect(() => {
    setAnswerDraft("");
  }, [answerDraftScope]);

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
        {shownRunId && (
          <span style={{ alignSelf: "center", minWidth: 0 }}>
            <RunIdChip runId={shownRunId} maxChars={24} />
          </span>
        )}
        <span className="spark-mono spark-num" style={{ fontSize: 10.5, color: "var(--muted)" }}>
          est. {fmtUsd(job.state.spentUsd)}
          {typeof budget === "number" ? ` / ${fmtUsd(budget)}` : ""}
        </span>
      </div>

      {liveRun ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="spark-mono" style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--ink-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <span style={{ color: runStatusColor(liveRun.status) }}>●</span> {liveRun.title || "run"}:{" "}
            {liveRun.status}
          </span>
          {running && (
            <button
              type="button"
              className="spark-btn"
              style={{ height: 24, padding: "0 10px", fontSize: 11 }}
              onClick={onOpenLiveBoard}
              title="Watch this run on the whiteboard"
            >
              Live board →
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
          <span style={{ fontSize: 11.5, color: "var(--ink)", whiteSpace: "pre-wrap" }}>{pendingQuestion.message}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="spark-input"
              value={answerDraft}
              onChange={(e) => setAnswerDraft(e.target.value)}
              placeholder="Answer the worker…"
              style={{ flex: 1, height: 26 }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && answerDraft.trim()) {
                  onAnswer(liveRun.id, pendingQuestion.id, answerDraft.trim());
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
                onAnswer(liveRun.id, pendingQuestion.id, answerDraft.trim());
                setAnswerDraft("");
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── History timeline (accordion + run peek) ──────────────────────────────────

function HistoryTimeline({
  history,
  liveRunId,
  onOpenLiveBoard,
}: {
  history: AutomationRunRecord[];
  liveRunId?: string;
  onOpenLiveBoard: () => void;
}): React.ReactElement {
  // Keyed iteration+runId: iteration alone collides across loop cycles
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
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 4px",
                  border: "none",
                  background: "transparent",
                  cursor: "default",
                }}
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
    node.kind === "worker" ? WORKER_TONE : node.kind === "guard" ? "var(--ok)" : "var(--info)";
  const title =
    node.label || (node.kind === "worker" ? "Worker" : node.kind === "guard" ? "Guard" : "Merge");
  const meta =
    node.kind === "worker"
      ? workerSummary(node.worker)
      : node.kind === "guard"
        ? predicateSummary(node.predicate)
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
        <LoomIcon kind={node.kind} tone={tone} size={12} />
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
      </div>
    </div>
  );
}

function ConfigSummary({ job }: { job: ScheduledJob }): React.ReactElement {
  // Tolerate malformed persisted jobs (loop without stop): the scheduler
  // backfills on read, but a bad record must never take down the renderer.
  const stop = job.loop?.stop ?? {};
  const chips: string[] = [];
  if (typeof stop.maxIterations === "number") chips.push(`max ${stop.maxIterations}`);
  if (typeof stop.budgetUsd === "number") chips.push(`est. ${fmtUsd(stop.budgetUsd)}`);
  if (stop.untilTestsPass) chips.push("tests pass");
  if (stop.untilGitClean) chips.push("git clean");
  if (stop.untilPhrase) chips.push(`phrase: ${stop.untilPhrase}`);
  if (stop.untilCommand) chips.push("custom cmd");
  const nodes = orderedNodes(graphForJob(job));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <KeyVal k="Trigger" v={triggerSummary(job.trigger)} />
      <KeyVal k="Loop" v={loopSummary(job.loop)} />
      <div style={{ display: "flex", gap: 8 }}>
        <ConfigKey label="Stops" />
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
      {/* The pipeline, node by node in execution order, each worker with ITS
          model and ITS prompt. */}
      <div style={{ display: "flex", gap: 8 }}>
        <ConfigKey label="Pipeline" />
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
