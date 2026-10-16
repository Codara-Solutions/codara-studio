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
  const longCommand = `test -f ${"x".repeat(shared.MAX_PRECHECK_COMMAND_CHARS + 100)}`;
  assert.strictEqual(
    shared.normalizeAutomationPrecheck({ command: longCommand }).command,
    longCommand,
    "a long command is kept whole (refused at the input, never cut into a different command)",
  );
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
    // A block typed over several lines, the way a batch file is written.
    assert.strictEqual(
      runner.joinCmdLines("if exist TODO.md (\n  echo found\n  exit 0\n) else (\n  exit 1\n)"),
      "if exist TODO.md ( echo found & exit 0 ) else ( exit 1 )",
      "no & right inside a ( ) block's edges",
    );
    assert.strictEqual(runner.joinCmdLines("git fetch &&\ngit status"), "git fetch && git status", "an operator at the end already joins");
    assert.strictEqual(runner.joinCmdLines("dir |\nfind \"x\""), 'dir | find "x"');
    assert.strictEqual(runner.joinCmdLines("echo a ^\nb\nexit 1"), "echo a b & exit 1", "a trailing ^ continues the line");
    assert.strictEqual(runner.joinCmdLines("echo a^^\nexit 1"), "echo a^^ & exit 1", "an escaped ^^ is not a continuation");
    assert.strictEqual(
      runner.joinCmdLines("rem look for work\n:: still a comment\nREM\nif exist TODO.md (exit 0) else (exit 1)"),
      "if exist TODO.md (exit 0) else (exit 1)",
      "comment lines are dropped, not allowed to swallow the lines after them",
    );
    assert.strictEqual(runner.joinCmdLines("remove.bat"), "remove.bat", "only a REM word is a comment");
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
    const decoded = Buffer.from(win.args[win.args.length - 1], "base64").toString("utf16le");
    assert.strictEqual(decoded, `$ProgressPreference = 'SilentlyContinue'\n${cmd}`, "progress records are off, then the command as typed");
    const mac = runner.precheckInvocation(cmd, "powershell", "darwin", {});
    assert.strictEqual(mac.file, "pwsh");
    assert.ok(!mac.args.includes("-ExecutionPolicy"));
    assert.ok(Buffer.from(mac.args[mac.args.length - 1], "base64").toString("utf16le").endsWith(`\n${cmd}`));
    pass("PowerShell gets the command as -EncodedCommand (powershell.exe on Windows, pwsh elsewhere)");

    const clixml =
      'before\r\n#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64></MS></Obj>' +
      '<S S="Error">No TODO.md &amp; nothing to do_x000D__x000A_</S><S S="Error">At line:1 &lt;here&gt;_x000D__x000A_</S></Objs>';
    assert.strictEqual(
      runner.decodeClixml(clixml),
      "before\r\nNo TODO.md & nothing to do\r\nAt line:1 <here>\r\n",
      "the error text is kept, progress records and markup are dropped",
    );
    assert.strictEqual(runner.decodeClixml("plain output"), "plain output");
    pass("Windows PowerShell CLIXML on stderr reads as its error text");
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

    const quitCalls = [];
    const quitTimers = [];
    runner.killPrecheckTree({ pid: 99, kill: () => quitCalls.push(["child.kill"]) }, "darwin", {
      processKill: (pid, sig) => quitCalls.push(["kill", pid, sig]),
      runTaskkill: () => quitCalls.push(["taskkill"]),
      setTimer: (fn, ms) => quitTimers.push(ms),
    }, true);
    assert.deepStrictEqual(quitCalls, [["kill", -99, "SIGKILL"]]);
    assert.strictEqual(quitTimers.length, 0, "quitting has no later to wait for");
    pass("quitting: SIGKILL to the process group at once");
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

    // A background job that keeps the pipes open: the shell's exit decides.
    let bgPid;
    const spawnImpl = (...args) => {
      const child = require("node:child_process").spawn(...args);
      bgPid = child.pid;
      return child;
    };
    const bgStarted = Date.now();
    const bg = await runner.runAutomationPrecheck({ command: "sleep 20 & echo started; exit 0", timeoutSeconds: 15 }, { cwd, spawnImpl });
    const bgTook = Date.now() - bgStarted;
    try {
      process.kill(-bgPid, "SIGKILL");
    } catch {
      /* already gone */
    }
    assert.strictEqual(bg.passed, true, "exit 0 passes although a background job still holds the output");
    assert.strictEqual(bg.timedOut, false);
    assert.strictEqual(bg.outputTail, "started");
    assert.ok(bgTook < runner.PRECHECK_DRAIN_MS + 2500, `the verdict does not wait for the background job (took ${bgTook} ms)`);
    pass("a check that leaves a background job running is decided by the shell's exit code");

    // Quitting Codara stops a running check, and says so.
    const quitStarted = Date.now();
    const quitting = runner.runAutomationPrecheck({ command: "trap '' TERM; sleep 30; exit 0", timeoutSeconds: 60 }, { cwd });
    await new Promise((r) => setTimeout(r, 300));
    runner.stopRunningPrechecks();
    const quit = await quitting;
    assert.strictEqual(quit.passed, false);
    assert.strictEqual(quit.error, runner.PRECHECK_STOPPED_ERROR);
    assert.ok(Date.now() - quitStarted < 5000, "a stopped check settles at once, even one that ignores SIGTERM");
    pass("quitting stops a running check (SIGKILL to its group) and marks it stopped, not failed");

    for (const where of ["", "relative/folder"]) {
      const none = await runner.runAutomationPrecheck({ command: "true" }, { cwd: where });
      assert.strictEqual(none.passed, false);
      assert.strictEqual(none.error, "the automation has no workspace folder", `cwd ${JSON.stringify(where)}`);
    }
    pass("no folder (or a relative one) fails instead of running wherever Codara runs");

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
