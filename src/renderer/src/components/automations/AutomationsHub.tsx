import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRuntimeDiagnostic,
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
import { ENGINE_TONE, LoomIcon } from "./flow/FlowNodes";
import { graphForJob } from "./flow/model";
import { useAutomationWorkers } from "./useAutomationWorkers";
import WorkersView from "./WorkersView";
import RunPeek from "./RunPeek";
import MiniFlow from "./MiniFlow";
import LiveBoard from "./LiveBoard";
import NodeFlowEditor from "./flow/NodeFlowEditor";
import AssistChat from "./AssistChat";

// AutomationsHub — the dedicated home for "Looms": automations that are a
// TRIGGER (when to start) + a LOOP (how it repeats) + a WORKER (which CLI
// agent runs each pass — no API manager anywhere). Layout: a permanent looms
// RAIL on the left (every loom with its armed/paused state and a quick
// toggle), and a STAGE on the right that swaps between the loom detail, the
// node-flow editor, the Cora architect chat, and the global workers grid
// (reached from the rail footer). Built on the shared .spark-* kit + design
// tokens. Loom runs never open chat/terminal tabs — everything renders here.

export interface Props {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  // Whether the Automations tab is the active top-level tab (drives the
  // workers poll + terminal pane visibility).
  active: boolean;
  terminalScrollbackLineLimit: number;
}

// view — list + detail; create/edit — the manual node-flow editor; assist —
// the "Create with Cora" split: live loom list on the left, an architect chat
// (chatMode "automation") on the right.
type Mode =
  | { kind: "view" }
  | { kind: "create" }
  | { kind: "edit"; job: ScheduledJob }
  | { kind: "assist" };
type SubTab = "looms" | "workers";

const SUBTAB_STORAGE_KEY = "spark.automations.subtab";

