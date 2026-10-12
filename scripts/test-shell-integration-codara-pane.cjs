#!/usr/bin/env node
"use strict";

// `codara-pane` is how a program in a Codara terminal opens a terminal over
// its own pane or in a new tab beside it (a session picker written for
// WezTerm's zoomed split is the motivating user). Codara writes the wrapper
// into <codaraHome>/integrations/bin at boot and puts that folder on PATH in
// its own panes only. This suite checks:
//   - argument parsing, and that argv survives the trip through the pane's
//     POSIX shell exactly (quotes, spaces, $ and backquotes stay literal),
//   - the request: pane.open with the pane's own bearer token, the caller's
//     cwd by default, and the exit codes a script branches on (0 opened,
//     1 refused/unreachable, 2 usage, 3 not in a Codara pane),
//   - the generated wrapper runs the helper with the given Node and is
//     executable, and the PATH helper puts its folder first exactly once.
//
//   node scripts/test-shell-integration-codara-pane.cjs

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const HELPER = path.join(ROOT, "resources", "shell-integration", "codara-pane.cjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pane-helper-"));
const TOKEN = "a".repeat(64);

const helper = require(HELPER);

function sink() {
  let text = "";
  return { write: (chunk) => (text += chunk), get text() { return text; } };
}

async function runMain(argv, env, cwd = "/work/project") {
  const stdout = sink();
  const stderr = sink();
  const code = await helper.main(argv, { env, cwd, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ auth: req.headers.authorization, path: req.url, body: parsed });
      const { status = 200, reply } = handler(parsed);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

async function main() {
  // Parsing.
  assert.deepEqual(helper.parseArgs(["overlay", "--", "fzf", "--multi"]), { mode: "overlay", argv: ["fzf", "--multi"] });
  assert.deepEqual(helper.parseArgs(["tab", "--cwd", "/x", "--title", "t", "claude", "--resume", "id"]), {
    mode: "tab",
    argv: ["claude", "--resume", "id"],
    cwd: "/x",
    title: "t",
  });
  assert.deepEqual(helper.parseArgs(["tab"]), { mode: "tab", argv: [] });
  assert.deepEqual(helper.parseArgs(["overlay", "-c", "ls | less"]), { mode: "overlay", argv: [], command: "ls | less" });
  assert.throws(() => helper.parseArgs(["overlay"]), /needs a command/);
  assert.throws(() => helper.parseArgs(["window", "x"]), /unknown mode/);
  assert.throws(() => helper.parseArgs(["tab", "--bogus"]), /unknown option/);
  assert.throws(() => helper.parseArgs(["tab", "-c", "a", "b"]), /either/);
  assert.equal(helper.parseArgs(["--help"]).help, true);
  console.log("PASS codara-pane parses overlay and tab requests");

  // argv reaches the program unchanged through the pane's shell.
  if (process.platform !== "win32") {
    const argv = ["printf", "[%s]", "plain", "a b", "it's", "$HOME", "`id`", "*", "", "tab\there"];
    const line = helper.commandLine({ argv }, "linux");
    const shells = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((shell) => fs.existsSync(shell));
    for (const shell of shells) {
      const out = spawnSync(shell, ["-c", line], { encoding: "utf8", cwd: TMP });
      assert.equal(out.stdout, argv.slice(2).map((arg) => `[${arg}]`).join(""), `${shell} sees the exact argv`);
    }
    console.log(`PASS argv survives ${shells.map((shell) => path.basename(shell)).join(", ")} untouched`);
  }

  // The request and its exit codes.
  assert.equal((await runMain(["overlay", "--", "x"], {})).code, 3, "outside a Codara pane");
  assert.equal(
    (await runMain(["overlay", "--", "x"], { SPARK_PANE_SOCKET: "http://example.com:80", SPARK_PANE_TOKEN: TOKEN })).code,
    3,
    "only a loopback socket is trusted",
  );
  assert.equal((await runMain(["overlay"], { SPARK_PANE_SOCKET: "http://127.0.0.1:1", SPARK_PANE_TOKEN: TOKEN })).code, 2);

  let reply = { reply: { jsonrpc: "2.0", id: 1, result: { mode: "overlay", paneId: "overlay-9", hostPaneId: "pane-1" } } };
  const { server, requests, port } = await startServer(() => reply);
  const env = { SPARK_PANE_SOCKET: `http://127.0.0.1:${port}`, SPARK_PANE_TOKEN: TOKEN };
  try {
    const opened = await runMain(["overlay", "--title", "Sessions", "--", "picker", "--overlay", "--here"], env);
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(opened.stdout, "overlay-9\n");
    assert.deepEqual(requests.at(-1), {
      auth: `Bearer ${TOKEN}`,
      path: "/rpc",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "pane.open",
        params: { mode: "overlay", cwd: "/work/project", command: "picker --overlay --here", title: "Sessions" },
      },
    });
    await runMain(["tab", "--cwd", "/elsewhere"], env);
    assert.deepEqual(requests.at(-1).body.params, { mode: "tab", cwd: "/elsewhere" }, "a bare tab sends no command");

    reply = { reply: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "this pane already has an overlay open" } } };
    const refused = await runMain(["overlay", "--", "x"], env);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already has an overlay open/);

    reply = { status: 401, reply: { error: "unauthorized" } };
    const stale = await runMain(["overlay", "--", "x"], env);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /did not accept this pane's credential/);
  } finally {
    server.close();
  }
  const unreachable = await runMain(["overlay", "--", "x"], env);
  assert.equal(unreachable.code, 1, "a closed Codara is a failure the caller can fall back from");
  console.log("PASS codara-pane sends pane.open with the pane's token and reports 0/1/2/3");

  // The wrapper Codara writes at boot.
  const bundle = path.join(TMP, "pane-helper.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "pane-helper.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(ROOT)}, getPath: () => ${JSON.stringify(TMP)}, getVersion: () => "0.0.0", on() {} }, ipcMain: { on() {}, handle() {} }, BrowserWindow: { getAllWindows: () => [] } };`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const paneHelper = require(bundle);
  const integrations = path.join(TMP, "codara-home", "integrations");
  assert.equal(paneHelper.paneHelperBinDir(integrations), path.join(integrations, "bin"));
  const dir = await paneHelper.writePaneHelperFiles({
    dir: paneHelper.paneHelperBinDir(integrations),
    nodePath: process.execPath,
    scriptPath: HELPER,
    platform: "linux",
  });
  const wrapper = path.join(dir, "codara-pane");
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o755, "the wrapper is executable");
  assert.match(fs.readFileSync(wrapper, "utf8"), /^#!\/bin\/sh\n/);
  assert.match(paneHelper.windowsPaneHelperWrapper("C:\\a\\node.exe", "C:\\b\\codara-pane.cjs"), /setlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\a\\node.exe" "C:\\b\\codara-pane.cjs" %\*/);

  const quoted = paneHelper.posixPaneHelperWrapper("/opt/it's here/node", "/x/codara-pane.cjs");
  assert.match(quoted, /exec '\/opt\/it'\\''s here\/node' '\/x\/codara-pane.cjs' "\$@"/);

  if (process.platform !== "win32") {
    const run = await new Promise((resolve) => {
      const child = spawn(wrapper, ["--help"], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ code, out }));
    });
    assert.equal(run.code, 0);
    assert.match(run.out, /codara-pane overlay/);
    const outside = spawnSync(wrapper, ["overlay", "--", "x"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(outside.status, 3, "the installed wrapper reports 'not in a pane' outside Codara");
  }

  const env2 = { PATH: ["/usr/bin", dir, "/bin"].join(path.delimiter) };
  paneHelper.withPaneHelperOnPath(env2, dir);
  assert.equal(env2.PATH, [dir, "/usr/bin", "/bin"].join(path.delimiter), "the folder comes first, once");
  const env3 = { Path: "C:\\Windows" };
  paneHelper.withPaneHelperOnPath(env3, dir);
  assert.deepEqual(Object.keys(env3), ["Path"], "the env's own PATH key is kept");
  console.log("PASS the boot-written wrapper runs the helper and PATH lists its folder first");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
