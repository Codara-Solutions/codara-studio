#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadJournalModule() {
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pr-journal-build-"));
  const outfile = path.join(buildRoot, "journal.cjs");
  await esbuild.build({
    entryPoints: [
      path.join(ROOT, "src", "main", "github-pull-request-import-journal.ts"),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [{
      name: "journal-codara-home-stub",
      setup(build) {
        build.onResolve({ filter: /^\.\/codara-home$/ }, () => ({
          path: "codara-home",
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          loader: "js",
          contents: "export function codaraHome() { throw new Error('explicit test home required'); }",
        }));
      },
    }],
    logLevel: "silent",
  });
  return {
    journal: require(outfile),
    cleanup: () => fs.rmSync(buildRoot, { recursive: true, force: true }),
  };
}

function input(transactionId = "12345678-1234-4234-9234-123456789abc") {
  const origin = {
    kind: "github-pull-request",
    repository: "codara/studio",
    repositoryUrl: "https://github.com/codara/studio",
    number: 42,
    title: "Journal it",
    url: "https://github.com/codara/studio/pull/42",
    sourceWorkspaceId: "source",
    base: { branch: "main", commitOid: "a".repeat(40) },
    head: {
      relationship: "fork",
      repository: "contributor/studio",
      repositoryUrl: "https://github.com/contributor/studio",
      branch: "feature",
      commitOid: "b".repeat(40),
    },
  };
  return {
    transactionId,
    operationKey: "c".repeat(64),
    revisionKey: `${"c".repeat(64)}@${"b".repeat(40)}`,
    source: {
      workspaceId: "source",
      cwd: "/repo",
      repositoryUrl: "https://github.com/codara/studio",
      repository: "codara/studio",
    },
    pullRequest: {
      origin,
      expectedHeadCommitOid: "b".repeat(40),
    },
    git: {
      worktreesRoot: "/managed",
      branch: "codara/pr/hash/42/feature",
      expectedOid: "b".repeat(40),
      privateRefState: "planned",
    },
    workspace: { id: "ws-pr-id" },
    run: {
      id: "run-pr-12345678-1234-4234-9234-123456789abc",
      initialMessageClientId: "github-pr-message",
    },
    activation: { intended: true },
  };
}

async function main() {
  const loaded = await loadJournalModule();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pr-journal-"));
  try {
    const store = loaded.journal.createGitHubPullRequestImportJournalStore(home);
    const created = await store.create(input());
    assert.equal(created.revision, 0);
    assert.equal(created.phase, "fetch-intent");
    const activeRoot = path.join(home, "transactions", "github-pr-import", "active");
    const activePath = path.join(activeRoot, `${created.transactionId}.json`);
    assert.equal(fs.existsSync(activePath), true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(activeRoot).mode & 0o777, 0o700);
      assert.equal(fs.statSync(activePath).mode & 0o777, 0o600);
    }

    const [first, second] = await Promise.all([
      store.update(created.transactionId, (current) => ({
        ...current,
        phase: "fetched-verified",
      })),
      store.update(created.transactionId, (current) => ({
        ...current,
        phase: "worktree-intent",
        git: { ...current.git, worktreePath: "/managed/feature" },
      })),
    ]);
    assert.deepEqual([first.revision, second.revision], [1, 2]);
    const listed = await store.listActive();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].revision, 2);
    assert.equal(listed[0].phase, "worktree-intent");

    const archived = await store.archive(created.transactionId, "completed");
    assert.equal(archived.phase, "complete");
    assert.equal(fs.existsSync(activePath), false);
    assert.equal(
      fs.existsSync(
        path.join(
          home,
          "transactions",
          "github-pr-import",
          "history",
          `${created.transactionId}.json`,
        ),
      ),
      true,
    );

    const corruptId = "87654321-4321-4321-8321-cba987654321";
    fs.writeFileSync(path.join(activeRoot, `${corruptId}.json`), "{broken", {
      mode: 0o600,
    });
    assert.deepEqual(await store.listActive(), []);
    const quarantine = fs.readdirSync(
      path.join(home, "transactions", "github-pr-import", "quarantine"),
    );
    assert.equal(
      quarantine.some((name) => name.startsWith(`${corruptId}.json.`)),
      true,
      "corrupt active journals are quarantined without touching artifacts",
    );

    const capacityResults = await Promise.allSettled(
      Array.from({ length: 160 }, () => store.create(input(randomUUID()))),
    );
    assert.equal(
      capacityResults.filter((result) => result.status === "fulfilled").length,
      128,
      "concurrent transaction IDs cannot bypass the global active-journal cap",
    );
    assert.equal(
      capacityResults.filter((result) => result.status === "rejected").length,
      32,
    );
    assert.equal((await store.listActive()).length, 128);

    const fsAtomicSource = fs.readFileSync(
      path.join(ROOT, "src", "main", "fs-atomic.ts"),
      "utf8",
    );
    assert.match(fsAtomicSource, /export async function syncDirectory/);
    assert.match(fsAtomicSource, /await handle\.sync\(\)/);
    assert.match(fsAtomicSource, /await syncDirectory\(dir\)/);

    const bootSource = fs.readFileSync(
      path.join(ROOT, "src", "main", "index.ts"),
      "utf8",
    );
    const recovery = bootSource.indexOf("await recoverGitHubPullRequestImports()");
    const seed = bootSource.indexOf("const state = await loadState()", recovery);
    const ipc = bootSource.indexOf("registerIpc()", recovery);
    const remote = bootSource.indexOf('import("./remote-access/production")', recovery);
    const window = bootSource.indexOf("createWindow()", recovery);
    assert.ok(recovery > -1);
    for (const [label, position] of [
      ["sandbox seed", seed],
      ["IPC", ipc],
      ["remote access", remote],
      ["window", window],
    ]) {
      assert.ok(position > recovery, `PR recovery must precede ${label}`);
    }

    console.log(
      "PASS durable PR journal modes, serialized revisions, atomic capacity, quarantine, directory fsync, and boot ordering",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    loaded.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
