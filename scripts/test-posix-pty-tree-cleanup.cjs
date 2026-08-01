#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const nodePty = require("node-pty");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-posix-pty-tree-"));

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function loadModule() {
  const outfile = path.join(TMP, "posix-pty-tree.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/posix-pty-tree.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

function deterministicChecks(mod) {
  const listed = [
    { pid: 501, parentPid: 1, startedAt: "root-start" },
    { pid: 502, parentPid: 501, startedAt: "child-start" },
    { pid: 503, parentPid: 502, startedAt: "grandchild-start" },
    // Same fabricated tty listing, but not a descendant of the owned root.
    { pid: 777, parentPid: 1, startedAt: "unrelated-start" },
  ];
  const signals = [];
  const timers = [];
  const deps = {
    platform: "darwin",
    listExactTtyProcesses: () => listed,
    signal: (pid, signal) => signals.push(`${signal}:${pid}`),
    setTimer: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return { unref() {} };
    },
  };

  const target = mod.capturePosixPtyTree(
    { pid: 501, _pty: "/dev/ttys999" },
    deps,
  );
  assert.ok(target, "an exact owned root tty should capture");
  assert.deepEqual(
    target.members.map(({ pid, depth }) => ({ pid, depth })),
    [
      { pid: 503, depth: 2 },
      { pid: 502, depth: 1 },
      { pid: 501, depth: 0 },
    ],
    "capture must include only root descendants and order children first",
  );

  mod.beginPosixPtyTreeTeardown(target, 123, deps);
  assert.deepEqual(signals, ["SIGHUP:503", "SIGHUP:502", "SIGHUP:501"]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 123, "force fallback must be bounded");
  timers[0].callback();
  assert.deepEqual(signals.slice(3), [
    "SIGKILL:503",
    "SIGKILL:502",
    "SIGKILL:501",
  ]);
  assert.equal(
    signals.some((entry) => entry.endsWith(":777")),
    false,
    "a same-listing unrelated process must never be signaled",
  );

  // A retry is best effort and must remain safe/idempotent.
  mod.signalPosixPtyTree(target, "SIGKILL", deps);
  assert.equal(signals.at(-1), "SIGKILL:501");

  const changedIdentityDeps = {
    ...deps,
    listExactTtyProcesses: () =>
      listed.map((entry) =>
        entry.pid === 502 ? { ...entry, startedAt: "reused-pid-start" } : entry,
      ),
  };
  signals.length = 0;
  mod.signalPosixPtyTree(target, "SIGKILL", changedIdentityDeps);
  assert.equal(
    signals.some((entry) => entry.endsWith(":502")),
    false,
    "a reused PID with a different start identity must not be signaled",
  );

  let windowsListed = false;
  const windowsDeps = {
    ...deps,
    platform: "win32",
    listExactTtyProcesses: () => {
      windowsListed = true;
      return listed;
    },
  };
  assert.equal(
    mod.capturePosixPtyTree({ pid: 501, _pty: "/dev/ttys999" }, windowsDeps),
    null,
  );
  assert.equal(windowsListed, false, "Windows must not enter POSIX discovery");
  assert.equal(
    mod.capturePosixPtyTree(
      { pid: process.pid, _pty: "/dev/ttys999" },
      deps,
    ),
    null,
    "the current process must never be a cleanup root",
  );
  for (const pid of [0, -1, 1, Number.NaN]) {
    assert.equal(
      mod.capturePosixPtyTree({ pid, _pty: "/dev/ttys999" }, deps),
      null,
    );
  }
  assert.equal(
    mod.capturePosixPtyTree({ pid: 501, _pty: "/tmp/not-a-tty" }, deps),
    null,
    "an untrusted path must fail closed",
  );
}

async function realPosixTreeCheck(mod) {
  if (process.platform === "win32") return;

  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  let pty;
  let descendantPid = 0;
  try {
    const childProgram = [
      "process.on('SIGHUP', () => {});",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");
    const rootProgram = [
      "const {spawn}=require('node:child_process');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:'inherit'});`,
      "console.log('OWNED_DESCENDANT:'+child.pid);",
      "process.on('SIGHUP', () => {});",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");
    pty = nodePty.spawn(process.execPath, ["-e", rootProgram], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: ROOT,
      env: process.env,
    });

    let output = "";
    pty.onData((chunk) => {
      output += chunk;
      const match = /OWNED_DESCENDANT:(\d+)/.exec(output);
      if (match) descendantPid = Number(match[1]);
    });
    await waitFor(
      () => descendantPid > 1 && alive(descendantPid),
      3_000,
      "real PTY descendant",
    );

    const target = mod.capturePosixPtyTree(pty);
    assert.ok(target, "real node-pty ownership should be discoverable");
    assert.ok(
      target.members.some((member) => member.pid === descendantPid),
      "real descendant should be captured from only the owned slave tty",
    );
    assert.equal(
      target.members.some((member) => member.pid === unrelated.pid),
      false,
      "an unrelated process must not enter the owned target",
    );

    // This exactly mirrors pty-manager: flush happens before node-pty's normal
    // SIGHUP, then descendants get the same graceful signal and a bounded
    // force fallback.
    pty.kill();
    mod.beginPosixPtyTreeTeardown(target, 125);
    await waitFor(
      () => !mod.isPosixPtyTreeAlive(target),
      3_000,
      "owned PTY tree teardown",
    );
    assert.equal(
      alive(unrelated.pid),
      true,
      "the unrelated process must survive owned PTY teardown",
    );
    // Repeated cleanup is a no-op, not a cross-process kill.
    assert.equal(mod.signalPosixPtyTree(target, "SIGKILL"), 0);
  } finally {
    if (pty && alive(pty.pid)) {
      try {
        process.kill(pty.pid, "SIGKILL");
      } catch {}
    }
    if (descendantPid && alive(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {}
    }
    if (unrelated.pid && alive(unrelated.pid)) {
      try {
        process.kill(unrelated.pid, "SIGKILL");
      } catch {}
    }
  }
}

async function main() {
  const mod = await loadModule();
  deterministicChecks(mod);
  await realPosixTreeCheck(mod);

  const managerSource = fs.readFileSync(
    path.join(ROOT, "src/main/pty-manager.ts"),
    "utf8",
  );
  assert.match(
    managerSource,
    /if \(process\.platform === "win32"\)[\s\S]*?spawnChild\([\s\S]*?"taskkill"/,
    "the existing Windows taskkill tree path must remain present",
  );
  assert.match(
    managerSource,
    /else \{\s*beginPosixPtyTreeTeardown\(posixTree\);\s*\}/,
    "POSIX cleanup must remain isolated from the Windows branch",
  );
  console.log(
    "PASS: exact POSIX PTY descendants are gracefully then forcibly reaped; unrelated and Windows paths are untouched",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
