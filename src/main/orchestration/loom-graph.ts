// ── Loom graph planning (pure, dependency-free) ─────────────────────────────
// Topological layering over a loom's node graph. Kept free of any imports from
// run-store / electron / event-log so it can be unit-tested in isolation and so
// later slices can grow prune/mergeReady/render helpers here without dragging
// the orchestrator's transitive deps into a leaf module.
//
// Execution model (see LoomGraph in @shared/types): ONE RunState per loom PASS;
// nodes execute as worker attempts within that one run; the autopilot join
// barrier is the wave/layer boundary. planLoomLayers groups nodes into the
// waves the executor launches in order — each wave is the set of nodes whose
// forward-edge prerequisites have all completed.

import type { LoomEdgeDef, LoomGraph } from "@shared/types";

/** Kahn topological layering over the graph's FORWARD edges (edges with
 *  backEdge===true are loop-closing edges handled separately by slice 6's
 *  bounded-cycle machinery — armedBackEdges / backEdgesToFire — and are ignored
 *  here so the forward graph stays acyclic and layerable). Returns the waves to
 *  launch in order plus a flat launch order
 *  (layers concatenated). A 1-node / 0-edge graph yields {layers:[["w0"]],
 *  order:["w0"]} — the degenerate single-node loom the executor walks today.
 *
 *  Defensive against malformed graphs: edges referencing unknown nodes are
 *  dropped, and any nodes left unreachable by a cycle of forward edges are
 *  emitted as a trailing layer (so they are never silently lost). */
export function planLoomLayers(graph: LoomGraph): { layers: string[][]; order: string[] } {
  const nodeIds = graph.nodes.map((n) => n.id);
  const known = new Set(nodeIds);

  // Forward edges only; ignore back-edges and edges touching unknown nodes.
  const forward = graph.edges.filter(
    (e) => e.backEdge !== true && known.has(e.from) && known.has(e.to),
  );

  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    indegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const edge of forward) {
    adjacency.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const layers: string[][] = [];
  const order: string[] = [];
  const placed = new Set<string>();
  // Stable wave ordering: preserve the node array's order within each layer.
  let frontier = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);

  while (frontier.length > 0) {
    layers.push(frontier);
    for (const id of frontier) {
      placed.add(id);
      order.push(id);
    }
    const next: string[] = [];
    for (const id of frontier) {
      for (const to of adjacency.get(id) ?? []) {
        const remaining = (indegree.get(to) ?? 0) - 1;
        indegree.set(to, remaining);
        if (remaining === 0 && !placed.has(to)) next.push(to);
      }
    }
    frontier = next;
  }

  // Any node not placed is trapped in a forward cycle (shouldn't happen for the
  // acyclic forward graph this slice produces, but never drop a node): emit the
  // remainder as one trailing layer so the executor still accounts for them.
  const leftover = nodeIds.filter((id) => !placed.has(id));
  if (leftover.length > 0) {
    layers.push(leftover);
    for (const id of leftover) order.push(id);
  }

  return { layers, order };
}

/** The SINK nodes of the graph: nodes with NO forward-outgoing edge (the pass's
 *  terminal nodes — nothing runs after them on a live path). Computed over
 *  FORWARD edges only (back-edges loop earlier, so a node that is only a
 *  back-edge source is still a sink). Used by the pass-level "agent" loop to read
 *  ONLY the terminal worker's continue/stop decision in a multi-node wave. A
 *  degenerate single-node loom ({w0}, no edges) yields ["w0"] — its sole node is
 *  the sink, so the agent-loop reads exactly that node's signal, identical to the
 *  legacy unstamped read. Returned in graph node order for determinism. */
export function sinkNodeIds(graph: LoomGraph): string[] {
  const known = new Set(graph.nodes.map((n) => n.id));
  const hasForwardOut = new Set<string>();
  for (const e of graph.edges) {
    if (e.backEdge === true) continue;
    if (!known.has(e.from) || !known.has(e.to)) continue;
    hasForwardOut.add(e.from);
  }
  return graph.nodes.map((n) => n.id).filter((id) => !hasForwardOut.has(id));
}

// ── Slice 3: sequential-chain walk helpers (pure) ────────────────────────────
// The executor (run-store.finalizeDirectRun) is mechanical: it settles a wave,
// records each node's output, then asks THESE functions what to do next. Keeping
// every graph-walk decision here means the single safety net is this module's
// unit tests (the run-store harnesses stub run-store, so they never exercise the
// real walk). A node's lifecycle status lives in RunState.loomPass.nodeStates;
// only the {status} subset matters to the walk, so the helpers take a loose
// Record so the same code serves the executor and the tests.

