// Binds the workflow runtime to Cora's runs. It starts a workflow run (a
// direct run with a `workflow` block), snapshots the script and args into the
// run folder, runs the script with every agent() call executed as an ordinary
// worker task through run-store, journals each result, and owns Stop, Resume,
// Cancel and Delete for those runs. Boot recovery parks interrupted runs and
// starts nothing: Resume is always the user's action.
//
// run-store is reached through the injected environment (lazily imported by
// default, like automation-loop), so the suite drives the driver against a
// stub store without Electron.

import { existsSync, mkdirSync, readFileSync, writeFileSync, promises as fs } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";

import { contextWindowForModel } from "@shared/context-window";
import { DEFAULT_LOOM_WORKER_MODEL } from "@shared/model-catalog";
import type { AgentEffortLevel, RunState } from "@shared/types";
import {
  WORKFLOW_DEFAULTS,
  clampWorkflowCaps,
  type SavedWorkflow,
  type SavedWorkflowSummary,
  type StartWorkflowRunInput,
  type WorkflowCallMarker,
  type WorkflowCaps,
  type WorkflowCheckResult,
  type WorkflowMeta,
  type WorkflowRef,
  type WorkflowRunInfo,
  type WorkflowRunStatus,
} from "@shared/workflow";

import { resolveBundledResourcePath } from "../bundled-resources";
import { codaraHome } from "../codara-home";
import { runDir } from "./event-log";
import type * as RunStoreModule from "./run-store";
import { WorkflowAdmission, type MemorySample } from "./workflow-admission";
import { estimateWorkflow } from "./workflow-estimate";
import {
  JournalWriter,
  canonicalJson,
  journalFileName,
  latestReplaySource,
  listJournalGenerations,
  readJournal,
  sha256,
  type JournalEntry,
  type JournalUsage,
  type JournalWorktree,
} from "./workflow-journal";
import { WorkflowSourceError, parseWorkflowSource } from "./workflow-meta";
import {
  deleteWorkflowFile,
  getSavedWorkflow,
  listSavedWorkflows,
  nestedWorkflowScripts,
  saveWorkflowFile,
  type WorkflowRegistryDirs,
} from "./workflow-registry";
import {
  WorkflowRuntime,
  type WorkflowAgentControl,
  type WorkflowAgentOutcome,
  type WorkflowAgentRequest,
  type WorkflowRuntimeOutcome,
} from "./workflow-runtime";
import type { WorkflowSandbox, WorkflowSandboxOptions } from "./workflow-sandbox";
import { validateWorkflowResult } from "./workflow-schema";
import {
  cleanupWorkflowBranches,
  createWorkflowWorktree,
  finishWorkflowWorktree,
  removeWorkflowWorktrees,
  workflowBaseCommit,
  type WorkflowWorktree,
} from "./workflow-worktree";

export type WorkflowStore = Pick<
  typeof RunStoreModule,
  | "createWorkflowRun"
  | "saveWorkflowRunInfo"
  | "launchWorkflowAgentTask"
  | "stopWorkerAttempt"
  | "interruptWorkflowAttempts"
  | "getRun"
  | "listRuns"
  | "setWorkflowRunControls"
  | "setWorkflowHeavyBinDir"
>;

export interface WorkflowModelPolicy {
  defaultModel: string;
  defaultEffort: AgentEffortLevel;
  /** Null when the model may be used, otherwise why not. */
  check(model: string): string | null;
  connected(model: string): boolean;
}

export interface WorkflowDriverEnv {
  store(): Promise<WorkflowStore>;
  runDir(runId: string): string;
  registryDirs(): WorkflowRegistryDirs;
  worktreeRoot(runId: string): string;
  models(): Promise<WorkflowModelPolicy>;
  sampleMemory?: () => MemorySample | null;
  startSandbox?: (options: WorkflowSandboxOptions) => WorkflowSandbox;
  progressIntervalMs?: number;
  /** Folder holding `codara-heavy`, put first on every workflow agent's PATH. */
  heavyBinDir?: () => string | null;
}

const RESTART_MESSAGE = "Interrupted by an app restart. Resume to continue; finished agents will not run again.";
const PREVIEW_CHARS = 400;

let env: WorkflowDriverEnv | null = null;

export function configureWorkflowDriver(next: WorkflowDriverEnv | null): void {
  env = next;
  admission?.dispose();
  admission = null;
}

function driverEnv(): WorkflowDriverEnv {
  env ??= defaultEnv();
  return env;
}

// ── Machine-wide admission ─────────────────────────────────────────────────

let admission: WorkflowAdmission | null = null;

function sharedAdmission(): WorkflowAdmission {
  admission ??= new WorkflowAdmission({
    machineSlots: WORKFLOW_DEFAULTS.machineSlots,
    heavySlots: WORKFLOW_DEFAULTS.heavySlots,
    sampleMemory: driverEnv().sampleMemory ?? sampleSystemMemory,
  });
  return admission;
}

