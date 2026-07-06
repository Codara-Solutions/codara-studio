import type {
  AgentEffortLevel,
  AgentLoopSignal,
  AutomationContinuationSource,
  AutomationRunRecord,
  AutomationStatus,
  AutomationStopReason,
  LoomEngine,
  RunState,
  RunStatus,
  ScheduledJob,
} from "@shared/types";
import {
  AUTOMATION_HISTORY_CAP,
  DEFAULT_AGENT_MAX_ITERATIONS,
  DEFAULT_ITERATION_TIMEOUT_MINUTES,
  SPARK_LOOP_CONTINUE,
  SPARK_LOOP_DONE,
} from "@shared/types";
import { appendHistory, getJob, injectTriggerNote, listJobs, patchJob } from "./scheduler";
import { automationSourceKey, publish, rearm } from "../notify";
import { planLoomLayers, renderNodePrompt, sinkNodeIds } from "./loom-graph";
// Shell-check / git-clean probes live in loom-predicates so guard nodes (run-store)
// and these StopConditions settle identically without a run-store↔automation-loop
// static import cycle (automation-loop lazy-imports run-store).
import { gitClean, runShellCheck } from "./loom-predicates";

// ── The Loop Driver ─────────────────────────────────────────────────────────
// Owns iterations 1..N for every automation: it renders the per-iteration
// prompt, launches (or chains) the run, watches it to terminal status, decides
// whether to continue, and ALWAYS enforces the hard caps (maxIterations +
// budget) so an "infinite" / agent-driven loop is always escapable.
//
// It is a SEPARATE registry from scheduler.ts's `armed` map: pausing a loop
// never disarms its trigger and vice-versa. The driver is loaded lazily by the
// scheduler (await import) so its heavy transitive deps (run-store) stay out of
// cold start; run-store / event-log are themselves lazy-imported per call.
//
// Agent-driven loops: the model decides whether to keep going either via the
// `spark_request_next_iteration` MCP tool (recorded through recordAgentSignal)
// or, with zero instrumentation, by writing SPARK_LOOP_CONTINUE /
// SPARK_LOOP_DONE as the LAST line of its final summary. Either way the engine
// caps still apply.

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(["complete", "failed", "cancelled"]);

// Defensive default when a job somehow reaches the driver without its graph
// backfilled (the type carries graph as optional; normalizeJob fills it on
// every read/create path). Mirrors normalizeJob's single-node backfill: one
// "w0" worker node, no edges — planLoomLayers yields {layers:[["w0"]]}.
const FALLBACK_GRAPH: import("@shared/types").LoomGraph = {
  version: 1,
  nodes: [{ id: "w0", kind: "worker", worker: { engine: "auto" }, prompt: "" }],
  edges: [],
  entryNodeIds: ["w0"],
};

interface LoopRunner {
  unsubscribe?: () => void;
  cadenceTimer?: ReturnType<typeof setTimeout>;
  // Per-iteration wall-clock watchdog (LoomWorkerConfig.timeoutMinutes), keyed
  // by attemptId. Slice 7: a pass can have MULTIPLE live attempts at once (a
  // parallel wave), so each LIVE attempt gets its own timer — on fire it
  // force-fails ONLY that attempt (which funnels through finalizeDirectRun so
  // the wave/pass settles per the graph rules), never the whole run. A timer is
  // cleared when its attempt goes terminal, and the WHOLE map is cleared on
  // teardown/pause/stop/finalize so no leaked timer force-fails an attempt of an
  // already-settled pass. Single-node: exactly one timer for the one attempt =
  // today's behaviour.
  watchdogTimers: Map<string, ReturnType<typeof setTimeout>>;
  firing: boolean;
  // The chain of automation ids that led here (onFinishOf cycle guard).
  chain: string[];
}

const loops = new Map<string, LoopRunner>();
// sourceAutomationId -> set of dependent automation ids (onFinishOf triggers).
const onFinishWatchers = new Map<string, Set<string>>();
// runIds with a live completion watcher (avoid double-subscribing).
const watchedRuns = new Set<string>();
// Jobs whose "paused" state was MIRRORED from their run being paused (chat
// Pause / force-pause on the pass), as opposed to the user pausing the loom
// itself. Only mirrored pauses may be auto-cleared when the run moves again —
// a user's loom-level pause must never be laundered back to running. In-memory
// on purpose: after a restart the conservative outcome (loom stays paused
// until the user acts) is the safe one.
const runPausedMirror = new Set<string>();
// Structured agent continuation intents, keyed by runId then by NODE id (the
// inner key is "" for an unstamped/legacy signal — SPARK_NODE_ID absent, i.e. a
// pre-graph single-node loom). Written by the MCP handler via recordAgentSignal;
// read once in onTerminal, which reads ONLY the SINK node's signal in a
// multi-node wave (falling back to the unstamped slot for single-node looms).
// The SINK's decision is also mirrored into job.state.pendingAgentSignal so a
// restart between worker-finish and onTerminal can't lose the model's decision.
const agentSignals = new Map<string, Map<string, AgentLoopSignal>>();

function nowIso(): string {
  return new Date().toISOString();
}

function runnerFor(id: string): LoopRunner {
  let r = loops.get(id);
  if (!r) {
    r = { firing: false, chain: [id], watchdogTimers: new Map() };
    loops.set(id, r);
  }
  return r;
}

// Largest number of iterations this loop may ever start. ALWAYS finite (the
// "always escapable" invariant): the user's maxIterations wins when set,
// otherwise every repeating kind — agent/continuous AND until/cadence — falls
// back to DEFAULT_AGENT_MAX_ITERATIONS. (A blank-cap `until` loop with no
// predicate would otherwise spin forever; cadence is rate-limited but still
// capped so the editor's "20" placeholder is truthful for every kind.)
function hardCap(job: ScheduledJob): number {
  const m = job.loop.stop.maxIterations;
  if (typeof m === "number" && m > 0) return m;
  switch (job.loop.kind) {
    case "once":
      return 1;
    case "count":
      return 1; // count's target is stop.maxIterations; absent => a single pass
    default:
      return DEFAULT_AGENT_MAX_ITERATIONS; // agent / continuous / until / cadence
  }
}

function capHistory(history: AutomationRunRecord[]): AutomationRunRecord[] {
  return history.length > AUTOMATION_HISTORY_CAP ? history.slice(-AUTOMATION_HISTORY_CAP) : history;
}

// The per-PASS variable snapshot, computed ONCE per iteration. These are the
// pass-level {{vars}} every node in the pass renders against (a pass is one
// consistent snapshot, not re-sampled per wave). `lastSummary` is kept as an
// alias of `lastOutput` for backward compatibility with older templates.
function buildPassVars(
  job: ScheduledJob,
  ctx: { iteration: number; lastOutput?: string; file?: string },
): Record<string, string> {
  return {
    iteration: String(ctx.iteration),
    lastOutput: ctx.lastOutput ?? "",
    lastSummary: ctx.lastOutput ?? "",
    file: ctx.file ?? job.lastFiredPath ?? "",
    date: nowIso().slice(0, 10),
    name: job.name,
  };
}

// NB: the per-iteration prompt is rendered inline in startIteration so it can
// reuse the same passVars snapshot threaded onto the run. Both the entry prompt
// and every graph node prompt go through loom-graph.renderNodePrompt with that
// one snapshot, so a degenerate single-node loom's entry prompt is rendered by
// the EXACT same code as a graph node's layer-0 prompt — the single-node parity
// invariant (renderNodePrompt(template,{vars,{},[]}) === the legacy
// {{var}}-only render).

