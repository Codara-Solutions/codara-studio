#!/usr/bin/env node
"use strict";

// Regression tests for the worker/manager liveness policy
// (src/main/orchestration/agent-liveness.ts).
//
// Both policies are reconstructions of a real incident. The worker cases replay
// run-msamjw8y-tnthy2: a Codex 500 arrived mid-turn, Pi emitted auto_retry_start
// and then nothing, `agent_settled` never came, and the old wait sat silent for
// 16 minutes while the pane claimed "working". The manager cases replay the
// other half of the same run: a turn that had been orchestrating correctly for
// 90 minutes was killed by a flat wall-clock cap while it sat in a healthy
// codara_wait_for_workers.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

function loadTypeScriptModule(sourcePath) {
  const resolved = path.resolve(sourcePath);
  const source = fs.readFileSync(resolved, "utf8");
  const output = ts.transpileModule(source, {
    fileName: resolved,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(resolved, module);
  loaded.filename = resolved;
  loaded.paths = Module._nodeModulePaths(path.dirname(resolved));
  loaded._compile(output, resolved);
  return loaded.exports;
}

const liveness = loadTypeScriptModule(
  path.join(__dirname, "..", "src", "main", "orchestration", "agent-liveness.ts"),
);
const {
  classifyWorkerSilence,
  classifyTurnLiveness,
  isLongPollToolName,
  OBSERVED_HEALTHY_WORKER_GAP_MS,
  PI_WORKER_STALL_WARN_MS,
  PI_WORKER_PROVIDER_FAILURE_WARN_MS,
  PI_WORKER_PROVIDER_FAILURE_GRACE_MS,
  PI_WORKER_STALL_FAIL_MS,
  PI_TURN_IDLE_TIMEOUT_MS,
  PI_TURN_ABSOLUTE_CEILING_MS,
  PI_TOOL_RESULT_TIMEOUT_MS,
  PI_LONG_POLL_TRUST_MS,
} = liveness;

const MIN = 60_000;
const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}

const CODEX_500 =
  "Codex error: An error occurred while processing your request. You can retry your request, " +
  "or contact us through our help center at help.openai.com if the error persists.";

// ── Worker silence ────────────────────────────────────────────────────────

check("the generic warn clears the healthy envelope by a real margin", () => {
  // Regression on a live miss: this was originally set level with the widest
  // healthy gap on record and a perfectly healthy worker tripped it on the
  // first real run, mid-message. A warning that cries wolf gets ignored.
  assert.ok(
    PI_WORKER_STALL_WARN_MS >= OBSERVED_HEALTHY_WORKER_GAP_MS * 1.5,
    "the generic warn must sit well clear of normal worker behaviour, not level with it",
  );
  assert.ok(PI_WORKER_STALL_FAIL_MS > PI_WORKER_STALL_WARN_MS,
    "a silent worker must be SHOWN as stalled before it is failed");
  assert.ok(PI_WORKER_PROVIDER_FAILURE_GRACE_MS > PI_WORKER_PROVIDER_FAILURE_WARN_MS,
    "the same ordering must hold on the provider-failure path");
  assert.ok(PI_WORKER_PROVIDER_FAILURE_WARN_MS < PI_WORKER_STALL_WARN_MS,
    "a KNOWN provider error is evidence, so it must surface sooner than bare silence");
});

check("a busy worker is never disturbed", () => {
  // Includes the exact gap that produced the false positive: 5 min of silence
  // between message_update and message_end on a healthy worker.
  for (const gap of [0, 1_000, 60_000, 4 * MIN, 5 * MIN, 7 * MIN]) {
    const verdict = classifyWorkerSilence({
      silentForMs: gap,
      providerFailure: null,
      lastEventType: "message_update",
      alreadyWarned: false,
    });
    assert.equal(verdict.action, "continue", `${gap}ms of healthy silence must not act`);
  }
});

check("the incident's provider error is reported, then failed with its own text", () => {
  // t+0: the Codex 500 lands. auto_retry_start follows immediately, so the
  // silence clock starts from that last event, not from the error.
  const atWarn = classifyWorkerSilence({
    silentForMs: PI_WORKER_PROVIDER_FAILURE_WARN_MS,
    providerFailure: CODEX_500,
    lastEventType: "auto_retry_start",
    alreadyWarned: false,
  });
  assert.equal(atWarn.action, "warn", "post-error silence must surface as a stall promptly");
  assert.match(atWarn.detail, /Codex error/, "the stall note must carry the provider's own words");
  assert.match(atWarn.detail, /auto_retry_start/, "and name the last thing we heard");

  const atFail = classifyWorkerSilence({
    silentForMs: PI_WORKER_PROVIDER_FAILURE_GRACE_MS,
    providerFailure: CODEX_500,
    lastEventType: "auto_retry_start",
    alreadyWarned: true,
  });
  assert.equal(atFail.action, "fail");
  assert.match(atFail.detail, /Codex error/);
  assert.match(atFail.detail, /retry never produced a response/);
});

check("the whole incident resolves inside the window the old code needed", () => {
  // The real run went 16 minutes with nobody the wiser, and was only ended by
  // an unrelated manager cap. Every decision must now land well inside that.
  assert.ok(PI_WORKER_PROVIDER_FAILURE_WARN_MS < 16 * MIN);
  assert.ok(PI_WORKER_PROVIDER_FAILURE_GRACE_MS < 16 * MIN);
  assert.ok(PI_WORKER_STALL_WARN_MS < 16 * MIN);
});

check("silence with no diagnosis still terminates, just later", () => {
  const midway = classifyWorkerSilence({
    silentForMs: 10 * MIN,
    providerFailure: null,
    lastEventType: "message_update",
    alreadyWarned: true,
  });
  assert.equal(midway.action, "continue", "generic silence gets more rope than a known error");

  const dead = classifyWorkerSilence({
    silentForMs: PI_WORKER_STALL_FAIL_MS,
    providerFailure: null,
    lastEventType: "message_update",
    alreadyWarned: true,
  });
  assert.equal(dead.action, "fail");
  assert.match(dead.detail, /stalled/);
  assert.match(dead.detail, /20 min/);
});

check("a worker that never spoke at all is described honestly", () => {
  const verdict = classifyWorkerSilence({
    silentForMs: PI_WORKER_STALL_FAIL_MS,
    providerFailure: null,
    lastEventType: null,
    alreadyWarned: true,
  });
  assert.equal(verdict.action, "fail");
  assert.match(verdict.detail, /never sent one/);
});

check("the stall warning is edge-triggered, not repeated every poll", () => {
  const repeat = classifyWorkerSilence({
    silentForMs: PI_WORKER_STALL_WARN_MS + 30_000,
    providerFailure: null,
    lastEventType: "message_end",
    alreadyWarned: true,
  });
  assert.equal(repeat.action, "continue", "an already-reported stall must not re-announce itself");
});

check("a known provider error surfaces far sooner than bare silence", () => {
  // Same silence, different evidence: with a provider error in hand this is a
  // report, without one it is still a guess.
  const gap = PI_WORKER_PROVIDER_FAILURE_WARN_MS;
  const withError = classifyWorkerSilence({
    silentForMs: gap,
    providerFailure: CODEX_500,
    lastEventType: "auto_retry_start",
    alreadyWarned: false,
  });
  const withoutError = classifyWorkerSilence({
    silentForMs: gap,
    providerFailure: null,
    lastEventType: "auto_retry_start",
    alreadyWarned: false,
  });
  assert.equal(withError.action, "warn");
  assert.equal(withoutError.action, "continue");
});

// ── Manager turn liveness ─────────────────────────────────────────────────

const base = { startedAt: 0, lastEventAt: 0, inFlightTools: [] };

check("the exact turn the old 90-minute cap killed now survives", () => {
  // run-msamjw8y-tnthy2: the manager had been driving for 90 minutes and was
  // sitting in a healthy codara_wait_for_workers when the flat cap fired.
  const verdict = classifyTurnLiveness({
    ...base,
    now: 90 * MIN,
    lastEventAt: 88 * MIN,
    inFlightTools: [{ name: "codara_wait_for_workers", startedAt: 88 * MIN, longPoll: true }],
  });
  assert.equal(verdict.action, "continue", "a turn blocked on workers is waiting, not wedged");
});

check("a long orchestration turn with periodic activity is not capped by duration", () => {
  const verdict = classifyTurnLiveness({
    ...base,
    now: 3 * 60 * MIN,
    lastEventAt: 3 * 60 * MIN - 30_000,
  });
  assert.equal(verdict.action, "continue", "three hours of real work must not time out");
});

check("a genuinely quiet turn with no tool in flight fails", () => {
  const verdict = classifyTurnLiveness({
    ...base,
    now: PI_TURN_IDLE_TIMEOUT_MS,
    lastEventAt: 0,
  });
  assert.equal(verdict.action, "fail");
  assert.match(verdict.detail, /went quiet/);
  assert.match(verdict.detail, /no tool call in flight/);
});

check("a long poll cannot suppress the idle clock forever", () => {
  // The trust window must exceed the client's own 21-minute abort, so a healthy
  // maximum-length wait is never cut off...
  assert.ok(PI_LONG_POLL_TRUST_MS > 21 * MIN,
    "trust must outlast the MCP client's own abort or healthy waits would be killed");
  const healthy = classifyTurnLiveness({
    ...base,
    now: 21 * MIN,
    inFlightTools: [{ name: "codara_wait_for_workers", startedAt: 0, longPoll: true }],
  });
  assert.equal(healthy.action, "continue");

  // ...but a call still "in flight" past it has lost its tool_execution_end,
  // and must not disable the timeout for the rest of the turn.
  const wedged = classifyTurnLiveness({
    ...base,
    now: PI_LONG_POLL_TRUST_MS,
    inFlightTools: [{ name: "codara_wait_for_workers", startedAt: 0, longPoll: true }],
  });
  assert.equal(wedged.action, "fail");
  assert.match(wedged.detail, /stuck in codara_wait_for_workers/);
});

check("an unresolved normal tool is named accurately and bounded", () => {
  const healthy = classifyTurnLiveness({
    ...base,
    now: PI_TOOL_RESULT_TIMEOUT_MS - 1,
    inFlightTools: [{ name: "bash", startedAt: 0, longPoll: false }],
  });
  assert.equal(healthy.action, "continue");

  const wedged = classifyTurnLiveness({
    ...base,
    now: PI_TOOL_RESULT_TIMEOUT_MS,
    inFlightTools: [{ name: "bash", startedAt: 0, longPoll: false }],
  });
  assert.equal(wedged.action, "fail");
  assert.match(wedged.detail, /stuck in bash/);
  assert.match(wedged.detail, /with no result/);
  assert.doesNotMatch(wedged.detail, /no tool call in flight/);
});

check("one tool result does not clear another parallel in-flight tool", () => {
  const verdict = classifyTurnLiveness({
    ...base,
    now: PI_TOOL_RESULT_TIMEOUT_MS,
    inFlightTools: [
      { name: "completed-elsewhere", startedAt: PI_TOOL_RESULT_TIMEOUT_MS - MIN, longPoll: false },
      { name: "bash", startedAt: 0, longPoll: false },
    ],
  });
  assert.equal(verdict.action, "fail");
  assert.match(verdict.detail, /bash/);
});

check("the absolute ceiling still bounds everything, even mid-long-poll", () => {
  const verdict = classifyTurnLiveness({
    ...base,
    now: PI_TURN_ABSOLUTE_CEILING_MS,
    lastEventAt: PI_TURN_ABSOLUTE_CEILING_MS,
    inFlightTools: [{
      name: "codara_wait_for_workers",
      startedAt: PI_TURN_ABSOLUTE_CEILING_MS,
      longPoll: true,
    }],
  });
  assert.equal(verdict.action, "fail");
  assert.match(verdict.detail, /ceiling/);
});

check("long-poll tool names match bare and mcp-prefixed forms", () => {
  assert.equal(isLongPollToolName("codara_wait_for_workers"), true);
  assert.equal(isLongPollToolName("mcp__codara-studio__codara_wait_for_workers"), true);
  assert.equal(isLongPollToolName("codara_ask_user"), true);
  assert.equal(isLongPollToolName("codara_wait_for_automation"), true);
  // A non-blocking tool must NOT hold the idle clock open.
  assert.equal(isLongPollToolName("codara_spawn_workers"), false);
  assert.equal(isLongPollToolName("bash"), false);
  assert.equal(isLongPollToolName(undefined), false);
  assert.equal(isLongPollToolName(42), false);
});

for (const name of results) console.log(`PASS ${name}`);
console.log(`\n${results.length} agent liveness checks passed.`);