function sampleSystemMemory(): MemorySample | null {
  try {
    if (process.platform === "linux") {
      const text = readFileSync("/proc/meminfo", "utf8");
      const field = (name: string): number | null => {
        const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, "m").exec(text);
        return match ? Number(match[1]) * 1024 : null;
      };
      const total = field("MemTotal");
      const available = field("MemAvailable");
      if (total === null || available === null) return null;
      const swapTotal = field("SwapTotal") ?? 0;
      const swapFree = field("SwapFree") ?? 0;
      return { totalBytes: total, availableBytes: available, swapUsedBytes: Math.max(0, swapTotal - swapFree) };
    }
    return { totalBytes: os.totalmem(), availableBytes: os.freemem(), swapUsedBytes: 0 };
  } catch {
    return null;
  }
}

// ── Live runs ──────────────────────────────────────────────────────────────

interface ActiveRun {
  runId: string;
  runtime: WorkflowRuntime | null;
  endReason: "stop" | "cancel" | "discard" | null;
  endMessage?: string;
  finished: Promise<void>;
}

const activeRuns = new Map<string, ActiveRun>();

export function isWorkflowRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

export function activeWorkflowRunIds(): string[] {
  return [...activeRuns.keys()];
}

function workflowDir(runId: string): string {
  return join(driverEnv().runDir(runId), "workflow");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

function preview(value: unknown): string {
  try {
    return oneLine(typeof value === "string" ? value : JSON.stringify(value ?? null), PREVIEW_CHARS);
  } catch {
    return "(unserializable)";
  }
}

// ── Sources ────────────────────────────────────────────────────────────────

interface ResolvedSource {
  ref: WorkflowRef;
  text: string;
  meta: WorkflowMeta;
  body: string;
}

async function resolveSource(input: { workflow?: string; source?: string; cwd?: string }): Promise<ResolvedSource> {
  if (typeof input.source === "string" && input.source.trim()) {
    const parsed = parseWorkflowSource(input.source);
    return { ref: { source: "inline", name: parsed.meta.name }, text: input.source, ...parsed };
  }
  const wanted = typeof input.workflow === "string" ? input.workflow.trim() : "";
  if (!wanted) throw new Error("Pass a saved workflow name or an inline script.");
  const saved = await getSavedWorkflow(driverEnv().registryDirs(), wanted, input.cwd);
  if (!saved) throw new Error(`No saved workflow named ${wanted}.`);
  if (saved.error) throw new Error(`Workflow ${saved.name} is invalid: ${saved.error}`);
  const parsed = parseWorkflowSource(saved.source_text);
  return { ref: { source: saved.source, name: saved.name, path: saved.path }, text: saved.source_text, ...parsed };
}

function checkArgs(meta: WorkflowMeta, args: unknown): string | null {
  if (!meta.args) return null;
  const checked = validateWorkflowResult(meta.args, args ?? {});
  return checked.ok ? null : `args ${checked.errors.join("; ")}`;
}

function defaultCaps(meta: WorkflowMeta): WorkflowCaps {
  return clampWorkflowCaps(
    { concurrency: meta.caps?.concurrency, maxAgents: meta.caps?.maxAgents },
    {
      concurrency: WORKFLOW_DEFAULTS.concurrency,
      maxAgents: WORKFLOW_DEFAULTS.maxAgents,
      tokenCeiling: null,
      usdCeiling: null,
    },
  );
}

async function childScripts(cwd: string | undefined, ownName: string): Promise<Record<string, { name: string; body: string }>> {
  const children = await nestedWorkflowScripts(driverEnv().registryDirs(), cwd).catch(() => ({}));
  const out: Record<string, { name: string; body: string }> = {};
  for (const [name, child] of Object.entries(children)) {
    if (name !== ownName) out[name] = child;
  }
  return out;
}

// ── Saved workflows ────────────────────────────────────────────────────────

export function listWorkflows(cwd?: string): Promise<SavedWorkflowSummary[]> {
  return listSavedWorkflows(driverEnv().registryDirs(), cwd);
}

export function getWorkflow(ref: string, cwd?: string): Promise<SavedWorkflow | null> {
  return getSavedWorkflow(driverEnv().registryDirs(), ref, cwd);
}

export function saveWorkflow(input: {
  sourceText: string;
  scope: "user" | "project";
  cwd?: string;
  overwrite?: boolean;
}): Promise<SavedWorkflowSummary> {
  return saveWorkflowFile(driverEnv().registryDirs(), input);
}

export function deleteWorkflow(ref: string, cwd?: string): Promise<boolean> {
  return deleteWorkflowFile(driverEnv().registryDirs(), ref, cwd);
}

/** Parse, args check and a dry-run estimate; never starts an agent. */
export async function checkWorkflow(input: {
  workflow?: string;
  source?: string;
  args?: unknown;
  caps?: Partial<WorkflowCaps>;
  cwd?: string;
}): Promise<WorkflowCheckResult> {
  let resolved: ResolvedSource;
  try {
    resolved = await resolveSource(input);
  } catch (err) {
    return {
      ok: false,
      errors: [{ line: err instanceof WorkflowSourceError ? err.line : undefined, message: errorMessage(err) }],
      warnings: [],
    };
  }
  const errors: Array<{ line?: number; message: string }> = [];
  const argsProblem = checkArgs(resolved.meta, input.args);
  if (argsProblem) errors.push({ message: argsProblem });
  const models = await driverEnv().models();
  const caps = clampWorkflowCaps(input.caps, defaultCaps(resolved.meta));
  const estimate = await estimateWorkflow({
    body: resolved.body,
    args: input.args ?? null,
    children: await childScripts(input.cwd, resolved.meta.name),
    caps,
    defaults: { model: models.defaultModel, effort: models.defaultEffort },
    phases: resolved.meta.phases,
    connected: (model) => models.connected(model),
    startSandbox: driverEnv().startSandbox,
  });
  if (estimate.error) errors.push({ line: lineOf(estimate.error), message: estimate.error });
  return {
    ok: errors.length === 0,
    meta: resolved.meta,
    errors,
    warnings: estimate.warnings,
    estimate,
    sourceHash: sha256(resolved.text),
  };
}

function lineOf(message: string): number | undefined {
  const match = /line (\d+)/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Start ──────────────────────────────────────────────────────────────────

export async function startWorkflowRun(input: StartWorkflowRunInput): Promise<RunState> {
  const resolved = await resolveSource({ workflow: input.workflow, source: input.source, cwd: input.cwd });
  // A saved workflow is read again here, after the user approved what the
  // check showed; anything (an agent, an editor) may have rewritten it since.
  if (input.expectedSourceHash && sha256(resolved.text) !== input.expectedSourceHash) {
    throw new Error(`Workflow ${resolved.meta.name} changed after it was checked; check it again before running it.`);
  }
  const argsProblem = checkArgs(resolved.meta, input.args);
  if (argsProblem) throw new Error(`Workflow ${resolved.meta.name}: ${argsProblem}`);
  const models = await driverEnv().models();
  const caps = clampWorkflowCaps(input.caps, defaultCaps(resolved.meta));
  const args = input.args === undefined ? null : input.args;
  const store = await driverEnv().store();
  const startedAt = new Date().toISOString();
  const info: WorkflowRunInfo = {
    ref: resolved.ref,
    name: resolved.meta.name,
    description: resolved.meta.description,
    cwd: input.cwd,
    scriptHash: sha256(resolved.body),
    argsHash: sha256(canonicalJson(args)),
    caps,
    defaults: { model: models.defaultModel, effort: models.defaultEffort },
    heavySlots: WORKFLOW_DEFAULTS.heavySlots,
    ...(input.launchedFromRunId ? { launchedFromRunId: input.launchedFromRunId } : {}),
    ...(input.seedFromRunId ? { seededFromRunId: input.seedFromRunId } : {}),
    ...(input.continueChat ? { continueChat: true } : {}),
    state: "running",
    spent: { inputTokens: 0, outputTokens: 0, usd: 0 },
    counts: { issued: 0, cached: 0, live: 0, done: 0, nulls: 0 },
    phases: resolved.meta.phases,
    startedAt,
  };
  const run = await store.createWorkflowRun({
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    cwd: input.cwd,
    title: input.title?.trim() || `Workflow: ${resolved.meta.name}`,
    workflow: info,
  });
  const dir = workflowDir(run.id);
  mkdirSync(join(dir, "results"), { recursive: true });
  writeFileSync(join(dir, "script.js"), resolved.text, "utf8");
  writeFileSync(join(dir, "args.json"), JSON.stringify(args, null, 2), "utf8");
  let replay: JournalEntry[] | undefined;
  if (input.seedFromRunId) replay = await seedFrom(input.seedFromRunId, run.id);
  launchExecution(run.id, 0, replay);
  return run;
}

// Re-running from an older run replays its journal: calls whose inputs did
// not change keep their results, so a fixed script repeats only what changed.
async function seedFrom(sourceRunId: string, runId: string): Promise<JournalEntry[] | undefined> {
  const sourceDir = workflowDir(sourceRunId);
  const source = await latestReplaySource(sourceDir);
  if (!source) return undefined;
  const results = await fs.readdir(join(sourceDir, "results")).catch(() => [] as string[]);
  for (const name of results) {
    await fs.copyFile(join(sourceDir, "results", name), join(workflowDir(runId), "results", name)).catch(() => undefined);
  }
  return source.entries;
}

function launchExecution(runId: string, generation: number, replay: JournalEntry[] | undefined): ActiveRun {
  let resolveFinished: () => void = () => undefined;
  const active: ActiveRun = {
    runId,
    runtime: null,
    endReason: null,
    finished: new Promise<void>((resolve) => {
      resolveFinished = resolve;
    }),
  };
  activeRuns.set(runId, active);
  void executeRun(active, generation, replay)
    .catch(async (err) => {
      console.warn(`[workflow] run ${runId} failed to execute:`, err);
      const store = await driverEnv().store();
      await store
        .saveWorkflowRunInfo(
          runId,
          { state: "failed", error: errorMessage(err), finishedAt: new Date().toISOString() },
          { status: "failed", event: { type: "workflow.failed", message: `Workflow failed: ${oneLine(errorMessage(err), 300)}` } },
        )
        .catch(() => undefined);
    })
    .finally(() => {
      if (activeRuns.get(runId) === active) activeRuns.delete(runId);
      resolveFinished();
    });
  return active;
}

// ── Execution ──────────────────────────────────────────────────────────────

async function executeRun(active: ActiveRun, generation: number, replay: JournalEntry[] | undefined): Promise<void> {
  const environment = driverEnv();
  const store = await environment.store();
  const runId = active.runId;
  const run = await store.getRun(runId);
  if (!run?.workflow) throw new Error(`Workflow run not found: ${runId}`);
  const info = run.workflow;
  const dir = workflowDir(runId);
  const resultsDir = join(dir, "results");
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(join(dir, "schemas"), { recursive: true });
  const source = await fs.readFile(join(dir, "script.js"), "utf8");
  const args = JSON.parse(await fs.readFile(join(dir, "args.json"), "utf8").catch(() => "null")) as unknown;
  const parsed = parseWorkflowSource(source);
  const models = await environment.models();
  const writer = new JournalWriter(join(dir, journalFileName(generation)));

  let base: Promise<string> | null = null;
  const context: AgentContext = {
    runId,
    cwd: info.cwd,
    name: info.name,
    dir,
    store,
    worktreeRoot: environment.worktreeRoot(runId),
    baseCommit: () => {
      base ??= workflowBaseCommit(info.cwd);
      return base;
    },
  };

  let saveTimer: NodeJS.Timeout | null = null;
  let saving: Promise<unknown> = Promise.resolve();
  const progress = (runtime: WorkflowRuntime): Partial<WorkflowRunInfo> => ({
    tree: runtime.snapshot(),
    counts: runtime.counts,
    spent: runtime.spent,
    ...(runtime.diverged !== null ? { divergedAtSeq: runtime.diverged } : {}),
  });
  const flushProgress = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const runtime = active.runtime;
    if (!runtime) return saving;
    const patch = progress(runtime);
    saving = saving.then(() => store.saveWorkflowRunInfo(runId, patch)).catch(() => undefined);
    return saving;
  };
  const scheduleProgress = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => void flushProgress(), environment.progressIntervalMs ?? 1_000);
  };

  const runtime = new WorkflowRuntime({
    runId,
    body: parsed.body,
    args,
    scriptHash: info.scriptHash,
    children: await childScripts(info.cwd, info.name),
    caps: info.caps,
    defaults: info.defaults,
    phases: parsed.meta.phases ?? info.phases,
    checkModel: (model) => models.check(model),
    executor: { run: (request, control) => runAgent(context, request, control) },
    admission: sharedAdmission(),
    journal: {
      append: (entry) => void writer.append(entry),
      saveResult: (seq, value) => {
        const name = `${generation}-${seq}.json`;
        writeFileSync(join(resultsDir, name), JSON.stringify(value), "utf8");
        return name;
      },
      loadResult: (ref) => JSON.parse(readFileSync(join(resultsDir, basename(ref)), "utf8")) as unknown,
    },
    replay,
    generation,
    startSandbox: environment.startSandbox,
    onChange: scheduleProgress,
  });
  active.runtime = runtime;

  let outcome: WorkflowRuntimeOutcome;
  try {
    // A Stop or Cancel that arrived while this run was still loading found no
    // runtime to stop; it must not start one now.
    outcome = active.endReason ? { status: "stopped" } : await runtime.start();
  } finally {
    await writer.close();
    await flushProgress();
  }
  await settle(active, outcome, runtime);
}

