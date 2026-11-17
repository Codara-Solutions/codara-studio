// What each live Cora worker is doing now, for the chat's agents rail: the
// writer's activity (src/main/orchestration/worker-feed.ts), only changes
// pushed, the renderer's merge (lib/useWorkerActivity.ts) and the rail's model
// (components/chat/agents-rail.ts): marks, "+N", groups and labels.
//
//   node scripts/test-worker-activity.cjs

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

const electronStub = {
  name: "electron-stub",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const BrowserWindow = { getAllWindows: () => [] };",
      loader: "js",
    }));
  },
};
// React is only imported for the hook; the merge under test is pure.
const reactStub = {
  name: "react-stub",
  setup(build) {
    build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "stub-react" }));
    build.onLoad({ filter: /.*/, namespace: "stub-react" }, () => ({
      contents: "export const useEffect = () => undefined; export const useState = (v) => [v, () => undefined];",
      loader: "js",
    }));
  },
};
const sharedAlias = {
  name: "shared-alias",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

let failures = 0;
function check(name, condition, detail) {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition || detail === undefined ? "" : ` - ${detail}`}`);
}

async function load(dir, entry, name) {
  const outfile = path.join(dir, name);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [electronStub, reactStub, sharedAlias],
  });
  return require(outfile);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-worker-activity-"));
  try {
    const shared = await load(dir, path.join(ROOT, "src", "shared", "worker-feed.ts"), "shared.cjs");
    const writerModule = await load(dir, path.join(ROOT, "src", "main", "orchestration", "worker-feed.ts"), "main.cjs");
    const hook = await load(dir, path.join(ROOT, "src", "renderer", "src", "lib", "useWorkerActivity.ts"), "hook.cjs");
    const rail = await load(dir, path.join(ROOT, "src", "renderer", "src", "components", "chat", "agents-rail.ts"), "rail.cjs");
    targets(shared);
    await writer(writerModule, dir);
    merge(hook);
    model(rail);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.log(`worker activity: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("worker activity: all checks passed");
}

function targets(shared) {
  const target = shared.workerActivityTarget;
  check("a file is named by its base name", target({ file_path: "/repo/src/rail/CleanupToast.tsx", content: "x".repeat(9000) }) === "CleanupToast.tsx");
  check("a command is kept, flattened", target({ command: "npm test \n  -- merged-fold" }) === "npm test -- merged-fold");
  check("a search keeps its pattern", target({ pattern: "foldCount" }) === "foldCount");
  const long = target({ command: "x".repeat(400) });
  check("a long target is clipped to one row", long.length === 120 && long.endsWith("…"), String(long.length));
  check("no known field, no target", target({ content: "secret-ish body" }) === undefined && target("text") === undefined && target(null) === undefined);
}

async function writer(mod, dir) {
  const pushed = [];
  let clock = Date.parse("2026-11-17T12:00:00.000Z");
  const open = (attemptId) =>
    mod.createWorkerFeedWriter({
      runId: "run-1",
      attemptId,
      path: path.join(dir, `${attemptId}.jsonl`),
      publish: () => undefined,
      publishActivity: (activity) => pushed.push(activity),
      partialIntervalMs: 0,
      now: () => new Date((clock += 1000)),
    });
  const feed = open("a1");
  check("a new session starts thinking", pushed.at(-1)?.step?.kind === "thinking");
  feed.tool("call-1", "Bash", { command: "npm test", env: { TOKEN: "never sent" } });
  const tool = pushed.at(-1);
  check(
    "a tool call pushes its name and target only",
    tool.step.kind === "tool" && tool.step.tool === "Bash" && tool.step.target === "npm test" && !JSON.stringify(tool).includes("never sent"),
    JSON.stringify(tool),
  );
  const count = pushed.length;
  feed.result("call-1", "ok", false);
  check("a result sends it back to thinking", pushed.at(-1).step.kind === "thinking" && pushed.length === count + 1);
  feed.textDelta("Look");
  feed.textDelta("ing at it");
  feed.textDelta(" now.");
  check("a reply is one push, not one per delta", pushed.at(-1).step.kind === "reply" && pushed.length === count + 2);
  feed.endMessage();
  check("an ended reply goes back to thinking", pushed.at(-1).step.kind === "thinking");
  feed.steer("Also cover the empty list.", "user");
  check("a message to the worker is not a step", pushed.at(-1).step.kind === "thinking" && pushed.length === count + 3);
  check("seq only rises", pushed.every((entry, index) => index === 0 || entry.seq > pushed[index - 1].seq));

  const other = open("a2");
  other.tool("c", "read", { path: "src/a.ts" });
  const live = mod.readWorkerActivity("run-1");
  check(
    "a read gives each live worker's current step",
    live.length === 2 && live.find((entry) => entry.attemptId === "a2").step.target === "a.ts",
    JSON.stringify(live.map((entry) => entry.attemptId)),
  );
  check("another run reads none of them", mod.readWorkerActivity("run-2").length === 0);

  await feed.close();
  check("closing pushes the end", pushed.at(-1).attemptId === "a1" && pushed.at(-1).step === null);
  check("an ended worker leaves the read", mod.readWorkerActivity("run-1").map((entry) => entry.attemptId).join() === "a2");

  // A relaunch of the same attempt: the old session ending never drops the new one.
  const relaunched = open("a2");
  relaunched.tool("c2", "edit", { path: "src/b.ts" });
  await other.close();
  const after = mod.readWorkerActivity("run-1");
  check("a relaunch keeps its entry when the old session closes", after.length === 1 && after[0].step.target === "b.ts", JSON.stringify(after));
  await relaunched.close();
  check("nothing live, nothing read", mod.readWorkerActivity("run-1").length === 0);
}

