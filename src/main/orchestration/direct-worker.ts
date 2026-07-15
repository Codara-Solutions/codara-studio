// Looms v2 — structured direct-worker (automation) inventory and recovery.
//
// Automation workers run through Claude Agent SDK or Codex App Server in
// run-store. Ordinary Cora implementation workers retain their visible CLI
// panes; looms are unattended jobs and expose their ordered activity logs in
// the Automations Hub instead of fabricating a terminal UI.
//
// Also owns: boot recovery for direct runs (the report-first decision table)
// and the live-worker inventory behind `automations:listActiveWorkers`.

import type {
  AutomationWorkerInfo,
  LoomEngine,
  LoomGraph,
  RunState,
  ScheduledJob,
  SparkEvent,
  WorkerAttempt,
  WorkerAttemptStatus,
} from "@shared/types";
import { resolveOpenRunQuestionForLoomNode } from "@shared/run-questions";

import * as pty from "../pty-manager";
import { appendEvent, subscribeToEvents } from "./event-log";

let runStoreMod: typeof import("./run-store") | undefined;
async function getRunStore(): Promise<typeof import("./run-store")> {
  runStoreMod ??= await import("./run-store");
  return runStoreMod;
}

const ACTIVE_ATTEMPT_STATUSES = new Set<WorkerAttemptStatus>([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
]);

const TERMINAL_RUN_STATUSES = new Set(["complete", "failed", "cancelled"]);

// Attempts announced to the Hub; the finished lifecycle event removes them.
const trackedAttempts = new Map<string, { runId: string; automationId: string }>();

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
 * Subscribe to direct-run lifecycle events and broadcast live inventory pings
 * for the Automations Hub. Execution itself is owned by run-store's structured
 * worker transport.
 */
