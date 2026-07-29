// The board nudge lifecycle: queued cards on a chat's board wake that chat's
// OWN manager, exactly once per card, never for automation runs, and never
// while the manager is busy. Replaces the retired test-board-engine.cjs (the
// engine that spawned a separate run per card is gone). Drives board-nudge.ts
// with fully injected deps, so no electron and no run-store are loaded; the
// injection itself (synthetic note + chat decision) lives in run-store's
// nudgeBoardManager, exercised via the app.
//
//   node test-board-nudge.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

// board-nudge imports event-log (electron-adjacent) at module scope; stub
// electron so the bundle loads under plain node. The subscribe seam is
// injected, so event-log itself is never exercised.
const electronStub = {
  name: "electron-stub",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: [
        "export const app = { getPath: () => '/tmp/userdata', getVersion: () => '0.0.0', isPackaged: false, on: () => {}, whenReady: () => Promise.resolve() };",
        "export const BrowserWindow = { getAllWindows: () => [] };",
        "export class Notification { constructor() {} show() {} on() {} }",
        "export const shell = { openExternal: async () => {} };",
        "export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };",
        "export const ipcMain = { on: () => {}, handle: () => {} };",
        "export const nativeImage = { createFromPath: () => ({}) };",
        "export const clipboard = { writeText: () => {} };",
        "export const dialog = {};",
        "export const webContents = { getAllWebContents: () => [] };",
      ].join("\n"),
      loader: "js",
    }));
  },
};

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The module's trailing debounce is 400ms; wait comfortably past it.
const SETTLE_MS = 700;

