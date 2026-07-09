// Looms v2 — headless pty plumbing for direct-worker (automation) runs.
//
// Managed runs rely on the renderer to spawn each worker attempt's pty (the
// workers terminal tab reacts to `worker_task.envelope_prepared`). Automation
// runs must work with NO tab anywhere, so this module substitutes the renderer
// exactly the way eval/headless-runner.ts does: spawn the pty in the main
// process (webContents: null) the moment an envelope for a direct run is
// prepared. The Automations Hub's Workers sub-tab can attach a TerminalPane to
// the same pty later (pty.spawn replays the tail buffer on late attach) — the
// worker keeps running headless regardless.
//
// Also owns: boot recovery for direct runs (the report-first decision table)
// and the live-worker inventory behind `automations:listActiveWorkers`.

import type {
  AutomationWorkerInfo,
  LoomEngine,
  LoomGraph,
  ScheduledJob,
  ShellInfo,
  SparkEvent,
  WorkerAttemptStatus,
} from "@shared/types";

import * as pty from "../pty-manager";
import { defaultShell } from "../shells";
import { appendEvent, subscribeToEvents } from "./event-log";
import {
  failWorkerAttempt,
  getRun,
  listRuns,
  relaunchDirectAttempt,
  settleRecoveredDirectAttempt,
} from "./run-store";

const HEADLESS_PTY_COLS = 120;
const HEADLESS_PTY_ROWS = 32;

const ACTIVE_ATTEMPT_STATUSES = new Set<WorkerAttemptStatus>([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
]);

const TERMINAL_RUN_STATUSES = new Set(["complete", "failed", "cancelled"]);

// runIds whose pty this module spawned — lets the exit watcher emit
// automation.worker "exited" pings without re-reading every event.
const trackedAttempts = new Map<string, { runId: string; automationId: string }>();

let cachedShell: ShellInfo | null = null;
async function ensureShell(): Promise<ShellInfo> {
  if (cachedShell) return cachedShell;
  const detected = await defaultShell();
  if (!detected) {
    throw new Error("No default shell detected — cannot launch automation workers.");
  }
  cachedShell = detected;
  return detected;
}

// Broadcast-only live ping for the Hub's Workers sub-tab (same pattern as
// automation.iteration: empty workspaceId, payload-only consumers).
async function emitWorkerPhase(
  phase: "spawned" | "exited",
  worker: AutomationWorkerInfo,
): Promise<void> {
  try {
    // No runId on purpose: workspaceId "" + no runId = broadcast-only (never
    // journaled into the run's events.jsonl) — same shape automation.iteration
    // uses. The payload itself carries runId for consumers.
    await appendEvent({
      workspaceId: "",
      type: "automation.worker",
      payload: { phase, worker },
    });
  } catch {
    /* best-effort ping; the hub also refreshes on automation.updated + poll */
  }
}

/**
 * Subscribe to envelope_prepared events and claim direct-run attempts with a
 * main-owned headless pty so runWorkerSession's waitForSpawn resolves without
 * any renderer. Returns an unsubscribe for shutdown symmetry.
 */
