#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadModule() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pr-git-"));
  const outfile = path.join(temp, "pr-git.cjs");
  await esbuild.build({
    entryPoints: [
      path.join(ROOT, "src", "main", "github-pull-request-git.ts"),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [
      {
        name: "pr-git-stubs",
        setup(build) {
          build.onResolve(
            { filter: /^\.\/(?:git-exec|git-worktrees)$/ },
            (args) => ({ path: args.path, namespace: "pr-git-stub" }),
          );
          build.onLoad(
            { filter: /.*/, namespace: "pr-git-stub" },
            (args) => ({
              loader: "js",
              contents:
                args.path === "./git-exec"
                  ? `
                    export const NETWORK_TIMEOUT_MS = 90000;
                    export function errorText(value) { return value instanceof Error ? value.message : String(value); }
                    export async function runGit() { throw new Error("production git must be injected"); }
                  `
                  : `
                    export function slugifyBranchName(value) {
                      return value.replace(/[\\\\/:*?"<>|]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
                    }
                  `,
            }),
          );
        },
      },
    ],
    logLevel: "silent",
  });
  return {
    module: require(outfile),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

function input(overrides = {}) {
  return {
    repoCwd: "/repo",
    worktreesRoot: "/managed",
    repository: {
      owner: "codara",
      name: "studio",
      nameWithOwner: "codara/studio",
      url: "https://github.com/codara/studio",
      hostname: "github.com",
      defaultBranch: "main",
    },
    pullRequestNumber: 42,
    expectedHeadCommitOid: "b".repeat(40),
    localBranch: "codara/pr/0123456789ab/42/feature",
    baseBranch: "main",
    ...overrides,
  };
}

function commandArgs(args) {
  let index = 0;
  while (index < args.length) {
    if (
      args[index] === "--no-replace-objects" ||
      args[index] === "--no-optional-locks"
    ) {
      index += 1;
      continue;
    }
    if (args[index] === "-c") {
      index += 2;
      continue;
    }
    break;
  }
  return args.slice(index);
}

function dependencies(options = {}) {
  const calls = [];
  const existing = new Set(options.existing ?? []);
  const value = {
    async runGit(cwd, args, settings) {
      calls.push({ cwd, args: [...args], settings });
      const actual = commandArgs(args);
      const command = actual[0];
      if (command === "check-ref-format") return { stdout: "", stderr: "" };
      if (command === "remote" && actual.length === 1) {
        return { stdout: "origin\nbackup\n", stderr: "" };
      }
      if (command === "remote" && actual[1] === "get-url") {
        const name = actual.at(-1);
        return {
          stdout:
            name === "backup"
              ? "https://github.com/other/repo.git\n"
              : options.remoteUrl ?? "git@github.com:codara/studio.git\n",
          stderr: "",
        };
      }
      if (command === "fetch") {
        if (options.fetchError) throw new Error(options.fetchError);
        return { stdout: "", stderr: "" };
      }
      if (command === "rev-parse" && cwd === "/repo") {
        return {
          stdout: `${options.fetchedOid ?? "b".repeat(40)}\n`,
          stderr: "",
        };
      }
      if (command === "cat-file") {
        return { stdout: `${options.objectType ?? "commit"}\n`, stderr: "" };
      }
      if (command === "ls-tree") {
        return {
          stdout: options.treePaths ?? "src/a.ts\0src/b.ts\0",
          stderr: "",
        };
      }
      if (command === "check-attr") {
        const separator = actual.indexOf("--");
        const paths = actual.slice(separator + 1);
        return {
          stdout: paths
            .map((filePath) =>
              `${filePath}\0filter\0${
                options.contentFilter ?? "unspecified"
              }\0`
            )
            .join(""),
          stderr: "",
        };
      }
      if (command === "worktree" && actual[1] === "add") {
        if (options.worktreeAddError) {
          throw new Error(options.worktreeAddError);
        }
        return { stdout: "", stderr: "" };
      }
      if (command === "rev-parse") {
        return { stdout: `${"b".repeat(40)}\n`, stderr: "" };
      }
      if (command === "status") {
        return { stdout: options.status ?? "", stderr: "" };
      }
      if (command === "ls-files") {
        return { stdout: "src/a.ts\0src/b.ts\0", stderr: "" };
      }
      if (
        command === "update-ref" ||
        command === "branch" ||
        (command === "worktree" && actual[1] === "remove")
      ) {
        if (command === "update-ref" && options.privateRefCleanupError) {
          throw new Error(options.privateRefCleanupError);
        }
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${cwd} ${args.join(" ")}`);
    },
    pathExists(candidate) {
      return existing.has(candidate);
    },
    async ensureDirectory() {},
    async listDirectories() {
      return options.directories ?? [];
    },
    transactionId() {
      return "12345678-1234-1234-1234-123456789abc";
    },
    async prepareSecurityContext() {
      return {
        root: "/managed/.codara-internal/pr-import-security/transaction",
        hooksPath:
          "/managed/.codara-internal/pr-import-security/transaction/empty hooks",
        globalConfigPath:
          "/managed/.codara-internal/pr-import-security/transaction/empty gitconfig",
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL:
            "/managed/.codara-internal/pr-import-security/transaction/empty gitconfig",
          GIT_ALLOW_PROTOCOL: "https",
          GIT_PROTOCOL_FROM_USER: "0",
        },
      };
    },
    async cleanupSecurityContext() {},
  };
  return { calls, value };
}

function realGit(cwd, args, env = process.env) {
  try {
    return {
      stdout: execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString("utf8")
      : String(error.stderr ?? error.message ?? error);
    throw new Error(stderr.trim() || "git command failed");
  }
}

function writeExecutable(file, sentinel) {
  fs.writeFileSync(
    file,
    `#!/bin/sh\n: > ${JSON.stringify(sentinel)}\nexit 0\n`,
    { mode: 0o700 },
  );
  fs.chmodSync(file, 0o700);
}

async function assertRealGitExecutionBoundary(module) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pr-real-git-"));
  const upstream = path.join(root, "upstream");
  const repo = path.join(root, "repo");
  const worktreesRoot = path.join(root, "managed");
  const attackRoot = path.join(root, "attacks");
  const hooksRoot = path.join(attackRoot, "hooks");
  fs.mkdirSync(upstream, { recursive: true });
  fs.mkdirSync(hooksRoot, { recursive: true });
  fs.mkdirSync(worktreesRoot, { recursive: true });
  const hookSentinel = path.join(root, "hook-ran");
  const fsmonitorSentinel = path.join(root, "fsmonitor-ran");
  const alternateRefsSentinel = path.join(root, "alternate-refs-ran");
  const credentialSentinel = path.join(root, "credential-ran");
  const sshSentinel = path.join(root, "ssh-ran");
  const filterSentinel = path.join(root, "filter-ran");
  writeExecutable(path.join(hooksRoot, "post-checkout"), hookSentinel);
  writeExecutable(path.join(attackRoot, "fsmonitor"), fsmonitorSentinel);
  writeExecutable(path.join(attackRoot, "alternate-refs"), alternateRefsSentinel);
  writeExecutable(path.join(attackRoot, "credential"), credentialSentinel);
  writeExecutable(path.join(attackRoot, "ssh"), sshSentinel);
  writeExecutable(path.join(attackRoot, "filter"), filterSentinel);

  try {
    realGit(upstream, ["init"]);
    realGit(upstream, ["config", "user.name", "Codara Test"]);
    realGit(upstream, ["config", "user.email", "test@codara.invalid"]);
    fs.writeFileSync(path.join(upstream, "safe.txt"), "safe\n");
    realGit(upstream, ["add", "safe.txt"]);
    realGit(upstream, ["commit", "-m", "safe fixture"]);
    const safeOid = realGit(upstream, ["rev-parse", "HEAD"]).stdout.trim();
    realGit(root, ["clone", upstream, repo]);
    realGit(repo, ["remote", "set-url", "origin", "git@github.com:codara/studio.git"]);
    realGit(repo, ["config", "core.hooksPath", hooksRoot]);
    realGit(repo, ["config", "core.fsmonitor", path.join(attackRoot, "fsmonitor")]);
    realGit(repo, ["config", "core.alternateRefsCommand", path.join(attackRoot, "alternate-refs")]);
    realGit(repo, ["config", "credential.helper", `!${path.join(attackRoot, "credential")}`]);
    realGit(repo, ["config", "core.sshCommand", path.join(attackRoot, "ssh")]);
    realGit(repo, ["config", "filter.sneaky.smudge", path.join(attackRoot, "filter")]);

    // Prove the fixture is live: ordinary worktree creation executes the local
    // post-checkout hook. Remove that controlled sentinel before exercising
    // Codara's hardened path.
    const baselinePath = path.join(root, "baseline");
    realGit(repo, ["worktree", "add", baselinePath, "-b", "baseline-test", safeOid]);
    assert.equal(fs.existsSync(hookSentinel), true, "baseline hook fixture must execute");
    realGit(repo, ["worktree", "remove", "--force", baselinePath]);
    realGit(repo, ["branch", "-D", "baseline-test"]);
    fs.rmSync(hookSentinel, { force: true });
    for (const sentinel of [
      fsmonitorSentinel,
      alternateRefsSentinel,
      credentialSentinel,
      sshSentinel,
      filterSentinel,
    ]) {
      fs.rmSync(sentinel, { force: true });
    }

    const realDependencies = {
      async runGit(cwd, args, settings) {
        const actual = commandArgs(args);
        if (actual[0] === "fetch") {
          assert.equal(actual.at(-2), "https://github.com/codara/studio");
          const refspec = actual.at(-1);
          const privateRef = refspec.slice(refspec.indexOf(":") + 1);
          return realGit(cwd, ["update-ref", privateRef, safeOid], settings?.env);
        }
        return realGit(cwd, args, settings?.env);
      },
      pathExists: fs.existsSync,
      async ensureDirectory(target) {
        fs.mkdirSync(target, { recursive: true });
      },
      async listDirectories(target) {
        return fs.readdirSync(target, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      },
      transactionId() {
        return "real-git-12345678";
      },
      async prepareSecurityContext(targetRoot, transactionId) {
        const securityRoot = path.join(targetRoot, ".security", transactionId);
        const hooksPath = path.join(securityRoot, "empty-hooks");
        const globalConfigPath = path.join(securityRoot, "empty-gitconfig");
        fs.mkdirSync(hooksPath, { recursive: true, mode: 0o700 });
        fs.writeFileSync(globalConfigPath, "", { mode: 0o600 });
        return {
          root: securityRoot,
          hooksPath,
          globalConfigPath,
          env: module.hardenedGitEnvironment(globalConfigPath),
        };
      },
      async cleanupSecurityContext(context) {
        fs.rmSync(context.root, { recursive: true, force: true });
      },
    };
    const injectedSentinel = path.join(root, "env-hook-ran");
    const injectedHooks = path.join(root, "env-hooks");
    fs.mkdirSync(injectedHooks);
    writeExecutable(path.join(injectedHooks, "post-checkout"), injectedSentinel);
    const previousInjected = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
      dir: process.env.GIT_DIR,
      ssh: process.env.GIT_SSH_COMMAND,
    };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_0 = injectedHooks;
    process.env.GIT_DIR = path.join(root, "wrong-git-dir");
    process.env.GIT_SSH_COMMAND = path.join(attackRoot, "ssh");
    let imported;
    try {
      imported = await module.createPullRequestWorktree(
        input({
          repoCwd: repo,
          worktreesRoot,
          expectedHeadCommitOid: safeOid,
          localBranch: "codara/pr/0123456789ab/42/real-safe",
        }),
        realDependencies,
      );
    } finally {
      for (const [key, value] of [
        ["GIT_CONFIG_COUNT", previousInjected.count],
        ["GIT_CONFIG_KEY_0", previousInjected.key],
        ["GIT_CONFIG_VALUE_0", previousInjected.value],
        ["GIT_DIR", previousInjected.dir],
        ["GIT_SSH_COMMAND", previousInjected.ssh],
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.equal(imported.ok, true, imported.error);
    for (const sentinel of [
      hookSentinel,
      fsmonitorSentinel,
      alternateRefsSentinel,
      credentialSentinel,
      sshSentinel,
      filterSentinel,
      injectedSentinel,
    ]) {
      assert.equal(fs.existsSync(sentinel), false, `${path.basename(sentinel)} must not execute`);
    }
    const cleanupResult = await module.cleanupPullRequestWorktree(
      {
        repoCwd: repo,
        worktreesRoot,
        worktreePath: imported.path,
        branch: imported.branch,
        expectedHeadCommitOid: safeOid,
      },
      realDependencies,
    );
    assert.equal(cleanupResult.ok, true, cleanupResult.error);
    assert.equal(fs.existsSync(imported.path), false);
    assert.throws(
      () => realGit(repo, ["rev-parse", "--verify", `refs/heads/${imported.branch}`]),
      /Needed a single revision|unknown revision|ambiguous argument|fatal/i,
      "cleanup compare-deletes the exact owned branch",
    );

    const splitImported = await module.createPullRequestWorktree(
      input({
        repoCwd: repo,
        worktreesRoot,
        expectedHeadCommitOid: safeOid,
        localBranch: "codara/pr/0123456789ab/42/recovery-split",
      }),
      realDependencies,
    );
    assert.equal(splitImported.ok, true, splitImported.error);
    // Simulate a crash after worktree removal but before the branch CAS. A
    // second cleanup pass must prove the path/branch are unregistered and
    // finish only the exact expected branch deletion.
    realGit(repo, ["worktree", "remove", "--", splitImported.path]);
    assert.equal(
      realGit(repo, [
        "rev-parse",
        "--verify",
        `refs/heads/${splitImported.branch}`,
      ]).stdout.trim(),
      safeOid,
    );
    const resumedCleanup = await module.cleanupPullRequestWorktree(
      {
        repoCwd: repo,
        worktreesRoot,
        worktreePath: splitImported.path,
        branch: splitImported.branch,
        expectedHeadCommitOid: safeOid,
      },
      realDependencies,
    );
    assert.equal(resumedCleanup.ok, true, resumedCleanup.error);
    assert.throws(
      () =>
        realGit(repo, [
          "rev-parse",
          "--verify",
          `refs/heads/${splitImported.branch}`,
        ]),
      /Needed a single revision|unknown revision|ambiguous argument|fatal/i,
      "cleanup resumes the branch-only half of a prior transaction",
    );

    // A committed filter is rejected before worktree materialization, and its
    // configured smudge process never runs.
    fs.writeFileSync(path.join(upstream, ".gitattributes"), "payload.txt filter=sneaky\n");
    fs.writeFileSync(path.join(upstream, "payload.txt"), "payload\n");
    realGit(upstream, ["add", ".gitattributes", "payload.txt"]);
    realGit(upstream, ["commit", "-m", "filter fixture"]);
    const filterOid = realGit(upstream, ["rev-parse", "HEAD"]).stdout.trim();
    realGit(repo, ["fetch", upstream, filterOid]);
    const filterDependencies = {
      ...realDependencies,
      async runGit(cwd, args, settings) {
        const actual = commandArgs(args);
        if (actual[0] === "fetch") {
          const refspec = actual.at(-1);
          const privateRef = refspec.slice(refspec.indexOf(":") + 1);
          return realGit(cwd, ["update-ref", privateRef, filterOid], settings?.env);
        }
        return realGit(cwd, args, settings?.env);
      },
      transactionId() {
        return "real-git-filter-12345678";
      },
    };
    const rejected = await module.createPullRequestWorktree(
      input({
        repoCwd: repo,
        worktreesRoot,
        expectedHeadCommitOid: filterOid,
        localBranch: "codara/pr/0123456789ab/42/real-filter",
      }),
      filterDependencies,
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /content filters/i);
    assert.equal(fs.existsSync(filterSentinel), false, "smudge filter must not execute");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const { module, cleanup } = await loadModule();
  try {
    for (const [value, expected] of [
      [
        "https://github.com/codara/studio.git",
        { hostname: "github.com", nameWithOwner: "codara/studio" },
      ],
      [
        "git@github.com:codara/studio.git",
        { hostname: "github.com", nameWithOwner: "codara/studio" },
      ],
      [
        "ssh://git@git.example/codara/studio.git",
        { hostname: "git.example", nameWithOwner: "codara/studio" },
      ],
    ]) {
      assert.deepEqual(module.parseGitRemoteRepositoryIdentity(value), expected);
    }
    for (const hostile of [
      " https://github.com/codara/studio.git",
      "http://github.com/codara/studio.git",
      "https://user:token@github.com/codara/studio.git",
      "https://github.com:8443/codara/studio.git",
      "https://github.com/codara%2Fstudio.git",
      "https://github.com/codara/studio.git?token=secret",
      "git@github.com:../studio.git",
      "git@github.com:codara/studio/extra.git",
      "file:///tmp/repo.git",
      "git@github.com:codara/studio.git\nnext",
    ]) {
      assert.equal(
        module.parseGitRemoteRepositoryIdentity(hostile),
        null,
        hostile,
      );
    }

    {
      const mock = dependencies();
      const result = await module.createPullRequestWorktree(input(), mock.value);
      assert.equal(result.ok, true);
      assert.equal(result.branch, "codara/pr/0123456789ab/42/feature");
      assert.equal(result.fileCount, 2);
      const fetch = mock.calls.find(
        (call) => commandArgs(call.args)[0] === "fetch",
      );
      assert.ok(fetch);
      assert.equal(fetch.args[0], "--no-replace-objects");
      const fetchCommand = commandArgs(fetch.args);
      assert.deepEqual(fetchCommand.slice(0, 10), [
        "fetch",
        "--no-tags",
        "--force",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-commit-graph",
        "--no-filter",
        "--",
        "https://github.com/codara/studio",
      ]);
      assert.match(
        fetchCommand[10],
        /^\+refs\/pull\/42\/head:refs\/codara\/pr-import\//,
      );
      assert.ok(
        fetch.args.includes(
          "credential.https://github.com.helper=!gh auth git-credential",
        ),
        "the PR fetch reuses the authenticated gh credential provider for private repositories",
      );
      assert.equal(
        fetchCommand.join(" ").includes("feature"),
        false,
        "the contributor branch never enters the fetch refspec",
      );
      const add = mock.calls.find(
        (call) => {
          const actual = commandArgs(call.args);
          return actual[0] === "worktree" && actual[1] === "add";
        },
      );
      assert.equal(add.args.at(-1), "b".repeat(40));
      assert.ok(
        mock.calls.some(
          (call) => {
            const actual = commandArgs(call.args);
            return (
              actual[0] === "update-ref" &&
              actual[1] === "-d" &&
              actual.at(-1) === "b".repeat(40)
            );
          },
        ),
        "the private transaction ref is compare-and-deleted at its verified OID",
      );
      assert.ok(
        mock.calls.every(
          (call) =>
            call.args[0] === "--no-replace-objects" &&
            call.args.includes("--no-optional-locks") &&
            call.args.includes("core.fsmonitor=false") &&
            call.args.includes("credential.helper=") &&
            call.args.includes("core.alternateRefsCommand=") &&
            call.args.some((arg) => arg.startsWith("core.hooksPath=/")),
        ),
        "all import and verification commands disable hooks, fsmonitor, helpers, alternate commands, and replacement refs",
      );
      assert.ok(
        mock.calls.every(
          (call) =>
            call.settings?.env?.GIT_CONFIG_GLOBAL?.includes(
              "empty gitconfig",
            ) &&
            call.settings?.env?.GIT_ALLOW_PROTOCOL === "https" &&
            call.settings?.env?.GIT_NO_LAZY_FETCH === "1",
        ),
        "every Git process receives the scrubbed import environment",
      );
    }

    {
      const mock = dependencies({
        fetchError: "fatal: unable to get password from user",
      });
      const result = await module.createPullRequestWorktree(input(), mock.value);
      assert.equal(result.ok, false);
      assert.match(result.error, /gh auth login/);
      assert.match(result.error, /account can read this repository/);
      assert.doesNotMatch(result.error, /fatal:/);
    }

    {
      const mock = dependencies({ fetchedOid: "c".repeat(40) });
      const result = await module.createPullRequestWorktree(input(), mock.value);
      assert.equal(result.ok, false);
      assert.match(result.error, /head moved/i);
      assert.equal(
        mock.calls.some(
          (call) => {
            const actual = commandArgs(call.args);
            return actual[0] === "worktree" && actual[1] === "add";
          },
        ),
        false,
      );
      assert.ok(
        mock.calls.some(
          (call) => {
            const actual = commandArgs(call.args);
            return (
              actual[0] === "update-ref" &&
              actual[1] === "-d" &&
              actual.at(-1) === "c".repeat(40)
            );
          },
        ),
      );
    }

    {
      const mock = dependencies({
        remoteUrl: "git@github.com:other/repo.git",
      });
      const result = await module.createPullRequestWorktree(input(), mock.value);
      assert.equal(result.ok, false);
      assert.match(result.error, /No configured Git remote/);
      assert.equal(
        mock.calls.some((call) => commandArgs(call.args)[0] === "fetch"),
        false,
      );
    }

    {
      const mock = dependencies({ objectType: "tag" });
      const result = await module.createPullRequestWorktree(input(), mock.value);
      assert.equal(result.ok, false);
      assert.match(result.error, /not a Git commit/);
    }

    {
      const mock = dependencies({ contentFilter: "hostile-smudge" });
      const result = await module.createPullRequestWorktree(input(), mock.value);
      assert.equal(result.ok, false);
      assert.match(result.error, /content filters/i);
      assert.equal(
        mock.calls.some((call) => {
          const actual = commandArgs(call.args);
          return actual[0] === "worktree" && actual[1] === "add";
        }),
        false,
        "a resolved smudge/process driver is rejected before checkout",
      );
    }

    {
      const mock = dependencies({
        worktreeAddError: "branch already exists",
      });
      const result = await module.createPullRequestWorktree(input(), mock.value);
      assert.equal(result.ok, false);
      assert.equal(result.retained, undefined);
      assert.equal(
        mock.calls.some(
          (call) => {
            const actual = commandArgs(call.args);
            return actual[0] === "worktree" && actual[1] === "remove";
          },
        ),
        false,
        "a losing add never removes a concurrent winner's worktree",
      );
      assert.equal(
        mock.calls.some((call) => commandArgs(call.args)[0] === "branch"),
        false,
      );
    }

    {
      const mock = dependencies({ status: "?? hook-output.txt\n" });
      const result = await module.createPullRequestWorktree(input(), mock.value);
      assert.equal(result.ok, false);
      assert.deepEqual(result.retained, {
        path: "/managed/codara-pr-0123456789ab-42-feature",
        branch: "codara/pr/0123456789ab/42/feature",
      });
      assert.equal(
        mock.calls.some(
          (call) => {
            const actual = commandArgs(call.args);
            return actual[0] === "worktree" && actual[1] === "remove";
          },
        ),
        false,
        "post-checkout hook or user data is retained for recovery",
      );
    }

    {
      const mock = dependencies({
        privateRefCleanupError: "injected compare-delete failure",
      });
      const result = await module.createPullRequestWorktree(
        input(),
        mock.value,
      );
      assert.equal(result.ok, false);
      assert.match(result.error, /private Git reference/i);
      assert.deepEqual(result.retained, {
        path: "/managed/codara-pr-0123456789ab-42-feature",
        branch: "codara/pr/0123456789ab/42/feature",
      });
    }

    for (const hostile of [
      input({ pullRequestNumber: 0 }),
      input({ expectedHeadCommitOid: "a".repeat(41) }),
      input({ localBranch: "--upload-pack=evil" }),
      input({
        repository: {
          ...input().repository,
          url: "https://evil.example/codara/studio",
        },
      }),
    ]) {
      const mock = dependencies();
      const result = await module.createPullRequestWorktree(hostile, mock.value);
      assert.equal(result.ok, false);
      assert.equal(
        mock.calls.some((call) => commandArgs(call.args)[0] === "fetch"),
        false,
      );
    }

    await assertRealGitExecutionBoundary(module);

    console.log(
      "PASS exact GitHub PR fetch, remote pinning, OID fencing, real-Git execution isolation, and cleanup",
    );
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
