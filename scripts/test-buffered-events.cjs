// Ad-hoc verification for the coalesced stream-event path in event-log.ts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = "/Users/etienne/Documents/Projects/Codara/codara-studio";
const EVENT_LOG = path.join(ROOT, "src", "main", "orchestration", "event-log.ts");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-buffered-events-"));

const sends = [];

const plugin = {
  name: "stubs",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron-stub", namespace: "stub" }));
    build.onResolve({ filter: /\/codara-home$/ }, () => ({ path: "codara-home-stub", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      if (args.path === "electron-stub") {
        return {
          contents:
            "export const BrowserWindow = { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (channel, payload) => globalThis.__sends.push([channel, payload]) } }] };",
          loader: "js",
        };
      }
      return { contents: `export const codaraHome = () => ${JSON.stringify(TMP_HOME)};`, loader: "js" };
    });
  },
};

async function load() {
  const out = await esbuild.build({
    stdin: { contents: `export * from ${JSON.stringify(EVENT_LOG)};`, resolveDir: ROOT, loader: "ts" },
    bundle: true, format: "cjs", platform: "node", write: false, plugins: [plugin], logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const input = (runId, type) => ({ workspaceId: "w1", runId, type, message: type });
const readJournal = (log, runId) =>
  fs.readFileSync(log.eventsPath(runId), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  globalThis.__sends = sends;
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed += 1; console.log(`  PASS ${name}`); };

  await test("buffered events coalesce into one append and one batch IPC send", async () => {
    const log = await load();
    sends.length = 0;
    for (let i = 0; i < 10; i += 1) log.appendBufferedEvent(input("coalesce", `chat.assistant_block.${i}`));
    // Nothing durable yet.
    assert.equal(fs.existsSync(log.eventsPath("coalesce")), false);
    await log.flushBufferedEvents("coalesce");
    const journal = readJournal(log, "coalesce");
    assert.deepEqual(journal.map((e) => e.sequence), Array.from({ length: 10 }, (_, i) => i + 1));
    assert.deepEqual(journal.map((e) => e.type), Array.from({ length: 10 }, (_, i) => `chat.assistant_block.${i}`));
    assert.deepEqual(sends.map(([c]) => c), ["orchestration:events-batch"]);
    assert.equal(sends[0][1].length, 10);
  });

  await test("the flush timer drains without an explicit flush", async () => {
    const log = await load();
    log.appendBufferedEvent(input("timer", "chat.assistant_block"));
    await sleep(120);
    assert.deepEqual(readJournal(log, "timer").map((e) => e.type), ["chat.assistant_block"]);
  });

  await test("an ordinary append flushes the buffer ahead of itself", async () => {
    const log = await load();
    sends.length = 0;
    log.appendBufferedEvent(input("order", "chat.assistant_block.a"));
    log.appendBufferedEvent(input("order", "chat.assistant_block.b"));
    const direct = await log.appendEvent(input("order", "chat.tool_use"));
    assert.equal(direct.sequence, 3);
    assert.deepEqual(readJournal(log, "order").map((e) => e.type), [
      "chat.assistant_block.a", "chat.assistant_block.b", "chat.tool_use",
    ]);
    // Batch of 2 first, then the single event on the legacy channel.
    assert.deepEqual(sends.map(([c]) => c), ["orchestration:events-batch", "orchestration:event"]);
  });

  await test("emission order survives an interleaved buffered/direct sequence", async () => {
    const log = await load();
    const expected = [];
    const inflight = [];
    for (let i = 0; i < 30; i += 1) {
      if (i % 7 === 3) {
        expected.push(`direct.${i}`);
        inflight.push(log.appendEvent(input("mixed", `direct.${i}`)));
      } else {
        expected.push(`stream.${i}`);
        log.appendBufferedEvent(input("mixed", `stream.${i}`));
      }
    }
    await Promise.all(inflight);
    await log.flushBufferedEvents("mixed");
    const journal = readJournal(log, "mixed");
    assert.deepEqual(journal.map((e) => e.type), expected);
    assert.deepEqual(journal.map((e) => e.sequence), expected.map((_, i) => i + 1));
  });

  await test("two concurrent runs keep independent per-run order", async () => {
    const log = await load();
    for (let i = 0; i < 8; i += 1) {
      log.appendBufferedEvent(input("run-a", `a.${i}`));
      log.appendBufferedEvent(input("run-b", `b.${i}`));
    }
    await log.flushBufferedEvents();
    assert.deepEqual(readJournal(log, "run-a").map((e) => e.type), Array.from({ length: 8 }, (_, i) => `a.${i}`));
    assert.deepEqual(readJournal(log, "run-b").map((e) => e.type), Array.from({ length: 8 }, (_, i) => `b.${i}`));
    assert.deepEqual(readJournal(log, "run-a").map((e) => e.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  await test("a burst past the ceiling drains without unbounded buffering", async () => {
    const log = await load();
    for (let i = 0; i < 600; i += 1) log.appendBufferedEvent(input("burst", `chat.assistant_block.${i}`));
    await log.flushBufferedEvents("burst");
    const journal = readJournal(log, "burst");
    assert.equal(journal.length, 600);
    assert.deepEqual(journal.map((e) => e.type), Array.from({ length: 600 }, (_, i) => `chat.assistant_block.${i}`));
    assert.deepEqual(journal.map((e) => e.sequence), Array.from({ length: 600 }, (_, i) => i + 1));
  });

  await test("broadcast order matches durable journal order", async () => {
    const log = await load();
    const observed = [];
    const unsub = log.subscribeToEvents((e) => observed.push(e.type));
    log.appendBufferedEvent(input("bcast", "s1"));
    log.appendBufferedEvent(input("bcast", "s2"));
    await log.appendEvent(input("bcast", "d1"));
    log.appendBufferedEvent(input("bcast", "s3"));
    await log.flushBufferedEvents("bcast");
    unsub();
    assert.deepEqual(observed, ["s1", "s2", "d1", "s3"]);
    assert.deepEqual(readJournal(log, "bcast").map((e) => e.type), observed);
  });

  await test("deleted-run cleanup cancels a buffered tail before it can recreate artifacts", async () => {
    const log = await load();
    log.appendBufferedEvent(input("deleted", "chat.assistant_block"));
    log.forgetRunEventState("deleted");
    await sleep(120);
    assert.equal(fs.existsSync(log.eventsPath("deleted")), false);
    const firstAfterReuse = await log.appendEvent(input("deleted", "run.created"));
    assert.equal(firstAfterReuse.sequence, 1);
  });

  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  console.log(`\nAll ${passed} buffered-event checks passed.`);
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  process.exit(1);
});
