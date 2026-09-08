"use strict";
const assert = require("node:assert/strict");
const rpcPath = require.resolve("../cli/lib/rpc.cjs");
const requests = [];
require.cache[rpcPath] = { id: rpcPath, filename: rpcPath, loaded: true, exports: {
  rpcRaw: async (_flags, method) => {
    requests.push(method);
    return { result: { status: "blocked" } };
  },
  rpc: async () => { throw new Error("A one-shot evaluator must not answer for the user"); },
} };
const { driveToCompletion } = require("../cli/commands/bench.cjs");
(async () => {
  const outcome = await driveToCompletion({}, "run", Date.now() + 1000);
  assert.deepEqual(outcome, { status: "blocked", questionsAsked: 1 });
  assert.deepEqual(requests, ["chat.wait"]);
  console.log("blocked benchmarks terminate without manufacturing input");
})().catch((error) => { console.error(error); process.exitCode = 1; });