export function installAutomationWorkerSpawnHandler(): () => void {
  const unsubscribe = subscribeToEvents((event: SparkEvent) => {
    if (event.type !== "worker_task.envelope_prepared") return;
    if (!event.attemptId || !event.runId) return;
    const payload = event.payload as Record<string, unknown> | undefined;
    // The payload stamp is authoritative and synchronous; fall back to getRun
    // for events emitted before the stamp existed (same-session upgrades).
    if (payload && payload.executionMode !== "direct") return;

    const attemptId = event.attemptId;
    const runId = event.runId;
    void (async () => {
      let automationId = typeof payload?.automationId === "string" ? payload.automationId : "";
      try {
        const run = await getRun(runId);
        if (!run || run.executionMode !== "direct" || !run.automationId) return;
        automationId = run.automationId;
        const attempt = run.workerAttempts.find((item) => item.id === attemptId);
        if (!attempt) return;
        // Slice 7: stamp the attempt's graph node id into the worker env so the
        // orchestrator tools (codara_request_next_iteration) can attribute the
        // calling worker to ONE loom node — letting the pass-level "agent" loop
        // read only the SINK node's signal in a multi-node wave. Looked up from
        // the attempt's task loomNodeId; undefined for a pre-graph single-node
        // loom (the env var is then simply omitted, behaviour unchanged).
        const task = run.workerTasks.find((item) => item.id === attempt.workerTaskId);
        const nodeId = task?.loomNodeId;
        const shell = await ensureShell();
        await pty.spawn({
          id: attemptId,
          shell,
          cwd: attempt.cwd,
          cols: HEADLESS_PTY_COLS,
          rows: HEADLESS_PTY_ROWS,
          webContents: null,
          env: {
            // Makes codara_ask_user / codara_request_next_iteration auto-fill
            // their runId from the worker's own environment.
            SPARK_RUN_ID: runId,
            SPARK_AUTOMATION_ID: automationId,
            // Slice 7: which graph node this worker executes (omitted when the
            // task carries no loomNodeId — pre-graph single-node loom).
            ...(nodeId ? { SPARK_NODE_ID: nodeId } : {}),
            // Same flag renderer worker panes set: the shell-integration
            // script must not echo the autorun command into the TUI.
            SPARK_NO_SHELL_INTEGRATION: "1",
          },
        });
        // Mirror the renderer TerminalView's first paint so waitForResize
        // resolves and run-store types into a shell with a real width.
        pty.resize(attemptId, HEADLESS_PTY_COLS, HEADLESS_PTY_ROWS);
        trackedAttempts.set(attemptId, { runId, automationId });
        pty.onExit(attemptId, () => {
          const tracked = trackedAttempts.get(attemptId);
          trackedAttempts.delete(attemptId);
          if (!tracked) return;
          void (async () => {
            const worker = await describeWorker(tracked.runId, attemptId);
            if (worker) await emitWorkerPhase("exited", worker);
          })();
        });
        const worker = await describeWorker(runId, attemptId);
        if (worker) await emitWorkerPhase("spawned", worker);
      } catch (err) {
        // Fail fast instead of letting runWorkerSession eat the full 30s
        // waitForSpawn timeout — the loop driver sees a terminal run promptly.
        const message = err instanceof Error ? err.message : String(err);
        await failWorkerAttempt(runId, attemptId, `pty-spawn-failed: ${message}`).catch(
          () => undefined,
        );
      }
    })();
  });
  return unsubscribe;
}

/**
 * Boot recovery for direct runs, called BEFORE resumeLoops() so the loop
 * driver re-attaches to a coherent world. Decision table (report-first):
 *   - final-report.json on disk      → settle + finalize (never re-run work)
 *   - first attempt of its task      → one free in-place relaunch (only when
 *                                      the owning loom still claims the run)
 *   - second-or-later attempt        → fail the attempt → run failed
 * Paused runs are user-owned and left untouched. Blocked runs split by what
 * blocked them: a worker that EXITED declaring blocked in its final report is
 * legitimately waiting on the user's answer (resumeLoops re-attaches the
 * answer seam) — left be; a worker that died MID-ask_user (attempt still
 * active, its pty gone with the old process) left a question nobody can ever
 * consume — unblock the run and put it through the normal table.
 */
