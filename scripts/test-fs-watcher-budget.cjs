#!/usr/bin/env node
// Bounded Explorer watches on Linux: runs src/main/fs-watcher.ts against a
// generated workspace full of nested node_modules and counts the inotify
// watches this process holds, from /proc/self/fdinfo.
//
//   node scripts/test-fs-watcher-budget.cjs
//
// Guards that:
//   - a root costs one watch plus one per expanded folder, where Node's
//     recursive fs.watch costs one per folder and file of the whole tree (both
//     are printed);
//   - expanded folders under an ignored name, or past the budget, hold no
//     watch but are polled, so their changes still arrive, and reaching the
//     budget is logged once;
//   - a previewed file's folder is watched until its last preview closes;
//   - a deleted and re-created expanded folder is watched again;
//   - hundreds of expand / collapse / open / close / reload cycles over several
//     windows, roots and previews bring the count back to its baseline.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OLD_IGNORED_TOP_LEVEL = new Set([".git", "node_modules", "out", "dist", "build", ".next", ".turbo"]);

function inotifyWatchCount() {
  let total = 0;
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    let link;
    try {
      link = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      continue;
    }
    if (link !== "anon_inode:inotify") continue;
    try {
      const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
      total += info.split("\n").filter((line) => line.startsWith("inotify ")).length;
    } catch {
      // The fd closed between the listing and the read.
    }
  }
  return total;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(label, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
}

// Node's recursive watcher on Linux scans the tree asynchronously.
async function settledCount() {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 250 && stable < 5; i++) {
    const count = inotifyWatchCount();
    stable = count === last ? stable + 1 : 0;
    last = count;
    await tick();
  }
  return last;
}

function buildTree(base) {
  const root = path.join(base, "workspace");
  let dirs = 0;
  let files = 0;
  const mkdir = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  };
  const write = (file) => {
    fs.writeFileSync(file, "x");
    files += 1;
  };
  for (let p = 0; p < 8; p++) {
    const pkg = path.join(root, "packages", `pkg${p}`);
    for (const sub of ["a", "b", "c"]) {
      mkdir(path.join(pkg, "src", sub));
      write(path.join(pkg, "src", sub, "index.ts"));
    }
    for (let m = 0; m < 40; m++) {
      const mod = path.join(pkg, "node_modules", `mod${m}`);
      mkdir(path.join(mod, "dist", "esm"));
      mkdir(path.join(mod, "lib"));
      write(path.join(mod, "dist", "esm", "index.js"));
    }
    mkdir(path.join(pkg, "test-results", "analytics"));
    mkdir(path.join(pkg, "target", "debug", "deps"));
  }
  mkdir(path.join(root, "node_modules", "left-pad"));
  mkdir(path.join(root, ".git", "objects", "ab"));
  mkdir(path.join(root, "docs"));
  write(path.join(root, "README.md"));
  const countDirs = (dir) => {
    dirs += 1;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) countDirs(path.join(dir, entry.name));
    }
  };
  countDirs(root);
  return { root, dirs, files };
}

// The previous Explorer watcher: the root, plus a recursive watch on every
// top-level folder outside a short ignore list.
async function measureOldStrategy(root, baseline) {
  const handles = [fs.watch(root, { recursive: false })];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || OLD_IGNORED_TOP_LEVEL.has(entry.name)) continue;
      handles.push(fs.watch(path.join(root, entry.name), { recursive: true }));
    }
    return (await settledCount()) - baseline;
  } finally {
    for (const handle of handles) handle.close();
  }
}

function fakeWebContents(id, changed) {
  return {
    id,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    send(channel, event) {
      assert.equal(channel, "fs:changed");
      for (const dir of event.dirs) changed.add(dir);
    },
  };
}

// Deterministic choices for the churn loop.
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

