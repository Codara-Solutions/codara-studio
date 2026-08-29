// ── Loom inline-node resolution (shared by the engine's two seams) ──────────
// Between worker waves a pass has nodes that launch NO attempt and settle in
// place: MERGE (pure join), GUARD (await a predicate, route pass/fail), and —
// Looms v3 — STEP (run a deterministic action, record its output). Skips
// (branches whose every path went dead) are pruned in the same turn.
//
// This loop used to live inline in run-store.finalizeDirectRun. It is
// extracted here because automation-loop.startIteration needs the SAME
// resolution BEFORE a pass's first worker wave exists: a loom whose entry
// frontier holds a step (or a guard/merge wired straight off the trigger) must
// settle those nodes first, then launch whatever worker wave they make ready —
// or, for a steps-only loom, finish the pass with no worker at all. One
// function, two callers, one behavior.
//
// The projection is mutated in place; the returned lists are what the caller
// persists (run-store writes them into loomPass.nodeStates in its advance
// commit; the loop driver hands them to the launcher as `preResolved`).

import type { LoomGraph, LoomNodeDef, LoomStepResult } from "@shared/types";
import {
  computeSkips,
  mergeOutput,
  readyGuardNodes,
  readyMergeNodes,
  readyStepNodes,
  upstreamOf,
} from "./loom-graph";
import { evaluateGuardPredicate } from "./loom-predicates";
import { executeStep, stepOutcome, type StepContext } from "./loom-steps";

export type ProjectedStatus = "pending" | "skipped" | "running" | "succeeded" | "failed" | "blocked";

export interface ProjectedNode {
  status: ProjectedStatus;
  output?: string;
  branchResult?: "pass" | "fail";
}

export type Projection = Record<string, ProjectedNode>;

export interface ResolvedStep {
  nodeId: string;
  label: string;
  status: "succeeded" | "failed";
  output: string;
  result: LoomStepResult;
}

export interface InlineResolution {
  merges: Array<{ nodeId: string; output: string }>;
  guards: Array<{ nodeId: string; branch: "pass" | "fail"; output: string }>;
  steps: ResolvedStep[];
  /** Node ids newly pruned to "skipped" during this resolution. */
  skipped: string[];
}

/** Live progress of inline STEP nodes: emitted around each executeStep so a
 *  caller can persist "running"/settled node states and stream child output
 *  while a long step (a release build) is still executing. */
export type StepProgressEvent =
  | { kind: "started"; nodeId: string; label: string }
  | { kind: "output"; nodeId: string; chunk: string }
  | { kind: "settled"; nodeId: string; label: string; status: "succeeded" | "failed"; output: string };

export interface InlineContext {
  cwd: string;
  vars: Record<string, string>;
  /** Extra env for step children; the engine stamps run/automation ids. */
  env?: Record<string, string>;
  notify?: StepContext["notify"];
  automationId?: string;
  workspaceId?: string;
  /** Optional live-progress sink; see StepProgressEvent. */
  onStepEvent?: (event: StepProgressEvent) => void;
}

export function emptyResolution(): InlineResolution {
  return { merges: [], guards: [], steps: [], skipped: [] };
}

/** Fold one resolution's lists into an accumulator (the finalize walk runs the
 *  resolution once per outer back-edge turn and persists the union). */
export function appendResolution(into: InlineResolution, add: InlineResolution): void {
  into.merges.push(...add.merges);
  into.guards.push(...add.guards);
  into.steps.push(...add.steps);
  for (const id of add.skipped) if (!into.skipped.includes(id)) into.skipped.push(id);
}

/** Resolve every ready merge, guard and step — repeatedly, until a turn makes
 *  no progress — pruning dead branches between turns. Bounded by the node
 *  count + 1: each inline node resolves at most once (it only leaves "pending"
 *  here) and skips are monotonic. Merges first (pure; a guard downstream of a
 *  merge reads the joined output), then guards, then steps (impure; each may
 *  take real time), then skips. A step's parents' outputs feed its {{node:}}
 *  and {{incoming}} tokens exactly as a worker's would. */