function card(id, status) {
  const now = new Date().toISOString();
  return { id, title: `Card ${id}`, status, order: 0, createdAt: now, updatedAt: now };
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-board-nudge-"));
  process.env.CODARA_HOME_DIR = home;
  // packages:"external" + a bundle under node_modules: event-log's transitive
  // deps include native .node addons (ssh2) esbuild cannot bundle; they must
  // resolve from the project's node_modules at require time.
  const bundleDir = path.join(ROOT, "node_modules", ".codara-board-nudge-test");
  fs.mkdirSync(bundleDir, { recursive: true });
  const outfile = path.join(bundleDir, "bundle.cjs");

  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "board-nudge.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    packages: "external",
    plugins: [electronStub],
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const nudgeModule = require(outfile);

  // ── Fake world ───────────────────────────────────────────────────────────
  // Runs the fake getRun serves, mutated by the test between phases.
  const runs = new Map();
  // Every nudge the module asked for, in order; `outcomes` scripts the reply.
  const nudges = [];
  const outcomes = new Map(); // runId -> outcome for the NEXT nudge
  let emit = null; // the module's event handler, captured via the subscribe seam

  // Named so the restart-simulation phase below can start a fresh session
  // against the same world.
  const fakeDeps = {
    getRun: async (runId) => runs.get(runId) ?? null,
    nudge: async (runId) => {
      nudges.push(runId);
      return outcomes.get(runId) ?? "nudged";
    },
    subscribe: (handler) => {
      emit = handler;
      return () => {
        emit = null;
      };
    },
  };

  await nudgeModule.startBoardNudge(fakeDeps);
  check("the module subscribed to the event bus", typeof emit === "function");

  // ── 1. queue while idle → exactly one nudge ──────────────────────────────
  runs.set("run-a", {
    id: "run-a",
    status: "idle",
    board: { revision: 1, cards: [card("c1", "queued")] },
  });
  emit({ runId: "run-a", type: "run.board_updated" });
  await sleep(SETTLE_MS);
  check("a queued card on an idle run nudges once", nudges.length === 1 && nudges[0] === "run-a", JSON.stringify(nudges));

  // ── 2. a burst of board writes → still one nudge ─────────────────────────
  runs.set("run-b", {
    id: "run-b",
    status: "idle",
    board: { revision: 3, cards: [card("b1", "queued"), card("b2", "queued"), card("b3", "queued")] },
  });
  emit({ runId: "run-b", type: "run.board_updated" });
  emit({ runId: "run-b", type: "run.board_updated" });
  emit({ runId: "run-b", type: "run.board_updated" });
  await sleep(SETTLE_MS);
  check(
    "three queue writes in one burst collapse into one nudge",
    nudges.filter((id) => id === "run-b").length === 1,
    JSON.stringify(nudges),
  );

  // ── 3. already-nudged cards do not re-fire on later events ───────────────
  emit({ runId: "run-b", type: "run.status_updated" });
  emit({ runId: "run-b", type: "run.board_updated" });
  await sleep(SETTLE_MS);
  check(
    "cards already handed over are not re-nudged on later events",
    nudges.filter((id) => id === "run-b").length === 1,
    JSON.stringify(nudges),
  );

  // ── 4. a NEW queued card nudges again ────────────────────────────────────
  runs.get("run-b").board.cards.push(card("b4", "queued"));
  emit({ runId: "run-b", type: "run.board_updated" });
  await sleep(SETTLE_MS);
  check(
    "a newly queued card nudges again",
    nudges.filter((id) => id === "run-b").length === 2,
    JSON.stringify(nudges),
  );

  // ── 5. busy manager → no duplicate; retried on the next run event ────────
  runs.set("run-c", {
    id: "run-c",
    status: "running",
    board: { revision: 1, cards: [card("cc1", "queued")] },
  });
  outcomes.set("run-c", "busy");
  emit({ runId: "run-c", type: "run.board_updated" });
  await sleep(SETTLE_MS);
  check("a busy manager gets asked once (and refuses)", nudges.filter((id) => id === "run-c").length === 1);

  // While busy, unrelated events keep retrying (pending set), still refused.
  emit({ runId: "run-c", type: "chat.assistant_block" });
  await sleep(SETTLE_MS);
  check(
    "a pending run retries on any of its events",
    nudges.filter((id) => id === "run-c").length === 2,
    JSON.stringify(nudges),
  );

  // The turn ends: the manager goes idle, the retry lands, and the hand-over
  // sticks — further settles do not re-nudge the same card.
  outcomes.set("run-c", "nudged");
  runs.get("run-c").status = "complete";
  emit({ runId: "run-c", type: "run.status_updated" });
  await sleep(SETTLE_MS);
  const afterIdle = nudges.filter((id) => id === "run-c").length;
  emit({ runId: "run-c", type: "run.status_updated" });
  await sleep(SETTLE_MS);
  check("the retry lands once the manager settles", afterIdle === 3, String(afterIdle));
  check(
    "no duplicate nudge after the hand-over",
    nudges.filter((id) => id === "run-c").length === 3,
    JSON.stringify(nudges),
  );

  // ── 6. a card that leaves queued clears the ledger; re-queueing re-nudges ─
  runs.get("run-b").board.cards = runs.get("run-b").board.cards.map((c) => ({ ...c, status: "done" }));
  emit({ runId: "run-b", type: "run.board_updated" });
  await sleep(SETTLE_MS);
  const afterClear = nudges.filter((id) => id === "run-b").length;
  runs.get("run-b").board.cards[0].status = "queued";
  emit({ runId: "run-b", type: "run.board_updated" });
  await sleep(SETTLE_MS);
  check("clearing the queue does not nudge", afterClear === 2, String(afterClear));
  check(
    "re-queueing a previously handled card nudges again",
    nudges.filter((id) => id === "run-b").length === 3,
    JSON.stringify(nudges),
  );

  // ── 7. automation runs are never nudged ──────────────────────────────────
  runs.set("run-loom", {
    id: "run-loom",
    status: "idle",
    automationId: "auto-1",
    board: { revision: 1, cards: [card("l1", "queued")] },
  });
  runs.set("run-direct", {
    id: "run-direct",
    status: "idle",
    executionMode: "direct",
    board: { revision: 1, cards: [card("d1", "queued")] },
  });
  emit({ runId: "run-loom", type: "run.board_updated" });
  emit({ runId: "run-direct", type: "run.board_updated" });
  await sleep(SETTLE_MS);
  check(
    "automation and direct runs are never nudged",
    !nudges.includes("run-loom") && !nudges.includes("run-direct"),
    JSON.stringify(nudges),
  );

  // ── 8. a run with no queued cards is left alone ──────────────────────────
  runs.set("run-quiet", {
    id: "run-quiet",
    status: "idle",
    board: { revision: 1, cards: [card("q1", "idea"), card("q2", "done")] },
  });
  emit({ runId: "run-quiet", type: "run.board_updated" });
  await sleep(SETTLE_MS);
  check("a board without queued cards never nudges", !nudges.includes("run-quiet"), JSON.stringify(nudges));

  // ── 9. a deleted run clears its state instead of throwing ────────────────
  emit({ runId: "run-gone", type: "run.board_updated" });
  await sleep(SETTLE_MS);
  check("an unknown run is ignored", !nudges.includes("run-gone"));

  // ── 10. restart pickup: user interaction is the consent signal ───────────
  // A fresh session (stop + start clears the ledger and the seen set, exactly
  // like an app relaunch) must hand a leftover queued card over on the run's
  // FIRST event of the session — a chat message, not a board write.
  nudgeModule.stopBoardNudge();
  check("stop unsubscribes from the bus", emit === null);
  await nudgeModule.startBoardNudge(fakeDeps);
  runs.set("run-restart", {
    id: "run-restart",
    status: "idle",
    board: { revision: 5, cards: [card("r1", "queued")] },
  });
  emit({ runId: "run-restart", type: "human.note" });
  await sleep(SETTLE_MS);
  check(
    "a card queued before the restart is handed over on the run's first event",
    nudges.filter((id) => id === "run-restart").length === 1,
    JSON.stringify(nudges),
  );
  emit({ runId: "run-restart", type: "human.note" });
  await sleep(SETTLE_MS);
  check(
    "the first-event board check runs once per session",
    nudges.filter((id) => id === "run-restart").length === 1,
    JSON.stringify(nudges),
  );
  runs.set("run-restart-quiet", {
    id: "run-restart-quiet",
    status: "idle",
    board: { revision: 2, cards: [card("rq1", "idea")] },
  });
  emit({ runId: "run-restart-quiet", type: "run.status_updated" });
  await sleep(SETTLE_MS);
  check(
    "a first event with nothing queued nudges nothing",
    !nudges.includes("run-restart-quiet"),
  );

  // ── 11. teardown ─────────────────────────────────────────────────────────
  nudgeModule.stopBoardNudge();
  check("stop unsubscribes from the bus again", emit === null);
  const before = nudges.length;
  runs.set("run-late", {
    id: "run-late",
    status: "idle",
    board: { revision: 1, cards: [card("z1", "queued")] },
  });
  // A handler captured before stop must be inert (timers cleared, started=false).
  await sleep(SETTLE_MS);
  check("nothing fires after stop", nudges.length === before);

  // ── 12. the nudge note vs the plan-rewrite heuristics ────────────────────
  // The synthetic note is delivered as user-authored text; pin that (a) its
  // wording never trips hasExplicitParallelAgentIntent (the canned staging
  // plan rewriter's trigger), and (b) the last-user-text heuristic skips
  // boardNote messages entirely, so even a hostile card title cannot arm it.
  const heurEntry = path.join(bundleDir, "entry-heuristics.ts");
  fs.writeFileSync(
    heurEntry,
    [
      `export { composeBoardNudgeMessage } from ${JSON.stringify(
        path.join(ROOT, "src", "main", "orchestration", "board-store.ts"),
      )};`,
      `export { hasExplicitParallelAgentIntent, isHeuristicUserMessage, latestUserRunMessageText } from ${JSON.stringify(
        path.join(ROOT, "src", "main", "orchestration", "user-intent.ts"),
      )};`,
    ].join("\n"),
  );
  const heurOut = path.join(bundleDir, "heuristics.bundle.cjs");
  await esbuild.build({
    entryPoints: [heurEntry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: heurOut,
    logLevel: "silent",
    packages: "external",
    plugins: [electronStub],
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const heur = require(heurOut);

  check(
    "the intent trigger itself still works",
    heur.hasExplicitParallelAgentIntent(
      "please spawn two workers in parallel and combine the results",
    ) === true,
  );
  const note = heur.composeBoardNudgeMessage([
    card("n1", "queued"),
    card("n2", "queued"),
    card("n3", "queued"),
  ]);
  check(
    "the composed nudge note never trips the parallel-agent trigger",
    heur.hasExplicitParallelAgentIntent(note) === false,
    note,
  );
  const boardNoteMessage = {
    id: "m2",
    runId: "r",
    author: "user",
    kind: "note",
    boardNote: true,
    message: "spawn workers in parallel and combine everything", // hostile-worst-case body
    createdAt: new Date().toISOString(),
  };
  check(
    "boardNote messages are not heuristic user messages",
    heur.isHeuristicUserMessage(boardNoteMessage) === false,
  );
  const heurRun = {
    humanMessages: [
      { id: "m1", runId: "r", author: "user", kind: "note", message: "real ask", createdAt: "2026-01-01T00:00:00.000Z" },
      boardNoteMessage,
    ],
  };
  check(
    "latestUserRunMessageText skips board notes",
    heur.latestUserRunMessageText(heurRun) === "real ask",
  );
  check(
    "a run whose only user text is a board note reads as empty intent",
    heur.latestUserRunMessageText({ humanMessages: [boardNoteMessage] }) === "",
  );

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(bundleDir, { recursive: true, force: true });
  console.log(
    failures === 0
      ? "\nAll board-nudge checks passed."
      : `\n${failures} board-nudge check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
