import type {
  AgentEffortLevel,
  AgentRuntimeDiagnostic,
  AutomationLoop,
  AutomationLoopKind,
  AutomationTrigger,
  FolderTriggerEvent,
  GuardPredicate,
  LoomEdgeDef,
  LoomEngine,
  LoomGraph,
  LoomGuardNode,
  LoomMergeNode,
  LoomNodeDef,
  LoomWorkerConfig,
  LoomWorkerNode,
  ScheduledJob,
  StopConditions,
} from "@shared/types";
import type { Edge, Node } from "@xyflow/react";
import type { LoomPreset } from "./presets";

// The node-flow editor's data model. The TRIGGER + LOOP live OFF the graph
// (job.trigger / job.loop); the graph holds the worker/guard/merge pipeline.
// This module owns the draft<->persisted translation, the graph<->ReactFlow
// translation, and validation.

// ── legacy linear-node kinds (still used by validateNode + the trigger form) ──
export type LoomNodeKind = "trigger" | "loop" | "worker";
export const NODE_ORDER: LoomNodeKind[] = ["trigger", "loop", "worker"];

export interface TriggerDraft {
  kind: AutomationTrigger["kind"];
  cronExpr: string;
  cronTz: string;
  intervalMin: string;
  folderPath: string;
  folderGlob: string;
  folderEvents: Record<FolderTriggerEvent, boolean>;
  chainSourceId: string;
}

export interface LoopDraft {
  kind: AutomationLoopKind;
  countN: string;
  cadenceMin: string;
  isolate: boolean;
  maxIters: string;
  budget: string;
  untilTests: boolean;
  testCommand: string;
  untilGit: boolean;
  untilPhrase: string;
  untilCommand: string;
  template: string;
}

export interface WorkerDraft {
  engine: LoomEngine;
  model: string; // concrete engine-native model id — never blank
  effort: AgentEffortLevel; // concrete — never blank
  timeoutMin: string; // "" = engine default (60)
}

// Every worker must carry a concrete engine, model, and effort — "auto" and
// blank ("CLI default"/"default") no longer exist as choices. These are the
// pre-selections a fresh worker (or a legacy "auto"/blank one loaded for
// editing) resolves to, mirroring automation-loop's runtime resolution so what
// the editor shows matches what would run.
export const DEFAULT_ENGINE_MODEL: Record<LoomEngine, string> = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.5",
};
export const DEFAULT_WORKER_EFFORT: AgentEffortLevel = "medium";

/** A worker config guaranteed concrete: a real engine (never "auto") and a
 *  non-blank model/effort. */
export type ConcreteWorkerConfig = LoomWorkerConfig & {
  engine: LoomEngine;
  model: string;
  effort: AgentEffortLevel;
};

/** Resolve a possibly-legacy worker config (engine "auto", or a blank
 *  model/effort) to concrete display values. Mirrors automation-loop.resolveWorker:
 *  "auto" → claude when installed, else codex (else claude as a last resort so
 *  the select is never blank); a blank model/effort fills the engine's concrete
 *  default. The returned config never has engine "auto" nor a blank model/effort. */
export function concreteWorker(
  worker: LoomWorkerConfig,
  installed: Set<LoomEngine>,
): ConcreteWorkerConfig {
  const engine: LoomEngine =
    worker.engine === "claude" || worker.engine === "codex"
      ? worker.engine
      : installed.has("claude")
        ? "claude"
        : installed.has("codex")
          ? "codex"
          : "claude";
  return {
    ...worker,
    engine,
    model: worker.model && worker.model.trim() ? worker.model : DEFAULT_ENGINE_MODEL[engine],
    effort: worker.effort ?? DEFAULT_WORKER_EFFORT,
  };
}

/** The concrete default worker for a fresh node/loom, engine chosen from what's
 *  installed (claude-if-installed, else codex). */