type NodeStatus = "pending" | "skipped" | "running" | "succeeded" | "failed" | "blocked";
// The walk needs only {status}; mergeOutput additionally reads a succeeded
// node's {output} (optional, so the status-only callers still satisfy it).
// branchResult (slice 5) is read ONLY for guard nodes, to decide which of a
// guard's pass/fail edges are live; absent on workers/merges.
type NodeStateLike = { status: NodeStatus; output?: string; branchResult?: "pass" | "fail" };

/** Forward-edge parents of a node (edges whose `to` is this node, ignoring
 *  back-edges and edges touching unknown nodes — the same edge filter
 *  planLoomLayers uses). The set the executor feeds a launching node as its
 *  upstream `incoming` context. */
export function upstreamOf(graph: LoomGraph, nodeId: string): string[] {
  const known = new Set(graph.nodes.map((n) => n.id));
  if (!known.has(nodeId)) return [];
  const parents: string[] = [];
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (e.backEdge === true) continue;
    if (e.to !== nodeId) continue;
    if (!known.has(e.from)) continue;
    if (seen.has(e.from)) continue;
    seen.add(e.from);
    parents.push(e.from);
  }
  return parents;
}

// ── Slice 5: branch pruning + live-edge readiness (pure) ─────────────────────
// A guard node routes flow down its "pass" or "fail" edges by recording a
// branchResult; the un-taken branch's edges go DEAD and the nodes they sole-feed
// are pruned to "skipped". Readiness/completeness therefore reason over LIVE
// forward edges, not all forward edges. For a graph with no guards (and so no
// branchResult set anywhere) and no skipped nodes, EVERY forward edge is live,
// so these helpers reduce exactly to the slice-3 behavior — the chain/merge/
// single-node parity invariant.

/** A node's FORWARD-incoming edges (edges whose `to` is this node), ignoring
 *  back-edges and edges touching unknown nodes — the same edge filter
 *  planLoomLayers/upstreamOf use, but returning the edges (with their `branch`)
 *  rather than just the parent ids, so liveness can be judged per edge. */
function forwardIncomingEdges(graph: LoomGraph, nodeId: string): LoomEdgeDef[] {
  const known = new Set(graph.nodes.map((n) => n.id));
  if (!known.has(nodeId)) return [];
  const edges: LoomEdgeDef[] = [];
  for (const e of graph.edges) {
    if (e.backEdge === true) continue;
    if (e.to !== nodeId) continue;
    if (!known.has(e.from)) continue;
    edges.push(e);
  }
  return edges;
}

/** True when a node has NO forward-incoming edges — the entry-wave notion the
 *  walk has always used (indegree 0 over forward edges, matching planLoomLayers'
 *  initial frontier). Deliberately derived from the edge set rather than
 *  graph.entryNodeIds so it can't drift from the edges the walk actually reads. */
function isEntryNode(graph: LoomGraph, nodeId: string): boolean {
  return forwardIncomingEdges(graph, nodeId).length === 0;
}

/** Whether a forward edge is still LIVE (can still carry flow to its target).
 *  An edge is DEAD when:
 *   • it is a back-edge (forward-only readiness this slice — slice 6 owns these);
 *   • its source node is "skipped" (a pruned branch carries no flow);
 *   • its source is a GUARD whose branchResult is RECORDED and DIFFERS from the
 *     edge's `branch` (the un-taken branch).
 *  A guard edge with no `branch`, or a guard not yet resolved (no branchResult),
 *  is treated as NOT-yet-dead (live) — pruning only happens once the guard has
 *  routed. A non-guard source's edges are always live (unless skipped/back). */
export function edgeIsLive(
  graph: LoomGraph,
  edge: LoomEdgeDef,
  nodeStates: Record<string, NodeStateLike>,
): boolean {
  if (edge.backEdge === true) return false;
  const src = nodeStates[edge.from];
  if (src?.status === "skipped") return false;
  const srcNode = graph.nodes.find((n) => n.id === edge.from);
  if (srcNode?.kind === "guard") {
    const taken = src?.branchResult;
    if (taken !== undefined && edge.branch !== undefined && edge.branch !== taken) return false;
  }
  return true;
}