export function installAutomationWorkerSpawnHandler(): () => void {
  const unsubscribe = subscribeToEvents((event: SparkEvent) => {
    if (!event.attemptId || !event.runId) return;
    if (event.type === "worker_attempt.finished") {
      const tracked = trackedAttempts.get(event.attemptId);
      if (!tracked) return;
      trackedAttempts.delete(event.attemptId);
      void (async () => {
        const worker = await describeWorker(tracked.runId, event.attemptId);
        if (worker) await emitWorkerPhase("exited", worker);
      })();
      return;
    }
    if (event.type !== "worker_task.envelope_prepared") return;
    const payload = event.payload as Record<string, unknown> | undefined;
    // The payload stamp is authoritative and synchronous; fall back to getRun
    // for events emitted before the stamp existed (same-session upgrades).
    if (payload && payload.executionMode !== "direct") return;

    const attemptId = event.attemptId;
    const runId = event.runId;
    void (async () => {
      let automationId = typeof payload?.automationId === "string" ? payload.automationId : "";
      try {
        const runStore = await getRunStore();
        const run = await runStore.getRun(runId);
        if (!run || run.executionMode !== "direct" || !run.automationId) return;
        automationId = run.automationId;
        const attempt = run.workerAttempts.find((item) => item.id === attemptId);
        if (!attempt) return;
        trackedAttempts.set(attemptId, { runId, automationId });
        const worker = await describeWorker(runId, attemptId);
        if (worker) await emitWorkerPhase("spawned", worker);
      } catch (err) {
        console.warn("[automation-worker] failed to announce structured worker:", err);
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
  let runStore: typeof import("./run-store");
  try {
    runStore = await getRunStore();
    runs = await runStore.listRuns();
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

    // ── Blocked-recovery split. A multi-node wave can append a terminal sibling
    // AFTER the worker whose ask_user long-poll is still active, so newest-only
    // inspection can mistake a dead live ask for a report-blocked run. Inspect the
    // whole active frontier instead: no active attempts means every blocked node
    // exited with a report and remains answerable; any surviving pty means a live
    // process still owns the ask (dev hot-reload re-entry); otherwise every active
    // attempt belongs to the dead prior process and must pass through recovery.
    if (run.status === "blocked") {
      const activeAttempts = run.workerAttempts.filter((attempt) =>
        ACTIVE_ATTEMPT_STATUSES.has(attempt.status),
      );
      if (activeAttempts.length === 0) continue; // report-blocked: answerable
      if (activeAttempts.some((attempt) => pty.exists(attempt.id))) continue;
      // Dead mid-ask worker(s): the table below funnels through
      // finalizeDirectRun, which refuses blocked runs — unblock first (the same
      // flip agent-socket's restoreRunning performs).
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
      await runStore.settleRecoveredDirectAttempt(run.id, run.workerAttempts.at(-1)!.id).catch(
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
        await runStore.settleRecoveredDirectAttempt(run.id, attempt.id).catch(() => undefined);
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
          await runStore.relaunchDirectAttempt(run.id, attempt.id).catch(() => undefined);
        } else {
          await runStore.failWorkerAttempt(
            run.id,
            attempt.id,
            "owning loom deleted or no longer claims this run",
          ).catch(() => undefined);
        }
        continue;
      }
      await runStore.failWorkerAttempt(
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
    const { updateRunStatus } = await getRunStore();
    await updateRunStatus({ runId, status: "running" });
  } catch {
    /* best-effort; the table below still records what it can */
  }
}

// Active attempt statuses also drive which attempts the inventory enumerates as
// distinct workers (a parallel wave fans out N live attempts at once).

/** A report-blocked node's question belongs to the exact attempt that emitted
 * it. Current records encode that attempt in clientMessageId; legacy records
 * fall back conservatively to the node's newest recorded attempt. */
function terminalAttemptOwnsOpenQuestion(run: RunState, attempt: WorkerAttempt): boolean {
  if (run.status !== "blocked" || ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) return false;
  const task = run.workerTasks.find((candidate) => candidate.id === attempt.workerTaskId);
  const nodeId = task?.loomNodeId;
  const question = resolveOpenRunQuestionForLoomNode(run, nodeId);
  if (!question) return false;

  if (nodeId) {
    const expectedClientMessageId = `loom-question-${run.id}-${nodeId}-${attempt.id}`;
    if (question.clientMessageId) return question.clientMessageId === expectedClientMessageId;
    const nodeAttemptIds = run.loomPass?.nodeStates[nodeId]?.attemptIds;
    if (nodeAttemptIds?.length) return nodeAttemptIds.at(-1) === attempt.id;
    const taskAttempts = run.workerAttempts.filter(
      (candidate) => candidate.workerTaskId === attempt.workerTaskId,
    );
    return taskAttempts.at(-1)?.id === attempt.id;
  }

  // Pre-graph direct runs had no node stamp. Their one report-blocked question
  // stays attached to the newest attempt, preserving the legacy single-worker
  // inventory behavior without guessing across multiple graph nodes.
  return run.workerAttempts.at(-1)?.id === attempt.id;
}

/**
 * Live inventory for the Hub's Workers sub-tab. Slice 7: every LIVE attempt of a
 * non-terminal direct run is enumerated as its OWN worker entry — an N-node
 * parallel wave shows N workers, each carrying its graph nodeId/nodeLabel. A
 * single-node run has exactly one live attempt → one entry (unchanged). Each
 * entry is joined with its task config + the owning loom's name + graph.
 */
export async function listActiveAutomationWorkers(): Promise<AutomationWorkerInfo[]> {
  const runStore = await getRunStore();
  const [runs, jobs] = await Promise.all([
    runStore.listRuns(),
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
    // Every LIVE attempt is its own worker. Also retain every terminal attempt
    // that owns an unresolved report-blocked node question: a later sibling may
    // already have succeeded, but hiding the older owner makes the remaining
    // question impossible to answer from LiveBoard. When neither category is
    // present, keep the newest attempt so the Hub doesn't drop the run between
    // waves (legacy single-node parity).
    const selectedAttemptIds = new Set<string>();
    for (const attempt of run.workerAttempts) {
      if (
        ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ||
        terminalAttemptOwnsOpenQuestion(run, attempt)
      ) {
        selectedAttemptIds.add(attempt.id);
      }
    }
    if (selectedAttemptIds.size === 0) {
      const newest = run.workerAttempts.at(-1);
      if (newest) selectedAttemptIds.add(newest.id);
    }
    const attempts = run.workerAttempts.filter((attempt) => selectedAttemptIds.has(attempt.id));
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
  const run = await (await getRunStore()).getRun(runId);
  if (!run || run.executionMode !== "direct" || !run.automationId) return null;
  const attempt = attemptId
    ? run.workerAttempts.find((a) => a.id === attemptId)
    : run.workerAttempts.at(-1);
  if (!attempt) return null;
  const task = run.workerTasks.find((t) => t.id === attempt.workerTaskId);
  const engine: LoomEngine = task?.runtimePreference === "codex" ? "codex" : "claude";
  const nodeId = task?.loomNodeId;
  // Resolve THIS attempt's still-open question, not merely the run's newest
  // historical question. Live attempts may own an active-RPC blocker; terminal
  // attempts render a question only when they are the exact report-blocked owner.
  const openQuestion =
    run.status === "blocked" &&
    (ACTIVE_ATTEMPT_STATUSES.has(attempt.status) || terminalAttemptOwnsOpenQuestion(run, attempt))
      ? resolveOpenRunQuestionForLoomNode(run, nodeId)
      : null;
  const blocked = Boolean(openQuestion);
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
    question: openQuestion?.message,
    questionMessageId: openQuestion?.id,
    nodeId,
    nodeLabel: nodeLabelFor(job?.graph, nodeId),
    transport: engine === "claude" ? "agent-sdk" : "app-server",
    stdoutLogPath: attempt.stdoutLogPath,
    rawLogPath: attempt.rawLogPath,
  };
}

async function failNoAttemptRun(runId: string): Promise<void> {
  try {
    const { updateRunStatus } = await getRunStore();
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
