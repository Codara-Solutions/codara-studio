// Going inside a Cora worker (src/renderer/src/components/chat/worker-view.ts):
// a worker's state, its feed as chat rows, what folds once it finished, and
// how the bar's arrows step through the chat's workers.
//
//   node scripts/test-worker-view.cjs

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

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

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cora-worker-view-"));
  try {
    const outfile = path.join(dir, "worker-view.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "renderer", "src", "components", "chat", "worker-view.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
      plugins: [sharedAlias],
    });
    run(require(outfile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.log(`worker view: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("worker view: all checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function run(view) {
  const at = "2026-11-17T12:00:00.000Z";
  const attempt = (status, runtime = "claude", extra = {}) => ({ id: "a1", status, runtime, ...extra });

  // State and who can be messaged.
  check("no attempt reads as queued", view.workerViewState(null) === "queued");
  for (const status of ["preparing", "prompt_ready", "launching", "running", "finishing"]) {
    check(`${status} reads as running`, view.workerViewState(attempt(status)) === "running");
  }
  check("succeeded reads as done", view.workerViewState(attempt("succeeded")) === "done");
  check("cancelled reads as stopped", view.workerViewState(attempt("cancelled")) === "stopped");
  check(
    "a failed attempt with a retry owed reads as queued, as its row does",
    view.workerViewState(attempt("failed"), { status: "retry_queued" }) === "queued" &&
      view.workerViewState(attempt("cancelled"), { status: "running", pending: { number: 2 } }) === "queued",
  );
  check(
    "a retry already running reads as running",
    view.workerViewState(attempt("running"), { status: "running", pending: { number: 2 } }) === "running",
  );
  check("timed out reads as failed", view.workerViewState(attempt("timed_out")) === "failed");
  check("a running agent worker can be messaged", view.canMessageWorker(attempt("running", "codex")));
  check("a launching worker cannot yet", !view.canMessageWorker(attempt("launching")));
  check("a shell worker takes keystrokes, not chat messages", !view.canMessageWorker(attempt("running", "shell")));
  check("a finished worker cannot be messaged", !view.canMessageWorker(attempt("succeeded")));

  // Elapsed time.
  const started = Date.parse(at);
  check("seconds", view.workerElapsed(attempt("running", "claude", { startedAt: at }), started + 12_400) === "12s");
  check(
    "minutes from start to finish",
    view.workerElapsed(attempt("succeeded", "claude", { startedAt: at, finishedAt: "2026-11-17T12:03:12.000Z" }), started + 10 ** 9) ===
      "3m 12s",
  );
  check("hours", view.workerElapsed(attempt("running", "claude", { startedAt: at }), started + 3_840_000) === "1h 4m");
  check("no start, no time", view.workerElapsed(attempt("prompt_ready"), started) === null);

  // Arrows step through workers that can be opened, in step-card order.
  const workers = [
    { id: "w1", title: "One", attemptId: "a1" },
    { id: "w2", title: "Two" },
    { id: "w3", title: "Three", attemptId: "a3" },
  ];
  const openable = view.openableWorkers(workers);
  check("a worker without an attempt cannot be opened", openable.map((w) => w.id).join() === "w1,w3");
  check("next skips nothing it should not", view.neighbourWorker(openable, "w1", 1)?.id === "w3");
  check("no previous before the first", view.neighbourWorker(openable, "w1", -1) === null);
  check("no next after the last", view.neighbourWorker(openable, "w3", 1) === null);
  check("an unknown worker has no neighbours", view.neighbourWorker(openable, "nope", 1) === null);

  // Feed entries become chat rows: text and tool work group into turns,
  // messages and notes break them.
  const entries = [
    { kind: "tool", id: "tool:1", at, toolUseId: "1", toolName: "read", input: { path: "README.md" }, output: "# Project" },
    { kind: "text", id: "text:2", at, text: "Reading done." },
    { kind: "steer", id: "steer:3", at, text: "Also check the tests.", from: "user" },
    { kind: "tool", id: "tool:4", at, toolUseId: "4", toolName: "bash", input: { command: "npm test" }, output: "1 failing", isError: true },
    { kind: "note", id: "note:5", at, text: "The provider failed: overloaded", tone: "error" },
    { kind: "note", id: "note:6", at, text: "Retrying in 4s.", tone: "info" },
    { kind: "tool", id: "tool:7", at, toolUseId: "7", toolName: "bash", input: { command: "npm test" }, output: "12 passing" },
    { kind: "text", id: "text:8", at, text: "Fixed and passing." },
  ];
  const rows = view.workerRows(entries);
  check(
    "rows group in order",
    rows.map((row) => row.kind).join() === "turn,message,turn,note,turn",
    rows.map((row) => row.kind).join(),
  );
  check("a turn keeps its tool call and reply as the main chat's blocks", rows[0].blocks.map((b) => b.kind).join() === "tool,text");
  check("a tool block carries its result", rows[0].blocks[0].output === "# Project" && rows[0].blocks[0].toolName === "read");
  check("a message keeps who sent it", rows[1].from === "user" && rows[1].text === "Also check the tests.");
  check("a failed call is marked", rows[2].blocks[0].isError === true);
  check("an error note draws as an error in its turn", rows[2].blocks[1].kind === "error");
  check("an info note is its own row", rows[3].kind === "note" && rows[3].text === "Retrying in 4s.");
  check("row ids are unique", new Set(rows.map((row) => row.id)).size === rows.length);
  check("three tool calls make three steps", view.workerStepCount(rows) === 3, String(view.workerStepCount(rows)));

  // A finished worker folds its work; the last reply and failures stay.
  const fold = view.foldFinishedWorker(rows);
  const kept = fold.kept.flatMap((row) => (row.kind === "turn" ? row.blocks.map((b) => b.id) : [row.id]));
  check(
    "the fold keeps the message sent, the failed call, the error and the last reply",
    kept.join() === "steer:3,tool:4,note:5,text:8",
    kept.join(),
  );
  check("the fold counts what it hides", fold.hidden === 4, String(fold.hidden));
  const talkOnly = view.workerRows([{ kind: "text", id: "text:1", at, text: "Nothing to do." }]);
  check("nothing folds without a tool call", view.foldFinishedWorker(talkOnly).hidden === 0);

  const elided = view.workerRows([{ kind: "elided", id: "elided:1", at, count: 40 }, ...entries.slice(0, 2)]);
  check("dropped steps lead as their own row", elided[0].kind === "elided" && elided[0].count === 40);
}
