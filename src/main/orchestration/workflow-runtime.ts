// Host side of one workflow run: receives the sandbox's agent() calls,
// answers them from the journal while a resume replays, and otherwise queues
// them under the run's caps and the machine-wide admission, hands them to an
// injected executor (the driver binds it to run-store workers) and posts the
// results back. It never trusts the script for a limit: concurrency,
// maxAgents and the token and USD ceilings are all enforced here.
//
// Electron-free and run-store-free on purpose; the suite drives it with a
// fake executor and the real sandbox.

import { MIN_COMPACT_AT_TOKENS } from "@shared/context-compaction";
import type { AgentEffortLevel } from "@shared/types";
import {
  WORKFLOW_HARD_LIMITS,
  type WorkflowAgentAccess,
  type WorkflowAgentType,
  type WorkflowCaps,
  type WorkflowCallStatus,
  type WorkflowPhaseMeta,
  type WorkflowTreeCall,
  type WorkflowTreeSnapshot,
  type WorkflowWaitReason,
} from "@shared/workflow";

import type { WorkflowAdmission } from "./workflow-admission";
import {
  CallKeyCounter,
  INLINE_RESULT_LIMIT,
  JournalReplayer,
  WORKFLOW_RUNTIME_VERSION,
  callKeyBase,
  canonicalJson,
  rerunsOnResume,
  sha256,
  type DoneEntry,
  type JournalEntry,
  type JournalUsage,
  type JournalWorktree,
} from "./workflow-journal";
import { startWorkflowSandbox, type WorkflowSandbox, type WorkflowSandboxOptions } from "./workflow-sandbox";
import type { SandboxAgentCall, SandboxChildScript, SandboxLimits } from "./workflow-sandbox-protocol";
import { checkResultSchema, jsonSize } from "./workflow-schema";

const EFFORTS: readonly AgentEffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const ACCESS: readonly WorkflowAgentAccess[] = ["full", "edits", "readonly"];
const AGENT_TYPES: readonly WorkflowAgentType[] = ["worker", "verifier", "researcher"];
const MAX_LOG_LINES = 200;
const NO_USAGE: JournalUsage = { in: 0, out: 0, usd: 0 };
export const DEFAULT_WORKFLOW_PHASE = "Main";

export interface WorkflowAgentRequest {
  seq: number;
  key: string;
  /** Name of the nested workflow that issued the call, "" for the root script. */
  ctx: string;
  prompt: string;
  label: string;
  phase: string;
  schema?: Record<string, unknown>;
  model: string;
  effort: AgentEffortLevel;
  isolation?: "worktree";
  access: WorkflowAgentAccess;
  agentType: WorkflowAgentType;
  heavy: boolean;
  timeoutMinutes?: number;
  /** Fraction of the context window (0..1) or an absolute token count. */
  compactAt?: number;
  envelope: boolean;
}

export interface WorkflowAgentOutcome {
  /** "ok" delivers `value`; "null" delivers null with `note` saying why. */
  status: "ok" | "null";
  value?: unknown;
  usage: JournalUsage;
  note?: string;
  attemptId?: string;
  workerTaskId?: string;
  worktree?: JournalWorktree;
}

// "quit" settles like "stop", but the executor leaves the attempt to the
// app's process teardown and the next launch's recovery.
export type WorkflowAbortReason = "skip" | "stop" | "ceiling" | "quit";

export interface WorkflowAgentControl {
  signal: AbortSignal;
  /** The executor created its task and attempt. */
  started(info: { workerTaskId?: string; attemptId?: string; runId?: string }): void;
  /** Running usage of the live attempt, counted toward the ceilings. */
  usage(usage: JournalUsage): void;
}

export interface WorkflowAgentExecutor {
  run(request: WorkflowAgentRequest, control: WorkflowAgentControl): Promise<WorkflowAgentOutcome>;
}

export interface WorkflowJournalSink {
  append(entry: JournalEntry): void;
  /** Stores a large result off the journal line; returns the reference. */
  saveResult?(seq: number, value: unknown): string | undefined;
  loadResult?(ref: string): unknown;
}