// Attempt statuses that mean the worker process is still going. Mirrors the
// module-private set in WorkersView / LiveBoard — one live-vs-done rule.
const LIVE_ATTEMPT = new Set(["preparing", "prompt_ready", "launching", "running", "finishing"]);

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
  // The architect run "Open chat" jumps to. Cleared whenever we leave assist
  // mode (below) so re-opening the SAME creator run re-fires AssistChat's
  // value-guarded focus effect (null → runId is a change; runId → runId isn't).
  const [focusAssistRunId, setFocusAssistRunId] = useState<string | null>(null);
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
  // Live board — the "whiteboard" view of the selected loom's run (full flow
  // canvas + in-canvas worker terminals). NEVER auto-opens (user feedback:
  // "I should go to it myself") — only the explicit affordances (the Board /
  // Live board buttons) open it, and closing it is always manual too.
  const [boardOpen, setBoardOpen] = useState(false);
  // When the board is opened by clicking a worker row in the loom detail, the
  // attemptId to focus the board's terminal sheet on. Null for a plain "Board"
  // open (whiteboard opens clean). Cleared on close / selection change so the
  // same worker clicked twice re-fires LiveBoard's focus effect.
  const [boardFocusWorkerId, setBoardFocusWorkerId] = useState<string | null>(null);

  const workers = useAutomationWorkers(active);
  const workspaceWorkers = useMemo(
    () => workers.filter((w) => jobs.some((j) => j.id === w.automationId)),
    [workers, jobs],
  );
  const anyBlocked = workspaceWorkers.some((w) => w.blocked);
  // Holds the Workers overlay mounted across top-level tab switches while any
  // of this workspace's workers is still running — see the gate below.
  const anyLiveWorkspaceWorker = workspaceWorkers.some((w) => LIVE_ATTEMPT.has(w.status));

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

  // ── live board open/close ───────────────────────────────────────────────
  // Selection change always closes the board (a different loom's board is a
  // different surface); the new selection's board waits for an explicit open.
  useEffect(() => {
    setBoardOpen(false);
    setBoardFocusWorkerId(null);
  }, [selectedId]);

  const openLiveBoard = useCallback(() => {
    switchSubTab("looms");
    setBoardFocusWorkerId(null);
    setBoardOpen(true);
  }, [switchSubTab]);

  // Open the board AND focus its terminal sheet on one specific worker — the
  // affordance the loom detail's Workers rows use.
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
      // The assist chat is NOT a draft (its run persists and resumes), so an
      // explicit "show me this loom" wins over it and reveals the detail pane.
      setMode((m) => (m.kind === "create" || m.kind === "edit" ? m : { kind: "view" }));
    },
    [switchSubTab],
  );

  const stopLoom = useCallback(
    (automationId: string) => {
      void act(() => window.spark.scheduler.stop!(automationId));
    },
    [act],
  );

  // Jump from a loom's detail back to the architect chat that authored it. The
  // session isn't a draft (its run persists and resumes), so swapping to the
  // assist pane is safe; AssistChat picks the run via focusAssistRunId.
  const openCreatorChat = useCallback(
    (runId: string) => {
      setActionError(null);
      setFocusAssistRunId(runId);
      switchSubTab("looms");
      setMode({ kind: "assist" });
    },
    [switchSubTab],
  );

  // Reset the focus target whenever we leave assist mode so a later "Open chat"
  // for the same run is seen as a fresh change by AssistChat's focus effect.
  useEffect(() => {
    if (mode.kind !== "assist") setFocusAssistRunId(null);
  }, [mode.kind]);

  // "editing" = the node-flow editor owns the body (create/edit draft).
  // "assisting" = the Cora architect chat replaces the detail pane.
  const editing = mode.kind === "create" || mode.kind === "edit";
  const assisting = mode.kind === "assist";
  // Live board on screen: it owns the Looms body while open, but yields to the
  // editor/assist overlays and to the Workers sub-tab (kept mounted under the
  // same visibility contract so the canvas viewport + dock mirrors survive).
  const boardShowing = boardOpen && selected !== null && subTab === "looms" && !editing && !assisting;

  // The looms rail — ALWAYS on screen ("the looms live on the left; the right
  // side is the part that changes"). The header carries the create actions,
  // each row carries its armed/paused state + a quick toggle, and the footer
  // swaps the stage to the global workers grid (the old Workers sub-tab).
  const loomRail = (
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
        <span className="spark-eyebrow" style={{ flex: "0 0 auto" }}>
          Looms
        </span>
        <span className="spark-mono spark-num" style={{ flex: 1, fontSize: 10, color: "var(--muted-2)" }}>
          {String(jobs.length).padStart(2, "0")}
        </span>
        <button
          type="button"
          className="spark-btn"
          style={{
            height: 24,
            padding: "0 9px",
            fontSize: 11,
            ...(assisting
              ? { borderColor: "var(--accent-edge)", background: "var(--accent-soft)" }
              : {}),
          }}
          disabled={editing}
          onClick={() => {
            setActionError(null);
            switchSubTab("looms");
            setMode({ kind: "assist" });
          }}
          title={
            editing
              ? "Finish or cancel the open editor first"
              : "Chat with Cora — she designs, creates, and test-runs the loom for you"
          }
        >
          ✦ Cora
        </button>
        <button
          type="button"
          className="spark-btn is-primary"
          style={{ height: 24, padding: "0 9px", fontSize: 11 }}
          disabled={editing}
          onClick={() => {
            setActionError(null);
            switchSubTab("looms");
            setMode((m) => (m.kind === "create" || m.kind === "edit" ? m : { kind: "create" }));
          }}
          title={editing ? "The editor is already open" : "New loom — open the flow editor"}
        >
          + New
        </button>
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
          </div>
        ) : (
          jobs.map((job) => (
            <AutomationRow
              key={job.id}
              job={job}
              selected={job.id === selectedId && subTab === "looms" && !assisting}
              onSelect={() => {
                setActionError(null);
                setSelectedId(job.id);
                switchSubTab("looms");
                // Picking a loom while the assist chat is up means "show
                // me this loom" — swap the chat for the detail pane. The
                // session isn't lost: its run persists and "Create with
                // Cora" resumes it.
                setMode((m) => (m.kind === "assist" ? { kind: "view" } : m));
              }}
              onToggleEnabled={(enabled) =>
                void act(() => window.spark.scheduler.setEnabled(job.id, enabled))
              }
            />
          ))
        )}
      </div>

      {/* Footer: the global workers grid (was the Workers sub-tab). Click to
          flip the stage there and back — never automatic. */}
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
        title={subTab === "workers" ? "Back to the loom detail" : "Every live worker as a real terminal"}
      >
        <span className="spark-eyebrow" style={{ flex: 1, color: subTab === "workers" ? "var(--ink)" : undefined }}>
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
        {loomRail}

        {/* The STAGE — a position:relative flex container to the right of the
            rail. Editor / workers grid / assist chat mount here as absolute
            overlays kept MOUNTED while hidden, using visibility:hidden +
            pointer-events:none — NEVER display:none — because the ReactFlow
            canvas (editor) and xterm panes (workers) measure their containers
            and would collapse or garble under display:none. visibility:hidden
            survives the round-trip so drafts, zoom/pan, and terminal state
            stay intact while another stage face is up. */}
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

        {/* Workers sub-tab: kept MOUNTED behind the Looms sub-tab (same
            visibility contract as the editor/assist overlays above) so a
            Looms ↔ Workers flip no longer unmounts every live worker terminal
            and forces a garble-prone TUI reattach. Each WorkerPane's `visible`
            prop stays accurate (below) so useTerminalSession's reveal-refit
            re-fits + resizes the pty when the panes come back on screen.

            Gated on `active` OR a live workspace worker: gating on `active`
            alone unmounted every canonical WorkerPane on a top-level tab
            switch — and, because LiveBoard's mirrors mount only while a
            canonical pane is registered (worker-pane-registry), the board's
            mirror xterms too — so returning to a RUNNING worker forced a
            garble-prone raw-tail replay / mid-frame mirror attach (the "leave
            and come back breaks the terminal" bug). Keeping the overlay
            mounted while any workspace worker is live preserves the xterm
            buffers across the round-trip; each WorkerPane's `visible` prop
            (below) stays false meanwhile, so hidden panes never take focus
            or reveal-refit (a window resize can still re-fit them at their
            real kept-layout dimensions — same regime as the hidden sub-tab
            case), and writeWhileHidden keeps their buffers complete. While the tab
            is INACTIVE the workers poll pauses and this gate rides the last
            snapshot (a worker that exits while we're away holds it up until
            return, when the poll reconciles). Once nothing is live — the
            60s-lingering exited workers don't count — an inactive tab still
            tears the terminals down, matching the original intent that a
            closed Automations tab shouldn't keep xterms mounted forever.
            `inherit` (not visible/auto) for the same punch-through reason
            documented on the editor overlay. */}
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
              scrollbackLineLimit={terminalScrollbackLineLimit}
              visible={active && subTab === "workers"}
              onStopLoom={stopLoom}
              onSelectLoom={openLoomDetail}
              onNewLoom={() => {
                // Switching back to Looms must reveal whatever editor is already
                // open. Only start a fresh create when nothing is being authored;
                // if an edit draft is open, just unhide it (don't double-mount or
                // clobber the in-progress edit with a blank create form). An
                // assist chat is not a draft — an explicit "new loom" opens the
                // manual editor over it (the session persists and resumes).
                switchSubTab("looms");
                setMode((m) => (m.kind === "create" || m.kind === "edit" ? m : { kind: "create" }));
              }}
            />
          </div>
        )}

        {/* Assist view: live loom list + the Cora architect chat. Kept MOUNTED
            behind the Workers sub-tab (same visibility contract as the editor
            above) so the chat's composer draft, session selection, and live
            stream buffer survive a Looms ↔ Workers flip. `inherit` (not
            visible/auto) for the same punch-through reason documented on the
            editor overlay. */}
        {assisting && (
          <div
            aria-hidden={subTab !== "looms"}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              visibility: subTab === "looms" ? "inherit" : "hidden",
              pointerEvents: subTab === "looms" ? "inherit" : "none",
            }}
          >
            {/* The chat takes the full STAGE (everything right of the rail —
                still the "bigger window" the user asked for, and the rail
                means looms Cora creates appear in the list live, while the
                chat is open). */}
            <AssistChat
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              cwd={cwd}
              runtimes={runtimes}
              active={active && subTab === "looms"}
              focusRunId={focusAssistRunId ?? undefined}
              terminalScrollbackLineLimit={terminalScrollbackLineLimit}
              onClose={() => setMode({ kind: "view" })}
            />
          </div>
        )}

        {!editing && !assisting && subTab === "looms" && (
          <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
            {!selected ? (
              <div className="spark-empty" style={{ flex: 1, gap: 8 }}>
                {loading ? null : jobs.length === 0 ? (
                  <AutomationEmptyState
                    onAssist={() => {
                      setActionError(null);
                      setMode({ kind: "assist" });
                    }}
                    onManual={() => {
                      setActionError(null);
                      setMode({ kind: "create" });
                    }}
                  />
                ) : (
                  <>
                    <div className="spark-eyebrow">Select a loom</div>
                    <div className="spark-empty__body">Pick a loom on the left to see its worker and history.</div>
                  </>
                )}
              </div>
            ) : (
              <AutomationDetail
                job={selected}
                liveRun={liveRun}
                runtimes={runtimes}
                workers={boardWorkers}
                onEdit={() => setMode({ kind: "edit", job: selected })}
                onOpenCreatorChat={
                  selected.createdByRunId
                    ? () => openCreatorChat(selected.createdByRunId as string)
                    : undefined
                }
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
                onOpenLiveBoard={openLiveBoard}
                onOpenBoardFocused={openBoardFocused}
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
        )}

        {/* Live board overlay: the loom run as a full "whiteboard" — the flow
            canvas with live node state and the worker terminal docked INSIDE
            the canvas. Kept MOUNTED across Looms ↔ Workers flips and
            editor/assist excursions (same visibility contract as the other
            overlays — ReactFlow must never sit under display:none, and the
            dock's mirror xterms must never remount on a view flip). Rendered
            LAST so it paints above the in-flow detail while showing. */}
        {boardOpen && selected && (
          <div
            aria-hidden={!boardShowing}
            style={{
              position: "absolute",
              inset: 0,
              // Above the detail pane's sticky header (zIndex 2) — without
              // this the detail header paints THROUGH the board's header (the
              // "two headers fighting" overlap the user reported).
              zIndex: 5,
              display: "flex",
              // "inherit", not visible/auto — same punch-through reason as the
              // editor overlay above.
              visibility: boardShowing ? "inherit" : "hidden",
              pointerEvents: boardShowing ? "inherit" : "none",
            }}
          >
            <LiveBoard
              key={selected.id}
              job={selected}
              runtimes={runtimes}
              liveRun={liveRun}
              workers={boardWorkers}
              initialFocusWorkerId={boardFocusWorkerId}
              shown={active && boardShowing}
              scrollbackLineLimit={terminalScrollbackLineLimit}
              onClose={closeLiveBoard}
              onOpenWorkersGrid={() => switchSubTab("workers")}
              onStop={() => stopLoom(selected.id)}
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
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

function AutomationEmptyState({
  onAssist,
  onManual,
}: {
  onAssist: () => void;
  onManual: () => void;
}): React.ReactElement {
  return (
    <div className="automation-launchpad">
      <div className="automation-launchpad__eyebrow">Automation studio</div>
      <div className="automation-launchpad__title">Make this project keep working for you</div>
      <div className="automation-launchpad__body">
        Looms combine a trigger, bounded repetition, and real Claude or Codex
        workers. Start from the outcome with Cora, or wire the flow yourself.
      </div>
      <div className="automation-launchpad__actions">
        <button type="button" className="automation-launch-card is-cora" onClick={onAssist}>
          <span className="automation-launch-card__icon" aria-hidden>✦</span>
          <span className="automation-launch-card__copy">
            <span className="automation-launch-card__label">Recommended</span>
            <span className="automation-launch-card__title">Design with Cora</span>
            <span className="automation-launch-card__body">
              Describe the result. Cora designs the schedule, safety limits,
              models, and worker graph, then test-runs it with you.
            </span>
          </span>
          <span className="automation-launch-card__arrow" aria-hidden>→</span>
        </button>
        <button type="button" className="automation-launch-card" onClick={onManual}>
          <span className="automation-launch-card__icon" aria-hidden>⌘</span>
          <span className="automation-launch-card__copy">
            <span className="automation-launch-card__label">Visual builder</span>
            <span className="automation-launch-card__title">Build a flow</span>
            <span className="automation-launch-card__body">
              Start from a proven template, then tune triggers, loops, guards,
              parallel workers, access, and model effort directly.
            </span>
          </span>
          <span className="automation-launch-card__arrow" aria-hidden>→</span>
        </button>
      </div>
      <div className="automation-launchpad__capabilities" aria-label="Automation capabilities">
        <span>Schedules & folders</span>
        <span>Bounded agent loops</span>
        <span>Parallel workers</span>
        <span>Guards & retries</span>
      </div>
    </div>
  );
}

// ── Left-list row ────────────────────────────────────────────────────────────

// Two-bar pause mark, sized to sit inside the row's state tile.
function PauseBars({ color, size = 10 }: { color: string; size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden>
      <rect x="2" y="1.5" width="2.2" height="7" rx="1" fill={color} />
      <rect x="5.8" y="1.5" width="2.2" height="7" rx="1" fill={color} />
    </svg>
  );
}

// The row's 18px state tile — the shape tells you the loom's disposition at a
// glance: amber bolt = armed (trigger live, will fire), muted bars = paused
// (disarmed), accent pulse = running, red = needs you, info bars = the live
// pass is held. Status is COLOR + GLYPH here, never a moving box.
function LoomStateTile({ job }: { job: ScheduledJob }): React.ReactElement {
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
  if (st.kind === "running" || st.kind === "blocked") {
    return (
      <span aria-hidden style={tile}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: st.color,
            boxShadow: `0 0 6px color-mix(in oklch, ${st.color} 55%, transparent)`,
            animation: st.kind === "running" ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
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
  // armed — the trigger's own bolt, in its warm trigger amber.
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
  const loomPaused = st.kind === "paused";
  const [hover, setHover] = useState(false);
  const cue = liveCue(job);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="spark-fade-in"
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
        // A paused loom recedes — dimmer as a WHOLE row, so armed vs paused
        // reads even in peripheral vision. spark-fade-in's fill-forwards
        // animation would override an inline opacity (animations win the
        // cascade), so the entrance animation is dropped while paused.
        opacity: loomPaused ? 0.68 : 1,
        animation: loomPaused ? "none" : undefined,
        transition:
          "background var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      <LoomStateTile job={job} />
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
            style={{ flex: "0 0 auto", fontSize: 9.5, color: st.color, letterSpacing: "0.04em" }}
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
      {/* Quick arm/pause — revealed on hover (and always for a paused loom so
          re-arming never needs discovery). A span with role=button because the
          row itself is already a <button>. */}
      <span
        role="button"
        tabIndex={0}
        aria-label={job.enabled ? "Pause this loom (disarm its trigger)" : "Arm this loom"}
        title={job.enabled ? "Pause — the trigger stops firing" : "Arm — the trigger fires again"}
        className="spark-icon-btn"
        style={{
          ["--spark-icon-btn-size"]: "20px",
          flex: "0 0 auto",
          marginTop: 0,
          opacity: hover || loomPaused ? 1 : 0,
          pointerEvents: hover || loomPaused ? "auto" : "none",
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
        // Keyboard focus must reveal the control — otherwise tab lands on an
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

// ── Right detail ─────────────────────────────────────────────────────────────

function AutomationDetail({
  job,
  liveRun,
  runtimes,
  workers,
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
  runtimes: AgentRuntimeDiagnostic[];
  // This loom's workers only (live + briefly-lingering exited ones).
  workers: AutomationWorkerInfo[];
  onEdit: () => void;
  // Present only when this loom carries a createdByRunId; the button is further
  // gated below on the run still existing.
  onOpenCreatorChat?: () => void;
  onRunNow: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  // Opens the live board — the flow canvas with the worker terminal docked in.
  onOpenLiveBoard: () => void;
  // Opens the board with its terminal sheet focused on one worker (by attemptId).
  onOpenBoardFocused: (attemptId: string) => void;
  onAnswer: (runId: string, answer: string) => void;
}): React.ReactElement {
  const status = job.state.status;
  const running = status === "running" || status === "blocked";
  const st = loomState(job);
  // Resolve whether the authoring architect run still exists so a deleted
  // session doesn't leave a dead "Open chat" button. One cheap getRun per loom
  // that has a back-pointer; re-checked when the pointer changes.
  const creatorRunId = job.createdByRunId;
  const [creatorRunExists, setCreatorRunExists] = useState(false);
  // Keyed on the run id ONLY — onOpenCreatorChat is a fresh closure each hub
  // render (which is frequent while a run streams), so depending on it would
  // re-fire getRun every render. The button is separately gated on
  // onOpenCreatorChat below, and the two always move together (both derive from
  // job.createdByRunId), so the id alone is a faithful trigger.
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
  // Install hint when the loop stopped because no engine is available.
  const installHint =
    job.state.lastStopReason === "engine-missing"
      ? runtimes.find((r) => r.kind === "claude")?.installHint ??
        "Install Claude Code or Codex, then run the loom again."
      : null;
  return (
    // flex:"1 0 auto" — fill the scroll pane's height so the last section's
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
        <LoomStateTile job={job} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {job.name}
            </span>
            <span
              className="spark-badge"
              style={{
                flex: "0 0 auto",
                color: st.color,
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
        {/* The board's ONLY entry points are explicit clicks like this one —
            it never auto-opens. Glowing while live so a running loom invites
            you in; plain "Board" otherwise (the board shows the last run). */}
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
              ? "Watch this run on the whiteboard — live graph + worker terminals"
              : "Open the whiteboard — the loom graph with its last run's state"
          }
        >
          {running ? (
            <>
              <span aria-hidden style={{ color: "var(--accent)", marginRight: 6 }}>
                ●
              </span>
              Live board
            </>
          ) : (
            "Board"
          )}
        </button>
      </div>

      {/* Action bar — every control in ONE place, run-scoped first, then
          loom-scoped, destructive last. (Previously scattered across the
          worker card and the config footer.) */}
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

      {/* Pipeline strip */}
      <div style={{ padding: "10px 16px 4px" }}>
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
        <LiveWorkerCard job={job} liveRun={liveRun} onOpenLiveBoard={onOpenLiveBoard} onAnswer={onAnswer} />
      </Section>

      {/* Workers — THIS loom's live/lingering workers, surfaced inside the loom
          (not only on the global Workers grid). Hidden entirely when none. */}
      {workers.length > 0 && (
        <Section label="Workers" count={workers.length}>
          <LoomWorkersList workers={workers} onOpenBoardFocused={onOpenBoardFocused} />
        </Section>
      )}

      {/* History */}
      <Section label="History" count={job.history.length}>
        <HistoryTimeline history={job.history} liveRunId={job.state.currentRunId} onOpenLiveBoard={onOpenLiveBoard} />
      </Section>

      {/* Read-only configuration — the actions for it (Edit / Delete) live in
          the action bar up top with everything else. Grows to absorb the
          leftover height so the page reads as one composed surface. */}
      <Section label="Configuration" grow>
        <LoopConfigSummary job={job} />
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
            ? "Stop the current pass and start the loom over from pass 1"
            : "Start a fresh run of this loom now"
        }
      >
        {running ? "Restart" : "Run now"}
      </button>
      {status === "paused" ? (
        <button type="button" className="spark-btn" style={btn} onClick={onResume} title="Resume the held pass">
          Resume
        </button>
      ) : running ? (
        <button type="button" className="spark-btn" style={btn} onClick={onPause} title="Hold the live pass — resume it any time">
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

      {/* Loom-scoped controls */}
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
            ? "Pause the loom — its trigger stops firing (a live pass keeps going)"
            : "Arm the loom — its trigger fires again"
        }
      >
        {job.enabled ? "Pause loom" : "⚡ Arm loom"}
      </button>
      <button type="button" className="spark-btn" style={btn} onClick={onEdit} title="Open this loom in the flow editor">
        Edit
      </button>
      {onOpenCreatorChat && (
        <button
          type="button"
          className="spark-btn"
          style={btn}
          onClick={onOpenCreatorChat}
          title="Open the Cora chat that created this loom"
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
        title="Delete this loom (its run history stays on disk)"
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
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px 4px" }}>
        <span className="spark-eyebrow">{label}</span>
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

// ── This loom's workers (inside the detail) ──────────────────────────────────

// The Workers section of a loom's detail: its own live/lingering workers as
// compact rows. Live rows are clickable — they open this loom's board with the
// terminal sheet focused on that worker. Reads from the same
// useAutomationWorkers source as the global Workers grid, filtered to this loom
// upstream; this is the "inside the loom" surfacing of that same inventory.
function LoomWorkersList({
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
        <LoomWorkerRow key={w.attemptId} worker={w} now={now} onOpenBoardFocused={onOpenBoardFocused} />
      ))}
    </div>
  );
}

function LoomWorkerRow({
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
  // Steady dot — accent live, danger blocked, muted otherwise. No pulse.
  const dot = blocked ? "var(--danger)" : live ? "var(--accent)" : "var(--muted)";
  // Runtime tint edge — the engine's coral/cyan (matches the flow cards); a
  // legacy "auto" worker stays neutral.
  const tone = ENGINE_TONE[worker.engine] ?? "var(--rule-strong)";
  const engineWord =
    worker.engine === "claude" ? "Claude" : worker.engine === "codex" ? "Codex" : "Auto";
  const meta = worker.model ? `${engineWord} · ${worker.model}` : engineWord;
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
          title={worker.model ?? "CLI default model"}
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
    boxShadow: `inset 3px 0 0 ${tone}`,
    textAlign: "left",
  };

  // Live rows open the board focused on this worker; a lingering exited row is
  // not interactive (its terminal is released — nothing to focus on the board).
  if (!live) {
    return <div style={shared}>{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpenBoardFocused(worker.attemptId)}
      title="Open this loom's board on this worker's terminal"
      style={{ ...shared, appearance: "none", width: "100%", cursor: "default" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--panel)")}
    >
      {body}
    </button>
  );
}

// ── Live worker card ─────────────────────────────────────────────────────────

// Status-only now: what the loom is doing this instant (iteration, live run,
// spend, a blocked worker's question). Every BUTTON lives in the ActionBar.
function LiveWorkerCard({
  job,
  liveRun,
  onOpenLiveBoard,
  onAnswer,
}: {
  job: ScheduledJob;
  liveRun: RunState | null;
  onOpenLiveBoard: () => void;
  onAnswer: (runId: string, answer: string) => void;
}): React.ReactElement {
  const [answerDraft, setAnswerDraft] = useState("");
  const status = job.state.status;
  const running = status === "running" || status === "blocked";
  const edge = liveRun ? runStatusColor(liveRun.status) : automationDotColor(status);
  const budget = job.loop?.stop?.budgetUsd;

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
              onClick={onOpenLiveBoard}
              title="Watch this run on the whiteboard — live graph + worker terminal"
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

// ── Loop config summary ──────────────────────────────────────────────────────

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

// One card per graph node — a multi-worker loom has one prompt and one engine
// PER worker, so a single flat "Prompt" row would lie about what runs.
function NodeConfigCard({ node }: { node: LoomNodeDef }): React.ReactElement {
  const tone =
    node.kind === "worker"
      ? ENGINE_TONE[node.worker.engine] ?? "var(--rule-strong)"
      : node.kind === "guard"
        ? "var(--ok)"
        : "var(--info)";
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
        boxShadow: `inset 3px 0 0 ${tone}`,
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
            {node.prompt || <span style={{ color: "var(--muted-2)" }}>—</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function LoopConfigSummary({ job }: { job: ScheduledJob }): React.ReactElement {
  // Tolerate malformed persisted jobs (loop without stop) — the scheduler
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
      {/* The pipeline, node by node in execution order — each worker with ITS
          engine and ITS prompt (the old flat Worker/Prompt rows collapsed a
          multi-worker loom into one misleading line). */}
      <div style={{ display: "flex", gap: 8 }}>
        <span className="spark-eyebrow" style={{ flex: "0 0 72px", paddingTop: 3 }}>
          Pipeline
        </span>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {nodes.map((n) => (
            <NodeConfigCard key={n.id} node={n} />
          ))}
        </div>
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
