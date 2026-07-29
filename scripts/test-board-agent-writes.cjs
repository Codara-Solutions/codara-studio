// The agent-side board write policy: what a chat's Cora may and may not do to
// its OWN board. Under the per-chat model the manager works the board, so it
// holds full card powers; the boundaries that remain are the ones that matter
// against a prompt-injected model: it cannot delete the user's cards, cannot
// point a card at another run's worker task, and cannot touch the app-owned
// provenance fields. Each rule gets an explicit test.
//
//   node test-board-agent-writes.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

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

// This run's worker tasks — the only ids a card's workerTaskId may point at.
const WORKER_TASKS = new Set(["wt-1", "wt-2"]);

function stored() {
  const now = "2026-01-01T00:00:00.000Z";
  return [
    // A card the user wrote and queued.
    { id: "user-card", title: "User task", description: "Do it.", status: "queued", createdBy: "user", order: 0, createdAt: now, updatedAt: now },
    // A legacy card (no provenance) adopted from the old workspace board,
    // still linked to the separate run the retired engine spawned for it.
    { id: "legacy-card", title: "Legacy card", status: "review", runId: "run-legacy", order: 1, createdAt: now, updatedAt: now, imagePaths: ["/tmp/userdata/pasted-images/a.png"] },
    // A card Cora created earlier, already linked to one of its workers and
    // carrying a note.
    { id: "agent-card", title: "Cora idea", status: "running", createdBy: "agent", workerTaskId: "wt-1", error: "wedged on npm install", order: 2, createdAt: now, updatedAt: now },
  ];
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-board-agent-"));
  const bundleDir = path.join(ROOT, "node_modules", ".codara-board-agent-test");
  fs.mkdirSync(bundleDir, { recursive: true });
  const outfile = path.join(bundleDir, "bundle.cjs");

  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "agent-socket.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    packages: "external",
    plugins: [electronStub],
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const { authorizeAgentBoardWrite } = require(outfile);
  const authorize = (incoming) =>
    authorizeAgentBoardWrite(stored(), incoming, { workerTaskIds: WORKER_TASKS });

  // ── Full card powers on its own board ────────────────────────────────────
  const queueNew = authorize([...stored(), { id: "planned", title: "Planned follow-up", status: "queued", order: 9 }]);
  check(
    "the manager may create a card in any lane, including queued",
    !("error" in queueNew) && queueNew.cards.find((c) => c.id === "planned").status === "queued",
    JSON.stringify(queueNew),
  );
  check(
    "a manager-created card is stamped createdBy agent",
    !("error" in queueNew) && queueNew.cards.find((c) => c.id === "planned").createdBy === "agent",
  );

  const moveUserCard = authorize(
    stored().map((c) => (c.id === "user-card" ? { ...c, status: "running", workerTaskId: "wt-2" } : c)),
  );
  check(
    "the manager may move the user's queued card to running and stamp its worker",
    !("error" in moveUserCard) &&
      moveUserCard.cards.find((c) => c.id === "user-card").status === "running" &&
      moveUserCard.cards.find((c) => c.id === "user-card").workerTaskId === "wt-2",
    JSON.stringify(moveUserCard),
  );

  const retitle = authorize(
    stored().map((c) => (c.id === "user-card" ? { ...c, title: "Enriched scope", description: "Now with acceptance criteria" } : c)),
  );
  check(
    "the manager may retitle and re-describe the user's card",
    !("error" in retitle) && retitle.cards.find((c) => c.id === "user-card").title === "Enriched scope",
  );

  const reorder = authorize(stored().map((c) => (c.id === "legacy-card" ? { ...c, order: 99 } : c)));
  check("the manager may reorder any card", !("error" in reorder) && reorder.cards.find((c) => c.id === "legacy-card").order === 99);

  const blocked = authorize(
    stored().map((c) => (c.id === "agent-card" ? { ...c, status: "blocked", error: "needs a database password" } : c)),
  );
  check(
    "the manager may park a card in blocked with a note",
    !("error" in blocked) &&
      blocked.cards.find((c) => c.id === "agent-card").status === "blocked" &&
      blocked.cards.find((c) => c.id === "agent-card").error === "needs a database password",
  );

  // ── Omission never destroys card text ────────────────────────────────────
  // The schema requires only id/title/status/order, so a minimally compliant
  // round-trip must keep descriptions and notes intact.
  const minimal = authorize(
    stored().map((c) => ({ id: c.id, title: c.title, status: c.status, order: c.order })),
  );
  check(
    "a minimal round-trip keeps the user's description",
    !("error" in minimal) && minimal.cards.find((c) => c.id === "user-card").description === "Do it.",
    JSON.stringify(minimal.cards?.find((c) => c.id === "user-card")),
  );
  check(
    "a minimal round-trip keeps the note while the lane is unchanged",
    !("error" in minimal) &&
      minimal.cards.find((c) => c.id === "agent-card").error === "wedged on npm install",
  );
  check(
    "an empty description also keeps the stored one",
    (() => {
      const res = authorize(stored().map((c) => (c.id === "user-card" ? { ...c, description: "  " } : c)));
      return !("error" in res) && res.cards.find((c) => c.id === "user-card").description === "Do it.";
    })(),
  );
  const laneChange = authorize(
    stored().map((c) =>
      c.id === "agent-card" ? { id: c.id, title: c.title, status: "done", order: c.order } : c,
    ),
  );
  check(
    "a lane change without a fresh note clears the stale one",
    !("error" in laneChange) && laneChange.cards.find((c) => c.id === "agent-card").error === undefined,
    JSON.stringify(laneChange.cards?.find((c) => c.id === "agent-card")),
  );
  const laneChangeWithNote = authorize(
    stored().map((c) =>
      c.id === "agent-card" ? { ...c, status: "failed", error: "gave up: flaky suite" } : c,
    ),
  );
  check(
    "a lane change with a fresh note keeps the new note",
    !("error" in laneChangeWithNote) &&
      laneChangeWithNote.cards.find((c) => c.id === "agent-card").error === "gave up: flaky suite",
  );

  // ── workerTaskId validation ──────────────────────────────────────────────
  const badTask = authorize(
    stored().map((c) => (c.id === "user-card" ? { ...c, workerTaskId: "wt-of-another-run" } : c)),
  );
  check(
    "a workerTaskId outside this run's tasks is refused",
    "error" in badTask && /not a worker task of this run/.test(badTask.error),
    JSON.stringify(badTask),
  );

  const keepStaleTask = authorize(stored());
  check(
    "an existing stamp round-trips even if the task set no longer lists it",
    !("error" in keepStaleTask) && keepStaleTask.cards.find((c) => c.id === "agent-card").workerTaskId === "wt-1",
  );

  const restamp = authorize(
    stored().map((c) => (c.id === "agent-card" ? { ...c, workerTaskId: "wt-2" } : c)),
  );
  check(
    "the manager may re-stamp a card onto another of its own workers",
    !("error" in restamp) && restamp.cards.find((c) => c.id === "agent-card").workerTaskId === "wt-2",
  );

  // ── Deletion: only the agent's own cards ─────────────────────────────────
  const deleteUser = authorize(stored().filter((c) => c.id !== "user-card"));
  check(
    "omitting the user's card is refused",
    "error" in deleteUser && /may not delete cards the user created/.test(deleteUser.error),
    JSON.stringify(deleteUser),
  );

  const deleteLegacy = authorize(stored().filter((c) => c.id !== "legacy-card"));
  check(
    "a legacy card with no provenance counts as the user's",
    "error" in deleteLegacy,
    JSON.stringify(deleteLegacy),
  );

  const deleteOwn = authorize(stored().filter((c) => c.id !== "agent-card"));
  check(
    "the manager may delete a card it created itself",
    !("error" in deleteOwn) && deleteOwn.cards.length === 2,
    JSON.stringify(deleteOwn),
  );

  // ── Server-owned fields ──────────────────────────────────────────────────
  const forge = authorize(
    stored().map((c) =>
      c.id === "legacy-card" ? { ...c, runId: "run-attacker", createdBy: "agent" } : c,
    ),
  );
  check(
    "a forged legacy runId is ignored, not honored",
    !("error" in forge) && forge.cards.find((c) => c.id === "legacy-card").runId === "run-legacy",
  );
  check(
    "forged provenance is ignored (the card stays the user's)",
    !("error" in forge) && forge.cards.find((c) => c.id === "legacy-card").createdBy === undefined,
  );

  const forgeImages = authorize(
    stored().map((c) => (c.id === "agent-card" ? { ...c, imagePaths: ["/etc/passwd"] } : c)),
  );
  check(
    "agent-supplied imagePaths are ignored",
    !("error" in forgeImages) && !forgeImages.cards.find((c) => c.id === "agent-card").imagePaths,
    JSON.stringify(forgeImages.cards?.find((c) => c.id === "agent-card")),
  );

  const preservedImages = authorize(stored());
  check(
    "an untouched card keeps its stored imagePaths",
    !("error" in preservedImages) &&
      preservedImages.cards.find((c) => c.id === "legacy-card").imagePaths?.length === 1,
  );

  // ── Malformed input ──────────────────────────────────────────────────────
  check("a non-object card is rejected", "error" in authorize([...stored(), "nope"]));
  check("a card without an id is rejected", "error" in authorize([...stored(), { title: "x", status: "idea" }]));
  check("a card without a title is rejected", "error" in authorize([...stored(), { id: "z", title: "  ", status: "idea" }]));
  check(
    "a duplicated id is rejected",
    "error" in authorize([...stored(), { id: "user-card", title: "dupe", status: "idea", order: 4 }]),
  );
  const badStatus = authorize([...stored(), { id: "weird", title: "weird", status: "someday", order: 5 }]);
  check(
    "an unknown status is rejected with the lane list",
    "error" in badStatus && /Valid lanes/.test(badStatus.error),
    JSON.stringify(badStatus),
  );

  // ── The no-op case must be accepted ──────────────────────────────────────
  const noop = authorize(stored());
  check("sending the board back unchanged is accepted", !("error" in noop) && noop.cards.length === 3);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(bundleDir, { recursive: true, force: true });
  console.log(
    failures === 0
      ? "\nAll agent board-write policy checks passed."
      : `\n${failures} agent board-write policy check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
