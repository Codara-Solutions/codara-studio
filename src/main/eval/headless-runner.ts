// Headless eval runner.
//
// Codara normally orchestrates worker subprocesses (claude / codex CLI) for
// an Electron BrowserWindow renderer that mounts a TerminalView per worker.
// In headless mode there is no renderer, so this module:
//
//   1. Loads the variant config and pins the parts that live in module state
//      (the manager prompt profile, worker-pool knobs) in memory, without
//      touching spark-settings.json.
//   2. Calls `startAutopilot()` directly — the same internal entry point the
//      renderer's start button uses via IPC, passing the variant's manager
//      backend/model/effort/mode as the run's chat* fields.
//   3. Subscribes to the main-process event bus. When the run-store emits
//      `worker_task.envelope_prepared`, we spawn a pty for the worker
//      ourselves (no renderer means nothing else will). The run-store then
//      types the launch command + prompt into that pty and waits for a
//      `final-report.json` from the worker, exactly like in interactive
//      mode.
//   4. Watches run state for terminal status (complete / failed / cancelled
//      / paused-on-question) and resolves with the final summary.
//   5. Emits one structured progress line per significant event on stderr
//      and one final summary line on stdout.
//
// This module is the entire headless surface — `src/main/index.ts` calls
// `runHeadlessEval()` once and quits the app afterwards.

import { app } from "electron";
import { promises as fs } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as pty from "../pty-manager";
import { defaultShell } from "../shells";
import { flush as flushStorage } from "../storage";
import { detectAgentRuntimes } from "../agent-runtimes";
import { startAutopilot, getRun, cancelRun, flushRunCompletionTails } from "../orchestration/run-store";
import { sanitizeWorkspace } from "../workspace-sanitize";
import { runDir } from "../orchestration/event-log";
import { subscribeToEvents } from "../orchestration/event-log";
import { loadManagerPromptProfileFromPath } from "../orchestration/prompt-profile";
import type {
  AgentEffortLevel,
  ChatBackendKind,
  ChatMode,
  RunState,
  RunStatus,
  ShellInfo,
  SparkEvent,
} from "@shared/types";
import type { HeadlessEvalArgs } from "./headless-args";

// Variant config schema mirrored loosely from evals-v2/lib/variant-config.js.
// We only consume the fields headless mode actually applies — everything
// else is ignored so a future field addition does not break interactive
// Codara.
interface VariantConfig {
  variantId?: string;
  agent?: string;
  manager?: {
    // ChatBackendKind, or the retired "openrouter" on pre-Pi configs (read as
    // "pi"). Anything unrecognized is dropped and the run takes the default.
    backend?: string;
    // Model id in the chosen backend's own naming, it is forwarded verbatim
    // as the run's chatModel, not through AppSettings.
    model?: string;
    effort?: string;
    mode?: string;
    profilePath?: string;
  };
  workerPolicy?: {
    maxParallelWorkers?: number;
  };
  pool?: Array<{ runtime?: string; model?: string; effort?: string }>;
  perRoleOverrides?: Record<string, unknown>;
}

// Final-status mapping for the JSON summary line on stdout. Matches the
// surface the eval harness expects.
type HeadlessFinalStatus = "completed" | "failed" | "timed_out";

interface HeadlessOutcome {
  runId: string;
  runDir: string;
  status: HeadlessFinalStatus;
  durationSeconds: number;
}

// Hard limits for the watcher loop — long enough for a real autopilot run
// when no `--eval-budget` was passed.
const DEFAULT_BUDGET_SECONDS = 60 * 60; // 1h
const POLL_INTERVAL_MS = 1000;

// The pty cols/rows we report for headless workers. Values match the
// interactive renderer's first-paint defaults so claude/codex's TUI uses
// the same wrap/layout it would use on the desktop.
const HEADLESS_PTY_COLS = 120;
const HEADLESS_PTY_ROWS = 32;