function merge(hook) {
  const entry = (attemptId, seq, step) => ({ runId: "run-1", attemptId, seq, at: "2026-11-17T12:00:00.000Z", step });
  const empty = new Map();
  const first = hook.mergeWorkerActivity(empty, [entry("a1", 3, { kind: "thinking" })]);
  check("a push lands", first.get("a1").seq === 3);
  const stale = hook.mergeWorkerActivity(first, [entry("a1", 2, { kind: "tool", tool: "Bash" })]);
  check("an older copy never replaces a newer one", stale === first);
  const ended = hook.mergeWorkerActivity(first, [entry("a1", 4, null)]);
  const late = hook.mergeWorkerActivity(ended, [entry("a1", 3, { kind: "thinking" })]);
  check("a read landing after the end never brings the worker back", late.get("a1").step === null);
  const both = hook.mergeWorkerActivity(empty, [entry("a1", 5, { kind: "reply" }), entry("a2", 6, { kind: "thinking" })]);
  check("a snapshot merges every attempt", both.size === 2);
}

function model(rail) {
  const at = (seconds) => new Date(Date.parse("2026-11-17T12:00:00.000Z") + seconds * 1000).toISOString();
  const now = Date.parse(at(200));
  const tasks = [];
  const attempts = [];
  const workers = [];
  const add = (id, stepId, status, extra = {}) => {
    tasks.push({ id, stepId, title: id, description: "" });
    attempts.push({ id: `att-${id}`, workerTaskId: id, status, runtime: "pi", model: "Opus 5.5", startedAt: at(10), ...extra });
    workers.push({ id, taskId: id, title: id, runtime: "pi", status: "running", attemptId: `att-${id}` });
  };
  add("read", "s1", "succeeded", { finishedAt: at(100) });
  add("toast", "s2", "running");
  add("light", "s2", "failed", { error: "\n typecheck, 2 errors\nmore detail", finishedAt: at(140) });
  const run = {
    steps: [
      { id: "s1", index: 1, title: "Read the code" },
      { id: "s2", index: 2, title: "Fix merged fold" },
    ],
    workerTasks: tasks,
    workerAttempts: attempts,
  };
  const activity = new Map([
    ["att-toast", { runId: "r", attemptId: "att-toast", seq: 1, at: at(190), step: { kind: "tool", tool: "Bash", target: "npm test -- merged-fold" } }],
  ]);
  const items = rail.railWorkers(run, workers, activity, now);
  const byId = Object.fromEntries(items.map((item) => [item.worker.id, item]));
  check("a finished worker's time is how long it ran", byId.read.state === "done" && byId.read.elapsed === "1m 30s", byId.read.elapsed);
  check("a running worker shows what it is doing", byId.toast.activity === "Run command · npm test -- merged-fold", byId.toast.activity);
  check("a failed worker shows its reason's first line", byId.light.reason === "typecheck, 2 errors", byId.light.reason);
  check("a running worker's model comes from its attempt", byId.toast.model === "Opus 5.5");
  check(
    "a mark reads name-free: model, state, time and step",
    rail.railWorkerLine(byId.toast) === "Opus 5.5 · running · 3m 10s · Run command · npm test -- merged-fold",
    rail.railWorkerLine(byId.toast),
  );
  check("the summary counts each state", rail.railSummary(items) === "1 running · 1 failed · 1 done", rail.railSummary(items));
  const groups = rail.railGroups(run, items);
  check(
    "the list groups workers under their step",
    groups.length === 2 && groups[1].label === "Step 2 · Fix merged fold" && groups[1].workers.length === 2,
    JSON.stringify(groups.map((group) => group.label)),
  );
  check("a reply and thinking have their own words", rail.workerActivityLabel({ kind: "reply" }) === "Writing a reply" && rail.workerActivityLabel({ kind: "thinking" }) === "Thinking");
  check("an ended worker has no step", rail.workerActivityLabel(null) === null);

  // Eight fit; more put the running ones first and keep the one you are in.
  const many = Array.from({ length: 13 }, (_, index) => ({
    worker: { id: `w${index}` },
    state: index % 3 === 0 ? "running" : "done",
  }));
  check("eight or fewer: every mark, in step order", rail.railMarks(many.slice(0, 8), null).more === 0);
  const folded = rail.railMarks(many, null);
  check("more than eight: eight marks and +N", folded.marks.length === 8 && folded.more === 5);
  check("running ones come first", folded.marks.slice(0, 5).every((item) => item.state === "running"));
  const inside = rail.railMarks(many, "w11");
  check("the worker you are in keeps its mark", inside.marks.some((item) => item.worker.id === "w11") && inside.more === 5);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
