// Unit suite for the automation precheck runner
// (src/main/orchestration/automation-precheck.ts) and the shared precheck
// helpers (src/shared/automation-catchup.ts).
//
// The platform seams (which shell and argv, how a timed-out tree is killed)
// are driven with a fake platform, so the Windows and macOS shapes are pinned
// on any host. The real-process cases run only where a POSIX shell exists.
//
//   node scripts/test-automation-precheck.cjs

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

let passed = 0;
function pass(name) {
  passed += 1;
  console.log(`  PASS ${name}`);
}

async function bundle(tmp) {
  const outfile = path.join(tmp, "precheck.bundle.cjs");
  await esbuild.build({
    stdin: {
      contents: [
        `export * as runner from ${JSON.stringify(path.join(ROOT, "src/main/orchestration/automation-precheck.ts"))};`,
        `export * as shared from ${JSON.stringify(path.join(SHARED_DIR, "automation-catchup.ts"))};`,
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [
      {
        name: "shared-alias",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  return require(outfile);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-precheck-"));
  // The default shell is a LOGIN shell: point it at an empty home so the
  // real cases never read the developer's own shell startup files.
  const fakeHome = path.join(tmp, "home");
  fs.mkdirSync(fakeHome);
  process.env.HOME = fakeHome;
  process.env.SHELL = "/bin/sh";
  const { runner, shared } = await bundle(tmp);

  // ── shared normalizers and lines ──────────────────────────────────────────
  assert.strictEqual(shared.normalizeAutomationPrecheck(undefined), undefined);
  assert.strictEqual(shared.normalizeAutomationPrecheck({ command: "   " }), undefined);
  assert.strictEqual(shared.normalizeAutomationPrecheck("echo hi"), undefined);
  assert.deepStrictEqual(shared.normalizeAutomationPrecheck({ command: "  test -f x  " }), {
    command: "test -f x",
    timeoutSeconds: 60,
  });
  assert.deepStrictEqual(
    shared.normalizeAutomationPrecheck({ command: "x", timeoutSeconds: 99999, shell: "powershell" }),
    { command: "x", timeoutSeconds: 600, shell: "powershell" },
  );
  assert.strictEqual(shared.normalizeAutomationPrecheck({ command: "x", timeoutSeconds: 0 }).timeoutSeconds, 1);
  assert.strictEqual(shared.normalizeAutomationPrecheck({ command: "x", shell: "bash" }).shell, undefined);
  pass("precheck normalizer trims, clamps the timeout and drops unknown shells");

  assert.strictEqual(
    shared.precheckSkipDetail({ passed: false, exitCode: 3, timedOut: false, durationMs: 5, outputTail: "" }),
    "Skipped: the check exited with code 3.",
  );
  assert.strictEqual(
    shared.precheckSkipDetail({ passed: false, exitCode: null, timedOut: true, durationMs: 60_400, outputTail: "" }, 60),
    "Skipped: the check did not finish within 60s.",
  );
  assert.match(
    shared.precheckSkipDetail({ passed: false, exitCode: null, timedOut: false, durationMs: 1, outputTail: "", error: "spawn /bin/zsh ENOENT" }),
    /could not run \(spawn \/bin\/zsh ENOENT\)/,
  );
  assert.match(
    shared.precheckVerdict({ passed: true, exitCode: 0, timedOut: false, durationMs: 12, outputTail: "" }),
    /^Passed \(exit 0, 12 ms\)/,
  );
  assert.match(
    shared.precheckVerdict({ passed: false, exitCode: 1, timedOut: false, durationMs: 12, outputTail: "" }),
    /^Would skip: the check exited with code 1\.$/,
  );
  pass("skip and verdict lines are plain words");

  // ── platform seam: which shell runs the command ──────────────────────────
  {
    const inv = runner.precheckInvocation('echo "a b"', "default", "linux", { SHELL: "/usr/bin/zsh" });
    assert.deepStrictEqual(inv, { file: "/usr/bin/zsh", args: ["-lc", 'echo "a b"'] });
    assert.strictEqual(runner.precheckInvocation("x", undefined, "darwin", { SHELL: "/bin/bash" }).file, "/bin/bash");
    assert.strictEqual(runner.precheckInvocation("x", "default", "darwin", { SHELL: "/opt/homebrew/bin/fish" }).file, "/bin/sh");
    assert.strictEqual(runner.precheckInvocation("x", "default", "linux", {}).file, "/bin/sh");
    pass("macOS and Linux run the login shell with -lc (fish and unknown shells use /bin/sh)");
  }
  {
    const inv = runner.precheckInvocation('if exist "a b.txt" (exit 0) else (exit 1)', "default", "win32", {
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
    });
    assert.strictEqual(inv.file, "C:\\Windows\\system32\\cmd.exe");
    assert.deepStrictEqual(inv.args, ["/d", "/s", "/c", '"if exist "a b.txt" (exit 0) else (exit 1)"']);
    assert.strictEqual(inv.windowsVerbatimArguments, true);
    assert.strictEqual(runner.precheckInvocation("x", "default", "win32", {}).file, "cmd.exe");
    assert.deepStrictEqual(
      runner.precheckInvocation("cd sub\r\n\r\n  if exist TODO.md (exit 0) else (exit 1)\n", "default", "win32", {}).args,
      ["/d", "/s", "/c", '"cd sub & if exist TODO.md (exit 0) else (exit 1)"'],
      "cmd.exe would run only the first line: lines are joined with &",
    );
    assert.deepStrictEqual(
      runner.precheckInvocation("cd sub\ntest -f TODO.md", "default", "linux", { SHELL: "/bin/sh" }).args,
      ["-lc", "cd sub\ntest -f TODO.md"],
      "POSIX shells take the lines as they are",
    );
    pass("Windows runs cmd.exe /d /s /c with the command passed through verbatim");
  }
  {
    const cmd = "if (Test-Path 'TODO.md') { exit 0 } else { exit 1 }";
    const win = runner.precheckInvocation(cmd, "powershell", "win32", {});
    assert.strictEqual(win.file, "powershell.exe");
    assert.ok(win.args.includes("-NonInteractive") && win.args.includes("-NoProfile"));
    assert.deepStrictEqual(win.args.slice(-4, -2), ["-ExecutionPolicy", "Bypass"]);
    assert.strictEqual(win.args[win.args.length - 2], "-EncodedCommand");
    assert.strictEqual(Buffer.from(win.args[win.args.length - 1], "base64").toString("utf16le"), cmd);
    const mac = runner.precheckInvocation(cmd, "powershell", "darwin", {});
    assert.strictEqual(mac.file, "pwsh");
    assert.ok(!mac.args.includes("-ExecutionPolicy"));
    assert.strictEqual(Buffer.from(mac.args[mac.args.length - 1], "base64").toString("utf16le"), cmd);
    pass("PowerShell gets the command as -EncodedCommand (powershell.exe on Windows, pwsh elsewhere)");
  }

  // ── platform seam: how a timed-out command tree is stopped ───────────────
  {
    const calls = [];
    const timers = [];
    const deps = {
      processKill: (pid, sig) => calls.push(["kill", pid, sig]),
      runTaskkill: (pid) => calls.push(["taskkill", pid]),
      setTimer: (fn, ms) => timers.push([fn, ms]),
    };
    runner.killPrecheckTree({ pid: 4321, kill: () => calls.push(["child.kill"]) }, "linux", deps);
    assert.deepStrictEqual(calls, [["kill", -4321, "SIGTERM"]]);
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0][1], 2000);
    timers[0][0]();
    assert.deepStrictEqual(calls[1], ["kill", -4321, "SIGKILL"]);
    pass("POSIX: SIGTERM to the process group, SIGKILL two seconds later");
  }
  {
    const calls = [];
    let done;
    const deps = {
      processKill: () => calls.push(["kill"]),
      runTaskkill: (pid, onDone) => {
        calls.push(["taskkill", pid]);
        done = onDone;
      },
      setTimer: () => calls.push(["timer"]),
    };
    runner.killPrecheckTree({ pid: 77, kill: () => calls.push(["child.kill"]) }, "win32", deps);
    assert.deepStrictEqual(calls, [["taskkill", 77]]);
    done(false);
    assert.deepStrictEqual(calls, [["taskkill", 77]], "a working taskkill needs no fallback");
    done(true);
    assert.deepStrictEqual(calls[1], ["child.kill"], "a failed taskkill falls back to killing the shell");
    pass("Windows: taskkill /T /F on the tree, the shell itself when taskkill fails");
  }
  {
    const calls = [];
    runner.killPrecheckTree({ pid: undefined, kill: (s) => calls.push(s) }, "linux", {
      processKill: () => calls.push("group"),
      runTaskkill: () => calls.push("taskkill"),
      setTimer: () => calls.push("timer"),
    });
    assert.deepStrictEqual(calls, ["SIGKILL"]);
    pass("a child with no pid is killed directly");
  }

  // ── real runs (POSIX hosts) ──────────────────────────────────────────────
  if (process.platform === "win32") {
    console.log("  SKIP real-process cases (POSIX shell cases; Windows is pinned by the seams above)");
  } else {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codara-precheck-cwd-"));
    fs.writeFileSync(path.join(cwd, "marker.txt"), "x");

    const ok = await runner.runAutomationPrecheck({ command: "test -f marker.txt && echo found it" }, { cwd });
    assert.strictEqual(ok.passed, true);
    assert.strictEqual(ok.exitCode, 0);
    assert.strictEqual(ok.outputTail, "found it");
    pass("exit 0 passes and runs in the automation's folder");

    const no = await runner.runAutomationPrecheck({ command: "echo nothing new; echo 'to stderr' >&2; exit 3" }, { cwd });
    assert.strictEqual(no.passed, false);
    assert.strictEqual(no.exitCode, 3);
    assert.strictEqual(no.timedOut, false);
    assert.match(no.outputTail, /nothing new/);
    assert.match(no.outputTail, /to stderr/);
    pass("a non-zero exit fails with both streams in the tail");

    const env = await runner.runAutomationPrecheck(
      { command: 'test "$SPARK_AUTOMATION_ID" = job-abc' },
      { cwd, env: { SPARK_AUTOMATION_ID: "job-abc" } },
    );
    assert.strictEqual(env.passed, true);
    pass("the automation id reaches the command's environment");

    const started = Date.now();
    const slow = await runner.runAutomationPrecheck(
      { command: "sleep 30 & sleep 30; echo never", timeoutSeconds: 1 },
      { cwd },
    );
    const took = Date.now() - started;
    assert.strictEqual(slow.passed, false);
    assert.strictEqual(slow.timedOut, true);
    assert.strictEqual(slow.exitCode, null);
    assert.ok(took < 8000, `a timed-out check settles promptly (took ${took} ms)`);
    pass("a timeout stops the whole tree (background child included) and fails the check");

    const missing = await runner.runAutomationPrecheck({ command: "true" }, { cwd: path.join(cwd, "gone") });
    assert.strictEqual(missing.passed, false);
    assert.ok(missing.error, "a missing folder is reported as an error");
    assert.match(missing.error, /^the folder .*gone does not exist$/, `a missing folder reads as one, not as a missing shell (${missing.error})`);
    pass("a missing folder fails with an error instead of throwing");

    const long = await runner.runAutomationPrecheck(
      { command: "i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done; printf '\\033[31mred\\033[0m'; exit 1" },
      { cwd },
    );
    assert.ok(long.outputTail.length <= shared.PRECHECK_OUTPUT_TAIL_CHARS);
    assert.ok(long.outputTail.endsWith("red"), "colour codes are stripped and the newest output kept");
    assert.ok(!long.outputTail.includes("line-0\n"), "the oldest output is dropped");
    pass("output is cut to the newest 2000 characters without colour codes");

    fs.rmSync(cwd, { recursive: true, force: true });
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAll ${passed} automation precheck checks PASSED.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nAUTOMATION PRECHECK TEST FAILED:\n", err);
    process.exit(1);
  },
);
