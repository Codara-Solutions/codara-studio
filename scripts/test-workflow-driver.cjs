// Guards the workflow driver (src/main/orchestration/workflow-driver.ts)
// against a stub run store and the real sandbox: a failing, crashing or
// schema-violating agent resolves null instead of failing the run, phases and
// call markers reach the launches, Stop parks the run and Resume answers the
// finished calls from the journal, and after an app restart recovery journals
// a report an interrupted agent had already written, parks the run and starts
// nothing, so Resume pays for no agent twice. A saved workflow edited after it
// was checked or approved does not run.
//
//   node scripts/test-workflow-driver.cjs

const fs = require("node:fs");
const path = require("node:path");
const { ROOT, bundleModule, loadSandboxWorkerCode, check, finish, tempDir } = require("./workflow-test-harness.cjs");

const SCHEMA = { type: "object", properties: { n: {} , v: { type: "integer" } } };
const STRICT = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  return false;
}

// Agents answer from their prompt: "ok:<json>" completes with that result,
// "fail" ends failed, "crash" leaves no report, "hang-then-ok" hangs until it
// is stopped the first time and completes the second, "report-then-hang"
// writes a complete report and never returns (the app died under it).
function makeStore(root) {
  const runs = new Map();
  const calls = { launches: [], stops: [], interrupts: [], saves: [] };
  const pending = new Map();
  const seen = new Map();
  let nextId = 0;
  const store = {
    runs,
    calls,
    controls: null,
    async createWorkflowRun(input) {
      nextId += 1;
      const run = {
        id: `run-test${nextId}abcdef`,
        workspaceId: input.workspaceId,
        title: input.title,
        status: "running",
        workflow: input.workflow,
        steps: [],
        workerTasks: [],
        workerAttempts: [],
      };
      runs.set(run.id, run);
      return run;
    },
    async saveWorkflowRunInfo(runId, patch, options = {}) {
      const run = runs.get(runId);
      if (!run?.workflow) return run ?? null;
      run.workflow = { ...run.workflow, ...patch };
      if (options.status) run.status = options.status;
      calls.saves.push({ runId, patch, options });
      return run;
    },
    async launchWorkflowAgentTask(input) {
      calls.launches.push(input);
      const run = runs.get(input.runId);
      const n = calls.launches.length;
      const workerTaskId = `task-${n}`;
      const attemptId = `att-${n}`;
      const reportPath = path.join(root, `report-${n}.json`);
      run.workerTasks.push({ id: workerTaskId, title: input.label, workflowCall: input.call });
      const attempt = { id: attemptId, workerTaskId, status: "running", finalReportPath: reportPath };
      run.workerAttempts.push(attempt);
      input.onStarted?.({ workerTaskId, attemptId });
      const done = (status, report) => {
        attempt.status = status;
        if (report) fs.writeFileSync(reportPath, JSON.stringify(report));
        return {
          workerTaskId,
          attemptId,
          exitCode: status === "succeeded" ? 0 : 1,
          attemptStatus: status,
          report: report ?? null,
          usage: { in: 100, out: 10, usd: 0.01 },
        };
      };
      const prompt = input.prompt;
      if (prompt.startsWith("ok:")) {
        return done("succeeded", { status: "complete", summary: "done", result: JSON.parse(prompt.slice(3)) });
      }
      if (prompt === "fail") return done("succeeded", { status: "failed", summary: "could not do it" });
      if (prompt === "crash") return { ...done("failed", null), error: "worker exited 1" };
      if (prompt === "hang-then-ok") {
        const count = (seen.get(prompt) ?? 0) + 1;
        seen.set(prompt, count);
        if (count > 1) return done("succeeded", { status: "complete", summary: "done", result: { v: 2 } });
        await new Promise((resolve) => pending.set(attemptId, resolve));
        return done("cancelled", null);
      }
      if (prompt === "report-then-hang") {
        fs.writeFileSync(reportPath, JSON.stringify({ status: "complete", summary: "done", result: { v: 9 } }));
        return new Promise(() => undefined);
      }
      return done("succeeded", { status: "complete", summary: `summary of ${prompt}` });
    },
    async stopWorkerAttempt(runId, attemptId) {
      calls.stops.push(attemptId);
      pending.get(attemptId)?.();
      return runs.get(runId);
    },
    async interruptWorkflowAttempts(runId, reason) {
      calls.interrupts.push({ runId, reason });
      for (const attempt of runs.get(runId).workerAttempts) {
        if (attempt.status === "running") attempt.status = "cancelled";
      }
      return runs.get(runId);
    },
    async getRun(runId) {
      return runs.get(runId) ?? null;
    },
    async listRuns() {
      return [...runs.values()];
    },
    setWorkflowRunControls(controls) {
      store.controls = controls;
    },
    setWorkflowHeavyBinDir() {},
  };
  return store;
}