export async function recoverDirectRuns(): Promise<void> {
  let runs;
  try {
    runs = await listRuns();
  } catch {
    return;
  }
  for (const run of runs) {
    if (run.executionMode !== "direct") continue;
    if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
    if (run.status === "paused") continue;

    if (run.workerAttempts.length === 0) {
      if (run.status === "blocked") continue; // can't happen in practice; user-owned
      // Crashed between run creation and prepare — nothing to salvage.
      await failNoAttemptRun(run.id);
      continue;
    }

    // ── Blocked-recovery split (unchanged): a blocked run is owned by ONE
    // ask_user worker. The split keys off the NEWEST attempt exactly as before:
    // a report-blocked worker (newest attempt terminal) is answerable — leave it
    // for the loop driver's answer seam; a worker that died MID-ask (newest
    // attempt still active, pty gone) left an unconsumable question — unblock and
    // fall through to the per-attempt table below.
    if (run.status === "blocked") {
      const newest = run.workerAttempts.at(-1)!;
      if (!ACTIVE_ATTEMPT_STATUSES.has(newest.status)) continue; // report-blocked: answerable
      if (pty.exists(newest.id)) continue; // live ask (dev hot-reload re-entry)
      // Dead mid-ask worker: the table below funnels through finalizeDirectRun,
      // which refuses blocked runs — unblock first (the same flip agent-socket's
      // restoreRunning performs).
      await unblockRun(run.id);
    }

    // ── Per-attempt report-first table. A partial wave (Looms parallel fan-out)
    // can strand SEVERAL non-terminal attempts at once; decide EACH independently
    // so the whole wave converges. Iterate a snapshot of the non-terminal
    // attempts (settle/relaunch/fail each re-read the run). The conservative
    // default holds per attempt: an undecidable attempt fails; nothing is ever
    // double-launched. settleRecoveredDirectAttempt funnels into finalizeDirectRun,
    // which re-derives the wave from loomPass.pendingNodeIds, so a partially
    // settled wave converges once its last node is decided.
    const nonTerminal = run.workerAttempts.filter((a) => ACTIVE_ATTEMPT_STATUSES.has(a.status));
    if (nonTerminal.length === 0) {
      // No active attempt, but the run never finalized (quit landed between the
      // wave's session ends and review). Funnel the run through finalize once.
      await settleRecoveredDirectAttempt(run.id, run.workerAttempts.at(-1)!.id).catch(
        () => undefined,
      );
      continue;
    }

    for (const attempt of nonTerminal) {
      // A pty from the previous process can't exist, but guard anyway (dev
      // hot-reload can re-enter recovery inside a live process).
      if (pty.exists(attempt.id)) continue;

      const reportExists = attempt.finalReportPath
        ? await fileExists(attempt.finalReportPath)
        : false;
      if (reportExists) {
        // Report on disk → settle this attempt (never re-run finished work).
        await settleRecoveredDirectAttempt(run.id, attempt.id).catch(() => undefined);
        continue;
      }
      if (attempt.attemptNumber <= 1) {
        // Never spend on a loom that no longer exists or moved on: relaunch only
        // when the owning job still claims this run (stopLoop/finalize clear
        // currentRunId; deleteJob removes the job). The currentRunId check stays
        // SCALAR — one run per loom — so it gates every attempt of that run the
        // same way. Settle paths above stay ungated — they spawn no worker, only
        // record already-finished work.
        if (await loomClaimsRun(run.automationId, run.id)) {
          await relaunchDirectAttempt(run.id, attempt.id).catch(() => undefined);
        } else {
          await failWorkerAttempt(
            run.id,
            attempt.id,
            "owning loom deleted or no longer claims this run",
          ).catch(() => undefined);
        }
        continue;
      }
      await failWorkerAttempt(
        run.id,
        attempt.id,
        "app restarted mid-iteration (relaunch already used)",
      ).catch(() => undefined);
    }
  }
}

async function loomClaimsRun(automationId: string | undefined, runId: string): Promise<boolean> {
  if (!automationId) return false;
  try {
    const { getJob } = await import("./scheduler");
    const job = await getJob(automationId);
    return Boolean(job && job.state.currentRunId === runId);
  } catch {
    return false;
  }
}

async function unblockRun(runId: string): Promise<void> {
  try {
    const { updateRunStatus } = await import("./run-store");
    await updateRunStatus({ runId, status: "running" });
  } catch {
    /* best-effort; the table below still records what it can */
  }
}

// Active attempt statuses also drive which attempts the inventory enumerates as
// distinct workers (a parallel wave fans out N live attempts at once).

/**
 * Live inventory for the Hub's Workers sub-tab. Slice 7: every LIVE attempt of a
 * non-terminal direct run is enumerated as its OWN worker entry — an N-node
 * parallel wave shows N workers, each carrying its graph nodeId/nodeLabel. A
 * single-node run has exactly one live attempt → one entry (unchanged). Each
 * entry is joined with its task config + the owning loom's name + graph.
 */