async function settle(active: ActiveRun, outcome: WorkflowRuntimeOutcome, runtime: WorkflowRuntime): Promise<void> {
  const store = await driverEnv().store();
  const runId = active.runId;
  const finishedAt = new Date().toISOString();
  const base: Partial<WorkflowRunInfo> = {
    tree: runtime.snapshot(),
    counts: runtime.counts,
    spent: runtime.spent,
  };
  if (active.endReason === "discard") return;
  if (outcome.status === "complete") {
    writeFileSync(join(workflowDir(runId), "return.json"), JSON.stringify(outcome.value ?? null, null, 2), "utf8");
    await store.saveWorkflowRunInfo(
      runId,
      { ...base, state: "complete", finishedAt, resultPreview: preview(outcome.value), error: undefined },
      {
        status: "complete",
        event: {
          type: "workflow.finished",
          message: `Workflow finished: ${runtime.counts.issued} agents`,
          payload: { counts: runtime.counts, spent: runtime.spent },
        },
      },
    );
    return;
  }
  if (outcome.status === "failed") {
    await store.saveWorkflowRunInfo(
      runId,
      { ...base, state: "failed", finishedAt, error: oneLine(outcome.error, 2_000) },
      { status: "failed", event: { type: "workflow.failed", message: `Workflow failed: ${oneLine(outcome.error, 300)}` } },
    );
    return;
  }
  if (active.endReason === "cancel") {
    await store.saveWorkflowRunInfo(
      runId,
      { ...base, state: "cancelled", finishedAt },
      { status: "cancelled", event: { type: "workflow.cancelled", message: active.endMessage ?? "Workflow cancelled" } },
    );
    return;
  }
  await store.saveWorkflowRunInfo(
    runId,
    { ...base, state: "paused" },
    { status: "paused", event: { type: "workflow.paused", message: active.endMessage ?? "Workflow stopped" } },
  );
}

