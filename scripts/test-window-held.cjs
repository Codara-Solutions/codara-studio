// src/main/window-held.ts: whether the window holds a worktree folder before a
// removal deletes it. An editor tab on a file inside the folder holds it
// however the tab spells the file: through a symlink from outside, or a file
// that no longer exists under a symlinked folder. A window that does not
// answer, or answers something else, holds it.
//
//   node scripts/test-window-held.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-window-held-")));
  try {
    const out = path.join(scratch, "window-held.cjs");
    await esbuild.build({
      entryPoints: [path.join(__dirname, "..", "src", "main", "window-held.ts")],
      bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent",
    });
    const { filesInsideFolders, windowHoldsFolder } = require(out);

    const tree = path.join(scratch, "worktrees", "fix-login");
    fs.mkdirSync(path.join(tree, "src"), { recursive: true });
    fs.writeFileSync(path.join(tree, "src", "a.ts"), "a\n");
    const project = path.join(scratch, "project");
    fs.mkdirSync(project);
    fs.symlinkSync(tree, path.join(project, "current-fix"));
    const other = path.join(scratch, "other");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "b.ts"), "b\n");
    fs.symlinkSync(path.join(tree, "src", "a.ts"), path.join(other, "link-to-a.ts"));

    assert.equal(await filesInsideFolders([path.join(tree, "src", "a.ts")], [tree]), true, "a file inside");
    assert.equal(await filesInsideFolders([path.join(project, "current-fix", "src", "a.ts")], [tree]), true, "through a symlinked folder");
    assert.equal(await filesInsideFolders([path.join(other, "link-to-a.ts")], [tree]), true, "a symlinked file");
    assert.equal(await filesInsideFolders([path.join(project, "current-fix", "gone", "draft.md")], [tree]), true, "a file that is gone, under a symlinked folder");
    fs.writeFileSync(path.join(tree, "..draft.md"), "draft\n");
    fs.symlinkSync(path.join(tree, "..draft.md"), path.join(other, "draft-link.md"));
    assert.equal(await filesInsideFolders([path.join(other, "draft-link.md")], [tree]), true, "a file whose name starts with two dots");
    fs.writeFileSync(path.join(tree, "deleted.md"), "gone soon\n");
    fs.symlinkSync(path.join(tree, "deleted.md"), path.join(other, "dangling.md"));
    fs.symlinkSync(path.join(other, "dangling.md"), path.join(other, "chained.md"));
    fs.rmSync(path.join(tree, "deleted.md"));
    assert.equal(await filesInsideFolders([path.join(other, "dangling.md")], [tree]), true, "a link whose target inside was deleted");
    assert.equal(await filesInsideFolders([path.join(other, "chained.md")], [tree]), true, "a chain of links ending inside");
    fs.mkdirSync(path.join(tree, "generated"));
    fs.symlinkSync(path.join(tree, "generated"), path.join(other, "alias"));
    fs.rmSync(path.join(tree, "generated"), { recursive: true });
    assert.equal(await filesInsideFolders([path.join(other, "alias", "draft.md")], [tree]), true, "a file under a folder link whose target inside was deleted");
    fs.symlinkSync(path.join(other, "loop-b"), path.join(other, "loop-a"));
    fs.symlinkSync(path.join(other, "loop-a"), path.join(other, "loop-b"));
    assert.equal(await filesInsideFolders([path.join(other, "loop-a")], [tree]), null, "a link loop: cannot tell");
    assert.equal(await filesInsideFolders([path.join(other, "b.ts"), "relative/a.ts", 7, null], [tree]), false, "nothing inside");
    assert.equal(await filesInsideFolders([path.join(scratch, "worktrees", "fix-login-2", "a.ts")], [tree]), false, "a sibling with the same prefix");
    assert.equal(await filesInsideFolders(null, [tree]), null, "no list: cannot tell");
    assert.equal(await filesInsideFolders(new Array(5_001).fill("/x"), [tree]), null, "too many: cannot tell");

    const asked = [];
    const window = (held, files) => async (op, params) => {
      asked.push({ op, params });
      if (op === "workspaceHeld") return held;
      return files;
    };
    assert.equal(await windowHoldsFolder(window(true, []), "ws", [tree]), true, "its own tabs");
    assert.equal(await windowHoldsFolder(window(false, [path.join(project, "current-fix", "src", "a.ts")]), "ws", [tree]), true);
    assert.deepEqual(asked.at(-2), { op: "workspaceHeld", params: { workspaceId: "ws", paths: [tree] } });
    assert.equal(await windowHoldsFolder(window(false, [path.join(other, "b.ts")]), "ws", [tree]), false, "nothing holds it");
    assert.equal(await windowHoldsFolder(window(null, []), "ws", [tree]), null, "no answer");
    assert.equal(await windowHoldsFolder(window(false, null), "ws", [tree]), null, "no file list");
    assert.equal(
      await windowHoldsFolder(async () => { throw new Error("no window"); }, "ws", [tree]),
      null,
      "a failed question",
    );
    console.log("window-held: all checks passed");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
