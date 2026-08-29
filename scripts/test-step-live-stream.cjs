// Live steps-only pass streaming (Looms v3.1): the inline resolver's
// onStepEvent seam plus loom-steps' onOutput streaming. Asserts that a
// steps-only resolution emits started/output/settled per step in execution
// order, that streamed chunks reassemble into the captured output, and that
// the resolution's settled lists stay byte-identical to a run WITHOUT the
// live sink (finalize parity: the after-the-fact record path and the live
// path persist the same node states).
//
//   node scripts/test-step-live-stream.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const RESOLVE_TS = path.join(ROOT, "src", "main", "orchestration", "loom-resolve.ts");

const harnessPlugin = {
  name: "step-live-stream-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^\.\.\/notify$/ }, () => ({ path: "notify", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export function publish(e){ (globalThis.__PUB ??= []).push(e); }",
      loader: "js",
    }));
  },
};

const step = (id, action, extra = {}) => ({ id, kind: "step", action, ...extra });

function graphOf(nodes, edges) {
  return {
    version: 1,
    nodes,
    edges,
    entryNodeIds: [nodes[0].id],
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-livestream-"));
  const outfile = path.join(tmp, "loom-resolve.bundle.cjs");
  await esbuild.build({
    entryPoints: [RESOLVE_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [harnessPlugin],
    logLevel: "silent",
  });
  const { resolveInlineNodes } = require(outfile);
  const isWin = process.platform === "win32";
  let passed = 0;
  const t = async (name, fn) => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  console.log("step live streaming");

  const twoSteps = () =>
    graphOf(
      [
        step("a", { type: "command", command: "echo alpha" }, { label: "First" }),
        step("b", { type: "command", command: "echo beta {{node:a}}" }, { label: "Second" }),
      ],
      [{ id: "e", from: "a", to: "b" }],
    );

  await t("events arrive in execution order with per-step lifecycle", async () => {
    const events = [];
    const projected = {};
    await resolveInlineNodes(twoSteps(), projected, {
      cwd: os.tmpdir(),
      vars: {},
      onStepEvent: (e) => events.push(e),
    });
    const shape = events.map((e) => `${e.kind}:${e.nodeId}`);
    assert.strictEqual(shape[0], "started:a");
    assert.strictEqual(shape[shape.length - 1], "settled:b");
    const settleA = shape.indexOf("settled:a");
    const startB = shape.indexOf("started:b");
    assert.ok(settleA > 0 && startB > settleA, `b starts after a settles: ${shape.join(",")}`);
    const settledA = events.find((e) => e.kind === "settled" && e.nodeId === "a");
    assert.strictEqual(settledA.status, "succeeded");
    assert.strictEqual(settledA.output, "alpha");
    assert.strictEqual(settledA.label, "First");
    const settledB = events.find((e) => e.kind === "settled" && e.nodeId === "b");
    assert.strictEqual(settledB.output, "beta alpha");
  });

  await t("streamed chunks reassemble into the captured output", async () => {
    const events = [];
    const projected = {};
    await resolveInlineNodes(
      graphOf([step("s", { type: "command", command: "echo one; echo two" }, { label: "S" })], []),
      projected,
      { cwd: os.tmpdir(), vars: {}, onStepEvent: (e) => events.push(e) },
    );
    const streamed = events
      .filter((e) => e.kind === "output" && e.nodeId === "s")
      .map((e) => e.chunk)
      .join("");
    assert.ok(streamed.includes("one"), `streamed carries stdout: ${JSON.stringify(streamed)}`);
    assert.ok(streamed.includes("two"), `streamed carries later chunks: ${JSON.stringify(streamed)}`);
    const settled = events.find((e) => e.kind === "settled");
    assert.strictEqual(settled.output, "one\ntwo");
  });

  await t("a failing step settles as failed, downstream never starts", async () => {
    const events = [];
    const projected = {};
    const res = await resolveInlineNodes(
      graphOf(
        [
          step(
            "boom",
            { type: "command", command: isWin ? "exit 7" : "echo doomed; exit 7" },
            { label: "Boom" },
          ),
          step("next", { type: "command", command: "echo unreachable" }, { label: "Next" }),
        ],
        [{ id: "e", from: "boom", to: "next" }],
      ),
      projected,
      { cwd: os.tmpdir(), vars: {}, onStepEvent: (e) => events.push(e) },
    );
    const settled = events.find((e) => e.kind === "settled" && e.nodeId === "boom");
    assert.strictEqual(settled.status, "failed");
    assert.strictEqual(projected.boom.status, "failed");
    assert.ok(!events.some((e) => e.nodeId === "next"), "downstream of a failed step stays silent");
    assert.strictEqual(res.steps.length, 1);
  });

  await t("finalize parity: resolution is identical with and without the live sink", async () => {
    const silentProjected = {};
    const silent = await resolveInlineNodes(twoSteps(), silentProjected, {
      cwd: os.tmpdir(),
      vars: {},
    });
    const liveProjected = {};
    const live = await resolveInlineNodes(twoSteps(), liveProjected, {
      cwd: os.tmpdir(),
      vars: {},
      onStepEvent: () => {},
    });
    assert.deepStrictEqual(
      live.steps.map((s) => ({ nodeId: s.nodeId, status: s.status, output: s.output })),
      silent.steps.map((s) => ({ nodeId: s.nodeId, status: s.status, output: s.output })),
    );
    assert.deepStrictEqual(liveProjected, silentProjected);
  });

  console.log(`\n${passed} checks passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