// ── One agent ──────────────────────────────────────────────────────────────

interface AgentContext {
  runId: string;
  cwd: string;
  name: string;
  dir: string;
  store: WorkflowStore;
  worktreeRoot: string;
  baseCommit(): Promise<string>;
}

function compactAtTokens(request: WorkflowAgentRequest): number | undefined {
  if (request.compactAt === undefined) return undefined;
  if (request.compactAt <= 1) {
    return Math.round(contextWindowForModel(request.model).tokens * request.compactAt);
  }
  return Math.round(request.compactAt);
}

async function runAgent(
  context: AgentContext,
  request: WorkflowAgentRequest,
  control: WorkflowAgentControl,
): Promise<WorkflowAgentOutcome> {
  let worktree: WorkflowWorktree | null = null;
  if (request.isolation === "worktree") {
    const base = await context.baseCommit();
    worktree = await createWorkflowWorktree({
      repoCwd: context.cwd,
      root: context.worktreeRoot,
      runId: context.runId,
      label: request.label,
      seq: request.seq,
      base,
    });
  }
  let schemaPath: string | undefined;
  if (request.schema) {
    schemaPath = join(context.dir, "schemas", `${request.seq}.json`);
    writeFileSync(schemaPath, JSON.stringify(request.schema, null, 2), "utf8");
  }
  const call: WorkflowCallMarker = {
    key: request.key,
    seq: request.seq,
    phase: request.phase,
    ...(schemaPath ? { schemaPath } : {}),
    ...(request.heavy ? { heavy: true } : {}),
    ...(request.isolation ? { isolation: request.isolation } : {}),
    ...(request.envelope ? { envelope: true } : {}),
  };
  const compactAt = compactAtTokens(request);
  if (compactAt) call.compactAtTokens = compactAt;

  let attemptId: string | undefined;
  let timedOut = false;
  const stopAttempt = () => {
    if (attemptId) void context.store.stopWorkerAttempt(context.runId, attemptId).catch(() => undefined);
  };
  const onAbort = () => stopAttempt();
  control.signal.addEventListener("abort", onAbort, { once: true });
  const timer = request.timeoutMinutes
    ? setTimeout(() => {
        timedOut = true;
        stopAttempt();
      }, request.timeoutMinutes * 60_000)
    : null;

  let usage: JournalUsage = { in: 0, out: 0, usd: 0 };
  let finished: (JournalWorktree & { note?: string }) | undefined;
  try {
    const result = await context.store.launchWorkflowAgentTask({
      runId: context.runId,
      cwd: worktree?.path ?? context.cwd,
      phase: request.phase,
      label: request.label,
      prompt: request.prompt,
      model: request.model,
      effort: request.effort,
      access: request.access,
      verifier: request.agentType === "verifier",
      call,
      onStarted: (info) => {
        attemptId = info.attemptId;
        control.started({ workerTaskId: info.workerTaskId, attemptId: info.attemptId });
        if (control.signal.aborted || timedOut) stopAttempt();
      },
    });
    usage = result.usage;
    if (worktree) finished = await finishWorkflowWorktree(worktree, `workflow ${context.name}: ${request.label}`);
    const outcome = workflowOutcomeFromReport({
      report: result.report,
      attemptStatus: result.attemptStatus,
      error: timedOut ? `timed out after ${request.timeoutMinutes} minutes` : result.error,
      schema: request.schema,
      envelope: request.envelope,
      usage,
      worktree: finished,
    });
    return {
      ...outcome,
      usage,
      attemptId: result.attemptId,
      workerTaskId: result.workerTaskId,
      ...(finished ? { worktree: stripNote(finished) } : {}),
      ...(finished?.note ? { note: [outcome.note, finished.note].filter(Boolean).join("; ") } : {}),
    };
  } catch (err) {
    if (worktree && !finished) await finishWorkflowWorktree(worktree, `workflow ${context.name}: ${request.label}`).catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    control.signal.removeEventListener("abort", onAbort);
  }
}

