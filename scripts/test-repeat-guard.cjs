// Executable coverage for the Pi worker repeated-tool-call guard
// (resources/pi-cora/repeat-guard.ts): warn at the third identical call, refuse
// the fifth, never punish progress, polling tools, or widely spaced repeats.
//
//   node scripts/test-repeat-guard.cjs
//
// Exits non-zero on any failed assertion.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

const {
  createRepeatedCallGuard,
  callSignature,
  resultFingerprint,
  POLLING_TOOLS,
} = loadTypeScriptModule(path.join(__dirname, "..", "resources", "pi-cora", "repeat-guard.ts"));

let callId = 0;

// Runs one full call cycle (tool_call then tool_result) and returns both halves.
function call(guard, toolName, input, result = "same output", isError = false) {
  callId += 1;
  const toolCallId = `call-${callId}`;
  const decision = guard.observeCall({ toolCallId, toolName, input });
  if (decision.action === "block") return { decision, outcome: null };
  const outcome = guard.observeResult({
    toolCallId,
    content: [{ type: "text", text: result }],
    isError,
  });
  return { decision, outcome };
}

// 1. The documented ladder: allow, allow, note, note, block.
{
  const guard = createRepeatedCallGuard();
  const actions = [];
  const notes = [];
  for (let i = 0; i < 6; i += 1) {
    const { decision, outcome } = call(guard, "bash", { command: "npm run build" });
    actions.push(decision.action);
    notes.push(outcome?.note ?? null);
  }
  assert.deepEqual(actions, ["allow", "allow", "note", "note", "block", "block"]);
  assert.equal(notes[0], null);
  assert.equal(notes[1], null);
  assert.match(notes[2], /Cora loop guard/);
  assert.match(notes[2], /3 times with identical arguments/);
  assert.match(notes[2], /change approach/i);
  assert.match(notes[2], /number 5 will be refused/);
  // The refusal has to read as an error the model must act on, not as advice.
  const refusal = guard.observeCall({ toolCallId: "call-refused", toolName: "bash", input: { command: "npm run build" } });
  assert.equal(refusal.action, "block");
  assert.match(refusal.message, /refused this call/);
  assert.match(refusal.message, /loop, not progress/);
}

// 2. Argument key order is incidental, and a different argument is a different
//    call that starts its own streak.
{
  const guard = createRepeatedCallGuard();
  assert.equal(
    callSignature("edit", { path: "a.ts", text: "x" }),
    callSignature("edit", { text: "x", path: "a.ts" }),
  );
  assert.notEqual(callSignature("edit", { path: "a.ts" }), callSignature("edit", { path: "b.ts" }));
  assert.notEqual(callSignature("edit", { path: "a.ts" }), callSignature("read", { path: "a.ts" }));

  for (let i = 0; i < 4; i += 1) call(guard, "grep", { pattern: "TODO", nested: { a: 1, b: [1, 2] } });
  const reordered = call(guard, "grep", { nested: { b: [1, 2], a: 1 }, pattern: "TODO" });
  assert.equal(reordered.decision.action, "block");
  const different = call(guard, "grep", { pattern: "FIXME" });
  assert.equal(different.decision.action, "allow");
  assert.equal(different.decision.count, 1);
}

// 3. Progress resets the streak: the same test command whose output keeps
//    changing is a fix loop, not a stuck loop, and must never be refused.
{
  const guard = createRepeatedCallGuard();
  const args = { command: "npm test" };
  for (let i = 0; i < 12; i += 1) {
    const { decision } = call(guard, "bash", args, `run ${i}: ${i} failing`);
    assert.equal(decision.action, "allow", `changing output must stay allowed (iteration ${i})`);
  }
  // An unchanged result from here still walks the ladder.
  const ladder = [];
  for (let i = 0; i < 5; i += 1) ladder.push(call(guard, "bash", args, "frozen output").decision.action);
  assert.deepEqual(ladder, ["allow", "allow", "note", "note", "block"]);
}