// The agent's final say for an iteration — used to drive {{lastOutput}} and the
// agent-loop continue decision and the until-phrase check.
function lastSparkSummary(run: RunState): string | undefined {
  for (let i = run.humanMessages.length - 1; i >= 0; i -= 1) {
    const m = run.humanMessages[i];
    if (m.author === "spark" && m.message.trim()) return m.message;
  }
  return undefined;
}

async function emitIteration(
  automationId: string,
  iteration: number,
  runId: string | undefined,
  status: AutomationStatus,
): Promise<void> {
  try {
    const { appendEvent } = await import("./event-log");
    await appendEvent({
      workspaceId: "",
      type: "automation.iteration",
      payload: { automationId, iteration, runId, status },
    });
  } catch {
    /* best-effort live ping; patchJob already emits automation.updated */
  }
}

// ── Public API (called by scheduler.ts + ipc.ts) ─────────────────────────────

export interface StartIterationOpts {
  source: AutomationContinuationSource;
  firedPath?: string;
  chain?: string[];
}

// Start the next iteration of an automation's loop. Idempotent against an
// in-flight run (won't stack), and enforces the hard caps before launching.
export async function startIteration(id: string, opts: StartIterationOpts): Promise<void> {
  let job = await getJob(id);
  if (!job || !job.enabled) return;
  if (job.state.status === "paused") return; // explicit user hold; resumeLoop re-drives
  if (job.state.status === "stopped") {
    // A finalized loop is NOT dead to its trigger: a cron/interval/folder fire
    // (or an onFinishOf chain / manual kick) starts a FRESH cycle, exactly like
    // the pre-loop scheduler fired on every tick. Loop-internal continuation
    // sources never revive a finalized loop. Re-read the job afterwards — the
    // cap checks below must see the reset iteration, not the stale snapshot.
    if (opts.source !== "trigger" && opts.source !== "continuous" && opts.source !== "manual") {
      return;
    }
    await patchJob(id, (j) => ({
      ...j,
      state: {
        status: "idle",
        iteration: 0,
        spentUsd: 0,
        currentRunId: undefined,
        nextFireAt: undefined,
        lastStopReason: undefined,
        pendingNextPrompt: undefined,
        pendingNextWorker: undefined,
        pendingAgentSignal: undefined,
      },
    }));
    job = await getJob(id);
    if (!job) return;
  }

  const runner = runnerFor(id);
  if (runner.firing) return; // single-flight within a tick
  if (opts.chain) runner.chain = opts.chain;

  runner.firing = true;
  try {
    // Don't stack iterations: if the current run is still live, hold. (Same-run
    // chaining only re-enters here AFTER onTerminal, when the run is terminal.)
    if (job.state.currentRunId) {
      const live = await safeGetRun(job.state.currentRunId);
      if (live && !TERMINAL.has(live.status)) return;
    }

    // HARD CAPS — always enforced, even for agent/continuous loops.
    const cap = hardCap(job);
    if (job.state.iteration >= cap) {
      await finalize(id, "max-iterations");
      return;
    }
    const budget = job.loop.stop.budgetUsd;
    if (typeof budget === "number" && (job.state.spentUsd ?? 0) >= budget) {
      await finalize(id, "budget");
      return;
    }

    // A new iteration is real new activity — re-arm the notify policy so the
    // loop's eventual finish/failure alert delivers even after a prior one.
    rearm(automationSourceKey(id));

    const passIter = job.state.iteration; // 0-based index of THIS pass
    const lastRecord = job.history[job.history.length - 1];
    // Compute the pass-level {{var}} snapshot ONCE. The entry (layer-0) prompt
    // renders against it here; the SAME snapshot is threaded onto the run so a
    // later wave (launched by finalizeDirectRun for a chain A→B→C) renders its
    // node templates against identical values — a pass is one consistent
    // snapshot, never re-sampled per wave.
    const passVars = buildPassVars(job, {
      iteration: passIter,
      lastOutput: lastRecord?.summary,
      file: opts.firedPath,
    });
    // Decorate a rendered node prompt with the firedPath trigger note + the
    // agent-loop footer — the EXACT transforms the legacy single-node prompt got.
    // Used for BOTH the degenerate entry prompt AND each multi-node entry's
    // per-node prompt (FIX 1: the footer/note apply PER entry node).
    const decoratePrompt = (rendered: string, steerable = true): string => {
      let p = rendered;
      // A folder trigger's changed path: append it unless the template already
      // wove it in via {{file}}, so the agent always knows what fired.
      if (opts.firedPath && !p.includes(opts.firedPath)) {
        p = injectTriggerNote({ ...job.input, initialUserNote: p }, opts.firedPath)
          .initialUserNote as string;
      }
      // Agent-driven loops: tell the model how to keep the loop going even if the
      // template never mentioned the mechanism. (Hard caps stop it regardless.)
      // steerable=false for multi-node entry prompts: resolveWorker only consumes
      // a handoff on the job-level worker (degenerate/answer-resume paths), so
      // graph entries must not be promised engine steering that can't happen.
      if (
        job.loop.kind === "agent" &&
        !/SPARK_LOOP_(CONTINUE|DONE)|spark_request_next_iteration/.test(p)
      ) {
        p = `${p}${agentLoopFooter(job, steerable)}`;
      }
      return p;
    };

    // Looms v2.5: plan the pass's node layers from the graph (guaranteed present
    // post-normalize). Layer 0 (the FULL indegree-0 frontier) is launched here;
    // downstream layers are launched by finalizeDirectRun as each wave settles.
    const graph = job.graph ?? FALLBACK_GRAPH;
    const { layers } = planLoomLayers(graph);
    const entryIds = layers[0]?.length ? layers[0] : ["w0"];
    const sinks = sinkNodeIds(graph);
    // DEGENERATE (single-node / legacy): exactly ONE entry AND that entry is
    // itself a sink (no forward successor). Then route through the EXISTING
    // job.prompt.template + job.worker single-node path VERBATIM — byte-identical
    // to today (pendingNextPrompt precedence, the legacy render, single-node
    // launch). A multi-entry frontier OR a single entry that feeds a successor
    // (a linear chain A→B→C) takes the multi-node path so the entry runs its OWN
    // prompt/worker, never the sink's mirror.
    const degenerate = entryIds.length === 1 && sinks.includes(entryIds[0]);

    const startedAt = nowIso();
    let run: RunState;
    const sameRun = !job.loop.isolate && job.state.currentRunId;

    if (degenerate) {
      // BYTE-IDENTICAL legacy path. pendingNextPrompt (answer-resume / agent
      // steering) still takes precedence; the firedPath note + agentLoopFooter
      // still apply; resolveWorker uses job.worker.
      const entryNodeId = entryIds[0];
      // BYTE-IDENTICAL: pendingNextPrompt takes precedence over the rendered
      // template, then BOTH flavors get the firedPath note + agent footer (the
      // legacy code applied those transforms after the `??`, to either source).
      const prompt = decoratePrompt(
        job.state.pendingNextPrompt ??
          renderNodePrompt(job.prompt?.template ?? job.input.initialUserNote ?? "", {
            vars: passVars,
            nodeOutputs: {},
            incoming: [],
          }),
      );
      const resolved = await resolveWorker(job);
      if (!resolved.ok) {
        await finalize(id, "engine-missing");
        return;
      }
      // Per-worker tool access lives on the graph node (not job.worker), so the
      // single-node path reads it off the entry node and threads it down. collab
      // is skipped — a lone worker has no peers.
      const entryNode = graph.nodes.find((n) => n.id === entryNodeId);
      const access = entryNode?.kind === "worker" ? entryNode.access : undefined;
      const blockedTools = entryNode?.kind === "worker" ? entryNode.blockedTools : undefined;
      if (sameRun) {
        const { addDirectIteration } = await import("./run-store");
        run = await addDirectIteration({
          runId: job.state.currentRunId as string,
          clientMessageId: `loop-${id}-${passIter}`,
          prompt,
          engine: resolved.engine,
          model: resolved.model,
          effort: resolved.effort,
          loomNodeId: entryNodeId,
          access,
          blockedTools,
          vars: passVars,
          freshPass: true, // same-run PASS boundary: rebuild loomPass from scratch
        });
      } else {
        const { startDirectWorkerRun } = await import("./run-store");
        run = await startDirectWorkerRun({
          workspaceId: job.input.workspaceId,
          workspaceName: job.input.workspaceName,
          cwd: job.input.cwd,
          automationId: id,
          title: `Loom: ${job.name} — pass ${passIter + 1}`,
          prompt,
          engine: resolved.engine,
          model: resolved.model,
          effort: resolved.effort,
          loomNodeId: entryNodeId,
          access,
          blockedTools,
          vars: passVars,
        });
      }
    } else {
      // MULTI-NODE entry frontier (FIX 1 + FIX 5): launch EVERY layer-0 node as
      // ONE wave, each running its OWN node prompt (rendered against the pass
      // vars, no upstream context) + its OWN worker config. (pendingNextPrompt is
      // a single-agent steering construct owned by the degenerate path; a graph
      // frontier renders each entry's authored prompt instead.) Non-worker entry
      // nodes (a guard/merge wired straight off the trigger) are skipped — the
      // executor only launches worker waves; if NONE remain we fall back to a
      // degenerate single-node launch so the pass never starts empty.
      const workerEntries = entryIds
        .map((nid) => graph.nodes.find((n) => n.id === nid))
        .filter((n): n is Extract<typeof graph.nodes[number], { kind: "worker" }> => n?.kind === "worker");

      if (workerEntries.length === 0) {
        // No launchable entry worker (malformed graph) — stop cleanly.
        await finalize(id, "iteration-failed");
        return;
      }

      // Resolve each entry node's worker against the installed set; a single
      // missing engine fails the pass exactly as the single-node path does.
      const launches: import("@shared/types").DirectNodeLaunch[] = [];
      for (const node of workerEntries) {
        const resolved = await resolveWorker(job, node.worker);
        if (!resolved.ok) {
          await finalize(id, "engine-missing");
          return;
        }
        const rendered = decoratePrompt(
          renderNodePrompt(node.prompt, { vars: passVars, nodeOutputs: {}, incoming: [] }),
          false,
        );
        launches.push({
          nodeId: node.id,
          template: rendered,
          worker: { engine: resolved.engine, model: resolved.model, effort: resolved.effort },
          label: node.label,
          access: node.access,
          blockedTools: node.blockedTools,
          collab: node.collab,
        });
      }

      if (sameRun) {
        const { addDirectIteration } = await import("./run-store");
        run = await addDirectIteration({
          runId: job.state.currentRunId as string,
          clientMessageId: `loop-${id}-${passIter}`,
          // prompt/engine kept for the iteration_started event payload + type; the
          // actual launch uses `nodes`. Use the first entry's resolved values.
          prompt: launches[0].template,
          engine: launches[0].worker.engine as LoomEngine,
          model: launches[0].worker.model,
          effort: launches[0].worker.effort,
          vars: passVars,
          nodes: launches,
          freshPass: true, // same-run PASS boundary: rebuild loomPass from scratch
        });
      } else {
        const { startDirectWorkerRun } = await import("./run-store");
        run = await startDirectWorkerRun({
          workspaceId: job.input.workspaceId,
          workspaceName: job.input.workspaceName,
          cwd: job.input.cwd,
          automationId: id,
          title: `Loom: ${job.name} — pass ${passIter + 1}`,
          prompt: launches[0].template,
          engine: launches[0].worker.engine as LoomEngine,
          model: launches[0].worker.model,
          effort: launches[0].worker.effort,
          vars: passVars,
          nodes: launches,
        });
      }
    }

    await patchJob(id, (j) => ({
      ...j,
      lastRunAt: startedAt,
      lastRunId: run.id,
      state: {
        ...j.state,
        status: "running",
        iteration: passIter + 1,
        currentRunId: run.id,
        pendingNextPrompt: undefined,
        pendingNextWorker: undefined,
        pendingAgentSignal: undefined,
        nextFireAt: undefined,
      },
      history: capHistory([
        ...j.history,
        {
          iteration: passIter,
          runId: run.id,
          startedAt,
          status: "running",
          continuationSource: opts.source,
        },
      ]),
    }));

    void emitIteration(id, passIter, run.id, "running");
    armWatchdog(id, run.id, job.worker.timeoutMinutes);
    watchTerminal(id, run.id);
  } catch (err) {
    console.error(`[automation-loop] startIteration ${id} failed:`, err);
  } finally {
    runner.firing = false;
  }
}