export async function runHeadlessEval(args: HeadlessEvalArgs): Promise<HeadlessOutcome> {
  const startedMs = Date.now();
  const planPath = resolveExistingPath(args.evalPlan);
  if (!planPath) {
    fail(2, `--eval-plan path does not exist: ${args.evalPlan}`);
  }

  const planText = readFileSync(planPath, "utf8");
  const cwd = dirname(planPath);

  let config: VariantConfig | null = null;
  if (args.evalConfig) {
    const configPath = resolveExistingPath(args.evalConfig);
    if (!configPath) {
      fail(2, `--eval-config path does not exist: ${args.evalConfig}`);
    }
    try {
      config = JSON.parse(readFileSync(configPath, "utf8")) as VariantConfig;
    } catch (err) {
      fail(2, `--eval-config is not valid JSON (${configPath}): ${(err as Error).message}`);
    }
    await applyVariantConfig(config!, configPath);
  }

  // Budget — defaults if unspecified, otherwise the operator-provided value.
  const budgetSeconds =
    typeof args.evalBudgetSeconds === "number" && args.evalBudgetSeconds > 0
      ? args.evalBudgetSeconds
      : DEFAULT_BUDGET_SECONDS;
  const budgetMs = Math.floor(budgetSeconds * 1000);

  // Start watching events BEFORE startAutopilot so we never miss the first
  // envelope_prepared.
  const stopEvents = installEventStreamer();
  const stopWorkers = installWorkerSpawnHandler(planPath);

  emitEvent("eval.headless_starting", {
    planPath,
    cwd,
    configPath: args.evalConfig ?? null,
    variantId: config?.variantId ?? null,
    budgetSeconds,
  });

  let run: RunState;
  try {
    const managerBackend = normalizeManagerBackend(config?.manager?.backend);
    const managerMode = normalizeManagerMode(config?.manager?.mode);
    const managerEffort = normalizeManagerEffort(config?.manager?.effort);
    // A config that named the retired "openrouter" API manager also carries an
    // OpenRouter catalog slug as its model, which no surviving backend
    // understands. Drop it and let the Pi backend apply its default, the same
    // migration run-store's normalizeRun performs on persisted runs.
    const managerModel =
      config?.manager?.backend === "openrouter"
        ? undefined
        : config?.manager?.model?.trim() || undefined;
    run = await startAutopilot({
      workspaceId: `eval-${makeShortId()}`,
      workspaceName: `eval-${config?.variantId ?? "spark"}`,
      cwd,
      planPath,
      planText,
      planTitle: deriveTitle(planText) || "Eval plan",
      chatBackend: managerBackend,
      chatModel: managerModel,
      chatMode: managerMode,
      chatEffort: managerEffort,
    });
  } catch (err) {
    stopEvents();
    stopWorkers();
    fail(2, `failed to start autopilot: ${(err as Error).message}`);
  }

  emitEvent("run_started", { runId: run.id, runDir: runDir(run.id) });

  // Watch run status until terminal or budget elapses. We poll on top of the
  // event subscription because completion is reflected in run.json status
  // updates (commitRunChange) which the event bus also signals — the polling
  // is just a safety net so a missed event still lets the runner exit.
  const finalStatus = await waitForTerminalStatus(run.id, budgetMs);

  // A CLI manager's codara_complete MCP call flips the run terminal slightly
  // before the provider stream returns its final usage/result frame. Give that
  // already-finished turn a short grace to settle so the mirrored run contains
  // truthful manager token telemetry and a completed SparkCall instead of
  // exiting the Electron process with the call still marked started.
  if (finalStatus.kind === "complete") {
    await waitForManagerCallSettlement(run.id, 10_000);
  }

  // If we exited because the budget elapsed (or the run paused indefinitely),
  // the run-store still thinks it is running. Mark it cancelled so run.json
  // reflects reality and any in-flight workers receive a stop signal.
  if (finalStatus.kind === "timed_out" || finalStatus.kind === "paused_blocked") {
    try {
      await cancelRun({
        runId: run.id,
        reason:
          finalStatus.kind === "timed_out"
            ? `Budget exhausted (${Math.round(budgetMs / 1000)}s)`
            : "Paused without resumption",
      });
    } catch (err) {
      emitEvent("eval.cancel_failed", {
        runId: run.id,
        error: (err as Error).message,
      });
    }
  }

  stopEvents();
  stopWorkers();

  // Sanitize the workspace BEFORE the harness captures the diff. Workers
  // sometimes leave behind compiler scratch dirs or planning markdowns the
  // diff-hygiene rule forbids; judges score those as polish/fit failures
  // even when the actual fix is correct. Conservative pattern list — only
  // names that are unambiguously scratch (`.tmp-*` dirs, two named
  // planning markdowns) — so this never destroys real work.
  try {
    const sanitized = await sanitizeWorkspace(cwd);
    if (sanitized.removed.length > 0 || sanitized.errors.length > 0) {
      emitEvent("eval.workspace_sanitized", {
        cwd,
        removed: sanitized.removed,
        errors: sanitized.errors,
      });
    }
  } catch (err) {
    emitEvent("eval.sanitize_failed", { cwd, error: (err as Error).message });
  }

  // Run completion detaches its bookkeeping tail (result manifest, summary
  // message, memory/lessons ledgers) off the critical path; the mirror below
  // must not copy the run dir before that tail lands, and process exit must
  // not kill the ledger writes mid-flight.
  await flushRunCompletionTails(run.id);

  // Persist any pending settings/state writes to disk before the process
  // exits — the run-store has its own write queues but this picks up any
  // legacy callers.
  await flushStorage();

  const finishedMs = Date.now();
  const durationSeconds = Math.round(((finishedMs - startedMs) / 1000) * 100) / 100;

  // Optional artifact mirror: if --eval-output-dir was set, copy the run dir
  // contents there. We never DELETE the canonical run dir under
  // ~/.SparkAgent/runs/<id>; we just copy out so the harness can collect
  // artifacts from a known location.
  const canonicalRunDir = runDir(run.id);
  let artifactDir = canonicalRunDir;
  if (args.evalOutputDir) {
    try {
      await fs.mkdir(args.evalOutputDir, { recursive: true });
      await copyDir(canonicalRunDir, args.evalOutputDir);
      artifactDir = args.evalOutputDir;
    } catch (err) {
      emitEvent("eval.artifact_mirror_failed", {
        canonicalRunDir,
        evalOutputDir: args.evalOutputDir,
        error: (err as Error).message,
      });
    }
  }

  let outcomeStatus: HeadlessFinalStatus;
  switch (finalStatus.kind) {
    case "complete":
      outcomeStatus = "completed";
      break;
    case "failed":
      outcomeStatus = "failed";
      break;
    case "cancelled":
      outcomeStatus = "failed";
      break;
    case "timed_out":
      outcomeStatus = "timed_out";
      break;
    case "paused_blocked":
      // A run that paused on a manager question / human checkpoint and never
      // resumed is a failure for the eval harness — there is no operator to
      // answer it. Treat as failed.
      outcomeStatus = "failed";
      break;
  }

  const outcome: HeadlessOutcome = {
    runId: run.id,
    runDir: artifactDir,
    status: outcomeStatus,
    durationSeconds,
  };
  emitEvent("run_completed", { ...outcome, terminalStatus: finalStatus.kind });
  return outcome;
}

