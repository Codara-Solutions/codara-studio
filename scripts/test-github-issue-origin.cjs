// Focused persistence-contract checks for GitHub issue provenance. The pure
// normalizer is exercised directly; structural assertions pin run-store's
// creation/autopilot forwarding seams without booting Electron orchestration.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  const outfile = path.join(cacheDir, `github-issue-origin-${process.pid}.cjs`);
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "shared", "types.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
    });
    delete require.cache[outfile];
    const {
      GITHUB_ISSUE_ORIGIN_MAX_TITLE_LENGTH,
      normalizeGitHubOrigin,
      normalizeGitHubIssueOrigin,
      normalizeGitHubPullRequestOrigin,
    } = require(outfile);

    assert.deepEqual(
      normalizeGitHubIssueOrigin({
        kind: "github-issue",
        repository: " codara/studio ",
        number: 42,
        title: " Fix mobile reconnect ",
        url: "https://github.com/codara/studio/issues/42",
        sourceWorkspaceId: " ws-main ",
        ignored: "must not persist",
      }),
      {
        kind: "github-issue",
        repository: "codara/studio",
        repositoryUrl: "https://github.com/codara/studio",
        number: 42,
        title: "Fix mobile reconnect",
        url: "https://github.com/codara/studio/issues/42",
        sourceWorkspaceId: "ws-main",
      },
      "valid provenance is trimmed and rebuilt to its exact bounded shape",
    );

    const base = {
      kind: "github-issue",
      repository: "codara/studio",
      number: 42,
      title: "Fix mobile reconnect",
      url: "https://github.com/codara/studio/issues/42",
      sourceWorkspaceId: "ws-main",
    };
    for (const invalid of [
      { ...base, kind: "other" },
      { ...base, repository: "../studio" },
      { ...base, number: 0 },
      { ...base, number: 1.5 },
      { ...base, title: "x".repeat(GITHUB_ISSUE_ORIGIN_MAX_TITLE_LENGTH + 1) },
      { ...base, url: "http://github.com/codara/studio/issues/42" },
      { ...base, url: "https://github.com/other/repo/issues/42" },
      { ...base, url: "https://github.com/codara/studio/issues/43" },
      { ...base, url: "https://github.com/codara/studio/issues/42?x=1" },
      { ...base, url: "https://github.com/codara%2Fstudio/issues/42" },
      { ...base, repositoryUrl: "https://evil.example/codara/studio" },
      { ...base, title: "Fix\u200espoof" },
      { ...base, sourceWorkspaceId: "bad\u0000id" },
    ]) {
      assert.equal(normalizeGitHubIssueOrigin(invalid), undefined);
    }

    const pullRequest = {
      kind: "github-pull-request",
      repository: "codara/studio",
      repositoryUrl: "https://github.com/codara/studio",
      number: 9,
      title: "Import exact fork revision",
      url: "https://github.com/codara/studio/pull/9",
      sourceWorkspaceId: "ws-main",
      base: {
        branch: "main",
        commitOid: "A".repeat(40),
        ignored: "discard",
      },
      head: {
        relationship: "fork",
        repository: "contributor/studio",
        repositoryUrl: "https://github.com/contributor/studio",
        branch: "feature/pr-9",
        commitOid: "B".repeat(40),
        token: "must not persist",
      },
      body: "must not persist",
    };
    assert.deepEqual(normalizeGitHubPullRequestOrigin(pullRequest), {
      kind: "github-pull-request",
      repository: "codara/studio",
      repositoryUrl: "https://github.com/codara/studio",
      number: 9,
      title: "Import exact fork revision",
      url: "https://github.com/codara/studio/pull/9",
      sourceWorkspaceId: "ws-main",
      base: {
        branch: "main",
        commitOid: "a".repeat(40),
      },
      head: {
        relationship: "fork",
        repository: "contributor/studio",
        repositoryUrl: "https://github.com/contributor/studio",
        branch: "feature/pr-9",
        commitOid: "b".repeat(40),
      },
    });
    assert.deepEqual(
      normalizeGitHubOrigin(pullRequest),
      normalizeGitHubPullRequestOrigin(pullRequest),
      "the general persistence normalizer preserves pull-request origins",
    );
    assert.deepEqual(
      normalizeGitHubOrigin(base),
      normalizeGitHubIssueOrigin(base),
      "the general persistence normalizer remains issue compatible",
    );

    const sameRepositoryPullRequest = {
      ...pullRequest,
      head: {
        ...pullRequest.head,
        relationship: "same-repository",
        repository: "CODARA/STUDIO",
        repositoryUrl: "https://github.com/CODARA/STUDIO",
      },
    };
    assert.ok(normalizeGitHubPullRequestOrigin(sameRepositoryPullRequest));

    for (const invalid of [
      { ...pullRequest, kind: "github-issue" },
      { ...pullRequest, number: 0 },
      { ...pullRequest, url: "https://github.com/codara/studio/issues/9" },
      { ...pullRequest, url: "https://github.com/codara/studio/pull/10" },
      { ...pullRequest, repositoryUrl: "https://evil.example/codara/studio" },
      {
        ...pullRequest,
        head: {
          ...pullRequest.head,
          repositoryUrl: "https://enterprise.example/contributor/studio",
        },
      },
      {
        ...pullRequest,
        head: {
          ...pullRequest.head,
          relationship: "same-repository",
        },
      },
      {
        ...sameRepositoryPullRequest,
        head: {
          ...sameRepositoryPullRequest.head,
          relationship: "fork",
        },
      },
      {
        ...pullRequest,
        base: { ...pullRequest.base, commitOid: "a".repeat(39) },
      },
      {
        ...pullRequest,
        base: { ...pullRequest.base, commitOid: "a".repeat(41) },
      },
      {
        ...pullRequest,
        base: { ...pullRequest.base, commitOid: "a".repeat(64) },
      },
      {
        ...pullRequest,
        head: { ...pullRequest.head, branch: " feature/pr-9" },
      },
      {
        ...pullRequest,
        head: { ...pullRequest.head, branch: "feature..pr-9" },
      },
      {
        ...pullRequest,
        head: { ...pullRequest.head, branch: "feature/.hidden" },
      },
      {
        ...pullRequest,
        head: { ...pullRequest.head, branch: "feature/lock.LOCK" },
      },
    ]) {
      assert.equal(normalizeGitHubPullRequestOrigin(invalid), undefined);
    }

    const runStore = fs.readFileSync(
      path.join(ROOT, "src", "main", "orchestration", "run-store.ts"),
      "utf8",
    );
    assert.match(
      runStore,
      /const origin = normalizeGitHubOrigin\(input\.origin\);[\s\S]*?const run: RunState = \{[\s\S]*?workspaceId:\s*input\.workspaceId,[\s\S]*?\borigin,/,
      "createRun normalizes provenance before stamping only that normalized value",
    );
    assert.match(
      runStore,
      /export async function startAutopilot[\s\S]*?run = await createRun\(\{[\s\S]*?cwd:\s*input\.cwd,[\s\S]*?origin:\s*input\.origin,[\s\S]*?title:\s*chatTitleFromInput\(input\)/,
      "startAutopilot forwards provenance into createRun",
    );
    assert.match(
      runStore,
      /const origin = normalizeGitHubOrigin\(run\.origin\)/,
      "persisted runs discard malformed provenance on normalization",
    );

    const storage = fs.readFileSync(
      path.join(ROOT, "src", "main", "storage.ts"),
      "utf8",
    );
    assert.match(
      storage,
      /const origin = normalizeGitHubOrigin\(cb\.origin\)/,
      "workspace copy-branch provenance is normalized on load",
    );
    assert.match(
      storage,
      /workspaces:\s*candidate\.workspaces\.map\(normalizeWorkspaceGitHubOrigin\)/,
      "atomic state updates normalize provenance before publication",
    );

    console.log("All GitHub issue origin checks passed.");
  } finally {
    fs.rmSync(outfile, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
