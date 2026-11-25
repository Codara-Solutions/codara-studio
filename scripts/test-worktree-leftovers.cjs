// Processes left running in a merged worktree (src/main/worktree-cleanup/
// leftovers.ts, and rail.ts's Clean up around it). The invariant: a signal
// reaches a process only when, right before it, the process has the pid and
// start time the user confirmed and still works inside the worktree; a group
// only when every member is confirmed and inside; and the worktree goes only
// after a fresh check finds nothing running in it. Driven against throwaway
// git repositories with a bare remote and a fake process table, plus one real
// child process stopped through the real system (Linux and macOS).
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(dir, name, content, message) {
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, ["add", name]);
  git(dir, ["commit", "-q", "-m", message]);
}

async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-worktree-leftovers-${name}-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  return { mod: require(outfile), outfile };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const CREATED_AT = new Date(Date.now() - 60_000).toISOString();
const HOUR = 60 * 60_000;

// A process table the test owns: SIGTERM ends a process unless it ignores
// it, SIGKILL unless it cannot be killed. Every signal is recorded.
function fakeSystem() {
  const procs = new Map();
  const signals = [];
  let clock = 1_000_000;
  const system = {
    appPid: 100,
    sessions: new Set(),
    sessionPids: () => [...system.sessions],
    facts: async (pid) => (procs.has(pid) ? { ...procs.get(pid) } : null),
    table: async () => [...procs.values()].map(({ pid, parentPid, group }) => ({ pid, parentPid, group })),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      const targets = pid < 0 ? [...procs.values()].filter((entry) => entry.group === -pid) : [procs.get(pid)].filter(Boolean);
      for (const entry of targets) {
        if (entry.unkillable || (signal === "SIGTERM" && entry.ignoresTerm)) continue;
        procs.delete(entry.pid);
      }
    },
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    graceMs: 300,
  };
  const add = (pid, extra) =>
    procs.set(pid, {
      pid,
      parentPid: 1,
      group: pid,
      start: `s${pid}`,
      startedAtMs: clock - 3 * HOUR,
      cwd: "/nowhere",
      command: "node server.js --token=FAKE_SECRET",
      zombie: false,
      ...extra,
    });
  procs.set(100, { pid: 100, parentPid: 1, group: 100, start: "app", startedAtMs: 0, cwd: "/", command: "codara", zombie: false });
  return { system, procs, signals, add };
}

