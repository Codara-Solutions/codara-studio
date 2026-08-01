#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

const verification = loadTypeScriptModule(
  path.join(__dirname, "..", "src", "main", "orchestration", "pi-verification.ts"),
);

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

async function withRepo(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-frontier-verification-"));
  try {
    git(root, "init", "--quiet");
    return await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  await withRepo(async (root) => {
    write(root, "package.json", JSON.stringify({
      name: "frontier-fixture",
      packageManager: "pnpm@10.0.0",
      scripts: { test: "node --test", typecheck: "tsc --noEmit" },
    }));
    write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    write(root, "README.md", [
      "# Public contract",
      "",
      "Returns an exact result. Self references, overlap between sets, and cycles are `CONFLICT`. It rejects invalid input before mutation, records no history, and returns an exact result on success.",
      "When one path is read and written, its read digest must equal beforeDigest.",
      "It models agents in one workspace: candidates cooperate.",
      "It supports reads and writes.",
      "The runtime supports reads, writes, and deletes.",
      "It never mutates state and remains correct after rejected input.",
      "For a new command, error precedence is `INVALID > CONFLICT`.",
      "Canonical JSON recursively orders keys, preserves arrays, emits no whitespace, and uses scalar encoding.",
      "Unselected candidates are rebased when every selected final write is disjoint from their reads and writes or is a compatible feed.",
      "A timed-out task cannot become successful, emit another event, or occupy capacity forever.",
      "Export is byte-identical, matching retries do not change it, and a restored runtime preserves fencing.",
      "Rejected, invalid, stale, and committed candidates are terminal.",
      "If a peer is pending, stale-base, or excluded, the closure is unsatisfiable.",
      "Planning is pure: it does not mutate state.",
      "A dependency edge orders ancestors: a write may feed a read when digests match, and may feed a write when digests match.",
      "Restoration validates the owned tree, exact shapes, commit history, command digests, and stored results before exposing a runtime.",
      "",
    ].join("\n"));
    write(root, "SURFACE.json", JSON.stringify({ export: "answer", type: "number" }));
    write(root, "src/index.js", "export const answer = 42;\n");
    git(root, "add", "package.json", "pnpm-lock.yaml", "README.md", "SURFACE.json", "src/index.js");

    const first = await verification.discoverPiFrontierVerification(path.join(root, "src"));
    assert.equal(first.schemaVersion, 4);
    assert.equal(first.requestContract, null);
    // `git rev-parse --show-toplevel` resolves macOS's `/var` symlink to
    // `/private/var`; compare canonical paths so the fixture spelling does not
    // turn a correct repository root into a platform-only failure.
    assert.equal(first.workspaceRoot, fs.realpathSync(root));
    assert.match(first.trackedTreeSha256, /^[a-f0-9]{64}$/);
    assert.match(first.contractTreeSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.cacheEligible, true);
    assert.deepEqual(first.contractPaths, ["README.md", "SURFACE.json"]);
    assert.equal(first.contractObligations.length, 41);
    assert.equal(new Set(first.contractObligations.map((obligation) => obligation.id)).size, 41);
    assert.ok(first.contractObligations.every((obligation) => /^obligation-[a-f0-9]{20}$/.test(obligation.id)));
    assert.ok(first.contractObligations.every((obligation) => /^[a-f0-9]{64}$/.test(obligation.contentSha256)));
    assert.ok(first.contractObligations.every((obligation) => ["paired", "positive"].includes(obligation.proofMode)));
    const markdownAtoms = first.contractObligations.filter((obligation) => obligation.kind === "markdown-atom");
    assert.deepEqual(markdownAtoms.map((obligation) => obligation.excerpt), [
      "Returns an exact result.",
      "Self references are `CONFLICT`.",
      "overlap between sets are `CONFLICT`.",
      "cycles are `CONFLICT`.",
      "It rejects invalid input before mutation.",
      "It records no history.",
      "It returns an exact result on success.",
      "When one path is read and written, its read digest must equal beforeDigest.",
      "It models agents in one workspace: candidates cooperate.",
      "It supports reads and writes.",
      "The runtime supports reads, writes, and deletes.",
      "It never mutates state.",
      "It remains correct after rejected input.",
      "For a new command, error precedence is `INVALID > CONFLICT`.",
      "Canonical JSON recursively orders keys.",
      "Canonical JSON recursively preserves arrays.",
      "Canonical JSON recursively emits no whitespace.",
      "Canonical JSON recursively uses scalar encoding.",
      "Unselected candidates are rebased when every selected final write is disjoint from their reads and writes.",
      "Unselected candidates are rebased when every selected final write is a compatible feed.",
      "A timed-out task cannot become successful.",
      "A timed-out task cannot emit another event.",
      "A timed-out task cannot occupy capacity forever.",
      "Export is byte-identical.",
      "matching retries do not change it.",
      "a restored runtime preserves fencing.",
      "Rejected candidates are terminal.",
      "invalid candidates are terminal.",
      "stale candidates are terminal.",
      "committed candidates are terminal.",
      "If a peer is pending, the closure is unsatisfiable.",
      "If a peer is stale-base, the closure is unsatisfiable.",
      "If a peer is excluded, the closure is unsatisfiable.",
      "Planning is pure.",
      "it does not mutate state.",
      "A dependency edge orders ancestors.",
      "a write may feed a read when digests match.",
      "a write may feed a write when digests match.",
      "Restoration validates the owned tree, exact shapes, commit history, command digests, and stored results before exposing a runtime.",
    ]);
    assert.ok(markdownAtoms.slice(0, 8).every((obligation) => obligation.proofMode === "paired"));
    assert.ok(markdownAtoms.slice(8, 11).every((obligation) => obligation.proofMode === "positive"));
    assert.ok(markdownAtoms.slice(11, 13).every((obligation) => obligation.proofMode === "paired"));
    assert.equal(markdownAtoms.find((obligation) => obligation.excerpt === "Planning is pure.")?.proofMode, "positive");
    assert.equal(markdownAtoms.find((obligation) => obligation.excerpt === "it does not mutate state.")?.proofMode, "paired");
    assert.deepEqual(first.frontierPolicy, {
      schemaVersion: 3,
      targetCuts: 6,
      minFamilies: 4,
      minOperations: 3,
      minDeepFamilies: 0,
      minCriticalFamilies: 0,
      maxObligationsPerCut: 8,
      maxObligationsPerProbe: 4,
      minCounterfactualFamilies: 4,
    });
    assert.deepEqual(verification.piFrontierDepthPolicy(10, 245), {
      schemaVersion: 3,
      targetCuts: 31,
      minFamilies: 16,
      minOperations: 5,
      minDeepFamilies: 7,
      minCriticalFamilies: 5,
      maxObligationsPerCut: 8,
      maxObligationsPerProbe: 4,
      minCounterfactualFamilies: 16,
    });
    assert.deepEqual(first.commands.map((command) => ({
      command: command.command,
      args: command.args,
      cwd: command.cwdRelative,
      source: command.source,
    })), [
      { command: "pnpm", args: ["run", "test"], cwd: ".", source: "package-json" },
      { command: "pnpm", args: ["run", "typecheck"], cwd: ".", source: "package-json" },
    ]);
    const firstHash = verification.verificationManifestSha256(first);
    assert.match(firstHash, /^[a-f0-9]{64}$/);
    assert.equal(firstHash, verification.verificationManifestSha256(first));

    const withRequest = await verification.discoverPiFrontierVerification(root,
      "Add a finite-number double export. Reject NaN with TypeError INVALID_NUMBER.");
    assert.equal(withRequest.schemaVersion, 4);
    assert.equal(withRequest.trackedTreeSha256, first.trackedTreeSha256);
    assert.equal(withRequest.contractTreeSha256, first.contractTreeSha256);
    assert.equal(withRequest.requestContract.sourcePath, ".codara/__codara_user_request__.md");
    assert.match(withRequest.requestContract.contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(withRequest.requestContract.text,
      "Add a finite-number double export. Reject NaN with TypeError INVALID_NUMBER.");
    assert.ok(withRequest.contractObligations.some((obligation) =>
      obligation.sources.some((source) => source.path === withRequest.requestContract.sourcePath)));
    assert.notEqual(verification.verificationManifestSha256(withRequest), firstHash);

    write(root, "README.md", "# Public contract\n\nReturns an exact result with a boundary.\n");
    const changed = await verification.discoverPiFrontierVerification(root);
    assert.notEqual(changed.trackedTreeSha256, first.trackedTreeSha256);
    assert.notEqual(changed.contractTreeSha256, first.contractTreeSha256);
    assert.notDeepEqual(changed.contractObligations.map((obligation) => obligation.id),
      first.contractObligations.map((obligation) => obligation.id));

    write(root, "scratch.js", "untracked but behaviorally relevant\n");
    const untracked = await verification.discoverPiFrontierVerification(root);
    assert.equal(untracked.cacheEligible, false);
    assert.match(untracked.cacheIneligibilityReasons.join("\n"), /untracked/);
  });

  await withRepo(async (root) => {
    write(root, "README.md", "# Contract\n");
    write(root, "verify.mjs", "process.exit(0);\n");
    write(root, ".codara/frontier.json", JSON.stringify({
      schemaVersion: 1,
      commands: [{
        id: "contract-verification",
        command: "node",
        args: ["verify.mjs"],
        cwd: ".",
        timeoutMs: 30_000,
      }],
      contractPaths: ["README.md"],
    }));
    git(root, "add", "README.md", "verify.mjs", ".codara/frontier.json");
    const explicit = await verification.discoverPiFrontierVerification(root);
    assert.equal(explicit.cacheEligible, true);
    assert.deepEqual(explicit.sourceManifests, [".codara/frontier.json"]);
    assert.deepEqual(explicit.commands, [{
      id: "contract-verification",
      command: "node",
      args: ["verify.mjs"],
      cwdRelative: ".",
      timeoutMs: 30_000,
      source: "codara-config",
      sourcePath: ".codara/frontier.json",
    }]);

    write(root, ".codara/frontier.json", JSON.stringify({
      schemaVersion: 1,
      commands: [{ id: "escape", command: "../outside", args: [], cwd: ".", timeoutMs: 30_000 }],
      contractPaths: ["README.md"],
    }));
    await assert.rejects(
      verification.discoverPiFrontierVerification(root),
      /basename or safe \.\/relative executable/,
    );
  });

  console.log("Pi Frontier verification discovery: exact tracked/contract fingerprints, inferred argv gates, explicit config, and cache refusal verified");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