export async function listActiveAutomationWorkers(): Promise<AutomationWorkerInfo[]> {
  const [runs, jobs] = await Promise.all([
    listRuns(),
    (async () => {
      try {
        const { listJobs } = await import("./scheduler");
        return await listJobs();
      } catch {
        return [];
      }
    })(),
  ]);
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const out: AutomationWorkerInfo[] = [];
  for (const run of runs) {
    if (run.executionMode !== "direct" || !run.automationId) continue;
    if (TERMINAL_RUN_STATUSES.has(run.status) || run.status === "paused") continue;
    const job = jobById.get(run.automationId);
    // Every LIVE attempt is its own worker. A run with no live attempt (between
    // waves) still surfaces its newest attempt so the Hub doesn't drop the run
    // mid-pass — single-node parity (one attempt either way).
    const live = run.workerAttempts.filter((a) => ACTIVE_ATTEMPT_STATUSES.has(a.status));
    const attempts = live.length > 0 ? live : run.workerAttempts.slice(-1);
    for (const attempt of attempts) {
      const worker = await describeWorker(run.id, attempt.id, job);
      if (worker) out.push(worker);
    }
  }
  return out;
}

// A node's display label from the loom graph (falls back to the node id, then to
// the bare nodeId string). Used to annotate the Hub's per-node worker rows.
function nodeLabelFor(graph: LoomGraph | undefined, nodeId: string | undefined): string | undefined {
  if (!nodeId) return undefined;
  const node = graph?.nodes.find((n) => n.id === nodeId);
  const label = node && "label" in node ? node.label : undefined;
  return label && label.trim().length > 0 ? label : nodeId;
}

// Build the AutomationWorkerInfo for a run's newest attempt (or a specific one).
// Returns null when the run isn't a live direct automation run. Slice 7: the
// nodeId/nodeLabel come from the attempt's task loomNodeId joined with the loom
// graph; iteration is derived from the owning loom's pass counter (the job
// state), NOT steps.length — a multi-wave pass creates several steps, so the old
// steps.length-1 over-counted. The owning `job` is threaded in for name/graph/
// iteration; falls back to a lazy listJobs lookup when omitted.
async function describeWorker(
  runId: string,
  attemptId?: string,
  ownerJob?: ScheduledJob,
): Promise<AutomationWorkerInfo | null> {
  const run = await getRun(runId);
  if (!run || run.executionMode !== "direct" || !run.automationId) return null;
  const attempt = attemptId
    ? run.workerAttempts.find((a) => a.id === attemptId)
    : run.workerAttempts.at(-1);
  if (!attempt) return null;
  const task = run.workerTasks.find((t) => t.id === attempt.workerTaskId);
  const engine: LoomEngine = task?.runtimePreference === "codex" ? "codex" : "claude";
  const blocked = run.status === "blocked";
  const nodeId = task?.loomNodeId;
  // For a blocked run, prefer THIS node's question (a multi-node wave can block
  // several nodes, each with a loomNodeId-stamped question); fall back to the
  // newest unstamped question for a pre-graph single-node run.
  const question = blocked
    ? [...run.humanMessages]
        .reverse()
        .find(
          (m) =>
            m.author === "spark" &&
            m.kind === "question" &&
            (nodeId === undefined || m.loomNodeId === undefined || m.loomNodeId === nodeId),
        )?.message
    : undefined;
  let job = ownerJob;
  if (job === undefined) {
    try {
      const { listJobs } = await import("./scheduler");
      job = (await listJobs()).find((j) => j.id === run.automationId);
    } catch {
      /* name/graph/iteration are presentation-only */
    }
  }
  // The pass index in flight: the loom's iteration counter is 1-based once a pass
  // launches, so iteration-1 is the 0-based pass index (matching the loop
  // driver's passIter). Falls back to 0 when the job state is unavailable.
  const iteration = Math.max(0, (job?.state?.iteration ?? 1) - 1);
  return {
    automationId: run.automationId,
    automationName: job?.name ?? run.title,
    runId: run.id,
    workerTaskId: attempt.workerTaskId,
    attemptId: attempt.id,
    iteration,
    engine,
    model: task?.modelHint,
    effort: task?.effortHint,
    cwd: attempt.cwd,
    startedAt: attempt.startedAt,
    status: attempt.status,
    blocked,
    question,
    nodeId,
    nodeLabel: nodeLabelFor(job?.graph, nodeId),
  };
}

async function failNoAttemptRun(runId: string): Promise<void> {
  try {
    const { updateRunStatus } = await import("./run-store");
    await updateRunStatus({ runId, status: "failed" });
  } catch {
    /* recovery is best-effort; resumeLoops re-decides from run status */
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const { promises: fs } = await import("node:fs");
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
