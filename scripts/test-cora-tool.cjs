"use strict";
// `cora tool` (cli/commands/tool.cjs): an agent without MCP calls the same
// codara-studio tools from its shell. Runs the real CLI against a fake agent
// socket and checks the call carries the pane identity an MCP call would,
// images become files, errors exit non-zero, and arguments parse as JSON.
//
//   node scripts/test-cora-tool.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "cli", "cora.cjs");
const { parseToolArgs, renderResult, fullName } = require(path.join(ROOT, "cli", "commands", "tool.cjs"));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function run(args, env, command = "tool") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, command, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

(async () => {
  // Argument parsing.
  assert.deepEqual(parseToolArgs(["preview_click", '{"selector":"@e1"}', "--timeoutMs", "500", "--force"]).args, { selector: "@e1", timeoutMs: 500, force: true });
  assert.deepEqual(parseToolArgs(["x", "--text=hello world", "--clip", '{"x":1}']).args, { text: "hello world", clip: { x: 1 } });
  assert.equal(parseToolArgs(["x", "--json"]).own.json, true);
  assert.throws(() => parseToolArgs(["x", "not-json"]), /JSON object/);
  assert.equal(fullName("preview_snapshot"), "codara_preview_snapshot");
  assert.equal(fullName("codara_terminal_run"), "codara_terminal_run");

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cora-tool-out-"));
  const lines = renderResult({ content: [{ type: "image", mimeType: "image/jpeg", data: PNG.toString("base64") }, { type: "text", text: '{"url":"x"}' }] }, { outDir: out, now: 0 });
  assert.match(lines[0], /^image: .*\.jpg$/);
  assert.deepEqual(fs.readFileSync(lines[0].slice("image: ".length)), PNG);
  assert.deepEqual(
    renderResult({ content: [{ type: "image", mimeType: "image/png", data: "AA==" }, { type: "text", text: '{"path":"/saved.png"}' }] }, { outDir: out }),
    ['{"path":"/saved.png"}'],
    "an image the result already saved is not written twice",
  );
  assert.deepEqual(
    renderResult({ isError: true, content: [{ type: "text", text: "Uncaught Error: hi\x1b]52;c;ZXZpbA==\x07\r\n\x9b2J done" }] }, { outDir: out }),
    ["Uncaught Error: hi]52;c;ZXZpbA==\n2J done"],
    "page text in a result cannot act on the terminal printing it",
  );
  fs.rmSync(out, { recursive: true, force: true });

  // The real CLI against a fake Codara.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cora-tool-home-"));
  const token = "a".repeat(64);
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const { id, method, params } = JSON.parse(body);
      calls.push({ method, params });
      const reply = (payload) => res.end(JSON.stringify({ jsonrpc: "2.0", id, ...payload }));
      if (method === "preview.screenshot") return reply({ result: { dataUrl: `data:image/png;base64,${PNG.toString("base64")}`, url: "http://localhost:3000/", tabId: "tab-1" } });
      if (method === "preview.click") return reply({ error: { code: -32602, message: "No element matches \"@e9\". Take a new snapshot." } });
      return reply({ result: { ok: true, echo: params } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "agent-socket.json"), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token }));
  const env = { PATH: process.env.PATH, HOME: home, CODARA_HOME_DIR: home, SPARK_PANE_ID: "pane-7" };
  try {
    const shot = await run(["preview_screenshot", "--tabId", "tab-1"], env);
    assert.equal(shot.code, 0, shot.stderr);
    const image = /^image: (.+)$/m.exec(shot.stdout)?.[1];
    assert.ok(image && image.startsWith(path.join(home, "tool-output")), shot.stdout);
    assert.deepEqual(fs.readFileSync(image), PNG);
    assert.match(shot.stdout, /"url":"http:\/\/localhost:3000\/"/);
    const call = calls.at(-1);
    assert.equal(call.method, "preview.screenshot");
    assert.equal(call.params.tabId, "tab-1");
    assert.equal(call.params.callerPaneId, "pane-7", "the pane identity an MCP call would carry");
    assert.equal(typeof call.params.callerPid, "number");

    const failed = await run(["codara_preview_click", '{"selector":"@e9"}'], env);
    assert.equal(failed.code, 1, "a failed tool exits 1");
    assert.match(failed.stdout, /No element matches/);

    const inbox = await run(["preview_inbox", "--peek", "--json"], env);
    assert.equal(inbox.code, 0, inbox.stderr);
    assert.deepEqual(calls.at(-1).params.peek, true);
    assert.equal(JSON.parse(inbox.stdout).content[0].type, "text");

    // `cora inbox` and `cora inspect` are the same calls under short names.
    const pulled = await run(["--peek", "--limit", "3", "--json"], env, "inbox");
    assert.equal(pulled.code, 0, pulled.stderr);
    assert.equal(calls.at(-1).method, "preview.inbox");
    assert.equal(calls.at(-1).params.peek, true);
    assert.equal(calls.at(-1).params.limit, 3);
    const described = await run(["#cta", "--tabId", "tab-2"], env, "inspect");
    assert.equal(described.code, 0, described.stderr);
    assert.equal(calls.at(-1).method, "preview.inspect");
    assert.equal(calls.at(-1).params.ref, "#cta");
    assert.equal(calls.at(-1).params.tabId, "tab-2");
    await run(["--x", "12", "--y", "40"], env, "inspect");
    assert.equal(calls.at(-1).params.x, 12);
    assert.equal(calls.at(-1).params.y, 40);
    const bare = await run([], env, "inspect");
    assert.equal(bare.code, 2);
    assert.match(bare.stderr, /usage: cora inspect/);

    const unknown = await run(["preview_teleport"], env);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown tool: codara_preview_teleport/);

    const listed = await run(["list", "--json"], env);
    const names = JSON.parse(listed.stdout).map((tool) => tool.name);
    const expected = require("node:child_process").execFileSync(
      process.execPath,
      ["-e", `console.log(JSON.stringify(require(${JSON.stringify(path.join(ROOT, "resources", "codara-studio-mcp", "server.js"))}).listTools().map((tool) => tool.name)))`],
      { env, encoding: "utf8" },
    );
    assert.deepEqual(names, JSON.parse(expected), "the same roster an MCP client in this terminal gets");
    assert.ok(names.includes("codara_preview_snapshot") && names.includes("codara_terminal_run"));
    console.log(`cora tool: ${names.length} tools, pane identity, images as files, exit codes`);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
