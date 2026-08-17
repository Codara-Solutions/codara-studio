// Focused harness for the per-chat Cora Board model (board-store.ts): card
// normalization with server-owned field carry-over, the user-side apply, and
// the one-time legacy workspace-board adoption. Bundles the production module
// so the checks exercise the real code. Persistence/revision guarding lives in
// run-store's commit and is covered by the agent-socket + e2e suites.
//
//   node test-board-store.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "orchestration", "board-store.ts");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-board-test-"));
const userData = path.join(home, "userdata");
fs.mkdirSync(path.join(userData, "pasted-images"), { recursive: true });

// codara-home.ts imports electron for its legacy-userData migration leg, which
// this test never reaches, and board-store uses app.getPath("userData") for
// the pasted-images containment root. Stub the module so the bundle runs under
// plain node with a real temp userData dir.
const electronStub = {
  name: "electron-stub",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `export const app = { getPath: () => ${JSON.stringify(userData)} };`,
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

function card(id, status, order, extra = {}) {
  const now = "2026-01-01T00:00:00.000Z";
  return { id, title: `Card ${id}`, status, order, createdAt: now, updatedAt: now, ...extra };
}

// Mirrors board-store's legacy file naming (sanitize + sha1 digest) so the
// test can plant a legacy workspace-board file where the reader looks.
function legacyFileStem(workspaceId) {
  const cleaned = workspaceId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_");
  const digest = crypto.createHash("sha1").update(workspaceId).digest("hex").slice(0, 8);
  const stem = cleaned.length > 0 ? cleaned.slice(0, 180) : "_unknown";
  return `${stem}-${digest}`;
}

async function main() {
  process.env.CODARA_HOME_DIR = home;
  const outfile = path.join(home, "board-store.bundle.cjs");

  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [electronStub],
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const store = require(outfile);

  // ── 1. normalizeBoardCards basics ────────────────────────────────────────
  const dirty = store.normalizeBoardCards([
    { id: "keep", title: "Keep", status: "nonsense", order: 0, evil: "payload" },
    { id: "", title: "no id", status: "idea", order: 1 },
    { title: "no id field", status: "idea", order: 2 },
    { id: "dupe", title: "First", status: "queued", order: 3 },
    { id: "dupe", title: "Second", status: "done", order: 4 },
    "not-an-object",
  ]);
  check("cards without a usable id are dropped", dirty.length === 2, JSON.stringify(dirty.map((c) => c.id)));
  check("an unknown status falls back to idea", dirty[0].status === "idea");
  check("unknown fields are stripped", !("evil" in dirty[0]));
  check("a duplicated id keeps the first occurrence", dirty[1].title === "First");

  // ── 2. applyUserBoardUpdate: provenance + server-owned carry-over ────────
  const current = {
    revision: 3,
    cards: [
      card("mine", "running", 0, { createdBy: "agent", workerTaskId: "wt-1", description: "the plan", error: "waiting on npm" }),
      card("legacy", "idea", 1, { runId: "run-legacy", imagePaths: [path.join(userData, "pasted-images", "a.png")] }),
    ],
  };
  const applied = store.applyUserBoardUpdate(
    current,
    [
      // Forge every server-owned field on an existing card.
      { ...card("mine", "done", 0), createdBy: "user", workerTaskId: "wt-forged", runId: "run-stolen" },
      // Round-trip the legacy card without its imagePaths field.
      { id: "legacy", title: "Card legacy", status: "idea", order: 1 },
      // A brand-new user card.
      card("new", "queued", 2),
    ],
    undefined,
  );
  const appliedById = new Map(applied.map((c) => [c.id, c]));
  check("user edit keeps the stored createdBy", appliedById.get("mine").createdBy === "agent");
  check(
    "user edit keeps the stored workerTaskId against a forged one",
    appliedById.get("mine").workerTaskId === "wt-1",
    appliedById.get("mine").workerTaskId,
  );
  check("user edit cannot plant a runId", appliedById.get("mine").runId === undefined);
  check("legacy runId is carried over", appliedById.get("legacy").runId === "run-legacy");
  check(
    "omitting imagePaths keeps the stored attachments",
    (appliedById.get("legacy").imagePaths ?? []).length === 1,
  );
  check("a new user card is stamped createdBy user", appliedById.get("new").createdBy === "user");
  check("the user may create a card directly in queued", appliedById.get("new").status === "queued");

  // The user path round-trips whole cards; a payload that omits (or blanks)
  // description/error must never strip the stored text.
  const minimalRoundTrip = store.applyUserBoardUpdate(
    current,
    [{ id: "mine", title: "Card mine", status: "running", order: 0 }],
    undefined,
  );
  check(
    "omitting description on the user path keeps the stored text",
    minimalRoundTrip[0].description === "the plan",
    JSON.stringify(minimalRoundTrip[0]),
  );
  check(
    "omitting the error note on the user path keeps it too",
    minimalRoundTrip[0].error === "waiting on npm",
  );
  // Omission IS the user's delete: BoardView's per-card delete simply commits
  // the card list without the doomed card, and the user may delete ANY card,
  // including agent-created ones with a linked worker.
  check(
    "omitting a card on the user path deletes it",
    minimalRoundTrip.length === 1 && !minimalRoundTrip.some((c) => c.id === "legacy"),
    JSON.stringify(minimalRoundTrip.map((c) => c.id)),
  );
  const deletedWorkerCard = store.applyUserBoardUpdate(
    current,
    [{ id: "legacy", title: "Card legacy", status: "idea", order: 1 }],
    undefined,
  );
  check(
    "the user may delete an agent-created card with a linked worker",
    deletedWorkerCard.length === 1 && deletedWorkerCard[0].id === "legacy",
    JSON.stringify(deletedWorkerCard.map((c) => c.id)),
  );

  // ── 3. image path containment ────────────────────────────────────────────
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const inside = path.join(repo, "shot.png");
  const pasted = path.join(userData, "pasted-images", "p.png");
  const traversal = path.join(repo, "..", "..", "etc", "passwd");
  const withImages = store.applyUserBoardUpdate(
    { revision: 0, cards: [] },
    [
      {
        ...card("img", "idea", 0),
        imagePaths: [inside, pasted, "/etc/passwd", traversal, "relative/path.png", `${repo}/${"x".repeat(1100)}.png`],
      },
    ],
    repo,
  );
  const keptPaths = withImages[0].imagePaths ?? [];
  check(
    "only in-workspace and pasted-images paths survive",
    keptPaths.length === 2 && keptPaths.includes(inside) && keptPaths.includes(pasted),
    JSON.stringify(keptPaths),
  );
  check("an absolute path outside the roots is dropped", !keptPaths.includes("/etc/passwd"));
  check("a traversal path is dropped", !keptPaths.some((p) => p.includes("etc/passwd")));
  const many = Array.from({ length: 20 }, (_, i) => path.join(repo, `s${i}.png`));
  const capped = store.applyUserBoardUpdate(
    { revision: 0, cards: [] },
    [{ ...card("img", "idea", 0), imagePaths: many }],
    repo,
  );
  check("image paths are capped at 8 per card", (capped[0].imagePaths ?? []).length === 8);

  // ── 4. acceptWorkerTaskIds: only the agent path may stamp a task ─────────
  const stamped = store.normalizeBoardCards(
    [
      { ...card("a", "running", 0), workerTaskId: "wt-ok" },
      { ...card("b", "running", 1), workerTaskId: "wt-bad" },
    ],
    { acceptWorkerTaskIds: new Set(["wt-ok"]) },
  );
  check("a payload workerTaskId in the accept set is stamped", stamped[0].workerTaskId === "wt-ok");
  check("a payload workerTaskId outside the set is dropped", stamped[1].workerTaskId === undefined);

  // ── 5. normalizeStoredRunBoard: reading our own file back ────────────────
  const stored = store.normalizeStoredRunBoard({
    revision: 4.9,
    cards: [
      card("x", "running", 0, { createdBy: "agent", workerTaskId: "wt-2", runId: "run-old", imagePaths: ["/anywhere/on/disk.png"] }),
      card("y", "idea", 1, { createdBy: "hacker" }),
    ],
  });
  check("stored revision is clamped to a whole number", stored.revision === 4, String(stored.revision));
  check(
    "stored server-owned fields are restored",
    stored.cards[0].createdBy === "agent" &&
      stored.cards[0].workerTaskId === "wt-2" &&
      stored.cards[0].runId === "run-old" &&
      (stored.cards[0].imagePaths ?? []).length === 1,
    JSON.stringify(stored.cards[0]),
  );
  check("an invalid stored createdBy is dropped", stored.cards[1].createdBy === undefined);
  check("garbage input yields no board", store.normalizeStoredRunBoard("junk") === undefined);

  // ── 6. legacy workspace-board adoption ───────────────────────────────────
  const WS = "workspace-alpha";
  const boardsDir = path.join(home, "boards");
  fs.mkdirSync(boardsDir, { recursive: true });
  const legacyPath = path.join(boardsDir, `${legacyFileStem(WS)}.json`);
  const legacyContent = {
    revision: 7,
    workspaceId: WS,
    cards: [
      card("i1", "idea", 0),
      card("q1", "queued", 1),
      card("r1", "running", 2, { runId: "run-ms5xzc7m-33jk1y", workerTaskId: "wt-should-drop" }),
      card("b1", "blocked", 3, { runId: "run-ms5xynpk-mzy9ml", error: "was waiting" }),
      card("v1", "review", 4),
      card("d1", "done", 5),
      card("f1", "failed", 6, { error: "boom" }),
    ],
  };
  fs.writeFileSync(legacyPath, JSON.stringify(legacyContent, null, 2));
  const legacyBytes = fs.readFileSync(legacyPath, "utf8");

  const adoption = await store.readLegacyBoardForAdoption(WS);
  check("a legacy board with cards is offered for adoption", adoption !== null && adoption.cards.length === 7);
  const byId = new Map(adoption.cards.map((c) => [c.id, c]));
  check(
    "settled lanes carry over unchanged",
    byId.get("i1").status === "idea" &&
      byId.get("v1").status === "review" &&
      byId.get("d1").status === "done" &&
      byId.get("f1").status === "failed",
  );
  check(
    "live lanes (queued/running/blocked) land back in idea",
    byId.get("q1").status === "idea" && byId.get("r1").status === "idea" && byId.get("b1").status === "idea",
    JSON.stringify(["q1", "r1", "b1"].map((id) => byId.get(id).status)),
  );
  check(
    "demoted live cards say where they came from",
    /Adopted from the old workspace board/.test(byId.get("q1").error ?? ""),
    byId.get("q1").error,
  );
  check(
    "the legacy runId link survives so Open chat still works",
    byId.get("r1").runId === "run-ms5xzc7m-33jk1y" && byId.get("b1").runId === "run-ms5xynpk-mzy9ml",
  );
  check("legacy cards never carry a workerTaskId", byId.get("r1").workerTaskId === undefined);
  check("legacy cards read as user-authored (no createdBy)", adoption.cards.every((c) => c.createdBy === undefined));
  check("reading for adoption does not touch the legacy file", fs.readFileSync(legacyPath, "utf8") === legacyBytes);

  await store.markLegacyBoardAdopted(WS, "run-new-owner");
  check("a marked board is not offered again", (await store.readLegacyBoardForAdoption(WS)) === null);
  const marker = JSON.parse(fs.readFileSync(path.join(boardsDir, `${legacyFileStem(WS)}.adopted.json`), "utf8"));
  check("the sidecar records which run adopted", marker.runId === "run-new-owner" && marker.workspaceId === WS);
  check("marking does not touch the legacy file either", fs.readFileSync(legacyPath, "utf8") === legacyBytes);

  await store.clearLegacyBoardAdoption(WS);
  check("clearing the claim re-offers the board", (await store.readLegacyBoardForAdoption(WS)) !== null);

  // Nothing to adopt: missing file, empty cards, corrupt JSON.
  check("a workspace with no legacy file has nothing to adopt", (await store.readLegacyBoardForAdoption("no-such-ws")) === null);
  const emptyWs = "workspace-empty";
  fs.writeFileSync(
    path.join(boardsDir, `${legacyFileStem(emptyWs)}.json`),
    JSON.stringify({ revision: 1, workspaceId: emptyWs, cards: [] }),
  );
  check("an empty legacy board has nothing to adopt", (await store.readLegacyBoardForAdoption(emptyWs)) === null);
  const corruptWs = "workspace-corrupt";
  fs.writeFileSync(path.join(boardsDir, `${legacyFileStem(corruptWs)}.json`), "{not json");
  check("a corrupt legacy board is skipped, not thrown", (await store.readLegacyBoardForAdoption(corruptWs)) === null);

  fs.rmSync(home, { recursive: true, force: true });
  console.log(
    failures === 0
      ? "\nAll board-store checks passed."
      : `\n${failures} board-store check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