// Map RunStatus to a coarse outcome plus a short reason string. The watcher
// resolves once status enters a terminal state; we treat a paused/blocked run
// that has been stuck for `pausedGraceMs` as failed because the headless
// harness has no operator to answer questions.
type TerminalKind = "complete" | "failed" | "cancelled" | "timed_out" | "paused_blocked";
const PAUSED_GRACE_MS = 60_000;

async function waitForManagerCallSettlement(runId: string, graceMs: number): Promise<void> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const snapshot = await getRun(runId);
    if (!snapshot) return;
    const hasActiveCall = snapshot.sparkCalls.some(
      (call) => call.status === "started" && !call.completedAt,
    );
    if (!hasActiveCall) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  emitEvent("eval.manager_settlement_timeout", { runId, graceMs });
}

async function waitForTerminalStatus(
  runId: string,
  budgetMs: number,
): Promise<{ kind: TerminalKind; status: RunStatus }> {
  const start = Date.now();
  let firstPausedAt: number | null = null;
  let lastSnapshot: RunStatus | undefined;

  while (Date.now() - start < budgetMs) {
    const snapshot = await getRun(runId);
    if (!snapshot) {
      // Should never happen — the run was just created. Bail out.
      return { kind: "failed", status: "failed" };
    }
    if (snapshot.status !== lastSnapshot) {
      emitEvent("run_status", { runId, status: snapshot.status });
      lastSnapshot = snapshot.status;
    }
    if (snapshot.status === "complete") return { kind: "complete", status: snapshot.status };
    if (snapshot.status === "failed") return { kind: "failed", status: snapshot.status };
    if (snapshot.status === "cancelled") return { kind: "cancelled", status: snapshot.status };

    if (snapshot.status === "paused" || snapshot.status === "blocked") {
      firstPausedAt ??= Date.now();
      if (Date.now() - firstPausedAt >= PAUSED_GRACE_MS) {
        emitEvent("run_paused_unresolved", {
          runId,
          status: snapshot.status,
          stopReason: snapshot.autopilot?.stopReason,
        });
        return { kind: "paused_blocked", status: snapshot.status };
      }
    } else {
      firstPausedAt = null;
    }

    await delay(POLL_INTERVAL_MS);
  }

  emitEvent("run_budget_exhausted", { runId, budgetMs });
  return { kind: "timed_out", status: lastSnapshot ?? "running" };
}