export function defaultWorker(installed: Set<LoomEngine>): ConcreteWorkerConfig {
  return concreteWorker({ engine: "auto" }, installed);
}

function workerDraftFrom(worker: LoomWorkerConfig, installed: Set<LoomEngine>): Pick<WorkerDraft, "engine" | "model" | "effort"> {
  const c = concreteWorker(worker, installed);
  return { engine: c.engine, model: c.model, effort: c.effort };
}

export interface LoomDraft {
  name: string;
  trigger: TriggerDraft;
  loop: LoopDraft;
  worker: WorkerDraft;
}

export function emptyDraft(installed: Set<LoomEngine> = new Set()): LoomDraft {
  const w = workerDraftFrom({ engine: "auto" }, installed);
  return {
    name: "",
    trigger: {
      kind: "manual",
      cronExpr: "0 2 * * *",
      cronTz: "",
      intervalMin: "30",
      folderPath: "",
      folderGlob: "",
      folderEvents: { add: true, change: true, unlink: false },
      chainSourceId: "",
    },
    loop: {
      kind: "once",
      countN: "5",
      cadenceMin: "10",
      isolate: false,
      maxIters: "",
      budget: "",
      untilTests: false,
      testCommand: "npm test",
      untilGit: false,
      untilPhrase: "",
      untilCommand: "",
      template: "",
    },
    worker: { engine: w.engine, model: w.model, effort: w.effort, timeoutMin: "" },
  };
}

export function draftFromJob(job: ScheduledJob, installed: Set<LoomEngine> = new Set()): LoomDraft {
  const d = emptyDraft(installed);
  d.name = job.name;
  d.trigger.kind = job.trigger.kind;
  if (job.trigger.kind === "cron") {
    d.trigger.cronExpr = job.trigger.expr;
    d.trigger.cronTz = job.trigger.tz ?? "";
  } else if (job.trigger.kind === "interval") {
    d.trigger.intervalMin = String(job.trigger.everyMs / 60_000);
  } else if (job.trigger.kind === "folder") {
    d.trigger.folderPath = job.trigger.path;
    d.trigger.folderGlob = job.trigger.glob ?? "";
    d.trigger.folderEvents = {
      add: job.trigger.events.includes("add"),
      change: job.trigger.events.includes("change"),
      unlink: job.trigger.events.includes("unlink"),
    };
  } else if (job.trigger.kind === "onFinishOf") {
    d.trigger.chainSourceId = job.trigger.automationId;
  }

  // `stop` is contractually backfilled by the scheduler, but a malformed
  // persisted job must degrade to defaults here, not crash the editor.
  const stop = job.loop.stop ?? {};
  d.loop.kind = job.loop.kind;
  if (job.loop.kind === "count") d.loop.countN = String(stop.maxIterations ?? 5);
  if (job.loop.everyMs) d.loop.cadenceMin = String(job.loop.everyMs / 60_000);
  d.loop.isolate = Boolean(job.loop.isolate);
  if (stop.maxIterations !== undefined && job.loop.kind !== "count") {
    d.loop.maxIters = String(stop.maxIterations);
  }
  if (stop.budgetUsd !== undefined) d.loop.budget = String(stop.budgetUsd);
  d.loop.untilTests = Boolean(stop.untilTestsPass);
  d.loop.testCommand = stop.testCommand ?? "npm test";
  d.loop.untilGit = Boolean(stop.untilGitClean);
  d.loop.untilPhrase = stop.untilPhrase ?? "";
  d.loop.untilCommand = stop.untilCommand ?? "";
  d.loop.template = job.prompt?.template ?? job.input.initialUserNote ?? "";

  const jw = workerDraftFrom(job.worker ?? { engine: "auto" }, installed);
  d.worker.engine = jw.engine;
  d.worker.model = jw.model;
  d.worker.effort = jw.effort;
  d.worker.timeoutMin =
    job.worker?.timeoutMinutes !== undefined ? String(job.worker.timeoutMinutes) : "";
  return d;
}