export interface WorkflowRuntimeOptions {
  runId: string;
  body: string;
  args: unknown;
  scriptHash?: string;
  children?: Record<string, SandboxChildScript>;
  caps: WorkflowCaps;
  defaults: { model: string; effort: AgentEffortLevel };
  phases?: WorkflowPhaseMeta[];
  /** Null when the model may be used, otherwise why it may not. */
  checkModel?: (model: string) => string | null;
  executor: WorkflowAgentExecutor;
  admission?: WorkflowAdmission;
  journal: WorkflowJournalSink;
  /** Entries of the generation this run resumes from. */
  replay?: JournalEntry[];
  generation?: number;
  startSandbox?: (options: WorkflowSandboxOptions) => WorkflowSandbox;
  sandboxLimits?: Partial<SandboxLimits>;
  onChange?: () => void;
  onLog?: (message: string) => void;
}

export type WorkflowRuntimeOutcome =
  | { status: "complete"; value: unknown }
  | { status: "failed"; error: string }
  | { status: "stopped" };

interface CallState {
  seq: number;
  sandboxId: number;
  key: string;
  tree: WorkflowTreeCall;
  request?: WorkflowAgentRequest;
  /** Validation error, answered without running anything. */
  invalid?: string;
  cached: boolean;
  answered: boolean;
  controller?: AbortController;
  liveUsage?: JournalUsage;
  ticketCancel?: () => void;
  /** The ceiling that cut this call off while it ran. */
  cutOff?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

function defaultLabel(prompt: string): string {
  return oneLine(prompt, 60);
}

export class WorkflowRuntime {
  private sandbox: WorkflowSandbox | null = null;
  private readonly calls = new Map<number, CallState>();
  private readonly order: CallState[] = [];
  private readonly phaseOrder: string[] = [];
  private readonly phaseSeen = new Set<string>();
  private readonly logs: string[] = [];
  private readonly counter = new CallKeyCounter();
  private readonly queue: CallState[] = [];
  private nextSeq = 0;
  private running = 0;
  private liveLaunched = 0;
  private refused = 0;
  private readonly carriedAbandoned: JournalUsage[] = [];
  private replayer: JournalReplayer | null;
  private replaying: boolean;
  private divergedAtSeq: number | null = null;
  private pendingIdles = 1;
  private finished = false;
  private stopping = false;
  private concurrency: number;
  private readonly spentSettled = { in: 0, out: 0, usd: 0 };
  private outcome: WorkflowRuntimeOutcome | null = null;
  private resolveOutcome: ((outcome: WorkflowRuntimeOutcome) => void) | null = null;
  private readonly liveExecutions = new Set<Promise<void>>();

  constructor(private readonly options: WorkflowRuntimeOptions) {
    this.concurrency = options.caps.concurrency;
    const replayEntries = options.replay ?? [];
    this.replayer = replayEntries.length > 0 ? new JournalReplayer(replayEntries) : null;
    this.replaying = Boolean(this.replayer?.hasEntries);
    for (const entry of replayEntries) {
      if (entry.t !== "abandoned") continue;
      this.carriedAbandoned.push(entry.usage);
      this.addSettled(entry.usage);
    }
    for (const phase of options.phases ?? []) this.notePhase(phase.title);
  }

  // ── Public surface ──────────────────────────────────────────────────────

  start(): Promise<WorkflowRuntimeOutcome> {
    if (this.sandbox) throw new Error("workflow runtime already started");
    const generation = this.options.generation ?? 0;
    this.options.journal.append({
      t: "start",
      runtime: WORKFLOW_RUNTIME_VERSION,
      scriptHash: this.options.scriptHash ?? sha256(this.options.body),
      argsHash: sha256(canonicalJson(this.options.args ?? null)),
      defaults: this.options.defaults,
      generation,
    });
    for (const usage of this.carriedAbandoned) this.options.journal.append({ t: "abandoned", usage });
    if (!this.replaying && this.replayer) this.endReplay(null);
    const promise = new Promise<WorkflowRuntimeOutcome>((resolve) => {
      this.resolveOutcome = resolve;
    });
    const start = this.options.startSandbox ?? startWorkflowSandbox;
    this.sandbox = start({
      body: this.options.body,
      args: this.options.args ?? null,
      children: this.options.children,
      budget: { total: this.options.caps.tokenCeiling, totalUsd: this.options.caps.usdCeiling },
      limits: this.options.sandboxLimits,
      handlers: {
        onCall: (id, ctx, call) => this.onCall(id, ctx, call),
        onNote: (_ctx, op, value) => (op === "log" ? this.onLogNote(value) : this.onPhaseNote(value)),
        onChild: (name) => {
          this.options.journal.append({ t: "child", name });
          this.onLogNote(`started nested workflow ${name}`);
        },
        onIdle: () => this.onIdle(),
        onDone: (result) => this.onDone(result),
      },
    });
    return promise;
  }