// Install a streamer that writes one JSON line to stderr per orchestration
// event. The event payload is the entire SparkEvent object so a downstream
// adapter has the full envelope (run id, step id, attempt id, payload).
function installEventStreamer(): () => void {
  const unsubscribe = subscribeToEvents((event: SparkEvent) => {
    // Re-emit a small subset of high-signal types as our own structured
    // events so the adapter can advance progress without parsing every Codara
    // internal event.
    if (event.type === "worker_task.envelope_prepared") {
      emitEvent("worker_envelope_prepared", {
        runId: event.runId,
        workerTaskId: event.workerTaskId,
        attemptId: event.attemptId,
      });
    } else if (event.type === "worker_attempt.finished") {
      emitEvent("worker_completed", {
        runId: event.runId,
        attemptId: event.attemptId,
        exitCode: (event.payload as Record<string, unknown> | undefined)?.exitCode,
      });
    } else if (event.type === "step.updated") {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (payload.status === "complete") {
        emitEvent("step_completed", {
          runId: event.runId,
          stepId: event.stepId,
        });
      }
    } else if (event.type === "spark_call.failed") {
      emitEvent("manager_call_failed", {
        runId: event.runId,
        sparkCallId: event.sparkCallId,
        error: (event.payload as Record<string, unknown> | undefined)?.error,
      });
    }
    // Mirror everything for full debuggability — the structured wrapper is
    // small and the adapter is free to ignore types it does not understand.
    emitEvent("spark_event", { type: event.type, runId: event.runId, message: event.message });
  });
  return unsubscribe;
}

