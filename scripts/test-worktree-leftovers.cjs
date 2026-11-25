// Processes left running in a merged worktree (src/main/worktree-cleanup/
// leftovers.ts, and rail.ts's Clean up around it). The invariant: a signal
// reaches a process only when, right before it, the process has the pid,
// start time and command line the user confirmed and still works inside the
// worktree; never a whole group; a read that fails is never an exit; and the
// worktree goes only after a fresh, complete check finds nothing running. Driven against throwaway
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
    facts: async (pid) => {
      if (system.unreadable.has(pid)) throw new Error("EACCES");
      const entry = procs.get(pid);
      if (!entry) return null;
      return { ...entry, tty: entry.tty ?? null, argv: entry.argv ?? entry.command.split(/\s+/), argvExact: entry.argvExact ?? true, argvKey: entry.argvKey ?? entry.command };
    },
    unreadable: new Set(),
    table: async () => [...procs.values()].map(({ pid, parentPid }) => ({ pid, parentPid })),
    // As the real one: sent only while, at that moment, it has that start and
    // those arguments and works inside the worktree.
    signalOne: (pid, signal, expect) => {
      const entry = procs.get(pid);
      const inside = (cwd, dir) => typeof cwd === "string" && (cwd === dir || cwd.startsWith(`${dir}/`));
      if (!entry || entry.start !== expect.start || (entry.argvKey ?? entry.command) !== expect.commandKey || !inside(entry.cwd, expect.real)) {
        return "it changed since you said yes, so it was not stopped";
      }
      if ((entry.tty ?? null) !== expect.tty) return "a terminal was attached to it since you said yes, so it was not stopped";
      signals.push([pid, signal]);
      if (!(entry.unkillable || (signal === "SIGTERM" && entry.ignoresTerm))) procs.delete(pid);
      return true;
    },
    // One call for all targets, as the real one reads them together.
    signal: (targets, signal, real) => {
      system.batches.push(targets.map((target) => target.pid));
      return new Map(targets.map((target) => [target.pid, system.signalOne(target.pid, signal, { ...target, real })]));
    },
    batches: [],
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
      start: `s${pid}`,
      startedAtMs: clock - 3 * HOUR,
      cwd: "/nowhere",
      command: "node server.js --token=FAKE_SECRET",
      zombie: false,
      ...extra,
    });
  // Codara runs under the user's service manager, where orphans land too.
  procs.set(50, { pid: 50, parentPid: 1, start: "sd", startedAtMs: 0, cwd: "/", command: "/usr/lib/systemd/systemd --user", zombie: false });
  procs.set(100, { pid: 100, parentPid: 50, start: "app", startedAtMs: 0, cwd: "/", command: "codara", zombie: false });
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
      assert.equal(leftovers.programOf(["/usr/bin/node", "/srv/app/server.js", "--token=FAKE_SECRET"]), "node server.js");
      assert.equal(leftovers.programOf(["npm", "run", "dev", "--", "--port", "3000"]), "npm run dev");
      assert.equal(leftovers.programOf(["node", "-e", "setInterval(()=>{},1000)"]), "node");
      assert.equal(leftovers.programOf(["/opt/bin/vite", "--host"]), "vite");
      // Past an option, a word may be its value: only the program then.
      assert.equal(leftovers.programOf(["node", "--eval=run()", "FAKE_TOKEN"]), "node");
      assert.equal(leftovers.programOf(["python3", "-c", "FAKE_TOKEN"]), "python3");
      // By the real argument boundaries: a blank script name hides nothing behind it.
      assert.equal(leftovers.programOf(["node", " ", "FAKE_TOKEN"]), "node");
      assert.equal(leftovers.programOf(["node", "dir/ FAKE_TOKEN"]), "node");
      // From a flattened line (macOS), no word can be placed: the program only.
      assert.equal(leftovers.programOf(["node", "server.js"], false), "node");
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

    await check("the same pid and start with another command line is not signalled, nor confirmed", async () => {
      const { system, procs, signals, add } = fakeSystem();
      add(509, { cwd: W, command: "node before.js" });
      const [entry] = await leftovers.describeLeftovers(system, W, [509], new Map());
      const asked = leftovers.leftoverFingerprint(W, [entry]);
      procs.get(509).command = "node after.js";
      await leftovers.stopLeftovers(system, W, [entry]);
      assert.deepEqual(signals, []);
      const [now] = await leftovers.describeLeftovers(system, W, [509], new Map());
      assert.notEqual(leftovers.leftoverFingerprint(W, [now]), asked, "a yes to before.js is not a yes to after.js");
    });

    await check("arguments or folder that change at the signal itself stop it", async () => {
      for (const change of [(entry) => (entry.argvKey = "node other.js"), (entry) => (entry.cwd = "/elsewhere")]) {
        const { system, procs, signals, add } = fakeSystem();
        add(513, { cwd: W });
        const [entry] = await leftovers.describeLeftovers(system, W, [513], new Map());
        const send = system.signalOne;
        system.signalOne = (pid, signal, expect) => {
          change(procs.get(pid));
          return send(pid, signal, expect);
        };
        await leftovers.stopLeftovers(system, W, [entry]);
        assert.deepEqual(signals, []);
      }
    });

    await check("the arguments are bound as raw bytes", async () => {
      // Both decode to the same text ("n" and a replacement character).
      const a = Buffer.from([0x6e, 0xff]);
      const b = Buffer.from([0x6e, 0xfe]);
      assert.equal(a.toString("utf8"), b.toString("utf8"));
      assert.notEqual(leftovers.argvKeyOf(a), leftovers.argvKeyOf(b));
    });

    await check("a pid that changes hands at the signal itself is not signalled", async () => {
      const { system, procs, signals, add } = fakeSystem();
      add(512, { cwd: W });
      const [entry] = await leftovers.describeLeftovers(system, W, [512], new Map());
      // Every read before agrees; the start differs only at delivery.
      const realSignal = system.signalOne;
      system.signalOne = (pid, signal, expect) => {
        procs.get(pid).start = "reused";
        return realSignal(pid, signal, expect);
      };
      await leftovers.stopLeftovers(system, W, [entry]);
      assert.deepEqual(signals, []);
      assert.equal(procs.has(512), true);
    });

    await check("a path that only looks inside (a backslash, another case) is not inside", async () => {
      const { system, add } = fakeSystem();
      add(530, { cwd: "/work/tree\\other" });
      add(531, { cwd: "/work/Tree" });
      add(532, { cwd: "/work/tree (deleted)" });
      const list = await leftovers.describeLeftovers(system, W, [530, 531, 532], new Map());
      assert.deepEqual(list.map((entry) => Boolean(entry.blocked)), [true, true, true]);
    });

    await check("a read that fails is never taken for an exit", async () => {
      const { system, signals, add } = fakeSystem();
      add(540, { cwd: W, ignoresTerm: true });
      const list = await leftovers.describeLeftovers(system, W, [540], new Map());
      const realSignal = system.signalOne;
      system.signalOne = (pid, signal, expect) => {
        const sent = realSignal(pid, signal, expect);
        system.unreadable.add(pid);
        return sent;
      };
      const failed = await leftovers.stopLeftovers(system, W, list);
      assert.deepEqual(failed.map(({ entry, why }) => [entry.pid, why]), [[540, "whether it stopped could not be read"]]);
      assert.deepEqual(signals, [[540, "SIGTERM"]], "nothing more is sent to what cannot be read");
      // Alive and the same, but its folder no longer reads: unknown too.
      const second = fakeSystem();
      second.add(542, { cwd: W, ignoresTerm: true });
      const listed = await leftovers.describeLeftovers(second.system, W, [542], new Map());
      const sendTerm = second.system.signalOne;
      second.system.signalOne = (pid, signal, expect) => {
        const sent = sendTerm(pid, signal, expect);
        second.procs.get(pid).cwd = null;
        return sent;
      };
      const unknown = await leftovers.stopLeftovers(second.system, W, listed);
      assert.deepEqual(unknown.map(({ why }) => why), ["whether it stopped could not be read"]);
      system.unreadable.add(541);
      const [unread] = await leftovers.describeLeftovers(system, W, [541], new Map());
      assert.equal(unread.blocked, "it could not be read");
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
      assert.deepEqual(signals, [[503, "SIGTERM"], [504, "SIGTERM"], [503, "SIGKILL"], [504, "SIGKILL"]]);
      assert.deepEqual(failed.map(({ entry, why }) => [entry.pid, why]), [[504, "it did not stop, even when forced"]]);
    });

    await check("only the confirmed pids are signalled, never their group", async () => {
      const { system, procs, signals, add } = fakeSystem();
      add(510, { cwd: W });
      const list = await leftovers.describeLeftovers(system, W, [510], new Map());
      // A worker forked after the question, in the same group.
      add(511, { cwd: "/elsewhere", parentPid: 510 });
      await leftovers.stopLeftovers(system, W, list);
      assert.deepEqual(signals, [[510, "SIGTERM"]]);
      assert.equal(procs.has(511), true);
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
      assert.equal(by[800].blocked, "it is part of Codara");
      assert.equal(by[900].blocked, "it only has a file open in it. Close that file first");
      assert.equal(by[4040], undefined, "a process already gone is left out");
      // One that lost its parent hangs beside Codara, not below it.
      add(950, { cwd: W, parentPid: 50 });
      const [beside] = await leftovers.describeLeftovers(system, W, [950], panes);
      assert.equal(beside.blocked, undefined, "a process beside Codara is not Codara's");
    });

    await check("outside the panes, a shell or anything with a terminal is named, never offered; a detached orphan is", async () => {
      const { system, add } = fakeSystem();
      add(960, { cwd: W, command: "vim notes.md", tty: "34817" });
      add(961, { cwd: W, command: "/usr/bin/zsh" });
      add(962, { cwd: W, command: "-bash" });
      add(963, { cwd: W, command: "node server.js", parentPid: 1 });
      const list = await leftovers.describeLeftovers(system, W, [960, 961, 962, 963], new Map());
      const by = Object.fromEntries(list.map((entry) => [entry.pid, entry]));
      for (const pid of [960, 961, 962]) assert.equal(by[pid].blocked, leftovers.ELSEWHERE, String(pid));
      assert.equal(by[963].blocked, undefined, "a detached orphan with no terminal is offered");
    });

    await check("below a pane, at any depth, only what an agent started is offered", async () => {
      const { system, add } = fakeSystem();
      system.sessions.add(610);
      add(610, { cwd: "/home", command: "/bin/zsh -l", parentPid: 100, tty: "34818" });
      add(611, { cwd: W, command: "npm run dev", parentPid: 610, tty: "34818" });
      add(612, { cwd: W, command: "node server.js", parentPid: 611, tty: "34818" });
      // An agent in the chain: offered, though the pane's terminal is attached.
      add(613, { cwd: "/home", command: "claude", parentPid: 610, tty: "34818" });
      add(614, { cwd: W, command: "node dev.js", parentPid: 613, tty: "34818" });
      const panes = new Map([[610, "the tab “shell” in Repo"]]);
      const list = await leftovers.describeLeftovers(system, W, [612, 614], panes);
      const by = Object.fromEntries(list.map((entry) => [entry.pid, entry]));
      assert.equal(by[612].blocked, "it runs in the tab “shell” in Repo. Stop it there first", "a pane grandchild is the user's");
      assert.equal(by[614].blocked, undefined);
      assert.equal(by[614].tty, "34818");
    });

    await check("a terminal attached after the yes stops it, with why", async () => {
      const { system, procs, signals, add } = fakeSystem();
      add(970, { cwd: W });
      const list = await leftovers.describeLeftovers(system, W, [970], new Map());
      procs.get(970).tty = "34819";
      const failed = await leftovers.stopLeftovers(system, W, list);
      assert.deepEqual(signals, []);
      assert.deepEqual(failed.map(({ why }) => why), ["a terminal was attached to it since you said yes, so it was not stopped"]);
      // Attached at the signal itself: the system's own re-read refuses too.
      const second = fakeSystem();
      second.add(971, { cwd: W });
      const listed = await leftovers.describeLeftovers(second.system, W, [971], new Map());
      const send = second.system.signalOne;
      second.system.signalOne = (pid, signal, expect) => {
        second.procs.get(pid).tty = "34820";
        return send(pid, signal, expect);
      };
      const late = await leftovers.stopLeftovers(second.system, W, listed);
      assert.deepEqual(second.signals, []);
      assert.match(late[0].why, /terminal was attached/);
    });

    await check("all are re-read in one call at the signal, and one that did not answer in time is named, not signalled", async () => {
      const { system, signals, add } = fakeSystem();
      add(980, { cwd: W });
      add(981, { cwd: W });
      const list = await leftovers.describeLeftovers(system, W, [980, 981], new Map());
      system.signalOne = () => "the system did not answer in time, so it was not stopped";
      const failed = await leftovers.stopLeftovers(system, W, list);
      assert.deepEqual(signals, []);
      assert.deepEqual(system.batches[0], [980, 981], "one read for both");
      assert.deepEqual(failed.map(({ entry, why }) => [entry.pid, why]), [
        [980, "the system did not answer in time, so it was not stopped"],
        [981, "the system did not answer in time, so it was not stopped"],
      ]);
    });

    await check("macOS re-reads every pid with one ps and one lsof, each cut short", async () => {
      const calls = [];
      const target = (pid, extra = {}) => ({ pid, start: "Mon Nov 24 10:00:00 2026", commandKey: leftovers.argvKeyOf(`node s${pid}.js`), tty: null, ...extra });
      const exec = (file, args) => {
        calls.push([file, args]);
        if (file === "ps") {
          return {
            timedOut: false,
            stdout: [
              "  990 ??       Mon Nov 24 10:00:00 2026 node s990.js",
              "  991 ttys003  Mon Nov 24 10:00:00 2026 node s991.js",
              "  992 ??       Mon Nov 24 10:00:00 2026 node s992.js",
            ].join("\n"),
          };
        }
        return { timedOut: false, stdout: ["p990", "fcwd", `n${W}/app`, "p991", "fcwd", `n${W}`, "p992", "fcwd", "n/work/tree-2"].join("\n") };
      };
      const verdicts = leftovers.macSameNow([target(990), target(991), target(992)], W, exec);
      assert.deepEqual(calls.map(([file, args]) => [file, args[args.indexOf("-p") + 1]]), [["ps", "990,991,992"], ["/usr/sbin/lsof", "990,991,992"]]);
      assert.equal(verdicts.get(990), true);
      assert.match(verdicts.get(991), /terminal was attached/);
      assert.match(verdicts.get(992), /changed since you said yes/, "a sibling folder is not inside");
      const slow = leftovers.macSameNow([target(990)], W, () => ({ timedOut: true, stdout: "" }));
      assert.equal(slow.get(990), "the system did not answer in time, so it was not stopped");
      assert.equal(leftovers.SIGNAL_READ_TIMEOUT_MS <= 500, true);
    });

    await check("a sibling whose name only starts like the worktree is not inside it", async () => {
      const { system, add } = fakeSystem();
      add(985, { cwd: "/work/tree-2" });
      add(986, { cwd: "/work/tree 2" });
      const list = await leftovers.describeLeftovers(system, W, [985, 986], new Map());
      assert.deepEqual(list.map((entry) => entry.blocked), ["it only has a file open in it. Close that file first", "it only has a file open in it. Close that file first"]);
    });

    await check("the scan keeps a folder it cannot place as unknown where its text points, and holds nothing with no text", async () => {
      const T = path.join(scratch, "work", "tree");
      fs.mkdirSync(T, { recursive: true });
      const readers = {
        platform: "linux",
        list: async () => [
          { pid: 771, parentPid: 1, command: "node server.js" },
          { pid: 772, parentPid: 1, command: "ssh-agent" },
          { pid: 773, parentPid: 1, command: "node sibling.js" },
          { pid: 774, parentPid: 1, command: "node gone.js" },
        ],
        cwds: async () =>
          Object.assign(new Map(), {
            unknown: new Map([
              [771, `${T}/sub (deleted)`],
              [772, null],
              // Siblings whose names only start the same are not inside.
              [773, `${T} 2`],
              [774, `${T}-2 (deleted)`],
            ]),
          }),
        readdir: async () => [],
        readlink: async () => {
          throw new Error("EACCES");
        },
      };
      const scan = await agent.scanProcessesUnderCwds([T, "/work/other"], { appPid: 0x3ffffe, sessionPids: [], readers });
      assert.deepEqual(scan.get(T), [], "never placed inside by its text");
      assert.deepEqual(scan.cwdUnknown.get(T).map((use) => use.pid), [771]);
      assert.equal(scan.cwdUnknown.has("/work/other"), false);
      const siblings = await agent.scanProcessesUnderCwds([T], { appPid: 0x3ffffe, sessionPids: [], readers });
      assert.deepEqual(siblings.cwdUnknown.get(T).map((use) => use.pid), [771], "not /work/tree 2 nor /work/tree-2");
      assert.deepEqual(scan.cwdUnreadable.map((use) => use.pid), [772]);
      const one = await agent.scanProcessesUnderCwd(T, { appPid: 0x3ffffe, sessionPids: [], readers });
      assert.deepEqual(one.map((use) => use.pid), [771], "the agent tools' check counts it as a use");
      fs.rmdirSync(T);
      const gone = await agent.scanProcessesUnderCwd(T, { appPid: 0x3ffffe, sessionPids: [], readers });
      assert.deepEqual(gone.map((use) => use.pid), [], "not once the folder is gone");
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
    const isUnder = (candidate, dir) => typeof candidate === "string" && (candidate === dir || candidate.startsWith(`${dir}/`));
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
            [...fake.procs.values()].filter((entry) => entry.pid !== 100 && entry.pid !== 50 && isUnder(entry.cwd, dir)).map(({ pid, command }) => ({ pid, command })),
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
      fake.add(4244, { cwd: served, command: "node worker.js", parentPid: 4242 });
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
      assert.deepEqual(fake.signals, [[4242, "SIGTERM"], [4244, "SIGTERM"]]);
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

    await check("after a stop, an unreadable scan keeps the worktree", async () => {
      const blind = merged("blind");
      fake.add(6161, { cwd: blind });
      const ask = await click("blind");
      const original = deps.processesUnderCwds;
      deps.processesUnderCwds = async (dirs) => {
        const found = await original(dirs);
        return fake.signals.some(([pid]) => pid === 6161) ? Object.assign(found, { openFilesUnknown: true }) : found;
      };
      try {
        const result = await click("blind", { confirmStop: ask.stopFingerprint });
        assert.equal(result.status, "refused");
        assert.match(result.message, /could not be read in full, so it was kept/);
        assert.equal(fs.existsSync(blind), true);
      } finally {
        deps.processesUnderCwds = original;
      }
    });

    await check("a process whose folder cannot be placed keeps the worktree, named, and is not signalled", async () => {
      const unplaced = merged("unplaced");
      fake.add(6363, { cwd: null, command: "node server.js" });
      const original = deps.processesUnderCwds;
      deps.processesUnderCwds = async (dirs) =>
        Object.assign(await original(dirs), { cwdUnknown: new Map(dirs.map((dir) => [dir, [{ pid: 6363, command: "node server.js" }]])) });
      const signalled = fake.signals.length;
      try {
        const result = await click("unplaced");
        assert.equal(result.status, "refused");
        assert.equal(result.message, "node server.js (pid 6363) runs in it, and its folder cannot be read. Stop it yourself, then Clean up again.");
        assert.equal(fake.signals.length, signalled);
        assert.equal(fs.existsSync(unplaced), true);
      } finally {
        deps.processesUnderCwds = original;
        fake.procs.delete(6363);
      }
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

    await check("a row whose folder is gone is cleaned (or, unattended, left as on main) though a process points into the deleted folder", async () => {
      for (const mode of ["manual", "auto-merged"]) {
        const id = `vanished-${mode}`;
        const dir = merged(id);
        fs.rmSync(dir, { recursive: true, force: true });
        // The scan cannot place it: its link reads "<dir> (deleted)".
        fake.add(6464, { cwd: null, command: "node server.js" });
        const original = deps.processesUnderCwds;
        deps.processesUnderCwds = async (dirs) =>
          Object.assign(await original(dirs), { cwdUnknown: new Map(dirs.map((entry) => [entry, [{ pid: 6464, command: "node server.js" }]])) });
        const signalled = fake.signals.length;
        try {
          const result =
            mode === "manual"
              ? await click(id)
              : await rail.cleanUpRailWorkspace(deps, { workspaceId: id, mode }, { autoRemoveMerged: { enabled: true, minUptimeMs: 0 } });
          if (mode === "manual") {
            assert.equal(result.status, "removed", `${mode}: ${result.message}`);
            assert.equal(has(id), false);
          } else {
            // As on main: the unattended mode leaves a gone folder to a click, and says so, not "in use".
            assert.equal(result.message, "The folder is gone.");
          }
          assert.equal(fake.signals.length, signalled, "nothing is signalled for a gone folder");
        } finally {
          deps.processesUnderCwds = original;
          fake.procs.delete(6464);
        }
      }
    });

    await check("a row READY at the check that gained a process before the click asks again and stops nothing", async () => {
      const late = merged("late");
      assert.equal((await click("late", { preview: true })).code, "READY");
      fake.add(6565, { cwd: late, command: "node late.js" });
      const signalled = fake.signals.length;
      // The fold's yes to a READY row carries no fingerprint.
      const again = await click("late", {});
      assert.equal(again.status, "confirm");
      assert.equal(again.code, "CONFIRM_STOP");
      assert.deepEqual(again.processes.map((entry) => entry.program), ["node late.js"]);
      assert.equal(fake.signals.length, signalled);
      assert.equal(fs.existsSync(late), true);
      const done = await click("late", { confirmStop: again.stopFingerprint });
      assert.equal(done.status, "removed", done.message);
    });

    await check("on its own, it stops nothing: whatever runs in it waits for a click", async () => {
      const ON = { autoRemoveMerged: { enabled: true, minUptimeMs: 0 } };
      const auto = (id) => rail.cleanUpRailWorkspace(deps, { workspaceId: id, mode: "auto-merged" }, ON);
      const led = merged("led");
      fake.add(9001, { cwd: led, parentPid: 8000 });
      const orphaned = merged("orphaned");
      fake.add(9002, { cwd: orphaned, parentPid: 1 });
      const signalled = fake.signals.length;
      for (const [id, dir, pid] of [["led", led, 9001], ["orphaned", orphaned, 9002]]) {
        const stays = await auto(id);
        assert.equal(stays.status, "refused");
        assert.equal(fs.existsSync(dir), true);
        assert.equal(fake.procs.has(pid), true);
      }
      assert.equal(fake.signals.length, signalled);
    });

    await check("after a yes to stopping, an unreadable scan stops and removes nothing", async () => {
      const unseen = merged("unseen");
      fake.add(6262, { cwd: unseen });
      const ask = await click("unseen");
      const original = deps.processesUnderCwds;
      deps.processesUnderCwds = async (dirs) => Object.assign(await original(dirs), { openFilesUnknown: true });
      try {
        const result = await click("unseen", { confirmStop: ask.stopFingerprint });
        assert.equal(result.status, "refused");
        assert.match(result.message, /could not be read in full, so it was kept/);
        assert.equal(fake.procs.has(6262), true);
        assert.equal(fs.existsSync(unseen), true);
      } finally {
        deps.processesUnderCwds = original;
      }
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
        assert.equal(list[0].program, process.platform === "linux" ? "node server.js" : "node");
        assert.equal(list[0].blocked, undefined);
        // Read again at the signal itself: another start, other arguments or
        // another folder sends nothing.
        const bound = { pid: child.pid, start: list[0].start, commandKey: list[0].commandKey, tty: list[0].tty, real: dir };
        assert.equal(bound.tty, null, "a detached child has no terminal");
        for (const wrong of [{ start: "not-its-start" }, { commandKey: "not-its-arguments" }, { real: path.join(scratch, "elsewhere") }, { tty: "34816" }]) {
          const { real: where, ...target } = { ...bound, ...wrong };
          const verdict = real.signal([target], "SIGTERM", where).get(child.pid);
          assert.equal(typeof verdict, "string", JSON.stringify(wrong));
        }
        await new Promise((done) => setTimeout(done, 100));
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        const exited = new Promise((done) => child.once("exit", done));
        assert.deepEqual(await leftovers.stopLeftovers(real, dir, list), []);
        await exited;
        child = null;
      });

      await check("a worktree reached through a symlink: by the link's text nothing is signalled, with why", async () => {
        const dir = fs.mkdtempSync(path.join(scratch, "target-"));
        const link = path.join(scratch, `link-${path.basename(dir)}`);
        fs.symlinkSync(dir, link);
        const script = path.join(scratch, "server.js");
        child = spawn(process.execPath, [script], { cwd: link, detached: true, stdio: "ignore" });
        await new Promise((done) => setTimeout(done, 300));
        const [entry] = await leftovers.describeLeftovers(real, link, [child.pid], new Map());
        assert.equal(entry.blocked, "it only has a file open in it. Close that file first");
        const target = { pid: child.pid, start: entry.start, commandKey: entry.commandKey, tty: entry.tty };
        assert.equal(typeof real.signal([target], "SIGTERM", link).get(child.pid), "string");
        await new Promise((done) => setTimeout(done, 100));
        assert.equal(child.exitCode, null, "still running");
        // Codara reads the worktree's real path first (canonicalPath): there it is offered.
        const [placed] = await leftovers.describeLeftovers(real, fs.realpathSync(link), [child.pid], new Map());
        assert.equal(placed.blocked, undefined);
        const exited = new Promise((done) => child.once("exit", done));
        process.kill(child.pid, "SIGKILL");
        await exited;
        child = null;
      });

      if (process.platform === "linux" && fs.existsSync("/bin/script")) {
        await check("a real process with a terminal attached and no pane above it is named, never offered", async () => {
          const dir = fs.mkdtempSync(path.join(scratch, "tty-"));
          const script = path.join(scratch, "server.js");
          // script(1) gives its child a terminal of its own, as a terminal app does.
          child = spawn("/bin/script", ["-qfec", `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, "/dev/null"], {
            cwd: dir,
            detached: true,
            stdio: ["pipe", "ignore", "ignore"],
          });
          let inner = null;
          try {
            for (let tries = 0; tries < 50 && !inner; tries += 1) {
              await new Promise((done) => setTimeout(done, 100));
              const kids = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
              inner = kids.length ? Number(kids[0]) : null;
            }
            assert.ok(inner, "the terminal's child started");
            const facts = await real.facts(inner);
            assert.notEqual(facts.tty, null, "tty_nr is read from /proc/<pid>/stat");
            const [entry] = await leftovers.describeLeftovers(real, dir, [inner], new Map());
            assert.equal(entry.blocked, leftovers.ELSEWHERE);
            const target = { pid: inner, start: entry.start, commandKey: entry.commandKey, tty: null };
            assert.match(real.signal([target], "SIGTERM", dir).get(inner), /terminal was attached/, "the terminal is read again at the signal");
            assert.equal(fs.existsSync(`/proc/${inner}`), true, "not signalled");
          } finally {
            if (inner) {
              try {
                process.kill(inner, "SIGKILL");
              } catch {
                /* already gone */
              }
            }
            const exited = new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", done)));
            try {
              process.kill(child.pid, "SIGKILL");
            } catch {
              /* already gone */
            }
            await exited;
            child = null;
          }
        });
      }

      if (process.platform === "linux") {
        await check("a process whose folder was deleted is unknown, never inside a look-alike", async () => {
          const gone = fs.mkdtempSync(path.join(scratch, "old-"));
          const script = path.join(scratch, "server.js");
          child = spawn(process.execPath, [script], { cwd: gone, detached: true, stdio: "ignore" });
          await new Promise((done) => setTimeout(done, 300));
          fs.rmdirSync(gone);
          // A real folder whose name is what the kernel prints for the deleted one.
          const lookalike = `${gone} (deleted)`;
          fs.mkdirSync(lookalike);
          const facts = await real.facts(child.pid);
          assert.equal(facts.cwd, null, "unknown, not the look-alike");
          const [entry] = await leftovers.describeLeftovers(real, lookalike, [child.pid], new Map());
          assert.equal(entry.blocked, "its folder cannot be read. Stop it yourself, then Clean up again");
          const scan = await agent.scanProcessesUnderCwds([lookalike], { appPid: 0x3ffffe, sessionPids: [] });
          assert.equal(scan.get(lookalike).some((use) => use.pid === child.pid), false, "not placed inside");
          assert.equal(scan.cwdUnknown?.get(lookalike)?.some((use) => use.pid === child.pid), true, "kept as unknown");
          const pid = child.pid;
          const exited = new Promise((done) => child.once("exit", done));
          process.kill(pid, "SIGKILL");
          await exited;
          child = null;
        });
      }
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