async function main() {
  if (process.platform !== "linux") {
    console.log("SKIP inotify budget checks run on Linux only");
    return;
  }
  const outfile = path.join(ROOT, "node_modules", ".codara-fs-watcher-budget-test", "bundle.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/fs-watcher.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    packages: "external",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const watcher = require(outfile);

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(" "));
  };

  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-fs-budget-")));
  const { root, dirs, files } = buildTree(base);
  const other = path.join(base, "attached");
  fs.mkdirSync(path.join(other, "notes", "2026"), { recursive: true });
  const pkg = (p, ...rest) => path.join(root, "packages", `pkg${p}`, ...rest);
  let passed = 0;
  const pass = (label) => {
    passed += 1;
    console.log(`  PASS ${label}`);
  };
  const log = (line) => console.log(line);

  try {
    const baseline = inotifyWatchCount();

    let oldCount = null;
    try {
      oldCount = await measureOldStrategy(root, baseline);
    } catch (err) {
      // A machine whose inotify limit other programs already used up cannot
      // host the comparison; the bounded checks below still run.
      if (err?.code !== "ENOSPC") throw err;
      log(`  (old-strategy comparison skipped: ${err.message})`);
    }
    assert.equal(await settledCount(), baseline, "closing the recursive watchers released their watches");

    watcher.__test.setLimits({ pollMs: 60 });
    const changed = new Set();
    const wc = fakeWebContents(1, changed);
    await watcher.addWatchRoot(wc, root);
    const expanded = [
      path.join(root, "packages"),
      pkg(0),
      pkg(0, "src"),
      pkg(0, "src", "a"),
      pkg(1),
      pkg(1, "node_modules"),
      pkg(1, "node_modules", "mod0"),
      pkg(1, "test-results"),
    ];
    const added = await watcher.setWatchedDirs(wc, root, expanded);
    assert.deepEqual(added.sort(), [...expanded].sort(), "every newly expanded folder is reported for a re-list");
    const newCount = inotifyWatchCount() - baseline;
    assert.equal(newCount, 1 + 5, "the root and the five expanded folders outside ignored names are watched");
    assert.deepEqual(watcher.__test.diagnostics(), { roots: 1, watchedDirs: 5, polledDirs: 3, previews: 0 });
    log(
      `  tree: ${dirs} folders, ${files} files; old strategy ${oldCount ?? "n/a"} inotify watches, ` +
        `new ${newCount} with ${expanded.length} folders expanded`,
    );
    if (oldCount !== null) assert.ok(oldCount > dirs, `old strategy watched every folder (${oldCount})`);
    pass("one watch for the root and one per expanded folder outside ignored names");

    assert.deepEqual(await watcher.setWatchedDirs(wc, root, expanded), [], "an unchanged set arms nothing");
    pass("re-sending the same expanded set arms nothing");

    fs.writeFileSync(pkg(0, "src", "a", "new.ts"), "x");
    await waitUntil("event for a watched folder", () => changed.has(pkg(0, "src", "a")));
    fs.writeFileSync(pkg(1, "node_modules", "mod0", "new.js"), "x");
    await waitUntil("polled event for an expanded node_modules folder", () =>
      changed.has(pkg(1, "node_modules", "mod0")),
    );
    pass("changes arrive from watched and from polled (ignored) expanded folders");

    // Collapsing a folder hides its open descendants too.
    await watcher.setWatchedDirs(wc, root, [path.join(root, "packages")]);
    assert.equal(inotifyWatchCount() - baseline, 2);
    assert.deepEqual(watcher.__test.diagnostics(), { roots: 1, watchedDirs: 1, polledDirs: 0, previews: 0 });
    pass("collapsing releases the hidden folders' watches and polls");

    // A previewed file's folder is watched even when no Explorer expands it.
    const previewed = pkg(3, "src", "b", "index.ts");
    watcher.watchPreviewFile(wc, previewed);
    watcher.watchPreviewFile(wc, previewed);
    assert.deepEqual(watcher.__test.diagnostics(), { roots: 1, watchedDirs: 2, polledDirs: 0, previews: 1 });
    fs.renameSync(previewed, `${previewed}.tmp`);
    fs.renameSync(`${previewed}.tmp`, previewed);
    await waitUntil("event for a previewed file's folder", () => changed.has(pkg(3, "src", "b")));
    watcher.unwatchPreviewFile(wc, previewed);
    assert.equal(watcher.__test.diagnostics().previews, 1, "a second preview of the file keeps the watch");
    watcher.unwatchPreviewFile(wc, previewed);
    assert.deepEqual(watcher.__test.diagnostics(), { roots: 1, watchedDirs: 1, polledDirs: 0, previews: 0 });
    pass("a previewed file's folder is watched until its last preview closes");

    // A folder deleted and re-created while expanded.
    await watcher.setWatchedDirs(wc, root, [path.join(root, "packages"), pkg(2)]);
    assert.equal(watcher.__test.diagnostics().watchedDirs, 2);
    fs.rmSync(pkg(2), { recursive: true, force: true });
    await waitUntil("the deleted folder's watch to close", () => watcher.__test.diagnostics().watchedDirs === 1);
    fs.mkdirSync(pkg(2));
    await waitUntil("the re-created folder to be watched again", () => watcher.__test.diagnostics().watchedDirs === 2);
    changed.clear();
    fs.writeFileSync(path.join(pkg(2), "after.ts"), "x");
    await waitUntil("event from the re-created folder", () => changed.has(pkg(2)));
    pass("a deleted and re-created expanded folder is watched again");
    fs.mkdirSync(pkg(2, "src", "a"), { recursive: true });
    fs.mkdirSync(pkg(2, "node_modules"));

    // Budget: the root plus 7 folders, the other 13 polled.
    watcher.__test.setLimits({ budget: 8 });
    warnings.length = 0;
    const many = [];
    for (let p = 0; p < 5; p++) {
      many.push(pkg(p), pkg(p, "src"), pkg(p, "src", "a"), pkg(p, "src", "b"));
    }
    await watcher.setWatchedDirs(wc, root, many);
    assert.equal(inotifyWatchCount() - baseline, 8, "the budget caps the watches");
    assert.deepEqual(watcher.__test.diagnostics(), { roots: 1, watchedDirs: 7, polledDirs: 13, previews: 0 });
    assert.equal(warnings.filter((line) => line.includes("watch budget")).length, 1, warnings.join("\n"));
    changed.clear();
    fs.writeFileSync(path.join(pkg(4, "src", "b"), "late.ts"), "x");
    await waitUntil("polled event past the budget", () => changed.has(pkg(4, "src", "b")));
    await watcher.setWatchedDirs(wc, root, many.slice(-3));
    assert.deepEqual(watcher.__test.diagnostics(), { roots: 1, watchedDirs: 3, polledDirs: 0, previews: 0 });
    pass("past the budget folders are polled, the budget is logged once, and freed budget is reused");

    watcher.removeWatchRoot(wc, root);
    assert.equal(inotifyWatchCount(), baseline);
    pass("removing the root releases everything");

    // Churn over three windows, two roots each, and previews.
    const budget = 12;
    watcher.__test.setLimits({ budget, pollMs: 40 });
    const rand = prng(7);
    const candidates = [
      path.join(root, "packages"),
      path.join(root, "docs"),
      path.join(root, "node_modules"),
      ...Array.from({ length: 8 }, (_, p) => [pkg(p), pkg(p, "src"), pkg(p, "src", "a"), pkg(p, "node_modules")]).flat(),
    ];
    const otherDirs = [path.join(other, "notes"), path.join(other, "notes", "2026")];
    const windows = [1, 2, 3].map((id) => ({ wc: fakeWebContents(10 + id, new Set()), previews: [] }));
    let maxSeen = 0;
    for (let i = 0; i < 400; i++) {
      const win = windows[Math.floor(rand() * windows.length)];
      const op = rand();
      if (op < 0.4) {
        await watcher.setWatchedDirs(win.wc, root, candidates.filter(() => rand() < 0.35));
      } else if (op < 0.5) {
        await watcher.setWatchedDirs(win.wc, other, otherDirs.filter(() => rand() < 0.5));
      } else if (op < 0.6) {
        await watcher.addWatchRoot(win.wc, rand() < 0.7 ? root : other);
      } else if (op < 0.65) {
        // React StrictMode: arm, remove before the arm finishes, arm again.
        const pending = watcher.addWatchRoot(win.wc, root);
        watcher.removeWatchRoot(win.wc, root);
        await pending;
        await watcher.addWatchRoot(win.wc, root);
      } else if (op < 0.72) {
        watcher.removeWatchRoot(win.wc, rand() < 0.7 ? root : other);
      } else if (op < 0.82) {
        const file = path.join(candidates[Math.floor(rand() * candidates.length)], "preview.png");
        watcher.watchPreviewFile(win.wc, file);
        win.previews.push(file);
      } else if (op < 0.9 && win.previews.length > 0) {
        const [file] = win.previews.splice(Math.floor(rand() * win.previews.length), 1);
        watcher.unwatchPreviewFile(win.wc, file);
      } else if (op < 0.95) {
        // Window closed or reloaded.
        watcher.disposeForWebContents(win.wc);
        win.previews = [];
      } else {
        fs.writeFileSync(path.join(candidates[Math.floor(rand() * candidates.length)], `churn-${i}.txt`), "x");
      }
      const count = inotifyWatchCount() - baseline;
      maxSeen = Math.max(maxSeen, count);
      assert.ok(count <= budget, `step ${i}: ${count} watches exceed the budget of ${budget}`);
    }
    for (const win of windows) {
      for (const file of win.previews) watcher.unwatchPreviewFile(win.wc, file);
      win.previews = [];
    }
    for (const win of windows) watcher.disposeForWebContents(win.wc);
    assert.deepEqual(watcher.__test.diagnostics(), { roots: 0, watchedDirs: 0, polledDirs: 0, previews: 0 });
    assert.equal(inotifyWatchCount(), baseline, "every watch was released");
    log(`  churn: 400 steps, at most ${maxSeen} watches held, ${inotifyWatchCount() - baseline} after closing`);
    pass("400 open / close / expand / collapse / preview steps return to the baseline");
  } finally {
    console.warn = realWarn;
    watcher.disposeAll();
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(`PASS ${passed} Explorer watch budget checks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