/** The node ids that should launch NEXT: every node still "pending" that is
 *  reachable along LIVE forward edges and whose live forward-incoming parents
 *  have ALL "succeeded". Precisely: pending AND every live forward-incoming
 *  edge's source is "succeeded" AND (it is an entry node OR it has ≥1 live
 *  forward-incoming edge). The last clause keeps a node whose ONLY parents are
 *  all dead (a fully-pruned branch) from launching — such a node is instead a
 *  skip candidate (computeSkips). "skipped" nodes are settled: never launched,
 *  never waited on. Returns [] when nothing is ready.
 *
 *  Status comes from `nodeStates`; a node absent from the map is treated as
 *  pending (the seed only records launched nodes, so a not-yet-launched
 *  downstream node has no entry until its wave fires). */
export function nextReadyWave(
  graph: LoomGraph,
  nodeStates: Record<string, NodeStateLike>,
): string[] {
  const statusOf = (id: string): NodeStatus => nodeStates[id]?.status ?? "pending";
  const ready: string[] = [];
  for (const node of graph.nodes) {
    if (statusOf(node.id) !== "pending") continue;
    const liveParents = forwardIncomingEdges(graph, node.id).filter((e) =>
      edgeIsLive(graph, e, nodeStates),
    );
    if (!liveParents.every((e) => statusOf(e.from) === "succeeded")) continue;
    // An entry node (no forward-incoming edges at all) is ready on its own; any
    // other node must still have ≥1 LIVE incoming edge — a node all of whose
    // parents are dead is unreachable and must be skipped, not launched.
    if (isEntryNode(graph, node.id) || liveParents.length > 0) ready.push(node.id);
  }
  return ready;
}

/** Pending nodes that can never become ready because EVERY forward-incoming
 *  edge is dead (the only paths to them were pruned) — they are to be marked
 *  "skipped". Applied TRANSITIVELY: a node skipped here makes its sole-dependents
 *  skippable in turn (their last live parent just died), so the returned list is
 *  the full closure. Entry nodes (no forward-incoming edges) are NEVER skipped —
 *  they have no parent to die. Computed against a working copy so an already-
 *  skipped node feeds the closure without mutating the caller's map. */
export function computeSkips(
  graph: LoomGraph,
  nodeStates: Record<string, NodeStateLike>,
): string[] {
  const statusOf = (id: string): NodeStatus => working[id]?.status ?? "pending";
  // Working projection: skips discovered here are folded in so transitive
  // dependents see their last live parent as "skipped" (a dead edge source).
  const working: Record<string, NodeStateLike> = {};
  for (const [id, ns] of Object.entries(nodeStates)) working[id] = { ...ns };

  const skipped: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (statusOf(node.id) !== "pending") continue;
      if (isEntryNode(graph, node.id)) continue; // entry nodes have no parent to die
      const incoming = forwardIncomingEdges(graph, node.id);
      // All forward-incoming edges dead ⇒ no live path remains ⇒ skip.
      if (incoming.every((e) => !edgeIsLive(graph, e, working))) {
        working[node.id] = { ...(working[node.id] ?? { status: "pending" }), status: "skipped" };
        skipped.push(node.id);
        changed = true;
      }
    }
  }
  return skipped;
}

// ── Slice 6: bounded loop-back cycles (pure) ─────────────────────────────────
// A back-edge (backEdge===true) routes flow from a source S BACK to an earlier
// target T, re-running the loop body (the forward path T..S). Forward readiness
// (edgeIsLive/nextReadyWave/computeSkips) still EXCLUDES back-edges — the cycle
// body's normal forward edges drive readiness; the back-edge is resolved here,
// SEPARATELY, only after the body has settled. Two independent bounds guarantee
// the loop can NEVER run forever (the always-escapable invariant):
//   (1) per-edge visitCap — each back-edge fires at most effectiveVisitCap times
//       (clamped: missing/<=0 → DEFAULT_BACK_EDGE_VISIT_CAP; capped at
//       MAX_BACK_EDGE_VISIT_CAP). run-store tracks visits in
//       loomPass.backEdgeVisits and stops firing once the count reaches the cap.
//   (2) a per-pass total-activation backstop (MAX_PASS_ACTIVATIONS) enforced in
//       run-store: if cumulative worker activations across the pass exceed it the
//       pass is failed outright, defending against pathological multi-back-edge
//       graphs even if a visitCap were mis-set. (Bound (2) lives in run-store
//       because activations are tracked on RunState.loomPass.nodeStates, not in
//       this pure module; documented here so both bounds are visible together.)
// Acyclic graphs have no backEdge===true edge, so armedBackEdges/backEdgesToFire
// return [] and NOTHING resets — the slice-1..5 behavior is byte-identical.

