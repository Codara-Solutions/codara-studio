"use strict";
// `cora task` and `cora inbox add` (cli/commands/tasks.cjs): the real CLI
// against a fake agent socket. Checks each command reaches the right socket
// method with the caller identity an MCP call carries, repeated --done
// flags become the done-when list, and a refusal exits non-zero.
//
//   node scripts/test-cora-task-cli.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "cli", "cora.cjs");

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const TASK = {
  id: "T1",
  title: "Ship it",
  state: "verifying",
  doneWhen: ["typecheck passes"],
  evidence: [{ checkId: "types", ok: true, exitCode: 0, artifact: "/v/types.log" }],
};

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cora-task-cli-"));
  const token = "b".repeat(64);
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      calls.push({ method, params });
      const reply = (payload) => res.end(JSON.stringify({ jsonrpc: "2.0", id, ...payload }));
      if (method === "task.update" && params.state === "done") {
        return reply({ error: { code: -32602, message: "Only the verify gate closes a task." } });
      }
      if (method === "task.list") {
        return reply({
          result: {
            line: "1 running · 1 in inbox",
            tasks: [TASK],
            inbox: [{ id: "I1", text: "Look at CI\nmore" }],
            tasksFile: "/home/x/.codarastudio/cos/ws/TASKS.md",
          },
        });
      }
      if (method === "inbox.add") return reply({ result: { item: { id: "I2" }, line: "2 in inbox" } });
      return reply({ result: { task: TASK, line: "1 running", note: "The verify gate is running." } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "agent-socket.json"), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token }));
  const env = { PATH: process.env.PATH, HOME: home, CODARA_HOME_DIR: home, SPARK_PANE_ID: "pane-3" };
  try {
    const list = await run(["task", "list"], env);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(calls.at(-1).method, "task.list");
    assert.equal(calls.at(-1).params.callerPaneId, "pane-3", "the call is placed by the pane it runs in");
    assert.match(list.stdout, /^1 running · 1 in inbox\nT1   verifying  Ship it\n     pass types \(exit 0\)  \/v\/types\.log\nI1   inbox      Look at CI\n/);

    const add = await run(["task", "add", "Ship", "it", "--done", "typecheck passes", "--done", "unit suite passes", "--state", "ready"], env);
    assert.equal(add.code, 0, add.stderr);
    assert.equal(calls.at(-1).method, "task.add");
    assert.equal(calls.at(-1).params.title, "Ship it");
    assert.deepEqual(calls.at(-1).params.done_when, ["typecheck passes", "unit suite passes"]);
    assert.equal(calls.at(-1).params.state, "ready");

    const missing = await run(["task", "add", "No proof"], env);
    assert.equal(missing.code, 2, "a task without --done is refused before any call");

    const move = await run(["task", "move", "T1", "needs_you", "Pick", "the", "price."], env);
    assert.equal(move.code, 0, move.stderr);
    assert.deepEqual(
      { id: calls.at(-1).params.id, state: calls.at(-1).params.state, reason: calls.at(-1).params.reason },
      { id: "T1", state: "needs_you", reason: "Pick the price." },
    );

    const refused = await run(["task", "move", "T1", "done"], env);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Only the verify gate closes a task/);

    const worktree = await run(["task", "worktree", "T1", "claude", "rel/dir", "--branch", "cora/x"], env);
    assert.equal(worktree.code, 0, worktree.stderr);
    assert.deepEqual(calls.at(-1).params.assignee, { cli: "claude", worktree: path.resolve("rel/dir"), branch: "cora/x" });

    const filed = await run(["inbox", "add", "CI", "is", "red", "--link", "https://ci.test/1"], env);
    assert.equal(filed.code, 0, filed.stderr);
    assert.equal(calls.at(-1).method, "inbox.add");
    assert.deepEqual({ text: calls.at(-1).params.text, link: calls.at(-1).params.link }, { text: "CI is red", link: "https://ci.test/1" });
    assert.match(filed.stdout, /^I2 filed\n2 in inbox\n$/);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log("cora task cli: all passed");
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
