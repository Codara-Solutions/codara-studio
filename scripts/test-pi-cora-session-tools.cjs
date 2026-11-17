#!/usr/bin/env node
"use strict";

// Cora's manager-side helpers for agent sessions and the python3 guard
// (resources/pi-cora/session-tools.ts, python-guard.ts), loaded outside Pi.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded.require = (id) => {
    const sibling = id.startsWith("./") ? path.join(path.dirname(sourcePath), `${id}.ts`) : null;
    if (sibling && fs.existsSync(sibling)) return loadTypeScriptModule(sibling);
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

const piCora = path.join(__dirname, "..", "resources", "pi-cora");
const sessions = loadTypeScriptModule(path.join(piCora, "session-tools.ts"));
const python = loadTypeScriptModule(path.join(piCora, "python-guard.ts"));

function waitResult(reason, statuses = []) {
  return { content: [{ type: "text", text: JSON.stringify({ reason, sessions: statuses.map((status, i) => ({ id: `as-${i}`, status })) }) }] };
}

(async () => {
  // Every session the manager starts runs with a model and an effort.
  assert.deepEqual(
    sessions.withSessionDefaults({ brief: "b", runtime: "claude" }),
    { brief: "b", runtime: "claude", model: "opus", effort: "high" },
  );
  assert.deepEqual(
    sessions.withSessionDefaults({ brief: "b", runtime: "claude", model: "sonnet", effort: "low" }),
    { brief: "b", runtime: "claude", model: "sonnet", effort: "low" },
    "the manager's own choice wins",
  );
  assert.deepEqual(
    sessions.withSessionDefaults({ brief: "b", runtime: "codex", model: " " }),
    { brief: "b", runtime: "codex", effort: "high" },
    "a blank model is dropped: Codex keeps its CLI's model and gets an effort",
  );
  assert.deepEqual(
    sessions.withSessionDefaults({ brief: "b", runtime: "claude", model: "  " }),
    { brief: "b", runtime: "claude", model: "opus", effort: "high" },
  );

  // A session model goes through the user's allowlist; the top tier needs the
  // user to have named it in this chat.
  const allowed = ["claude-opus-5", "gpt-5.6-sol"];
  const refusal = (model, userNamedTopTier = false, list = allowed) =>
    sessions.sessionModelRefusal({ runtime: "claude", model }, { allowed: list, userNamedTopTier });
  assert.equal(refusal("opus"), null, "an alias of an enabled model");
  assert.equal(refusal("claude-opus-5"), null);
  assert.equal(refusal("gpt-5.6-sol@high"), null);
  assert.match(refusal("sonnet"), /not enabled\. Use one of: claude-opus-5, gpt-5\.6-sol/);
  assert.match(refusal("fable"), /top tier, used only when the user asks for it by name/);
  assert.match(refusal("claude-fable-5"), /top tier/);
  assert.equal(refusal("fable", true), null, "the user asked for it");
  assert.match(refusal("fable", false, null), /top tier/, "also when the list is unknown");
  assert.equal(refusal("sonnet", false, null), null);
  assert.equal(sessions.namesTopTier("use fable for this one"), true);
  assert.equal(sessions.namesTopTier("a fabled bug"), false);

  // The manager's wait schema states its own default and maximum.
  const schema = sessions.managerSessionWaitSchema({ type: "object", properties: { ids: {}, timeoutSeconds: { type: "number", description: "Default 120, max 540." } } });
  assert.equal(schema.properties.timeoutSeconds.description, "Default 300, max 1200.");
  assert.equal(schema.properties.timeoutSeconds.type, "number");
  assert.deepEqual(sessions.managerSessionWaitSchema({ type: "object" }), { type: "object" });
  assert.deepEqual(sessions.withSessionDefaults({ brief: "b" }), { brief: "b" }, "an invalid call reaches Studio unchanged");

  // One wait loops in Studio-sized chunks until a session settles.
  let clock = 0;
  const calls = [];
  const settled = await sessions.waitForSessionsInChunks(
    async (args) => {
      calls.push(args.timeoutSeconds);
      clock += args.timeoutSeconds * 1000;
      return calls.length < 2 ? waitResult("timeout") : waitResult("any_settled");
    },
    { ids: ["as-1"], timeoutSeconds: 1200 },
    { now: () => clock },
  );
  assert.equal(sessions.sessionWaitReason(settled), "any_settled");
  assert.deepEqual(calls, [30, 30], "short chunks, so an early end is noticed quickly");

  // The total honors the requested timeout and the manager's maximum.
  clock = 0;
  calls.length = 0;
  const timedOut = await sessions.waitForSessionsInChunks(
    async (args) => {
      calls.push(args.timeoutSeconds);
      clock += args.timeoutSeconds * 1000;
      return waitResult("timeout");
    },
    { ids: ["as-1"], timeoutSeconds: 5000 },
    { now: () => clock },
  );
  assert.equal(sessions.sessionWaitReason(timedOut), "timeout");
  assert.equal(calls.reduce((a, b) => a + b, 0), 1200, "capped at 1200 s in all");
  assert.ok(calls.every((seconds) => seconds <= 30));

  clock = 0;
  calls.length = 0;
  await sessions.waitForSessionsInChunks(
    async (args) => {
      calls.push(args.timeoutSeconds);
      clock += args.timeoutSeconds * 1000;
      return waitResult("timeout");
    },
    { ids: ["as-1"] },
    { now: () => clock },
  );
  assert.equal(calls.reduce((a, b) => a + b, 0), 300, "the default wait is 300 s");

  // In "all" mode a session that needs the user, or failed, ends the wait.
  for (const status of ["needs_you", "failed"]) {
    clock = 0;
    calls.length = 0;
    const early = await sessions.waitForSessionsInChunks(
      async (args) => {
        calls.push(args.timeoutSeconds);
        clock += args.timeoutSeconds * 1000;
        return waitResult("timeout", ["working", calls.length < 2 ? "working" : status]);
      },
      { ids: ["as-0", "as-1"], mode: "all", timeoutSeconds: 1200 },
      { now: () => clock },
    );
    assert.equal(calls.length, 2, status);
    assert.match(early.content[0].text, new RegExp(status));
  }

  // A message the user queued ends the wait, so it is not held for 20 minutes.
  clock = 0;
  calls.length = 0;
  let pending = false;
  const interrupted = await sessions.waitForSessionsInChunks(
    async (args) => {
      calls.push(args.timeoutSeconds);
      clock += args.timeoutSeconds * 1000;
      pending = calls.length >= 3;
      return waitResult("timeout", ["working"]);
    },
    { ids: ["as-0"], timeoutSeconds: 1200 },
    { now: () => clock, hasPendingMessages: () => pending },
  );
  assert.equal(calls.length, 3);
  assert.match(interrupted.content.at(-1).text, /the user sent a message/);

  // An error or an abort ends the loop at once.
  clock = 0;
  calls.length = 0;
  const failed = await sessions.waitForSessionsInChunks(
    async (args) => {
      calls.push(args.timeoutSeconds);
      return { isError: true, content: [{ type: "text", text: "no such session" }] };
    },
    { ids: ["as-x"], timeoutSeconds: 1200 },
    { now: () => clock },
  );
  assert.equal(failed.isError, true);
  assert.equal(calls.length, 1);
  const controller = new AbortController();
  calls.length = 0;
  await sessions.waitForSessionsInChunks(
    async (args) => {
      calls.push(args.timeoutSeconds);
      controller.abort();
      return waitResult("timeout");
    },
    { ids: ["as-1"], timeoutSeconds: 1200 },
    { now: () => clock, signal: controller.signal },
  );
  assert.equal(calls.length, 1, "Stop ends the wait");
  const liveness = loadTypeScriptModule(path.join(__dirname, "..", "src", "main", "orchestration", "agent-liveness.ts"));
  assert.ok(
    sessions.SESSION_WAIT_MANAGER_MAX_SECONDS * 1000 < liveness.PI_LONG_POLL_TRUST_MS,
    "the longest wait stays inside Pi's long-poll trust window",
  );

  // The manager extension uses both helpers on the bridge tools.
  const indexSource = fs.readFileSync(path.join(piCora, "index.ts"), "utf8");
  assert.match(indexSource, /codara_session_start" \? withSessionDefaults\(params\)/);
  assert.match(indexSource, /sessionModelRefusal\(args, \{\s*allowed: modelIdList\(process\.env\.CODARA_PI_WORKER_MODELS\),\s*userNamedTopTier,/);
  assert.match(indexSource, /hasPendingMessages: \(\) => ctx\?\.hasPendingMessages\?\.\(\) === true/);
  assert.match(indexSource, /waitForSessionsInChunks\(/);
  assert.match(indexSource, /"codara_session_wait",\n  "codara_feedback_send"/, "Stop can walk away from a session wait");

  // python3 hint: added to a bash result whose shell could not find a bare
  // `python`, only on a machine that has python3 and no python.
  const missing = { hasPython: false, hasPython3: true };
  const out = (text) => ({ toolName: "bash", isError: true, content: [{ type: "text", text }] });
  for (const text of [
    "bash: line 1: python: command not found\n\nCommand exited with code 127",
    "/bin/sh: 1: python: not found",
    "zsh: command not found: python",
    "sh: python: command not found",
    "env: 'python': No such file or directory",
  ]) {
    const hinted = python.barePythonHint(out(text), missing);
    assert.ok(hinted, text);
    assert.equal(hinted.content.at(-1).text, python.PYTHON3_HINT);
    assert.equal(hinted.content[0].text, text, "the shell's own output stays");
  }
  for (const text of [
    "bash: python3: command not found",
    "zsh: command not found: python3.12",
    "ok",
    "ModuleNotFoundError: No module named 'python'",
    "pip: python-dotenv: not found in index",
  ]) {
    assert.equal(python.barePythonHint(out(text), missing), undefined, text);
  }
  const notFound = out("bash: python: command not found");
  assert.equal(python.barePythonHint(notFound, { hasPython: true, hasPython3: true }), undefined);
  assert.equal(python.barePythonHint(notFound, { hasPython: false, hasPython3: false }), undefined, "no python3 either: nothing better to suggest");
  assert.equal(python.barePythonHint({ ...notFound, toolName: "read" }, missing), undefined);
  assert.equal(python.barePythonHint({ ...notFound, isError: false }, missing), undefined, "a successful call that printed the text");
  assert.match(python.PYTHON3_HINT, /Rerun only the python step/);

  // PATH lookup.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-python-guard-"));
  try {
    fs.writeFileSync(path.join(dir, "python3"), "");
    assert.deepEqual(python.pythonAvailability({ PATH: dir }), { hasPython: false, hasPython3: true });
    fs.writeFileSync(path.join(dir, "python"), "");
    assert.deepEqual(python.pythonAvailability({ PATH: dir }), { hasPython: true, hasPython3: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const workerSource = fs.readFileSync(path.join(piCora, "worker.ts"), "utf8");
  assert.match(indexSource, /pi\.on\("tool_result", \(event\) => barePythonHint\(event, python\)\);/);
  assert.match(workerSource, /const hinted = barePythonHint\(event, python\);/, "the worker's one tool_result handler adds it");
  for (const source of [indexSource, workerSource]) {
    assert.doesNotMatch(source, /barePythonDecision/, "nothing is refused on a guess");
  }

  console.log("pi-cora session tools and python guard: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