// 4. Errors count as outcomes too: five identical failing calls are refused.
{
  const guard = createRepeatedCallGuard();
  const actions = [];
  for (let i = 0; i < 5; i += 1) {
    actions.push(call(guard, "read", { path: "/nope.ts" }, "ENOENT", true).decision.action);
  }
  assert.deepEqual(actions, ["allow", "allow", "note", "note", "block"]);
  // Same text but a different isError flag is a different outcome.
  assert.notEqual(resultFingerprint([{ type: "text", text: "x" }], true), resultFingerprint([{ type: "text", text: "x" }], false));
  assert.equal(resultFingerprint([{ type: "text", text: "x" }]), resultFingerprint([{ type: "text", text: "x" }], false));
}

// 5. Repeats separated by enough other work are forgotten, so revisiting a file
//    later in the session is free.
{
  const guard = createRepeatedCallGuard({ forgetAfterOtherCalls: 3 });
  call(guard, "read", { path: "run-store.ts" });
  call(guard, "read", { path: "run-store.ts" });
  assert.equal(guard.countFor("read", { path: "run-store.ts" }), 2);
  for (let i = 0; i < 4; i += 1) call(guard, "bash", { command: `echo ${i}` });
  const revisit = call(guard, "read", { path: "run-store.ts" });
  assert.equal(revisit.decision.action, "allow");
  assert.equal(revisit.decision.count, 1);
}

// 6. A refused call must NOT re-open the ladder. Its refusal text is not a real
//    result, so it can never become the signature's new fingerprint.
{
  const guard = createRepeatedCallGuard();
  const args = { command: "git status" };
  for (let i = 0; i < 5; i += 1) call(guard, "bash", args);
  for (let i = 0; i < 6; i += 1) {
    const { decision } = call(guard, "bash", args);
    assert.equal(decision.action, "block", `hammering a refused call stays refused (iteration ${i})`);
  }
  // The counter is capped so a stuck model cannot inflate it without bound.
  assert.ok(guard.countFor("bash", args) <= 6, `count stayed bounded: ${guard.countFor("bash", args)}`);
  // Doing other work long enough clears the block: the guard is a nudge, not a
  // permanent ban.
  for (let i = 0; i < 13; i += 1) call(guard, "read", { path: `file-${i}.ts` });
  assert.equal(call(guard, "bash", args).decision.action, "allow");
}

// 7. Polling and observation tools are exempt: waiting means calling the same
//    thing with the same arguments until the world changes.
{
  const guard = createRepeatedCallGuard();
  for (const toolName of POLLING_TOOLS) {
    for (let i = 0; i < 8; i += 1) {
      const { decision } = call(guard, toolName, { paneId: "pane-1" });
      assert.equal(decision.action, "allow", `${toolName} must never be blocked`);
      assert.equal(decision.count, 0);
    }
    assert.equal(guard.countFor(toolName, { paneId: "pane-1" }), 0);
  }
  assert.ok(POLLING_TOOLS.includes("codara_terminal_read"));
  assert.ok(POLLING_TOOLS.includes("peer_await"));
}

// 8. Thresholds are configurable and self-consistent, and a result reported for
//    an unknown call id is ignored rather than throwing.
{
  const guard = createRepeatedCallGuard({ noteThreshold: 2, blockThreshold: 3 });
  const actions = [];
  for (let i = 0; i < 3; i += 1) actions.push(call(guard, "write", { path: "x.ts" }).decision.action);
  assert.deepEqual(actions, ["allow", "note", "block"]);
  assert.equal(guard.observeResult({ toolCallId: "never-seen", content: [], isError: false }), null);
  // A blockThreshold at or below the note threshold is coerced upward instead
  // of producing a guard that refuses the call it was only meant to warn about.
  const coerced = createRepeatedCallGuard({ noteThreshold: 4, blockThreshold: 2 });
  const coercedActions = [];
  for (let i = 0; i < 5; i += 1) coercedActions.push(call(coerced, "write", { path: "y.ts" }).decision.action);
  assert.deepEqual(coercedActions, ["allow", "allow", "allow", "note", "block"]);
}

