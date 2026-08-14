// Focused harness for src/main/github-cli.ts. The adapter is bundled with
// esbuild, then driven entirely through its injected resolver/runner so these
// tests need neither `gh` nor a GitHub account.
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function bundle() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `github-cli-test-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "github-cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  delete require.cache[outfile];
  return { github: require(outfile), outfile };
}

function fakeAdapter(github, responses, executablePath = "/opt/homebrew/bin/gh") {
  const calls = [];
  const queue = [...responses];
  const adapter = github.createGitHubCliAdapter({
    resolveBinary: async (name) => {
      assert.equal(name, "gh");
      return executablePath;
    },
    runCommand: async (command) => {
      calls.push(command);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next && next.throw) throw next.throw;
      return next ?? { stdout: "", stderr: "" };
    },
  });
  return { adapter, calls, queue };
}

function commandFailure(stderr, code) {
  const error = new Error("command failed");
  error.stderr = stderr;
  if (code) error.code = code;
  return error;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "GitHubCliError");
    assert.equal(error?.code, code);
    return true;
  });
}

async function main() {
  const { github, outfile } = await bundle();
  const temp = mkdtempSync(path.join(os.tmpdir(), "codara-github-cli-"));
  try {
    // `gh auth status` is answered from a process-wide cache, so every case
    // that exercises diagnose() starts by dropping it — otherwise the first
    // case's answer would be handed to the second.
    {
      github.invalidateGitHubCliDiagnosticCache();
      let ran = false;
      const adapter = github.createGitHubCliAdapter({
        resolveBinary: async () => null,
        runCommand: async () => {
          ran = true;
          return { stdout: "", stderr: "" };
        },
      });
      assert.deepEqual(await adapter.diagnose(), {
        installed: false,
        authenticated: false,
        hint: "Install GitHub CLI, then run `gh auth login`.",
      });
      assert.equal(ran, false, "a missing binary must not spawn a command");
    }

    {
      github.invalidateGitHubCliDiagnosticCache();
      const { adapter, calls } = fakeAdapter(github, [{ stdout: "", stderr: "" }]);
      assert.deepEqual(await adapter.diagnose(), {
        installed: true,
        authenticated: true,
        executablePath: "/opt/homebrew/bin/gh",
      });
      assert.deepEqual(calls[0].args, ["auth", "status"]);
      assert.equal(calls[0].cwd, undefined);
      assert.equal(calls[0].timeoutMs, github.GITHUB_CLI_AUTH_TIMEOUT_MS);
      assert.equal(calls[0].maxOutputBytes, github.GITHUB_CLI_MAX_OUTPUT_BYTES);
    }

    {
      github.invalidateGitHubCliDiagnosticCache();
      const secret = `ghp_${"x".repeat(32)}`;
      const { adapter } = fakeAdapter(github, [
        commandFailure(`not logged in; token ${secret}`),
      ]);
      const diagnostic = await adapter.diagnose();
      assert.equal(diagnostic.installed, true);
      assert.equal(diagnostic.authenticated, false);
      assert.match(diagnostic.hint, /\[redacted\]/);
      assert.doesNotMatch(diagnostic.hint, /ghp_/);
    }

    // An authenticated answer is reused for its full TTL, across adapter
    // instances — callers build a fresh adapter at every site, so an
    // instance-level cache would never be hit.
    {
      const clock = { now: 5_000_000 };
      github.setGitHubCliCacheClock(() => clock.now);
      try {
        github.invalidateGitHubCliDiagnosticCache();
        const first = fakeAdapter(github, [{ stdout: "", stderr: "" }]);
        const second = fakeAdapter(github, [{ stdout: "", stderr: "" }]);
        assert.equal((await first.adapter.diagnose()).authenticated, true);
        assert.equal((await second.adapter.diagnose()).authenticated, true);
        assert.equal(first.calls.length, 1);
        assert.equal(
          second.calls.length,
          0,
          "a second adapter reuses the cached auth answer",
        );

        clock.now += github.GITHUB_CLI_DIAGNOSTIC_TTL_MS - 1;
        await second.adapter.diagnose();
        assert.equal(second.calls.length, 0, "still inside the TTL");
        clock.now += 1;
        await second.adapter.diagnose();
        assert.equal(second.calls.length, 1, "the TTL expired");

        // A cold cache with several readers arriving together spawns one `gh`.
        github.invalidateGitHubCliDiagnosticCache();
        const burst = fakeAdapter(github, [{ stdout: "", stderr: "" }]);
        const answers = await Promise.all(
          Array.from({ length: 20 }, () => burst.adapter.diagnose()),
        );
        assert.equal(burst.calls.length, 1, "20 readers share one `gh auth status`");
        assert.equal(answers[19].authenticated, true);

        // A disconnected CLI expires quickly: the fix is `gh auth login` in a
        // terminal Codara never sees, so it has to re-ask on its own.
        github.invalidateGitHubCliDiagnosticCache();
        const offline = fakeAdapter(github, [
          commandFailure("not logged in"),
          { stdout: "", stderr: "" },
        ]);
        assert.equal((await offline.adapter.diagnose()).authenticated, false);
        clock.now += github.GITHUB_CLI_DIAGNOSTIC_FAILURE_TTL_MS - 1;
        await offline.adapter.diagnose();
        assert.equal(offline.calls.length, 1, "still inside the failure TTL");
        clock.now += 1;
        assert.equal(
          (await offline.adapter.diagnose()).authenticated,
          true,
          "a re-login is picked up once the short failure TTL expires",
        );
        assert.equal(offline.calls.length, 2);
        assert.ok(
          github.GITHUB_CLI_DIAGNOSTIC_FAILURE_TTL_MS <
            github.GITHUB_CLI_DIAGNOSTIC_TTL_MS,
          "a failure must never be cached as long as a success",
        );
      } finally {
        github.setGitHubCliCacheClock(null);
        github.invalidateGitHubCliDiagnosticCache();
      }
    }

    {
      const payload = {
        nameWithOwner: "pingdotgg/t3code",
        url: "https://github.com/pingdotgg/t3code",
        defaultBranchRef: { name: "main" },
      };
      const { adapter, calls } = fakeAdapter(github, [
        { stdout: JSON.stringify(payload), stderr: "" },
      ]);
      assert.deepEqual(await adapter.resolveRepository("/repo"), {
        owner: "pingdotgg",
        name: "t3code",
        nameWithOwner: "pingdotgg/t3code",
        url: "https://github.com/pingdotgg/t3code",
        hostname: "github.com",
        defaultBranch: "main",
      });
      assert.deepEqual(calls[0].args, [
        "repo",
        "view",
        "--json",
        "nameWithOwner,url,defaultBranchRef",
      ]);
      assert.equal(calls[0].cwd, "/repo");
      assert.equal(calls[0].timeoutMs, github.GITHUB_CLI_READ_TIMEOUT_MS);
    }

    {
      const { adapter } = fakeAdapter(github, [
        {
          stdout: JSON.stringify({
            nameWithOwner: "missing-slash",
            url: "https://github.com/example/repo",
            defaultBranchRef: null,
          }),
          stderr: "",
        },
      ]);
      await rejectsCode(adapter.resolveRepository("/repo"), "invalid-response");
    }

    {
      const payload = {
        number: 42,
        title: "Ship the fleet overview",
        url: "https://github.com/codara/studio/pull/42",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        headRefName: "feature/fleet",
        updatedAt: "2026-07-30T08:15:00Z",
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: [
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
          { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
          { __typename: "StatusContext", state: "SUCCESS" },
        ],
      };
      const { adapter, calls } = fakeAdapter(github, [
        { stdout: JSON.stringify(payload), stderr: "" },
      ]);
      assert.deepEqual(await adapter.getCurrentPullRequest("/repo"), {
        number: 42,
        title: "Ship the fleet overview",
        url: "https://github.com/codara/studio/pull/42",
        state: "OPEN",
        isDraft: false,
        baseBranch: "main",
        headBranch: "feature/fleet",
        updatedAt: "2026-07-30T08:15:00Z",
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "BLOCKED",
        checks: { total: 4, successful: 2, failed: 1, pending: 1 },
      });
      assert.equal(calls[0].args[0], "pr");
      assert.equal(calls[0].args[1], "view");
      assert.equal(calls[0].args[2], "--json");
      assert.equal(calls[0].args.length, 4, "PR lookup uses one fixed JSON field argument");
      assert.doesNotMatch(calls[0].args[3], /body|comments|reviews/);
      // Status reads request only what this projection parses. `gh` validates
      // --json names before it looks for a pull request, so an import-only
      // field here would fail the panel on every branch of an older CLI —
      // `baseRefOid` needs gh 2.63+ and is discarded by the summary parser.
      assert.doesNotMatch(calls[0].args[3], /baseRefOid|headRepository/);
      for (const field of [
        "mergeStateStatus",
        "statusCheckRollup",
        "reviewDecision",
        "headRefOid",
      ]) {
        assert.match(calls[0].args[3], new RegExp(`(^|,)${field}(,|$)`));
      }
    }

    {
      const { adapter } = fakeAdapter(github, [
        commandFailure('no pull requests found for branch "local-only"'),
      ]);
      assert.equal(await adapter.getCurrentPullRequest("/repo"), null);
    }

    {
      const { adapter } = fakeAdapter(github, [
        commandFailure("HTTP 401: Bad credentials. Run gh auth login."),
      ]);
      await rejectsCode(adapter.getCurrentPullRequest("/repo"), "not-authenticated");
    }

    {
      const { adapter } = fakeAdapter(github, [
        {
          stdout: JSON.stringify({
            number: 1,
            title: "Malformed checks",
            url: "https://github.com/example/repo/pull/1",
            state: "OPEN",
            isDraft: false,
            baseRefName: "main",
            headRefName: "topic",
            statusCheckRollup: {},
          }),
          stderr: "",
        },
      ]);
      await rejectsCode(adapter.getCurrentPullRequest("/repo"), "invalid-response");
    }

    {
      const { adapter, calls } = fakeAdapter(github, [
        {
          stdout: JSON.stringify([
            {
              number: 73,
              title: "Mobile reconnect should survive a network change",
              url: "https://github.com/codara/studio/issues/73",
              labels: [{ name: "mobile" }, { name: "reliability" }],
              updatedAt: "2026-07-30T09:00:00Z",
            },
          ]),
          stderr: "",
        },
      ]);
      assert.deepEqual(await adapter.listOpenIssues("/repo"), [
        {
          number: 73,
          title: "Mobile reconnect should survive a network change",
          url: "https://github.com/codara/studio/issues/73",
          labels: ["mobile", "reliability"],
          updatedAt: "2026-07-30T09:00:00Z",
        },
      ]);
      assert.deepEqual(calls[0].args, [
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        String(github.GITHUB_ISSUE_LIST_LIMIT),
        "--json",
        "number,title,url,labels,updatedAt",
      ]);
    }

    {
      const payload = {
        number: 73,
        title: "Mobile reconnect should survive a network change",
        url: "https://github.com/codara/studio/issues/73",
        state: "OPEN",
        labels: [
          { name: "mobile" },
          { name: "reliability" },
          { name: "one" },
          { name: "two" },
          { name: "three" },
          { name: "four" },
          { name: "five" },
          { name: "six" },
          { name: "not-forwarded" },
        ],
        updatedAt: "2026-07-30T09:00:00Z",
      };
      const { adapter, calls } = fakeAdapter(github, [
        { stdout: JSON.stringify(payload), stderr: "" },
      ]);
      assert.deepEqual(await adapter.getIssue("/repo", 73), {
        number: 73,
        title: "Mobile reconnect should survive a network change",
        url: "https://github.com/codara/studio/issues/73",
        labels: [
          "mobile",
          "reliability",
          "one",
          "two",
          "three",
          "four",
          "five",
          "six",
        ],
        updatedAt: "2026-07-30T09:00:00Z",
      });
      assert.deepEqual(calls[0].args, [
        "issue",
        "view",
        "73",
        "--json",
        "number,title,url,state,labels,updatedAt",
      ]);
      assert.equal(calls[0].cwd, "/repo");
      assert.equal(calls[0].timeoutMs, github.GITHUB_CLI_READ_TIMEOUT_MS);
    }

    {
      const { adapter, calls } = fakeAdapter(github, []);
      for (const issueNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await rejectsCode(adapter.getIssue("/repo", issueNumber), "command-failed");
      }
      assert.equal(
        calls.length,
        0,
        "invalid issue numbers are rejected before resolving/spawning",
      );
    }

    for (const payload of [
      {
        number: 74,
        title: "Different issue",
        url: "https://github.com/codara/studio/issues/74",
        state: "OPEN",
        labels: [],
      },
      {
        number: 73,
        title: "Closed issue",
        url: "https://github.com/codara/studio/issues/73",
        state: "CLOSED",
        labels: [],
      },
    ]) {
      const { adapter } = fakeAdapter(github, [
        { stdout: JSON.stringify(payload), stderr: "" },
      ]);
      await rejectsCode(adapter.getIssue("/repo", 73), "invalid-response");
    }

    {
      const { adapter, calls } = fakeAdapter(github, []);
      await rejectsCode(adapter.resolveRepository("  "), "command-failed");
      assert.equal(calls.length, 0, "invalid cwd is rejected before resolving/spawning");
    }

    {
      const body = "Release notes\n\n$(touch never-run)\n; echo still-data";
      const { adapter, calls } = fakeAdapter(github, [
        { stdout: "https://github.com/codara/studio/pull/91\n", stderr: "" },
      ]);
      await adapter.createPullRequest({
        cwd: "/repo",
        title: "Ship mobile source control; $(still text)",
        body,
        draft: true,
        baseBranch: "main",
        headBranch: "feature/mobile-publish",
      });
      assert.deepEqual(calls[0].args, [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        "feature/mobile-publish",
        "--title",
        "Ship mobile source control; $(still text)",
        "--body-file",
        "-",
        "--draft",
      ]);
      assert.equal(calls[0].stdin, body, "PR body is transported only on stdin");
      assert.doesNotMatch(JSON.stringify(calls[0].args), /Release notes|never-run/);
      assert.equal(calls[0].timeoutMs, github.GITHUB_CLI_WRITE_TIMEOUT_MS);
    }

    {
      const { adapter, calls } = fakeAdapter(github, []);
      await rejectsCode(
        adapter.createPullRequest({
          cwd: "/repo",
          title: "line one\nline two",
          body: "",
          draft: false,
          baseBranch: "main",
          headBranch: "topic",
        }),
        "command-failed",
      );
      assert.equal(calls.length, 0, "invalid publish fields are rejected before spawning");
    }

    // The IPC-facing projection never forwards executable paths, raw command
    // output, auth hints, or Error objects.
    {
      const secret = `ghp_${"z".repeat(32)}`;
      const status = await github.readGitHubWorkspaceStatus("/repo", {
        diagnose: async () => ({
          installed: false,
          authenticated: false,
          executablePath: "/private/bin/gh",
          hint: `token ${secret}`,
        }),
        resolveRepository: async () => {
          throw new Error("must not resolve");
        },
        getCurrentPullRequest: async () => {
          throw new Error("must not read PR");
        },
        getIssue: async () => {
          throw new Error("must not read issue");
        },
      });
      assert.deepEqual(status, {
        kind: "not-installed",
        message: "Install GitHub CLI (`gh`), then run `gh auth login` in a terminal.",
      });
      assert.doesNotMatch(JSON.stringify(status), /ghp_|private\/bin/);
    }

    {
      const repository = {
        owner: "codara",
        name: "studio",
        nameWithOwner: "codara/studio",
        url: "https://github.com/codara/studio",
        hostname: "github.com",
        defaultBranch: "main",
      };
      const status = await github.readGitHubWorkspaceStatus("/repo", {
        diagnose: async () => ({ installed: true, authenticated: true }),
        resolveRepository: async () => repository,
        getCurrentPullRequest: async () => null,
        getIssue: async () => {
          throw new Error("must not read issue");
        },
      });
      assert.deepEqual(status, { kind: "ready", repository, pullRequest: null, issues: [] });
    }

    {
      const repository = {
        owner: "codara",
        name: "studio",
        nameWithOwner: "codara/studio",
        url: "https://github.com/codara/studio",
        hostname: "github.com",
        defaultBranch: "main",
      };
      const status = await github.readGitHubWorkspaceStatus("/repo", {
        diagnose: async () => ({ installed: true, authenticated: true }),
        resolveRepository: async () => repository,
        getCurrentPullRequest: async () => null,
        getIssue: async () => {
          throw new Error("must not read issue");
        },
        listOpenIssues: async () => {
          throw new Error(`token ghp_${"z".repeat(32)}`);
        },
      });
      assert.deepEqual(status, {
        kind: "ready",
        repository,
        pullRequest: null,
        issues: [],
        issuesError: "Open issues could not be loaded. Refresh to try again.",
      });
      assert.doesNotMatch(JSON.stringify(status), /ghp_/);
    }

    {
      const status = await github.readGitHubWorkspaceStatus("/repo", {
        diagnose: async () => ({ installed: true, authenticated: true }),
        resolveRepository: async () => {
          throw new github.GitHubCliError(
            "command-failed",
            "none of the git remotes configured for this repository point to a known GitHub host",
          );
        },
        getCurrentPullRequest: async () => null,
        getIssue: async () => {
          throw new Error("must not read issue");
        },
      });
      assert.equal(status.kind, "not-repository");
    }

    {
      const status = await github.readGitHubWorkspaceStatus("/repo", {
        diagnose: async () => ({ installed: true, authenticated: true }),
        resolveRepository: async () => {
          throw new github.GitHubCliError(
            "not-authenticated",
            `Bad credentials: ghp_${"q".repeat(32)}`,
          );
        },
        getCurrentPullRequest: async () => null,
        getIssue: async () => {
          throw new Error("must not read issue");
        },
      });
      assert.deepEqual(status, {
        kind: "not-authenticated",
        message: "GitHub CLI is disconnected. Run `gh auth login`, then refresh.",
      });
      assert.doesNotMatch(JSON.stringify(status), /ghp_/);
    }

    // An installed, authenticated, but stale `gh` fails with "Unknown JSON
    // field". That is a CLI-age problem, not a refresh problem, so it gets its
    // own status instead of the generic error — and the CLI's field dump never
    // reaches the renderer.
    {
      const repository = {
        owner: "codara",
        name: "studio",
        nameWithOwner: "codara/studio",
        url: "https://github.com/codara/studio",
        hostname: "github.com",
        defaultBranch: "main",
      };
      const status = await github.readGitHubWorkspaceStatus("/repo", {
        diagnose: async () => ({ installed: true, authenticated: true }),
        resolveRepository: async () => repository,
        getCurrentPullRequest: async () => {
          throw new github.GitHubCliError(
            "command-failed",
            'Unknown JSON field: "baseRefOid" Available fields: additions assignees author baseRefName body changedFiles closed comments commits',
          );
        },
        getIssue: async () => {
          throw new Error("must not read issue");
        },
      });
      assert.deepEqual(status, {
        kind: "outdated-cli",
        message:
          "This GitHub CLI is too old for Codara Studio. Update `gh` to the latest version, then refresh.",
      });
      assert.doesNotMatch(
        JSON.stringify(status),
        /baseRefOid|Available fields/,
      );
    }

    // The UI-facing status read is cached per workspace and coalesced, so a
    // burst of callers costs one `gh` subprocess tree rather than four each.
    {
      const clock = { now: 9_000_000 };
      github.setGitHubCliCacheClock(() => clock.now);
      try {
        github.invalidateAllGitHubStatusCaches();
        const repository = {
          owner: "codara",
          name: "studio",
          nameWithOwner: "codara/studio",
          url: "https://github.com/codara/studio",
          hostname: "github.com",
          defaultBranch: "main",
        };
        let reads = 0;
        const adapter = {
          diagnose: async () => ({ installed: true, authenticated: true }),
          resolveRepository: async () => {
            reads += 1;
            return repository;
          },
          getCurrentPullRequest: async () => null,
          getIssue: async () => {
            throw new Error("must not read issue");
          },
        };
        const read = (cwd, options = {}) =>
          github.readCachedGitHubWorkspaceStatus(cwd, { ...options, adapter });

        const first = await read("/repo");
        assert.equal(first.kind, "ready");
        assert.equal(reads, 1);
        await read("/repo");
        assert.equal(reads, 1, "a second background read is served from cache");

        // Two workspaces never share an entry.
        await read("/other");
        assert.equal(reads, 2, "a different workspace builds its own entry");

        // Concurrent background readers collapse onto one in-flight read.
        github.invalidateAllGitHubStatusCaches();
        reads = 0;
        const burst = await Promise.all(
          Array.from({ length: 20 }, () => read("/repo")),
        );
        assert.equal(reads, 1, "20 readers share one status read");
        assert.equal(burst[19].kind, "ready");

        // The returned object is a copy: a caller mutating it cannot corrupt
        // what the next reader is handed.
        const snapshot = await read("/repo");
        snapshot.repository.nameWithOwner = "tampered/repo";
        const afterTamper = await read("/repo");
        assert.equal(afterTamper.repository.nameWithOwner, "codara/studio");

        // A read the user asked for always goes to GitHub, warm cache or not,
        // and leaves the fresh answer behind for the background readers.
        reads = 0;
        await read("/repo", { refresh: true });
        assert.equal(reads, 1, "a loud read bypasses the cache");
        await read("/repo");
        assert.equal(reads, 1, "and repopulates it");

        // Expiry.
        clock.now += github.GITHUB_STATUS_CACHE_TTL_MS - 1;
        await read("/repo");
        assert.equal(reads, 1, "still inside the TTL");
        clock.now += 1;
        await read("/repo");
        assert.equal(reads, 2, "the TTL expired");

        // Invalidating one workspace leaves every other workspace cached —
        // this is what publish/mark-ready/merge call.
        await read("/other");
        reads = 0;
        github.invalidateGitHubStatusCache("/repo");
        await read("/other");
        assert.equal(reads, 0, "an unrelated workspace keeps its entry");
        await read("/repo");
        assert.equal(reads, 1, "the invalidated workspace rebuilds");
      } finally {
        github.setGitHubCliCacheClock(null);
        github.invalidateAllGitHubStatusCaches();
      }
    }

    // Mark-ready names one exact repository and pull request in a fixed,
    // non-shell argv vector.
    {
      const { adapter, calls } = fakeAdapter(github, [
        { stdout: "", stderr: "" },
      ]);
      await adapter.markPullRequestReady({
        cwd: "/repo",
        repository: "codara/studio",
        pullRequestNumber: 42,
      });
      assert.deepEqual(calls[0].args, [
        "pr",
        "ready",
        "42",
        "--repo",
        "codara/studio",
      ]);
      assert.equal(calls[0].cwd, "/repo");
      assert.equal(calls[0].timeoutMs, github.GITHUB_CLI_WRITE_TIMEOUT_MS);
      assert.equal(calls[0].maxOutputBytes, github.GITHUB_CLI_MAX_OUTPUT_BYTES);
      assert.equal(calls[0].stdin, undefined);
    }

    {
      const { adapter, calls } = fakeAdapter(github, []);
      await rejectsCode(
        adapter.markPullRequestReady({
          cwd: "/repo",
          repository: "--repo",
          pullRequestNumber: 0,
        }),
        "command-failed",
      );
      assert.equal(
        calls.length,
        0,
        "invalid mark-ready identity is rejected before spawning",
      );
    }

    // Merge is one fixed, non-shell argv vector pinned to the reviewed head.
    {
      const { adapter, calls } = fakeAdapter(github, [
        { stdout: "", stderr: "" },
      ]);
      await adapter.mergePullRequest({
        cwd: "/repo",
        repository: "codara/studio",
        pullRequestNumber: 42,
        strategy: "squash",
        expectedHeadCommitOid: "0123456789abcdef0123456789abcdef01234567",
      });
      assert.deepEqual(calls[0].args, [
        "pr",
        "merge",
        "42",
        "--repo",
        "codara/studio",
        "--squash",
        "--match-head-commit",
        "0123456789abcdef0123456789abcdef01234567",
      ]);
      assert.equal(calls[0].cwd, "/repo");
      assert.equal(calls[0].timeoutMs, github.GITHUB_CLI_WRITE_TIMEOUT_MS);
      assert.equal(calls[0].maxOutputBytes, github.GITHUB_CLI_MAX_OUTPUT_BYTES);
      assert.equal(calls[0].stdin, undefined);
    }

    {
      const repo = {
        owner: "codara",
        name: "studio",
        nameWithOwner: "codara/studio",
        url: "https://github.com/codara/studio",
        hostname: "github.com",
        defaultBranch: "main",
      };
      const { adapter, calls } = fakeAdapter(github, [
        {
          stdout: JSON.stringify([
            {
              number: 73,
              title: "Pinned issue",
              url: "https://github.com/codara/studio/issues/73",
              labels: [],
              updatedAt: "2026-07-31T09:00:00Z",
            },
          ]),
          stderr: "",
        },
        {
          stdout: JSON.stringify([
            {
              number: 42,
              title: "Pinned pull request",
              url: "https://github.com/codara/studio/pull/42",
              state: "OPEN",
              isDraft: false,
              baseRefName: "main",
              headRefName: "feature/queue",
              isCrossRepository: false,
              updatedAt: "2026-07-31T10:00:00Z",
              statusCheckRollup: [],
            },
          ]),
          stderr: "",
        },
      ]);
      const issues = await adapter.listOpenIssues("/repo", repo);
      assert.equal(issues[0].number, 73);
      assert.deepEqual(calls[0].args.slice(6, 8), ["--repo", "codara/studio"]);
      const pullRequests = await adapter.listOpenPullRequests("/repo", repo);
      assert.equal(pullRequests[0].isCrossRepository, false);
      assert.deepEqual(calls[1].args.slice(6, 8), ["--repo", "codara/studio"]);
      assert.match(calls[1].args.at(-1), /isCrossRepository/);
    }

    {
      const repo = {
        owner: "codara",
        name: "studio",
        nameWithOwner: "codara/studio",
        url: "https://git.enterprise.example/codara/studio",
        hostname: "git.enterprise.example",
        defaultBranch: "main",
      };
      const { adapter, calls } = fakeAdapter(github, [
        {
          stdout: JSON.stringify([
            {
              number: 73,
              title: "Enterprise issue",
              url: `${repo.url}/issues/73`,
              labels: [],
              updatedAt: "2026-07-31T09:00:00Z",
            },
          ]),
          stderr: "",
        },
        {
          stdout: JSON.stringify([
            {
              number: 42,
              title: "Enterprise pull request",
              url: `${repo.url}/pull/42`,
              state: "OPEN",
              isDraft: false,
              baseRefName: "main",
              headRefName: "feature/enterprise",
              isCrossRepository: false,
              updatedAt: "2026-07-31T10:00:00Z",
              statusCheckRollup: [],
            },
          ]),
          stderr: "",
        },
      ]);
      await adapter.listOpenIssues("/repo", repo);
      await adapter.listOpenPullRequests("/repo", repo);
      assert.deepEqual(calls[0].args.slice(6, 8), [
        "--repo",
        "git.enterprise.example/codara/studio",
      ]);
      assert.deepEqual(calls[1].args.slice(6, 8), [
        "--repo",
        "git.enterprise.example/codara/studio",
      ]);
    }

    {
      const repo = {
        owner: "codara",
        name: "studio",
        nameWithOwner: "codara/studio",
        url: "https://git.enterprise.example/codara/studio",
        hostname: "git.enterprise.example",
        defaultBranch: "main",
      };
      const payload = {
        number: 42,
        title: "Import exact enterprise fork",
        url: `${repo.url}/pull/42`,
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        baseRefOid: "A".repeat(40),
        headRefName: "feature/import",
        headRefOid: "B".repeat(40),
        headRepository: { id: "ignored", name: "studio" },
        headRepositoryOwner: { id: "ignored", login: "contributor" },
        isCrossRepository: true,
        statusCheckRollup: [],
      };
      const { adapter, calls } = fakeAdapter(github, [
        { stdout: JSON.stringify(payload), stderr: "" },
      ]);
      assert.deepEqual(
        await adapter.getPullRequestForCheckout("/repo", repo, 42),
        {
          number: 42,
          title: "Import exact enterprise fork",
          url: "https://git.enterprise.example/codara/studio/pull/42",
          baseBranch: "main",
          baseCommitOid: "a".repeat(40),
          headBranch: "feature/import",
          headCommitOid: "b".repeat(40),
          headRepository: "contributor/studio",
          headRepositoryUrl:
            "https://git.enterprise.example/contributor/studio",
          isCrossRepository: true,
        },
      );
      assert.deepEqual(calls[0].args.slice(0, 6), [
        "pr",
        "view",
        "42",
        "--repo",
        "git.enterprise.example/codara/studio",
        "--json",
      ]);
      assert.match(calls[0].args[6], /baseRefOid/);
      assert.match(calls[0].args[6], /headRepositoryOwner/);
      assert.match(calls[0].args[6], /headRepository(,|$)/);
      assert.doesNotMatch(calls[0].args[6], /body|comments|reviews|files/);
    }

    // Import is the one read that genuinely needs gh 2.63+, so a stale CLI is
    // reported as an update instruction rather than a raw field listing.
    {
      const repo = {
        owner: "codara",
        name: "studio",
        nameWithOwner: "codara/studio",
        url: "https://github.com/codara/studio",
        hostname: "github.com",
        defaultBranch: "main",
      };
      const { adapter } = fakeAdapter(github, [
        commandFailure(
          'Unknown JSON field: "baseRefOid" Available fields: additions assignees author baseRefName body',
        ),
      ]);
      await assert.rejects(
        adapter.getPullRequestForCheckout("/repo", repo, 42),
        (error) => {
          assert.equal(error?.name, "GitHubCliError");
          assert.equal(error.code, "command-failed");
          assert.match(error.message, /GitHub CLI 2\.63 or newer/);
          assert.doesNotMatch(error.message, /Available fields|baseRefOid/);
          return true;
        },
      );
    }

    {
      const repo = {
        owner: "codara",
        name: "studio",
        nameWithOwner: "codara/studio",
        url: "https://github.com/codara/studio",
        hostname: "github.com",
      };
      const valid = {
        number: 42,
        title: "Import exact head",
        url: `${repo.url}/pull/42`,
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        baseRefOid: "a".repeat(40),
        headRefName: "feature/import",
        headRefOid: "b".repeat(40),
        headRepository: { name: "studio" },
        headRepositoryOwner: { login: "codara" },
        isCrossRepository: false,
        statusCheckRollup: [],
      };
      for (const hostile of [
        { ...valid, number: 43 },
        { ...valid, url: `${repo.url}/issues/42` },
        { ...valid, state: "CLOSED" },
        { ...valid, baseRefOid: "a".repeat(41) },
        { ...valid, headRefOid: "b".repeat(63) },
        { ...valid, baseRefOid: "a".repeat(64) },
        { ...valid, headRefName: " feature/import" },
        { ...valid, headRefName: "feature..import" },
        { ...valid, headRepository: null },
        { ...valid, headRepositoryOwner: null },
        {
          ...valid,
          headRepositoryOwner: { login: "other" },
          isCrossRepository: false,
        },
        { ...valid, isCrossRepository: "false" },
      ]) {
        const { adapter } = fakeAdapter(github, [
          { stdout: JSON.stringify(hostile), stderr: "" },
        ]);
        await rejectsCode(
          adapter.getPullRequestForCheckout("/repo", repo, 42),
          "invalid-response",
        );
      }
    }

    {
      const repo = {
        owner: "codara",
        name: "studio",
        nameWithOwner: "codara/studio",
        url: "https://git.enterprise.example:8443/codara/studio",
        hostname: "git.enterprise.example",
      };
      const { adapter, calls } = fakeAdapter(github, []);
      await rejectsCode(
        adapter.getPullRequestForCheckout("/repo", repo, 42),
        "command-failed",
      );
      assert.equal(calls.length, 0, "custom-port hosts fail before spawning gh");
    }

    for (const hostile of [
      {
        title: "Wrong repository",
        url: "https://github.com/other/repo/issues/73",
      },
      {
        title: "Wrong number",
        url: "https://github.com/codara/studio/issues/74",
      },
      {
        title: "Query spoof",
        url: "https://github.com/codara/studio/issues/73?next=evil",
      },
      {
        title: "Encoded path",
        url: "https://github.com/codara%2Fstudio/issues/73",
      },
      {
        title: "Bidi\u200espoof",
        url: "https://github.com/codara/studio/issues/73",
      },
    ]) {
      const repo = {
        owner: "codara",
        name: "studio",
        nameWithOwner: "codara/studio",
        url: "https://github.com/codara/studio",
        hostname: "github.com",
      };
      const { adapter } = fakeAdapter(github, [
        {
          stdout: JSON.stringify({
            number: 73,
            title: hostile.title,
            url: hostile.url,
            state: "OPEN",
            labels: [],
          }),
          stderr: "",
        },
      ]);
      await rejectsCode(adapter.getIssue("/repo", 73, repo), "invalid-response");
    }

    // Exercise the real execFile seam with hostile-looking argv. A shell would
    // interpret these tokens; shell:false must deliver them byte-for-byte.
    {
      const script = path.join(temp, "argv.cjs");
      writeFileSync(
        script,
        "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), prompt: process.env.GH_PROMPT_DISABLED }))",
      );
      const result = await github.runGitHubCliCommand({
        executablePath: process.execPath,
        args: [script, "$(touch should-not-exist)", "; echo injected"],
        cwd: temp,
        timeoutMs: 2_000,
        maxOutputBytes: 16_384,
      });
      assert.deepEqual(JSON.parse(result.stdout), {
        argv: ["$(touch should-not-exist)", "; echo injected"],
        prompt: "1",
      });
    }

    {
      const script = path.join(temp, "stdin.cjs");
      writeFileSync(
        script,
        'let value = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(JSON.stringify(value)))',
      );
      const stdin = "body with $(commands), semicolons; and\nmultiple lines";
      const result = await github.runGitHubCliCommand({
        executablePath: process.execPath,
        args: [script],
        stdin,
        cwd: temp,
        timeoutMs: 2_000,
        maxOutputBytes: 16_384,
      });
      assert.equal(JSON.parse(result.stdout), stdin);
    }

    // The low-level runner enforces the caller's output ceiling.
    {
      const script = path.join(temp, "large-output.cjs");
      writeFileSync(script, 'process.stdout.write("x".repeat(8192))');
      await assert.rejects(
        github.runGitHubCliCommand({
          executablePath: process.execPath,
          args: [script],
          cwd: temp,
          timeoutMs: 2_000,
          maxOutputBytes: 128,
        }),
      );
    }

    console.log("All GitHub CLI adapter checks passed.");
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(outfile, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
