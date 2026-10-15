"use strict";
// The review tab's combined diff (src/main/review/review-diff.ts) against
// throwaway repositories: every kind of change in one list (modified, added,
// deleted, renamed, untracked, binary, paths with spaces and non-ASCII),
// a repository with no commit yet, the branch view from where the branch left
// its base, the line budget that defers sections, loading deferred files by
// path, untracked links (shown by target, never followed), a nested
// repository and the capped read of a huge untracked file, a merge conflict,
// a diff too large for one read, and a one-hunk patch from the review model
// that git applies to the index.
//
//   node scripts/test-review-diff.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "./main/review/review-diff";
        export { fileStructure, hunkPatch, quoteFor } from "./renderer/src/components/review/review-model";
      `,
      resolveDir: path.join(ROOT, "src"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src/shared") },
    external: ["ssh2", "cpu-features"],
    // Nothing here needs Electron; a stub keeps its binary from being fetched.
    plugins: [{
      name: "no-electron",
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = {};", loader: "js" }));
      },
    }],
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-review-diff-")));
// A fake home and git config: nothing here reads or writes the user's own.
const home = path.join(scratch, "home");
fs.mkdirSync(home, { recursive: true });
const gitConfig = path.join(scratch, "gitconfig");
fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n");
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.HOME = home;
process.env.USERPROFILE = home;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repo(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  return dir;
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const numbered = (count, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

(async () => {
  try {
    const lib = await load();

    // ── Pure helpers ────────────────────────────────────────────────────
    assert.equal(lib.isSafeRefName("origin/main"), true);
    assert.equal(lib.isSafeRefName("feature/x-1"), true);
    assert.equal(lib.isSafeRefName("../etc"), false);
    assert.equal(lib.isSafeRefName("-x"), false);
    assert.equal(lib.isSafeRefName("a b"), false);
    assert.equal(lib.isSafeRefName("main.lock"), false);
    assert.equal(lib.unquoteGitPath('"caf\\303\\251 \\"q\\".txt"'), 'café "q".txt');
    assert.equal(lib.unquoteGitPath("plain.txt"), "plain.txt");
    assert.deepEqual(lib.parseNumstatZ("3\t1\ta.txt\0-\t-\tbin.dat\0" + "1\t0\t\0old.txt\0new.txt\0"), [
      { path: "a.txt", additions: 3, deletions: 1, binary: false },
      { path: "bin.dat", additions: 0, deletions: 0, binary: true },
      { path: "new.txt", oldPath: "old.txt", additions: 1, deletions: 0, binary: false },
    ]);
    const statuses = lib.parseNameStatusZ("M\0a.txt\0A\0b.txt\0D\0c.txt\0R087\0d.txt\0e.txt\0T\0link\0");
    assert.deepEqual([...statuses], [["a.txt", "modified"], ["b.txt", "added"], ["c.txt", "deleted"], ["e.txt", "renamed"], ["link", "typechange"]]);
    const blocks = lib.splitPatch(
      [
        "diff --git a/dir with space/x.txt b/dir with space/x.txt",
        "index 1..2 100644",
        "--- a/dir with space/x.txt",
        "+++ b/dir with space/x.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        'diff --git "a/q\\"x.txt" "b/q\\"x.txt"',
        "deleted file mode 100644",
        '--- "a/q\\"x.txt"',
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
        "",
      ].join("\n"),
    );
    assert.deepEqual(blocks.map((block) => block.path), ["dir with space/x.txt", 'q"x.txt']);
    // Content lines keep a CRLF file's CR; header lines never hold one.
    const crBlocks = lib.splitPatch("diff --git a/w.txt b/w.txt\r\nindex 1..2 100644\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1 +1 @@ ctx\r\n-a\r\n+b\r\n");
    assert.deepEqual(crBlocks.map((block) => [block.path, block.lines]), [["w.txt", ["diff --git a/w.txt b/w.txt", "index 1..2 100644", "--- a/w.txt", "+++ b/w.txt", "@@ -1 +1 @@ ctx", "-a\r", "+b\r"]]]);

    // ── Every kind of uncommitted change ─────────────────────────────────
    const main = repo("main");
    write(main, "a.txt", numbered(40));
    write(main, "c.txt", "remove me\n");
    write(main, "d.txt", numbered(20, "keep"));
    write(main, "bin.dat", Buffer.from([0, 1, 2, 3]));
    write(main, "q.sql", "select 1;\n-- comment\nselect 2;\n");
    git(main, "add", ".");
    git(main, "commit", "-qm", "base");

    const a = numbered(40).split("\n");
    a[1] = "line 2 changed";
    a[30] = "line 31 changed";
    write(main, "a.txt", a.join("\n"));
    write(main, "b.txt", "brand new\n");
    git(main, "add", "b.txt");
    fs.rmSync(path.join(main, "c.txt"));
    git(main, "mv", "d.txt", "e.txt");
    write(main, "bin.dat", Buffer.from([0, 9, 9, 9]));
    write(main, "q.sql", "select 1;\nselect 2;\n");
    write(main, "dir with space/new ü.txt", "first\nsecond\n");
    write(main, "ignored.log", "x\n");
    write(main, ".gitignore", "*.log\n");

    const diff = await lib.getReviewDiff({ cwd: main, mode: "uncommitted" });
    assert.equal(diff.isRepo, true);
    assert.equal(diff.base, "HEAD");
    assert.equal(diff.error, undefined);
    assert.equal(fs.realpathSync(diff.root), main);
    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    assert.deepEqual(
      diff.files.map((file) => [file.path, file.status]),
      [
        [".gitignore", "untracked"],
        ["a.txt", "modified"],
        ["b.txt", "added"],
        ["bin.dat", "modified"],
        ["c.txt", "deleted"],
        ["dir with space/new ü.txt", "untracked"],
        ["e.txt", "renamed"],
        ["q.sql", "modified"],
      ],
    );
    const aFile = byPath.get("a.txt");
    assert.equal(aFile.additions, 2);
    assert.equal(aFile.deletions, 2);
    assert.equal(aFile.lines.filter((line) => line.kind === "hunk").length, 2, "two separate hunks");
    assert.ok(aFile.lines.some((line) => line.kind === "add" && line.text === "+line 31 changed"));
    assert.equal(byPath.get("e.txt").oldPath, "d.txt");
    assert.equal(byPath.get("bin.dat").binary, true);
    assert.equal(byPath.get("c.txt").deletions, 1);
    const untracked = byPath.get("dir with space/new ü.txt");
    assert.deepEqual(untracked.lines.filter((line) => line.kind === "add").map((line) => line.text), ["+first", "+second"]);
    assert.equal(untracked.additions, 2);
    const sql = byPath.get("q.sql");
    assert.deepEqual(
      sql.lines.filter((line) => line.kind === "del").map((line) => line.text),
      ["--- comment"],
      "a removed line that starts with -- is content, not a file header",
    );
    assert.ok(!byPath.has("ignored.log"), "ignored files stay out");

    // A one-hunk patch from the review model stages that hunk alone.
    const structure = lib.fileStructure(aFile);
    assert.equal(structure.hunks.length, 2);
    const patchFile = path.join(scratch, "hunk.patch");
    fs.writeFileSync(patchFile, lib.hunkPatch(aFile, structure.hunks[1]));
    git(main, "apply", "--cached", "--recount", patchFile);
    const staged = git(main, "diff", "--cached", "--", "a.txt");
    assert.ok(staged.includes("+line 31 changed") && !staged.includes("+line 2 changed"), "only the second hunk is staged");
    git(main, "reset", "-q", "--", "a.txt");

    // Only the asked files, with no budget.
    const some = await lib.getReviewDiff({ cwd: main, mode: "uncommitted", paths: ["a.txt", "dir with space/new ü.txt"] });
    assert.deepEqual(some.files.map((file) => file.path), ["a.txt", "dir with space/new ü.txt"]);
    assert.ok(some.files.every((file) => Array.isArray(file.lines) && !file.deferred));

    // ── No commit yet ───────────────────────────────────────────────────
    const unborn = repo("unborn");
    write(unborn, "one.txt", "1\n");
    git(unborn, "add", "one.txt");
    write(unborn, "two.txt", "2\n");
    const fresh = await lib.getReviewDiff({ cwd: unborn, mode: "uncommitted" });
    assert.equal(fresh.base, null);
    assert.deepEqual(fresh.files.map((file) => [file.path, file.status]), [["one.txt", "added"], ["two.txt", "untracked"]]);
    const freshBase = await lib.getReviewDiff({ cwd: unborn, mode: "base" });
    assert.match(freshBase.error, /no commits yet/);

    // ── Not a repository ────────────────────────────────────────────────
    const plain = path.join(scratch, "plain");
    fs.mkdirSync(plain);
    const none = await lib.getReviewDiff({ cwd: plain, mode: "uncommitted" });
    assert.equal(none.isRepo, false);
    assert.match(none.error, /not a git repository/);

    // ── Branch view: from where the branch left its base ────────────────
    const branchy = repo("branchy");
    write(branchy, "shared.txt", numbered(10));
    git(branchy, "add", ".");
    git(branchy, "commit", "-qm", "base");
    git(branchy, "checkout", "-qb", "feature");
    write(branchy, "feature.txt", "feature work\n");
    git(branchy, "add", ".");
    git(branchy, "commit", "-qm", "feature");
    git(branchy, "checkout", "-q", "main");
    write(branchy, "main-only.txt", "later on main\n");
    git(branchy, "add", ".");
    git(branchy, "commit", "-qm", "main moves on");
    git(branchy, "checkout", "-q", "feature");
    write(branchy, "shared.txt", numbered(10).replace("line 3", "line 3 edited"));

    const deps = { defaultBase: async () => "main" };
    const branchDiff = await lib.getReviewDiff({ cwd: branchy, mode: "base", listBases: true }, deps);
    assert.equal(branchDiff.base, "main");
    assert.equal(branchDiff.mergeBase, git(branchy, "merge-base", "main", "feature").trim().slice(0, 7));
    assert.deepEqual(
      branchDiff.files.map((file) => file.path),
      ["feature.txt", "shared.txt"],
      "committed and uncommitted work of the branch, not what main did since",
    );
    assert.ok(branchDiff.bases.includes("main") && branchDiff.bases.includes("feature"));
    const workspaceBase = await lib.getReviewDiff(
      { cwd: branchy, mode: "base" },
      { workspaceBase: async () => "feature", defaultBase: async () => "main" },
    );
    assert.equal(workspaceBase.base, "feature", "the workspace's own base wins over the default branch");
    assert.deepEqual(workspaceBase.files.map((file) => file.path), ["shared.txt"]);
    const asked = await lib.getReviewDiff({ cwd: branchy, mode: "base", base: "main" }, { workspaceBase: async () => "feature" });
    assert.equal(asked.base, "main", "a base the user picked wins over the workspace's");
    const bad = await lib.getReviewDiff({ cwd: branchy, mode: "base", base: "--output=x" }, deps);
    assert.match(bad.error, /not a branch name/);
    assert.equal(fs.existsSync(path.join(branchy, "x")), false);
    const missing = await lib.getReviewDiff({ cwd: branchy, mode: "base", base: "nope" }, deps);
    assert.match(missing.error, /was not found/);

    // ── Budget: large files and the files past the budget load later ────
    const big = repo("big");
    write(big, "keep.txt", "x\n");
    git(big, "add", ".");
    git(big, "commit", "-qm", "base");
    write(big, "huge.txt", numbered(lib.LARGE_FILE_LINES + 10));
    git(big, "add", "huge.txt");
    const per = 2_900;
    const count = Math.ceil(lib.BUDGET_LINES / per) + 1;
    for (let i = 0; i < count; i++) write(big, `part-${String(i).padStart(2, "0")}.txt`, numbered(per));
    git(big, "add", ".");
    const budget = await lib.getReviewDiff({ cwd: big, mode: "uncommitted" });
    const huge = budget.files.find((file) => file.path === "huge.txt");
    assert.equal(huge.deferred, "large");
    assert.equal(huge.lines, undefined);
    assert.equal(huge.additions, lib.LARGE_FILE_LINES + 10);
    const parts = budget.files.filter((file) => file.path.startsWith("part-"));
    const eager = parts.filter((file) => !file.deferred);
    const later = parts.filter((file) => file.deferred === "budget");
    assert.ok(eager.length > 0 && later.length > 0, "some sections load now, the rest later");
    assert.ok(eager.reduce((sum, file) => sum + file.additions, 0) <= lib.BUDGET_LINES);
    for (const file of eager) assert.ok(file.lines && file.lines.length > per, `${file.path} loaded: ${file.lines?.length} lines, error ${file.error}`);
    // A section scrolled into view loads; a large one waits until asked for.
    write(big, "wild.txt", numbered(lib.LARGE_FILE_LINES + 5));
    const scrolled = await lib.getReviewDiff({ cwd: big, mode: "uncommitted", paths: [later[0].path, "huge.txt", "wild.txt"] });
    assert.deepEqual(scrolled.files.map((file) => file.path).sort(), [later[0].path, "huge.txt", "wild.txt"].sort());
    const byName = new Map(scrolled.files.map((file) => [file.path, file]));
    assert.ok(!byName.get(later[0].path).deferred && byName.get(later[0].path).lines.length > per);
    assert.equal(byName.get("huge.txt").deferred, "large", "a large tracked file stays deferred unasked");
    assert.equal(byName.get("huge.txt").lines, undefined);
    assert.equal(byName.get("huge.txt").additions, lib.LARGE_FILE_LINES + 10);
    assert.equal(byName.get("wild.txt").deferred, "large", "a large untracked file stays deferred unasked");
    assert.equal(byName.get("wild.txt").status, "untracked");
    const loaded = await lib.getReviewDiff({ cwd: big, mode: "uncommitted", paths: ["huge.txt", "wild.txt"], force: true });
    assert.deepEqual(loaded.files.map((file) => file.path).sort(), ["huge.txt", "wild.txt"]);
    assert.ok(loaded.files.every((file) => !file.deferred && file.lines.length > lib.LARGE_FILE_LINES), "asked for, large files load");

    // ── A file with CRLF endings: a hunk still stages, quotes drop the CR ─
    const crlf = repo("crlf");
    const crlfLines = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`);
    write(crlf, "win.txt", `${crlfLines.join("\r\n")}\r\n`);
    git(crlf, "add", ".");
    git(crlf, "commit", "-qm", "base");
    crlfLines[1] = "row 2 changed";
    crlfLines[25] = "row 26 changed";
    write(crlf, "win.txt", `${crlfLines.join("\r\n")}\r\n`);
    const crlfFile = (await lib.getReviewDiff({ cwd: crlf, mode: "uncommitted" })).files.find((file) => file.path === "win.txt");
    const crlfStructure = lib.fileStructure(crlfFile);
    assert.equal(crlfStructure.hunks.length, 2);
    const crlfPatch = path.join(scratch, "crlf.patch");
    fs.writeFileSync(crlfPatch, lib.hunkPatch(crlfFile, crlfStructure.hunks[1]));
    git(crlf, "apply", "--cached", "--recount", "--whitespace=nowarn", crlfPatch);
    const crlfStaged = git(crlf, "diff", "--cached", "--", "win.txt");
    assert.ok(crlfStaged.includes("+row 26 changed\r") && !crlfStaged.includes("+row 2 changed"), "one hunk of a CRLF file stages");
    const changedAt = crlfFile.lines.findIndex((line) => line.text.startsWith("+row 26 changed"));
    assert.equal(lib.quoteFor(crlfFile, { path: "win.txt", from: changedAt, to: changedAt }), "+row 26 changed", "the quote has no CR");

    // ── Untracked entries that are not plain small files ─────────────────
    // A link shows its target, as git would add it, and is never followed;
    // a repository inside the repository says so; a file asked for in full
    // is read only up to a cap.
    const odd = repo("odd");
    write(odd, "kept.txt", "k\n");
    git(odd, "add", ".");
    git(odd, "commit", "-qm", "base");
    const outside = path.join(scratch, "outside-secret.txt");
    fs.writeFileSync(outside, "outside content\n");
    const nested = path.join(odd, "nested");
    fs.mkdirSync(nested);
    git(nested, "init", "-q");
    write(odd, "nested/inner.txt", "inner\n");
    git(nested, "add", ".");
    git(nested, "commit", "-qm", "inner");
    write(odd, "capped.txt", numbered(Math.ceil(lib.MAX_UNTRACKED_READ_BYTES / 9) + 50_000, "c"));
    let fifoMade = false;
    if (process.platform !== "win32") {
      fs.symlinkSync(outside, path.join(odd, "link-out"));
      try {
        execFileSync("mkfifo", [path.join(scratch, "a-pipe")], { stdio: "ignore" });
        fs.symlinkSync(path.join(scratch, "a-pipe"), path.join(odd, "link-pipe"));
        fifoMade = true;
      } catch {
        // No mkfifo here; the link to a file still covers following.
      }
    }
    let hang;
    const oddDiff = await Promise.race([
      lib.getReviewDiff({ cwd: odd, mode: "uncommitted" }),
      new Promise((_, reject) => {
        hang = setTimeout(() => reject(new Error("the review read hung on an untracked link")), 15_000);
      }),
    ]).finally(() => clearTimeout(hang));
    const oddFiles = new Map(oddDiff.files.map((file) => [file.path, file]));
    if (process.platform !== "win32") {
      const link = oddFiles.get("link-out");
      assert.ok(link && link.lines, "the link is listed and shown");
      assert.deepEqual(link.lines.filter((line) => line.kind === "add").map((line) => line.text), [`+${outside}`]);
      assert.ok(!link.lines.some((line) => line.text.includes("outside content")), "the link is not followed");
      if (fifoMade) {
        const pipe = oddFiles.get("link-pipe");
        assert.ok(pipe && pipe.lines.some((line) => line.text === `+${path.join(scratch, "a-pipe")}`), "a link to a pipe shows its target");
      }
    }
    const nestedFile = oddFiles.get("nested/");
    assert.ok(nestedFile, "the nested repository is listed");
    assert.match(nestedFile.error, /repository of its own/);
    assert.equal(oddFiles.get("capped.txt").deferred, "large");
    const capped = (await lib.getReviewDiff({ cwd: odd, mode: "uncommitted", paths: ["capped.txt"], force: true })).files[0];
    assert.equal(capped.truncated, true, "a file past the read cap is cut");
    assert.ok(capped.lines.length <= lib.MAX_FILE_LINES + 2, `capped lines: ${capped.lines.length}`);
    assert.ok(capped.additions > 0 && capped.additions < Math.ceil(lib.MAX_UNTRACKED_READ_BYTES / 9) + 50_000);

    // ── A merge conflict ────────────────────────────────────────────────
    const conflict = repo("conflict");
    write(conflict, "f.txt", "a\nb\nc\n");
    git(conflict, "add", ".");
    git(conflict, "commit", "-qm", "one");
    git(conflict, "checkout", "-qb", "side");
    write(conflict, "f.txt", "a\nSIDE\nc\n");
    git(conflict, "commit", "-qam", "side");
    git(conflict, "checkout", "-q", "main");
    write(conflict, "f.txt", "a\nMAIN\nc\n");
    git(conflict, "commit", "-qam", "main");
    try {
      git(conflict, "merge", "side");
    } catch {
      // The conflict is the point.
    }
    const conflicted = await lib.getReviewDiff({ cwd: conflict, mode: "uncommitted" });
    const cf = conflicted.files.find((file) => file.path === "f.txt");
    assert.ok(cf, "the conflicted file is listed");
    assert.equal(lib.fileStructure(cf).conflicted, true);

    // ── Output too large for one read: that file fails, the rest load ────
    const wide = repo("wide");
    write(wide, "min.js", "a\n");
    write(wide, "small.txt", "s\n");
    git(wide, "add", ".");
    git(wide, "commit", "-qm", "base");
    write(wide, "min.js", `${"x".repeat(17 * 1024 * 1024)}\n`);
    write(wide, "small.txt", "s2\n");
    const wideDiff = await lib.getReviewDiff({ cwd: wide, mode: "uncommitted" });
    assert.equal(wideDiff.error, undefined);
    const minFile = wideDiff.files.find((file) => file.path === "min.js");
    const smallFile = wideDiff.files.find((file) => file.path === "small.txt");
    assert.match(minFile.error, /too large/);
    assert.ok(smallFile.lines.some((line) => line.text === "+s2"));

    console.log("review diff: ok");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
