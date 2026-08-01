#!/usr/bin/env node
"use strict";

// Guards the client/server deadline invariant for orchestrator long polls.
//
// The MCP client (resources/codara-studio-mcp/server.js) destroys the socket at
// ORCHESTRATION_TIMEOUT_MS; the main-process handlers (src/main/agent-socket.ts)
// hold the same socket open until their own long-poll deadline. When the two
// numbers were EQUAL - both exactly 20 min - a manager that requested the
// documented maximum wait raced its own transport and lost: the socket died a
// few ms before the server wrote `reason:"timeout"`, and the manager got
// `Codara agent socket unreachable: Codara agent socket timeout` instead. That
// happened three times in one hour of real use, and one of those recoveries was
// in flight when the manager's own turn cap fired and failed the whole run.
//
// So: every server long-poll bound must be <= the shared ceiling, and the
// client must abort strictly ABOVE that ceiling with room to serialize.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const serverPath = path.join(repoRoot, "resources", "codara-studio-mcp", "server.js");
const socketPath = path.join(repoRoot, "src", "main", "agent-socket.ts");
const serverSource = fs.readFileSync(serverPath, "utf8");
const socketSource = fs.readFileSync(socketPath, "utf8");

// Constants are plain arithmetic literals (`20 * 60 * 1000`, `60_000`). Read
// them out of the source rather than importing, so the test stays honest about
// what ships instead of re-deriving the value it wants to check.
function readConst(source, file, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(source);
  assert.ok(match, `${file} must declare ${name}`);
  const expr = match[1].trim();
  assert.match(
    expr,
    /^[\d_\s*+()-]+$|^[A-Z_]+\s*\+\s*[A-Z_]+$|^[A-Z_]+$/,
    `${name} in ${file} must stay a literal arithmetic expression this guard can evaluate (got: ${expr})`,
  );
  return expr;
}

function evaluate(source, file, name, seen = new Set()) {
  assert.ok(!seen.has(name), `${name} in ${file} is self-referential`);
  seen.add(name);
  const expr = readConst(source, file, name);
  const resolved = expr.replace(/[A-Z][A-Z0-9_]*/g, (ident) => String(evaluate(source, file, ident, seen)));
  assert.match(resolved, /^[\d_\s*+()-]+$/, `${name} in ${file} did not reduce to arithmetic (got: ${resolved})`);
  // eslint-disable-next-line no-new-func -- input is asserted to be arithmetic only
  const value = Function(`"use strict"; return (${resolved});`)();
  assert.ok(Number.isFinite(value) && value > 0, `${name} in ${file} must be a positive finite number`);
  return value;
}

const clientCeiling = evaluate(serverSource, "server.js", "ORCHESTRATION_LONG_POLL_CEILING_MS");
const clientMargin = evaluate(serverSource, "server.js", "ORCHESTRATION_RESPONSE_MARGIN_MS");
const clientAbort = evaluate(serverSource, "server.js", "ORCHESTRATION_TIMEOUT_MS");
const serverCeiling = evaluate(socketSource, "agent-socket.ts", "ORCHESTRATION_LONG_POLL_CEILING_MS");

// 1. Both sides agree on the ceiling.
assert.equal(
  serverCeiling,
  clientCeiling,
  "agent-socket.ts and server.js must share one ORCHESTRATION_LONG_POLL_CEILING_MS",
);

// 2. The client aborts strictly above it, with a real margin.
assert.ok(
  clientAbort > clientCeiling,
  `client abort (${clientAbort}ms) must exceed the long-poll ceiling (${clientCeiling}ms) - equal values are the dead heat this test exists to prevent`,
);
assert.equal(clientAbort, clientCeiling + clientMargin, "client abort must be ceiling + margin");
assert.ok(clientMargin >= 30_000, `response margin ${clientMargin}ms is too thin to serialize a wait response`);