async function loadDriver(stubFile) {
  const stubs = {};
  for (const specifier of [
    "./run-store",
    "../storage",
    "./worker-model-availability",
    "../openrouter-config",
    "./pi-account-auth-store",
    "./pi-worker-providers",
    "./pi-model-catalog",
  ]) {
    stubs[specifier] = stubFile;
  }
  return bundleModule("workflow-driver.ts", { stubs, external: ["electron", "ssh2", "cpu-features", "node-pty"] });
}

async function main() {
  const base = tempDir();
  const stubFile = path.join(base, "stub.cjs");
  fs.writeFileSync(stubFile, "module.exports = {};\n");
  const sandboxMod = await bundleModule("workflow-sandbox.ts");
  sandboxMod.setWorkflowSandboxWorkerCode(await loadSandboxWorkerCode());

  const dirs = { builtinDir: path.join(ROOT, "resources", "orchestration", "workflows"), userDir: path.join(base, "user") };
  fs.mkdirSync(dirs.userDir, { recursive: true });
  const store = makeStore(base);
  const makeEnv = () => ({
    store: async () => store,
    runDir: (runId) => path.join(base, "runs", runId),
    registryDirs: () => dirs,
    worktreeRoot: (runId) => path.join(base, "wt", runId),
    models: async () => ({
      defaultModel: "test-model",
      defaultEffort: "medium",
      check: (model) => (model === "bad-model" ? "model bad-model has no connected account" : null),
      connected: (model) => model !== "bad-model",
    }),
    sampleMemory: () => null,
    startSandbox: sandboxMod.startWorkflowSandbox,
    progressIntervalMs: 20,
  });

  const driver = await loadDriver(stubFile);
  driver.configureWorkflowDriver(makeEnv());
  await driver.installWorkflowDriver();
  check("install registers the run controls", Boolean(store.controls?.stop && store.controls?.resume));

  // ── Failure isolation, phases and call markers ─────────────────────────
  fs.writeFileSync(
    path.join(dirs.userDir, "iso.js"),
    `export const meta = { name: "iso", description: "isolation", phases: [{ title: "A" }, { title: "B" }] };
const S = ${JSON.stringify(SCHEMA)};
const STRICT = ${JSON.stringify(STRICT)};
phase("A");
const r = await parallel([
  () => agent('ok:{"n":1}', { label: "good", schema: S }),
  () => agent("fail", { label: "bad" }),
  () => agent("crash", { label: "crash" }),
  () => agent('ok:{"n":"x"}', { label: "wrong type", schema: STRICT }),
  () => agent("plain", { label: "bad model", model: "bad-model" }),
  () => agent("plain", { label: "no schema" }),
]);
phase("B");
const e = await agent('ok:{"n":2}', { label: "envelope", schema: S, envelope: true });
return { r, e };
`,
  );
  const run = await driver.startWorkflowRun({ workspaceId: "ws", cwd: base, workflow: "iso" });
  const finished = await driver.waitForWorkflowRun(run.id, { timeoutMs: 20_000, pollMs: 25 });
  check("the run completes although agents failed", finished.workflow.state === "complete", finished.workflow);
  const r = finished.result?.r ?? [];
  check("a good agent returns its result", r[0]?.n === 1, r);
  check("a failed report resolves null", r[1] === null, r);
  check("a crashed attempt resolves null", r[2] === null, r);
  check("a result that breaks the schema resolves null", r[3] === null, r);
  check("a disconnected model resolves null through parallel", r[4] === null, r);
  check("without a schema the summary is the value", r[5] === "summary of plain", r);
  check("an envelope carries result and status", finished.result?.e?.result?.n === 2 && finished.result?.e?.status === "complete", finished.result?.e);
  check("the disconnected model never launched", store.calls.launches.length === 6, store.calls.launches.map((l) => l.label));
  const good = store.calls.launches.find((l) => l.label === "good");
  check("launches carry the phase and default model", good?.phase === "A" && good?.model === "test-model");
  check("the schema is written for the worker", Boolean(good?.call.schemaPath) && fs.existsSync(good.call.schemaPath));
  check("the call key reaches the task marker", /^k:[0-9a-f]{32}#0$/.test(good?.call.key ?? ""), good?.call);
  check("the envelope flag reaches the marker", store.calls.launches.find((l) => l.label === "envelope")?.call.envelope === true);
  const tree = store.runs.get(run.id).workflow.tree;
  check("the saved tree has both phases", tree?.phases.map((p) => p.title).join(",") === "A,B", tree?.phases);
  const crashRow = tree?.phases[0].calls.find((c) => c.label === "crash");
  check("a null row says why", crashRow?.status === "null" && /worker exited 1/.test(crashRow.note ?? ""), crashRow);
  const returnPath = path.join(base, "runs", run.id, "workflow", "return.json");
  check("the return value is on disk", fs.existsSync(returnPath));
  check("the run status is complete", store.runs.get(run.id).status === "complete");

  let argsError = "";
  try {
    await driver.startWorkflowRun({ workspaceId: "ws", cwd: base, workflow: "understand", args: { topic: 3 } });
  } catch (err) {
    argsError = err.message;
  }
  check("args are checked against meta.args", /args/.test(argsError) && /topic/.test(argsError), argsError);

  // ── Stop and resume ────────────────────────────────────────────────────
  const launchesBefore = store.calls.launches.length;
  const sr = await driver.startWorkflowRun({
    workspaceId: "ws",
    cwd: base,
    source: `export const meta = { name: "sr", description: "stop and resume" };
const S = ${JSON.stringify(SCHEMA)};
const a = await agent('ok:{"v":1}', { label: "first", schema: S });
const b = await agent("hang-then-ok", { label: "second", schema: S });
return [a, b];
`,
  });
  check("the second agent starts", await until(() => store.calls.launches.length === launchesBefore + 2));
  await store.controls.stop(sr.id, "Stopped by the user");
  check("Stop parks the run", store.runs.get(sr.id).status === "paused" && store.runs.get(sr.id).workflow.state === "paused");
  check("Stop stops the live attempt", store.calls.stops.includes(`att-${launchesBefore + 2}`), store.calls.stops);
  await store.controls.resume(sr.id);
  const resumed = await driver.waitForWorkflowRun(sr.id, { timeoutMs: 20_000, pollMs: 25 });
  check("Resume completes the run", resumed.workflow.state === "complete", resumed.workflow);
  check("Resume returns both results", JSON.stringify(resumed.result) === JSON.stringify([{ v: 1 }, { v: 2 }]), resumed.result);
  check("the finished agent did not run again", store.calls.launches.length === launchesBefore + 3, store.calls.launches.length);
  const firstRow = resumed.workflow.tree.phases[0].calls.find((c) => c.label === "first");
  check("the replayed call shows as cached", firstRow?.cached === true, firstRow);
  check("a second journal generation was written", fs.existsSync(path.join(base, "runs", sr.id, "workflow", "journal-1.jsonl")));
  check(
    "the run's spend includes the agent Stop cut off",
    Math.abs(resumed.workflow.spent.usd - 0.03) < 1e-9 && resumed.workflow.spent.inputTokens === 300,
    resumed.workflow.spent,
  );

  // ── Approved source ────────────────────────────────────────────────────
  {
    const file = path.join(dirs.userDir, "pinned.js");
    const v1 = `export const meta = { name: "pinned", description: "v1" };\nreturn await agent("plain");\n`;
    fs.writeFileSync(file, v1);
    const checkedV1 = await driver.checkWorkflow({ workflow: "pinned", cwd: base });
    check("the check reports the source hash", /^[0-9a-f]{64}$/.test(checkedV1.sourceHash ?? ""), checkedV1.sourceHash);
    fs.writeFileSync(file, v1.replace("v1", "v2"));
    let startError = "";
    try {
      await driver.startWorkflowRun({ workspaceId: "ws", cwd: base, workflow: "pinned", expectedSourceHash: checkedV1.sourceHash });
    } catch (err) {
      startError = err.message;
    }
    check("a workflow edited after its check does not start", /changed after it was checked/.test(startError), startError);

    fs.writeFileSync(file, v1);
    const pinned = await driver.startWorkflowRun({ workspaceId: "ws", cwd: base, workflow: "pinned", expectedSourceHash: checkedV1.sourceHash });
    await driver.waitForWorkflowRun(pinned.id, { timeoutMs: 20_000, pollMs: 25 });
    store.runs.get(pinned.id).workflow.state = "failed";
    check("an unedited saved workflow is not a change", (await driver.latestWorkflowScript(pinned.id))?.changed === false);
    fs.writeFileSync(file, v1.replace(`"plain"`, `"other"`));
    const latest = await driver.latestWorkflowScript(pinned.id);
    check("an edited saved workflow is reported as changed", latest?.changed === true, latest);
    fs.writeFileSync(file, v1.replace(`"plain"`, `"third"`));
    let resumeError = "";
    try {
      await driver.resumeWorkflowRun(pinned.id, { useLatestScript: true, expectedSourceHash: latest.sourceHash });
    } catch (err) {
      resumeError = err.message;
    }
    check("Resume refuses a script edited after it was approved", /changed after it was approved/.test(resumeError), resumeError);
  }

  // ── Restart recovery ───────────────────────────────────────────────────
  const beforeRestart = store.calls.launches.length;
  const rs = await driver.startWorkflowRun({
    workspaceId: "ws",
    cwd: base,
    source: `export const meta = { name: "rs", description: "restart" };
const S = ${JSON.stringify(SCHEMA)};
const a = await agent('ok:{"v":1}', { label: "first", schema: S });
const b = await agent("report-then-hang", { label: "second", schema: S });
return [a, b];
`,
  });
  check("the interrupted agent starts", await until(() => store.calls.launches.length === beforeRestart + 2));
  await sleep(200);

  // A fresh copy of the driver is the next app session: same files, same store.
  const next = await loadDriver(stubFile);
  next.configureWorkflowDriver(makeEnv());
  await next.installWorkflowDriver();
  const parked = await next.recoverWorkflowRuns();
  check("recovery parks the running run", parked.includes(rs.id) && store.runs.get(rs.id).status === "paused", parked);
  check("recovery marks attempts interrupted by a restart", store.calls.interrupts.some((i) => i.runId === rs.id && i.reason === "app_restart"));
  check("recovery starts nothing", store.calls.launches.length === beforeRestart + 2);
  const journal = fs.readFileSync(path.join(base, "runs", rs.id, "workflow", "journal-0.jsonl"), "utf8");
  check("the report on disk is journaled", /"note":"recovered after an app restart"/.test(journal));
  check("the parked run says how to continue", /Resume to continue/.test(store.runs.get(rs.id).workflow.error ?? ""));
  await store.controls.resume(rs.id);
  const recovered = await next.waitForWorkflowRun(rs.id, { timeoutMs: 20_000, pollMs: 25 });
  check("Resume after a restart completes", recovered.workflow.state === "complete", recovered.workflow);
  check("the salvaged result is delivered", JSON.stringify(recovered.result) === JSON.stringify([{ v: 1 }, { v: 9 }]), recovered.result);
  check("no agent ran twice", store.calls.launches.length === beforeRestart + 2, store.calls.launches.length);

  // ── Check and estimate ─────────────────────────────────────────────────
  const checked = await next.checkWorkflow({ workflow: "review-changes", cwd: base });
  check("a shipped workflow checks clean", checked.ok, checked.errors);
  check("the estimate counts the fan-out", checked.estimate?.agents > 5 && !checked.estimate?.unbounded, checked.estimate);
  check(
    "the estimate lists the phases",
    checked.estimate?.phases.map((p) => p.title).join(",") === "Find,Verify",
    checked.estimate?.phases,
  );
  const broken = await next.checkWorkflow({ source: "return 1;" });
  check("a script without meta fails the check", !broken.ok && /export const meta/.test(broken.errors[0]?.message ?? ""), broken);
  const thrower = await next.checkWorkflow({
    source: `export const meta = { name: "t", description: "t" };\nconst x = null;\nx.y = 1;\n`,
  });
  check("a script that throws fails the check", !thrower.ok, thrower);
}

main()
  .catch((err) => {
    check("suite crashed", false, err && err.stack ? err.stack : String(err));
  })
  .finally(finish);
