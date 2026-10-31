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

const { parseOpenPathRequest, startDesktopCommandSocket } = loadTypeScriptModule(
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
    const opened = [];
    let openOutcome = async () => "opened";
    const socket = await startDesktopCommandSocket({
      socketPath,
      newTerminal: () => {
        calls += 1;
        return outcome();
      },
      openPath: (target) => {
        opened.push(target);
        return openOutcome();
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

    // open-path: the path arrives whole, spaces and accents included, in one
    // write or several, and each answer reaches the caller.
    const spaced = "/home/e/Documents/Codara SL/Año nuevo/plan final.md";
    assert.equal(await send(socketPath, [`open-path ${spaced}\n`]), "opened\n");
    assert.equal(await send(socketPath, ["open-pa", "th /home/", "e/x\n"]), "opened\n");
    assert.deepEqual(opened, [spaced, "/home/e/x"]);
    opened.length = 0;
    assert.equal(await send(socketPath, ["open-path /home/e/folder/\n"]), "opened\n");
    assert.deepEqual(opened, ["/home/e/folder"], "trailing slash dropped");
    opened.length = 0;
    for (const reply of ["ignored", "not-found", "not-text", "too-large", "not-allowed", "no-workspace", "timeout", "unavailable"]) {
      openOutcome = async () => reply;
      assert.equal(await send(socketPath, ["open-path /x\n"]), `${reply}\n`);
    }
    openOutcome = async () => {
      throw new Error("renderer gone");
    };
    assert.equal(await send(socketPath, ["open-path /x\n"]), "unavailable\n");
    openOutcome = async () => "opened";
    opened.length = 0;

    // The longest path allowed passes; one byte more is refused at once.
    const longest = `/${"x".repeat(4095)}`;
    assert.equal(await send(socketPath, [`open-path ${longest}\n`]), "opened\n");
    assert.deepEqual(opened, [longest]);
    opened.length = 0;
    assert.equal(await send(socketPath, [`open-path /${"x".repeat(4096)}\n`]), "invalid-path\n");
    assert.equal(await send(socketPath, [`open-path /${"x".repeat(9000)}`]), "invalid-path\n", "no newline, too long");

    // Bad input is refused before anything looks at the disk.
    for (const bad of [
      "open-path \n",
      "open-path relative/file\n",
      "open-path ./file\n",
      "open-path ~/file\n",
      "open-path ~\n",
      "open-path /a/../etc/passwd\n",
      "open-path /a/./b\n",
      "open-path /a/..\n",
      "open-path /a\tb\n",
      "open-path /a\rb\n",
      "open-path /a\r\n",
      "open-path /a\u0000b\n",
      "open-path /a\u007fb\n",
      "open-path /a\nnew-terminal\n",
      "open-path /a\n\n",
      "open-path /a\nopen-path /b\n",
      Buffer.concat([Buffer.from("open-path /a"), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]),
      Buffer.concat([Buffer.from("open-path /a"), Buffer.from([0xc0, 0xaf]), Buffer.from("\n")]),
    ]) {
      assert.equal(await send(socketPath, [bad]), "invalid-path\n", `refuses ${JSON.stringify(String(bad))}`);
    }
    assert.deepEqual(opened, []);

    // Near misses of the command are not the command.
    for (const bad of ["open-path\n", "OPEN-PATH /a\n", "open-path\t/a\n", " open-path /a\n", "open-paths /a\n"]) {
      assert.equal(await send(socketPath, [bad]), "unknown-command\n", `refuses ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(opened, []);
    assert.equal(calls, 5, "open-path never opens a terminal");

    // A caller that stops halfway through a path is dropped, and nothing runs.
    assert.equal(await send(socketPath, ["open-path /half"], { closeAfter: true }), "");
    assert.deepEqual(opened, []);

    // The answer may take longer than a stalled caller is given.
    openOutcome = () => new Promise((resolve) => setTimeout(() => resolve("opened"), 1_300));
    assert.equal(await send(socketPath, ["open-path /slow\n"]), "opened\n");
    openOutcome = async () => "opened";
    opened.length = 0;

    const parsed = (text) => parseOpenPathRequest(Buffer.from(text));
    assert.equal(parsed("open-path /\n"), "/");
    assert.equal(parsed("open-path //\n"), "/");
    assert.equal(parsed("open-path /a b/ñ\n"), "/a b/ñ");
    assert.equal(parsed("open-path /a..b/...\n"), "/a..b/...", "dots inside a name are a name");
    assert.equal(parsed("open-path /a"), null);

    // A caller that sends and hangs up without reading still gets its tab, once.
    await new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        client.end("new-terminal\n", () => client.destroy());
      });
      client.on("close", resolve);
      client.on("error", reject);
    });
    while (calls === 5) await new Promise((done) => setTimeout(done, 5));
    assert.equal(calls, 6);
    assert.equal(await send(socketPath, ["new-terminal\n"]), "opened\n");
    assert.equal(calls, 7);

    // A caller that hangs up early runs nothing, and the socket keeps serving.
    assert.equal(await send(socketPath, ["new-term"], { closeAfter: true }), "");
    assert.equal(calls, 7);

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