function stripNote(worktree: JournalWorktree & { note?: string }): JournalWorktree {
  const { note: _note, ...rest } = worktree;
  return rest;
}

/**
 * The value a script receives for one finished attempt. Anything but a
 * complete or partial report with a result that matches the schema is null,
 * with the reason in `note`: a failed agent never throws into the script.
 */
export function workflowOutcomeFromReport(input: {
  report: Record<string, unknown> | null;
  attemptStatus: string;
  error?: string;
  schema?: Record<string, unknown>;
  envelope: boolean;
  usage: JournalUsage;
  worktree?: JournalWorktree;
}): { status: "ok" | "null"; value?: unknown; note?: string } {
  const report = input.report;
  const reportStatus = typeof report?.status === "string" ? report.status : null;
  const summary = typeof report?.summary === "string" ? report.summary : "";
  if (!report || (reportStatus !== "complete" && reportStatus !== "partial")) {
    const why =
      input.error ||
      (reportStatus ? `the agent ended ${reportStatus}${summary ? `: ${oneLine(summary, 300)}` : ""}` : null) ||
      `the agent's attempt ${input.attemptStatus} without a report`;
    return { status: "null", note: why };
  }
  let value: unknown;
  if (input.schema) {
    if (report.result === undefined) return { status: "null", note: "the agent returned no result" };
    const checked = validateWorkflowResult(input.schema, report.result);
    if (!checked.ok) return { status: "null", note: `the result does not match the schema: ${checked.errors.join("; ")}` };
    value = report.result;
  } else {
    value = typeof report.result === "string" ? report.result : summary;
  }
  if (!input.envelope) return { status: "ok", value };
  const files = Array.isArray(report.files_changed)
    ? report.files_changed
        .map((item) => (item && typeof item === "object" ? (item as { path?: unknown }).path : undefined))
        .filter((path): path is string => typeof path === "string")
    : [];
  return {
    status: "ok",
    value: {
      result: value,
      status: reportStatus,
      summary,
      filesChanged: files,
      worktree: input.worktree
        ? {
            branch: input.worktree.branch,
            base: input.worktree.base,
            commit: input.worktree.commit ?? null,
            changed: input.worktree.changed,
          }
        : null,
      usage: { tokens: input.usage.in + input.usage.out, usd: input.usage.usd },
    },
  };
}