// "Run now": reset the loop to a fresh manual pass and start it, returning the
// live RunState (matches the old runJobNow contract).
export async function runNow(id: string): Promise<RunState> {
  const existing = loops.get(id);
  if (existing?.cadenceTimer) clearTimeout(existing.cadenceTimer);
  if (existing) for (const timer of existing.watchdogTimers.values()) clearTimeout(timer);
  if (existing?.unsubscribe) existing.unsubscribe();
  loops.delete(id);

  // "Run now" is a RESTART, not a stack: a still-live pass must die first or
  // its CLI worker keeps editing the workspace headless — unwatched (we just
  // unsubscribed), unkillable (the state reset below orphans it from every UI
  // surface), and racing the fresh worker on the same cwd. Also drop the old
  // run from watchedRuns (the manual unsubscribe bypassed the handler that
  // normally removes it — a stale entry would block any future re-attach) and
  // close its history row so the Hub doesn't show a forever-"running" pass.
  const prior = await getJob(id);
  const priorRunId = prior?.state.currentRunId;
  if (priorRunId) {
    watchedRuns.delete(priorRunId);
    const live = await safeGetRun(priorRunId);
    if (live && !TERMINAL.has(live.status)) {
      await killLiveRun(priorRunId);
      await patchJob(id, (j) => ({
        ...j,
        history: j.history.map((r) =>
          r.runId === priorRunId && !r.finishedAt
            ? { ...r, finishedAt: nowIso(), status: "cancelled" as RunStatus, stopReason: "user-stop" as AutomationStopReason }
            : r,
        ),
      }));
    }
  }

  await patchJob(id, (j) => ({
    ...j,
    state: {
      status: "idle",
      iteration: 0,
      currentRunId: undefined,
      spentUsd: 0,
      nextFireAt: undefined,
      lastStopReason: undefined,
      pendingNextPrompt: undefined,
      pendingNextWorker: undefined,
      pendingAgentSignal: undefined,
    },
  }));

  await startIteration(id, { source: "manual" });

  const job = await getJob(id);
  const runId = job?.state.currentRunId;
  if (!runId) throw new Error(`Automation did not start a run: ${id}`);
  const run = await safeGetRun(runId);
  if (!run) throw new Error(`Run not found after start: ${runId}`);
  return run;
}

// Pause the LOOP (no further iterations) without disarming the trigger. An
// in-flight run still finishes; onTerminal records it and parks.
export async function pauseLoop(id: string): Promise<void> {
  const runner = loops.get(id);
  if (runner?.cadenceTimer) {
    clearTimeout(runner.cadenceTimer);
    runner.cadenceTimer = undefined;
  }
  await patchJob(id, (j) => ({ ...j, state: { ...j.state, status: "paused", nextFireAt: undefined } }));
}

