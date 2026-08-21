// Focused executable coverage for the durable orchestration event journal.
// Bundles the real event-log.ts with headless Electron/codara-home stubs, then
// exercises concurrent appends, atomic batches, restart high-water recovery,
// legacy synthetic sequences, and persist-before-broadcast ordering.
//
//   node scripts/test-lifecycle-events.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const EVENT_LOG = path.join(ROOT, "src", "main", "orchestration", "event-log.ts");
const RUN_LIFECYCLE = path.join(ROOT, "src", "main", "orchestration", "run-lifecycle.ts");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-lifecycle-events-"));

const plugin = {
  name: "lifecycle-event-test-stubs",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^electron$/ }, () => ({
      path: "electron-stub",
      namespace: "stub",
    }));
    build.onResolve({ filter: /\/codara-home$/ }, () => ({
      path: "codara-home-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      if (args.path === "electron-stub") {
        return {
          contents: "export const BrowserWindow = { getAllWindows: () => [] };",
          loader: "js",
        };
      }
      return {
        contents: `export const codaraHome = () => ${JSON.stringify(TMP_HOME)};`,
        loader: "js",
      };
    });
  },
};

async function loadFreshEventLog() {
  const out = await esbuild.build({
    stdin: {
      contents:
        `export * from ${JSON.stringify(EVENT_LOG)};\n` +
        `export * from ${JSON.stringify(RUN_LIFECYCLE)};`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    plugins: [plugin],
    logLevel: "silent",
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

function input(runId, type, extra = {}) {
  return {
    workspaceId: "workspace-1",
    runId,
    type,
    message: type,
    ...extra,
  };
}

async function main() {
  let passed = 0;
  const test = async (name, fn) => {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  await test("concurrent appends persist and broadcast in one monotonic order", async () => {
    const log = await loadFreshEventLog();
    const observed = [];
    let broadcastSawDurableLine = true;
    const unsubscribe = log.subscribeToEvents((event) => {
      const raw = fs.readFileSync(log.eventsPath(event.runId), "utf8");
      if (!raw.includes(`\"id\":\"${event.id}\"`)) broadcastSawDurableLine = false;
      observed.push(event.sequence);
    });
    const events = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        log.appendEvent(input("concurrent", `domain.${index}`)),
      ),
    );
    unsubscribe();

    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 24 }, (_, i) => i + 1));
    assert.deepEqual(observed, Array.from({ length: 24 }, (_, i) => i + 1));
    assert.equal(broadcastSawDurableLine, true);
    const persisted = fs
      .readFileSync(log.eventsPath("concurrent"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(persisted.map((event) => event.sequence), Array.from({ length: 24 }, (_, i) => i + 1));
    assert.ok(persisted.every((event) => event.eventVersion === 1));
  });

  await test("domain and lifecycle batch stays adjacent to its cause", async () => {
    const log = await loadFreshEventLog();
    const batch = await log.appendEvents([
      input("batch", "run.resumed", { id: "evt-domain" }),
      input("batch", "run.status_updated", {
        id: "evt-status",
        payload: { previousStatus: "paused", status: "running", causeEventId: "evt-domain" },
      }),
    ]);
    const trailing = await log.appendEvent(input("batch", "worker.started"));
    assert.deepEqual(batch.map((event) => event.sequence), [1, 2]);
    assert.equal(trailing.sequence, 3);
    assert.equal(batch[1].payload.causeEventId, batch[0].id);
  });

  await test("fresh process continues after the persisted high-water mark", async () => {
    const first = await loadFreshEventLog();
    await first.appendEvent(input("restart", "one"));
    await first.appendEvent(input("restart", "two"));
    const second = await loadFreshEventLog();
    const resumed = await second.appendEvent(input("restart", "three"));
    assert.equal(resumed.sequence, 3);
  });

  await test("legacy lines get deterministic in-memory sequence without rewrite", async () => {
    const log = await loadFreshEventLog();
    fs.mkdirSync(log.runDir("legacy"), { recursive: true });
    const legacyOne = input("legacy", "legacy.one", {
      id: "legacy-1",
      timestamp: "2026-07-13T00:00:00.000Z",
    });
    const legacyTwo = input("legacy", "legacy.two", {
      id: "legacy-2",
      timestamp: "2026-07-13T00:00:02.000Z",
    });
    const original = `${JSON.stringify(legacyOne)}\nnot-json\n${JSON.stringify(legacyTwo)}\n`;
    fs.writeFileSync(log.eventsPath("legacy"), original, "utf8");

    const listed = await log.listEvents("legacy");
    assert.deepEqual(listed.map((event) => event.sequence), [1, 3]);
    assert.equal(fs.readFileSync(log.eventsPath("legacy"), "utf8"), original);

    const fresh = await loadFreshEventLog();
    const appended = await fresh.appendEvent(input("legacy", "current"));
    assert.equal(appended.sequence, 4);
  });

  await test("canonical transition helper emits once with causal and blocker metadata", async () => {
    const lifecycle = await loadFreshEventLog();
    const baseRun = {
      id: "run-status",
      workspaceId: "workspace-1",
      title: "Lifecycle",
      status: "blocked",
      automationId: "automation-1",
      artifactDir: "/tmp/run-status",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:01.000Z",
      plans: [],
      steps: [],
      workerTasks: [],
      workerAttempts: [],
      sparkCalls: [],
      humanMessages: [],
      blockedOn: {
        questionMessageId: "question-1",
        category: "credentials_access",
        previousStatus: "running",
        resumeStatus: "running",
        source: "manager_decision",
        resumeStrategy: "schedule_manager",
        blockedAt: "2026-07-13T00:00:01.000Z",
      },
    };
    const event = lifecycle.buildRunStatusTransitionEvent({
      run: baseRun,
      previousStatus: "running",
      timestamp: "2026-07-13T00:00:01.000Z",
      causeType: "run.question_posted",
      causeEventId: "evt-cause",
      causeMessage: "Credentials required",
      eventId: "evt-status",
    });
    assert.ok(event);
    assert.equal(event.type, "run.status_updated");
    assert.equal(event.payload.previousStatus, "running");
    assert.equal(event.payload.status, "blocked");
    assert.equal(event.payload.causeEventId, "evt-cause");
    assert.equal(event.payload.automationId, "automation-1");
    assert.equal(event.payload.questionMessageId, "question-1");
    assert.equal(event.payload.blocker.category, "credentials_access");

    assert.equal(
      lifecycle.buildRunStatusTransitionEvent({
        run: { ...baseRun, status: "running", blockedOn: undefined },
        previousStatus: "running",
        timestamp: "2026-07-13T00:00:02.000Z",
        causeType: "run.status_change_requested",
        causeEventId: "evt-noop-cause",
        causeMessage: "Still running",
        eventId: "evt-noop",
      }),
      null,
    );
  });

  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  console.log(`\nAll ${passed} lifecycle-event checks passed.`);
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  process.exit(1);
});
