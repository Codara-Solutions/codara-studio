// Unit tests for the Looms v3 step executor (src/main/orchestration/loom-steps.ts)
// and the shared inline resolver (loom-resolve.ts) that runs steps between
// worker waves. Real shell / fs / http are exercised (the whole point of a
// step is to touch the world); the notify pipeline is injected so no Electron
// module loads.
//
//   node scripts/test-loom-steps.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const RESOLVE_TS = path.join(ROOT, "src", "main", "orchestration", "loom-resolve.ts");

const harnessPlugin = {
  name: "loom-steps-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    // The notify action only reaches ../notify when no sink is injected; stub
    // the module so the bundle never drags Electron in.
    build.onResolve({ filter: /^\.\.\/notify$/ }, () => ({ path: "notify", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export function publish(e){ (globalThis.__PUB ??= []).push(e); }",
      loader: "js",
    }));
  },
};

function ctx(over = {}) {
  return { cwd: os.tmpdir(), vars: { date: "2026-08-28", name: "t" }, nodeOutputs: {}, incoming: [], ...over };
}
const step = (id, action, extra = {}) => ({ id, kind: "step", action, ...extra });

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-loomsteps-"));
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
  const mod = require(outfile);
  // loom-steps is bundled inside loom-resolve; reach its exports through a
  // second entry so the executor is tested directly too.
  const stepsOut = path.join(tmp, "loom-steps.bundle.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "loom-steps.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: stepsOut,
    plugins: [harnessPlugin],
    logLevel: "silent",
  });
  const steps = require(stepsOut);
  const { executeStep, stepOutcome, renderStepTemplate } = steps;
  const { resolveInlineNodes, stepNoteMessage } = mod;
  const isWin = process.platform === "win32";
  let passed = 0;
  const t = async (name, fn) => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  console.log("loom-steps");

  await t("command: stdout is the output, exit 0 is ok", async () => {
    const r = await executeStep(step("s", { type: "command", command: "echo hello" }), ctx());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.output, "hello");
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.durationMs >= 0);
  });

  await t("command: non-zero exit fails with stdout, reason, stderr in order", async () => {
    const r = await executeStep(
      step("s", { type: "command", command: isWin ? "echo out & echo err 1>&2 & exit 3" : "echo out; echo err >&2; exit 3" }),
      ctx(),
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 3);
    assert.strictEqual(r.error, "exit 3");
    assert.strictEqual(r.output, "out\n[exit 3]\nerr");
  });

  await t("command: templates substitute vars + node outputs, never auto-append incoming", async () => {
    const r = await executeStep(
      step("s", { type: "command", command: "echo {{date}} {{node:a}} {{name}}" }),
      ctx({ nodeOutputs: { a: "AAA" }, incoming: ["UPSTREAM TRANSCRIPT"] }),
    );
    assert.strictEqual(r.output, "2026-08-28 AAA t");
    const plain = await executeStep(step("s", { type: "command", command: "echo hi" }), ctx({ incoming: ["UPSTREAM"] }));
    assert.strictEqual(plain.output, "hi");
    assert.strictEqual(renderStepTemplate("x {{incoming}}", ctx({ incoming: ["A", "B"] })).includes("Output from upstream node 2"), true);
  });

  await t("command: pass vars + upstream outputs are exported as env", async () => {
    const r = await executeStep(
      step("s", { type: "command", command: isWin ? "echo %DATE%|%NODE_OUTPUT_A_B%|%AUTOMATION_NAME%|%INCOMING%" : 'echo "$DATE|$NODE_OUTPUT_A_B|$AUTOMATION_NAME|$INCOMING"' }),
      ctx({ nodeOutputs: { "a-b": "multi\nline [x]" }, incoming: ["multi\nline [x]"] }),
    );
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.output, "2026-08-28|multi\nline [x]|t|multi\nline [x]");
  });

  await t("token filters: |json |line |trim; unknown filter left intact", async () => {
    const out = 'He said "hi"\nsecond';
    const r = await executeStep(
      step("s", { type: "writeFile", path: "f.txt", content: '{"text": {{node:a|json}}, "first": "{{node:a|line}}", "keep": "{{node:a|nope}}"}', mode: "overwrite" }),
      ctx({ cwd: fs.mkdtempSync(path.join(tmp, "flt-")), nodeOutputs: { a: out } }),
    );
    assert.strictEqual(r.ok, true, r.error);
    const written = fs.readFileSync(r.output, "utf8");
    assert.strictEqual(written, `{"text": ${JSON.stringify(out)}, "first": "He said \"hi\"", "keep": "{{node:a|nope}}"}`);
    assert.strictEqual(renderStepTemplate("{{incoming|json}}", ctx({ incoming: ["x"] })).startsWith('"--- Output from upstream node 1 ---'), true);
    assert.strictEqual(renderStepTemplate("{{name|upper}} {{date|line}}", ctx()), "T 2026-08-28");
  });

  await t("command: env + cwd honored", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "cwd-"));
    const r = await executeStep(
      step("s", { type: "command", command: isWin ? "echo %FOO% & cd" : "echo $FOO; pwd", cwd: dir, env: { FOO: "bar-{{name}}" } }),
      ctx(),
    );
    assert.strictEqual(r.ok, true);
    assert.ok(r.output.startsWith("bar-t"), r.output);
    assert.ok(r.output.includes(fs.realpathSync(dir)) || r.output.includes(dir), r.output);
  });

  await t("command: timeout kills the process and reports timedOut", async () => {
    const r = await executeStep(step("s", { type: "command", command: isWin ? "ping -n 6 127.0.0.1 >nul" : "sleep 5" }, { timeoutSec: 1 }), ctx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.timedOut, true);
    assert.ok(/timed out/.test(r.error));
  });

  await t("command: empty command is a failure, not a spawn", async () => {
    const r = await executeStep(step("s", { type: "command", command: "   " }), ctx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "empty command");
  });

  await t("script: node runs on the bundled binary", async () => {
    const r = await executeStep(
      step("s", { type: "script", language: "node", code: 'console.log("node " + [1,2].length + " {{node:a}}")' }),
      ctx({ nodeOutputs: { a: "ok" } }),
    );
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.output, "node 2 ok");
  });

  if (!isWin) {
    await t("script: bash", async () => {
      const r = await executeStep(step("s", { type: "script", language: "bash", code: 'x=3\necho "bash $x"' }), ctx());
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.output, "bash 3");
    });
    await t("script: python (python3)", async () => {
      const r = await executeStep(step("s", { type: "script", language: "python", code: 'import sys\nprint("py", sys.version_info[0])' }), ctx());
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.output, "py 3");
    });
    await t("script: a custom interpreter runs the file (uv-style runner prefix)", async () => {
      // Any prefix works — here a shell function stands in for `uv run python`.
      const r = await executeStep(
        step("s", { type: "script", language: "python", code: 'print("via custom")', interpreter: "env RUNNER=1 python3" }),
        ctx(),
      );
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.output, "via custom");
      const missing = await executeStep(
        step("s", { type: "script", language: "python", code: 'print("x")', interpreter: "definitely-not-a-runner-xyz" }),
        ctx(),
      );
      assert.strictEqual(missing.ok, false);
      assert.ok(/not found|exit 127/.test(missing.output), missing.output);
    });
    await t("script: a raising script fails with the traceback in output", async () => {
      const r = await executeStep(step("s", { type: "script", language: "python", code: 'raise SystemExit("boom")' }), ctx());
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.exitCode, 1);
      assert.ok(r.output.includes("boom"), r.output);
    });
  }

  await t("http: 2xx body is the output; non-2xx fails with the status", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ method: req.method, body, hdr: req.headers["x-token"] }));
        });
        return;
      }
      res.statusCode = 500;
      res.end("nope");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const r = await executeStep(
        step("s", {
          type: "http",
          method: "POST",
          url: `http://127.0.0.1:${port}/ok`,
          headers: { "x-token": "tok-{{name}}" },
          body: '{"n":"{{node:a}}"}',
        }),
        ctx({ nodeOutputs: { a: "A" } }),
      );
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(r.output), { method: "POST", body: '{"n":"A"}', hdr: "tok-t" });
      const bad = await executeStep(step("s", { type: "http", method: "GET", url: `http://127.0.0.1:${port}/bad` }), ctx());
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.statusCode, 500);
      assert.ok(bad.output.includes("nope") && bad.output.includes("[HTTP 500"), bad.output);
    } finally {
      server.close();
    }
  });

  await t("writeFile: overwrite then append, relative to cwd, output is the path", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "wf-"));
    const r1 = await executeStep(step("s", { type: "writeFile", path: "notes/{{date}}.md", content: "one\n", mode: "overwrite" }), ctx({ cwd: dir }));
    assert.strictEqual(r1.ok, true, r1.error);
    const file = path.join(dir, "notes", "2026-08-28.md");
    assert.strictEqual(r1.output, file);
    const r2 = await executeStep(step("s", { type: "writeFile", path: file, content: "two {{node:a}}\n", mode: "append" }), ctx({ nodeOutputs: { a: "X" } }));
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "one\ntwo X\n");
  });

  await t("notify: the injected sink receives the rendered title + message", async () => {
    const seen = [];
    const r = await executeStep(
      step("s", { type: "notify", title: "Nightly {{name}}", message: "Done: {{node:a}}" }),
      ctx({ nodeOutputs: { a: "42" }, notify: (e) => seen.push(e) }),
    );
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(seen, [{ title: "Nightly t", message: "Done: 42" }]);
    assert.strictEqual(r.output, "Done: 42");
  });

  await t("stepOutcome: continueOnError turns a failure into a succeeded settle with the error text", async () => {
    const failed = { ok: false, output: "[exit 2]\nbad", durationMs: 1, error: "exit 2" };
    assert.deepStrictEqual(stepOutcome({}, failed), { status: "failed", output: "[exit 2]\nbad" });
    assert.deepStrictEqual(stepOutcome({ continueOnError: true }, failed), { status: "succeeded", output: "[exit 2]\nbad" });
    assert.deepStrictEqual(stepOutcome({}, { ok: true, output: "fine", durationMs: 1 }), { status: "succeeded", output: "fine" });
  });

  console.log("loom-resolve (steps inline)");

  const worker = (id) => ({ id, kind: "worker", worker: { model: "m", effort: "medium" }, prompt: `do ${id}` });
  const edge = (from, to, over = {}) => ({ id: `${from}->${to}`, from, to, ...over });
  const graphBundle = path.join(tmp, "graph.bundle.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "loom-graph.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: graphBundle,
    plugins: [harnessPlugin],
    logLevel: "silent",
  });
  const { nextReadyWave } = require(graphBundle);

  await t("a chain of entry steps settles in one call and readies the worker with their outputs", async () => {
    const graph = {
      version: 1,
      nodes: [
        step("s0", { type: "command", command: "echo first" }),
        step("s1", { type: "command", command: "echo {{node:s0}} second" }),
        worker("w"),
      ],
      edges: [edge("s0", "s1"), edge("s1", "w")],
      entryNodeIds: ["s0"],
    };
    const projected = {};
    const res = await resolveInlineNodes(graph, projected, { cwd: os.tmpdir(), vars: {} });
    assert.deepStrictEqual(res.steps.map((s) => [s.nodeId, s.status, s.output]), [
      ["s0", "succeeded", "first"],
      ["s1", "succeeded", "first second"],
    ]);
    assert.strictEqual(projected.s1.output, "first second");
    assert.deepStrictEqual(nextReadyWave(graph, projected), ["w"]);
    assert.strictEqual(stepNoteMessage(res.steps[1]), "first second");
  });

  await t("a failed entry step settles failed and nothing downstream becomes ready", async () => {
    const graph = {
      version: 1,
      nodes: [step("s0", { type: "command", command: "exit 4" }), worker("w")],
      edges: [edge("s0", "w")],
      entryNodeIds: ["s0"],
    };
    const projected = {};
    const res = await resolveInlineNodes(graph, projected, { cwd: os.tmpdir(), vars: {} });
    assert.strictEqual(res.steps[0].status, "failed");
    assert.deepStrictEqual(nextReadyWave(graph, projected), []);
    assert.ok(stepNoteMessage(res.steps[0]).startsWith('Step "s0" failed:'));
  });

  await t("step → guard(phrase) routes on the step's output and prunes the dead branch", async () => {
    const graph = {
      version: 1,
      nodes: [
        step("s0", { type: "command", command: "echo ALL GREEN" }),
        { id: "g", kind: "guard", predicate: { type: "phrase", phrase: "green" } },
        worker("ok"),
        worker("fix"),
      ],
      edges: [edge("s0", "g"), edge("g", "ok", { branch: "pass" }), edge("g", "fix", { branch: "fail" })],
      entryNodeIds: ["s0"],
    };
    const projected = {};
    const res = await resolveInlineNodes(graph, projected, { cwd: os.tmpdir(), vars: {} });
    assert.deepStrictEqual(res.guards, [{ nodeId: "g", branch: "pass", output: "guard: pass" }]);
    assert.deepStrictEqual(res.skipped, ["fix"]);
    assert.deepStrictEqual(nextReadyWave(graph, projected), ["ok"]);
  });

  await t("continueOnError lets the chain proceed past a failing step", async () => {
    const graph = {
      version: 1,
      nodes: [
        step("s0", { type: "command", command: "echo partial; exit 1" }, { continueOnError: true }),
        // Upstream output is also exported as $NODE_OUTPUT_<ID> — the safe way
        // to read a multi-line/special-char output inside a shell line.
        step("s1", { type: "command", command: 'echo "got:$NODE_OUTPUT_S0"' }),
      ],
      edges: [edge("s0", "s1")],
      entryNodeIds: ["s0"],
    };
    const projected = {};
    const res = await resolveInlineNodes(graph, projected, { cwd: os.tmpdir(), vars: {} });
    assert.strictEqual(res.steps[0].status, "succeeded");
    assert.strictEqual(res.steps[1].output, "got:partial\n[exit 1]");
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