// ── Controls ───────────────────────────────────────────────────────────────

async function stopActive(active: ActiveRun, reason: "stop" | "cancel" | "discard", message: string): Promise<void> {
  if (!active.endReason) {
    active.endReason = reason;
    active.endMessage = message;
  } else if (reason === "cancel" || reason === "discard") {
    active.endReason = reason;
    active.endMessage = message;
  }
  await active.runtime?.stop();
  await active.finished;
}

export async function stopWorkflowRun(runId: string, reason = "Stopped by the user"): Promise<void> {
  const active = activeRuns.get(runId);
  if (active) {
    await stopActive(active, "stop", reason);
    return;
  }
  const store = await driverEnv().store();
  const run = await store.getRun(runId);
  if (!run?.workflow || run.workflow.state !== "running") return;
  await store.interruptWorkflowAttempts(runId, "pause");
  await store.saveWorkflowRunInfo(runId, { state: "paused" }, {
    status: "paused",
    event: { type: "workflow.paused", message: reason },
  });
}

export async function cancelWorkflowRun(runId: string, reason = "Workflow cancelled"): Promise<void> {
  const active = activeRuns.get(runId);
  if (active) {
    await stopActive(active, "cancel", reason);
    await removeRunWorktrees(runId);
    return;
  }
  const store = await driverEnv().store();
  const run = await store.getRun(runId);
  if (!run?.workflow) return;
  if (["complete", "failed", "cancelled"].includes(run.workflow.state)) return;
  await store.interruptWorkflowAttempts(runId, "pause");
  await store.saveWorkflowRunInfo(runId, { state: "cancelled", finishedAt: new Date().toISOString() }, {
    status: "cancelled",
    event: { type: "workflow.cancelled", message: reason },
  });
  await removeRunWorktrees(runId, run);
}

