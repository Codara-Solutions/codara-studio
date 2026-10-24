// Live output of a running tool in the Cora chat (Pi's bash: tests, builds).
//
//   node scripts/test-chat-tool-progress.cjs
//
// Pinned:
//   - The run store broadcasts chat.tool_progress without journaling it, under
//     one stable id per call, so each tail replaces the last. It reaches
//     windows only, and listeners that refetch runs on any event skip it.
//   - The projection attaches the newest tail to a call that has no result
//     yet and drops it once the result lands (the unsequenced progress event
//     sorts after the result).
//   - Only a row in the live turn shows the tail and an elapsed counter; a
//     settled turn's unfinished call does not tick.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

async function loadRecord() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/renderer/src/lib/useRunExecutionRecord.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    external: ["react"],
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

const event = (id, type, payload, sequence, timestamp = "2026-10-10T10:00:00.000Z") => ({
  id,
  type,
  timestamp,
  eventVersion: 1,
  workspaceId: "ws",
  runId: "run",
  sparkCallId: "call",
  ...(sequence ? { sequence } : {}),
  payload,
});

async function main() {
  const R = await loadRecord();
  const use = event("e1", "chat.tool_use", { toolUseId: "t1", toolName: "bash", input: { command: "npm test" } }, 1);
  const progress = (output, at) =>
    event("chat-tool-progress:call:t1", "chat.tool_progress", { toolUseId: "t1", output }, undefined, at);

  test("a running call carries the newest tail", () => {
    let events = R.mergeExecutionEvents([use], [progress("line 1", "2026-10-10T10:00:01.000Z")]);
    events = R.mergeExecutionEvents(events, [progress("line 1\nline 2", "2026-10-10T10:00:02.000Z")]);
    assert.equal(events.length, 2, "progress replaces itself by id");
    const [turn] = R.projectExecutionTurns(events);
    const tool = turn.blocks.find((block) => block.kind === "tool");
    assert.equal(tool.partialOutput, "line 1\nline 2");
    assert.equal(tool.output, undefined);
    assert.equal(turn.lastEventAt, "2026-10-10T10:00:02.000Z");
  });

  test("the result supersedes the tail", () => {
    const result = event("e2", "chat.tool_result", { toolUseId: "t1", output: "all passed" }, 2, "2026-10-10T10:00:03.000Z");
    const events = R.mergeExecutionEvents([use, result], [progress("stale tail", "2026-10-10T10:00:02.500Z")]);
    assert.equal(events.at(-1).type, "chat.tool_progress", "unsequenced events sort last");
    const [turn] = R.projectExecutionTurns(events);
    const tool = turn.blocks.find((block) => block.kind === "tool");
    assert.equal(tool.output, "all passed");
    assert.equal(tool.partialOutput, undefined);
  });

  test("progress for an unknown call adds no block", () => {
    const [turn] = R.projectExecutionTurns([use, event("p2", "chat.tool_progress", { toolUseId: "other", output: "x" })]);
    assert.equal(turn.blocks.length, 1);
  });

  test("main forwards tool_progress live-only", () => {
    const runStore = read("src/main/orchestration/run-store.ts");
    assert.match(
      runStore,
      /if \(event\.kind === "tool_progress"\) \{\s*broadcastLiveEvent\(\{ \.\.\.input, id: `chat-tool-progress:\$\{callId\}:\$\{event\.toolUseId\}` \}\);\s*return;\s*\}/,
    );
    const eventLog = read("src/main/orchestration/event-log.ts");
    // Windows only: main subscribers (phone invalidation, board pushes) track
    // journaled state, and a tail several times a second would make every
    // paired phone refetch an unchanged run.
    assert.match(eventLog, /export function broadcastLiveEvent\(input: AppendEventInput\): void \{\s*sendToWindows\(\[createEvent\(input\)\]\);\s*\}/);
    const backend = read("src/main/orchestration/agent-backend.ts");
    assert.match(backend, /kind: "tool_progress";\s*toolUseId: string;\s*output: string;/);
  });

  await (async () => {
    const out = await esbuild.build({
      entryPoints: [path.join(ROOT, "src/shared/live-events.ts")],
      bundle: true,
      format: "cjs",
      platform: "node",
      write: false,
      logLevel: "silent",
      tsconfig: path.join(ROOT, "tsconfig.node.json"),
    });
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
    const { isLiveOnlyEvent, leavesRunListUnchanged } = mod.exports;
    test("tool progress is live-only; journaled chat events are not", () => {
      assert.equal(isLiveOnlyEvent({ type: "chat.tool_progress" }), true);
      assert.equal(isLiveOnlyEvent({ type: "chat.tool_result" }), false);
      assert.equal(isLiveOnlyEvent({ type: "chat.assistant_block" }), false);
    });
    test("streamed text and live-only events leave the run list unchanged", () => {
      assert.equal(leavesRunListUnchanged({ type: "chat.tool_progress" }), true);
      assert.equal(leavesRunListUnchanged({ type: "chat.assistant_block" }), true);
      // Low-rate chat events still refresh: a tool call can launch a worker,
      // and a backend notice follows the turn's settle write.
      assert.equal(leavesRunListUnchanged({ type: "chat.tool_use" }), false);
      assert.equal(leavesRunListUnchanged({ type: "chat.tool_result" }), false);
      assert.equal(leavesRunListUnchanged({ type: "chat.backend_notice" }), false);
      assert.equal(leavesRunListUnchanged({ type: "run.status_updated" }), false);
    });
  })();

  test("run-list refreshers ignore live-only and streamed text events", () => {
    // Each of these refetches runs (or a run's detail) on any event; a long
    // command, or a streaming Cora reply, would otherwise re-list every run,
    // and re-render the app, once a second for as long as it prints.
    const globalRuns = read("src/renderer/src/lib/useGlobalRuns.ts");
    assert.match(globalRuns, /onEvent\(\(event\) => \{\s*if \(leavesRunListUnchanged\(event\)\) return;/);
    const app = read("src/renderer/src/App.tsx");
    assert.match(app, /if \(!event\.workspaceId \|\| leavesRunListUnchanged\(event\)\) return;/);
    const automations = read("src/renderer/src/components/automations/AutomationsPage.tsx");
    assert.match(automations, /event\.runId === liveRun\?\.id && !isLiveOnlyEvent\(event\)/);
  });

  test("only the live turn's running rows show output and elapsed time", () => {
    const conversation = read("src/renderer/src/components/chat/ChatConversation.tsx");
    assert.match(conversation, /const running = live && !finished;/);
    assert.match(conversation, /\{running && call\.partialOutput \? <LiveToolOutput text=\{call\.partialOutput\} \/> : null\}/);
    assert.match(conversation, /\{running && \(\s*<span style=\{TOOL_STATS_STYLE\}>\s*<ElapsedSince since=\{call\.at\} \/>/);
    assert.match(conversation, /<TurnSegments segments=\{segments\} live \/>/);
    assert.match(conversation, /<LiveToolRow call=\{segment\.call\} live=\{live\} \/>/);
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
