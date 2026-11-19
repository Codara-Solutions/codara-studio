// test-runner: heavy (bundles the whole run-store)
// A Claude Code worker whose processes could not all be confirmed gone holds
// its run: the REAL run-store.ts runs a `claude-code/` worker against a fake
// `claude`, through every way an attempt can end with its teardown
// unconfirmed (a report written, a failed turn, the user's Stop, a sign-in
// probe that left something behind), and after each one checks the same
// invariant: the attempt keeps no report, and nothing later runs in that run
// (no retry, no new launch, no review), all through one gate
// (unconfirmedWorkerCleanup). Stubs as in scripts/test-worker-feed-session.cjs.
//
//   node scripts/test-claude-code-cleanup-gate.cjs

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");
const { completeStubExports } = require("./run-store-stub-exports.cjs");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const WORKER_TS = path.join(ROOT, "src", "main", "orchestration", "claude-code-worker.ts");
const CACHE = path.join(ROOT, "node_modules", ".cache", `claude-code-cleanup-gate-${process.pid}`);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-cleanup-gate-"));
const NOW = "2026-11-19T10:00:00.000Z";

if (process.platform !== "linux") {
  // Claude Code workers run on Linux only (claudeCodeWorkerSupported).
  console.log(`SKIP every check (Linux only: Claude Code workers run on Linux only; this is ${process.platform})`);
  console.log("\nClaude Code cleanup gate: 1 suite SKIPPED (not Linux)");
  process.exit(0);
}

// The fake CLI. Its environment is an allowlist, so it is steered by a file
// beside it: `auth status` answers signed in; a turn says it started, waits
// for the harness, then writes a complete report and exits 0, or exits 1.
const FAKE = path.join(HOME, "claude");
const CONTROL = path.join(HOME, "control.json");
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require("node:fs");
const control = JSON.parse(fs.readFileSync(${JSON.stringify(CONTROL)}, "utf8"));
const argv = process.argv.slice(2);
if (argv[0] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
process.stdin.resume();
fs.writeFileSync(control.started, "1");
const wait = setInterval(() => {
  if (!fs.existsSync(control.go)) return;
  clearInterval(wait);
  if (control.mode === "report") {
    fs.writeFileSync(control.report, JSON.stringify({ status: "complete", summary: "Done.", files_changed: [], commands_run: [], tests: [], proof: [], risks: [], followups: [], handoff: [] }));
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: {} }) + "\\n");
    process.exit(0);
  }
  if (control.mode === "fail") process.exit(1);
}, 20);
`, { mode: 0o755 });

const ELECTRON_STUB = `const noop = () => {};
export const app = { getPath: () => "/tmp", getAppPath: () => process.cwd(), getVersion: () => "0.0.0", getName: () => "codara", isPackaged: false, on: noop, whenReady: () => Promise.resolve(), setName: noop };
export class BrowserWindow { static getAllWindows() { return []; } }
export class Notification { static isSupported() { return false; } show() {} on() {} }
export const ipcMain = { on: noop, handle: noop, removeHandler: noop };
export const shell = { openPath: noop, openExternal: noop, showItemInFolder: noop };
export const dialog = { showOpenDialog: noop, showMessageBox: noop };
export const clipboard = { readText: () => "", writeText: noop, readImage: () => null };
export const nativeImage = { createFromPath: () => null, createFromBuffer: () => null };
export const nativeTheme = { on: noop };
export const safeStorage = { isEncryptionAvailable: () => false };
export const webContents = { getAllWebContents: () => [] };
export default { app };`;

const STUBS = {
  electron: ELECTRON_STUB,
  "node-pty": `export function spawn() { throw new Error("stubbed"); } export default { spawn };`,
  "./backend-registry": `const backend = (kind) => ({ kind, displayName: "stub", async requestManagerDecision() {
    (globalThis.__gateReviews ??= []).push(kind);
    return { decision: { status: "ask_user", summary: "stub", question: "Stub?", questionCategory: "irreducible_product_scope", questionReason: "stub", steps: [], tasks: [] }, durationMs: 1, model: "stub" };
  }, async disposeChat() {}, interruptChat() {} });
