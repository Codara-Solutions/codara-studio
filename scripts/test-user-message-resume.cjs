// Contract tests for "sending into a paused run resumes it"
// (src/main/orchestration/user-message-resume.ts) plus the run-store wiring
// that acts on it.
//
// The predicate imports ONLY types (@shared/types), all erased by esbuild, so
// this harness bundles it with no stubs (same approach as
// scripts/test-worker-model-hint.cjs) and exercises the REAL decision. The
// wiring itself lives inside run-store.ts, which drags in electron/pty/git, so
// it is pinned by reading the source — the same technique
// scripts/test-manager-turn-policy.cjs uses.
//
//   node scripts/test-user-message-resume.cjs
//
// Evidence: run-msa0s2t6-sz26w1 — the user paused, typed a message, sent it,
// and nothing happened. The message was recorded and left queued forever:
// scheduleQueuedSteeringFollowup returns early while paused, and only
// resumeRun consumes the queue.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const MODULE_TS = path.join(ROOT, "src", "main", "orchestration", "user-message-resume.ts");
const RUN_STORE = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");

const harnessPlugin = {
  name: "user-message-resume-test-harness",
  setup(build) {
    // @shared/* is a type-only import here, erased by esbuild — resolve
    // defensively so a future value import never breaks the bundle.
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function loadContract() {
  const out = await esbuild.build({
    entryPoints: [MODULE_TS],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    plugins: [harnessPlugin],
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// A user force-pause: exactly the state run-msa0s2t6-sz26w1 was in.
const forcePaused = { status: "paused", autopilot: { lastAction: "force_paused" } };
// A run the manager-turn failure policy parked (the live run-msa0v0te-lru1ge
// sat here on an Extra Usage rejection).
const parked = { status: "paused", autopilot: { lastAction: "chat_turn_parked" } };

async function main() {
  const { shouldResumeForUserMessage } = await loadContract();
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  test("a message into a user-paused run resumes it", () => {
    assert.equal(shouldResumeForUserMessage(forcePaused, "turn"), true);
    assert.equal(shouldResumeForUserMessage(forcePaused, "steer"), true);
  });

  test("a message into an error-parked run resumes it too", () => {
    // Same pause, different cause: the user answering a provider failure with
    // "try again" must not have to find a second button either.
    assert.equal(shouldResumeForUserMessage(parked, "turn"), true);
    assert.equal(shouldResumeForUserMessage(parked, "steer"), true);
  });

  test("an answer never takes this path", () => {
    // Answers resume through answerRunQuestion's own continuation.
    assert.equal(shouldResumeForUserMessage(forcePaused, "answer"), false);
  });

  test("an open question keeps ownership of the run", () => {
    const blocked = {
      ...forcePaused,
      blockedOn: { questionMessageId: "msg-q", askedAt: "2026-08-01T07:00:00.000Z" },
    };
    assert.equal(shouldResumeForUserMessage(blocked, "turn"), false);
  });

  test("only paused runs are resumed", () => {
    for (const status of [
      "planning",
      "running",
      "reviewing",
      "blocked",
      "complete",
      "failed",
      "cancelled",
    ]) {
      assert.equal(
        shouldResumeForUserMessage({ status }, "turn"),
        false,
        `${status} must not be auto-resumed`,
      );
    }
  });

  test("loom runs are never woken by a note", () => {
    assert.equal(
      shouldResumeForUserMessage({ ...forcePaused, executionMode: "direct" }, "turn"),
      false,
    );
  });

  // ── run-store wiring ──────────────────────────────────────────────────────
  const source = fs.readFileSync(RUN_STORE, "utf8");

  test("addRunMessage schedules the resume for user messages", () => {
    assert.match(
      source,
      /if \(input\.author === "user"\) \{\s*\n\s*scheduleResumeForUserMessage\(updated, recordedIntent\);/,
      "the message tail must hand the recorded intent to the scheduler",
    );
  });

  test("the scheduler re-decides on a freshly read run before resuming", () => {
    const start = source.indexOf("function scheduleResumeForUserMessage");
    // Bounded by the next declaration so the assertions below read only this
    // function's body, not half the file.
    const scheduler = source.slice(
      start,
      source.indexOf("\nfunction scheduleQueuedSteeringFollowup", start),
    );
    assert.ok(scheduler.length > 0, "scheduleResumeForUserMessage must exist");
    // Guard against a stale decision: the run is re-read and re-tested after
    // the await, so a pause lifted meanwhile cannot produce a second turn.
    assert.match(scheduler, /const latest = await getRun\(run\.id\);/);
    assert.match(scheduler, /shouldResumeForUserMessage\(latest, intent\)/);
    assert.match(scheduler, /conversationEpoch\(latest\) !== scheduledEpoch/);
    // One resume per run at a time, whatever the send rate.
    assert.match(scheduler, /activeUserMessageResumes\.has\(run\.id\)/);
    assert.match(scheduler, /activeUserMessageResumes\.delete\(run\.id\)/);
    // Resume goes through the same entry point the Resume button calls.
    assert.match(scheduler, /await resumeRun\(\{ runId: latest\.id \}\)/);
    // A failed resume leaves the run paused and usable, with a journal entry.
    assert.match(scheduler, /run\.auto_resume_failed/);
    assert.doesNotMatch(
      scheduler,
      /draft\.status = "running"/,
      "the scheduler must not hand-roll a second resume path",
    );
  });

  console.log(`\n${passed} user-message-resume contract tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