async function main() {
  const bundles = await Promise.all([
    bundle("src/main/worktree-cleanup/rail.ts", "rail"),
    bundle("src/main/worktree-cleanup/leftovers.ts", "leftovers"),
    bundle("src/main/agent-worktrees.ts", "agent"),
  ]);
  const [rail, leftovers, agent] = bundles.map((entry) => entry.mod);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-wt-leftovers-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;
  let child = null;

  try {
    // ── The stop helper alone ───────────────────────────────────────────
    await check("program names keep the script, never other arguments", async () => {
      assert.equal(leftovers.programOf("/usr/bin/node /srv/app/server.js --token=FAKE_SECRET"), "node server.js");
      assert.equal(leftovers.programOf("npm run dev -- --port 3000"), "npm run dev");
      assert.equal(leftovers.programOf("node -e setInterval(()=>{},1000)"), "node");
      assert.equal(leftovers.programOf("/opt/bin/vite --host"), "vite");
    });

    const W = "/work/tree";
    await check("a reused pid (same pid, another start) is not signalled", async () => {
      const { system, procs, signals, add } = fakeSystem();
      add(501, { cwd: W });
      const [entry] = await leftovers.describeLeftovers(system, W, [501], new Map());
      procs.get(501).start = "another";
      const failed = await leftovers.stopLeftovers(system, W, [entry]);
      assert.deepEqual(signals, []);
      assert.deepEqual(failed, []);
      assert.equal(procs.has(501), true);
    });

    await check("a process whose folder moved out of the worktree is not signalled", async () => {
      const { system, procs, signals, add } = fakeSystem();
      add(502, { cwd: `${W}/sub` });
      const [entry] = await leftovers.describeLeftovers(system, W, [502], new Map());
      procs.get(502).cwd = "/work/tree-other";
      await leftovers.stopLeftovers(system, W, [entry]);
      assert.deepEqual(signals, []);
    });

    await check("SIGTERM first, SIGKILL after the grace, and one that survives both is named", async () => {
      const { system, signals, add } = fakeSystem();
      add(503, { cwd: W, ignoresTerm: true });
      add(504, { cwd: W, unkillable: true });
      const list = await leftovers.describeLeftovers(system, W, [503, 504], new Map());
      const failed = await leftovers.stopLeftovers(system, W, list);
      // Each leads a group of its own, so the group is signalled.
      assert.deepEqual(signals, [[-503, "SIGTERM"], [-504, "SIGTERM"], [-503, "SIGKILL"], [-504, "SIGKILL"]]);
      assert.deepEqual(failed.map(({ entry, why }) => [entry.pid, why]), [[504, "it did not stop, even when forced"]]);
    });

    await check("a group is signalled whole only when every member was confirmed", async () => {
      const { system, signals, add } = fakeSystem();
      add(510, { cwd: W, group: 510 });
      add(511, { cwd: W, group: 510, parentPid: 510 });
      let list = await leftovers.describeLeftovers(system, W, [510, 511], new Map());
      await leftovers.stopLeftovers(system, W, list);
      assert.deepEqual(signals, [[-510, "SIGTERM"]]);
      const other = fakeSystem();
      other.add(520, { cwd: W, group: 520 });
      other.add(521, { cwd: "/elsewhere", group: 520, parentPid: 520 });
      list = await leftovers.describeLeftovers(other.system, W, [520], new Map());
      await leftovers.stopLeftovers(other.system, W, list);
      assert.deepEqual(other.signals, [[520, "SIGTERM"]]);
      assert.equal(other.procs.has(521), true, "the member outside the worktree runs on");
    });

    await check("Codara, a pane's shell and what runs in a pane are never stopped; an agent's child is named", async () => {
      const { system, add } = fakeSystem();
      system.sessions.add(600).add(700);
      add(600, { cwd: W, command: "/bin/zsh -l", parentPid: 100 });
      add(601, { cwd: W, command: "npm run dev", parentPid: 600 });
      add(700, { cwd: "/home", command: "claude --resume", parentPid: 100 });
      add(701, { cwd: "/home", command: "/bin/bash -c node server.js", parentPid: 700 });
      add(702, { cwd: W, parentPid: 701 });
      add(800, { cwd: W, command: "git status", parentPid: 100 });
      add(900, { cwd: "/elsewhere", command: "tail -f log.txt" });
      const panes = new Map([[600, "the tab “shell” in Repo"], [700, "the tab “agent” in Other"]]);
      const list = await leftovers.describeLeftovers(system, W, [600, 601, 702, 800, 900, 4040], panes);
      const by = Object.fromEntries(list.map((entry) => [entry.pid, entry]));
      assert.equal(by[600].blocked, "it is the terminal of the tab “shell” in Repo. Close that tab first");
      assert.equal(by[601].blocked, "it runs in the tab “shell” in Repo. Stop it there first");
      assert.equal(by[702].blocked, undefined);
      assert.equal(by[702].startedBy, "started by an agent that is still open: the tab “agent” in Other");
      assert.equal(by[702].orphan, false);
      assert.equal(by[800].blocked, "it is part of Codara");
      assert.equal(by[900].blocked, "it only has a file open in it. Close that file first");
      assert.equal(by[4040], undefined, "a process already gone is left out");
    });

    // ── Clean up from the rail ──────────────────────────────────────────
    const origin = path.join(scratch, "origin.git");
    const repo = path.join(scratch, "repo");
    const trees = path.join(scratch, "trees");
    fs.mkdirSync(trees);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, "README.md", "# test\n", "init");
    commitFile(repo, ".gitignore", ".env\n", "ignore");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    const fake = fakeSystem();
    const h = {
      state: {
        workspaces: [{ id: "ws-repo", name: "Repo", cwd: repo, color: "#123456", workers: [] }],
        activeWorkspaceId: "ws-repo",
        workspaceRailOrder: ["ws-repo"],
      },
      terminals: [],
      now: new Date(Date.now() + HOUR),
    };
    const isUnder = (candidate, dir) => candidate === dir || candidate.startsWith(`${dir}/`);
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      publishState: () => undefined,
      invalidateGitCache: () => undefined,
      listRuns: async () => [],
      sessionCwd: () => null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => h.terminals,
      workspaceHeld: async () => false,
      processesUnderCwds: async (dirs) =>
        new Map(
          dirs.map((dir) => [
            dir,
            [...fake.procs.values()].filter((entry) => entry.pid !== 100 && isUnder(entry.cwd, dir)).map(({ pid, command }) => ({ pid, command })),
          ]),
        ),
      runningServers: () => 0,
      pullRequests: async () => ({ open: [], merged: [] }),
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      audit: agent.createWorktreeAuditLog(path.join(scratch, "audit.jsonl")),
      now: () => h.now,
      leftovers: fake.system,
    };
    const has = (id) => h.state.workspaces.some((workspace) => workspace.id === id);
    const merged = (id) => {
      const branch = `feature/${id}`;
      const dir = path.join(trees, id);
      git(repo, ["worktree", "add", "-q", dir, "-b", branch]);
      h.state.workspaces.push({
        id,
        name: id,
        cwd: dir,
        color: "#123456",
        workers: [],
        copyBranch: { repoCwd: repo, branch, baseBranch: "main", city: id, mode: "fork", createdAt: CREATED_AT, createdBy: { kind: "user" } },
      });
      commitFile(dir, `${id}.txt`, `${id}\n`, `${id} work`);
      git(repo, ["merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch]);
      git(repo, ["push", "-q", "origin", "main"]);
      return dir;
    };
    const click = (id, extra = {}) => rail.cleanUpRailWorkspace(deps, { workspaceId: id, mode: "manual", ...extra });

    const served = merged("served");
    fake.add(4242, { cwd: served });
    fake.add(4343, { cwd: "/elsewhere" });
    let asked;
    await check("a process alone holding a merged worktree is named in a confirm, and nothing is stopped yet", async () => {
      asked = await click("served");
      assert.equal(asked.status, "confirm", asked.message);
      assert.equal(asked.code, "CONFIRM_STOP");
      assert.equal(asked.processes.length, 1);
      assert.equal(asked.processes[0].program, "node server.js");
      assert.equal(asked.processes[0].runningMs, 3 * HOUR);
      assert.doesNotMatch(JSON.stringify(asked), /FAKE_SECRET/);
      assert.deepEqual(fake.signals, []);
      assert.equal(fs.existsSync(served), true);
    });

    await check("a preview reads only: it asks the same, and a clean worktree reads READY", async () => {
      const preview = await click("served", { preview: true });
      assert.equal(preview.stopFingerprint, asked.stopFingerprint);
      const clean = merged("clean");
      assert.deepEqual([(await click("clean", { preview: true })).code, fs.existsSync(clean)], ["READY", true]);
      assert.equal((await click("clean")).status, "removed");
    });

    await check("a list that changed since the question asks again and stops nothing", async () => {
      fake.add(4244, { cwd: served, command: "node worker.js", parentPid: 4242, group: 4242 });
      const again = await click("served", { confirmStop: asked.stopFingerprint });
      assert.equal(again.status, "confirm");
      assert.equal(again.message, "It changed since you were asked.");
      assert.deepEqual(again.processes.map((entry) => entry.program), ["node server.js", "node worker.js"]);
      assert.deepEqual(fake.signals, []);
      asked = again;
    });

    await check("the yes stops exactly those processes, then the worktree and its branch go", async () => {
      const done = await click("served", { confirmStop: asked.stopFingerprint });
      assert.equal(done.status, "removed", done.message);
      assert.deepEqual(fake.signals, [[-4242, "SIGTERM"]]);
      assert.equal(fake.procs.has(4343), true, "a process outside runs on");
      assert.equal(fs.existsSync(served), false);
      assert.equal(has("served"), false);
    });

    await check("one that survives SIGKILL keeps the worktree, and says which", async () => {
      const stuck = merged("stuck");
      fake.add(5050, { cwd: stuck, command: "python3 app.py", unkillable: true });
      const first = await click("stuck");
      const result = await click("stuck", { confirmStop: first.stopFingerprint });
      assert.equal(result.status, "refused");
      assert.equal(result.code, "STOP_FAILED");
      assert.equal(result.message, "python3 app.py (pid 5050): it did not stop, even when forced. The worktree was kept.");
      assert.equal(fs.existsSync(stuck), true);
      fake.procs.delete(5050);
    });

    await check("an ignored file and a leftover are asked about together, and both answers are needed", async () => {
      const both = merged("both");
      fs.writeFileSync(path.join(both, ".env"), "LOCAL=1\n");
      fake.add(6060, { cwd: both });
      const ask = await click("both");
      assert.deepEqual([ask.status, ask.holds, ask.processes.length], ["confirm", [".env"], 1]);
      const half = await click("both", { confirmStop: ask.stopFingerprint });
      assert.equal(half.status, "confirm", "the .env was not confirmed");
      assert.equal(fake.procs.has(6060), true);
      const done = await click("both", { confirmStop: ask.stopFingerprint, confirmIgnored: ask.fingerprint });
      assert.equal(done.status, "removed", done.message);
      assert.equal(fs.existsSync(both), false);
    });

    await check("uncommitted work, or a program in a pane, still refuses as before and stops nothing", async () => {
      const dirty = merged("dirty");
      fs.writeFileSync(path.join(dirty, "notes.txt"), "draft\n");
      fake.add(7070, { cwd: dirty });
      const signals = fake.signals.length;
      const result = await click("dirty");
      assert.equal(result.status, "refused");
      assert.match(result.message, /uncommitted work/);
      fs.rmSync(path.join(dirty, "notes.txt"));
      fake.procs.get(7070).parentPid = 8000;
      fake.add(8000, { cwd: dirty, command: "/bin/bash", parentPid: 100 });
      fake.system.sessions.add(8000);
      const pane = await click("dirty");
      assert.equal(pane.status, "refused");
      assert.match(pane.message, /node server\.js \(pid 7070\) runs in it, and it runs in a terminal tab\. Stop it there first\./);
      assert.equal(fake.signals.length, signals);
      assert.equal(fs.existsSync(dirty), true);
    });

    await check("on its own, it stops only orphans; anything a tab leads to waits for a click", async () => {
      const ON = { autoRemoveMerged: { enabled: true, minUptimeMs: 0 } };
      const auto = (id) => rail.cleanUpRailWorkspace(deps, { workspaceId: id, mode: "auto-merged" }, ON);
      const led = merged("led");
      fake.add(9001, { cwd: led, parentPid: 8000 });
      const stays = await auto("led");
      assert.equal(stays.status, "refused");
      assert.equal(fs.existsSync(led), true);
      assert.equal(fake.procs.has(9001), true);
      const orphaned = merged("orphaned");
      fake.add(9002, { cwd: orphaned, parentPid: 1 });
      const gone = await auto("orphaned");
      assert.equal(gone.status, "removed", gone.message);
      assert.equal(fake.procs.has(9002), false);
      assert.equal(fs.existsSync(orphaned), false);
    });

    // ── A real process ──────────────────────────────────────────────────
    // The test runner is the child's parent here, not Codara: Codara stands
    // for a pid nothing uses.
    const real = leftovers.systemLeftovers({ appPid: 0x3ffffe, sessionPids: () => [] });
    if (!real) {
      console.log("skip - a real process (no process scan on this platform)");
    } else {
      await check("a real leftover process is found, named and stopped by its exact pid", async () => {
        const dir = fs.mkdtempSync(path.join(scratch, "real-"));
        const script = path.join(scratch, "server.js");
        fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
        child = spawn(process.execPath, [script], { cwd: dir, detached: true, stdio: "ignore" });
        await new Promise((done) => setTimeout(done, 300));
        const list = await leftovers.describeLeftovers(real, dir, [child.pid], new Map());
        assert.equal(list.length, 1);
        assert.equal(list[0].program, "node server.js");
        assert.equal(list[0].blocked, undefined);
        const exited = new Promise((done) => child.once("exit", done));
        assert.deepEqual(await leftovers.stopLeftovers(real, dir, list), []);
        await exited;
        child = null;
      });
    }
  } finally {
    if (child?.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    for (const { outfile } of bundles) fs.rmSync(outfile, { force: true });
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
