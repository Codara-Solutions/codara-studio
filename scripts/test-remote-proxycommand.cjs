#!/usr/bin/env node
"use strict";

// ProxyCommand support for SSH hosts (src/main/remote/proxy-command.ts):
// token expansion and its refusals, shell invocation per platform, and the
// Duplex that carries SSH over a child's stdio. Loads no native modules.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-proxycommand-"));

async function load() {
  const outfile = path.join(TMP, "proxy-command.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/remote/proxy-command.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  return require(outfile);
}

// A stand-in proxy: mode "echo" copies stdin to stdout and logs two phase
// lines on stderr; "fail" prints a reason and exits 7; "hang" stays alive.
const FAKE = path.join(TMP, "fake-proxy.js");
fs.writeFileSync(
  FAKE,
  `
const mode = process.argv[2];
if (mode === "fail") {
  process.stderr.write("Waking dev: starting the box\\nThe box did not start in time\\n");
  process.exit(7);
}
if (mode === "hang") {
  process.stderr.write("ready\\n");
  setInterval(() => {}, 1000);
} else {
  process.stderr.write("Waking dev: waiting for a server\\n");
  process.stderr.write("Waking dev: starting the box\\n");
  process.stdin.pipe(process.stdout);
}
`,
);

const tokens = { host: "codara-dev", port: 22, user: "codara", name: "codara-dev" };

function testExpansion(api) {
  assert.equal(
    api.expandProxyCommand("ncat %h %p --user %r --name %n 100%%", tokens),
    "ncat codara-dev 22 --user codara --name codara-dev 100%",
  );
  // Values are only checked for the tokens the template uses.
  assert.equal(
    api.expandProxyCommand("echo %h", { ...tokens, user: "a;b" }),
    "echo codara-dev",
  );
  for (const bad of ["a b", "a;b", "$(id)", "`id`", "a|b", "a'b", 'a"b', "a&b", "-o x\nid", "a%b", ""]) {
    for (const [token, field] of [["%h", "host"], ["%r", "user"], ["%n", "name"]]) {
      assert.throws(
        () => api.expandProxyCommand(`ssh ${token}`, { ...tokens, [field]: bad }),
        /not allowed/,
        `${field}=${JSON.stringify(bad)} must be refused`,
      );
    }
  }
  assert.throws(() => api.expandProxyCommand("ssh %C", tokens), /not supported/);
  assert.throws(() => api.expandProxyCommand("ssh %", tokens), /not supported/);
}

function testInvocation(api) {
  assert.deepEqual(api.shellInvocation("a b", "linux"), { file: "/bin/sh", args: ["-c", "a b"] });
  assert.deepEqual(api.shellInvocation("a b", "darwin"), { file: "/bin/sh", args: ["-c", "a b"] });
  assert.deepEqual(api.shellInvocation("a b", "win32"), {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", '"a b"'],
    windowsVerbatimArguments: true,
  });
  const base = { id: "h", host: "h.example", port: 2222, username: "me", source: "manual" };
  assert.equal(api.resolveProxyInvocation(base), null);
  // argv wins and is never run through a shell.
  assert.deepEqual(
    api.resolveProxyInvocation({ ...base, proxyCommand: ["/bin/x y", "a;b"], proxyCommandTemplate: "ignored" }),
    { file: "/bin/x y", args: ["a;b"] },
  );
  assert.deepEqual(
    api.resolveProxyInvocation({ ...base, proxyCommandTemplate: "nc %h %p" }, "linux"),
    { file: "/bin/sh", args: ["-c", "nc h.example 2222"] },
  );
  assert.throws(
    () => api.resolveProxyInvocation({ ...base, host: "h;id", proxyCommandTemplate: "nc %h %p" }),
    /not allowed/,
  );
  assert.throws(
    () => api.resolveProxyInvocation({ ...base, username: "me$(id)", proxyCommandTemplate: "nc %r@%h" }),
    /not allowed/,
  );
}

function collect(stream) {
  const chunks = [];
  stream.on("data", (c) => chunks.push(c));
  return () => Buffer.concat(chunks).toString("utf8");
}

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

async function testEcho(api) {
  const lines = [];
  const sock = api.openProxySocket(
    { file: process.execPath, args: [FAKE, "echo"] },
    { onStderrLine: (l) => lines.push(l) },
  );
  const read = collect(sock);
  sock.write("hello ");
  sock.end("proxy");
  await once(sock, "end");
  assert.equal(read(), "hello proxy");
  await once(sock.child, "close");
  assert.deepEqual(lines, ["Waking dev: waiting for a server", "Waking dev: starting the box"]);
  assert.equal(typeof sock.setNoDelay, "function");
  sock.destroy();
}

async function testNonZeroExit(api) {
  const sock = api.openProxySocket({ file: process.execPath, args: [FAKE, "fail"] });
  const [err] = await once(sock, "error").then((e) => [e]);
  assert.match(err.message, /exited with code 7/);
  assert.match(err.message, /The box did not start in time/);
}

async function testSpawnFailure(api) {
  const sock = api.openProxySocket({ file: path.join(TMP, "does-not-exist"), args: [] });
  const err = await once(sock, "error");
  assert.equal(err.code, "ENOENT");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function testDestroyKillsChild(api) {
  const sock = api.openProxySocket({ file: process.execPath, args: [FAKE, "hang"] });
  const pid = sock.child.pid;
  await new Promise((resolve) => sock.child.stderr.once("data", resolve));
  assert(alive(pid), "child must be running before destroy");
  sock.destroy();
  await once(sock.child, "close");
  assert(!alive(pid), "destroying the socket must kill the proxy child");
}

(async () => {
  const api = await load();
  testExpansion(api);
  testInvocation(api);
  await testEcho(api);
  await testNonZeroExit(api);
  await testSpawnFailure(api);
  await testDestroyKillsChild(api);
  console.log("remote proxycommand: ok");
})()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
