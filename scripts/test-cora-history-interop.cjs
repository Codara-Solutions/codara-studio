// Cross-repository producer/consumer contract for Studio's bounded Cora
// history deltas and the mobile client's exact materializer.
//
//   npm run test:cora-history-interop

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const STUDIO_ROOT = path.resolve(__dirname, "..");
const MOBILE_ROOT = path.resolve(STUDIO_ROOT, "..", "codara-mobile");
const CACHE_ROOT = path.join(STUDIO_ROOT, "node_modules", ".cache");

async function bundle(entry, name) {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const outfile = path.join(CACHE_ROOT, name);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: {
      "@shared": path.join(STUDIO_ROOT, "src", "shared"),
    },
  });
  delete require.cache[outfile];
  return require(outfile);
}

function summary(id, overrides = {}) {
  return {
    id,
    workspaceId: "workspace-interop",
    title: `Conversation ${id}`,
    status: "running",
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:01:00.000Z",
    messageCount: 1,
    activeWorkers: 0,
    ...overrides,
  };
}

function throughWire(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  assert.ok(
    fs.existsSync(MOBILE_ROOT),
    `mobile sibling repository is required at ${MOBILE_ROOT}`,
  );
  const studio = await bundle(
    path.join(
      STUDIO_ROOT,
      "src",
      "main",
      "remote-access",
      "cora-history-delta.ts",
    ),
    "cora-history-studio-interop.cjs",
  );
  const mobile = await bundle(
    path.join(MOBILE_ROOT, "src", "lib", "cora-history-delta.ts"),
    "cora-history-mobile-interop.cjs",
  );

  assert.equal(studio.CORA_HISTORY_DELTA_VERSION, 1);
  assert.equal(mobile.CORA_HISTORY_DELTA_VERSION, 1);
  assert.equal(mobile.CORA_HISTORY_MAX_RUNS, 50);
  assert.equal(mobile.CORA_HISTORY_RUNS_MAX_UTF8_BYTES, 72 * 1024);

  const cache = new studio.CoraHistoryDeltaCache();
  const boundaryId = "界".repeat(85) + "a";
  assert.equal(Buffer.byteLength(boundaryId, "utf8"), 256);
  const baseRuns = [
    summary("run-a", { title: "A", lastMessage: "base" }),
    summary(boundaryId, {
      title: "界".repeat(170) + "aa",
      model: "m".repeat(120),
    }),
    summary("run-removed", { status: "complete" }),
    ...Array.from({ length: 18 }, (_, index) =>
      summary(`run-stable-${index}`, {
        title: `Stable conversation ${index} ${"x".repeat(140)}`,
        lastMessage: `Unchanged history ${index} ${"y".repeat(140)}`,
      }),
    ),
  ];
  assert.equal(
    Buffer.byteLength(baseRuns[1].title, "utf8"),
    512,
    "fixture exercises Studio/mobile's exact UTF-8 title boundary",
  );

  const initial = throughWire(
    cache.project({
      workspaceId: "workspace-interop",
      runs: baseRuns,
      deltaVersion: 1,
    }),
  );
  assert.ok(Array.isArray(initial.runs));
  const ticket = {
    workspaceId: "workspace-interop",
    ifRevision: initial.revision,
  };
  const cached = {
    runs: throughWire(initial.runs),
    revision: initial.revision,
    updatedAt: 1,
  };

  const currentRuns = [
    summary(boundaryId, {
      title: "Updated boundary conversation",
      model: "m".repeat(120),
      updatedAt: "2026-07-31T12:02:00.000Z",
    }),
    summary("run-a", { title: "A", lastMessage: "base" }),
    ...baseRuns.filter((run) => run.id.startsWith("run-stable-")),
    summary("run-new", {
      status: "blocked",
      recovery: {
        cause: "provider_unavailable",
        parkedAt: "2026-07-31T12:02:30.000Z",
      },
    }),
  ];
  const delta = throughWire(
    cache.project({
      workspaceId: "workspace-interop",
      runs: currentRuns,
      ifRevision: initial.revision,
      deltaVersion: 1,
    }),
  );
  assert.ok(delta.historyDelta, "a proportional update must use the delta shape");
  assert.ok(
    Buffer.byteLength(JSON.stringify(delta), "utf8") <
      Buffer.byteLength(
        JSON.stringify({ runs: currentRuns, revision: delta.revision }),
        "utf8",
      ),
    "Studio only sends a delta when it is strictly smaller than full",
  );

  const materialized = mobile.materializeCoraHistoryDelta(
    cached,
    ticket,
    delta,
  );
  assert.equal(materialized.ok, true);
  assert.deepEqual(
    materialized.response,
    { runs: currentRuns, revision: delta.revision },
    "mobile reconstructs Studio's reordered/upserted/removed projection exactly",
  );
  assert.deepEqual(
    cached.runs,
    baseRuns,
    "materialization cannot mutate the durable cached base",
  );

  const unchanged = throughWire(
    cache.project({
      workspaceId: "workspace-interop",
      runs: currentRuns,
      ifRevision: delta.revision,
      deltaVersion: 1,
    }),
  );
  assert.deepEqual(unchanged, {
    notModified: true,
    revision: delta.revision,
  });
  const unchangedResult = await mobile.resolveCoraHistoryDeltaWithRepair({
    cached: {
      runs: currentRuns,
      revision: delta.revision,
      updatedAt: 2,
    },
    ticket: {
      workspaceId: "workspace-interop",
      ifRevision: delta.revision,
    },
    response: unchanged,
    repair: async () => {
      throw new Error("valid not-modified must not repair");
    },
  });
  assert.equal(unchangedResult.repaired, false);

  // A Studio process restart loses only its optimization cache. It must return
  // a valid full projection, which the same mobile validator accepts directly.
  const restarted = new studio.CoraHistoryDeltaCache();
  const afterRestart = throughWire(
    restarted.project({
      workspaceId: "workspace-interop",
      runs: currentRuns,
      ifRevision: initial.revision,
      deltaVersion: 1,
    }),
  );
  assert.ok(Array.isArray(afterRestart.runs));
  const afterRestartResult =
    await mobile.resolveCoraHistoryDeltaWithRepair({
      cached,
      ticket,
      response: afterRestart,
      repair: async () => {
        throw new Error("Studio's full fallback must not repair");
      },
    });
  assert.equal(afterRestartResult.repaired, false);
  assert.deepEqual(afterRestartResult.response.runs, currentRuns);

  // A damaged in-flight delta gets one unconditional full repair and cannot
  // poison the cache or loop indefinitely.
  const poison = throughWire(delta);
  poison.historyDelta.order.push(poison.historyDelta.order[0]);
  let repairCount = 0;
  const repaired = await mobile.resolveCoraHistoryDeltaWithRepair({
    cached,
    ticket,
    response: poison,
    repair: async () => {
      repairCount += 1;
      return afterRestart;
    },
  });
  assert.equal(repairCount, 1);
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.response.runs, currentRuns);

  console.log("Studio/mobile Cora history interoperability tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
