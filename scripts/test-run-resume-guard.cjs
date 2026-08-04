// Regression harness for the blocked-run Resume wedge.
//
// Shape of the bug: a run blocked on an open question showed the composer's
// Resume button right next to the question's own answer options (ChatComposer
// derived isPaused from `status === "paused" || status === "blocked"`).
// Clicking it called resumeRun, which had no blocked-state guard: the run
// flipped to "running" and lost its blocker, but nothing was scheduled to
// drive it (an auto Pi manager fails shouldScheduleDriver, and
// shouldResumeManagerPlanning only fires from "paused"), and answerRunQuestion
// then rejected the now-orphaned question off the non-blocked state. Net: a
// run stuck at "running" with no driver and an unanswerable question.
//
// Both layers are pinned here:
//   1. the store — the REAL run-store.ts, driven over a fabricated run.json:
//      post a question, watch the run block, watch resumeRun REFUSE, then
//      answer and watch the run resume properly;
//   2. the shared predicate resumeBlockingRunQuestion, which decides exactly
//      which blocked shapes are refused — and, just as importantly, which keep
//      their plain resume (a paused run, a direct Loom run still "blocked"
//      after its answer was consumed);
//   3. the source seams — that resumeRun's guard is the FIRST thing it does
//      (so no earlier branch can bypass it) and that the composer hides its
//      Resume button off the same condition.
//
// The two "still resumable" shapes are asserted through the predicate rather
// than by calling resumeRun for real: a resume that is ALLOWED goes on to
// schedule a manager planning turn against a live provider, which has no place
// in a node guard script. The source pin closes the gap by proving
// resumeBlockingRunQuestion is the only refusal resumeRun added.
//
//   node scripts/test-run-resume-guard.cjs
//
// Bundles the REAL run-store.ts against an electron/node-pty stub and drives it
// over run.json files under a throwaway CODARA_HOME_DIR — the same technique as
// scripts/test-wedged-run-recovery.cjs.
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const RUN_QUESTIONS_TS = path.join(ROOT, "src", "shared", "run-questions.ts");
const COMPOSER_TSX = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "components",
  "chat",
  "ChatComposer.tsx",
);
// Bundles live under node_modules so the externalized runtime deps (ssh2 and
// friends) still resolve from the file that requires them.
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-run-resume-guard-test");

const ELECTRON_STUB = `const noop = () => {};
export const app = { getPath: () => "/tmp", getVersion: () => "0.0.0", getName: () => "codara", isPackaged: false, on: noop, whenReady: () => Promise.resolve(), setName: noop };
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

const PTY_STUB = `export function spawn() { throw new Error("node-pty is stubbed in this harness"); }
export function exists() { return false; }
export default { spawn, exists };`;

const stubPlugin = {
  name: "electron-pty-stub",
  setup(build) {
    build.onResolve({ filter: /^(electron|node-pty)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: args.path === "electron" ? ELECTRON_STUB : PTY_STUB,
      loader: "js",
    }));
  },
};

async function bundle(entry, name, opts = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const outfile = path.join(CACHE, name);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    ...opts,
  });
  return require(outfile);
}

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond || detail === undefined ? "" : ` - ${detail}`}`);
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-run-resume-guard-"));
const WS = "ws-resume-guard-test";
const NOW = "2026-08-04T12:00:00.000Z";