/** Default per-edge fire cap when a back-edge omits visitCap or sets it <=0. */
export const DEFAULT_BACK_EDGE_VISIT_CAP = 10;
/** Hard ceiling on any back-edge's visitCap (defends a mis-set huge cap). */
export const MAX_BACK_EDGE_VISIT_CAP = 1000;

/** The clamped number of times a back-edge may fire: a missing/<=0 visitCap
 *  becomes DEFAULT_BACK_EDGE_VISIT_CAP, and any value is hard-capped at
 *  MAX_BACK_EDGE_VISIT_CAP. Non-integers floor (a visitCap of 2.9 ⇒ 2). */
export function effectiveVisitCap(edge: LoomEdgeDef): number {
  const raw = edge.visitCap;
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_BACK_EDGE_VISIT_CAP;
  return Math.min(Math.floor(raw), MAX_BACK_EDGE_VISIT_CAP);
}

/** Every back-edge in the graph (edges with backEdge===true touching known
 *  nodes). Forward readiness ignores these; slice 6 resolves them here. */
function backEdgesOf(graph: LoomGraph): LoomEdgeDef[] {
  const known = new Set(graph.nodes.map((n) => n.id));
  return graph.edges.filter((e) => e.backEdge === true && known.has(e.from) && known.has(e.to));
}

/** The back-edges whose SOURCE has resolved in a way that ROUTES flow to them —
 *  i.e. the loop is being TAKEN this turn. The arming rule mirrors edgeIsLive's
 *  routing for forward edges, but for the back-edge's source S:
 *   • S is a GUARD → armed iff S.branchResult is recorded AND equals the
 *     back-edge's `branch` (the taken branch is the loop-back); a back-edge with
 *     no `branch` off a guard is NOT armed (a guard must route by branch).
 *   • S is a WORKER or MERGE → armed iff S "succeeded" AND the back-edge has no
 *     `branch` (an unconditional loop-back). A branch on a non-guard back-edge is
 *     meaningless (only guards set branchResult), so it never arms.
 *  A skipped/failed/blocked/pending/running source never arms (the loop body
 *  didn't complete down this path). Armed ≠ fires: backEdgesToFire additionally
 *  gates on the visit counter (an EXHAUSTED armed edge is dead). */
export function armedBackEdges(
  graph: LoomGraph,
  nodeStates: Record<string, NodeStateLike>,
): LoomEdgeDef[] {
  const armed: LoomEdgeDef[] = [];
  for (const e of backEdgesOf(graph)) {
    const src = nodeStates[e.from];
    if (!src) continue;
    const srcNode = graph.nodes.find((n) => n.id === e.from);
    if (srcNode?.kind === "guard") {
      // A guard arms a back-edge only when it routed down THAT branch.
      if (e.branch !== undefined && src.branchResult === e.branch) armed.push(e);
      continue;
    }
    // Worker / merge: an unconditional loop-back fires on success.
    if (e.branch === undefined && src.status === "succeeded") armed.push(e);
  }
  return armed;
}

/** The loop-body node set for a back-edge S→T: every node on a FORWARD path from
 *  the back-edge's target T up to AND INCLUDING its source S (the nodes the loop
 *  re-runs). Pure forward reachability from T over forward edges only (back-edges
 *  — this one and any other — are excluded from the traversal so a nested loop
 *  can't make the body run away), intersected with the set of nodes that can
 *  forward-REACH S (so a sibling branch hanging off T that does NOT lead back to
 *  S is not reset). S itself is always included; T is included iff it lies on
 *  such a path (it does whenever T can reach S, which an armed back-edge implies).
 *  Returns the body in graph node order for determinism. */