// Worker pty bootstrapper. In interactive mode the renderer reacts to
// `worker_task.envelope_prepared` by adding a TerminalView pane, which calls
// pty:spawn over IPC. In headless mode we substitute that with a direct
// pty.spawn (and resize) call so `pty.waitForSpawn` inside runWorkerSession
// resolves and the run-store can drive the launch + paste phases.
function installWorkerSpawnHandler(_planPath: string): () => void {
  let cachedShell: ShellInfo | null = null;
  const ensureShell = async (): Promise<ShellInfo> => {
    if (cachedShell) return cachedShell;
    const detected = await defaultShell();
    if (!detected) {
      throw new Error("No default shell detected — headless eval cannot launch workers.");
    }
    cachedShell = detected;
    return detected;
  };

  const unsubscribe = subscribeToEvents((event: SparkEvent) => {
    if (event.type !== "worker_task.envelope_prepared") return;
    if (!event.attemptId || !event.runId) return;

    const attemptId = event.attemptId;
    const runId = event.runId;
    void (async () => {
      try {
        const run = await getRun(runId);
        const attempt = run?.workerAttempts.find((item) => item.id === attemptId);
        if (!attempt) {
          emitEvent("eval.worker_pty_skip_no_attempt", { runId, attemptId });
          return;
        }
        const shell = await ensureShell();
        // Headless eval: pass null webContents so pty-manager skips the
        // renderer fan-out. The run-store waits for waitForSpawn() to
        // resolve and uses pty.write + pty.tap from main-process land.
        pty.spawn({
          id: attemptId,
          shell,
          cwd: attempt.cwd,
          cols: HEADLESS_PTY_COLS,
          rows: HEADLESS_PTY_ROWS,
          webContents: null,
        });
        // Mirror what the renderer's TerminalView does on first paint so
        // pty.waitForResize() resolves and run-store types into a shell that
        // already knows its real width.
        pty.resize(attemptId, HEADLESS_PTY_COLS, HEADLESS_PTY_ROWS);
        emitEvent("eval.worker_pty_spawned", { runId, attemptId, cwd: attempt.cwd });
      } catch (err) {
        emitEvent("eval.worker_pty_failed", {
          runId,
          attemptId,
          error: (err as Error).message,
        });
      }
    })();
  });
  return unsubscribe;
}

// Apply variant config overrides to in-memory caches. Persists nothing to
// disk; affects only the running process. Returns nothing — the caches are
// shared module state already inspected by orchestration call paths.
async function applyVariantConfig(config: VariantConfig, configPath: string): Promise<void> {
  // NOTE: `manager.backend` / `manager.model` / `manager.effort` / `manager.mode`
  // are NOT applied here. They ride on the startAutopilot() call as
  // chatBackend/chatModel/chatEffort/chatMode, which is the only channel the
  // manager reads. (They used to be mirrored into AppSettings.openRouterModel
  // back when the manager could be routed through the OpenRouter API; that
  // setting now only feeds the editor's inline AI, so writing it here would
  // change nothing about the run.)

  // Manager profile path. The variant config records a path relative to
  // the repo root (the JSON lives under evals-v2/configs/, the profile lives
  // under resources/orchestration/). We try multiple resolution roots so
  // both relative and absolute forms work: an absolute path wins; otherwise
  // we try the nearest .git ancestor of the config file (the repo root),
  // then the config dir itself, then process.cwd(). The first existing file
  // wins. We pin the loaded profile in the prompt-profile cache so all
  // subsequent loadManagerPromptProfile() calls see it without disk reads.
  const profileRel = config.manager?.profilePath?.trim();
  if (profileRel) {
    const repoRoot = findRepoRoot(dirname(configPath));
    const candidates: string[] = [];
    if (isAbsolute(profileRel)) {
      candidates.push(profileRel);
    } else {
      if (repoRoot) candidates.push(resolve(repoRoot, profileRel));
      candidates.push(resolve(dirname(configPath), profileRel));
      candidates.push(resolve(process.cwd(), profileRel));
    }
    let loaded = false;
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const profile = loadManagerPromptProfileFromPath(candidate);
        if (profile) {
          loaded = true;
          emitEvent("eval.manager_profile_loaded", { path: candidate });
          break;
        }
      }
    }
    if (!loaded) {
      emitEvent("eval.manager_profile_missing", {
        requested: profileRel,
        candidates,
      });
    }
  }

  const maxParallelWorkers = config.workerPolicy?.maxParallelWorkers;
  if (typeof maxParallelWorkers === "number" && Number.isFinite(maxParallelWorkers) && maxParallelWorkers > 0) {
    process.env.SPARK_EVAL_MAX_PARALLEL_WORKERS = String(Math.floor(maxParallelWorkers));
    emitEvent("eval.max_parallel_workers_pinned", {
      maxParallelWorkers: Math.floor(maxParallelWorkers),
    });
  }

  // Pool + perRoleOverrides aren't enforced inside Codara today: the manager
  // emits worker assignments via runtimePreference + modelHint, which the
  // CLIs honor directly. We pre-warm runtime detection so plan_analysis sees
  // an accurate INSTALLED list and the manager picks workers from the pool's
  // runtimes by capability rather than guessing.
  await detectAgentRuntimes(true).catch(() => undefined);
}

