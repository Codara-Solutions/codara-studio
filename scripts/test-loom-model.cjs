// Pure unit tests for the node-flow editor MODEL validators (src/renderer/src/
// components/automations/flow/model.ts) + the preset gallery (presets.ts).
// model.ts/presets.ts import ONLY types (@shared/types, @xyflow/react, ./presets),
// all erased by esbuild — so this harness bundles them with NO DOM and exercises
// the real validateGraph / flowFromGraph / graphFromFlow against every shipped
// preset graph (catches FIX 4 + the dual-write/graph→flow→graph round-trip).
//
//   node scripts/test-loom-model.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const FLOW_DIR = path.join(ROOT, "src", "renderer", "src", "components", "automations", "flow");
const MODEL_TS = path.join(FLOW_DIR, "model.ts");
const PRESETS_TS = path.join(FLOW_DIR, "presets.ts");

const harnessPlugin = {
  name: "loom-model-test-harness",
  setup(build) {
    // @shared/types → real source (type-only import, erased — resolved
    // defensively so a future value import never breaks the bundle).
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    // @xyflow/react is a TYPE-ONLY import in model.ts (Edge/Node), erased by
    // esbuild — stub it so the bundle never tries to resolve the real package.
    build.onResolve({ filter: /^@xyflow\/react$/ }, () => ({
      path: "xyflow",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export {};\n",
      loader: "js",
    }));
  },
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-loommodel-"));
  const outfile = path.join(tmp, "loom-model.bundle.cjs");
  // Combined entry: re-export model's validators + presets' gallery in ONE
  // bundle so they share module state and a preset graph round-trips through the
  // real flowFromGraph/validateGraph.
  const entryFile = path.join(tmp, "loom-model-entry.ts");
  fs.writeFileSync(
    entryFile,
    `export { validateGraph, flowFromGraph, graphFromFlow, TRIGGER_ID } from ${JSON.stringify(MODEL_TS)};\n` +
      `export { PRESETS } from ${JSON.stringify(PRESETS_TS)};\n`,
  );
  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    resolveExtensions: [".ts", ".tsx", ".js", ".cjs", ".mjs", ".json"],
    plugins: [harnessPlugin],
  });
  const M = require(outfile);

  let passed = 0;
  const ok = (name, cond) => {
    if (!cond) throw new Error(`FAIL: ${name}`);
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  // A minimal ScheduledJob carrying a graph (flowFromGraph only reads job.graph
  // via graphForJob, plus job.trigger for the pinned trigger node + job.worker /
  // job.prompt fallbacks). manual trigger keeps the trigger node simple.
  const jobWithGraph = (graph) => ({
    id: "j",
    name: "preset",
    enabled: true,
    trigger: { kind: "manual" },
    worker: { engine: "auto" },
    prompt: { template: "" },
    input: { workspaceId: "ws", cwd: "/tmp", initialUserNote: "" },
    graph,
    createdAt: new Date().toISOString(),
  });

  // ── 1) EVERY shipped preset that has a graph validates clean ───────────────
  // (FIX 4: the "fix until tests pass" preset's guard has ONLY a fail branch
  // wired — requiring BOTH would brick it. The graph→flow→graph round-trip via
  // flowFromGraph also catches a dual-write drift.)
  {
    const withGraph = M.PRESETS.filter((p) => p.graph);
    ok("there is at least one preset graph to validate", withGraph.length >= 1);
    for (const p of withGraph) {
      const { nodes, edges } = M.flowFromGraph(jobWithGraph(p.graph));
      const problem = M.validateGraph(nodes, edges);
      ok(`preset "${p.id}" graph validates clean (validateGraph === null)`, problem === null);
    }
    // The fix-until-tests preset specifically: confirm its guard is fail-only.
    const fixUntil = withGraph.find((p) => p.id === "until-tests");
    ok("fix-until-tests preset exists with a guard graph", Boolean(fixUntil));
    const guard = fixUntil.graph.nodes.find((n) => n.kind === "guard");
    const guardEdges = fixUntil.graph.edges.filter((e) => e.from === guard.id);
    ok(
      "fix-until-tests guard has ONLY a fail branch wired (no pass branch)",
      guardEdges.some((e) => e.branch === "fail") && !guardEdges.some((e) => e.branch === "pass"),
    );
  }

  // ── 2) FIX 4 directly: a guard with ONE branch passes; NO branch fails ─────
  // Build FlowNode/FlowEdge arrays directly (trigger → worker → guard → ...).
  const TRIGGER = M.TRIGGER_ID;
  const triggerNode = { id: TRIGGER, type: "trigger", position: { x: 0, y: 0 }, data: { kind: "trigger", label: "Trigger" } };
  const workerNode = (id, label) => ({
    id,
    type: "worker",
    position: { x: 100, y: 0 },
    data: { kind: "worker", label: label ?? "Worker", worker: { engine: "auto" }, prompt: "do work" },
  });
  const guardNode = (id, label) => ({
    id,
    type: "guard",
    position: { x: 200, y: 0 },
    data: { kind: "guard", label: label ?? "Guard", predicate: { type: "tests", command: "npm test" } },
  });
  const fEdge = (id, source, target, over = {}) => ({ id, source, target, type: "loom", ...over });

  {
    // Guard with ONLY a fail branch wired → its fail edge feeds a second worker.
    // (pass is an implicit terminal route; FIX 4 allows it.)
    const nodes = [triggerNode, workerNode("w0"), guardNode("g0"), workerNode("w1", "Fixer")];
    const edges = [
      fEdge("e-t-w0", TRIGGER, "w0"),
      fEdge("e-w0-g0", "w0", "g0"),
      fEdge("e-g0-w1", "g0", "w1", { sourceHandle: "fail", data: { branch: "fail" } }),
    ];
    ok("guard with only a fail branch wired validates clean", M.validateGraph(nodes, edges) === null);
  }
  {
    // Guard with ONLY a pass branch wired → also clean (symmetry of FIX 4).
    const nodes = [triggerNode, workerNode("w0"), guardNode("g0"), workerNode("w1", "Next")];
    const edges = [
      fEdge("e-t-w0", TRIGGER, "w0"),
      fEdge("e-w0-g0", "w0", "g0"),
      fEdge("e-g0-w1", "g0", "w1", { sourceHandle: "pass", data: { branch: "pass" } }),
    ];
    ok("guard with only a pass branch wired validates clean", M.validateGraph(nodes, edges) === null);
  }
  {
    // Guard with NO branch wired at all → a real error (FIX 4's only failure).
    const nodes = [triggerNode, workerNode("w0"), guardNode("g0", "Tests pass?")];
    const edges = [fEdge("e-t-w0", TRIGGER, "w0"), fEdge("e-w0-g0", "w0", "g0")];
    const problem = M.validateGraph(nodes, edges);
    ok(
      "guard with NO branch wired fails validation with the at-least-one message",
      problem !== null &&
        problem.focusNodeId === "g0" &&
        /at least one branch \(pass or fail\)/.test(problem.message),
    );
  }

  // ── 3) per-worker access/blockedTools/collab round-trip (minimal persist) ──
  {
    const mkWorker = (id, extra) => ({
      id,
      type: "worker",
      position: { x: 100, y: 0 },
      data: { kind: "worker", label: "Worker", worker: { engine: "claude" }, prompt: "do work", ...extra },
    });

    // A fully-default worker persists NONE of the new fields (byte-identical to
    // before the feature).
    {
      const g = M.graphFromFlow([triggerNode, mkWorker("w0", {})], [fEdge("e", TRIGGER, "w0")]);
      const n = g.nodes.find((x) => x.id === "w0");
      ok("default worker omits access", n.access === undefined);
      ok("default worker omits blockedTools", n.blockedTools === undefined);
      ok("default worker omits collab", n.collab === undefined);
    }

    // access:"full" is treated as the default and dropped; edits/readonly persist.
    {
      const g = M.graphFromFlow([triggerNode, mkWorker("w0", { access: "full" })], [fEdge("e", TRIGGER, "w0")]);
      ok("access 'full' is not persisted (kept minimal)", g.nodes.find((x) => x.id === "w0").access === undefined);
    }
    {
      const g = M.graphFromFlow([triggerNode, mkWorker("w0", { access: "readonly" })], [fEdge("e", TRIGGER, "w0")]);
      ok("access 'readonly' persists", g.nodes.find((x) => x.id === "w0").access === "readonly");
    }
    // Looms on Pi: readonly is valid for every model (the Pi harness enforces
    // the fence and the worker keeps write for its final report), so a gpt
    // worker's readonly persists as-is instead of the old codex edits flip.
    {
      const gptRo = {
        id: "w0",
        type: "worker",
        position: { x: 100, y: 0 },
        data: { kind: "worker", label: "Worker", worker: { model: "gpt-5.6-sol", effort: "medium" }, prompt: "do work", access: "readonly" },
      };
      const g = M.graphFromFlow([triggerNode, gptRo], [fEdge("e", TRIGGER, "w0")]);
      ok("gpt 'readonly' persists (no edits flip on Pi)", g.nodes.find((x) => x.id === "w0").access === "readonly");
    }

    // blockedTools: the rebuilt editor persists the list as authored; the
    // scheduler's normalizeJob is the enforcement backstop that drops scoped
    // and blank entries on every persisted write (see test-automations.cjs).
    {
      const g = M.graphFromFlow(
        [triggerNode, mkWorker("w0", { blockedTools: ["WebSearch", "Bash"] })],
        [fEdge("e", TRIGGER, "w0")],
      );
      const n = g.nodes.find((x) => x.id === "w0");
      ok("blockedTools persist on the node", JSON.stringify(n.blockedTools) === JSON.stringify(["WebSearch", "Bash"]));
    }
    {
      const g = M.graphFromFlow(
        [triggerNode, mkWorker("w0", { blockedTools: [] })],
        [fEdge("e", TRIGGER, "w0")],
      );
      ok("an empty blockedTools list persists nothing", g.nodes.find((x) => x.id === "w0").blockedTools === undefined);
    }

    // collab: an all-false object drops; only the true flags persist.
    {
      const g = M.graphFromFlow(
        [triggerNode, mkWorker("w0", { collab: { awareness: false, chat: false } })],
        [fEdge("e", TRIGGER, "w0")],
      );
      ok("all-false collab persists nothing", g.nodes.find((x) => x.id === "w0").collab === undefined);
    }
    {
      const g = M.graphFromFlow(
        [triggerNode, mkWorker("w0", { collab: { awareness: true, chat: false } })],
        [fEdge("e", TRIGGER, "w0")],
      );
      const n = g.nodes.find((x) => x.id === "w0");
      ok("collab persists only the true flags", JSON.stringify(n.collab) === JSON.stringify({ awareness: true }));
    }
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  assert.ok(passed >= 6, `expected >= 6 checks, ran ${passed}`);
  console.log(`\nAll ${passed} loom-model checks PASSED.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nLOOM-MODEL TEST FAILED:\n", err);
    process.exit(1);
  },
);