// Stop the loop now: finalize + force-pause the live run + kill the worker's
// CLI process. opts.fireDependents=false suppresses onFinishOf chaining — a
// delete-driven stop must not kick downstream looms.
export async function stopLoop(id: string, opts?: { fireDependents?: boolean }): Promise<void> {
  const job = await getJob(id);
  const runId = job?.state.currentRunId;
  if (runId) await killLiveRun(runId);
  await finalize(id, "user-stop", opts);
}

// Force-stop a live direct run: forcePauseRun terminalizes orchestration state;
// the pty kills make sure no orphaned claude/codex keeps editing the workspace.
// Shared by stopLoop and runNow (a restart must not stack workers).
//
// Slice 7: a parallel wave can have SEVERAL live attempts (one pty each), so we
// kill the pty of EVERY non-terminal attempt — Restart/Stop must not orphan a
// sibling worker that keeps editing the cwd headless. (forcePauseRun also kills
// the run's active worker ptys via activeWorkersForRun, but those are tracked
// in-process; a recovered/headless attempt's pty may not be, so we sweep the
// attempt set explicitly too. killImmediate on an already-dead pty no-ops.)
// Single-node: one live attempt = exactly today's single kill.
async function killLiveRun(runId: string): Promise<void> {
  try {
    const { forcePauseRun } = await import("./run-store");
    await forcePauseRun(runId);
  } catch {
    /* best-effort */
  }
  try {
    const run = await safeGetRun(runId);
    if (run) {
      const pty = await import("../pty-manager");
      for (const attempt of run.workerAttempts) {
        if (ATTEMPT_TERMINAL.has(attempt.status)) continue;
        if (pty.exists(attempt.id)) pty.killImmediate(attempt.id);
      }
    }
  } catch {
    /* best-effort */
  }
}

// Re-drive a SINGLE loop after the user un-pauses it (scheduler.resumeJob has
// already flipped paused → idle). Mirrors one iteration of resumeLoops: if the
// in-flight run already finished (during the pause) re-decide it; if it's still
// live re-attach; if nothing is in flight, re-arm cadence / await the trigger.
// Safe + idempotent (onTerminal no longer re-counts a finalized pass; the
// watchedRuns guard prevents double-subscribe).
export async function resumeLoop(id: string): Promise<void> {
  const job = await getJob(id);
  if (!job || job.state.status !== "idle") return;
  const runId = job.state.currentRunId;
  if (!runId) {
    // Re-arm only a cadence CYCLE that was actually in progress: nextFireAt
    // survives a parked wait (resume at the remaining due time), and a pause
    // mid-cycle clears nextFireAt but leaves iteration > 0 (full period).
    // A paused never-fired cadence loom (iteration 0) must keep waiting for
    // its TRIGGER — resuming it must not start spending on a loop the
    // trigger never started.
    if (job.loop.kind === "cadence" && (job.state.nextFireAt || job.state.iteration > 0)) {
      const everyMs = Math.max(1000, Math.floor(job.loop.everyMs ?? 60_000));
      const due = job.state.nextFireAt
        ? new Date(job.state.nextFireAt).getTime() - Date.now()
        : everyMs;
      scheduleCadence(id, Math.max(0, Math.min(due, everyMs)));
    }
    return;
  }
  const run = await safeGetRun(runId);
  if (!run) {
    await finalize(id, "iteration-failed");
  } else if (TERMINAL.has(run.status)) {
    await onTerminal(id, run); // finished during the pause → re-decide now
  } else {
    armWatchdog(id, runId, job.worker.timeoutMinutes); // fresh ceiling on re-attach
    watchTerminal(id, runId); // still live → re-attach
    // An answer to a report-blocked pass may have landed during the pause.
    if (run.status === "blocked") await maybeResumeAnsweredPass(id, run);
  }
}

// Re-attach to / re-decide loops that were mid-flight when the app last closed.
export async function resumeLoops(): Promise<void> {
  let jobs: ScheduledJob[] = [];
  try {
    jobs = await listJobs();
  } catch {
    return;
  }
  for (const job of jobs) {
    try {
      // "blocked" looms re-attach too: a report-blocked pass is waiting on the
      // user's answer, and without a watcher the answer would be a dead letter
      // after a restart (recoverDirectRuns deliberately leaves those runs be).
      if (
        (job.state.status === "running" || job.state.status === "blocked") &&
        job.state.currentRunId
      ) {
        const run = await safeGetRun(job.state.currentRunId);
        if (!run) {
          await finalize(job.id, "iteration-failed");
        } else if (TERMINAL.has(run.status)) {
          await onTerminal(job.id, run); // missed terminal during downtime — re-decide now
        } else {
          armWatchdog(job.id, job.state.currentRunId, job.worker.timeoutMinutes);
          watchTerminal(job.id, job.state.currentRunId);
          // The answer may have landed while the app was closed — no event
          // will re-fire the watcher for it, so check once now.
          if (run.status === "blocked") await maybeResumeAnsweredPass(job.id, run);
        }
      } else if (job.loop.kind === "cadence" && job.state.status === "idle" && job.state.nextFireAt) {
        const due = new Date(job.state.nextFireAt).getTime() - Date.now();
        scheduleCadence(job.id, Math.max(0, due));
      }
    } catch (err) {
      console.error(`[automation-loop] resume ${job.id} failed:`, err);
    }
  }
}

export function teardownAllLoops(): void {
  for (const runner of loops.values()) {
    if (runner.cadenceTimer) clearTimeout(runner.cadenceTimer);
    for (const timer of runner.watchdogTimers.values()) clearTimeout(timer);
    if (runner.unsubscribe) runner.unsubscribe();
  }
  loops.clear();
  watchedRuns.clear();
}

// onFinishOf chain registry (called from scheduler.armJob).
export function registerOnFinishOf(sourceId: string, dependentId: string): void {
  let set = onFinishWatchers.get(sourceId);
  if (!set) {
    set = new Set();
    onFinishWatchers.set(sourceId, set);
  }
  set.add(dependentId);
}

export function unregisterOnFinishOf(sourceId: string, dependentId: string): void {
  onFinishWatchers.get(sourceId)?.delete(dependentId);
}

// Record a structured agent continuation intent (the spark_request_next_iteration
// MCP tool calls this; handoff fields arrive pre-validated by agent-socket).
// Read once by onTerminal. The signal carries the calling worker's loom node id
// (slice 7) so a multi-node wave's signals are stored per node; the pass-level
// loop reads only the SINK node's decision. Single-node / pre-graph workers send
// no node id, stored under the "" slot — exactly the legacy single-slot behaviour.
//
// The persisted mirror (job.state.pendingAgentSignal) survives a restart landing
// between worker-finish and onTerminal. Only the SINK node's signal is mirrored
// (a non-sink worker's decision must not become the pass's persisted verdict);
// an unstamped signal or a loom with no graph mirrors unconditionally (the
// single-node case).
export function recordAgentSignal(runId: string, signal: AgentLoopSignal): void {
  const nodeKey = signal.nodeId ?? "";
  let byNode = agentSignals.get(runId);
  if (!byNode) {
    byNode = new Map();
    agentSignals.set(runId, byNode);
  }
  byNode.set(nodeKey, signal);
  void (async () => {
    try {
      const jobs = await listJobs();
      const job = jobs.find((j) => j.state.currentRunId === runId);
      if (!job) return;
      // Mirror only the sink's (or an unstamped) signal so a non-terminal
      // worker's vote can't be persisted as the pass verdict.
      const sinks = sinkNodeIds(job.graph ?? FALLBACK_GRAPH);
      const isSinkOrUnstamped = signal.nodeId === undefined || sinks.includes(signal.nodeId);
      if (!isSinkOrUnstamped) return;
      await patchJob(job.id, (j) => ({
        ...j,
        state: { ...j.state, pendingAgentSignal: signal },
      }));
    } catch {
      /* persistence is best-effort; the in-memory map covers the live path */
    }
  })();
}