// 9. Undefined, null, and empty inputs are signable and stay distinct.
{
  const guard = createRepeatedCallGuard();
  assert.notEqual(callSignature("t", undefined), callSignature("t", null));
  assert.notEqual(callSignature("t", {}), callSignature("t", undefined));
  const actions = [];
  for (let i = 0; i < 5; i += 1) actions.push(call(guard, "ls", undefined).decision.action);
  assert.deepEqual(actions, ["allow", "allow", "note", "note", "block"]);
}

// 10. Wiring: the real worker extension must hang the guard off Pi's tool_call
//     and tool_result hooks, veto the fifth identical call, and deliver the
//     change-approach note on the third call's own result.
async function checkWorkerExtensionWiring() {
  const os = require("node:os");
  const esbuild = require("esbuild");
  const { pathToFileURL } = require("node:url");

  const root = path.join(__dirname, "..");
  const workerPath = path.join(root, "resources", "pi-cora", "worker.ts");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cora-repeat-guard-"));
  const bridgePath = path.join(tmp, "bridge.cjs");
  fs.writeFileSync(
    bridgePath,
    "module.exports = { listTools: () => [], callToolByName: async () => ({ content: [] }) };",
    "utf8",
  );
  const outfile = path.join(tmp, "worker.cjs");
  await esbuild.build({
    entryPoints: [workerPath],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    define: { "import.meta.url": JSON.stringify(pathToFileURL(workerPath).href) },
    logLevel: "silent",
  });

  const previousBridge = process.env.CODARA_PI_BRIDGE_PATH;
  process.env.CODARA_PI_BRIDGE_PATH = bridgePath;
  const handlers = new Map();
  const pi = {
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: () => undefined,
  };
  try {
    const loaded = require(outfile);
    (loaded.default ?? loaded)(pi);
  } finally {
    if (previousBridge === undefined) delete process.env.CODARA_PI_BRIDGE_PATH;
    else process.env.CODARA_PI_BRIDGE_PATH = previousBridge;
  }

  // worker.ts layers several tool_call policies (browser-only access, the
  // optional tool fence, the repeat guard). Drive them like Pi does: every
  // handler sees the call in registration order and the first veto wins; a
  // bash call passes the access policies untouched, so the repeat guard's
  // decisions are what surface.
  const onToolCall = handlers.get("tool_call");
  const onToolResult = handlers.get("tool_result");
  assert.ok(onToolCall && onToolCall.length >= 1, "worker.ts must register a tool_call handler");
  assert.ok(onToolResult && onToolResult.length === 1, "worker.ts must register exactly one tool_result handler");

  const results = [];
  for (let i = 0; i < 5; i += 1) {
    const toolCallId = `wire-${i}`;
    const input = { command: "npm run typecheck" };
    let blocked;
    for (const handler of onToolCall) {
      blocked = await handler({ type: "tool_call", toolCallId, toolName: "bash", input });
      if (blocked && blocked.block) break;
    }
    if (blocked && blocked.block) {
      results.push({ blocked: true, reason: blocked.reason });
      continue;
    }
    const content = [{ type: "text", text: "unchanged failure" }];
    const patched = await onToolResult[0]({
      type: "tool_result",
      toolCallId,
      toolName: "bash",
      input,
      content,
      isError: true,
    });
    results.push({ blocked: false, patched });
  }

  assert.equal(results[0].patched, undefined, "a first call is left alone");
  assert.equal(results[1].patched, undefined, "a second call is left alone");
  assert.ok(results[2].patched, "the third identical call carries a note");
  assert.equal(results[2].patched.content.length, 2, "the note is appended, the tool output is preserved");
  assert.equal(results[2].patched.content[0].text, "unchanged failure");
  assert.match(results[2].patched.content[1].text, /Cora loop guard/);
  assert.equal(results[4].blocked, true, "the fifth identical call is refused");
  assert.match(results[4].reason, /refused this call/);

  // The worker contract has to tell the model the rule exists before it trips.
  const workerSource = fs.readFileSync(workerPath, "utf8");
  assert.match(workerSource, /createRepeatedCallGuard\(\)/);
  assert.match(workerSource, /loop, not persistence/);
}

checkWorkerExtensionWiring()
  .then(() => {
    console.log("pi worker repeated-call guard: ok");
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