export function cycleBodyNodes(graph: LoomGraph, backEdge: LoomEdgeDef): string[] {
  const known = new Set(graph.nodes.map((n) => n.id));
  if (!known.has(backEdge.from) || !known.has(backEdge.to)) return [];
  // Forward adjacency (exclude ALL back-edges) and its reverse, over known nodes.
  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const id of known) {
    fwd.set(id, []);
    rev.set(id, []);
  }
  for (const e of graph.edges) {
    if (e.backEdge === true) continue;
    if (!known.has(e.from) || !known.has(e.to)) continue;
    fwd.get(e.from)!.push(e.to);
    rev.get(e.to)!.push(e.from);
  }
  // Nodes forward-reachable FROM T (descendants of T, T included).
  const fromT = new Set<string>();
  const stackF = [backEdge.to];
  while (stackF.length > 0) {
    const id = stackF.pop()!;
    if (fromT.has(id)) continue;
    fromT.add(id);
    for (const to of fwd.get(id) ?? []) stackF.push(to);
  }
  // Nodes that can forward-REACH S (ancestors of S, S included) — walk reverse.
  const toS = new Set<string>();
  const stackR = [backEdge.from];
  while (stackR.length > 0) {
    const id = stackR.pop()!;
    if (toS.has(id)) continue;
    toS.add(id);
    for (const from of rev.get(id) ?? []) stackR.push(from);
  }
  // The body is the intersection (on a forward path T..S), in graph node order.
  // S is force-included (an armed back-edge's source always re-runs); guarding
  // against a degenerate graph where reverse reachability missed it.
  const body = graph.nodes
    .map((n) => n.id)
    .filter((id) => fromT.has(id) && toS.has(id));
  if (!body.includes(backEdge.from)) body.push(backEdge.from);
  return body;
}

/** Every node FORWARD-reachable from any of `fromIds` (the ids themselves
 *  included), traversing forward edges only (back-edges excluded). Used by
 *  run-store when a loop re-opens: a node that a body guard PRUNED ("skipped") on
 *  the prior turn — e.g. the loop-EXIT branch downstream of the guard — must be
 *  un-skipped back to "pending" so it can be re-reached if the re-run guard routes
 *  to it. cycleBodyNodes (the strict T..S reset set) deliberately excludes such
 *  exit/sibling nodes from re-RUNNING; this returns the wider descendant set whose
 *  stale skips must be cleared so the fresh routing decides them. Returned in
 *  graph node order. */
export function forwardDescendants(graph: LoomGraph, fromIds: string[]): string[] {
  const known = new Set(graph.nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const id of known) adj.set(id, []);
  for (const e of graph.edges) {
    if (e.backEdge === true) continue;
    if (!known.has(e.from) || !known.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
  }
  const seen = new Set<string>();
  const stack = fromIds.filter((id) => known.has(id));
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const to of adj.get(id) ?? []) stack.push(to);
  }
  return graph.nodes.map((n) => n.id).filter((id) => seen.has(id));
}

/** The armed back-edges that FIRE this turn: armed (armedBackEdges) AND not yet
 *  exhausted (visits[edge.id] < effectiveVisitCap(edge)). Each result carries the
 *  edge plus its cycleBodyNodes — the reset set run-store flips back to "pending".
 *  An armed-but-exhausted back-edge is omitted: it is DEAD, so flow falls through
 *  (the loop exits) exactly as if the edge weren't there. Visits default to 0 for
 *  an edge absent from the map. Returned in graph edge order for determinism. */
export function backEdgesToFire(
  graph: LoomGraph,
  nodeStates: Record<string, NodeStateLike>,
  visits: Record<string, number>,
): Array<{ edge: LoomEdgeDef; resetNodes: string[] }> {
  const armed = armedBackEdges(graph, nodeStates);
  const fire: Array<{ edge: LoomEdgeDef; resetNodes: string[] }> = [];
  for (const edge of armed) {
    const used = visits[edge.id] ?? 0;
    if (used >= effectiveVisitCap(edge)) continue; // exhausted ⇒ dead ⇒ loop exits
    fire.push({ edge, resetNodes: cycleBodyNodes(graph, edge) });
  }
  return fire;
}

/** Pure decision for a settled WORKER node carrying a retry clause. Given the
 *  outcome facts — whether its attempt succeeded, whether its retry.until
 *  predicate HELD (pass true; pass `true` unconditionally when there is no
 *  until clause), how many times it has been activated so far, and its
 *  maxAttempts — return:
 *   • "satisfied" — the node is done (succeeded AND until held): treat as
 *     succeeded for advancement (the normal worker path);
 *   • "relaunch"  — not satisfied but activations remain (activations <
 *     maxAttempts): re-attempt this same node as a fresh single-node wave;
 *   • "exhausted" — not satisfied and no activations remain (activations >=
 *     maxAttempts): the node has failed and the pass fails.
 *  A blocked node is never passed here (blocked holds the pass regardless of
 *  retry). Pure so run-store's relaunch/advance branch is testable in isolation;
 *  the until-predicate evaluation (impure) is done by the caller. */
export function retryDisposition(opts: {
  succeeded: boolean;
  untilHeld: boolean;
  activations: number;
  maxAttempts: number;
}): "satisfied" | "relaunch" | "exhausted" {
  if (opts.succeeded && opts.untilHeld) return "satisfied";
  return opts.activations < opts.maxAttempts ? "relaunch" : "exhausted";
}