// ── Worker resolution (Looms v2) ─────────────────────────────────────────────
// Which CLI engine/model/effort runs the NEXT pass. Precedence:
//   1. a validated agent handoff (state.pendingNextWorker, consumed once) — now
//      honored even on a pinned engine, since "auto" no longer exists;
//   2. the loom's own pinned engine/model/effort;
//   3. a legacy "auto" spec (persisted before the auto→concrete change) still
//      resolves claude-when-installed, else codex.
// A model id unknown to the resolved runtime falls back to the CLI default
// rather than failing the pass.
async function resolveWorker(
  job: ScheduledJob,
  workerConfig: import("@shared/types").LoomWorkerConfig = job.worker,
): Promise<
  | { ok: true; engine: LoomEngine; model?: string; effort?: AgentEffortLevel }
  | { ok: false }
> {
  const { detectAgentRuntimes } = await import("../agent-runtimes");
  const runtimes = await detectAgentRuntimes();
  const installed = new Set(
    runtimes
      .filter((r) => (r.kind === "claude" || r.kind === "codex") && r.installed && !r.disabledBySettings)
      .map((r) => r.kind as LoomEngine),
  );

  // Resolve against the GIVEN worker config (defaults to job.worker so every
  // existing call is byte-identical). A multi-node entry frontier resolves each
  // entry node's OWN worker via resolveWorker(job, node.worker); the agent
  // handoff stays keyed off job.worker (the loom-level engine policy) — only the
  // job-level config carries a pending handoff. A handoff steers the NEXT pass's
  // engine/model/effort even when the engine is pinned: "auto" no longer exists,
  // so gating on it would silently drop every handoff (the socket already
  // validated the fields against installed runtimes before recording them).
  const handoff = workerConfig === job.worker ? job.state.pendingNextWorker : undefined;

  const want = handoff?.engine ?? workerConfig.engine;
  const engine: LoomEngine | null =
    want !== "auto"
      ? installed.has(want)
        ? want
        : null
      : installed.has("claude")
        ? "claude"
        : installed.has("codex")
          ? "codex"
          : null;
  if (!engine) return { ok: false };

  let model = handoff?.model ?? (engine === workerConfig.engine ? workerConfig.model : undefined);
  const known = runtimes.find((r) => r.kind === engine)?.models.map((m) => m.id) ?? [];
  if (model && known.length > 0 && !known.includes(model)) {
    void emitLoopNote("automation.model_fallback", {
      automationId: job.id,
      engine,
      requested: model,
    });
    model = undefined;
  }
  const effort =
    handoff?.effort ?? (engine === workerConfig.engine ? workerConfig.effort : undefined);
  return { ok: true, engine, model, effort };
}

// Broadcast-only observability ping (same shape as automation.iteration).
async function emitLoopNote(type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { appendEvent } = await import("./event-log");
    await appendEvent({ workspaceId: "", type, payload });
  } catch {
    /* best-effort */
  }
}

// ── Per-attempt watchdog (slice 7) ───────────────────────────────────────────
// A direct worker that hangs (TUI stuck, network dead) would otherwise hold the
// loop open forever — the run only terminalizes when its attempts do. A pass
// can run MULTIPLE attempts at once (a parallel wave), so each LIVE attempt gets
// its OWN wall-clock timer. On fire we re-verify the run is still the job's
// current run AND that attempt is still non-terminal, then force-fail ONLY that
// attempt: failWorkerAttempt funnels through finalizeDirectRun, so the wave/pass
// settles per the graph rules (a sibling that finished is unaffected; the run
// terminalizes only when the whole wave joins). watchTerminal then sees the
// terminal run and the loop records "iteration-failed".
//
// For a single-node pass there is exactly one live attempt, so exactly one timer
// is armed and firing it force-fails the sole attempt — byte-identical to the
// pre-slice-7 single-timer behaviour. Idempotent: a re-arm (resume re-attach)
// only adds timers for live attempts that don't already have one.
function armWatchdog(id: string, runId: string, timeoutMinutes: number | undefined): void {
  const runner = runnerFor(id);
  const minutes = Math.max(1, Math.floor(timeoutMinutes ?? DEFAULT_ITERATION_TIMEOUT_MINUTES));
  void (async () => {
    try {
      const run = await safeGetRun(runId);
      if (!run) return;
      // Blocked is not a hang (waiting on the user); the live-ask attempt then
      // owns its own deadline via spark_ask_user. Don't arm against a blocked
      // run — watchTerminal re-arms when it leaves blocked.
      if (run.status === "blocked") return;
      const liveAttempts = run.workerAttempts.filter((a) => !ATTEMPT_TERMINAL.has(a.status));
      for (const attempt of liveAttempts) {
        if (runner.watchdogTimers.has(attempt.id)) continue; // already armed
        const attemptId = attempt.id;
        const timer = setTimeout(() => {
          runner.watchdogTimers.delete(attemptId);
          void fireWatchdog(id, runId, attemptId, minutes);
        }, minutes * 60_000);
        runner.watchdogTimers.set(attemptId, timer);
      }
    } catch (err) {
      console.error(`[automation-loop] arm watchdog ${id} failed:`, err);
    }
  })();
}

// The per-attempt watchdog FIRE: re-verify (the run is still the job's current
// run AND that attempt is still non-terminal), then force-fail ONLY that attempt
// — failWorkerAttempt funnels through finalizeDirectRun so the wave/pass settles
// per the graph rules. Extracted from armWatchdog's timer callback so the fire
// behaviour is unit-testable without waiting out the (≥1-minute) wall clock.
// Exported under a leading-underscore test-seam name; never called in production
// except by the timer above.
export async function fireWatchdog(
  id: string,
  runId: string,
  attemptId: string,
  minutes: number,
): Promise<void> {
  try {
    const job = await getJob(id);
    if (!job || job.state.currentRunId !== runId) return; // ownership moved on
    const fresh = await safeGetRun(runId);
    if (!fresh || TERMINAL.has(fresh.status)) return;
    const a = fresh.workerAttempts.find((x) => x.id === attemptId);
    if (!a || ATTEMPT_TERMINAL.has(a.status)) return; // already settled
    const { failWorkerAttempt } = await import("./run-store");
    await failWorkerAttempt(runId, attemptId, `iteration timed out after ${minutes}m`);
  } catch (err) {
    console.error(`[automation-loop] watchdog ${id} failed:`, err);
  }
}

// Clear ALL of a loop's per-attempt watchdog timers (onTerminal/finalize/etc).
// A leaked timer for a settled pass would force-fail an attempt of whatever run
// reused the loop next — clearing the whole map closes that window.
function clearWatchdog(id: string): void {
  const runner = loops.get(id);
  if (!runner) return;
  for (const timer of runner.watchdogTimers.values()) clearTimeout(timer);
  runner.watchdogTimers.clear();
}

// ── Completion watching ──────────────────────────────────────────────────────

