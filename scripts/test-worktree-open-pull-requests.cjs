// The worktree cleanup reads every open pull request of a repository, not
// the work queue's first twelve, so each row finds its own; a list that may
// be cut short, or no open list at all, fails the read instead of leaving a
// row without its open pull request (src/main/worktree-cleanup/
// pull-request-reads.ts, github-cli.ts listOpenPullRequestHeads). gh is
// stubbed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

const outputs = [];
async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-open-pull-requests-${name}-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  outputs.push(outfile);
  return require(outfile);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function openPullRequests(count) {
  return Array.from({ length: count }, (_, i) => ({
    number: 100 + i,
    title: `Change ${i}`,
    url: `https://github.com/acme/app/pull/${100 + i}`,
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: `feat/change-${i}`,
    isCrossRepository: false,
    headRefOid: "a".repeat(40),
  }));
}

function stubbedAdapter(github, open, calls) {
  return github.createGitHubCliAdapter({
    resolveBinary: async () => "/usr/bin/gh",
    runCommand: async ({ args }) => {
      calls.push(args);
      if (args[0] === "repo") {
        return { stdout: JSON.stringify({ nameWithOwner: "acme/app", url: "https://github.com/acme/app", defaultBranchRef: { name: "main" } }), stderr: "" };
      }
      const limit = Number(args[args.indexOf("--limit") + 1]);
      const state = args[args.indexOf("--state") + 1];
      return { stdout: JSON.stringify(state === "open" ? open.slice(0, limit) : []), stderr: "" };
    },
  });
}

async function main() {
  const [reads, github] = await Promise.all([
    bundle("src/main/worktree-cleanup/pull-request-reads.ts", "reads"),
    bundle("src/main/github-cli.ts", "github"),
  ]);
  try {
    await check("a repository with 20 open pull requests gives every row its own, in one gh call per list", async () => {
      const calls = [];
      const open = openPullRequests(20);
      const lists = await reads.readRepoPullRequests(stubbedAdapter(github, open, calls), ROOT);
      assert.equal(lists.open.length, 20);
      assert.deepEqual(lists.open.at(-1), {
        number: 119,
        url: open[19].url,
        title: "Change 19",
        headBranch: "feat/change-19",
        isDraft: false,
        isCrossRepository: false,
      });
      const listed = calls.filter((args) => args[0] === "pr");
      assert.equal(listed.length, 2, "one gh call per list");
      const openArgs = listed.find((args) => args.includes("open"));
      assert.ok(Number(openArgs[openArgs.indexOf("--limit") + 1]) >= 100);
      assert.doesNotMatch(openArgs.at(-1), /statusCheckRollup/, "no checks: they are the heavy part");
    });

    await check("a full page of open pull requests fails the read: some may be left out", async () => {
      const limit = github.GITHUB_OPEN_PULL_REQUEST_HEADS_LIMIT;
      assert.equal(typeof limit, "number");
      await assert.rejects(reads.readRepoPullRequests(stubbedAdapter(github, openPullRequests(limit + 5), []), ROOT), /or more open pull requests/);
      await assert.rejects(reads.readRepoPullRequests(stubbedAdapter(github, openPullRequests(limit), []), ROOT), /or more open pull requests/);
      const lists = await reads.readRepoPullRequests(stubbedAdapter(github, openPullRequests(limit - 1), []), ROOT);
      assert.equal(lists.open.length, limit - 1, "one short of the limit is the whole list");
    });

    await check("a reader with no open list fails the read instead of answering none", async () => {
      const adapter = {
        resolveRepository: async () => ({ nameWithOwner: "acme/app", url: "https://github.com/acme/app" }),
        listMergedPullRequests: async () => [],
      };
      await assert.rejects(reads.readRepoPullRequests(adapter, ROOT), /cannot list open pull requests/);
    });
  } finally {
    for (const file of outputs) fs.rmSync(file, { force: true });
  }
  console.log(`${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