/** Pending GUARD nodes ready to EVALUATE: a guard's single forward parent has
 *  "succeeded" (its source output is available). A guard with no live forward
 *  parent, an unresolved/in-flight parent, or already settled is not returned.
 *  run-store evaluates each via evaluateGuardPredicate, records branchResult,
 *  then re-prunes — all inline between worker waves (a guard launches no
 *  attempt). */
export function readyGuardNodes(
  graph: LoomGraph,
  nodeStates: Record<string, NodeStateLike>,
): string[] {
  const statusOf = (id: string): NodeStatus => nodeStates[id]?.status ?? "pending";
  const ready: string[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "guard") continue;
    if (statusOf(node.id) !== "pending") continue;
    const liveParents = forwardIncomingEdges(graph, node.id).filter((e) =>
      edgeIsLive(graph, e, nodeStates),
    );
    // A guard routes its SINGLE upstream's output; ready once that parent (every
    // live parent, defensively) has succeeded and at least one live parent exists.
    if (liveParents.length === 0) continue;
    if (liveParents.every((e) => statusOf(e.from) === "succeeded")) ready.push(node.id);
  }
  return ready;
}

/** Pending STEP nodes ready to EXECUTE inline: the same readiness rule a worker
 *  wave uses (nextReadyWave) — every live forward parent succeeded, or the step
 *  is an entry node — filtered to kind "step". The executor runs each via
 *  loom-steps.executeStep, records its output, then re-prunes; like a guard or
 *  merge a step launches NO attempt. A subset of nextReadyWave by construction,
 *  so isPassComplete's nextReadyWave clause already holds the pass for them. */
export function readyStepNodes(
  graph: LoomGraph,
  nodeStates: Record<string, NodeStateLike>,
): string[] {
  const stepIds = new Set(graph.nodes.filter((n) => n.kind === "step").map((n) => n.id));
  return nextReadyWave(graph, nodeStates).filter((id) => stepIds.has(id));
}

/** True when no pending node can still become ready — every node reachable from
 *  the part of the graph that ran is settled (succeeded/failed/blocked/skipped),
 *  OR the only nodes left pending are unreachable (a parent failed/blocked, or
 *  every path to them was pruned dead). The executor uses this as the
 *  terminalization gate: the pass ends when nextReadyWave is empty AND
 *  isPassComplete, i.e. there is no live wave and nothing left that could become
 *  live. A pending guard that is still ready to evaluate (readyGuardNodes) also
 *  means more work — the pass is NOT complete until it has routed.
 *
 *  SLICE 6: a back-edge that is ARMED and still FIRABLE (under its visitCap, per
 *  the optional `visits` map) also means more work — re-running it re-activates a
 *  loop body, so the pass is NOT complete. An armed-but-EXHAUSTED back-edge is
 *  dead and does NOT hold the pass (the loop has exited). `visits` defaults to {}
 *  (every armed back-edge treated as firable / not-yet-fired), which is the safe
 *  hold: an acyclic graph has no back-edge so backEdgesToFire is [] and this
 *  clause is a no-op — slice-1..5 parity. */
export function isPassComplete(
  graph: LoomGraph,
  nodeStates: Record<string, NodeStateLike>,
  visits: Record<string, number> = {},
): boolean {
  const statusOf = (id: string): NodeStatus => nodeStates[id]?.status ?? "pending";
  // A running node means a wave is in flight — not complete.
  if (graph.nodes.some((n) => statusOf(n.id) === "running")) return false;
  // Any node that COULD still become ready (a worker wave, an inline merge, or a
  // guard waiting to route) means the walk has more to do — not complete.
  if (nextReadyWave(graph, nodeStates).length > 0) return false;
  if (readyGuardNodes(graph, nodeStates).length > 0) return false;
  if (readyMergeNodes(graph, nodeStates).length > 0) return false;
  // A firable back-edge will re-open a loop body — not complete. (Exhausted
  // back-edges are excluded by backEdgesToFire, so they don't hold the pass.)
  if (backEdgesToFire(graph, nodeStates, visits).length > 0) return false;
  // Otherwise every node is either settled or permanently stuck (a pending node
  // whose live parent failed/blocked, or whose every path was pruned, can never
  // become ready) — the pass is done.
  return true;
}

