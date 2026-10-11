// Contracts for src/main/terminal-foreground.ts: which process group a pane
// redraw signals, and that nothing is signalled when a shell sits at its
// prompt, on Windows, or for a remote pane.
//
//   node scripts/test-terminal-foreground.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "terminal-foreground.ts");

function statLine(pid, comm, tpgid) {
  // pid (comm) state ppid pgrp session tty_nr tpgid flags ...
  return `${pid} (${comm}) S 1 ${pid} ${pid} 34816 ${tpgid} 4194560 1234 0 0 0`;
}

function probe(overrides = {}) {
  const calls = { kill: [], stat: [], ps: [] };
  const value = {
    platform: "linux",
    readProcStat: async (pid) => {
      calls.stat.push(pid);
      return statLine(pid, "zsh", 4242);
    },
    psForegroundGroup: async (pid) => {
      calls.ps.push(pid);
      return " 4242\n";
    },
    kill: (pid, signal) => calls.kill.push([pid, signal]),
    ...overrides,
  };
  return { value, calls };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-terminal-foreground-"));
  try {
    const outfile = path.join(dir, "terminal-foreground.cjs");
    await esbuild.build({ entryPoints: [ENTRY], outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    const mod = require(outfile);

    assert.equal(mod.parseProcStatForegroundGroup(statLine(100, "zsh", 4242)), 4242);
    assert.equal(
      mod.parseProcStatForegroundGroup(statLine(100, "tmux: client) S 9 9", 777)),
      777,
      "a command name containing ') ' cannot shift the fields",
    );
    assert.equal(mod.parseProcStatForegroundGroup(statLine(100, "node", -1)), null, "no controlling terminal");
    assert.equal(mod.parseProcStatForegroundGroup("garbage"), null);
    if (process.platform === "linux") {
      const self = fs.readFileSync("/proc/self/stat", "utf8");
      const parsed = mod.parseProcStatForegroundGroup(self);
      assert.ok(parsed === null || (Number.isInteger(parsed) && parsed > 0), "real /proc stat parses");
    }

    {
      const { value, calls } = probe();
      assert.equal(await mod.continueForegroundJob(100, value), 4242);
      assert.deepEqual(calls.kill, [[-4242, "SIGCONT"]], "the whole foreground job is continued");
    }
    {
      const { value, calls } = probe({ readProcStat: async (pid) => statLine(pid, "zsh", pid) });
      assert.equal(await mod.continueForegroundJob(100, value), null);
      assert.deepEqual(calls.kill, [], "a shell at its prompt is never signalled");
    }
    {
      const { value, calls } = probe({ platform: "darwin" });
      assert.equal(await mod.continueForegroundJob(100, value), 4242);
      assert.deepEqual(calls.ps, [100], "macOS asks ps for the terminal's foreground group");
      assert.deepEqual(calls.stat, []);
    }
    {
      const { value, calls } = probe({ platform: "win32" });
      assert.equal(await mod.continueForegroundJob(100, value), null);
      assert.deepEqual([...calls.stat, ...calls.ps, ...calls.kill], [], "Windows has no job control");
    }
    {
      const { value, calls } = probe();
      assert.equal(await mod.continueForegroundJob(0, value), null);
      assert.deepEqual([...calls.stat, ...calls.kill], [], "remote panes report pid 0");
    }
    {
      const { value, calls } = probe({ readProcStat: async () => { throw new Error("ENOENT"); } });
      assert.equal(await mod.continueForegroundJob(100, value), null);
      assert.deepEqual(calls.kill, [], "an exited shell is ignored");
    }
    {
      const { value } = probe({ kill: () => { throw new Error("ESRCH"); } });
      assert.equal(await mod.continueForegroundJob(100, value), null, "a job that exits in between is ignored");
    }
    console.log("terminal foreground job checks passed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