export async function resolveInlineNodes(
  graph: LoomGraph,
  projected: Projection,
  ctx: InlineContext,
): Promise<InlineResolution> {
  const out = emptyResolution();
  const nodeById = new Map<string, LoomNodeDef>(graph.nodes.map((n) => [n.id, n]));
  const outputsOf = (parents: string[]): Record<string, string> => {
    const m: Record<string, string> = {};
    for (const pid of parents) {
      const o = projected[pid]?.output;
      if (o !== undefined) m[pid] = o;
    }
    return m;
  };
  const allOutputs = (): Record<string, string> => {
    const m: Record<string, string> = {};
    for (const [id, ns] of Object.entries(projected)) if (ns.output !== undefined) m[id] = ns.output;
    return m;
  };

  for (let bound = graph.nodes.length + 1; bound >= 0; bound -= 1) {
    let progressed = false;

    for (const mergeId of readyMergeNodes(graph, projected)) {
      const output = mergeOutput(graph, mergeId, projected);
      projected[mergeId] = { status: "succeeded", output };
      out.merges.push({ nodeId: mergeId, output });
      progressed = true;
    }

    for (const guardId of readyGuardNodes(graph, projected)) {
      const parents = upstreamOf(graph, guardId);
      const incomingOutputs = outputsOf(parents);
      const sourceOutput = parents.length > 0 ? (projected[parents[0]]?.output ?? "") : "";
      const node = nodeById.get(guardId);
      const predicate = node && node.kind === "guard" ? node.predicate : undefined;
      const passed = predicate
        ? await evaluateGuardPredicate(predicate, { cwd: ctx.cwd, sourceOutput, incomingOutputs })
        : false;
      const branch: "pass" | "fail" = passed ? "pass" : "fail";
      const output = `guard: ${branch}`;
      projected[guardId] = { status: "succeeded", output, branchResult: branch };
      out.guards.push({ nodeId: guardId, branch, output });
      progressed = true;
    }

    for (const stepId of readyStepNodes(graph, projected)) {
      const node = nodeById.get(stepId);
      if (!node || node.kind !== "step") continue;
      const parents = upstreamOf(graph, stepId);
      const incoming = parents.map((pid) => projected[pid]?.output ?? "");
      const label = node.label?.trim() || stepId;
      ctx.onStepEvent?.({ kind: "started", nodeId: stepId, label });
      const result = await executeStep(node, {
        cwd: ctx.cwd,
        vars: ctx.vars,
        nodeOutputs: allOutputs(),
        incoming,
        notify: ctx.notify,
        env: { ...(ctx.env ?? {}), SPARK_NODE_ID: node.id },
        automationId: ctx.automationId,
        workspaceId: ctx.workspaceId,
        onOutput: ctx.onStepEvent
          ? (chunk) => ctx.onStepEvent?.({ kind: "output", nodeId: stepId, chunk })
          : undefined,
      });
      const outcome = stepOutcome(node, result);
      projected[stepId] = { status: outcome.status, output: outcome.output };
      ctx.onStepEvent?.({
        kind: "settled",
        nodeId: stepId,
        label,
        status: outcome.status,
        output: outcome.output,
      });
      out.steps.push({
        nodeId: stepId,
        label,
        status: outcome.status,
        output: outcome.output,
        result,
      });
      progressed = true;
    }

    const skips = computeSkips(graph, projected);
    for (const id of skips) {
      projected[id] = { ...(projected[id] ?? { status: "pending" }), status: "skipped" };
      if (!out.skipped.includes(id)) out.skipped.push(id);
      progressed = true;
    }

    if (!progressed) break;
  }
  return out;
}

/** The transcript note a settled step leaves — the same contract a worker's
 *  summary note has (automation-loop reads the LAST spark note as the pass
 *  summary, so a sink step's output becomes {{lastOutput}}). */
export function stepNoteMessage(step: ResolvedStep): string {
  if (step.status === "failed") return `Step "${step.label}" failed:\n${step.output}`.trimEnd();
  return step.output.trim().length > 0 ? step.output : `Step "${step.label}" finished with no output.`;
}