function watchTerminal(id: string, runId: string): void {
  if (watchedRuns.has(runId)) return;
  watchedRuns.add(runId);
  void (async () => {
    const { subscribeToEvents } = await import("./event-log");
    const unsub = subscribeToEvents((event) => {
      if (event.runId !== runId) return;
      void (async () => {
        const run = await safeGetRun(runId);
        if (!run) return;
        if (run.status === "blocked") {
          // Surface the cue on the loom — but never clobber an explicit user
          // pause/stop (re-checked inside the patch fn: patchJob re-reads, so
          // a flip landing between our read and the write still can't lose
          // the pause, and the later blocked→running clear can't launder it).
          const current = await getJob(id);
          if (!current || current.state.status === "paused" || current.state.status === "stopped") {
            return;
          }
          if (current.state.status !== "blocked") {
            await patchJob(id, (j) =>
              j.state.status === "paused" || j.state.status === "stopped"
                ? j
                : { ...j, state: { ...j.state, status: "blocked" } },
            );
            void emitIteration(id, (await getJob(id))?.state.iteration ?? 0, runId, "blocked");
          }
          // Report-blocked passes (worker EXITED declaring blocked) have no
          // live ask_user poll — when the user's answer lands as a message,
          // this is the only consumer that can resume the pass with it.
          await maybeResumeAnsweredPass(id, run);
          return; // HOLD — keep the subscription; resume when it leaves blocked
        }
        if (run.status === "paused") {
          // A paused RUN must pull its loom out of "Running" — otherwise the
          // Hub shows a live loom forever while nothing is in flight (a
          // force-paused pass stranded exactly that way). Mirror one-way and
          // remember it, so only a mirrored pause is ever auto-cleared below.
          const current = await getJob(id);
          if (
            current &&
            (current.state.status === "running" || current.state.status === "blocked")
          ) {
            runPausedMirror.add(id);
            await patchJob(id, (j) =>
              j.state.status === "running" || j.state.status === "blocked"
                ? { ...j, state: { ...j.state, status: "paused" } }
                : j,
            );
          }
          return; // HOLD — resumeRun / terminal re-drives this watcher
        }
        if (!TERMINAL.has(run.status)) {
          // The run left a mirrored pause (user resumed the pass) — give the
          // loom its Running cue back. Loom-level pauses (not in the mirror
          // set) are untouched.
          if (runPausedMirror.has(id)) {
            runPausedMirror.delete(id);
            const mirrored = await getJob(id);
            if (mirrored?.state.status === "paused") {
              await patchJob(id, (j) =>
                j.state.status === "paused" ? { ...j, state: { ...j.state, status: "running" } } : j,
              );
              void emitIteration(id, mirrored.state.iteration, runId, "running");
            }
          }
          // The run LEFT "blocked" (user answered / resumeRun) but is still
          // non-terminal — clear the stale blocked cue so the Hub stops showing
          // the danger dot / "needs you" / red badge while the loom progresses.
          const current = await getJob(id);
          if (current?.state.status === "blocked") {
            await patchJob(id, (j) => ({ ...j, state: { ...j.state, status: "running" } }));
            void emitIteration(id, current.state.iteration, runId, "running");
          }
          // FIX 6: arm the watchdog for waves PAST layer 0. finalizeDirectRun
          // launches the next wave's attempts without re-arming; this watcher
          // fires on every run event, so re-arming here gives each fresh attempt
          // a wall-clock ceiling. armWatchdog is idempotent (skips attempts
          // already timed) and skips blocked runs; fireWatchdog re-verifies
          // ownership + attempt liveness, so re-arming per event is safe. A
          // single-node pass never reaches this branch with a NEW attempt
          // (invariant 1: one attempt, armed at launch), so it is inert there.
          armWatchdog(id, runId, current?.worker?.timeoutMinutes);
          return; // running / planning / paused → hold
        }
        unsub();
        watchedRuns.delete(runId);
        const runner = loops.get(id);
        if (runner) runner.unsubscribe = undefined;
        await onTerminal(id, run);
      })();
    });
    const runner = runnerFor(id);
    runner.unsubscribe = unsub;
  })();
}

// WorkerAttempt terminal statuses (mirrors run-store's DIRECT_ATTEMPT_TERMINAL,
// which is module-private there).
const ATTEMPT_TERMINAL = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

// `${runId}:${nodeId}` keys with an answer-resume in flight. addDirectIteration's
// own race guard is attempt-based, and between the answer landing and the new
// attempt existing a second event could double-launch — this closes that window.
// Slice 7: keyed per NODE (not just per run) so two distinct blocked nodes can
// resume independently across successive finalizes without one's in-flight guard
// suppressing the other. Single-node uses the node id "w0" (or the run's sole
// stamped node), so its guard is exactly per-run as before.
const answerResumes = new Set<string>();

// The agent-loop continuation instructions appended to every agent-driven
// pass's prompt (and to answer-resume continuations). A handoff is honored even
// on a pinned engine ("auto" no longer exists), but ONLY on the job-level
// worker (degenerate single-node passes + answer resumes) — resolveWorker never
// consumes a handoff for a graph entry node's own worker, so steerable=false
// there keeps the prompt honest.
function agentLoopFooter(job: ScheduledJob, steerable = true): string {
  if (job.loop.kind !== "agent") return "";
  const handoffNote = steerable
    ? ` You may also pass nextEngine ("claude"|"codex"), nextModel, and nextEffort to spark_request_next_iteration to pick the next pass's worker; only installed engines are honored.`
    : "";
  return `\n\n---\nThis is an automation loop. When you finish this pass, decide whether to continue: call the spark_request_next_iteration tool (done=false to run another iteration, done=true to stop), or end your final summary with ${SPARK_LOOP_CONTINUE} or ${SPARK_LOOP_DONE} on its own last line.${handoffNote} If you give no signal the loop stops. Your safety caps always stop it regardless.`;
}

// The newest spark "question" message a given blocked NODE left, plus the
// newest user answer that postdates it. A multi-node wave can block several
// nodes, each leaving a loomNodeId-stamped question (finalizeDirectRun pushes
// the per-node note in the commit that flips the node "blocked"). For a node id
// of `undefined` (pre-graph single-node run) we match ANY unstamped question —
// today's run-level scan, byte-identical. Returns undefined when the node has no
// question, or no newer user answer for it yet.
function answerForBlockedNode(
  run: RunState,
  nodeId: string | undefined,
): { question: string; answer: string } | undefined {
  const matchesNode = (msgNode: string | undefined): boolean =>
    nodeId === undefined ? true : msgNode === nodeId;
  let question: { message: string; createdAt: string } | undefined;
  for (let i = run.humanMessages.length - 1; i >= 0; i -= 1) {
    const m = run.humanMessages[i];
    if (m.author === "spark" && m.kind === "question" && matchesNode(m.loomNodeId)) {
      question = m;
      break;
    }
  }
  if (!question) return undefined;
  // The answer is a user note/answer that postdates the question. Answers are
  // not node-stamped (the Hub records a plain user note), so we match the
  // newest user message after THIS node's question. With serial per-node
  // resumption the next finalize re-enters for the next blocked node, whose
  // (older) question then pairs with its own later answer.
  let answer: string | undefined;
  for (let i = run.humanMessages.length - 1; i >= 0; i -= 1) {
    const m = run.humanMessages[i];
    if (m.author === "user" && m.createdAt > question.createdAt && m.message.trim()) {
      answer = m.message;
      break;
    }
  }
  if (!answer) return undefined;
  return { question: question.message, answer };
}

// The blocked NODES of a pass: nodes recorded "blocked" in loomPass.nodeStates
// whose newest attempt is terminal (a worker that EXITED declaring blocked, vs a
// LIVE ask_user attempt the long-poll still owns). For a pre-graph run (no
// loomPass) there is no node graph — return a single `undefined` sentinel so the
// caller runs today's run-level scan (newest attempt terminal already checked by
// the caller). Returned in nodeStates iteration order (deterministic for the
// "resume the first matchable, the rest on later finalizes" rule).
async function blockedNodesOf(run: RunState): Promise<Array<string | undefined>> {
  const pass = run.loomPass;
  if (!pass) return [undefined];
  const { newestAttemptForNode } = await import("./run-store");
  const nodes: string[] = [];
  for (const [nodeId, ns] of Object.entries(pass.nodeStates)) {
    if (ns.status !== "blocked") continue;
    const att = newestAttemptForNode(run, nodeId);
    if (att && ATTEMPT_TERMINAL.has(att.status)) nodes.push(nodeId);
  }
  return nodes;
}

