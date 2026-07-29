// Pure routing tests for the workbench's active-tab decisions
// (src/renderer/src/tabs/workbenchRouting.ts). Bundles the REAL module so the
// checks exercise production code.
//
//   node scripts/test-workbench-routing.cjs
//
// What is pinned here:
//   1. The split-view Runs bug: with two Cora chats open, activating the
//      SECOND chat's Runs canvas (or preview / worker terminal) must light the
//      second chat's top-strip pill, never the first chat's.
//   2. The stranded-browser bug: when the stored active id is gone, the
//      effective active tab must never auto-promote a run-owned tab (a
//      Cora-opened browser whose chat tab was closed has no pill anywhere) —
//      it falls back to the first non-run-owned tab, or null.
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "renderer", "src", "tabs", "workbenchRouting.ts");

const chat = (id) => ({ id, kind: "chat", title: "Cora" });
const runsTab = (id, runId) => ({ id, kind: "runs", title: "Runs", runId });
const preview = (id, runId) => ({
  id,
  kind: "preview",
  title: "preview",
  url: "http://localhost:3000",
  ...(runId ? { runId } : {}),
});
const workerTerminal = (id, runId) => ({
  id,
  kind: "terminal",
  title: "Workers",
  root: { kind: "leaf", paneId: `${id}-p1` },
  activePaneId: `${id}-p1`,
  scope: { kind: "workers", runId },
});
const plainTerminal = (id) => ({
  id,
  kind: "terminal",
  title: "Terminal",
  root: { kind: "leaf", paneId: `${id}-p1` },
  activePaneId: `${id}-p1`,
});

async function main() {
  const outfile = path.join(os.tmpdir(), "codara-workbench-routing-test", "workbenchRouting.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const { resolveEffectiveActiveId, resolveTopStripActiveId, runOwnedTabRunId } = require(outfile);

  let failures = 0;
  const check = (name, cond, detail) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  };

  // ── runOwnedTabRunId ───────────────────────────────────────────────────────
  check("worker terminal maps to its run", runOwnedTabRunId(workerTerminal("t1", "run-b")) === "run-b");
  check("runs tab maps to its run", runOwnedTabRunId(runsTab("r1", "run-b")) === "run-b");
  check("run-tagged preview maps to its run", runOwnedTabRunId(preview("p1", "run-b")) === "run-b");
  check("plain preview is not run-owned", runOwnedTabRunId(preview("p2")) === null);
  check("chat tab is not run-owned", runOwnedTabRunId(chat("run-a")) === null);

  // ── resolveTopStripActiveId: the split-view Runs bug ──────────────────────
  // Two Cora chats (tab id === run id). The second chat's Runs canvas is
  // active; the strip must highlight chat B, not chat A.
  const chats = [chat("run-a"), chat("run-b")];
  const runsB = runsTab("runs-1", "run-b");
  {
    const visible = [...chats, runsB];
    const got = resolveTopStripActiveId("runs-1", visible, chats);
    check("second chat's Runs canvas highlights the second chat tab", got === "run-b", got);
  }
  {
    const previewB = preview("p-b", "run-b");
    const visible = [...chats, previewB];
    const got = resolveTopStripActiveId("p-b", visible, chats);
    check("second chat's preview highlights the second chat tab", got === "run-b", got);
  }
  {
    const workersA = workerTerminal("wt-a", "run-a");
    const visible = [...chats, workersA];
    const got = resolveTopStripActiveId("wt-a", visible, chats);
    check("first chat's worker terminal highlights the first chat tab", got === "run-a", got);
  }
  {
    // Owning chat closed: fall back to the first chat tab rather than nothing.
    const orphanRuns = runsTab("runs-x", "run-gone");
    const visible = [...chats, orphanRuns];
    const got = resolveTopStripActiveId("runs-x", visible, chats);
    check("run-owned tab with no owning chat falls back to the first chat", got === "run-a", got);
  }
  {
    const visible = [...chats, runsB];
    const got = resolveTopStripActiveId("run-a", visible, chats);
    check("a non-run-owned active tab highlights itself", got === "run-a", got);
    check("null active resolves to null", resolveTopStripActiveId(null, visible, chats) === null);
  }

  // ── resolveEffectiveActiveId: the stranded-browser bug ────────────────────
  {
    const visible = [chat("run-a"), preview("p-b", "run-b")];
    check(
      "a stored active id that is still visible wins",
      resolveEffectiveActiveId("p-b", visible) === "p-b",
    );
  }
  {
    // Chat closed, orphaned run-owned preview first in list: the fallback must
    // skip it and land on the plain terminal.
    const visible = [preview("p-b", "run-b"), plainTerminal("t-plain")];
    const got = resolveEffectiveActiveId(null, visible);
    check("fallback skips run-owned tabs", got === "t-plain", got);
    check(
      "an invalid stored id also falls through to the non-run-owned tab",
      resolveEffectiveActiveId("gone", visible) === "t-plain",
    );
  }
  {
    // ONLY orphaned run-owned tabs left (the reported case: close the sole
    // Cora chat while it has a Cora-opened browser): nothing is eligible.
    const visible = [preview("p-b", "run-b"), runsTab("runs-1", "run-b"), workerTerminal("wt", "run-b")];
    const got = resolveEffectiveActiveId(null, visible);
    check("only run-owned tabs left resolves to null (empty state)", got === null, got);
  }
  {
    check("no tabs resolves to null", resolveEffectiveActiveId(null, []) === null);
    // A plain (user-opened, runId-less) preview is a normal top-strip tab and
    // MAY be the fallback.
    const visible = [preview("p-user")];
    check("a plain preview may be the fallback", resolveEffectiveActiveId(null, visible) === "p-user");
  }

  if (failures > 0) {
    console.error(`\n${failures} workbench-routing check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll workbench-routing checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