export function applyPresetToDraft(
  draft: LoomDraft,
  preset: LoomPreset,
  cwd: string,
  installed: Set<LoomEngine> = new Set(),
): LoomDraft {
  const pw = workerDraftFrom(preset.worker, installed);
  const next: LoomDraft = {
    ...draft,
    trigger: { ...draft.trigger, kind: preset.trigger.kind },
    loop: { ...draft.loop, kind: preset.loop.kind },
    worker: {
      engine: pw.engine,
      model: pw.model,
      effort: pw.effort,
      timeoutMin: preset.worker.timeoutMinutes !== undefined ? String(preset.worker.timeoutMinutes) : "",
    },
  };
  if (preset.trigger.kind === "cron") {
    next.trigger.cronExpr = preset.trigger.expr;
    next.trigger.cronTz = preset.trigger.tz ?? "";
  }
  if (preset.trigger.kind === "folder") {
    next.trigger.folderPath = preset.trigger.path || cwd;
  }
  if (typeof preset.loop.stop.maxIterations === "number") {
    next.loop.maxIters = String(preset.loop.stop.maxIterations);
  }
  if (typeof preset.loop.stop.budgetUsd === "number") {
    next.loop.budget = String(preset.loop.stop.budgetUsd);
  }
  next.loop.untilTests = Boolean(preset.loop.stop.untilTestsPass);
  if (preset.loop.stop.testCommand) next.loop.testCommand = preset.loop.stop.testCommand;
  next.loop.template = preset.promptHint;
  return next;
}

// ── draft → persisted shapes ─────────────────────────────────────────────────

export function buildTrigger(d: TriggerDraft): AutomationTrigger | null {
  switch (d.kind) {
    case "cron": {
      const expr = d.cronExpr.trim();
      if (!expr) return null;
      const tz = d.cronTz.trim();
      return tz ? { kind: "cron", expr, tz } : { kind: "cron", expr };
    }
    case "interval": {
      const m = Number(d.intervalMin);
      if (!Number.isFinite(m) || m <= 0) return null;
      return { kind: "interval", everyMs: Math.round(m * 60_000) };
    }
    case "folder": {
      const path = d.folderPath.trim();
      if (!path) return null;
      const events = (["add", "change", "unlink"] as FolderTriggerEvent[]).filter(
        (e) => d.folderEvents[e],
      );
      if (events.length === 0) return null;
      const glob = d.folderGlob.trim();
      return glob ? { kind: "folder", path, events, glob } : { kind: "folder", path, events };
    }
    case "continuous":
      return { kind: "continuous" };
    case "onFinishOf": {
      const sourceId = d.chainSourceId.trim();
      if (!sourceId) return null;
      return { kind: "onFinishOf", automationId: sourceId };
    }
    default:
      return { kind: "manual" };
  }
}

export function buildLoop(d: LoopDraft): AutomationLoop {
  const stop: StopConditions = {};
  const mi = Number(d.maxIters);
  if (d.maxIters.trim() && Number.isFinite(mi) && mi > 0) stop.maxIterations = Math.round(mi);
  const b = Number(d.budget);
  if (d.budget.trim() && Number.isFinite(b) && b > 0) stop.budgetUsd = b;
  if (d.untilTests) {
    stop.untilTestsPass = true;
    if (d.testCommand.trim()) stop.testCommand = d.testCommand.trim();
  }
  if (d.untilGit) stop.untilGitClean = true;
  if (d.untilPhrase.trim()) stop.untilPhrase = d.untilPhrase.trim();
  if (d.untilCommand.trim()) stop.untilCommand = d.untilCommand.trim();
  // count uses maxIterations as its target.
  if (d.kind === "count") {
    const n = Number(d.countN);
    if (Number.isFinite(n) && n > 0) stop.maxIterations = Math.round(n);
  }
  const loop: AutomationLoop = { kind: d.kind, stop, isolate: d.isolate };
  if (d.kind === "cadence") {
    const m = Number(d.cadenceMin);
    loop.everyMs = Math.round((Number.isFinite(m) && m > 0 ? m : 10) * 60_000);
  }
  return loop;
}