// Undefined means "let startAutopilot pick", which is the Pi backend. A
// pre-Pi variant config that still names the retired "openrouter" API manager
// is migrated to "pi" rather than rejected, matching how persisted runs read a
// legacy chatBackend, so an old config still produces a usable run.
function normalizeManagerBackend(value: string | undefined): ChatBackendKind | undefined {
  if (value === "openrouter") return "pi";
  return value === "claude" || value === "codex" || value === "pi" ? value : undefined;
}

// Auto is the only manager persona an eval run can select; a variant config
// still naming a retired mode falls through to the same default rather than
// stamping a chatMode the dispatcher would ignore.
function normalizeManagerMode(value: string | undefined): ChatMode | undefined {
  return value === "auto" ? value : undefined;
}

function normalizeManagerEffort(value: string | undefined): AgentEffortLevel | undefined {
  return value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : undefined;
}

function deriveTitle(planText: string): string {
  // First markdown H1 makes a good title; fall back to the first non-blank
  // line. Keeps the run row in ~/.SparkAgent/runs human-readable.
  const lines = planText.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# ")) return line.slice(2).trim();
    return line.slice(0, 80);
  }
  return "";
}

function resolveExistingPath(input: string): string | null {
  const abs = isAbsolute(input) ? input : resolve(process.cwd(), input);
  return existsSync(abs) ? abs : null;
}

// Walk up from `start` looking for a `.git` directory (or file — submodules
// store .git as a gitfile). Used to anchor variant-config relative paths
// like "resources/orchestration/manager-profile.json" against the original
// Codara repo root rather than the seed repo's cwd. Returns null when no
// repo root is found within a reasonable depth.
function findRepoRoot(start: string): string | null {
  let cur = start;
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function makeShortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

// Emit a structured event line on stderr so the calling adapter can stream
// progress without poisoning the JSON summary on stdout. Each line is a
// single JSON object with an ISO timestamp.
function emitEvent(type: string, payload: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
  process.stderr.write(`${line}\n`);
}

export function emitFinalSummary(outcome: HeadlessOutcome): void {
  // One JSON line on stdout — what the harness reads back. Stderr already
  // received the same data in `run_completed`; this is the canonical
  // machine-readable summary.
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

export function exitCodeFor(outcome: HeadlessOutcome): number {
  if (outcome.status === "completed") return 0;
  if (outcome.status === "timed_out") return 124;
  return 1;
}

// Surfaced separately so index.ts doesn't have to know the headless exit
// codes, adapter errors are exit 2 (config parsing, missing file, a manager
// backend that won't start). Logs to stderr, never to stdout (we don't want
// the harness to confuse a bare error message for the JSON summary line).
export function fail(code: number, reason: string): never {
  emitEvent("eval.fatal", { code, reason });
  process.stderr.write(`spark headless eval: ${reason}\n`);
  process.exitCode = code;
  // Force exit even when there are pending timers/handles.
  app.exit(code);
  // app.exit returns void — assert never for the type system.
  throw new Error(`headless eval failed: ${reason}`);
}