// The default shipping configuration and the one the wedge was reported on: a
// pi/auto manager with no worker in flight, so nothing but the scheduler could
// have re-driven the run after a plain resume.
function managedRun(id, overrides = {}) {
  return {
    id,
    title: "resume guard",
    status: "running",
    executionMode: "managed",
    chatBackend: "pi",
    chatMode: "auto",
    workspaceId: WS,
    cwd: HOME,
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    createdAt: NOW,
    updatedAt: NOW,
    conversationEpoch: 0,
    steps: [
      {
        id: "step-1",
        index: 0,
        title: "step 1",
        status: "running",
        acceptanceCriteria: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    workerTasks: [],
    workerAttempts: [],
    humanMessages: [
      {
        id: "msg-1",
        runId: id,
        author: "user",
        kind: "note",
        message: "do the thing",
        attachments: [],
        createdAt: NOW,
        deliveryState: "acknowledged",
        conversationEpoch: 0,
      },
    ],
    sparkCalls: [],
    plans: [],
    assumptions: [],
    ...overrides,
  };
}

function question(id, extra = {}) {
  return {
    id,
    runId: "run-1",
    author: "spark",
    kind: "question",
    message: `Question ${id}`,
    attachments: [],
    createdAt: NOW,
    ...extra,
  };
}

function answer(id, questionMessageId, extra = {}) {
  return {
    id,
    runId: "run-1",
    author: "user",
    kind: "answer",
    message: "go on",
    answersMessageId: questionMessageId,
    attachments: [],
    createdAt: NOW,
    ...extra,
  };
}

function writeRun(run) {
  const dir = path.join(HOME, "runs", run.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2));
  return run.id;
}

function readRun(runId) {
  return JSON.parse(fs.readFileSync(path.join(HOME, "runs", runId, "run.json"), "utf8"));
}

async function rejection(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });

  // ── 1. the shared predicate: which blocked shapes own their own resume ────
  const { resumeBlockingRunQuestion } = await bundle(RUN_QUESTIONS_TS, "run-questions.cjs");

  const blocker = (questionMessageId) => ({
    questionMessageId,
    category: "irreducible_product_scope",
    previousStatus: "running",
    resumeStatus: "running",
    source: "live_manager_rpc",
    resumeStrategy: "active_rpc",
    blockedAt: NOW,
  });
  const predicateRun = (status, humanMessages, extra = {}) => ({
    ...managedRun("run-predicate", { status, humanMessages }),
    ...extra,
  });

  check(
    "an owned open question blocks a plain resume",
    resumeBlockingRunQuestion(
      predicateRun("blocked", [question("q1")], { blockedOn: blocker("q1") }),
    )?.id === "q1",
  );
  // The legacy/unstamped shape: blocked with an open question but no durable
  // blocker (a rewound direct run, an old managed run). Same wedge, so the
  // same refusal.
  check(
    "an unowned open question blocks a plain resume too",
    resumeBlockingRunQuestion(predicateRun("blocked", [question("q1")]))?.id === "q1",
  );

  // ── the shapes that MUST keep their plain resume ─────────────────────────
  // A force pause abandons question ownership but leaves the question message
  // in the transcript. This is exactly the state the orchestration-smoke e2e
  // spec clicks Resume in, so refusing it would break a real, correct flow.
  check(
    "a force-paused run with a stranded question still resumes",
    resumeBlockingRunQuestion(predicateRun("paused", [question("q1")])) === null,
  );
  // A direct Loom run stays "blocked" after applyRunQuestionAnswer consumes
  // its answer — the loop driver owns the continuation. No open question is
  // left, so nothing here is claiming ownership of the resume.
  check(
    "a direct Loom run whose answer was consumed still resumes",
    resumeBlockingRunQuestion(
      predicateRun("blocked", [question("q1"), answer("a1", "q1")], {
        executionMode: "direct",
        automationId: "loom-1",
      }),
    ) === null,
  );
  check(
    "a blocked run with no question at all still resumes",
    resumeBlockingRunQuestion(predicateRun("blocked", [])) === null,
  );
  for (const status of ["running", "planning", "reviewing", "complete", "failed", "cancelled"]) {
    check(
      `a ${status} run is never refused by the guard`,
      resumeBlockingRunQuestion(predicateRun(status, [question("q1")])) === null,
    );
  }

  // ── 2. the REAL store: question → blocked → resume refused → answer ──────
  const runStore = await bundle(RUN_STORE_TS, "run-store.cjs", {
    plugins: [stubPlugin],
    packages: "external",
  });

  const runId = writeRun(managedRun("run-resume-guard"));
  const posted = await runStore.postRunQuestion({
    runId,
    message: "Which database should I use?",
    source: "live_manager_rpc",
    resumeStrategy: "active_rpc",
    resumeStatus: "running",
    questionOptions: [
      { id: "postgres", label: "Postgres" },
      { id: "sqlite", label: "SQLite" },
    ],
  });
  const questionMessageId = posted.questionMessageId;

  const afterQuestion = readRun(runId);
  check("posting a question blocks the run", afterQuestion.status === "blocked", afterQuestion.status);
  check(
    "the blocker owns the posted question",
    afterQuestion.blockedOn && afterQuestion.blockedOn.questionMessageId === questionMessageId,
    JSON.stringify(afterQuestion.blockedOn),
  );
  check(
    "the question message carries its answer options",
    (afterQuestion.humanMessages.find((m) => m.id === questionMessageId)?.questionOptions ?? [])
      .length === 2,
  );

  // The fix: the plain resume every transport funnels through is refused.
  const refusal = await rejection(() => runStore.resumeRun({ runId }));
  check("a plain resume of a question-blocked run is refused", refusal !== null);
  check(
    "the refusal names the question and the way out",
    refusal !== null &&
      refusal.message.includes(questionMessageId) &&
      /Answer it to resume/.test(refusal.message),
    refusal?.message,
  );

  // The wedge itself: the refused call must change NOTHING. Before the guard,
  // this is where the run lost its blocker and flipped to "running".
  const afterRefusal = readRun(runId);
  check("the refused resume leaves the run blocked", afterRefusal.status === "blocked", afterRefusal.status);
  check(
    "the refused resume leaves the blocker intact",
    afterRefusal.blockedOn &&
      afterRefusal.blockedOn.questionMessageId === questionMessageId,
    JSON.stringify(afterRefusal.blockedOn),
  );
  check(
    "the refused resume records no resume event on the run",
    !afterRefusal.humanMessages.some((m) => m.kind === "answer") &&
      afterRefusal.autopilot?.lastAction === "waiting_for_user",
    afterRefusal.autopilot?.lastAction,
  );

  // ...and the real way out still works.
  const answered = await runStore.answerRunQuestion({
    runId,
    questionMessageId,
    message: "Postgres",
  });
  check("answering resumes the run", answered.status === "running", answered.status);
  check("answering releases the blocker", answered.blockedOn === undefined);
  check(
    "the answer is linked to its question",
    answered.humanMessages.some(
      (m) => m.kind === "answer" && m.answersMessageId === questionMessageId,
    ),
  );
  const afterAnswer = readRun(runId);
  check("the resumed run is persisted", afterAnswer.status === "running", afterAnswer.status);
  check(
    "the resumed run is projected as running",
    afterAnswer.autopilot?.status === "running" &&
      afterAnswer.autopilot?.lastAction === "question_answered",
    JSON.stringify(afterAnswer.autopilot),
  );

  // A second question on the resumed run blocks it again, and the refusal is
  // not a one-shot: the guard reads live state, not a latch.
  const second = await runStore.postRunQuestion({
    runId,
    message: "Ship it now?",
    source: "live_manager_rpc",
    resumeStrategy: "active_rpc",
    resumeStatus: "running",
  });
  const secondRefusal = await rejection(() => runStore.resumeRun({ runId }));
  check(
    "a re-blocked run is refused again",
    secondRefusal !== null && secondRefusal.message.includes(second.questionMessageId),
    secondRefusal?.message,
  );

  // ── 3. source seams ─────────────────────────────────────────────────────
  const storeSource = fs.readFileSync(RUN_STORE_TS, "utf8");
  const resumeStart = storeSource.indexOf("export async function resumeRun(");
  const resumeBody = storeSource.slice(
    resumeStart,
    storeSource.indexOf("\nexport async function cancelRun(", resumeStart),
  );
  check("resumeRun exists", resumeStart !== -1 && resumeBody.length > 0);
  // The guard must run BEFORE the manager-turn-recovery branch, which returns
  // out of resumeRun through resumeManagerTurnRecovery and would otherwise
  // resume a blocked run behind the guard's back.
  check(
    "the guard is the first thing resumeRun does",
    /^export async function resumeRun\(input: ResumeRunInput\): Promise<RunState> \{\n\s*const run = await requireRun\(input\.runId\);\n(?:\s*\/\/[^\n]*\n)*\s*const blockingQuestion = resumeBlockingRunQuestion\(run\);\n\s*if \(blockingQuestion\) \{/.test(
      resumeBody,
    ),
  );
  check(
    "the refusal throws rather than silently no-opping",
    /if \(blockingQuestion\) \{\n\s*throw new Error\(/.test(resumeBody),
  );
  // resumeBlockingRunQuestion is the ONLY refusal resumeRun adds — that is what
  // makes the predicate cases above a complete statement of which shapes keep
  // their plain resume.
  check(
    "the guard adds no second, hand-rolled blocked check",
    !/\brun\.status === "blocked"/.test(resumeBody),
  );

  const composerSource = fs.readFileSync(COMPOSER_TSX, "utf8");
  check(
    "the composer derives the same blocked-on-a-question condition",
    /const blockedOnOpenQuestion = status === "blocked" && openQuestion !== null;/.test(
      composerSource,
    ),
  );
  check(
    "the composer withholds Resume in exactly that state",
    /const isPaused =\n\s*\(status === "paused" \|\| status === "blocked"\) && !blockedOnOpenQuestion;/.test(
      composerSource,
    ),
  );
  // Resume must survive for every OTHER paused/blocked shape — the e2e smoke
  // spec clicks it on a force-paused run.
  check(
    "the Resume button still renders off isPaused",
    /\{isPaused && \(\n\s*<TextButton onClick=\{resume\}/.test(composerSource),
  );

  console.log(
    failures === 0
      ? "\nAll run-resume guard checks passed."
      : `\n${failures} run-resume guard check(s) FAILED.`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(HOME, { recursive: true, force: true });
  });