export function buildWorker(d: WorkerDraft): LoomWorkerConfig {
  // engine/model/effort are always concrete in the draft — persist them all.
  const worker: LoomWorkerConfig = { engine: d.engine, model: d.model.trim(), effort: d.effort };
  const t = Number(d.timeoutMin);
  if (d.timeoutMin.trim() && Number.isFinite(t) && t > 0) worker.timeoutMinutes = Math.round(t);
  return worker;
}

// ── validation (per-node, used by the trigger form + footer hints) ───────────
// Returns the node's first problem as user-facing text, or null when valid.

export function validateNode(
  kind: LoomNodeKind,
  draft: LoomDraft,
  ctx: { chainableCount: number; runtimes: AgentRuntimeDiagnostic[] },
): string | null {
  if (kind === "trigger") {
    const t = draft.trigger;
    if (t.kind === "cron" && !t.cronExpr.trim()) return "Cron needs an expression.";
    if (t.kind === "interval") {
      const m = Number(t.intervalMin);
      if (!Number.isFinite(m) || m <= 0) return "Interval needs minutes > 0.";
    }
    if (t.kind === "folder") {
      if (!t.folderPath.trim()) return "Folder trigger needs a path.";
      if (!t.folderEvents.add && !t.folderEvents.change && !t.folderEvents.unlink) {
        return "Folder trigger needs at least one event.";
      }
    }
    if (t.kind === "onFinishOf") {
      if (ctx.chainableCount === 0) return "No other loom to chain after yet.";
      if (!t.chainSourceId.trim()) return "Pick the loom to chain after.";
    }
    return null;
  }
  if (kind === "loop") {
    if (draft.loop.kind === "count") {
      const n = Number(draft.loop.countN);
      if (!Number.isFinite(n) || n <= 0) return "N times needs a count > 0.";
    }
    if (draft.loop.kind === "cadence") {
      const m = Number(draft.loop.cadenceMin);
      if (!Number.isFinite(m) || m <= 0) return "Cadence needs minutes > 0.";
    }
    return null;
  }
  // worker
  const installed = installedEngines(ctx.runtimes);
  if (installed.size === 0) return "Install Claude Code or Codex to run looms.";
  if (!installed.has(draft.worker.engine)) {
    return `${draft.worker.engine === "claude" ? "Claude Code" : "Codex"} is not installed/enabled.`;
  }
  return null;
}

export function installedEngines(runtimes: AgentRuntimeDiagnostic[]): Set<LoomEngine> {
  return new Set(
    runtimes
      .filter(
        (r) => (r.kind === "claude" || r.kind === "codex") && r.installed && !r.disabledBySettings,
      )
      .map((r) => r.kind as LoomEngine),
  );
}

// ── ReactFlow node/edge payloads ─────────────────────────────────────────────
// The trigger node is a pinned, read-only ReactFlow node (id TRIGGER_ID) that
// is NOT part of graph.nodes — it mirrors job.trigger. graphFromFlow strips it.

export const TRIGGER_ID = "__trigger__";

/** Per-node config carried on a ReactFlow node's `data`. The node `id` is the
 *  LoomNodeDef.id (or TRIGGER_ID for the pinned trigger). */
export type FlowNodeData =
  | {
      kind: "trigger";
      label: string;
    }
  | {
      kind: "worker";
      label: string;
      worker: LoomWorkerConfig;
      prompt: string;
      isolate?: boolean;
      retry?: { maxAttempts: number; until?: GuardPredicate };
    }
  | {
      kind: "guard";
      label: string;
      predicate: GuardPredicate;
    }
  | {
      kind: "merge";
      label: string;
      joinMode: "all" | "any";
    };