// Isolated agents an app restart cut off leave their checkouts registered in
// the user's repository; a cancelled or deleted run has no resume to reuse
// them. Their edits are committed to their branches first, never dropped.
async function removeRunWorktrees(runId: string, known?: RunState): Promise<void> {
  const run = known ?? (await (await driverEnv().store()).getRun(runId));
  const root = driverEnv().worktreeRoot(runId);
  if (run?.workflow?.cwd) {
    await removeWorkflowWorktrees(run.workflow.cwd, root, `workflow ${run.workflow.name}: interrupted agent`).catch(
      () => undefined,
    );
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}

const resumingRuns = new Set<string>();

/**
 * Replays the newest complete journal generation into a fresh sandbox: calls
 * whose inputs match keep their results, the rest run live. A run that failed
 * can be resumed too, typically after its saved script was fixed and
 * `useLatestScript` copies the fix in.
 */
export async function resumeWorkflowRun(
  runId: string,
  options: { useLatestScript?: boolean; expectedSourceHash?: string } = {},
): Promise<void> {
  // Two Resume clicks (or the hub and Cora at once) both pass the activeRuns
  // check across the awaits below and would run the script twice.
  if (activeRuns.has(runId) || resumingRuns.has(runId)) return;
  resumingRuns.add(runId);
  try {
    await resumeWorkflowRunInner(runId, options);
  } finally {
    resumingRuns.delete(runId);
  }
}

/** The saved script a "use latest" resume would switch the run to, and whether it differs. */
export async function latestWorkflowScript(
  runId: string,
): Promise<{ name: string; description: string; changed: boolean; sourceHash: string } | null> {
  const store = await driverEnv().store();
  const run = await store.getRun(runId);
  if (!run?.workflow || run.workflow.ref.source === "inline" || !run.workflow.ref.name) return null;
  const latest = await resolveSource({ workflow: `${run.workflow.ref.source}:${run.workflow.ref.name}`, cwd: run.workflow.cwd });
  return {
    name: latest.meta.name,
    description: latest.meta.description,
    changed: sha256(latest.body) !== run.workflow.scriptHash,
    sourceHash: sha256(latest.text),
  };
}

async function resumeWorkflowRunInner(
  runId: string,
  options: { useLatestScript?: boolean; expectedSourceHash?: string },
): Promise<void> {
  const store = await driverEnv().store();
  const run = await store.getRun(runId);
  if (!run?.workflow) throw new Error(`Not a workflow run: ${runId}`);
  if (run.workflow.state === "complete" || run.workflow.state === "cancelled") {
    throw new Error("This workflow run has ended. Start it again to reuse its results.");
  }
  const dir = workflowDir(runId);
  const patch: Partial<WorkflowRunInfo> = { state: "running", error: undefined, finishedAt: undefined };
  if (options.useLatestScript && run.workflow.ref.source !== "inline" && run.workflow.ref.name) {
    const latest = await resolveSource({ workflow: `${run.workflow.ref.source}:${run.workflow.ref.name}`, cwd: run.workflow.cwd });
    if (options.expectedSourceHash && sha256(latest.text) !== options.expectedSourceHash) {
      throw new Error(`Workflow ${latest.meta.name} changed after it was approved; ask again before resuming with it.`);
    }
    writeFileSync(join(dir, "script.js"), latest.text, "utf8");
    patch.scriptHash = sha256(latest.body);
    patch.phases = latest.meta.phases;
  }
  const source = await latestReplaySource(dir);
  const generations = await listJournalGenerations(dir);
  const next = generations.length > 0 ? generations[generations.length - 1] + 1 : 0;
  await store.saveWorkflowRunInfo(runId, patch, {
    status: "running",
    event: { type: "workflow.resumed", message: "Workflow resumed", payload: { generation: next } },
  });
  launchExecution(runId, next, source?.entries);
}

/** Ends a run's script before its run is deleted, then drops its merged branches. */
export async function discardWorkflowRun(runId: string): Promise<void> {
  const active = activeRuns.get(runId);
  if (active) await stopActive(active, "discard", "Run deleted");
  const store = await driverEnv().store();
  const run = await store.getRun(runId);
  await removeRunWorktrees(runId, run ?? undefined);
  if (run?.workflow?.cwd) await cleanupWorkflowBranches(run.workflow.cwd, runId).catch(() => undefined);
}

export function skipWorkflowCall(runId: string, seq: number): boolean {
  return activeRuns.get(runId)?.runtime?.skip(seq) ?? false;
}

export async function workflowRunStatus(runId: string, options: { includeResult?: boolean } = {}): Promise<WorkflowRunStatus> {
  const store = await driverEnv().store();
  const run = await store.getRun(runId);
  if (!run?.workflow) throw new Error(`Not a workflow run: ${runId}`);
  const runtime = activeRuns.get(runId)?.runtime;
  const workflow: WorkflowRunInfo = runtime
    ? { ...run.workflow, tree: runtime.snapshot(), counts: runtime.counts, spent: runtime.spent }
    : run.workflow;
  const status: WorkflowRunStatus = { runId, status: run.status, title: run.title, workflow, live: Boolean(runtime) };
  if (options.includeResult && workflow.state === "complete") {
    try {
      status.result = JSON.parse(await fs.readFile(join(workflowDir(runId), "return.json"), "utf8")) as unknown;
    } catch {
      status.result = null;
    }
  }
  return status;
}

/** Long-polls until the run leaves "running" or the timeout passes. */
export async function waitForWorkflowRun(
  runId: string,
  options: { timeoutMs?: number; signal?: AbortSignal; pollMs?: number } = {},
): Promise<WorkflowRunStatus & { timedOut: boolean }> {
  const deadline = Date.now() + Math.max(0, Math.min(options.timeoutMs ?? 120_000, 15 * 60_000));
  const pollMs = options.pollMs ?? 1_000;
  for (;;) {
    const status = await workflowRunStatus(runId, { includeResult: true });
    if (status.workflow.state !== "running") return { ...status, timedOut: false };
    if (Date.now() >= deadline || options.signal?.aborted) return { ...status, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

export async function listWorkflowRuns(workspaceId?: string): Promise<RunState[]> {
  const store = await driverEnv().store();
  return (await store.listRuns(workspaceId)).filter((run) => Boolean(run.workflow));
}

// ── Boot ───────────────────────────────────────────────────────────────────

/** Registers the run controls; call once at boot before recovery. */
export async function installWorkflowDriver(): Promise<void> {
  const store = await driverEnv().store();
  const heavyBin = driverEnv().heavyBinDir?.() ?? null;
  store.setWorkflowHeavyBinDir(heavyBin && existsSync(heavyBin) ? heavyBin : null, {
    // tmpdir, not Codara's home: every Codara instance on the machine shares
    // the same few heavy slots.
    CODARA_HEAVY_LOCK_DIR: join(os.tmpdir(), "codara-heavy-locks"),
    CODARA_HEAVY_SLOTS: String(WORKFLOW_DEFAULTS.heavySlots),
    CODARA_HEAVY_MEMORY_MAX: `${Math.round(WORKFLOW_DEFAULTS.heavyMemoryMaxBytes / (1024 * 1024))}M`,
  });
  store.setWorkflowRunControls({
    stop: (runId, reason) => stopWorkflowRun(runId, reason),
    resume: (runId) => resumeWorkflowRun(runId),
    cancel: (runId, reason) => cancelWorkflowRun(runId, reason),
    discard: (runId) => discardWorkflowRun(runId),
  });
}

/**
 * Parks every workflow run the previous session left running. A report an
 * interrupted agent finished writing before the app went away is journaled
 * as that call's result, so Resume does not pay for it twice. Starts nothing.
 */
export async function recoverWorkflowRuns(): Promise<string[]> {
  const store = await driverEnv().store();
  const parked: string[] = [];
  for (const run of await store.listRuns()) {
    if (!run.workflow || activeRuns.has(run.id)) continue;
    if (run.workflow.state !== "running" && run.status !== "running") continue;
    try {
      await salvageFinishedAttempts(run);
      await store.interruptWorkflowAttempts(run.id, "app_restart");
      await store.saveWorkflowRunInfo(
        run.id,
        { state: "paused", error: RESTART_MESSAGE },
        { status: "paused", event: { type: "workflow.paused", message: RESTART_MESSAGE } },
      );
      parked.push(run.id);
    } catch (err) {
      console.warn(`[workflow] could not park ${run.id} after a restart:`, err);
    }
  }
  return parked;
}

const TERMINAL_ATTEMPT = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

async function salvageFinishedAttempts(run: RunState): Promise<void> {
  const dir = workflowDir(run.id);
  const generations = await listJournalGenerations(dir);
  if (generations.length === 0) return;
  const generation = generations[generations.length - 1];
  const entries = await readJournal(dir, generation);
  const answered = new Set(entries.filter((entry) => entry.t === "done").map((entry) => (entry as { seq: number }).seq));
  const issued = new Map<number, string>();
  for (const entry of entries) if (entry.t === "issue") issued.set(entry.seq, entry.key);
  const salvage: JournalEntry[] = [];
  for (const attempt of run.workerAttempts) {
    if (TERMINAL_ATTEMPT.has(attempt.status) || !attempt.finalReportPath) continue;
    const task = run.workerTasks.find((item) => item.id === attempt.workerTaskId);
    const call = task?.workflowCall;
    // An isolated agent's edits sit uncommitted in a checkout this session
    // does not track, so it reruns instead.
    if (!call || call.isolation || answered.has(call.seq) || issued.get(call.seq) !== call.key) continue;
    if (!existsSync(attempt.finalReportPath)) continue;
    let report: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(readFileSync(attempt.finalReportPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) report = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    let schema: Record<string, unknown> | undefined;
    if (call.schemaPath) {
      try {
        schema = JSON.parse(readFileSync(call.schemaPath, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    const usage: JournalUsage = {
      in: (attempt.inputTokens ?? 0) + (attempt.cacheReadTokens ?? 0) + (attempt.cacheWriteTokens ?? 0),
      out: attempt.outputTokens ?? 0,
      usd: attempt.costUsd ?? 0,
    };
    const outcome = workflowOutcomeFromReport({
      report,
      attemptStatus: "succeeded",
      schema,
      envelope: call.envelope === true,
      usage,
    });
    // Only results worth keeping are salvaged; a null reruns on resume.
    if (outcome.status !== "ok") continue;
    salvage.push({
      t: "done",
      seq: call.seq,
      status: "ok",
      result: outcome.value ?? null,
      usage,
      attemptId: attempt.id,
      workerTaskId: attempt.workerTaskId,
      note: "recovered after an app restart",
    });
    answered.add(call.seq);
  }
  if (salvage.length === 0) return;
  const writer = new JournalWriter(join(dir, journalFileName(generation)));
  for (const entry of salvage) void writer.append(entry);
  await writer.close();
}

// ── Default environment ────────────────────────────────────────────────────

function defaultEnv(): WorkflowDriverEnv {
  return {
    store: () => import("./run-store"),
    runDir,
    registryDirs: () => ({
      builtinDir: resolveBundledResourcePath("orchestration", "workflows"),
      userDir: join(codaraHome(), "workflows"),
    }),
    worktreeRoot: (runId) => join(codaraHome(), "workflow-worktrees", runId.replace(/^run-/, "").slice(0, 12)),
    models: defaultModelPolicy,
    heavyBinDir: () => resolveBundledResourcePath("orchestration", "bin"),
  };
}

async function defaultModelPolicy(): Promise<WorkflowModelPolicy> {
  const defaultEffort: AgentEffortLevel = "medium";
  if (process.env.CODARA_WORKFLOW_FAKE_WORKERS === "1") {
    return { defaultModel: DEFAULT_LOOM_WORKER_MODEL, defaultEffort, check: () => null, connected: () => true };
  }
  const [{ loadSettings }, { coraWorkerModelAvailability }, { availableCoraWorkerModels }] = await Promise.all([
    import("../storage"),
    import("./worker-model-availability"),
    import("../openrouter-config"),
  ]);
  const settings = await loadSettings();
  const availability = await coraWorkerModelAvailability(settings);
  const enabled = availableCoraWorkerModels(settings);
  const connected = new Set(availability.connected);
  const disconnected = new Set(availability.disconnected);
  // Any model in the live catalog of a connected provider may be named, not
  // only the enabled ones, so a newly released model works the day it ships.
  let catalog: Set<string> | null = null;
  try {
    const [{ inspectPiAccountProfileAuthStore }, { usablePiProviders }, { inspectUnifiedPiModelCatalog }] = await Promise.all([
      import("./pi-account-auth-store"),
      import("./pi-worker-providers"),
      import("./worker-model-catalog"),
    ]);
    const usable = usablePiProviders((await inspectPiAccountProfileAuthStore()).statuses);
    catalog = new Set((await inspectUnifiedPiModelCatalog()).filter((model) => usable.has(model.provider)).map((model) => model.id));
  } catch {
    catalog = null;
  }
  const isConnected = (model: string) => connected.has(model) || (catalog?.has(model) ?? false);
  return {
    defaultModel: availability.connected[0] ?? enabled[0] ?? DEFAULT_LOOM_WORKER_MODEL,
    defaultEffort,
    connected: (model) => catalog === null || isConnected(model),
    check: (model) => {
      if (catalog === null || isConnected(model)) return null;
      if (disconnected.has(model)) return `model ${model} has no connected account`;
      const names = [...connected].slice(0, 8).join(", ");
      return `model ${model} is not available${names ? `; connected models include ${names}` : ""}`;
    },
  };
}