// ── Slice 4: merge-node inline join (pure) ──────────────────────────────────
// A merge node is NOT a worker — it launches no attempt. The executor resolves
// it inline: once its forward parents have settled the way its joinMode wants,
// the merge node's "output" is the labeled concatenation of those parents'
// outputs, and it flips to "succeeded" in the projection so downstream waves
// (and {{node:<mergeId>}} / {{incoming}}) read it. These helpers let run-store
// resolve every ready merge before re-computing the next WORKER wave. The walk
// stays kind-agnostic in nextReadyWave; run-store distinguishes by node kind.

/** A node's display label for merge-output attribution (falls back to its id). */
function nodeLabelOrId(graph: LoomGraph, nodeId: string): string {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const label = node && "label" in node ? node.label : undefined;
  return label && label.trim().length > 0 ? label : nodeId;
}

/** True when a merge node is ready to resolve inline. For joinMode "all" every
 *  forward parent must be settled as "succeeded" OR "skipped" AND at least one
 *  must have succeeded (an all-skipped join produces no output, so it is not a
 *  meaningful join — left not-ready so the pass terminalizes rather than feeding
 *  an empty merge downstream). For "any" at least one forward parent must have
 *  "succeeded". In BOTH modes a still-pending/running forward parent means the
 *  join barrier hasn't been reached — not ready. A non-merge node (or unknown
 *  joinMode) is never "merge ready". */
export function mergeReady(
  graph: LoomGraph,
  mergeNodeId: string,
  nodeStates: Record<string, NodeStateLike>,
): boolean {
  const node = graph.nodes.find((n) => n.id === mergeNodeId);
  if (!node || node.kind !== "merge") return false;
  const statusOf = (id: string): NodeStatus => nodeStates[id]?.status ?? "pending";
  const parents = upstreamOf(graph, mergeNodeId);
  if (parents.length === 0) return false; // a merge with no inbound branches never resolves
  if (node.joinMode === "any") {
    return parents.some((p) => statusOf(p) === "succeeded");
  }
  // joinMode "all": no parent may still be in flight; every parent settled as
  // succeeded/skipped; at least one actually succeeded.
  if (parents.some((p) => statusOf(p) === "pending" || statusOf(p) === "running")) return false;
  if (!parents.every((p) => statusOf(p) === "succeeded" || statusOf(p) === "skipped")) return false;
  return parents.some((p) => statusOf(p) === "succeeded");
}

/** The labeled concatenation of a merge node's SUCCEEDED forward parents'
 *  outputs — each parent's output passed through truncateOutput and prefixed
 *  with "[<parentLabel or id>]". Skipped/failed parents contribute nothing.
 *  Parent order follows upstreamOf (the graph edge order), so the merge output
 *  is deterministic. A parent that succeeded with no recorded output still gets
 *  its labeled header (the worker produced no summary) so the join shape is
 *  stable for downstream prompts. */
export function mergeOutput(
  graph: LoomGraph,
  mergeNodeId: string,
  nodeStates: Record<string, NodeStateLike>,
): string {
  const parents = upstreamOf(graph, mergeNodeId);
  const parts: string[] = [];
  for (const parentId of parents) {
    const ns = nodeStates[parentId];
    if (ns?.status !== "succeeded") continue;
    const output = ns.output ?? "";
    parts.push(`[${nodeLabelOrId(graph, parentId)}]\n${truncateOutput(output)}`);
  }
  return parts.join("\n\n");
}

/** Pending merge nodes whose join is ready (mergeReady). The executor resolves
 *  these inline — marks each "succeeded" with mergeOutput — before re-computing
 *  the next worker wave. Returns [] when no merge is ready (the common case for
 *  a worker-only frontier). Only "pending" merges are returned: a merge already
 *  resolved (succeeded) or stranded (failed/blocked/skipped) is left alone. */
export function readyMergeNodes(
  graph: LoomGraph,
  nodeStates: Record<string, NodeStateLike>,
): string[] {
  const statusOf = (id: string): NodeStatus => nodeStates[id]?.status ?? "pending";
  const ready: string[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "merge") continue;
    if (statusOf(node.id) !== "pending") continue;
    if (mergeReady(graph, node.id, nodeStates)) ready.push(node.id);
  }
  return ready;
}

/** 8KB-budget truncation for an injected upstream output: keep the head and the
 *  tail, eliding the middle with a marker, so a runaway worker summary can't
 *  blow up a downstream prompt. Under the budget the string is returned
 *  unchanged. The budget is split head/tail so both the start (instructions,
 *  intent) and the end (result, sentinel) of the upstream output survive. */
