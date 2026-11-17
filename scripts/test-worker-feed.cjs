// A worker's feed (src/shared/worker-feed.ts and its writer,
// src/main/orchestration/worker-feed.ts): records bounded on the way in,
// appended to feed.jsonl in order, pushed to the renderer, kept under the cap
// by dropping the oldest, and read back the same after a restart.
//
//   node scripts/test-worker-feed.cjs

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

const electronStub = {
  name: "electron-stub",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const BrowserWindow = { getAllWindows: () => [] };",
      loader: "js",
    }));
  },
};
const sharedAlias = {
  name: "shared-alias",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

let failures = 0;
function check(name, condition, detail) {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition || detail === undefined ? "" : ` - ${detail}`}`);
}

async function load(dir, entry, name) {
  const outfile = path.join(dir, name);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [electronStub, sharedAlias],
  });
  return require(outfile);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-worker-feed-"));
  const shared = await load(dir, path.join(ROOT, "src", "shared", "worker-feed.ts"), "shared.cjs");
  const main = await load(dir, path.join(ROOT, "src", "main", "orchestration", "worker-feed.ts"), "main.cjs");
  const { WORKER_FEED_LIMITS: LIMITS } = shared;

  // ── bounds ──
  const input = shared.boundToolInput({
    path: "src/a.ts",
    oldText: "x".repeat(LIMITS.inputStringChars + 500),
    list: Array.from({ length: LIMITS.inputArrayItems + 5 }, (_, i) => i),
    deep: { a: { b: { c: { d: { e: { f: 1 } } } } } },
  });
  check("tool input keeps short strings as they are", input.path === "src/a.ts");
  check("tool input caps long strings", input.oldText.length === LIMITS.inputStringChars && input.oldText.endsWith("…"));
  check("tool input caps arrays and says how many more", input.list.length === LIMITS.inputArrayItems + 1 && input.list.at(-1) === "… 5 more");
  check("tool input caps nesting", JSON.stringify(input.deep).includes('"…"'));
  const huge = shared.boundToolInput({ files: Array.from({ length: 40 }, () => "y".repeat(3_000)) });
  const hugeSize = typeof huge === "string" ? huge.length : JSON.stringify(huge).length;
  check("tool input past its JSON budget is cut harder", hugeSize <= LIMITS.inputJsonChars, hugeSize);
  const output = shared.boundToolOutput(`HEAD${"m".repeat(20_000)}TAIL-ERROR`);
  check("tool output keeps its head and its tail", output.startsWith("HEAD") && output.endsWith("TAIL-ERROR") && /characters not kept/.test(output));
  check("short tool output is untouched", shared.boundToolOutput("ok\n") === "ok\n");

  // ── parse, merge, fold ──
  const at = "2026-11-17T10:00:00.000Z";
  const lines = [
    JSON.stringify({ k: "tool", id: "r1", at, call: "c1", name: "read", input: { path: "a.ts" } }),
    "not json",
    JSON.stringify({ k: "bogus", id: "x", at }),
    JSON.stringify({ k: "result", id: "r2", at, call: "c1", output: "contents" }),
    JSON.stringify({ k: "result", id: "r3", at, call: "gone", output: "orphan" }),
    JSON.stringify({ k: "text", id: "t1", at, text: "Found it." }),
    JSON.stringify({ k: "tool", id: "r4", at, call: "c2", name: "bash", input: { command: "npm test" } }),
    '{"k":"text","id":"t2","at":"' + at + '","te',
  ].join("\n");
  const parsed = shared.parseWorkerFeed(lines);
  check("parse skips torn, foreign and unknown lines", parsed.length === 5, parsed.length);
  const merged = shared.mergeWorkerFeedRecords(parsed, [parsed[0], { k: "steer", id: "s1", at, text: "use pnpm", from: "user" }]);
  check("merge appends only records it has not seen", merged.length === 6 && merged.at(-1).k === "steer");
  const entries = shared.foldWorkerFeed({ records: merged, partial: { id: "t3", text: "Running the" } });
  check(
    "fold pairs each call with its result, drops orphans and ends with the streaming message",
    JSON.stringify(entries.map((entry) => entry.kind)) === JSON.stringify(["tool", "text", "tool", "steer", "text"]) &&
      entries[0].output === "contents" &&
      entries[2].output === undefined &&
      entries[4].streaming === true,
    JSON.stringify(entries),
  );
  const settled = shared.foldWorkerFeed({
    records: [{ k: "text", id: "t3", at, text: "Running the tests." }],
    partial: { id: "t3", text: "Running the" },
  });
  check("a partial that already settled is not drawn twice", settled.length === 1 && !settled[0].streaming);
  const repeated = shared.foldWorkerFeed({
    records: [
      { k: "tool", id: "a", at, call: "call_0", name: "read" },
      { k: "result", id: "b", at, call: "call_0", output: "first" },
      { k: "tool", id: "c", at, call: "call_0", name: "edit" },
      { k: "result", id: "d", at, call: "call_0", output: "second" },
    ],
    partial: null,
  });
  check(
    "a provider that repeats one call id still gets each result on its own call",
    repeated.length === 2 && repeated[0].output === "first" && repeated[1].output === "second",
    JSON.stringify(repeated),
  );
  check("an input whose getter throws is dropped, not thrown", shared.boundToolInput({ get bad() { throw new Error("x"); } }) === undefined);

  // ── the writer ──
  const feedPath = path.join(dir, "feed.jsonl");
  fs.writeFileSync(feedPath, "left over from an earlier launch\n");
  fs.writeFileSync(`${feedPath}.99999.tmp`, "left by a crash between write and rename\n");
  const sent = [];
  let clock = Date.parse(at);
  const writer = main.createWorkerFeedWriter({
    runId: "run-1",
    attemptId: "attempt-1",
    path: feedPath,
    publish: (update) => sent.push(update),
    partialIntervalMs: 0,
    now: () => new Date((clock += 1000)),
  });
  check("a new session's feed is live", main.liveWorkerFeedSnapshot("attempt-1")?.live === true);
  check("a new session tells the renderer to read again", sent[0]?.reset === true);
  writer.textDelta("Let me ");
  writer.textDelta("look.");
  check(
    "a streaming message is pushed as a partial, not stored",
    sent.at(-1).partial?.text === "Let me look." && writer.snapshot().records.length === 0,
  );
  writer.tool("call-1", "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
  check("a tool call ends the streaming message as one text record", writer.snapshot().records[0].text === "Let me look.");
  check("ending the message clears the partial", sent.some((update) => update.partial === null));
  writer.result("call-1", "Edited src/a.ts", false);
  writer.tool(undefined, undefined, undefined);
  writer.result("call-1", "duplicate result", true);
  writer.steer("  Also update the docs.  ", "user");
  writer.steer("   ", "user");
  writer.note("Provider retry…", "info");
  writer.textDelta("z".repeat(LIMITS.textChars + 100));
  writer.endMessage();
  const live = main.liveWorkerFeedSnapshot("attempt-1");
  check(
    "records come out in order with their kinds",
    JSON.stringify(live.records.map((record) => record.k)) ===
      JSON.stringify(["text", "tool", "result", "tool", "result", "steer", "note", "text"]),
    JSON.stringify(live.records.map((record) => record.k)),
  );
  check("a call without a provider id or name still gets an id and a name", Boolean(live.records[3].id) && live.records[3].call === undefined && live.records[3].name === "tool");
  check("every record id is unique and carries the session", new Set(live.records.map((record) => record.id)).size === live.records.length && live.records.every((record) => /^[a-z0-9]+-[a-z0-9]+$/.test(record.id)));
  check("a steer is trimmed and a blank one dropped", live.records[5].text === "Also update the docs." && live.records[5].from === "user");
  check("a message past the cap is clipped", live.records[7].text.length === LIMITS.textChars);
  check("every record is pushed with its run and attempt", sent.filter((update) => update.records).every((update) => update.runId === "run-1" && update.attemptId === "attempt-1"));
  await writer.close();
  writer.note("after close", "info");
  check("a closed feed leaves the live set", main.liveWorkerFeedSnapshot("attempt-1") === null);
  check("closing pushes that the session ended", sent.at(-1).ended === true);
  const reread = await main.readWorkerFeedFile(feedPath);
  check(
    "the file holds the same records after a restart, and nothing from the earlier launch",
    JSON.stringify(reread) === JSON.stringify(live.records),
    `${reread?.length} vs ${live.records.length}`,
  );
  check("a feed that was never written reads as null", (await main.readWorkerFeedFile(path.join(dir, "none.jsonl"))) === null);
  check("a temp file left by a crash is removed", !fs.existsSync(`${feedPath}.99999.tmp`));
  const relaunch = main.createWorkerFeedWriter({ runId: "run-1", attemptId: "attempt-1", path: feedPath, publish: () => {}, now: () => new Date((clock += 1000)) });
  relaunch.note("second session", "info");
  const relaunchId = relaunch.snapshot().records[0].id;
  await relaunch.close();
  check("a relaunch of the same attempt never reuses an id of the session before", live.records.every((record) => record.id !== relaunchId));

  // ── the cap ──
  const cappedPath = path.join(dir, "capped.jsonl");
  const cappedSent = [];
  const capped = main.createWorkerFeedWriter({
    runId: "run-1",
    attemptId: "attempt-2",
    path: cappedPath,
    publish: (update) => cappedSent.push(update),
    maxBytes: 4_000,
  });
  for (let i = 0; i < 60; i += 1) capped.note(`step ${i} ${"n".repeat(80)}`, "info");
  capped.tool("call-x", "read", { path: "x" });
  capped.result("call-x", "r", false);
  await capped.close();
  const cappedRecords = await main.readWorkerFeedFile(cappedPath);
  const size = fs.statSync(cappedPath).size;
  check("a feed past its cap stays under it", size <= 4_000, size);
  check("the dropped records are counted first", cappedRecords[0].k === "elided" && cappedRecords.filter((record) => record.k === "elided").length === 1);
  check(
    "the newest records are the ones kept, and the count is in steps (a result belongs to its call)",
    cappedRecords.at(-1).k === "result" &&
      cappedRecords[0].count + cappedRecords.filter((record) => record.k !== "elided" && record.k !== "result").length === 61,
    `${cappedRecords[0].count} + ${cappedRecords.length - 1}`,
  );
  check("a rewrite tells the renderer to read again", cappedSent.some((update) => update.reset === true));
  check("the rewrite leaves no temp file", fs.readdirSync(dir).every((name) => !name.endsWith(".tmp")));
  const hugePath = path.join(dir, "huge.jsonl");
  const huge1 = main.createWorkerFeedWriter({ runId: "run-1", attemptId: "attempt-3", path: hugePath, publish: () => {}, maxBytes: 2_000 });
  huge1.note("small", "info");
  huge1.steer("w".repeat(3_000), "user");
  const hugeRecords = huge1.snapshot().records;
  await huge1.close();
  check("a record larger than the cap is still kept as the newest", hugeRecords.at(-1)?.k === "steer", JSON.stringify(hugeRecords.map((record) => record.k)));

  if (process.platform !== "win32") {
    const outside = path.join(dir, "outside.txt");
    fs.writeFileSync(outside, "the user's file\n");
    const linked = path.join(dir, "linked.jsonl");
    fs.symlinkSync(outside, linked);
    const planted = main.createWorkerFeedWriter({ runId: "run-1", attemptId: "attempt-4", path: linked, publish: () => {} });
    planted.note("written by the feed", "info");
    await planted.close();
    check(
      "a link planted at the feed's path is replaced, never written through",
      fs.readFileSync(outside, "utf8") === "the user's file\n" && !fs.lstatSync(linked).isSymbolicLink(),
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nworker feed: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
