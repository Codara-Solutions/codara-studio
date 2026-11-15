// The renderer's one git clock (src/renderer/src/git/gitRefreshClock.ts) and
// the fingerprints it compares (src/main/git-state.ts):
//   - a checkout on screen whose git state moves is re-read within 5 s;
//   - off-screen checkouts are compared every HIDDEN_EVERY ticks;
//   - nothing runs while the window is unfocused, and focus compares what is
//     on screen at once and leaves the rest to their next tick;
//   - the fingerprint moves on commit, stage, checkout, branch and remote
//     updates, and not on a working-tree edit or a `git status`;
//   - the branch is read from HEAD's file for a loose ref, never guessed.
//
//   node scripts/test-git-refresh-clock.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function load(dir, entry, name) {
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  return require(outfile);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-git-clock-"));
  try {
    const clockModule = await load(dir, "src/renderer/src/git/gitRefreshClock.ts", "clock");
    const state = await load(dir, "src/main/git-state.ts", "state");

    // ── The clock, with a scripted fingerprint source ──
    const signatures = new Map();
    let asked = [];
    const intervals = new Set();
    const env = {
      signatures: async (cwds) => {
        asked.push([...cwds]);
        return Object.fromEntries(cwds.map((cwd) => [cwd, signatures.get(cwd) ?? null]));
      },
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms);
        intervals.add(handle);
        return handle;
      },
      clearInterval: (handle) => {
        clearInterval(handle);
        intervals.delete(handle);
      },
    };
    const clock = clockModule.createGitRefreshClock(env);
    const seen = { visible: [], hidden: [] };
    signatures.set("/on-screen", "a");
    signatures.set("/off-screen", "x");
    const stopVisible = clock.watch({ cwds: ["/on-screen"], visible: true, onRefresh: (changed, reason) => seen.visible.push({ changed: [...changed], reason, at: Date.now() }) });
    const stopHidden = clock.watch({ cwds: ["/off-screen"], visible: false, onRefresh: (changed, reason) => seen.hidden.push({ changed: [...changed], reason }) });

    const hiddenTick = async () => {
      for (let i = 0; i < clockModule.HIDDEN_EVERY; i++) await clock.tick();
    };

    await check("an unfocused window starts no clock and reads nothing", async () => {
      assert.equal(intervals.size, 0);
      assert.equal(asked.length, 0);
    });

    await check("focus compares only what is on screen at once, and tells every watcher", async () => {
      await clock.focus();
      assert.deepEqual(asked.pop(), ["/on-screen"], "an off-screen checkout is not compared on focus");
      assert.equal(seen.visible.at(-1).reason, "focus");
      assert.equal(seen.hidden.at(-1).reason, "focus");
      assert.deepEqual(seen.visible.at(-1).changed, ["/on-screen"], "a first sighting counts as a change: the watcher's own read may predate it");
      assert.deepEqual(seen.hidden.at(-1).changed, [], "off screen: told of the focus, nothing to read yet");
      assert.equal(intervals.size, 1);
      // Its first comparison is its next off-screen tick.
      for (let i = 0; i < clockModule.HIDDEN_EVERY; i++) await clock.tick();
      assert.deepEqual(seen.hidden.at(-1), { changed: ["/off-screen"], reason: "tick" });
    });

    await check("a refocus after a change off screen re-reads nothing off screen until its tick", async () => {
      clock.pause();
      signatures.set("/off-screen", "x2");
      const before = seen.hidden.length;
      await clock.focus();
      assert.deepEqual(seen.hidden.slice(before).map((entry) => entry.changed), [[]]);
      for (let i = 0; i < clockModule.HIDDEN_EVERY; i++) await clock.tick();
      assert.deepEqual(seen.hidden.at(-1).changed, ["/off-screen"]);
    });

    await check("a change on screen reaches its watcher within 5 s, on the real timer", async () => {
      const changedAt = Date.now();
      signatures.set("/on-screen", "b");
      const deadline = changedAt + 5_000;
      while (Date.now() < deadline && !seen.visible.some((entry) => entry.changed.includes("/on-screen"))) await sleep(50);
      const hit = seen.visible.find((entry) => entry.changed.includes("/on-screen"));
      assert.ok(hit, "the visible checkout was re-read");
      assert.ok(hit.at - changedAt <= clockModule.TICK_MS + 500, `within one tick (${hit.at - changedAt} ms)`);
    });

    await check("off-screen checkouts are compared only every HIDDEN_EVERY ticks", async () => {
      asked = [];
      seen.hidden.length = 0;
      signatures.set("/off-screen", "y");
      for (let i = 0; i < clockModule.HIDDEN_EVERY; i++) await clock.tick();
      const withHidden = asked.filter((cwds) => cwds.includes("/off-screen"));
      assert.equal(withHidden.length, 1, "one comparison in HIDDEN_EVERY ticks");
      assert.deepEqual(seen.hidden.map((entry) => entry.changed), [["/off-screen"]]);
    });

    await check("an on-screen watcher never swallows a change for an off-screen one on the same folder", async () => {
      const shared = { visible: [], hidden: [] };
      signatures.set("/both", "1");
      const seenA = new Map();
      const seenB = new Map();
      await clock.baseline(seenA, ["/both"]);
      await clock.baseline(seenB, ["/both"]);
      const a = clock.watch({ cwds: ["/both"], visible: true, seen: seenA, onRefresh: (changed) => shared.visible.push([...changed]) });
      const b = clock.watch({ cwds: ["/both"], visible: false, seen: seenB, onRefresh: (changed) => shared.hidden.push([...changed]) });
      await clock.focus();
      assert.ok(shared.hidden.every((changed) => changed.length === 0), "nothing moved since the baseline");
      signatures.set("/both", "2");
      for (let i = 0; i < clockModule.HIDDEN_EVERY; i++) await clock.tick();
      assert.ok(shared.visible.some((changed) => changed.includes("/both")));
      assert.ok(shared.hidden.some((changed) => changed.includes("/both")), "the off-screen watcher still sees it");
      a();
      b();
    });

    await check("a move between a watcher's baseline and its first comparison is a change", async () => {
      const memory = new Map();
      const calls = [];
      signatures.set("/raced", "before-read");
      await clock.baseline(memory, ["/raced"]);
      // The hook's own read happens here; then a commit lands before the
      // first comparison.
      signatures.set("/raced", "after-read");
      const stop = clock.watch({ cwds: ["/raced"], visible: false, seen: memory, onRefresh: (changed) => calls.push([...changed]) });
      await hiddenTick();
      assert.deepEqual(calls.at(-1), ["/raced"]);
      await hiddenTick();
      assert.deepEqual(calls.at(-1), [], "and only once");
      stop();
    });

    await check("a watcher with a baseline and nothing moved reads nothing on its first comparison", async () => {
      const memory = new Map();
      const calls = [];
      signatures.set("/still", "same");
      await clock.baseline(memory, ["/still"]);
      const stop = clock.watch({ cwds: ["/still"], visible: false, seen: memory, onRefresh: (changed) => calls.push([...changed]) });
      await hiddenTick();
      assert.deepEqual(calls.at(-1), []);
      stop();
    });

    await check("a focus during a running tick is still delivered as a focus", async () => {
      const reasons = [];
      const stop = clock.watch({ cwds: ["/on-screen"], visible: true, onRefresh: (_changed, reason) => reasons.push(reason) });
      const tick = clock.tick();
      const focus = clock.focus();
      await Promise.all([tick, focus]);
      assert.deepEqual(reasons.slice(-2), ["tick", "focus"]);
      stop();
    });

    await check("reads due by time wait a whole off-screen round after focus returns", async () => {
      const fresh = clockModule.createGitRefreshClock(env);
      assert.equal(fresh.isSettled(), false, "unfocused");
      assert.equal(fresh.settlesAt(), null, "no settling time while unfocused");
      const before = Date.now();
      await fresh.focus();
      assert.equal(fresh.isSettled(), false, "just focused");
      const at = fresh.settlesAt();
      const round = clockModule.TICK_MS * clockModule.HIDDEN_EVERY;
      assert.ok(at >= before + round && at <= Date.now() + round, "settles a whole round after the focus");
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + clockModule.TICK_MS * clockModule.HIDDEN_EVERY;
        assert.equal(fresh.isSettled(), true, "a round later");
        await fresh.focus();
        assert.equal(fresh.isSettled(), true, "a focus while focused changes nothing");
      } finally {
        Date.now = realNow;
      }
      fresh.pause();
      assert.equal(fresh.isSettled(), false, "paused");
      assert.equal(fresh.settlesAt(), null, "paused: no settling time");
    });

    await check("losing focus stops the clock", async () => {
      clock.pause();
      assert.equal(intervals.size, 0);
      asked = [];
      await sleep(clockModule.TICK_MS + 300);
      assert.equal(asked.length, 0);
    });

    await check("a watcher that leaves is never called again, and the last one stops the timer", async () => {
      await clock.focus();
      stopHidden();
      const before = seen.hidden.length;
      await clock.focus();
      assert.equal(seen.hidden.length, before);
      stopVisible();
      assert.equal(intervals.size, 0);
    });

    // ── Fingerprints from a real repository ──
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
    const git = (cwd, args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
    const repo = path.join(dir, "repo");
    const tree = path.join(dir, "tree");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.invalid"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-q", "-m", "one"]);
    git(repo, ["worktree", "add", "-q", "-b", "lane", tree]);
    // Stamps are in ms; keep two writes from landing in the same one.
    const settle = () => sleep(20);
    const sig = (cwd) => state.gitStateSignature(cwd);

    await check("a worktree finds its own git dir and the shared one", async () => {
      const dirs = await state.gitDirsOf(path.join(tree));
      assert.equal(fs.realpathSync(dirs.commonDir), fs.realpathSync(path.join(repo, ".git")));
      assert.notEqual(dirs.gitDir, dirs.commonDir);
      assert.equal(await state.gitDirsOf(path.join(os.tmpdir(), "codara-surely-not-a-repo", "x")), null);
      assert.equal(await state.gitDirsOf("ssh://host/repo"), null);
    });

    await check("a working-tree edit and a git status leave the fingerprint alone", async () => {
      const before = await sig(repo);
      await settle();
      fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
      git(repo, ["status", "--porcelain"]);
      assert.equal(await sig(repo), before);
    });

    await check("staging, committing and checking out move it", async () => {
      let before = await sig(repo);
      await settle();
      git(repo, ["add", "a.txt"]);
      assert.notEqual(await sig(repo), before, "stage");
      before = await sig(repo);
      await settle();
      git(repo, ["commit", "-q", "-m", "two"]);
      assert.notEqual(await sig(repo), before, "commit");
      before = await sig(tree);
      await settle();
      git(tree, ["checkout", "-q", "-b", "other"]);
      assert.notEqual(await sig(tree), before, "checkout in the worktree");
    });

    await check("a commit in the main checkout moves its worktrees' fingerprints (shared refs)", async () => {
      const before = await sig(tree);
      await settle();
      fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
      git(repo, ["add", "b.txt"]);
      git(repo, ["commit", "-q", "-m", "b"]);
      assert.notEqual(await sig(tree), before);
    });

    await check("a remote branch update moves it, an unchanged fetch does not", async () => {
      fs.mkdirSync(path.join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
      const head = git(repo, ["rev-parse", "HEAD"]);
      fs.writeFileSync(path.join(repo, ".git", "FETCH_HEAD"), `${head}\t\tbranch 'main' of example\n`);
      const before = await sig(repo);
      await settle();
      fs.writeFileSync(path.join(repo, ".git", "FETCH_HEAD"), `${head}\t\tbranch 'main' of example\n`);
      assert.equal(await sig(repo), before, "same fetch result");
      await settle();
      git(repo, ["update-ref", "refs/remotes/origin/feature", head]);
      assert.notEqual(await sig(repo), before, "a new remote branch");
    });

    await check("a commit on a branch with a slash moves the other checkouts' fingerprints", async () => {
      git(repo, ["branch", "perf/slash"]);
      const head = git(repo, ["rev-parse", "HEAD"]);
      const before = await sig(tree);
      await settle();
      // Only that branch moves: a commit made elsewhere, no HEAD involved.
      const commit = git(repo, ["commit-tree", "HEAD^{tree}", "-p", head, "-m", "elsewhere"]);
      git(repo, ["update-ref", "refs/heads/perf/slash", commit]);
      assert.notEqual(await sig(tree), before);
      const mid = await sig(tree);
      await settle();
      git(repo, ["update-ref", "refs/remotes/origin/feat/deep", head]);
      assert.notEqual(await sig(tree), mid, "a nested remote branch");
    });

    await check("the branch comes from HEAD's file for a loose ref only", async () => {
      assert.equal(await state.branchFromFiles(repo), "main");
      assert.equal(await state.branchFromFiles(tree), "other");
      git(repo, ["pack-refs", "--all"]);
      assert.equal(await state.branchFromFiles(repo), null, "a packed ref is left to git");
      git(tree, ["checkout", "-q", "--detach"]);
      assert.equal(await state.branchFromFiles(tree), null, "a detached HEAD is left to git");
      assert.equal(await state.branchFromFiles(path.join(dir, "nowhere")), null);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} git refresh clock checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
