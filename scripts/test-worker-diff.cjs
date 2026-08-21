#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "src", "main", "orchestration", "worker-diff.ts");

async function loadContract() {
  const output = await esbuild.build({
    entryPoints: [SOURCE],
    bundle: true,
    format: "cjs",
    platform: "node",
    packages: "external",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function main() {
  const T = await loadContract();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codara-worker-diff-test-"));
  try {
    git(cwd, ["init", "-q"]);
    git(cwd, ["config", "user.email", "cora@example.invalid"]);
    git(cwd, ["config", "user.name", "Cora Test"]);
    fs.writeFileSync(path.join(cwd, "alpha.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(cwd, "old.txt"), "old\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-qm", "base"]);

    fs.writeFileSync(path.join(cwd, "alpha.txt"), "one changed\ntwo\nthree\n");
    fs.rmSync(path.join(cwd, "old.txt"));
    fs.writeFileSync(path.join(cwd, "new.txt"), "a\nb\n");

    const stagedBefore = git(cwd, ["diff", "--cached"]);
    const captured = await T.captureWorkerDiff({ cwd, baseSha: "HEAD" });
    assert.ok(captured, "captures a local Git worker diff");
    assert.deepEqual(
      {
        fileCount: captured.summary.fileCount,
        additions: captured.summary.additions,
        deletions: captured.summary.deletions,
      },
      { fileCount: 3, additions: 4, deletions: 2 },
    );
    assert.deepEqual(
      captured.summary.files.map((file) => file.path).sort(),
      ["alpha.txt", "new.txt", "old.txt"],
    );
    assert.match(captured.patch, /diff --git a\/alpha\.txt b\/alpha\.txt/);
    assert.equal(git(cwd, ["diff", "--cached"]), stagedBefore, "temporary capture never changes the real index");

    const scoped = await T.captureWorkerDiff({ cwd, baseSha: "HEAD", paths: ["alpha.txt"] });
    assert.deepEqual(scoped.summary, {
      fileCount: 1,
      additions: 2,
      deletions: 1,
      files: [{ path: "alpha.txt", additions: 2, deletions: 1 }],
    });

    assert.equal(
      await T.captureWorkerDiff({ cwd: "ssh://host/repo", baseSha: "HEAD" }),
      null,
      "remote workspaces do not run a local Git capture",
    );

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "codara-worker-plain-test-"));
    const baseline = path.join(plain, ".artifacts", "before");
    try {
      assert.equal(
        await T.captureWorkerFilesystemBaseline({
          cwd: plain,
          paths: ["calculator.html"],
          destination: baseline,
        }),
        true,
        "captures an empty declared path before a worker creates it",
      );
      fs.writeFileSync(path.join(plain, "calculator.html"), "one\ntwo\nthree\n");
      fs.writeFileSync(path.join(plain, "unowned.txt"), "ignore me\n");
      const created = await T.captureWorkerFilesystemDiff({
        cwd: plain,
        paths: ["calculator.html"],
        baselineDir: baseline,
      });
      assert.deepEqual(created?.summary, {
        fileCount: 1,
        additions: 3,
        deletions: 0,
        files: [{ path: "calculator.html", additions: 3, deletions: 0 }],
      });

      assert.equal(
        await T.captureWorkerFilesystemBaseline({
          cwd: plain,
          paths: ["calculator.html"],
          destination: baseline,
        }),
        true,
      );
      fs.writeFileSync(path.join(plain, "calculator.html"), "one changed\ntwo\nfour\nfive\n");
      const edited = await T.captureWorkerFilesystemDiff({
        cwd: plain,
        paths: ["calculator.html"],
        baselineDir: baseline,
      });
      assert.deepEqual(edited?.summary, {
        fileCount: 1,
        additions: 3,
        deletions: 2,
        files: [{ path: "calculator.html", additions: 3, deletions: 2 }],
      });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    console.log("worker diff contracts passed");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