// Resume a report-blocked pass once the user answers. A worker that EXITED
// declaring itself blocked (final-report status "blocked") left its question as
// a spark message with no live spark_ask_user poll to consume the reply —
// answering through the Hub only records a user note. When that note postdates
// the blocking question, chain a continuation attempt into the SAME run (this is
// a resumption of the pass, not a new iteration: the job's iteration count and
// history record carry across; onTerminal settles them when the resumed attempt
// finishes). The live-ask flavor (an attempt still active) is deliberately
// skipped — the long-poll owns that answer.
//
// Slice 7: a multi-node pass can block SEVERAL nodes at once, each with its own
// loomNodeId-stamped question. We resume the FIRST node whose answer has landed,
// chaining a continuation for THAT node (loomNodeId carried so the resumed
// attempt re-joins the node's lineage). The remaining blocked nodes are resumed
// on subsequent finalizes (this is re-entered each time the run re-enters
// blocked). The `answerResumes` guard is keyed `${runId}:${nodeId}` so two
// distinct nodes never block each other's resume. Single-node reduces to today:
// one blocked node (or the pre-graph run-level scan), one continuation, no
// iteration increment.
async function maybeResumeAnsweredPass(id: string, run: RunState): Promise<void> {
  if (run.status !== "blocked" || run.executionMode !== "direct") return;
  // A LIVE attempt means an ask_user long-poll is in flight — that flavor is
  // owned by agent-socket, not this seam. (For a multi-node wave only the
  // report-blocked nodes — whose newest attempt is terminal — are resumable
  // here; blockedNodesOf re-checks per node.)
  const newest = run.workerAttempts.at(-1);
  if (!newest || !ATTEMPT_TERMINAL.has(newest.status)) return;

  const candidates = await blockedNodesOf(run);
  for (const nodeId of candidates) {
    const matched = answerForBlockedNode(run, nodeId);
    if (!matched) continue;

    const key = `${run.id}:${nodeId ?? "*"}`;
    if (answerResumes.has(key)) continue;
    answerResumes.add(key);
    try {
      const job = await getJob(id);
      if (!job || job.state.status === "paused" || job.state.status === "stopped") return;
      if (job.state.currentRunId !== run.id) return;
      const resolved = await resolveWorker(job);
      if (!resolved.ok) return; // no engine to resume with; the loom stays answerable

      const prompt =
        `The previous worker on this pass stopped because it needed input:\n\n${matched.question}\n\n` +
        `The user answered:\n\n${matched.answer}\n\nContinue the pass using this answer.` +
        agentLoopFooter(job);
      const { addDirectIteration } = await import("./run-store");
      await addDirectIteration({
        runId: run.id,
        clientMessageId: `loop-${id}-answer-${nodeId ?? "w"}-${run.workerAttempts.length}`,
        prompt,
        engine: resolved.engine,
        model: resolved.model,
        effort: resolved.effort,
        loomNodeId: nodeId,
      });
      armWatchdog(id, run.id, job.worker.timeoutMinutes);
      void emitIteration(id, Math.max(0, job.state.iteration - 1), run.id, "running");
    } catch (err) {
      console.error(`[automation-loop] answer-resume ${id} failed:`, err);
    } finally {
      answerResumes.delete(key);
    }
    // Resume ONE node per call; the next finalize re-enters for the rest.
    return;
  }
}

async function onTerminal(id: string, run: RunState): Promise<void> {
  clearWatchdog(id);
  const job = await getJob(id);
  if (!job) return;

  const passIter = Math.max(0, job.state.iteration - 1);
  // Composite key: iteration alone collides across loop cycles ("Run now" /
  // trigger re-fires reset the counter while history is retained), which
  // would feed the PREVIOUS cycle's summary to untilPhrase/{{lastOutput}} and
  // skip the new pass's cost accounting (dead budget cap).
  const prevRec = job.history.find((r) => r.runId === run.id && r.iteration === passIter);
  const summary = prevRec?.summary ?? lastSparkSummary(run);
  // Idempotent: onTerminal can be re-entered for the SAME terminal run (e.g.
  // resumeLoop re-deciding a pass that finished while paused). Only do the
  // cost accounting + history finalize ONCE, keyed on the record's finishedAt,
  // so the budget tally is never double-counted on re-entry.
  let spentUsd = job.state.spentUsd ?? 0;
  if (!prevRec?.finishedAt) {
    const runCost = (run.totalCostUsd ?? 0) + (run.estimatedWorkerCostUsd ?? 0);
    // Same-run loops accumulate cost on ONE run (cumulative); isolate loops sum
    // per-run costs. Either way spentUsd ends up the true running total.
    const passCost = job.loop.isolate ? runCost : Math.max(0, runCost - spentUsd);
    spentUsd = job.loop.isolate ? spentUsd + runCost : runCost;
    await appendHistory(
      id,
      {
        iteration: passIter,
        runId: run.id,
        startedAt: prevRec?.startedAt ?? nowIso(),
        finishedAt: nowIso(),
        status: run.status,
        summary,
        costUsd: passCost,
        continuationSource: prevRec?.continuationSource,
      },
      { spentUsd },
    );
  }

  // Paused mid-flight: record the finish but do not advance.
  if (job.state.status === "paused") return;

  // A failed / cancelled iteration ends the loop (continue-on-failure is not v1).
  if (run.status !== "complete") {
    await finalize(id, "iteration-failed");
    return;
  }

  const fresh = (await getJob(id)) ?? job;
  const stop = fresh.loop.stop;

  // Hard caps re-checked with fresh spend.
  if (typeof stop.budgetUsd === "number" && spentUsd >= stop.budgetUsd) {
    await finalize(id, "budget");
    return;
  }
  if (fresh.state.iteration >= hardCap(fresh)) {
    await finalize(id, fresh.loop.kind === "once" ? "once" : "max-iterations");
    return;
  }

  // User-written until-predicates apply to ANY loop kind that sets them.
  const cwd = fresh.input.cwd;
  if (stop.untilPhrase && summary && summary.toLowerCase().includes(stop.untilPhrase.toLowerCase())) {
    await finalize(id, "phrase");
    return;
  }
  if (stop.untilTestsPass && (await runShellCheck(cwd, stop.testCommand || "npm test"))) {
    await finalize(id, "tests-pass");
    return;
  }
  if (stop.untilGitClean && (await gitClean(cwd))) {
    await finalize(id, "git-clean");
    return;
  }
  if (stop.untilCommand && (await runShellCheck(cwd, stop.untilCommand))) {
    await finalize(id, "until-command");
    return;
  }

  // Decide continuation by loop kind.
  switch (fresh.loop.kind) {
    case "once":
      await finalize(id, "once");
      return;
    case "count": {
      const target = stop.maxIterations ?? 1;
      if (fresh.state.iteration >= target) await finalize(id, "max-iterations");
      else await startIteration(id, { source: "count" });
      return;
    }
    case "until":
      await startIteration(id, { source: "until" });
      return;
    case "continuous":
      await startIteration(id, { source: "continuous" });
      return;
    case "cadence": {
      const everyMs = Math.max(1000, Math.floor(fresh.loop.everyMs ?? 60_000));
      const nextFireAt = new Date(Date.now() + everyMs).toISOString();
      await patchJob(id, (j) => ({ ...j, state: { ...j.state, status: "idle", nextFireAt } }));
      scheduleCadence(id, everyMs);
      return;
    }
    case "agent": {
      const sig = await readAgentSignal(fresh, run, summary);
      if (sig.continue) {
        // Record a worker handoff for the next pass regardless of the pinned
        // engine — "auto" no longer exists, so a handoff steers the next pass's
        // engine/model/effort directly (the socket already validated the fields
        // against installed runtimes). Effort-only steering (no nextEngine) is a
        // valid handoff too. resolveWorker consumes it on the job-level worker.
        const wantsHandoff = Boolean(sig.nextEngine || sig.nextModel || sig.nextEffort);
        const handoff = wantsHandoff
          ? { engine: sig.nextEngine, model: sig.nextModel, effort: sig.nextEffort }
          : undefined;
        await patchJob(id, (j) => ({
          ...j,
          state: {
            ...j.state,
            pendingNextPrompt: sig.prompt,
            pendingNextWorker: handoff,
            pendingAgentSignal: undefined,
          },
        }));
        await startIteration(id, { source: "agent" });
      } else {
        await finalize(id, sig.reason);
      }
      return;
    }
  }
}