export type FlowNode = Node<FlowNodeData & Record<string, unknown>>;
export type FlowEdge = Edge<{ branch?: "pass" | "fail"; backEdge?: boolean; visitCap?: number } & Record<string, unknown>>;

export type LoomGraphNodeKind = "worker" | "guard" | "merge";

let idSeq = 0;
/** A short, stable-enough id for a freshly added node/edge. */
export function freshId(prefix: string): string {
  idSeq += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${(idSeq % 1000).toString(36)}`;
}

export function defaultNodeData(kind: LoomGraphNodeKind, installed: Set<LoomEngine> = new Set()): FlowNodeData {
  switch (kind) {
    case "worker":
      return {
        kind: "worker",
        label: "Worker",
        worker: defaultWorker(installed),
        prompt: "",
      };
    case "guard":
      return {
        kind: "guard",
        label: "Guard",
        predicate: { type: "tests", command: "npm test" },
      };
    case "merge":
      return { kind: "merge", label: "Merge", joinMode: "all" };
  }
}

// ── graph → flow ─────────────────────────────────────────────────────────────

const LAYER_DX = 280;
const LAYER_DY = 150;
const ORIGIN_X = 40;
const ORIGIN_Y = 40;

/** Build the ReactFlow nodes/edges for a job. The trigger is rendered as a
 *  pinned read-only node wired to each entry node. Positions come from
 *  node.ui when present; missing ones get a simple layered auto-layout. */
export function flowFromGraph(
  job: ScheduledJob,
  installed: Set<LoomEngine> = new Set(),
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const graph = graphForJob(job);
  const layout = layeredPositions(graph);

  const nodes: FlowNode[] = [];

  // The pinned trigger node — read-only, mirrors job.trigger. Placed one layer
  // LEFT of the leftmost entry node (not at a fixed origin): persisted ui
  // positions are honored verbatim below, so a graph whose nodes sit at/near
  // the canvas origin would otherwise render the trigger overlapping its own
  // entry node with the wire running backwards.
  nodes.push({
    id: TRIGGER_ID,
    type: "trigger",
    position: triggerPosition(graph, layout),
    data: { kind: "trigger", label: "Trigger" },
    draggable: true,
    deletable: false,
  });

  for (const n of graph.nodes) {
    const pos =
      n.ui && Number.isFinite(n.ui.x) && Number.isFinite(n.ui.y)
        ? { x: n.ui.x, y: n.ui.y }
        : (layout.get(n.id) ?? { x: ORIGIN_X + LAYER_DX, y: ORIGIN_Y });
    nodes.push({
      id: n.id,
      type: n.kind,
      position: pos,
      data: nodeDataFromDef(n, installed),
    });
  }

  const edges: FlowEdge[] = [];
  // Trigger → entry nodes.
  for (const entry of graph.entryNodeIds) {
    if (!graph.nodes.some((n) => n.id === entry)) continue;
    edges.push({
      id: `e-trigger-${entry}`,
      source: TRIGGER_ID,
      target: entry,
      type: "loom",
    });
  }
  for (const e of graph.edges) {
    const sourceHandle = e.branch ? e.branch : undefined;
    edges.push({
      id: e.id,
      source: e.from,
      target: e.to,
      sourceHandle,
      type: "loom",
      data: { branch: e.branch, backEdge: e.backEdge, visitCap: e.visitCap },
    });
  }
  return { nodes, edges };
}

function nodeDataFromDef(
  n: LoomNodeDef,
  installed: Set<LoomEngine> = new Set(),
): FlowNodeData & Record<string, unknown> {
  switch (n.kind) {
    case "worker":
      return {
        kind: "worker",
        label: n.label ?? "Worker",
        // Concretize legacy "auto"/blank workers for display so what the editor
        // shows matches what would run. Persisted only when the user next saves.
        worker: concreteWorker(n.worker, installed),
        prompt: n.prompt,
        isolate: n.isolate,
        retry: n.retry,
      };
    case "guard":
      return { kind: "guard", label: n.label ?? "Guard", predicate: n.predicate };
    case "merge":
      return { kind: "merge", label: n.label ?? "Merge", joinMode: n.joinMode };
  }
}

/** The graph a job presents to the editor: the explicit job.graph, else a
 *  single w0 worker node derived from the legacy flat fields. */
export function graphForJob(job: ScheduledJob): LoomGraph {
  if (job.graph && job.graph.nodes.length > 0) return job.graph;
  const w0: LoomWorkerNode = {
    id: "w0",
    kind: "worker",
    label: "Worker",
    worker: job.worker ?? { engine: "auto" },
    prompt: job.prompt?.template ?? job.input?.initialUserNote ?? "",
  };
  return { version: 1, nodes: [w0], edges: [], entryNodeIds: ["w0"] };
}

// Simple layered (longest-path) auto-layout used only when a node lacks ui.
function layeredPositions(graph: LoomGraph): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const incoming = new Map<string, string[]>();
  for (const n of graph.nodes) incoming.set(n.id, []);
  for (const e of graph.edges) {
    if (e.backEdge) continue;
    if (incoming.has(e.to)) incoming.get(e.to)!.push(e.from);
  }
  // depth = longest path from an entry; memoized, cycle-safe.
  const depth = new Map<string, number>();
  const seen = new Set<string>();
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const preds = incoming.get(id) ?? [];
    const entries = graph.entryNodeIds.includes(id);
    let d = entries ? 0 : 1;
    for (const p of preds) d = Math.max(d, depthOf(p) + 1);
    depth.set(id, d);
    seen.delete(id);
    return d;
  };
  const byLayer = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const d = depthOf(n.id);
    if (!byLayer.has(d)) byLayer.set(d, []);
    byLayer.get(d)!.push(n.id);
  }
  for (const [layer, ids] of byLayer) {
    ids.forEach((id, i) => {
      out.set(id, {
        x: ORIGIN_X + LAYER_DX * (layer + 1),
        y: ORIGIN_Y + LAYER_DY * i,
      });
    });
  }
  return out;
}

function triggerPosition(
  graph: LoomGraph,
  layout: Map<string, { x: number; y: number }>,
): { x: number; y: number } {
  // One layer left of the leftmost entry node, vertically centered against
  // the entry nodes — wherever the user (or an authoring agent) put them.
  const pts: { x: number; y: number }[] = [];
  for (const entry of graph.entryNodeIds) {
    const def = graph.nodes.find((n) => n.id === entry);
    const pos =
      def?.ui && Number.isFinite(def.ui.x) && Number.isFinite(def.ui.y)
        ? def.ui
        : layout.get(entry);
    if (pos) pts.push(pos);
  }
  if (pts.length === 0) return { x: ORIGIN_X, y: ORIGIN_Y };
  return {
    x: Math.min(...pts.map((p) => p.x)) - LAYER_DX,
    y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
  };
}

// ── flow → graph ─────────────────────────────────────────────────────────────

/** Build a LoomGraph from the ReactFlow nodes/edges. The trigger node is
 *  stripped; edges out of it become entryNodeIds. Back-edges are detected and
 *  flagged. ui positions are persisted. */
export function graphFromFlow(nodes: FlowNode[], edges: FlowEdge[]): LoomGraph {
  const graphNodes: LoomNodeDef[] = [];
  for (const n of nodes) {
    if (n.id === TRIGGER_ID) continue;
    const d = n.data;
    const ui = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    if (d.kind === "worker") {
      const def: LoomWorkerNode = {
        id: n.id,
        kind: "worker",
        worker: d.worker,
        prompt: d.prompt,
        ui,
      };
      if (d.label && d.label !== "Worker") def.label = d.label;
      if (d.isolate) def.isolate = true;
      if (d.retry && d.retry.maxAttempts > 0) def.retry = d.retry;
      graphNodes.push(def);
    } else if (d.kind === "guard") {
      const def: LoomGuardNode = { id: n.id, kind: "guard", predicate: d.predicate, ui };
      if (d.label && d.label !== "Guard") def.label = d.label;
      graphNodes.push(def);
    } else if (d.kind === "merge") {
      const def: LoomMergeNode = { id: n.id, kind: "merge", joinMode: d.joinMode, ui };
      if (d.label && d.label !== "Merge") def.label = d.label;
      graphNodes.push(def);
    }
  }

  const entryNodeIds: string[] = [];
  const graphEdges: LoomEdgeDef[] = [];
  for (const e of edges) {
    if (e.source === TRIGGER_ID) {
      if (!entryNodeIds.includes(e.target)) entryNodeIds.push(e.target);
      continue;
    }
    if (e.target === TRIGGER_ID) continue; // never legal
    const branch = (e.sourceHandle === "pass" || e.sourceHandle === "fail"
      ? e.sourceHandle
      : e.data?.branch) as "pass" | "fail" | undefined;
    const def: LoomEdgeDef = { id: e.id, from: e.source, to: e.target };
    if (branch) def.branch = branch;
    if (e.data?.backEdge) {
      def.backEdge = true;
      def.visitCap = e.data?.visitCap ?? 10;
    }
    graphEdges.push(def);
  }

  // Mark back-edges (target is an ancestor of source via forward edges) and
  // default their visitCap. Re-run ancestry on the forward subset.
  markBackEdges(graphEdges);

  return { version: 1, nodes: graphNodes, edges: graphEdges, entryNodeIds };
}

/** In place: set backEdge:true + visitCap on every edge whose target is an
 *  ancestor of its source through the forward (non-backEdge) edges. Iterates to
 *  a fixed point so a chain of loop-backs all get flagged. */
export function markBackEdges(edges: LoomEdgeDef[]): void {
  // Iterate: an edge is a back-edge if its target reaches its source using
  // only the edges currently considered forward.
  let changed = true;
  let guard = 0;
  while (changed && guard < edges.length + 2) {
    changed = false;
    guard += 1;
    const forward = edges.filter((e) => !e.backEdge);
    for (const e of edges) {
      if (e.backEdge) continue;
      // Does `e.to` reach `e.from` over forward edges excluding `e` itself?
      if (reaches(e.to, e.from, forward, e.id)) {
        e.backEdge = true;
        if (e.visitCap === undefined) e.visitCap = 10;
        changed = true;
      }
    }
  }
}

function reaches(from: string, to: string, edges: LoomEdgeDef[], excludeId: string): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.id === excludeId) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}

// ── graph validation ─────────────────────────────────────────────────────────

export interface GraphProblem {
  message: string;
  /** node or edge id to focus when clicked, if any. */
  focusNodeId?: string;
}

/** Returns the FIRST graph problem, or null when the graph is sound. Cycles are
 *  allowed; an unmarked back-edge or a back-edge missing visitCap is a fixable
 *  warning. */
export function validateGraph(
  nodes: FlowNode[],
  edges: FlowEdge[],
): GraphProblem | null {
  const workerNodes = nodes.filter((n) => n.data.kind === "worker");
  if (workerNodes.length === 0) {
    return { message: "Add at least one Worker node." };
  }

  // Every worker needs a non-empty prompt.
  for (const n of workerNodes) {
    if (n.data.kind === "worker" && !n.data.prompt.trim()) {
      return { message: `Worker "${n.data.label}" needs a prompt.`, focusNodeId: n.id };
    }
  }

  // Build the persisted graph to reuse back-edge detection / ancestry.
  const graph = graphFromFlow(nodes, edges);

  // Back-edge integrity: every edge whose target is an ancestor of its source
  // (a true cycle) must be marked backEdge with a visitCap.
  const forward = graph.edges.filter((e) => !e.backEdge);
  for (const e of graph.edges) {
    if (e.backEdge) {
      if (e.visitCap === undefined || e.visitCap <= 0) {
        return {
          message: "A loop-back edge needs a visit cap > 0.",
          focusNodeId: e.from,
        };
      }
      continue;
    }
    // An unmarked edge that closes a cycle should have been flagged by
    // graphFromFlow; surface it as fixable if it slipped through.
    if (reaches(e.to, e.from, forward, e.id)) {
      return {
        message: "A loop-back edge must be marked (set a visit cap).",
        focusNodeId: e.from,
      };
    }
  }

  // No fully-orphaned nodes (no inbound and no outbound, and not an entry).
  for (const n of graph.nodes) {
    const wired =
      graph.entryNodeIds.includes(n.id) ||
      graph.edges.some((e) => e.from === n.id || e.to === n.id);
    if (!wired) {
      const label = labelForNode(nodes, n.id);
      return { message: `Node "${label}" isn't connected to anything.`, focusNodeId: n.id };
    }
  }

  // A guard needs AT LEAST ONE branch wired: the engine treats an unwired branch
  // as a terminal route (e.g. the shipped "fix until tests pass" preset leaves
  // pass unwired so a green run ends the pass), so requiring BOTH would brick
  // that preset. Only a guard with NEITHER branch wired is a real error.
  for (const n of graph.nodes) {
    if (n.kind !== "guard") continue;
    const outs = graph.edges.filter((e) => e.from === n.id);
    const hasPass = outs.some((e) => e.branch === "pass");
    const hasFail = outs.some((e) => e.branch === "fail");
    if (!hasPass && !hasFail) {
      return {
        message: `Guard "${labelForNode(nodes, n.id)}" needs at least one branch (pass or fail) wired.`,
        focusNodeId: n.id,
      };
    }
  }

  // At least one entry node (something wired from the trigger).
  if (graph.entryNodeIds.length === 0) {
    return { message: "Wire the trigger into the first node." };
  }

  return null;
}

