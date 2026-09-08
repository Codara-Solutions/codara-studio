"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

async function load(entry) {
  const result = await esbuild.build({ entryPoints: [path.resolve(entry)], bundle: true, platform: "node", format: "cjs", write: false, alias: { "@shared": path.resolve("src/shared") } });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}
async function main() {
  const quality = await load("src/shared/whiteboard-quality.ts");
  const { arrangeWhiteboard } = await load("src/shared/whiteboard-layout.ts");
  const review = await load("src/main/whiteboard-review.ts");
  const { createWhiteboardReviewGuard } = await load("resources/pi-cora/whiteboard-review-policy.ts");
  const { parseCoraWhiteboard } = await load("src/shared/cora-whiteboard-file.ts");
  const card = (id, x = 0, y = 0) => ({ id, title: id, kind: "file", x, y, width: 240, height: 140, sources: ["entry.ts:2"], confidence: "confirmed" });
  const nodes = [card("entry"), card("service"), card("storage")];
  const edges = [{ id: "call", from: "entry", to: "service" }, { id: "save", from: "service", to: "storage" }, { id: "cycle", from: "storage", to: "entry" }];
  const board = { version: 1, revision: 1, title: "Project map", updatedAt: "first", nodes, edges };
  assert.ok(quality.whiteboardIssues(board).some((issue) => issue.code === "overlap"));
  const arranged = { ...board, nodes: arrangeWhiteboard(nodes, edges) };
  assert.equal(quality.whiteboardIssues(arranged).filter((issue) => issue.severity === "error").length, 0, "cycle-aware layout separates cards");
  assert.deepEqual(arranged.nodes.map((node) => node.sources), nodes.map((node) => node.sources));
  assert.deepEqual(parseCoraWhiteboard(arranged).nodes[0].sources, ["entry.ts:2"]);
  const groups = [
    { id: "frontend", kind: "group", title: "Frontend", x: 0, y: 0, width: 600, height: 450 },
    card("ui", 30, 70), card("state", 30, 240),
    { id: "backend", kind: "group", title: "Backend", x: 800, y: 0, width: 600, height: 450 },
    card("api", 830, 70), card("db", 830, 240),
  ];
  const groupLinks = [{ id: "ui-state", from: "ui", to: "state" }, { id: "state-api", from: "state", to: "api" }, { id: "api-db", from: "api", to: "db" }];
  const grouped = { ...board, nodes: arrangeWhiteboard(groups, groupLinks), edges: groupLinks };
  assert.deepEqual(quality.whiteboardIssues(grouped).filter((issue) => issue.code === "overlap"), [], "module containers stay separated instead of expanding over each other");
  const frontend = grouped.nodes.find((node) => node.id === "frontend");
  assert.ok(quality.containsWhiteboardNode(frontend, grouped.nodes.find((node) => node.id === "state")));

  assert.throws(() => review.requireWhiteboardInspection("run", board), /Inspect the current/);
  review.rememberWhiteboardInspection("run", board, quality.whiteboardIssues(board), nodes.map((node) => node.id));
  assert.throws(() => review.requireWhiteboardInspection("run", board), /Fix the whiteboard issues/);
  review.rememberWhiteboardInspection("run", arranged, [], ["entry"]);
  // A new revision cannot inherit detail coverage from the old draft.
  const next = { ...arranged, revision: 2, updatedAt: "second" };
  review.rememberWhiteboardInspection("run", next, [], ["entry"]);
  assert.throws(() => review.requireWhiteboardInspection("run", next), /readable detail crops/);
  review.rememberWhiteboardInspection("run", next, [], ["service", "storage"]);
  assert.deepEqual(review.requireWhiteboardInspection("run", next), []);
  assert.throws(() => review.requireWhiteboardInspection("run", { ...next, updatedAt: "rebuilt" }), /Inspect the current/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "whiteboard-source-"));
  try {
    await fs.writeFile(path.join(root, "entry.ts"), "export const entry = 1;\nentry;\n");
    assert.deepEqual(await review.whiteboardSourceIssues(arranged, root), []);
    const bad = { ...arranged, nodes: [{ ...nodes[0], sources: ["entry.ts:90", "../outside.ts:1", "missing.ts:1"] }] };
    assert.equal((await review.whiteboardSourceIssues(bad, root)).length, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }

  const guard = createWhiteboardReviewGuard();
  const result = (whiteboard) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, whiteboard }) }] });
  guard.observe("codara_whiteboard_update", result(board));
  assert.match(guard.completionBlock(), /still a draft/);
  assert.match(guard.followUp(), /revision 1/);
  guard.observe("codara_whiteboard_review", result({ ...board, review: { revision: 1 } }));
  assert.equal(guard.followUp(), null);
  guard.observe("codara_whiteboard_update", result(next));
  assert.ok(guard.followUp());
  assert.equal(guard.followUp(), null, "review reminders are bounded across revisions");
  guard.reset();
  assert.equal(guard.completionBlock(), null, "a new user request does not inherit stale draft work");
  guard.observe("codara_whiteboard_update", { ...result(board), isError: true });
  assert.equal(guard.followUp(), null, "failed writes do not start review work");
  guard.observe("codara_whiteboard_update", result(board));
  assert.ok(guard.completionBlock());
  assert.ok(guard.completionBlock());
  assert.equal(guard.completionBlock(), null, "completion retries cannot become an unbounded tool loop");
  console.log("whiteboard layout, evidence, revision review, and bounded follow-up tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