function scheduleCadence(id: string, delayMs: number): void {
  const runner = runnerFor(id);
  if (runner.cadenceTimer) clearTimeout(runner.cadenceTimer);
  runner.cadenceTimer = setTimeout(() => {
    runner.cadenceTimer = undefined;
    void startIteration(id, { source: "cadence" });
  }, delayMs);
}

async function readAgentSignal(
  job: ScheduledJob,
  run: RunState,
  summary: string | undefined,
): Promise<AgentLoopSignal & { reason: AutomationStopReason }> {
  // 1) Structured intent from the spark_request_next_iteration MCP tool —
  //    in-memory first, then the persisted mirror (survives a restart that
  //    landed between worker-finish and this decision). Consumed once.
  //    Slice 7: in a multi-node wave several workers may have signalled; the
  //    pass-level decision is the SINK node's (the terminal worker — a node with
  //    no forward-live successor). We read the first sink with a stored signal,
  //    then fall back to the unstamped "" slot (a single-node / pre-graph worker
  //    sends no node id), then the persisted mirror. The whole per-run map is
  //    cleared once consumed so a non-sink worker's vote can't leak to a later
  //    pass. For a single-node loom the sink IS its sole node and its signal is
  //    stored under "" — so this reduces to the legacy single-slot read.
  const byNode = agentSignals.get(run.id);
  let structured: AgentLoopSignal | undefined;
  if (byNode) {
    for (const sinkId of sinkNodeIds(job.graph ?? FALLBACK_GRAPH)) {
      const s = byNode.get(sinkId);
      if (s) {
        structured = s;
        break;
      }
    }
    structured ??= byNode.get("");
  }
  structured ??= job.state.pendingAgentSignal;
  if (structured) {
    agentSignals.delete(run.id);
    if (job.state.pendingAgentSignal) {
      await patchJob(job.id, (j) => ({
        ...j,
        state: { ...j.state, pendingAgentSignal: undefined },
      })).catch(() => undefined);
    }
    return structured.continue
      ? { ...structured, reason: "agent-done" }
      : { continue: false, reason: "agent-done" };
  }
  // 2) Sentinel fallback — scan the TRAILING lines of the final summary. When
  //    the summary is a cleaned TUI tail, the literal last lines are often
  //    chrome (input box, token counter), so the sentinel is honored anywhere
  //    in the last dozen lines — but matched strictly (exact line, trailing
  //    punctuation tolerated, or CONTINUE:"prompt"), so the loop-instructions
  //    echo ("…end your summary with SPARK_LOOP_DONE…") can never count.
  const lines = (summary ?? "")
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 12; i -= 1) {
    const line = lines[i].replace(/[.!]+$/, "");
    if (line === SPARK_LOOP_DONE) return { continue: false, reason: "agent-done" };
    if (line === SPARK_LOOP_CONTINUE) return { continue: true, reason: "agent-done" };
    if (line.startsWith(`${SPARK_LOOP_CONTINUE}:`)) {
      const prompt = line.slice(SPARK_LOOP_CONTINUE.length + 1).trim() || undefined;
      return { continue: true, prompt, reason: "agent-done" };
    }
  }
  return { continue: false, reason: "agent-no-signal" };
}

async function finalize(
  id: string,
  reason: AutomationStopReason,
  opts?: { fireDependents?: boolean },
): Promise<void> {
  const runner = loops.get(id);
  if (runner?.cadenceTimer) clearTimeout(runner.cadenceTimer);
  if (runner) for (const timer of runner.watchdogTimers.values()) clearTimeout(timer);
  if (runner?.unsubscribe) runner.unsubscribe();
  const chain = runner?.chain ?? [id];
  loops.delete(id);
  // Drop any unconsumed per-node agent signals for the finalized run so a
  // non-sink worker's lingering vote can never leak into a later pass (runIds
  // are unique, so this only frees memory for this run's settled wave).
  const finalizedRunId = (await getJob(id))?.state.currentRunId;
  if (finalizedRunId) agentSignals.delete(finalizedRunId);

  await patchJob(id, (j) => {
    const history = [...j.history];
    if (history.length > 0) {
      const last = history[history.length - 1];
      if (!last.stopReason) history[history.length - 1] = { ...last, stopReason: reason };
    }
    return {
      ...j,
      history,
      state: {
        ...j.state,
        status: "stopped",
        lastStopReason: reason,
        currentRunId: undefined,
        nextFireAt: undefined,
        pendingNextPrompt: undefined,
        pendingNextWorker: undefined,
        pendingAgentSignal: undefined,
      },
    };
  });
  const finalJob = await getJob(id);
  void emitIteration(id, finalJob?.state.iteration ?? 0, undefined, "stopped");

  // Loop-level completion alert — once per finalize, never per iteration.
  // user-stop is skipped: the user clicked stop themselves; pinging them
  // about their own action is noise.
  if (finalJob && reason !== "user-stop") {
    const failed = reason === "iteration-failed" || reason === "engine-missing";
    const iterations = finalJob.state.iteration;
    const passes = `${iterations} iteration${iterations === 1 ? "" : "s"}`;
    publish({
      kind: failed ? "automation.failed" : "automation.finished",
      sourceKey: automationSourceKey(id),
      tone: failed ? "danger" : "success",
      title: failed ? "Automation — failed" : "Automation — finished",
      body: failed
        ? `“${finalJob.name}” stopped after ${passes} (${reason}).`
        : `“${finalJob.name}” finished after ${passes} (${reason}).`,
      soundKind: failed ? "needs-you" : "done",
      // workspaceId lets a cross-workspace notification click switch projects
      // before landing on this loom's hub/run (see notifications/routing.ts).
      target: {
        type: "automation",
        jobId: id,
        runId: finalizedRunId,
        workspaceId: finalJob.input.workspaceId,
      },
    });
  }

  // Fire onFinishOf dependents (cycle-guarded). Suppressed for delete-driven
  // stops — removing loom A must not kick off loom B.
  if (opts?.fireDependents === false) return;
  const dependents = onFinishWatchers.get(id);
  if (dependents) {
    for (const depId of dependents) {
      if (chain.includes(depId)) continue; // cycle: A->B->A
      void startIteration(depId, { source: "trigger", chain: [...chain, depId] });
    }
  }
}

// ── Bounded shell checks (never hang a loop) ─────────────────────────────────
// runShellCheck / gitClean now live in ./loom-predicates (imported above) so the
// guard-node path settles identically; the StopConditions checks call them.

async function safeGetRun(runId: string): Promise<RunState | null> {
  try {
    const { getRun } = await import("./run-store");
    return await getRun(runId);
  } catch {
    return null;
  }
}