export function getBackend(kind) { return backend(kind); }
export function listBackends() { return []; }
export async function disposeManagerSessions() {}`,
  "./pi-runtime-electron": `export async function resolveCodaraPiExecutionAccount() { return { accountProfileId: "p", provider: "anthropic", configDir: "/tmp/cora-stub-pi" }; }
export function codaraPiPaths() { return { home: "/tmp/cora-stub-pi" }; }
export async function cleanupPiMcpBridgeConfig() {}`,
  "../pty-manager": `const noop = () => {};
export function exists() { return false; }
export async function spawn() {}
export function resize() {}
export async function waitForResize() {}
export async function waitForSpawn() { return false; }
export function publishOutput() {}
export function killImmediate() {}
export function dispose() {}
export function onExit() { return noop; }
export function readTail() { return ""; }
export function tap() { return noop; }
export function write() {}`,
  // Claude Code carries the worker's Claude model (route claude-code/).
  "./worker-model-availability": `export async function coraWorkerModelAvailability() { return { connected: ["claude-opus-5"], disconnected: [] }; }
export async function routeCoraModel(model) { return model.startsWith("claude-code/") ? model : "claude-code/" + model; }
export function workerPlanningModels(models) { return models; }
export function runHasManagedWorkers(run) { return run.executionMode !== "direct"; }`,
  "../binary-resolver": `export async function resolveBinary() { return ${JSON.stringify(FAKE)}; }`,
  "../agent-launch-integration": `export async function claudeWorkerLaunchSnapshot() { return { args: [], dispose: async () => {} }; }`,
  "../providers": `export function getProvider() { return { buildArgs: () => [] }; }`,
  "./native-claude-profile-runtime": `export function acquireNativeClaudeProfileLease() { (globalThis.__gateLeases ??= []).push("acquire"); return () => globalThis.__gateLeases.push("release"); }`,
};

const stubPlugin = {
  name: "claude-code-cleanup-gate-stubs",
  setup(build) {
    build.onResolve({ filter: /^(electron|node-pty|\.\/backend-registry|\.\/pi-runtime-electron|\.\.\/pty-manager|\.\/worker-model-availability|\.\.\/binary-resolver|\.\.\/agent-launch-integration|\.\.\/providers|\.\/native-claude-profile-runtime)$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: completeStubExports(args.path, STUBS[args.path]), loader: "js" }));
    // The real worker module, with its teardown seam reachable from here.
    build.onLoad({ filter: /claude-code-worker\.ts$/ }, () => ({
      contents: `${fs.readFileSync(WORKER_TS, "utf8")}\n;(globalThis as any).__claudeCodeTeardown = setClaudeCodeTeardownForTests;\n`,
      loader: "ts",
      resolveDir: path.dirname(WORKER_TS),
    }));
  },
};

let failures = 0;
function check(name, condition, detail) {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition || detail === undefined ? "" : ` - ${detail}`}`);
}
let completed = false;
process.on("exit", (code) => {
  if (!completed && code === 0) {
    console.log("FAIL the harness exited before finishing its checks");
    process.exitCode = 1;
  }
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(file, ms = 20_000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`${path.basename(file)} never appeared`);
    await sleep(20);
  }
}