// 3. Every server-side long-poll bound fits under the ceiling.
for (const name of [
  "ASK_USER_TIMEOUT_MS",
  "PLAN_APPROVAL_TIMEOUT_MS",
  "WAIT_FOR_WORKERS_DEFAULT_TIMEOUT_MS",
  "WAIT_FOR_WORKERS_MAX_TIMEOUT_MS",
  "AUTOMATION_WAIT_DEFAULT_TIMEOUT_MS",
  "AUTOMATION_WAIT_MAX_TIMEOUT_MS",
]) {
  const value = evaluate(socketSource, "agent-socket.ts", name);
  assert.ok(
    value <= serverCeiling,
    `${name} (${value}ms) must not exceed ORCHESTRATION_LONG_POLL_CEILING_MS (${serverCeiling}ms)`,
  );
}

// 4. The wait loop stops early enough to serialize its own timeout response.
const reserve = evaluate(socketSource, "agent-socket.ts", "WAIT_FOR_WORKERS_RESPONSE_RESERVE_MS");
assert.ok(reserve > 0, "WAIT_FOR_WORKERS_RESPONSE_RESERVE_MS must be positive");
assert.ok(reserve < clientMargin, "the server-side reserve should be smaller than the client's own margin");
assert.match(
  socketSource,
  /requestedTimeout\s*-\s*WAIT_FOR_WORKERS_RESPONSE_RESERVE_MS/,
  "the wait deadline must actually subtract WAIT_FOR_WORKERS_RESPONSE_RESERVE_MS",
);

// 5. Each documented cap the model reads must be the cap we enforce. The
//    descriptions live next to their tool name, so scope the search to the
//    right tool block rather than grabbing the first "Capped at" in the file.
function documentedCap(toolName) {
  const block = new RegExp(`name:\\s*"${toolName}"[\\s\\S]{0,4000}?Capped at (\\d+)\\s*\\((\\d+) min\\)`).exec(
    serverSource,
  );
  assert.ok(block, `${toolName} must document its cap`);
  const ms = Number(block[1]);
  assert.equal(Number(block[2]) * 60_000, ms, `${toolName}: documented minutes must match documented milliseconds`);
  return ms;
}

assert.equal(
  documentedCap("codara_wait_for_workers"),
  evaluate(socketSource, "agent-socket.ts", "WAIT_FOR_WORKERS_MAX_TIMEOUT_MS"),
  "the codara_wait_for_workers description advertises a cap the server does not enforce",
);
assert.equal(
  documentedCap("codara_wait_for_automation"),
  evaluate(socketSource, "agent-socket.ts", "AUTOMATION_WAIT_MAX_TIMEOUT_MS"),
  "the codara_wait_for_automation description advertises a cap the server does not enforce",
);

// 6. The graceful transport-timeout path covers exactly the RPCs that long-poll,
//    and each name is one the socket actually dispatches.
const longPollBlock = /const LONG_POLL_RPCS = new Set\(\[([\s\S]*?)\]\);/.exec(serverSource);
assert.ok(longPollBlock, "server.js must declare LONG_POLL_RPCS");
const longPollRpcs = [...longPollBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
assert.deepEqual(
  longPollRpcs,
  ["automation.wait", "orchestrator.ask_user", "orchestrator.wait_for_workers"],
  "LONG_POLL_RPCS must list every blocking orchestration RPC and nothing else",
);
for (const rpc of longPollRpcs) {
  assert.ok(
    socketSource.includes(`"${rpc}"`),
    `LONG_POLL_RPCS names ${rpc}, which agent-socket.ts does not dispatch`,
  );
}

// 7. A transport timeout on a long poll must NOT reach the model as a tool error.
assert.match(
  serverSource,
  /isLongPollRpc\(rpc\)\s*&&\s*isTransportTimeout\(err\)/,
  "the graceful transport-timeout branch must gate on both the RPC kind and the error kind",
);
assert.match(
  serverSource,
  /reason:\s*"transport_timeout"/,
  "a long-poll transport timeout must return a structured transport_timeout result",
);
assert.match(
  serverSource,
  /workers_unaffected:\s*true/,
  "the transport_timeout result must state plainly that the workers are unaffected",
);

console.log("orchestration timeout margin: OK");
console.log(
  `  ceiling ${clientCeiling / 60_000} min · client abort ${clientAbort / 60_000} min · margin ${clientMargin / 1000}s · server reserve ${reserve / 1000}s`,
);
