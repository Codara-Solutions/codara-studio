#!/usr/bin/env node
"use strict";

// The desktop command socket lets a desktop-wide Ctrl+T ask Studio for a new
// terminal tab without a key press. This covers the socket itself against a
// real unix socket: the one command it takes, what it answers, who can reach
// it, and how it treats a socket file already at its path. The path through
// the renderer is tests/e2e/desktop-new-terminal.spec.ts.
//
//   node scripts/test-desktop-command-socket.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");

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

const { startDesktopCommandSocket } = loadTypeScriptModule(
  path.join(ROOT, "src", "main", "desktop-command-socket.ts"),
);

function send(socketPath, parts, { closeAfter = false } = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let reply = "";
    client.setEncoding("utf8");
    client.on("connect", async () => {
      for (const part of parts) {
        client.write(part);
        await new Promise((done) => setTimeout(done, 5));
      }
      if (closeAfter) client.end();
    });
    client.on("data", (chunk) => {
      reply += chunk;
    });
    client.on("end", () => resolve(reply));
    client.on("close", () => resolve(reply));
    client.on("error", reject);
  });
}

function listenOn(socketPath) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end());
    server.listen(socketPath, () => resolve(server));
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-command-"));
  const socketPath = path.join(dir, "desktop-command.sock");
  try {
    let calls = 0;
    let outcome = async () => "opened";
    const socket = await startDesktopCommandSocket({
      socketPath,
      newTerminal: () => {
        calls += 1;
        return outcome();
      },
    });

    // Reachable by this user only.
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    assert.ok(fs.lstatSync(socketPath).isSocket());

    // The command, with each answer the renderer can give.
    assert.equal(await send(socketPath, ["new-terminal\n"]), "opened\n");
    assert.equal(calls, 1);
    outcome = async () => "ignored";
    assert.equal(await send(socketPath, ["new-terminal\n"]), "ignored\n");
    outcome = async () => "unavailable";
    assert.equal(await send(socketPath, ["new-terminal\n"]), "unavailable\n");
    outcome = async () => {
      throw new Error("renderer gone");
    };
    assert.equal(await send(socketPath, ["new-terminal\n"]), "unavailable\n");
    assert.equal(calls, 4);

    // A request split across writes is still the same request.
    outcome = async () => "opened";
    assert.equal(await send(socketPath, ["new-", "terminal", "\n"]), "opened\n");
    assert.equal(calls, 5);

    // Nothing else is accepted and nothing runs for it.
    for (const bad of [
      "\n",
      "NEW-TERMINAL\n",
      "new-terminal \n",
      "new-terminal\r\n",
      "open-file /etc/passwd\n",
      "new-terminal\nnew-terminal\n",
      '{"method":"new-terminal"}\n',
      "x".repeat(4096),
      "x".repeat(64),
    ]) {
      assert.equal(await send(socketPath, [bad]), "unknown-command\n", `refuses ${JSON.stringify(bad)}`);
    }
    assert.equal(calls, 5);

    // A caller that hangs up early runs nothing, and the socket keeps serving.
    assert.equal(await send(socketPath, ["new-term"], { closeAfter: true }), "");
    assert.equal(calls, 5);

    // A caller that stalls is dropped instead of holding a slot.
    assert.equal(
      await new Promise((resolve, reject) => {
        const client = net.createConnection(socketPath);
        client.on("close", () => resolve("dropped"));
        client.on("error", reject);
      }),
      "dropped",
    );

    // A pending answer is not lost to other callers, and each caller gets one.
    let release;
    outcome = () =>
      new Promise((resolve) => {
        release = () => resolve("opened");
      });
    const waiting = send(socketPath, ["new-terminal\n"]);
    while (!release) await new Promise((done) => setTimeout(done, 5));
    outcome = async () => "ignored";
    assert.equal(await send(socketPath, ["new-terminal\n"]), "ignored\n");
    release();
    assert.equal(await waiting, "opened\n");

    // A second Studio on this home must not take the socket from a live one.
    await assert.rejects(
      startDesktopCommandSocket({ socketPath, newTerminal: async () => "opened" }),
      /another Studio/,
    );
    assert.equal(await send(socketPath, ["new-terminal\n"]), "ignored\n");

    // Closing removes the file, so "not running" reads as ENOENT.
    await socket.close();
    assert.equal(fs.existsSync(socketPath), false);
    await assert.rejects(send(socketPath, ["new-terminal\n"]), { code: "ENOENT" });

    // A crash leaves a socket nobody answers on: it is replaced.
    const crashed = await listenOn(socketPath);
    const keepFile = `${socketPath}.keep`;
    fs.linkSync(socketPath, keepFile);
    await new Promise((done) => crashed.close(done));
    fs.renameSync(keepFile, socketPath);
    await assert.rejects(send(socketPath, ["new-terminal\n"]), { code: "ECONNREFUSED" });
    const replaced = await startDesktopCommandSocket({ socketPath, newTerminal: async () => "opened" });
    assert.equal(await send(socketPath, ["new-terminal\n"]), "opened\n");
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    await replaced.close();

    // A regular file at the path is not ours to delete.
    fs.writeFileSync(socketPath, "keep me");
    await assert.rejects(
      startDesktopCommandSocket({ socketPath, newTerminal: async () => "opened" }),
      /not a socket/,
    );
    assert.equal(fs.readFileSync(socketPath, "utf8"), "keep me");
    fs.rmSync(socketPath);

    // Past sun_path libuv would truncate the path and bind somewhere else.
    await assert.rejects(
      startDesktopCommandSocket({ socketPath: `/tmp/${"x".repeat(120)}`, newTerminal: async () => "opened" }),
      /too long/,
    );

    console.log("ok - desktop command socket");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