  /** Ends the script and every live agent; the run can resume from the journal. */
  async stop(): Promise<void> {
    if (this.finished) {
      await this.settleLive();
      return;
    }
    this.stopping = true;
    await this.sandbox?.terminate();
    this.abortAll("stop");
    await this.settleLive();
    this.finish({ status: "stopped" });
  }

  /**
   * Ends the script for an app quit without waiting on live agents. The
   * quit's teardown kills them right after, and once this has run their
   * deaths are never journaled as answers, so a resume runs them again.
   */
  suspend(): void {
    if (this.finished) return;
    this.stopping = true;
    void this.sandbox?.terminate();
    this.abortAll("quit");
    this.finish({ status: "stopped" });
  }

  /** Resolves one call with null: a queued call never starts, a live one is stopped. */
  skip(seq: number): boolean {
    const call = this.calls.get(seq);
    if (!call || call.answered || call.cached || call.invalid) return false;
    const queuedAt = this.queue.indexOf(call);
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1);
      this.answer(call, { status: "skipped", usage: { in: 0, out: 0, usd: 0 }, note: "skipped by the user" });
      return true;
    }
    if (call.controller) {
      call.controller.abort("skip");
      return true;
    }
    return false;
  }

  setConcurrency(value: number): void {
    this.concurrency = Math.max(1, Math.min(WORKFLOW_HARD_LIMITS.concurrency, Math.floor(value)));
    this.pumpLive();
  }

  get spent(): { inputTokens: number; outputTokens: number; usd: number } {
    let input = this.spentSettled.in;
    let output = this.spentSettled.out;
    let usd = this.spentSettled.usd;
    for (const call of this.calls.values()) {
      if (!call.answered && call.liveUsage) {
        input += call.liveUsage.in;
        output += call.liveUsage.out;
        usd += call.liveUsage.usd;
      }
    }
    return { inputTokens: input, outputTokens: output, usd };
  }

  get counts(): { issued: number; cached: number; live: number; done: number; nulls: number } {
    let cached = 0;
    let done = 0;
    let nulls = 0;
    for (const call of this.order) {
      if (call.cached) cached += 1;
      if (call.answered) done += 1;
      if (call.tree.status === "null" || call.tree.status === "skipped" || call.tree.status === "error") nulls += 1;
    }
    return { issued: this.order.length, cached, live: this.running, done, nulls };
  }

  get diverged(): number | null {
    return this.divergedAtSeq;
  }

  get isReplaying(): boolean {
    return this.replaying;
  }

  snapshot(): WorkflowTreeSnapshot {
    const metaPhases = new Map((this.options.phases ?? []).map((phase) => [phase.title, phase]));
    const byPhase = new Map<string, WorkflowTreeCall[]>();
    for (const title of this.phaseOrder) byPhase.set(title, []);
    for (const call of this.order) {
      const list = byPhase.get(call.tree.phase);
      if (list) list.push({ ...call.tree });
      else byPhase.set(call.tree.phase, [{ ...call.tree }]);
    }
    const memory = this.options.admission?.memoryWait ?? null;
    return {
      phases: [...byPhase.entries()]
        .filter(([title, calls]) => calls.length > 0 || metaPhases.has(title))
        .map(([title, calls]) => {
          const meta = metaPhases.get(title);
          return { title, detail: meta?.detail, model: meta?.model, calls };
        }),
      logs: [...this.logs],
      ...(memory ? { memoryWait: memory } : {}),
    };
  }

  // ── Sandbox events ──────────────────────────────────────────────────────

  private onCall(sandboxId: number, ctx: string, raw: SandboxAgentCall): void {
    if (this.finished || this.stopping) return;
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const phase = typeof raw.phase === "string" && raw.phase ? raw.phase : DEFAULT_WORKFLOW_PHASE;
    this.notePhase(phase);
    const normalized = this.normalize(seq, ctx, raw, phase);
    const label =
      typeof raw.opts.label === "string" && raw.opts.label.trim()
        ? oneLine(raw.opts.label, 120)
        : defaultLabel(raw.prompt);
    const keyBase =
      "request" in normalized
        ? callKeyBase({
            prompt: normalized.request.prompt,
            schema: normalized.request.schema,
            model: normalized.request.model,
            effort: normalized.request.effort,
            isolation: normalized.request.isolation,
            access: normalized.request.access,
            agentType: normalized.request.agentType,
            heavy: normalized.request.heavy,
          })
        : `e:${sha256(canonicalJson({ prompt: raw.prompt, opts: raw.opts })).slice(0, 32)}`;
    const key = this.counter.commit(keyBase);
    const request = "request" in normalized ? { ...normalized.request, key, label } : undefined;
    const call: CallState = {
      seq,
      sandboxId,
      key,
      request,
      invalid: "error" in normalized ? normalized.error : undefined,
      cached: false,
      answered: false,
      tree: {
        seq,
        label,
        phase,
        status: "queued",
        model: request?.model,
        effort: request?.effort,
        isolated: request?.isolation === "worktree" || undefined,
        heavy: request?.heavy || undefined,
        access: request?.access,
      },
    };
    this.calls.set(seq, call);
    this.order.push(call);
    this.options.journal.append({ t: "issue", seq, key, label, phase });

    if (this.replaying && this.replayer) {
      if (this.replayer.matchIssue(key, seq)) {
        call.cached = true;
        this.changed();
        this.pumpReplay();
        return;
      }
      this.diverge(seq);
    }
    this.dispatchLive(call);
    this.changed();
  }

  private onIdle(): void {
    this.pendingIdles = Math.max(0, this.pendingIdles - 1);
    if (this.replaying) this.pumpReplay();
    this.checkDeadlock();
  }

  private onLogNote(value: string): void {
    const line = oneLine(value, 500);
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    this.options.journal.append({ t: "log", msg: line });
    this.options.onLog?.(line);
    this.changed();
  }

  private onPhaseNote(title: string): void {
    this.notePhase(title);
    this.options.journal.append({ t: "phase", title });
    this.changed();
  }

  private onDone(result: { ok: boolean; value?: unknown; error?: string }): void {
    if (this.stopping) return;
    if (result.ok) {
      let size = 0;
      try {
        size = jsonSize(result.value ?? null);
      } catch {
        size = Infinity;
      }
      if (size > WORKFLOW_HARD_LIMITS.returnBytes) {
        this.fail(`the workflow's return value is larger than ${WORKFLOW_HARD_LIMITS.returnBytes / 1024 / 1024} MB`);
        return;
      }
      // Calls the script never awaited may still be running; they cannot
      // change the result any more, so they stop with the script.
      this.abortAll("stop");
      this.options.journal.append({ t: "end", status: "complete" });
      this.finish({ status: "complete", value: result.value ?? null });
      return;
    }
    this.fail(result.error ?? "the workflow script failed");
  }

  // ── Replay ──────────────────────────────────────────────────────────────

  private pumpReplay(): void {
    while (this.replaying && this.replayer && !this.finished) {
      const step = this.replayer.next(this.pendingIdles === 0);
      if (step.kind === "wait") return;
      if (step.kind === "exhausted") {
        // Calls that were in flight when the previous generation stopped
        // matched their issue but have no result: they still have to run.
        if (this.replayer.leftovers().length > 0) this.diverge(null);
        else this.endReplay(null);
        return;
      }
      if (step.kind === "diverge") {
        this.diverge(null);
        return;
      }
      const call = this.calls.get(step.newSeq);
      if (!call) {
        this.diverge(null);
        return;
      }
      this.deliverCached(call, step.done);
    }
  }

  private deliverCached(call: CallState, done: DoneEntry): void {
    let value: unknown = done.result ?? null;
    if (done.resultRef) {
      try {
        value = this.options.journal.loadResult?.(done.resultRef) ?? null;
      } catch {
        value = null;
      }
    }
    call.tree.cached = true;
    call.tree.attemptId = done.attemptId;
    call.tree.workerTaskId = done.workerTaskId;
    if (done.worktree) {
      call.tree.branch = done.worktree.branch;
      call.tree.changed = done.worktree.changed;
    }
    this.answer(call, {
      status: done.status === "ok" ? "ok" : done.status === "skipped" ? "skipped" : "null",
      value,
      usage: done.usage,
      note: done.note,
      attemptId: done.attemptId,
      workerTaskId: done.workerTaskId,
      worktree: done.worktree,
      cached: true,
    });
  }

  private endReplay(divergedAt: number | null): void {
    if (this.divergedAtSeq === null) this.divergedAtSeq = divergedAt;
    this.replaying = false;
    this.options.journal.append({ t: "live", divergedAtSeq: divergedAt });
  }

  /**
   * From here the run is live. Calls that matched before the divergence keep
   * their recorded results (identical inputs), delivered now in issue order;
   * the ones with no usable result run live.
   */
  private diverge(atSeq: number | null): void {
    if (!this.replaying || !this.replayer) return;
    const leftovers = this.replayer.leftovers();
    this.endReplay(atSeq ?? (leftovers[0]?.newSeq ?? this.nextSeq));
    for (const leftover of leftovers) {
      const call = this.calls.get(leftover.newSeq);
      if (!call || call.answered) continue;
      call.cached = false;
      if (leftover.done && !rerunsOnResume(leftover.done)) {
        call.cached = true;
        this.deliverCached(call, leftover.done);
      } else {
        // The cut-off attempt was paid for; its rerun must not hide that spend.
        if (leftover.done) this.abandon(leftover.done.usage);
        this.dispatchLive(call);
      }
    }
    for (const done of this.replayer.unmatchedDones()) this.abandon(done.usage);
    this.changed();
  }

  // ── Live calls ──────────────────────────────────────────────────────────

  private normalize(
    seq: number,
    ctx: string,
    raw: SandboxAgentCall,
    phase: string,
  ): { request: Omit<WorkflowAgentRequest, "key" | "label"> } | { error: string } {
    const opts = isRecord(raw.opts) ? raw.opts : {};
    const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
    if (!prompt.trim()) return { error: "agent(prompt): prompt must be a non-empty string" };
    const phaseMeta = (this.options.phases ?? []).find((entry) => entry.title === phase);
    let schema: Record<string, unknown> | undefined;
    if (opts.schema !== undefined) {
      const check = checkResultSchema(opts.schema);
      if (!check.ok) return { error: `agent(): ${check.error}` };
      schema = check.schema;
    }
    const model = typeof opts.model === "string" && opts.model.trim()
      ? opts.model.trim()
      : phaseMeta?.model ?? this.options.defaults.model;
    const modelProblem = this.options.checkModel?.(model) ?? null;
    if (modelProblem) return { error: `agent(): ${modelProblem}` };
    let effort = this.options.defaults.effort;
    if (opts.effort !== undefined) {
      if (!EFFORTS.includes(opts.effort as AgentEffortLevel)) {
        return { error: `agent(): effort must be one of ${EFFORTS.join(", ")}` };
      }
      effort = opts.effort as AgentEffortLevel;
    }
    let agentType: WorkflowAgentType = "worker";
    if (opts.agentType !== undefined) {
      if (!AGENT_TYPES.includes(opts.agentType as WorkflowAgentType)) {
        return { error: `agent(): agentType must be one of ${AGENT_TYPES.join(", ")}` };
      }
      agentType = opts.agentType as WorkflowAgentType;
    }
    let access: WorkflowAgentAccess = agentType === "verifier" ? "readonly" : "full";
    if (opts.access !== undefined) {
      if (!ACCESS.includes(opts.access as WorkflowAgentAccess)) {
        return { error: `agent(): access must be one of ${ACCESS.join(", ")}` };
      }
      access = opts.access as WorkflowAgentAccess;
    }
    if (opts.isolation !== undefined && opts.isolation !== "worktree") {
      return { error: "agent(): isolation must be 'worktree' when set" };
    }
    let timeoutMinutes: number | undefined;
    if (opts.timeoutMinutes !== undefined) {
      if (typeof opts.timeoutMinutes !== "number" || !(opts.timeoutMinutes > 0)) {
        return { error: "agent(): timeoutMinutes must be a positive number" };
      }
      timeoutMinutes = Math.min(24 * 60, opts.timeoutMinutes);
    }
    let compactAt: number | undefined;
    if (opts.compactAt !== undefined) {
      if (typeof opts.compactAt !== "number" || !(opts.compactAt > 0)) {
        return { error: "agent(): compactAt must be a fraction of the context window (0..1) or a token count" };
      }
      if (opts.compactAt > 1 && opts.compactAt < MIN_COMPACT_AT_TOKENS) {
        return {
          error: `agent(): compactAt as a token count must be at least ${MIN_COMPACT_AT_TOKENS}; use a fraction (0..1) for a share of the context window`,
        };
      }
      compactAt = opts.compactAt;
    }
    return {
      request: {
        seq,
        ctx,
        prompt,
        phase,
        schema,
        model,
        effort,
        isolation: opts.isolation === "worktree" ? "worktree" : undefined,
        access,
        agentType,
        heavy: opts.heavy === true,
        timeoutMinutes,
        compactAt,
        envelope: opts.envelope === true,
      },
    };
  }

  private ceilingProblem(): string | null {
    const spent = this.spent;
    const { tokenCeiling, usdCeiling } = this.options.caps;
    if (tokenCeiling !== null && spent.inputTokens + spent.outputTokens >= tokenCeiling) {
      return `workflow token ceiling reached (${tokenCeiling} tokens)`;
    }
    if (usdCeiling !== null && spent.usd >= usdCeiling) {
      return `workflow USD ceiling reached ($${usdCeiling})`;
    }
    return null;
  }

  // The ceilings bound what agents spend while they run, not only which
  // agents may start: once settled plus live usage crosses one, every agent
  // still running or waiting for a slot is cut off and resolves null.
  // Checking only at launch let each running agent finish, so a run could
  // overshoot by up to `concurrency` whole agents.
  private enforceCeilings(): void {
    if (this.finished || this.stopping) return;
    const ceiling = this.ceilingProblem();
    if (!ceiling) return;
    for (const call of this.calls.values()) {
      if (call.answered || !call.controller || call.controller.signal.aborted) continue;
      call.cutOff = `cut off: ${ceiling}`;
      call.controller.abort("ceiling");
    }
  }

  private dispatchLive(call: CallState): void {
    if (call.invalid) {
      this.refuse(call, call.invalid);
      return;
    }
    if (this.liveLaunched >= this.options.caps.maxAgents) {
      this.refuse(call, `maxAgents reached: this run may start at most ${this.options.caps.maxAgents} agents`);
      return;
    }
    const ceiling = this.ceilingProblem();
    if (ceiling) {
      this.refuse(call, ceiling);
      return;
    }
    // Counted at issue, not at launch, so a script cannot queue past the cap
    // and have the excess fail later in an order that depends on timing.
    this.liveLaunched += 1;
    this.queue.push(call);
    this.pumpLive();
  }

  private pumpLive(): void {
    while (!this.finished && !this.stopping && this.running < this.concurrency && this.queue.length > 0) {
      const call = this.queue.shift()!;
      const ceiling = this.ceilingProblem();
      if (ceiling) {
        this.refuse(call, ceiling);
        continue;
      }
      this.running += 1;
      const execution = this.execute(call).finally(() => {
        this.liveExecutions.delete(execution);
      });
      this.liveExecutions.add(execution);
    }
    if (this.queue.length > 0) {
      for (const call of this.queue) this.setWaiting(call, "slot");
    }
  }

  private setWaiting(call: CallState, reason: WorkflowWaitReason | null): void {
    if (call.tree.waiting === (reason ?? undefined)) return;
    call.tree.waiting = reason ?? undefined;
    this.changed();
  }

  private async execute(call: CallState): Promise<void> {
    const request = call.request!;
    const controller = new AbortController();
    call.controller = controller;
    let lease: { release(): void } | null = null;
    try {
      if (this.options.admission) {
        const ticket = this.options.admission.request({
          runId: this.options.runId,
          heavy: request.heavy,
          onWait: (reason) => this.setWaiting(call, reason),
        });
        call.ticketCancel = ticket.cancel;
        const aborted = new Promise<null>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(null), { once: true });
        });
        const granted = await Promise.race([ticket.granted, aborted]);
        call.ticketCancel = undefined;
        if (!granted) {
          ticket.cancel();
          // A grant that raced the abort must go back to the pool.
          void ticket.granted.then((late) => {
            if (controller.signal.aborted) late.release();
          });
          this.settleAborted(call, controller.signal.reason as WorkflowAbortReason);
          return;
        }
        lease = granted;
      }
      if (controller.signal.aborted) {
        this.settleAborted(call, controller.signal.reason as WorkflowAbortReason);
        return;
      }
      this.setWaiting(call, null);
      call.tree.status = "running";
      call.tree.startedAt = new Date().toISOString();
      this.changed();
      let outcome: WorkflowAgentOutcome;
      try {
        outcome = await this.options.executor.run(request, {
          signal: controller.signal,
          started: (info) => {
            call.tree.workerTaskId = info.workerTaskId ?? call.tree.workerTaskId;
            call.tree.attemptId = info.attemptId ?? call.tree.attemptId;
            call.tree.runId = info.runId ?? call.tree.runId;
            this.changed();
          },
          usage: (usage) => {
            call.liveUsage = usage;
            call.tree.tokens = usage.in + usage.out;
            call.tree.costUsd = usage.usd;
            this.changed();
            this.enforceCeilings();
          },
        });
      } catch (err) {
        outcome = {
          status: "null",
          usage: call.liveUsage ?? { in: 0, out: 0, usd: 0 },
          note: `the agent failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (controller.signal.aborted) {
        if (controller.signal.reason === "skip") {
          this.answer(call, { ...outcome, status: "skipped", value: null, note: "skipped by the user" });
        } else if (controller.signal.reason === "ceiling") {
          this.answer(call, { ...outcome, status: "null", value: null, note: call.cutOff, cutOff: true });
        } else {
          this.settleAborted(call, "stop", outcome.usage);
        }
        return;
      }
      if (outcome.status === "ok") {
        let size = 0;
        try {
          size = jsonSize(outcome.value ?? null);
        } catch {
          size = Infinity;
        }
        if (size > WORKFLOW_HARD_LIMITS.resultBytes) {
          outcome = {
            ...outcome,
            status: "null",
            value: null,
            note: `the agent's result is larger than ${WORKFLOW_HARD_LIMITS.resultBytes / 1024} KB`,
          };
        }
      }
      this.answer(call, { ...outcome });
    } finally {
      lease?.release();
      call.controller = undefined;
      this.running -= 1;
      this.pumpLive();
    }
  }

  // Stopped calls get no journal entry, so a resume runs them again; the
  // guest is gone and is not answered either.
  private settleAborted(call: CallState, reason: WorkflowAbortReason, usage?: JournalUsage): void {
    if (reason === "skip") {
      this.answer(call, { status: "skipped", usage: usage ?? call.liveUsage ?? NO_USAGE, note: "skipped by the user" });
      return;
    }
    if (reason === "ceiling") {
      this.answer(call, { status: "null", usage: usage ?? call.liveUsage ?? NO_USAGE, note: call.cutOff, cutOff: true });
      return;
    }
    if (!call.answered) {
      // What the stopped attempt used was paid for even though no result
      // records it; without this a stopped run under-reports its spend and
      // a resumed one can run past its ceiling.
      const spent = usage ?? call.liveUsage;
      call.liveUsage = undefined;
      if (spent) {
        this.abandon(spent);
        call.tree.tokens = spent.in + spent.out;
        call.tree.costUsd = spent.usd;
      }
      call.tree.status = "queued";
      call.tree.waiting = undefined;
      call.tree.note = "stopped before it finished; runs again on resume";
      this.changed();
    }
  }

  private answer(
    call: CallState,
    outcome: {
      status: "ok" | "null" | "skipped" | "error";
      value?: unknown;
      usage: JournalUsage;
      note?: string;
      attemptId?: string;
      workerTaskId?: string;
      worktree?: JournalWorktree;
      cached?: boolean;
      cutOff?: boolean;
    },
  ): void {
    if (call.answered) return;
    call.answered = true;
    call.liveUsage = undefined;
    // The prompt can be large and a long run issues many calls; only the
    // tree row is needed once a call is answered.
    call.request = undefined;
    const usage = outcome.usage ?? NO_USAGE;
    this.addSettled(usage);
    this.enforceCeilings();
    const value = outcome.status === "ok" ? (outcome.value === undefined ? null : outcome.value) : null;

    const statusMap: Record<typeof outcome.status, WorkflowCallStatus> = {
      ok: "done",
      null: "null",
      skipped: "skipped",
      error: "error",
    };
    call.tree.status = statusMap[outcome.status];
    call.tree.waiting = undefined;
    call.tree.tokens = usage.in + usage.out;
    call.tree.costUsd = usage.usd;
    call.tree.finishedAt = new Date().toISOString();
    call.tree.note = outcome.note ? oneLine(outcome.note) : undefined;
    call.tree.attemptId = outcome.attemptId ?? call.tree.attemptId;
    call.tree.workerTaskId = outcome.workerTaskId ?? call.tree.workerTaskId;
    if (outcome.worktree) {
      call.tree.branch = outcome.worktree.branch;
      call.tree.changed = outcome.worktree.changed;
    }

    if (!this.stopping && !this.finished) {
      const entry: DoneEntry = {
        t: "done",
        seq: call.seq,
        status: outcome.status,
        usage,
        ...(outcome.attemptId ? { attemptId: outcome.attemptId } : {}),
        ...(outcome.workerTaskId ? { workerTaskId: outcome.workerTaskId } : {}),
        ...(outcome.worktree ? { worktree: outcome.worktree } : {}),
        ...(outcome.note ? { note: oneLine(outcome.note, 2_000) } : {}),
        ...(outcome.cached ? { cached: true } : {}),
        ...(outcome.cutOff ? { cutOff: true } : {}),
      };
      if (outcome.status === "ok") {
        let inlineSize = 0;
        try {
          inlineSize = jsonSize(value);
        } catch {
          inlineSize = Infinity;
        }
        const ref = inlineSize > INLINE_RESULT_LIMIT ? this.options.journal.saveResult?.(call.seq, value) : undefined;
        if (ref) entry.resultRef = ref;
        else entry.result = value;
      }
      this.options.journal.append(entry);
      this.pendingIdles += 1;
      if (outcome.status === "error") {
        this.sandbox?.reply(call.sandboxId, { ok: false, error: outcome.note ?? "agent call failed", usage: { tokens: 0, usd: 0 } });
      } else {
        this.sandbox?.reply(call.sandboxId, {
          ok: true,
          value,
          usage: { tokens: usage.in + usage.out, usd: usage.usd },
        });
      }
    }
    this.changed();
  }

  // A refusal answers at once without yielding to anything, so a script
  // that catches it in a loop would otherwise issue calls forever.
  private refuse(call: CallState, note: string): void {
    this.answer(call, { status: "error", usage: NO_USAGE, note });
    this.refused += 1;
    if (this.refused > WORKFLOW_HARD_LIMITS.refusedCalls) {
      this.fail(`the script kept calling agent() after ${WORKFLOW_HARD_LIMITS.refusedCalls} calls were refused (the last one: ${note})`);
    }
  }

  private addSettled(usage: JournalUsage): void {
    this.spentSettled.in += usage.in;
    this.spentSettled.out += usage.out;
    this.spentSettled.usd += usage.usd;
  }

  private abandon(usage: JournalUsage): void {
    if (!(usage.in > 0 || usage.out > 0 || usage.usd > 0)) return;
    this.addSettled(usage);
    this.options.journal.append({ t: "abandoned", usage: { in: usage.in, out: usage.out, usd: usage.usd } });
  }

  // ── Endings ─────────────────────────────────────────────────────────────

  // The guest settled, nothing it waits on is outstanding and it has not
  // finished: it awaits a promise nothing can resolve. Without this check
  // such a run would sit at "running" forever.
  private checkDeadlock(): void {
    if (this.finished || this.stopping || this.pendingIdles > 0 || this.replaying) return;
    for (const call of this.order) {
      if (!call.answered) return;
    }
    this.fail("the workflow script is waiting on a promise that can never settle (an await on something other than agent(), parallel(), pipeline() or workflow())");
  }

  private fail(error: string): void {
    if (this.finished) return;
    this.abortAll("stop");
    this.options.journal.append({ t: "end", status: "failed", error: oneLine(error, 2_000) });
    void this.sandbox?.terminate();
    this.finish({ status: "failed", error });
  }

  private abortAll(reason: WorkflowAbortReason): void {
    for (const call of this.queue.splice(0)) {
      if (!call.answered) {
        call.tree.status = "queued";
        call.tree.waiting = undefined;
      }
    }
    for (const call of this.calls.values()) {
      call.ticketCancel?.();
      if (!call.answered && call.controller && !call.controller.signal.aborted) call.controller.abort(reason);
    }
  }

  private async settleLive(): Promise<void> {
    while (this.liveExecutions.size > 0) {
      await Promise.allSettled([...this.liveExecutions]);
    }
  }

  private finish(outcome: WorkflowRuntimeOutcome): void {
    if (this.finished) return;
    this.finished = true;
    this.outcome = outcome;
    this.changed();
    // Live agents of a finished or failed script are being stopped; the run
    // reports its outcome only once they have, so nothing outlives it.
    void this.settleLive().then(() => this.resolveOutcome?.(outcome));
  }

  private notePhase(title: string): void {
    if (this.phaseSeen.has(title)) return;
    this.phaseSeen.add(title);
    this.phaseOrder.push(title);
  }

  private changed(): void {
    this.options.onChange?.();
  }

  get result(): WorkflowRuntimeOutcome | null {
    return this.outcome;
  }
}
