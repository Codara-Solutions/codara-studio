// Pure unit tests for the loom graph-walk module (src/main/orchestration/
// loom-graph.ts). loom-graph is dependency-free (only a type-only import of
// @shared/types, erased by esbuild), so this harness bundles it with NO stubs —
// the real functions are exercised directly. The run-store / automation-loop
// harnesses STUB run-store, so they never exercise the real graph walk; THESE
// tests are the safety net for every advance/terminalize decision.
//
//   node scripts/test-loom-graph.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const LOOM_GRAPH_TS = path.join(ROOT, "src", "main", "orchestration", "loom-graph.ts");

const harnessPlugin = {
  name: "loom-graph-test-harness",
  setup(build) {
    // The only import is `import type`, erased by esbuild — but resolve @shared
    // defensively so the bundle never fails if a value import is added later.
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

// Graph builders — minimal LoomGraph shapes the pure walk reads.
const workerNode = (id) => ({ id, kind: "worker", worker: { engine: "auto" }, prompt: `do ${id}` });
const edge = (from, to, over = {}) => ({ id: `${from}->${to}`, from, to, ...over });
const graphOf = (nodes, edges = []) => ({
  version: 1,
  nodes: nodes.map(workerNode),
  edges,
  entryNodeIds: nodes.filter((id) => !edges.some((e) => e.to === id && e.backEdge !== true)),
});
// Mixed-kind builder: pass node DESCRIPTORS so a graph can carry worker + merge
// + guard nodes. A string descriptor is a worker; {id,kind:"merge",joinMode,
// label?} is a merge node; {id,kind:"guard",predicate?} is a guard node.
const mkNode = (d) =>
  typeof d === "string"
    ? workerNode(d)
    : d.kind === "merge"
      ? { id: d.id, kind: "merge", joinMode: d.joinMode ?? "all", ...(d.label ? { label: d.label } : {}) }
      : d.kind === "guard"
        ? { id: d.id, kind: "guard", predicate: d.predicate ?? { type: "phrase", phrase: "" } }
        : workerNode(d.id);
const mixedGraph = (descriptors, edges = []) => ({
  version: 1,
  nodes: descriptors.map(mkNode),
  edges,
  entryNodeIds: descriptors
    .map((d) => (typeof d === "string" ? d : d.id))
    .filter((id) => !edges.some((e) => e.to === id && e.backEdge !== true)),
});

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-loomgraph-"));
  const outfile = path.join(tmp, "loom-graph.bundle.cjs");
  await esbuild.build({
    entryPoints: [LOOM_GRAPH_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    resolveExtensions: [".ts", ".js", ".cjs", ".mjs", ".json"],
    plugins: [harnessPlugin],
  });
  const G = require(outfile);

  let passed = 0;
  const ok = (name, cond) => {
    if (!cond) throw new Error(`FAIL: ${name}`);
    passed += 1;
    console.log(`  PASS ${name}`);
  };
  // status map helper
  const states = (obj) => {
    const m = {};
    for (const [k, v] of Object.entries(obj)) m[k] = { status: v };
    return m;
  };
  // status+output map helper: value is [status, output?].
  const statesOut = (obj) => {
    const m = {};
    for (const [k, v] of Object.entries(obj)) {
      const [status, output] = Array.isArray(v) ? v : [v, undefined];
      m[k] = output === undefined ? { status } : { status, output };
    }
    return m;
  };

  // ── planLoomLayers ────────────────────────────────────────────────────────
  {
    const single = graphOf(["w0"]);
    const r = G.planLoomLayers(single);
    ok("planLoomLayers: single node → one layer [[w0]]", r.layers.length === 1 && r.layers[0].length === 1 && r.layers[0][0] === "w0");
    ok("planLoomLayers: single node order is [w0]", r.order.length === 1 && r.order[0] === "w0");
  }
  {
    // A → B → C linear chain.
    const chain = graphOf(["A", "B", "C"], [edge("A", "B"), edge("B", "C")]);
    const r = G.planLoomLayers(chain);
    ok(
      "planLoomLayers: A→B→C → three single-node layers in order",
      r.layers.length === 3 &&
        r.layers[0].join() === "A" &&
        r.layers[1].join() === "B" &&
        r.layers[2].join() === "C",
    );
    ok("planLoomLayers: chain launch order is A,B,C", r.order.join() === "A,B,C");
  }
  {
    // Diamond: A → B, A → C, B → D, C → D.
    const diamond = graphOf(
      ["A", "B", "C", "D"],
      [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")],
    );
    const r = G.planLoomLayers(diamond);
    ok(
      "planLoomLayers: diamond layers are [A],[B,C],[D]",
      r.layers.length === 3 &&
        r.layers[0].join() === "A" &&
        r.layers[1].slice().sort().join() === "B,C" &&
        r.layers[2].join() === "D",
    );
  }
  {
    // FIX 5: a TWO-ENTRY graph — A and B both indegree-0, each feeding a shared
    // sink C — must surface BOTH as layers[0]. The loop driver launches that
    // WHOLE layer-0 frontier as one wave (entries run in parallel, not serially).
    const twoEntry = graphOf(["A", "B", "C"], [edge("A", "C"), edge("B", "C")]);
    const r = G.planLoomLayers(twoEntry);
    ok(
      "planLoomLayers: two indegree-0 entries → layers[0] is the FULL frontier [A,B]",
      r.layers[0].slice().sort().join() === "A,B" && r.layers[0].length === 2,
    );
    ok(
      "planLoomLayers: two-entry graph drains to the shared sink [C] in layer 1",
      r.layers.length === 2 && r.layers[1].join() === "C",
    );
  }

  // ── sinkNodeIds (slice 7: the pass-level "agent" loop reads the SINK's signal) ─
  {
    const single = graphOf(["w0"]);
    ok("sinkNodeIds: single node is its own sink", G.sinkNodeIds(single).join() === "w0");

    const chain = graphOf(["A", "B", "C"], [edge("A", "B"), edge("B", "C")]);
    ok("sinkNodeIds: A→B→C sink is C only", G.sinkNodeIds(chain).join() === "C");

    const diamond = graphOf(
      ["A", "B", "C", "D"],
      [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")],
    );
    ok("sinkNodeIds: diamond sink is D only", G.sinkNodeIds(diamond).join() === "D");

    // A back-edge from the sink does NOT make it a non-sink (forward edges only).
    const cyclic = graphOf(["A", "B"], [edge("A", "B"), edge("B", "A", { backEdge: true })]);
    ok("sinkNodeIds: back-edge source is still a sink (forward-only)", G.sinkNodeIds(cyclic).join() === "B");

    // Two independent terminal branches → two sinks (graph node order).
    const forked = graphOf(["A", "B", "C"], [edge("A", "B"), edge("A", "C")]);
    ok("sinkNodeIds: two terminal branches → both sinks", G.sinkNodeIds(forked).slice().sort().join() === "B,C");
  }

  // ── upstreamOf ──────────────────────────────────────────────────────────────
  {
    const diamond = graphOf(
      ["A", "B", "C", "D"],
      [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D"), edge("D", "A", { backEdge: true })],
    );
    ok("upstreamOf: entry node A has no forward parents", G.upstreamOf(diamond, "A").length === 0);
    ok("upstreamOf: D's forward parents are B,C", G.upstreamOf(diamond, "D").slice().sort().join() === "B,C");
    ok("upstreamOf: ignores back-edges (A has no parent via D→A backEdge)", !G.upstreamOf(diamond, "A").includes("D"));
    ok("upstreamOf: unknown node → []", G.upstreamOf(diamond, "ZZ").length === 0);
  }

  // ── nextReadyWave ────────────────────────────────────────────────────────────
  {
    const chain = graphOf(["A", "B", "C"], [edge("A", "B"), edge("B", "C")]);
    // Nothing run yet: only the entry A is ready.
    ok("nextReadyWave: fresh chain → only entry A ready", G.nextReadyWave(chain, states({})).join() === "A");
    // A running: nothing new ready (B waits on A succeeding).
    ok("nextReadyWave: A running → nothing ready (B not yet)", G.nextReadyWave(chain, states({ A: "running" })).length === 0);
    // A succeeded: B becomes ready, C still gated.
    ok("nextReadyWave: A succeeded → B ready (one at a time)", G.nextReadyWave(chain, states({ A: "succeeded" })).join() === "B");
    // A,B succeeded: C ready.
    ok("nextReadyWave: A,B succeeded → C ready", G.nextReadyWave(chain, states({ A: "succeeded", B: "succeeded" })).join() === "C");
    // A failed: B never becomes ready (parent not succeeded).
    ok("nextReadyWave: A failed → B never ready", G.nextReadyWave(chain, states({ A: "failed" })).length === 0);
    // Diamond: both B,C ready together once A succeeds; D waits on BOTH.
    const diamond = graphOf(["A", "B", "C", "D"], [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")]);
    ok(
      "nextReadyWave: diamond A succeeded → B,C ready together",
      G.nextReadyWave(diamond, states({ A: "succeeded" })).slice().sort().join() === "B,C",
    );
    ok(
      "nextReadyWave: diamond only B succeeded → D NOT ready (waits on C)",
      G.nextReadyWave(diamond, states({ A: "succeeded", B: "succeeded" })).join() === "C",
    );
    ok(
      "nextReadyWave: diamond B,C succeeded → D ready",
      G.nextReadyWave(diamond, states({ A: "succeeded", B: "succeeded", C: "succeeded" })).join() === "D",
    );
  }

  // ── isPassComplete ────────────────────────────────────────────────────────────
  {
    const chain = graphOf(["A", "B", "C"], [edge("A", "B"), edge("B", "C")]);
    ok("isPassComplete: fresh chain (A ready) → NOT complete", G.isPassComplete(chain, states({})) === false);
    ok("isPassComplete: A running → NOT complete", G.isPassComplete(chain, states({ A: "running" })) === false);
    ok("isPassComplete: A succeeded, B ready → NOT complete", G.isPassComplete(chain, states({ A: "succeeded" })) === false);
    ok(
      "isPassComplete: whole chain succeeded → complete",
      G.isPassComplete(chain, states({ A: "succeeded", B: "succeeded", C: "succeeded" })) === true,
    );
    ok(
      "isPassComplete: A failed → complete (B,C can never become ready)",
      G.isPassComplete(chain, states({ A: "failed" })) === true,
    );
    ok(
      "isPassComplete: single node succeeded → complete",
      G.isPassComplete(graphOf(["w0"]), states({ w0: "succeeded" })) === true,
    );
  }

  // ── mergeReady ───────────────────────────────────────────────────────────────
  {
    // A,B → M(all). M is ready only once BOTH parents are settled succeeded.
    const all = mixedGraph(
      ["A", "B", { id: "M", kind: "merge", joinMode: "all" }],
      [edge("A", "M"), edge("B", "M")],
    );
    ok("mergeReady(all): fresh → NOT ready", G.mergeReady(all, "M", states({})) === false);
    ok("mergeReady(all): one parent running → NOT ready", G.mergeReady(all, "M", states({ A: "succeeded", B: "running" })) === false);
    ok("mergeReady(all): one parent still pending → NOT ready", G.mergeReady(all, "M", states({ A: "succeeded" })) === false);
    ok("mergeReady(all): both succeeded → ready", G.mergeReady(all, "M", states({ A: "succeeded", B: "succeeded" })) === true);
    ok(
      "mergeReady(all): succeeded + skipped (>=1 succeeded) → ready",
      G.mergeReady(all, "M", states({ A: "succeeded", B: "skipped" })) === true,
    );
    ok(
      "mergeReady(all): all skipped (none succeeded) → NOT ready",
      G.mergeReady(all, "M", states({ A: "skipped", B: "skipped" })) === false,
    );
    ok(
      "mergeReady(all): a failed parent → NOT ready (not all succeeded/skipped)",
      G.mergeReady(all, "M", states({ A: "succeeded", B: "failed" })) === false,
    );

    // A,B → M(any). M is ready as soon as ONE parent succeeds.
    const any = mixedGraph(
      ["A", "B", { id: "M", kind: "merge", joinMode: "any" }],
      [edge("A", "M"), edge("B", "M")],
    );
    ok("mergeReady(any): one succeeded (other running) → ready", G.mergeReady(any, "M", states({ A: "succeeded", B: "running" })) === true);
    ok("mergeReady(any): none succeeded yet → NOT ready", G.mergeReady(any, "M", states({ A: "running", B: "pending" })) === false);
    ok("mergeReady(any): a failed parent but one succeeded → ready", G.mergeReady(any, "M", states({ A: "succeeded", B: "failed" })) === true);

    // A worker node is never "merge ready"; an unknown node is never ready.
    const chain = graphOf(["A", "B"], [edge("A", "B")]);
    ok("mergeReady: a worker node is never merge-ready", G.mergeReady(chain, "B", states({ A: "succeeded" })) === false);
    ok("mergeReady: a merge with no inbound edges never resolves", G.mergeReady(mixedGraph([{ id: "M", kind: "merge", joinMode: "all" }]), "M", states({})) === false);
  }

  // ── mergeOutput ──────────────────────────────────────────────────────────────
  {
    const all = mixedGraph(
      ["A", "B", { id: "M", kind: "merge", joinMode: "all", label: "Join" }],
      [edge("A", "M"), edge("B", "M")],
    );
    const out = G.mergeOutput(all, "M", statesOut({ A: ["succeeded", "OUT-A"], B: ["succeeded", "OUT-B"] }));
    ok(
      "mergeOutput: labeled concat of succeeded parents (by id when no label)",
      out.includes("[A]\nOUT-A") && out.includes("[B]\nOUT-B"),
    );
    ok("mergeOutput: parents joined in upstream order", out.indexOf("[A]") < out.indexOf("[B]"));
    // A skipped/failed parent contributes nothing.
    const partial = G.mergeOutput(all, "M", statesOut({ A: ["succeeded", "OUT-A"], B: ["skipped"] }));
    ok("mergeOutput: skipped parent omitted", partial.includes("[A]\nOUT-A") && !partial.includes("[B]"));
    // Each parent output is truncated.
    const big = "z".repeat(20000);
    const truncated = G.mergeOutput(all, "M", statesOut({ A: ["succeeded", big], B: ["succeeded", "OUT-B"] }));
    ok("mergeOutput: each parent output is truncated to budget", truncated.includes("truncated") && truncated.length < big.length + 100);
    // A parent's label (when set) is used for the header instead of its id.
    const labeledGraph = {
      version: 1,
      nodes: [
        { id: "A", kind: "worker", worker: { engine: "auto" }, prompt: "do A", label: "Designer" },
        { id: "M", kind: "merge", joinMode: "all" },
      ],
      edges: [edge("A", "M")],
      entryNodeIds: ["A"],
    };
    const labeledOut = G.mergeOutput(labeledGraph, "M", statesOut({ A: ["succeeded", "OUT-A"] }));
    ok("mergeOutput: uses the parent's label for the header when present", labeledOut.startsWith("[Designer]\nOUT-A"));
  }

  // ── readyMergeNodes + fan-out→merge frontier walk ─────────────────────────────
  {
    // A,B parallel → M merge(all) → C worker. After A&B succeed, M resolves
    // inline; then C is the next worker wave.
    const g = mixedGraph(
      ["A", "B", { id: "M", kind: "merge", joinMode: "all" }, "C"],
      [edge("A", "M"), edge("B", "M"), edge("M", "C")],
    );
    // Layer 0: A,B are the entry wave (both worker, both ready).
    ok("fan-out: entry wave is A,B", G.nextReadyWave(g, states({})).slice().sort().join() === "A,B");
    // While A,B run, M is not ready and nothing new launches.
    ok("fan-out: M not ready while A,B run", G.readyMergeNodes(g, states({ A: "running", B: "running" })).length === 0);
    // A,B succeed → M becomes ready (inline merge), C still gated on M.
    const afterAB = statesOut({ A: ["succeeded", "rA"], B: ["succeeded", "rB"] });
    ok("fan-out: A,B succeeded → M is the ready merge", G.readyMergeNodes(g, afterAB).join() === "M");
    // nextReadyWave is KIND-AGNOSTIC: before M resolves it surfaces M (a merge),
    // never C (C's parent M is still pending). run-store resolves M inline first,
    // then re-evaluates — so C must NOT appear here.
    ok("fan-out: C NOT ready before M resolves (nextReadyWave surfaces M only)", G.nextReadyWave(g, afterAB).join() === "M");
    // Resolve M inline (what run-store does): mark succeeded with the joined output.
    afterAB.M = { status: "succeeded", output: G.mergeOutput(g, "M", afterAB) };
    ok("fan-out: M's joined output carries both parents", afterAB.M.output.includes("[A]\nrA") && afterAB.M.output.includes("[B]\nrB"));
    // No more merges ready; C is now the next worker wave.
    ok("fan-out: after M resolves, no more ready merges", G.readyMergeNodes(g, afterAB).length === 0);
    ok("fan-out: after M resolves, C is the next worker wave", G.nextReadyWave(g, afterAB).join() === "C");
    ok("fan-out: not pass-complete until C runs", G.isPassComplete(g, afterAB) === false);
    // C succeeds → pass complete.
    afterAB.C = { status: "succeeded", output: "rC" };
    ok("fan-out: C succeeded → pass complete", G.isPassComplete(g, afterAB) === true);
  }

  // ── SLICE 5: edgeIsLive ───────────────────────────────────────────────────────
  {
    // Guard Gp with pass/fail branches: P on the pass edge, F on the fail edge.
    const g = mixedGraph(
      ["A", { id: "Gp", kind: "guard" }, "P", "F"],
      [edge("A", "Gp"), edge("Gp", "P", { branch: "pass" }), edge("Gp", "F", { branch: "fail" })],
    );
    const passEdge = g.edges.find((e) => e.to === "P");
    const failEdge = g.edges.find((e) => e.to === "F");
    const aEdge = g.edges.find((e) => e.to === "Gp");
    // Guard unresolved (no branchResult): BOTH branches are live (not-yet-dead).
    const unresolved = { A: { status: "succeeded" }, Gp: { status: "succeeded" } };
    ok("edgeIsLive: unresolved guard → pass edge live", G.edgeIsLive(g, passEdge, unresolved) === true);
    ok("edgeIsLive: unresolved guard → fail edge live", G.edgeIsLive(g, failEdge, unresolved) === true);
    // Guard routed PASS: pass edge live, fail edge DEAD.
    const routedPass = { A: { status: "succeeded" }, Gp: { status: "succeeded", branchResult: "pass" } };
    ok("edgeIsLive: guard branchResult=pass keeps the pass edge live", G.edgeIsLive(g, passEdge, routedPass) === true);
    ok("edgeIsLive: guard branchResult=pass kills the fail edge", G.edgeIsLive(g, failEdge, routedPass) === false);
    // Guard routed FAIL: fail edge live, pass edge DEAD (vice-versa).
    const routedFail = { A: { status: "succeeded" }, Gp: { status: "succeeded", branchResult: "fail" } };
    ok("edgeIsLive: guard branchResult=fail kills the pass edge", G.edgeIsLive(g, passEdge, routedFail) === false);
    ok("edgeIsLive: guard branchResult=fail keeps the fail edge live", G.edgeIsLive(g, failEdge, routedFail) === true);
    // A non-guard, non-skipped source edge is always live.
    ok("edgeIsLive: a plain worker→guard edge is live", G.edgeIsLive(g, aEdge, unresolved) === true);
    // A skipped source kills the edge.
    ok(
      "edgeIsLive: skipped source → edge dead",
      G.edgeIsLive(g, passEdge, { A: { status: "succeeded" }, Gp: { status: "skipped" } }) === false,
    );
    // A back-edge is never live (forward-only this slice).
    const back = { id: "P->A", from: "P", to: "A", backEdge: true };
    ok("edgeIsLive: back-edge is never live", G.edgeIsLive(g, back, unresolved) === false);
  }

  // ── SLICE 5: guard pruning — nextReadyWave / computeSkips / isPassComplete ──────
  {
    // A → Gp(guard) → {P (pass), F (fail)}. Only the TAKEN branch runs; the other
    // is skipped; the pass completes when the taken branch finishes.
    const g = mixedGraph(
      ["A", { id: "Gp", kind: "guard" }, "P", "F"],
      [edge("A", "Gp"), edge("Gp", "P", { branch: "pass" }), edge("Gp", "F", { branch: "fail" })],
    );
    // Entry wave is just A.
    ok("guard: entry wave is A", G.nextReadyWave(g, states({})).join() === "A");
    // A succeeded → the GUARD is ready to evaluate (not P/F yet).
    const afterA = { A: { status: "succeeded", output: "rA" } };
    ok("guard: A succeeded → Gp is the ready guard", G.readyGuardNodes(g, afterA).join() === "Gp");
    ok("guard: P,F NOT ready before the guard routes", G.nextReadyWave(g, afterA).join() === "Gp");
    // Guard routes PASS → P becomes the ready worker; F is a skip candidate.
    const routedPass = { ...afterA, Gp: { status: "succeeded", output: "guard: pass", branchResult: "pass" } };
    ok("guard: routed pass → P is the next worker wave", G.nextReadyWave(g, routedPass).join() === "P");
    ok("guard: routed pass → F is computed as a skip", G.computeSkips(g, routedPass).join() === "F");
    ok("guard: routed pass → not pass-complete (P still to run)", G.isPassComplete(g, routedPass) === false);
    // Apply the skip + run P → pass complete; the fail branch never ran.
    const done = { ...routedPass, F: { status: "skipped" }, P: { status: "succeeded", output: "rP" } };
    ok("guard: P done + F skipped → pass complete", G.isPassComplete(g, done) === true);
    ok("guard: nothing else ready once P done + F skipped", G.nextReadyWave(g, done).length === 0);
    // Vice-versa: routed FAIL runs F, skips P.
    const routedFail = { ...afterA, Gp: { status: "succeeded", output: "guard: fail", branchResult: "fail" } };
    ok("guard: routed fail → F is the next worker wave", G.nextReadyWave(g, routedFail).join() === "F");
    ok("guard: routed fail → P is computed as a skip", G.computeSkips(g, routedFail).join() === "P");
  }

  // ── SLICE 5: computeSkips is transitive ────────────────────────────────────────
  {
    // A → Gp → P(pass) → P2; Gp → F(fail). Routing pass should skip ONLY F.
    // Routing fail should skip P AND its sole-dependent P2 (transitive closure).
    const g = mixedGraph(
      ["A", { id: "Gp", kind: "guard" }, "P", "P2", "F"],
      [
        edge("A", "Gp"),
        edge("Gp", "P", { branch: "pass" }),
        edge("P", "P2"),
        edge("Gp", "F", { branch: "fail" }),
      ],
    );
    const routedFail = { A: { status: "succeeded" }, Gp: { status: "succeeded", branchResult: "fail" } };
    ok(
      "computeSkips: transitive — fail route skips P and its dependent P2",
      G.computeSkips(g, routedFail).slice().sort().join() === "P,P2",
    );
    const routedPass = { A: { status: "succeeded" }, Gp: { status: "succeeded", branchResult: "pass" } };
    ok("computeSkips: pass route skips only F (P/P2 live)", G.computeSkips(g, routedPass).join() === "F");
    // Entry nodes are never skipped even if (hypothetically) parentless.
    ok("computeSkips: entry node A is never skipped", !G.computeSkips(g, routedFail).includes("A"));
  }

  // ── SLICE 5: no-guard parity (chain/merge/single unchanged) ─────────────────────
  {
    // These mirror earlier no-guard assertions to prove the live-edge rewrite of
    // nextReadyWave/isPassComplete is behavior-preserving when no guard/skip exists.
    const chain = graphOf(["A", "B", "C"], [edge("A", "B"), edge("B", "C")]);
    ok("parity: chain fresh → only A ready", G.nextReadyWave(chain, states({})).join() === "A");
    ok("parity: chain A succeeded → B ready", G.nextReadyWave(chain, states({ A: "succeeded" })).join() === "B");
    ok("parity: chain A failed → B never ready", G.nextReadyWave(chain, states({ A: "failed" })).length === 0);
    ok("parity: chain A failed → complete", G.isPassComplete(chain, states({ A: "failed" })) === true);
    ok("parity: single node succeeded → complete", G.isPassComplete(graphOf(["w0"]), states({ w0: "succeeded" })) === true);
    ok("parity: no-guard graph → computeSkips empty", G.computeSkips(chain, states({ A: "succeeded" })).length === 0);
    ok("parity: no-guard graph → readyGuardNodes empty", G.readyGuardNodes(chain, states({ A: "succeeded" })).length === 0);
    // Merge frontier still resolves identically (re-uses the slice-4 shape).
    const m = mixedGraph(
      ["A", "B", { id: "M", kind: "merge", joinMode: "all" }, "C"],
      [edge("A", "M"), edge("B", "M"), edge("M", "C")],
    );
    const afterAB = statesOut({ A: ["succeeded", "rA"], B: ["succeeded", "rB"] });
    ok("parity: merge surfaces M as ready (unchanged)", G.readyMergeNodes(m, afterAB).join() === "M");
    afterAB.M = { status: "succeeded", output: G.mergeOutput(m, "M", afterAB) };
    ok("parity: after M resolves, C is next (unchanged)", G.nextReadyWave(m, afterAB).join() === "C");
  }

  // ── SLICE 5: retryDisposition (pure) ────────────────────────────────────────────
  {
    ok("retryDisposition: succeeded + until held → satisfied", G.retryDisposition({ succeeded: true, untilHeld: true, activations: 1, maxAttempts: 3 }) === "satisfied");
    ok("retryDisposition: succeeded + until failed, attempts remain → relaunch", G.retryDisposition({ succeeded: true, untilHeld: false, activations: 1, maxAttempts: 3 }) === "relaunch");
    ok("retryDisposition: failed, attempts remain → relaunch", G.retryDisposition({ succeeded: false, untilHeld: false, activations: 1, maxAttempts: 2 }) === "relaunch");
    ok("retryDisposition: failed, no attempts remain → exhausted", G.retryDisposition({ succeeded: false, untilHeld: false, activations: 2, maxAttempts: 2 }) === "exhausted");
    ok("retryDisposition: until failed at the cap → exhausted", G.retryDisposition({ succeeded: true, untilHeld: false, activations: 3, maxAttempts: 3 }) === "exhausted");
  }

  // ── truncateOutput ───────────────────────────────────────────────────────────
  {
    ok("truncateOutput: under budget → unchanged", G.truncateOutput("hello", 8192) === "hello");
    const big = "x".repeat(20000);
    const t = G.truncateOutput(big, 8192);
    ok("truncateOutput: over budget → shorter than the budget+marker", t.length < big.length && t.length <= 8192 + 64);
    ok("truncateOutput: keeps head and tail, elides middle", t.startsWith("x") && t.endsWith("x") && t.includes("truncated"));
    ok("truncateOutput: default limit applies", G.truncateOutput(big).includes("truncated"));
  }

  // ── renderNodePrompt ─────────────────────────────────────────────────────────
  {
    const vars = { iteration: "3", lastOutput: "prev", lastSummary: "prev", file: "/x.ts", date: "2026-06-10", name: "MyLoom" };

    // Single-node parity: renderNodePrompt with empty upstream == the pass-var
    // render the legacy renderPrompt produced (same 6 vars + lastSummary alias).
    const tpl = "iter {{iteration}} on {{file}} for {{name}} @ {{date}} (last: {{lastOutput}}/{{lastSummary}})";
    const legacy = tpl
      .replaceAll("{{iteration}}", "3")
      .replaceAll("{{lastOutput}}", "prev")
      .replaceAll("{{lastSummary}}", "prev")
      .replaceAll("{{file}}", "/x.ts")
      .replaceAll("{{date}}", "2026-06-10")
      .replaceAll("{{name}}", "MyLoom");
    const rendered = G.renderNodePrompt(tpl, { vars, nodeOutputs: {}, incoming: [] });
    ok("renderNodePrompt: single-node == legacy pass-var-only render (parity)", rendered === legacy);

    // {{node:<id>}} injects a specific upstream node's output.
    const r2 = G.renderNodePrompt("Use upstream: {{node:A}}", { vars, nodeOutputs: { A: "RESULT-A" }, incoming: [] });
    ok("renderNodePrompt: {{node:A}} → that node's output", r2 === "Use upstream: RESULT-A");

    // {{incoming}} joins all forward-parent outputs under a labeled separator.
    const r3 = G.renderNodePrompt("Context:\n{{incoming}}\nEnd", {
      vars,
      nodeOutputs: { A: "out-A", B: "out-B" },
      incoming: ["out-A", "out-B"],
    });
    ok(
      "renderNodePrompt: {{incoming}} joins parents with a labeled separator",
      r3.includes("--- Output from upstream worker 1 ---") &&
        r3.includes("out-A") &&
        r3.includes("--- Output from upstream worker 2 ---") &&
        r3.includes("out-B"),
    );
    ok("renderNodePrompt: {{incoming}} with no parents → empty", G.renderNodePrompt("[{{incoming}}]", { vars, nodeOutputs: {}, incoming: [] }) === "[]");

    // Truncation applies to injected upstream output.
    const big = "y".repeat(20000);
    const r4 = G.renderNodePrompt("{{node:A}}", { vars, nodeOutputs: { A: big }, incoming: [] });
    ok("renderNodePrompt: injected {{node:A}} output is truncated to budget", r4.length < big.length && r4.includes("truncated"));

    // Combined: vars + node + incoming in one template.
    const r5 = G.renderNodePrompt("#{{iteration}} {{node:A}} | {{incoming}}", {
      vars,
      nodeOutputs: { A: "AA" },
      incoming: ["AA"],
    });
    ok(
      "renderNodePrompt: vars + {{node}} + {{incoming}} all substitute together",
      r5.startsWith("#3 AA | ") && r5.includes("--- Output from upstream worker 1 ---") && r5.includes("AA"),
    );
  }

  // ── SLICE 6: effectiveVisitCap (clamp) ────────────────────────────────────────
  {
    ok("effectiveVisitCap: undefined → default 10", G.effectiveVisitCap({ id: "e" }) === 10);
    ok("effectiveVisitCap: 0 → default 10", G.effectiveVisitCap({ id: "e", visitCap: 0 }) === 10);
    ok("effectiveVisitCap: negative → default 10", G.effectiveVisitCap({ id: "e", visitCap: -5 }) === 10);
    ok("effectiveVisitCap: 3 → 3", G.effectiveVisitCap({ id: "e", visitCap: 3 }) === 3);
    ok("effectiveVisitCap: 2.9 floors to 2", G.effectiveVisitCap({ id: "e", visitCap: 2.9 }) === 2);
    ok("effectiveVisitCap: huge clamps to max 1000", G.effectiveVisitCap({ id: "e", visitCap: 99999 }) === 1000);
    ok("effectiveVisitCap: NaN → default 10", G.effectiveVisitCap({ id: "e", visitCap: NaN }) === 10);
    ok("effectiveVisitCap: Infinity → default 10", G.effectiveVisitCap({ id: "e", visitCap: Infinity }) === 10);
    ok("effectiveVisitCap: exported DEFAULT is 10", G.DEFAULT_BACK_EDGE_VISIT_CAP === 10);
    ok("effectiveVisitCap: exported MAX is 1000", G.MAX_BACK_EDGE_VISIT_CAP === 1000);
  }

  // ── SLICE 6: armedBackEdges ────────────────────────────────────────────────────
  {
    // Fix-until-tests skeleton: W → G(guard); G.fail → W (back-edge); G.pass → DONE.
    const g = mixedGraph(
      ["W", { id: "G", kind: "guard" }, "DONE"],
      [
        edge("W", "G"),
        edge("G", "DONE", { branch: "pass" }),
        edge("G", "W", { branch: "fail", backEdge: true, visitCap: 3 }),
      ],
    );
    const backFail = g.edges.find((e) => e.backEdge === true);
    // Guard routed FAIL → the fail back-edge is armed.
    const routedFail = { W: { status: "succeeded" }, G: { status: "succeeded", branchResult: "fail" } };
    ok("armedBackEdges: guard fail routes the fail back-edge → armed", G.armedBackEdges(g, routedFail).map((e) => e.id).join() === backFail.id);
    // Guard routed PASS → the fail back-edge is NOT armed.
    const routedPass = { W: { status: "succeeded" }, G: { status: "succeeded", branchResult: "pass" } };
    ok("armedBackEdges: guard pass → fail back-edge NOT armed", G.armedBackEdges(g, routedPass).length === 0);
    // Guard not yet resolved (no branchResult) → not armed.
    ok("armedBackEdges: unresolved guard → not armed", G.armedBackEdges(g, { W: { status: "succeeded" }, G: { status: "succeeded" } }).length === 0);
    // A WORKER unconditional loop-back (no branch) arms on success.
    const wg = graphOf(["A", "B"], [edge("A", "B"), edge("B", "A", { backEdge: true })]);
    const backUncond = wg.edges.find((e) => e.backEdge === true);
    ok("armedBackEdges: worker unconditional back-edge arms on success", G.armedBackEdges(wg, { A: { status: "succeeded" }, B: { status: "succeeded" } }).map((e) => e.id).join() === backUncond.id);
    ok("armedBackEdges: worker back-edge source not succeeded → not armed", G.armedBackEdges(wg, { A: { status: "succeeded" }, B: { status: "failed" } }).length === 0);
    // A branch on a NON-guard back-edge is meaningless → never arms.
    const wgBranch = graphOf(["A", "B"], [edge("A", "B"), edge("B", "A", { backEdge: true, branch: "fail" })]);
    ok("armedBackEdges: branch on a worker back-edge never arms", G.armedBackEdges(wgBranch, { A: { status: "succeeded" }, B: { status: "succeeded" } }).length === 0);
    // A guard fail back-edge does NOT arm when the guard routed pass (vice-versa already covered) — and a guard back-edge with NO branch never arms.
    const gNoBranch = mixedGraph(
      ["W", { id: "G", kind: "guard" }],
      [edge("W", "G"), edge("G", "W", { backEdge: true })],
    );
    ok("armedBackEdges: guard back-edge with no branch never arms", G.armedBackEdges(gNoBranch, { W: { status: "succeeded" }, G: { status: "succeeded", branchResult: "fail" } }).length === 0);
    // Acyclic graph → no back-edges → never armed.
    const chain = graphOf(["A", "B", "C"], [edge("A", "B"), edge("B", "C")]);
    ok("armedBackEdges: acyclic chain → []", G.armedBackEdges(chain, states({ A: "succeeded", B: "succeeded", C: "succeeded" })).length === 0);
  }

  // ── SLICE 6: cycleBodyNodes ────────────────────────────────────────────────────
  {
    // W → G(guard); G.fail → W back-edge. Body of the back-edge G→W is {W, G}.
    const g = mixedGraph(
      ["W", { id: "G", kind: "guard" }, "DONE"],
      [
        edge("W", "G"),
        edge("G", "DONE", { branch: "pass" }),
        edge("G", "W", { branch: "fail", backEdge: true, visitCap: 3 }),
      ],
    );
    const backFail = g.edges.find((e) => e.backEdge === true);
    ok("cycleBodyNodes: simple W→G fail-loop body is {W,G}", G.cycleBodyNodes(g, backFail).slice().sort().join() === "G,W");
    ok("cycleBodyNodes: DONE (the exit branch) is NOT in the body", !G.cycleBodyNodes(g, backFail).includes("DONE"));

    // Nested/longer body: A → B → C → G(guard); G.fail → A. Body {A,B,C,G}.
    const longLoop = mixedGraph(
      ["A", "B", "C", { id: "G", kind: "guard" }, "DONE"],
      [
        edge("A", "B"),
        edge("B", "C"),
        edge("C", "G"),
        edge("G", "DONE", { branch: "pass" }),
        edge("G", "A", { branch: "fail", backEdge: true }),
      ],
    );
    const longBack = longLoop.edges.find((e) => e.backEdge === true);
    ok("cycleBodyNodes: longer loop body is {A,B,C,G}", G.cycleBodyNodes(longLoop, longBack).slice().sort().join() === "A,B,C,G");
    ok("cycleBodyNodes: exit DONE excluded from the longer body", !G.cycleBodyNodes(longLoop, longBack).includes("DONE"));

    // Partial loop: pre → A → B → G; G.fail → A (NOT pre). Body is {A,B,G}; the
    // upstream `pre` (before the back-edge target) is NOT reset.
    const partial = mixedGraph(
      ["pre", "A", "B", { id: "G", kind: "guard" }],
      [
        edge("pre", "A"),
        edge("A", "B"),
        edge("B", "G"),
        edge("G", "A", { branch: "fail", backEdge: true }),
      ],
    );
    const partialBack = partial.edges.find((e) => e.backEdge === true);
    ok("cycleBodyNodes: target's upstream `pre` is NOT in the body", G.cycleBodyNodes(partial, partialBack).slice().sort().join() === "A,B,G");

    // Sibling branch off the loop target that does NOT lead back to S is excluded.
    // A → {B → G(fail→A back), X (dead-ends)}.
    const sibling = mixedGraph(
      ["A", "B", { id: "G", kind: "guard" }, "X"],
      [
        edge("A", "B"),
        edge("A", "X"),
        edge("B", "G"),
        edge("G", "A", { branch: "fail", backEdge: true }),
      ],
    );
    const sibBack = sibling.edges.find((e) => e.backEdge === true);
    ok("cycleBodyNodes: sibling X (not on path back to S) excluded", G.cycleBodyNodes(sibling, sibBack).slice().sort().join() === "A,B,G");
  }

  // ── SLICE 6: forwardDescendants (un-skip set for loop-exit re-open) ────────────
  {
    const g = mixedGraph(
      ["W", { id: "G", kind: "guard" }, "DONE"],
      [
        edge("W", "G"),
        edge("G", "DONE", { branch: "pass" }),
        edge("G", "W", { branch: "fail", backEdge: true, visitCap: 3 }),
      ],
    );
    // From the loop body {W,G}, the forward descendants include the exit sink DONE.
    ok("forwardDescendants: from {W,G} includes the loop-exit DONE", G.forwardDescendants(g, ["W", "G"]).slice().sort().join() === "DONE,G,W");
    ok("forwardDescendants: ignores back-edges (W not reached via G→W back)", G.forwardDescendants(g, ["DONE"]).join() === "DONE");
    // Longer chain forward descendants.
    const chain = graphOf(["A", "B", "C"], [edge("A", "B"), edge("B", "C")]);
    ok("forwardDescendants: chain from A → A,B,C", G.forwardDescendants(chain, ["A"]).slice().sort().join() === "A,B,C");
    ok("forwardDescendants: chain from B → B,C", G.forwardDescendants(chain, ["B"]).slice().sort().join() === "B,C");
    ok("forwardDescendants: empty seed → []", G.forwardDescendants(chain, []).length === 0);
    ok("forwardDescendants: unknown seed ignored", G.forwardDescendants(chain, ["ZZ"]).length === 0);
  }

  // ── SLICE 6: backEdgesToFire respects visitCap (fires N then exhausts) ──────────
  {
    const g = mixedGraph(
      ["W", { id: "G", kind: "guard" }, "DONE"],
      [
        edge("W", "G"),
        edge("G", "DONE", { branch: "pass" }),
        edge("G", "W", { branch: "fail", backEdge: true, visitCap: 3 }),
      ],
    );
    const backFail = g.edges.find((e) => e.backEdge === true);
    const routedFail = { W: { status: "succeeded" }, G: { status: "succeeded", branchResult: "fail" } };
    // visits 0,1,2 < cap 3 → fires; visits 3 → exhausted.
    ok("backEdgesToFire: visits 0 < cap → fires", G.backEdgesToFire(g, routedFail, {}).length === 1);
    ok("backEdgesToFire: fired edge carries its reset body {W,G}", G.backEdgesToFire(g, routedFail, {})[0].resetNodes.slice().sort().join() === "G,W");
    ok("backEdgesToFire: visits 2 < cap 3 → still fires", G.backEdgesToFire(g, routedFail, { [backFail.id]: 2 }).length === 1);
    ok("backEdgesToFire: visits 3 == cap 3 → exhausted (no fire)", G.backEdgesToFire(g, routedFail, { [backFail.id]: 3 }).length === 0);
    ok("backEdgesToFire: visits 5 > cap → exhausted", G.backEdgesToFire(g, routedFail, { [backFail.id]: 5 }).length === 0);
    // Not armed (guard routed pass) → never fires regardless of visits.
    const routedPass = { W: { status: "succeeded" }, G: { status: "succeeded", branchResult: "pass" } };
    ok("backEdgesToFire: un-armed (pass route) → no fire", G.backEdgesToFire(g, routedPass, {}).length === 0);
    // Default cap (no visitCap) fires up to 10.
    const gDefault = mixedGraph(
      ["W", { id: "G", kind: "guard" }, "DONE"],
      [edge("W", "G"), edge("G", "DONE", { branch: "pass" }), edge("G", "W", { branch: "fail", backEdge: true })],
    );
    const dBack = gDefault.edges.find((e) => e.backEdge === true);
    ok("backEdgesToFire: default cap fires at visits 9", G.backEdgesToFire(gDefault, { W: { status: "succeeded" }, G: { status: "succeeded", branchResult: "fail" } }, { [dBack.id]: 9 }).length === 1);
    ok("backEdgesToFire: default cap exhausted at visits 10", G.backEdgesToFire(gDefault, { W: { status: "succeeded" }, G: { status: "succeeded", branchResult: "fail" } }, { [dBack.id]: 10 }).length === 0);
    // Acyclic graph → never fires.
    const chain = graphOf(["A", "B"], [edge("A", "B")]);
    ok("backEdgesToFire: acyclic → []", G.backEdgesToFire(chain, states({ A: "succeeded", B: "succeeded" }), {}).length === 0);
  }

  // ── SLICE 6: full fix-until-tests walk fixture ─────────────────────────────────
  {
    // W(worker) → G(guard:tests). G.pass → DONE; G.fail → W (back-edge, visitCap 3).
    // Simulate the run-store advance loop's effect on the projection: each "round"
    // the worker succeeds, the guard routes (we toggle pass/fail), and if it fails
    // AND the back-edge is firable we reset the body {W,G} to pending and bump the
    // edge's visit counter. Assert it loops EXACTLY until pass, OR until 3 tries
    // then exhausts.
    const makeG = () =>
      mixedGraph(
        ["W", { id: "G", kind: "guard" }, "DONE"],
        [
          edge("W", "G"),
          edge("G", "DONE", { branch: "pass" }),
          edge("G", "W", { branch: "fail", backEdge: true, visitCap: 3 }),
        ],
      );

    // Helper: run the simulated advance until the pass terminalizes; `guardPasses`
    // is a function(round)→bool deciding the guard outcome each round. Returns the
    // number of times the worker RAN (activations) and whether DONE was reached.
    const simulate = (guardPasses) => {
      const g = makeG();
      const back = g.edges.find((e) => e.backEdge === true);
      const visits = {};
      let proj = { W: { status: "pending" } };
      let workerRuns = 0;
      let reachedDone = false;
      // Bounded outer guard so a broken sim can't hang the test (cap*2 rounds max).
      for (let round = 0; round < 20; round += 1) {
        // 1) worker wave runs → succeeds.
        proj.W = { status: "succeeded", output: "ran" };
        workerRuns += 1;
        // 2) guard resolves (inline) — pass or fail this round.
        const passed = guardPasses(round);
        proj.G = { status: "succeeded", output: `guard: ${passed ? "pass" : "fail"}`, branchResult: passed ? "pass" : "fail" };
        // 3) prune the un-taken forward branch (DONE only matters on pass).
        for (const id of G.computeSkips(g, proj)) proj[id] = { status: "skipped" };
        // 4) fire any firable back-edge → reset body (+ un-skip descendants, as
        //    run-store does so the loop-exit sink re-opens) + bump visits.
        const firing = G.backEdgesToFire(g, proj, visits);
        for (const f of firing) {
          visits[f.edge.id] = (visits[f.edge.id] ?? 0) + 1;
          const widen = new Set(f.resetNodes);
          for (const id of G.forwardDescendants(g, f.resetNodes)) widen.add(id);
          for (const id of widen) proj[id] = { status: "pending" };
        }
        // 5) if nothing fired and the pass is complete → terminalize.
        if (firing.length === 0) {
          // resolve DONE if it became the ready worker wave (pass route).
          const ready = G.nextReadyWave(g, proj);
          if (ready.includes("DONE")) {
            proj.DONE = { status: "succeeded", output: "done" };
            reachedDone = true;
          }
          if (G.isPassComplete(g, proj, visits)) break;
        }
      }
      return { workerRuns, reachedDone, visits: visits[back.id] ?? 0 };
    };

    // Case A: guard passes on the FIRST round → worker runs once, DONE reached, 0 loops.
    const a = simulate(() => true);
    ok("fix-until: pass on first try → worker ran once", a.workerRuns === 1);
    ok("fix-until: pass on first try → DONE reached", a.reachedDone === true);
    ok("fix-until: pass on first try → 0 back-edge fires", a.visits === 0);

    // Case B: guard passes on round 2 (0-indexed) → fail,fail,pass → worker runs 3×, 2 loops.
    const b = simulate((round) => round >= 2);
    ok("fix-until: pass on 3rd try → worker ran 3×", b.workerRuns === 3);
    ok("fix-until: pass on 3rd try → DONE reached", b.reachedDone === true);
    ok("fix-until: pass on 3rd try → 2 back-edge fires", b.visits === 2);

    // Case C: guard NEVER passes → loops exactly visitCap(3) times then exhausts.
    // Worker runs once initially + 3 loop re-runs = 4 runs; DONE never reached.
    const c = simulate(() => false);
    ok("fix-until: never passes → back-edge fires exactly 3× (cap)", c.visits === 3);
    ok("fix-until: never passes → worker ran 4× (1 + 3 loops)", c.workerRuns === 4);
    ok("fix-until: never passes → DONE never reached", c.reachedDone === false);
  }

  // ── SLICE 6: isPassComplete interplay with back-edges ──────────────────────────
  {
    const g = mixedGraph(
      ["W", { id: "G", kind: "guard" }, "DONE"],
      [
        edge("W", "G"),
        edge("G", "DONE", { branch: "pass" }),
        edge("G", "W", { branch: "fail", backEdge: true, visitCap: 3 }),
      ],
    );
    const back = g.edges.find((e) => e.backEdge === true);
    // Guard routed FAIL, back-edge firable (visits 0 < 3) → NOT complete.
    const failFirable = { W: { status: "succeeded" }, G: { status: "succeeded", branchResult: "fail" } };
    ok("isPassComplete: armed+firable back-edge → NOT complete", G.isPassComplete(g, failFirable, {}) === false);
    ok("isPassComplete: armed+firable (default visits {}) → NOT complete", G.isPassComplete(g, failFirable) === false);
    // Guard routed FAIL, back-edge EXHAUSTED (visits 3 == cap), DONE skipped (fail
    // route pruned it) → the loop has exited and nothing else is ready → complete.
    const failExhausted = { W: { status: "succeeded" }, G: { status: "succeeded", branchResult: "fail" }, DONE: { status: "skipped" } };
    ok("isPassComplete: exhausted back-edge + no ready node → complete", G.isPassComplete(g, failExhausted, { [back.id]: 3 }) === true);
    ok("isPassComplete: exhausted back-edge does NOT wrongly hold the pass", G.isPassComplete(g, failExhausted, { [back.id]: 3 }) === true);
    // Guard routed PASS → DONE is the ready worker wave → NOT complete until DONE runs.
    const routedPass = { W: { status: "succeeded" }, G: { status: "succeeded", branchResult: "pass" } };
    ok("isPassComplete: pass route, DONE pending → NOT complete", G.isPassComplete(g, routedPass, {}) === false);
    const passDone = { ...routedPass, DONE: { status: "succeeded" } };
    ok("isPassComplete: pass route + DONE done → complete", G.isPassComplete(g, passDone, {}) === true);
  }

  // ── SLICE 6: ACYCLIC parity (back-edge machinery is inert) ─────────────────────
  {
    // The slice-6 additions must not perturb any acyclic graph: armedBackEdges/
    // backEdgesToFire return [], and isPassComplete with the visits arg matches the
    // 2-arg form exactly.
    const chain = graphOf(["A", "B", "C"], [edge("A", "B"), edge("B", "C")]);
    const merge = mixedGraph(
      ["A", "B", { id: "M", kind: "merge", joinMode: "all" }, "C"],
      [edge("A", "M"), edge("B", "M"), edge("M", "C")],
    );
    const guardOnly = mixedGraph(
      ["A", { id: "Gp", kind: "guard" }, "P", "F"],
      [edge("A", "Gp"), edge("Gp", "P", { branch: "pass" }), edge("Gp", "F", { branch: "fail" })],
    );
    const single = graphOf(["w0"]);
    for (const [name, g, st] of [
      ["chain", chain, states({ A: "succeeded", B: "succeeded", C: "succeeded" })],
      ["chain-failed", chain, states({ A: "failed" })],
      ["merge", merge, statesOut({ A: ["succeeded", "rA"], B: ["succeeded", "rB"], M: ["succeeded", "rM"], C: ["succeeded", "rC"] })],
      ["guard-routed", guardOnly, { A: { status: "succeeded" }, Gp: { status: "succeeded", branchResult: "pass" }, P: { status: "succeeded" }, F: { status: "skipped" } }],
      ["single", single, states({ w0: "succeeded" })],
    ]) {
      ok(`acyclic parity: ${name} → armedBackEdges []`, G.armedBackEdges(g, st).length === 0);
      ok(`acyclic parity: ${name} → backEdgesToFire []`, G.backEdgesToFire(g, st, {}).length === 0);
      ok(
        `acyclic parity: ${name} → isPassComplete(3-arg) === isPassComplete(2-arg)`,
        G.isPassComplete(g, st, {}) === G.isPassComplete(g, st),
      );
    }
    // And the fresh/in-flight states stay NOT complete identically.
    ok("acyclic parity: fresh chain NOT complete (3-arg)", G.isPassComplete(chain, states({}), {}) === false);
    ok("acyclic parity: A running NOT complete (3-arg)", G.isPassComplete(chain, states({ A: "running" }), {}) === false);
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  assert.ok(passed >= 12, `expected >= 12 checks, ran ${passed}`);
  console.log(`\nAll ${passed} loom-graph checks PASSED.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nLOOM-GRAPH TEST FAILED:\n", err);
    process.exit(1);
  },
);
