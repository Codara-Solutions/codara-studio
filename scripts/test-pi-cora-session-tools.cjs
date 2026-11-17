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

function waitResult(reason) {
  return { content: [{ type: "text", text: JSON.stringify({ reason, sessions: [] }) }] };
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
    { brief: "b", runtime: "codex", model: " ", effort: "high" },
    "Codex keeps its CLI's model but gets an effort",
  );
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
  assert.deepEqual(calls, [540, 540], "chunks never exceed Studio's per-call ceiling");

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
  assert.deepEqual(calls, [540, 540, 120], "capped at 1200 s in all");

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
  assert.deepEqual(calls, [540, 60], "the default wait is 600 s");

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
  assert.ok(
    sessions.SESSION_WAIT_MANAGER_MAX_SECONDS * 1000 < 30 * 60 * 1000,
    "the longest wait stays inside Pi's long-poll trust window",
  );

  // The manager extension uses both helpers on the bridge tools.
  const indexSource = fs.readFileSync(path.join(piCora, "index.ts"), "utf8");
  assert.match(indexSource, /codara_session_start" \? withSessionDefaults\(params\)/);
  assert.match(indexSource, /waitForSessionsInChunks\(/);
  assert.match(indexSource, /"codara_session_wait",\n  "codara_feedback_send"/, "Stop can walk away from a session wait");

  // python3 guard: only bare `python` at the start of a command segment.
  for (const command of [
    "python script.py",
    "cd src && python -m pytest",
    "FOO=1 python x.py",
    "env PYTHONPATH=. python x.py",
    "sudo python setup.py install",
    "ls | python -c 'print(1)'",
  ]) {
    assert.equal(python.runsBarePython(command), true, command);
  }
  for (const command of [
    "python3 script.py",
    "python3.12 -m venv .venv",
    "git commit -m \"fix; python x\"",
    "echo python",
    "pytest",
    "pip install python-dotenv",
    "/usr/bin/python x.py",
    ".venv/bin/python -m pytest",
    "cat <<'DOC'\npython x.py\nDOC",
    "python3 - <<EOF\npython = 'snake'\nprint(python)\nEOF",
    "cat <<-DOC\n\tpython x.py\n\tDOC",
  ]) {
    assert.equal(python.runsBarePython(command), false, command);
  }
  const missing = { hasPython: false, hasPython3: true };
  assert.equal(python.runsBarePython("cat <<DOC\ntext\nDOC\npython x.py"), true, "a command after the heredoc still counts");
  assert.equal(python.runsBarePython("cat <<< python && python x.py"), true, "a here-string is not a heredoc");
  const blocked = python.barePythonDecision("bash", { command: "python x.py" }, missing);
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /python3/);
  assert.equal(python.barePythonDecision("bash", { command: "python x.py" }, { hasPython: true, hasPython3: true }), undefined);
  assert.equal(python.barePythonDecision("bash", { command: "python x.py" }, { hasPython: false, hasPython3: false }), undefined, "no python3 either: nothing better to suggest");
  assert.equal(python.barePythonDecision("read", { path: "python" }, missing), undefined);

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
  for (const source of [indexSource, workerSource]) {
    assert.match(source, /barePythonDecision\(event\.toolName, event\.input, python\)/);
  }

  console.log("pi-cora session tools and python guard: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