function labelForNode(nodes: FlowNode[], id: string): string {
  const n = nodes.find((x) => x.id === id);
  return (n?.data.label as string) ?? id;
}

/** The terminal worker node (a worker with no outgoing forward edge to another
 *  node) whose prompt/worker mirror the legacy flat fields. Falls back to the
 *  last worker. */
export function sinkWorkerNode(nodes: FlowNode[], edges: FlowEdge[]): FlowNode | null {
  const workers = nodes.filter((n) => n.data.kind === "worker");
  if (workers.length === 0) return null;
  const forwardOut = (id: string): boolean =>
    edges.some((e) => e.source === id && e.target !== TRIGGER_ID && !e.data?.backEdge);
  const sinks = workers.filter((w) => !forwardOut(w.id));
  if (sinks.length > 0) {
    // Prefer the lowest-on-canvas sink for determinism.
    return sinks.sort((a, b) => b.position.y - a.position.y || b.position.x - a.position.x)[0];
  }
  return workers[workers.length - 1];
}

/** Reachable-node ids upstream of `nodeId` over forward edges — used for the
 *  {{node:<id>}} autocomplete (only ancestors are referenceable). */
export function upstreamNodeIds(nodeId: string, edges: FlowEdge[]): string[] {
  const adj = new Map<string, string[]>(); // target -> sources
  for (const e of edges) {
    if (e.source === TRIGGER_ID || e.data?.backEdge) continue;
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.target)!.push(e.source);
  }
  const out = new Set<string>();
  const stack = [...(adj.get(nodeId) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const p of adj.get(cur) ?? []) stack.push(p);
  }
  return [...out];
}
