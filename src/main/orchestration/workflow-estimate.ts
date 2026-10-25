// Dry run of a workflow for the consent card, the run form and
// codara_workflow_check: the real script runs in the real sandbox, but every
// agent() call is answered at once with a sample of its schema (or "sample"),
// so the estimate counts the calls a run would make without starting one.
// Token figures are a rough per-effort table, priced with the worker price
// table; the card labels them as rough.

import type { AgentEffortLevel } from "@shared/types";
import { FAST_MODE_COST_NOTE } from "@shared/fast-mode";
import { loomRuntimeForModel } from "@shared/model-catalog";
import { runtimeForWorkerModelId } from "@shared/worker-model-roster";
import type { WorkflowCaps, WorkflowEstimate, WorkflowPhaseMeta } from "@shared/workflow";

import { estimateWorkerCostUsd } from "../model-prices";
import type { SandboxChildScript } from "./workflow-sandbox-protocol";
import type { WorkflowSandbox, WorkflowSandboxOptions } from "./workflow-sandbox";
import { WorkflowRuntime, type WorkflowAgentRequest } from "./workflow-runtime";
import { sampleFromSchema } from "./workflow-schema";

const DRY_RUN_MAX_CALLS = 2_000;
const DRY_RUN_MAX_MS = 2_000;

// Input plus output tokens of one agent, low and high, by effort.
const TOKENS_BY_EFFORT: Record<AgentEffortLevel, [number, number]> = {
  minimal: [8_000, 30_000],
  low: [15_000, 60_000],
  medium: [30_000, 120_000],
  high: [60_000, 250_000],
  xhigh: [100_000, 400_000],
  max: [150_000, 600_000],
};

export interface WorkflowEstimateInput {
  body: string;
  args: unknown;
  children?: Record<string, SandboxChildScript>;
  caps: WorkflowCaps;
  defaults: { model: string; effort: AgentEffortLevel };
  phases?: WorkflowPhaseMeta[];
  /** Models with a usable account; the rest are flagged on the card. */
  connected?: (model: string) => boolean;
  /** Models whose agents inherit fast mode; the card warns before approval. */
  fastMode?: (model: string) => boolean;
  startSandbox?: (options: WorkflowSandboxOptions) => WorkflowSandbox;
}

export async function estimateWorkflow(input: WorkflowEstimateInput): Promise<WorkflowEstimate> {
  const requests: WorkflowAgentRequest[] = [];
  let unbounded = false;
  let runtime: WorkflowRuntime | null = null;
  runtime = new WorkflowRuntime({
    runId: "estimate",
    body: input.body,
    args: input.args,
    children: input.children,
    caps: { ...input.caps, maxAgents: DRY_RUN_MAX_CALLS, concurrency: 16, tokenCeiling: null, usdCeiling: null },
    defaults: input.defaults,
    phases: input.phases,
    journal: { append: () => undefined },
    startSandbox: input.startSandbox,
    executor: {
      run: async (request) => {
        requests.push(request);
        if (requests.length >= DRY_RUN_MAX_CALLS) {
          unbounded = true;
          void runtime?.stop();
        }
        const [low] = TOKENS_BY_EFFORT[request.effort] ?? TOKENS_BY_EFFORT.medium;
        return {
          status: "ok",
          value: request.schema ? sampleFromSchema(request.schema) : "sample",
          usage: { in: Math.round(low * 0.9), out: Math.round(low * 0.1), usd: 0 },
        };
      },
    },
  });
  const timer = setTimeout(() => {
    unbounded = true;
    void runtime?.stop();
  }, DRY_RUN_MAX_MS);
  let outcome: Awaited<ReturnType<WorkflowRuntime["start"]>>;
  try {
    outcome = await runtime.start();
  } finally {
    clearTimeout(timer);
  }

  const phaseCounts = new Map<string, number>();
  for (const phase of input.phases ?? []) phaseCounts.set(phase.title, 0);
  const modelCounts = new Map<string, { model: string; effort: AgentEffortLevel; agents: number }>();
  let isolated = 0;
  let heavy = 0;
  let sharedWriters = false;
  const writersByPhase = new Map<string, number>();
  const tokens = { low: 0, high: 0 };
  const usd = { low: 0, high: 0 };
  for (const request of requests) {
    phaseCounts.set(request.phase, (phaseCounts.get(request.phase) ?? 0) + 1);
    const key = `${request.model}\u0000${request.effort}`;
    const entry = modelCounts.get(key) ?? { model: request.model, effort: request.effort, agents: 0 };
    entry.agents += 1;
    modelCounts.set(key, entry);
    if (request.isolation === "worktree") isolated += 1;
    else if (request.access !== "readonly") {
      const writers = (writersByPhase.get(request.phase) ?? 0) + 1;
      writersByPhase.set(request.phase, writers);
      if (writers > 1) sharedWriters = true;
    }
    if (request.heavy) heavy += 1;
    const [low, high] = TOKENS_BY_EFFORT[request.effort] ?? TOKENS_BY_EFFORT.medium;
    tokens.low += low;
    tokens.high += high;
    const runtimeKind = runtimeForWorkerModelId(request.model) ?? loomRuntimeForModel(request.model);
    const price = (total: number) =>
      estimateWorkerCostUsd({
        runtime: runtimeKind,
        modelHint: request.model,
        estimatedInputTokens: Math.round(total * 0.9),
        estimatedOutputTokens: Math.round(total * 0.1),
      });
    usd.low += price(low);
    usd.high += price(high);
  }

  const warnings: string[] = [];
  const agents = requests.length;
  // Workers inherit the fast-mode setting, and the price table has no fast
  // rate. First, so the consent card's short list of notes always shows it.
  const fastModels = [...new Set([...modelCounts.values()].map((entry) => entry.model))]
    .filter((model) => input.fastMode?.(model));
  if (fastModels.length > 0) {
    warnings.push(
      `Fast mode is on, so agents on ${fastModels.join(", ")} run fast and cost more than this estimate. ${FAST_MODE_COST_NOTE}`,
    );
  }
  if (unbounded) {
    warnings.push(`The dry run did not finish; the run will stop at maxAgents (${input.caps.maxAgents}).`);
  } else if (agents > input.caps.maxAgents) {
    warnings.push(`The dry run issued ${agents} agents but maxAgents is ${input.caps.maxAgents}; later calls will throw.`);
  }
  if (sharedWriters) {
    warnings.push("Several writing agents share the workspace in one phase; consider isolation: 'worktree' or access: 'readonly'.");
  }
  const disconnected = [...modelCounts.values()].filter((entry) => input.connected && !input.connected(entry.model));
  for (const entry of disconnected) warnings.push(`Model ${entry.model} has no connected account.`);
  for (const title of phaseCounts.keys()) {
    if (input.phases && !input.phases.some((phase) => phase.title === title)) {
      warnings.push(`phase("${title}") is not declared in meta.phases.`);
    }
  }

  return {
    agents: Math.min(agents, input.caps.maxAgents),
    unbounded,
    phases: [...phaseCounts.entries()].map(([title, count]) => ({ title, agents: count })),
    models: [...modelCounts.values()].map((entry) => ({
      ...entry,
      connected: input.connected ? input.connected(entry.model) : true,
    })),
    isolated,
    heavy,
    sharedWriters,
    tokens,
    usd: { low: Math.round(usd.low * 100) / 100, high: Math.round(usd.high * 100) / 100 },
    ...(outcome.status === "failed" ? { error: outcome.error } : {}),
    warnings,
  };
}