export function truncateOutput(s: string, limit = 8192): string {
  if (s.length <= limit) return s;
  const head = Math.floor(limit / 2);
  const tail = limit - head;
  const elided = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${elided} chars truncated]…\n${s.slice(s.length - tail)}`;
}

/** Render a node's prompt template. Substitutes, in order:
 *   1. the pass-level vars ({{iteration}} {{lastOutput}} {{lastSummary}}
 *      {{file}} {{date}} {{name}}) — the EXACT same rule set as
 *      automation-loop.renderPrompt, supplied as a Record so both call sites
 *      stay byte-identical for a degenerate single-node loom;
 *   2. {{node:<id>}} → that upstream node's output (truncated);
 *   3. {{incoming}} → every forward-parent's output, each truncated and joined
 *      under a labeled separator so the worker can tell branches apart.
 *  For a layer-0 node nodeOutputs/incoming are empty, so only the pass vars
 *  apply and the result equals renderPrompt(template) — the single-node parity
 *  invariant. Substitution uses replaceAll (no regex), so template text never
 *  triggers special-char surprises.
 *
 *  AUTO-INCOMING: a downstream worker must never run blind. When the authored
 *  template places NEITHER {{incoming}} NOR any {{node:...}} token but the
 *  node HAS upstream output (ctx.incoming carries real content), the exact
 *  block {{incoming}} would have produced is auto-appended under its labeled
 *  separator — via the same substitution path, by rendering
 *  `template + "\n\n{{incoming}}"`. Explicit {{incoming}}/{{node:*}} placement
 *  always wins (an authored token disables the append). Entry nodes and
 *  single-node looms pass incoming: [] and are untouched, preserving parity. */
export function renderNodePrompt(
  template: string,
  ctx: { vars: Record<string, string>; nodeOutputs: Record<string, string>; incoming: string[] },
  opts?: {
    /** Default true (worker prompts). Step-node templates pass false: a shell
     *  command / URL / file path must never grow an upstream transcript. */
    autoIncoming?: boolean;
  },
): string {
  const autoIncoming = opts?.autoIncoming !== false;
  const referencesUpstream = template.includes("{{incoming}}") || template.includes("{{node:");
  const hasIncoming = ctx.incoming.some((out) => out.trim().length > 0);
  let result = autoIncoming && !referencesUpstream && hasIncoming ? `${template}\n\n{{incoming}}` : template;
  const joinedIncoming = (): string =>
    ctx.incoming.length > 0
      ? ctx.incoming
          .map((out, i) => `--- Output from upstream node ${i + 1} ---\n${truncateOutput(out)}`)
          .join("\n\n")
      : "";
  // Filtered tokens FIRST ({{node:x|json}} before {{node:x}}), so the plain
  // replaceAll below never eats the head of a filtered token.
  result = result.replace(TOKEN_WITH_FILTER, (whole, name: string, filter: string) => {
    let value: string | undefined;
    if (name === "incoming") value = joinedIncoming();
    else if (name.startsWith("node:")) {
      const out = ctx.nodeOutputs[name.slice(5)];
      value = out === undefined ? undefined : truncateOutput(out);
    } else value = ctx.vars[name];
    const filtered = applyTokenFilter(value ?? "", filter);
    return value === undefined || filtered === null ? whole : filtered;
  });
  for (const [key, value] of Object.entries(ctx.vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  for (const [id, output] of Object.entries(ctx.nodeOutputs)) {
    result = result.replaceAll(`{{node:${id}}}`, truncateOutput(output));
  }
  if (result.includes("{{incoming}}")) {
    result = result.replaceAll("{{incoming}}", joinedIncoming());
  }
  return result;
}

// ── token filters (Looms v3) ─────────────────────────────────────────────────
// `{{node:x|json}}` — the value as a JSON string literal (quotes included), so
//   a webhook body like {"text": {{node:x|json}}} stays valid whatever the
//   output contains. `|line` — the first non-empty line. `|trim` — trimmed.
//   `|upper` / `|lower`. An unknown filter leaves the token untouched so the
//   author sees it in the rendered prompt instead of silently losing data.
const TOKEN_WITH_FILTER = /\{\{([A-Za-z][\w:-]*)\|([a-z]+)\}\}/g;

export function applyTokenFilter(value: string, filter: string): string | null {
  switch (filter) {
    case "json":
      return JSON.stringify(value);
    case "line":
      return value.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
    case "trim":
      return value.trim();
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
    default:
      return null;
  }
}