function writeRun(id) {
  const stepId = `step-${id}`;
  const taskId = `task-${id}`;
  const attemptId = `attempt-${id}`;
  const nextAttemptId = `attempt-${id}-next`;
  const dir = path.join(HOME, "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  const task = (tid, title) => ({
    id: tid, runId: id, stepId, title, description: title, status: "queued",
    runtimePreference: "claude", allowedPaths: [], forbiddenPaths: [], expectedOutputs: [], verificationCommands: [],
    canRunParallel: true, conflictsWith: [], taskClass: "implementation", createdBy: "spark", createdAt: NOW, updatedAt: NOW,
  });
  const run = {
    id, title: "cleanup gate", status: "running", executionMode: "managed", chatBackend: "pi", chatMode: "auto",
    workspaceId: "ws-cleanup-gate", cwd: HOME, artifactDir: path.join(dir, "artifacts"), createdAt: NOW, updatedAt: NOW,
    conversationEpoch: 1, autopilot: { status: "running", lastAction: "started", updatedAt: NOW },
    plans: [], humanMessages: [], sparkCalls: [],
    steps: [{
      id: stepId, runId: id, index: 1, title: "Fix", goal: "Fix it", kind: "worker_batch", status: "running",
      plannedAgents: [], acceptanceCriteria: [], verificationCommands: [], workerTaskIds: [taskId, `${taskId}-next`], createdAt: NOW, updatedAt: NOW,
    }],
    workerTasks: [task(taskId, "fix it"), task(`${taskId}-next`, "the next worker")],
    workerAttempts: [
      { id: attemptId, runId: id, workerTaskId: taskId, attemptNumber: 1, runtime: "claude", cwd: HOME, status: "prompt_ready", createdAt: NOW },
      { id: nextAttemptId, runId: id, workerTaskId: `${taskId}-next`, attemptNumber: 1, runtime: "claude", cwd: HOME, status: "prompt_ready", createdAt: NOW },
    ],
  };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2));
  for (const [tid, aid] of [[taskId, attemptId], [`${taskId}-next`, nextAttemptId]]) {
    const attemptDir = path.join(dir, "steps", stepId, "workers", tid, "attempts", aid);
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.writeFileSync(path.join(attemptDir, "prompt.md"), "Do it.\n");
  }
  const attemptDir = path.join(dir, "steps", stepId, "workers", taskId, "attempts", attemptId);
  return { id, taskId, attemptId, nextAttemptId, report: path.join(attemptDir, "final-report.json") };
}

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(CACHE, { recursive: true });
  const outfile = path.join(CACHE, "run-store.cjs");
  await esbuild.build({
    entryPoints: [RUN_STORE_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    plugins: [stubPlugin],
    packages: "external",
  });
  const runStore = require(outfile);
  // Listings work until a scenario breaks them: what was started can then
  // no longer be confirmed gone. Short timing keeps each teardown quick.
  let listingFails = false;
  globalThis.__claudeCodeTeardown({ graceMs: 100, killDeadlineMs: 400, listing: (real) => (listingFails ? null : real()) });

  const scenarios = [
    { name: "a turn that wrote a complete report", mode: "report" },
    { name: "a turn that failed", mode: "fail" },
    { name: "the user's Stop during a turn", mode: "stop" },
    { name: "a sign-in probe that left something it started", mode: "probe" },
  ];
  for (const scenario of scenarios) {
    const fixture = writeRun(`run-gate-${scenario.mode}`);
    const started = path.join(HOME, `${scenario.mode}.started`);
    const go = path.join(HOME, `${scenario.mode}.go`);
    fs.writeFileSync(CONTROL, JSON.stringify({ mode: scenario.mode, started, go, report: fixture.report }));
    listingFails = scenario.mode === "probe";
    globalThis.__gateReviews = [];
    const launch = runStore.launchWorkerAttempt({ runId: fixture.id, attemptId: fixture.attemptId }).catch((error) => error);
    if (scenario.mode !== "probe") {
      await waitFor(started);
      listingFails = true;
      if (scenario.mode === "stop") await runStore.stopWorkerAttempt(fixture.id, fixture.attemptId);
      else fs.writeFileSync(go, "1");
    }
    const launched = await launch;
    listingFails = false;
    const run = await runStore.getRun(fixture.id);
    const attempt = run.workerAttempts.find((item) => item.id === fixture.attemptId);
    const task = run.workerTasks.find((item) => item.id === fixture.taskId);
    const label = scenario.name;
    check(`${label}: the launch settles`, !(launched instanceof Error), launched?.message);
    check(`${label}: the attempt is marked as not confirmed clean`, attempt?.cleanupUnconfirmed === true, JSON.stringify({ status: attempt?.status, error: attempt?.error }));
    check(`${label}: the attempt keeps no report`, attempt?.finalReportPath === undefined, attempt?.finalReportPath);
    check(`${label}: it is not a success, and its task is not up for review`, attempt?.status !== "succeeded" && !["needs_review", "accepted"].includes(task?.status), `${attempt?.status} / ${task?.status}`);
    check(`${label}: the gate holds the run`, runStore.unconfirmedWorkerCleanup(run)?.id === fixture.attemptId);
    const retry = await runStore.retryWorkerTask(fixture.id, fixture.taskId).then(() => null, (error) => error.message);
    check(`${label}: no retry`, /could not be confirmed gone/.test(retry ?? ""), retry);
    const next = await runStore.launchWorkerAttempt({ runId: fixture.id, attemptId: fixture.nextAttemptId }).then(() => null, (error) => error.message);
    check(`${label}: no new worker in the run`, /could not be confirmed gone/.test(next ?? ""), next);
    const nextAttempt = (await runStore.getRun(fixture.id)).workerAttempts.find((item) => item.id === fixture.nextAttemptId);
    check(`${label}: the refused worker never started`, nextAttempt?.status === "prompt_ready" && !nextAttempt?.startedAt, nextAttempt?.status);
    check(`${label}: no review asked of the manager`, globalThis.__gateReviews.length === 0, JSON.stringify(globalThis.__gateReviews));
    const leases = globalThis.__gateLeases ?? [];
    check(`${label}: the account hold is kept`, scenario.mode === "probe" || leases.at(-1) === "acquire", JSON.stringify(leases));
    // What a process left behind writes later is not this attempt's report.
    fs.writeFileSync(fixture.report, JSON.stringify({ status: "complete", summary: "late" }));
    const later = await runStore.getRun(fixture.id);
    check(`${label}: a report written afterwards is still not the attempt's`, later.workerAttempts.find((item) => item.id === fixture.attemptId)?.finalReportPath === undefined);
  }

  // Review and the worker cycle reach the same gate before anything else.
  const source = fs.readFileSync(RUN_STORE_TS, "utf8");
  const body = (name) => {
    const start = source.indexOf(`async function ${name}(`);
    return source.slice(start, source.indexOf("\nasync function ", start + 10));
  };
  check(
    "manager review stops at the gate",
    /if \(run\.status === "paused" \|\| run\.status === "blocked" \|\| run\.status === "cancelled"\) return;\s*if \(unconfirmedWorkerCleanup\(run\)\) return;/.test(body("runAutopilotManagerReview")),
  );
  check(
    "the worker cycle stops at the gate before any review or continuation",
    /if \(unconfirmedWorkerCleanup\(latest\)\) \{\s*await stopRunAfterUnconfirmedCleanup\(runId, attemptId\);\s*return;\s*\}\s*const hasOtherActiveCycles/.test(body("runAutopilotWorkerCycle")),
  );
  const socket = fs.readFileSync(path.join(ROOT, "src", "main", "agent-socket.ts"), "utf8");
  const spawnStart = socket.indexOf("async function handleOrchestratorSpawnWorkers(");
  check(
    "the manager's spawn stops at the gate",
    /if \(runStore\.unconfirmedWorkerCleanup\(run\)\) \{\s*return errorResponse\(id, ERR_FORBIDDEN, UNCONFIRMED_CLEANUP_ERROR\);/.test(socket.slice(spawnStart, spawnStart + 1_500)),
  );

  completed = true;
  globalThis.__claudeCodeTeardown(null);
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nClaude Code cleanup gate: all checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
