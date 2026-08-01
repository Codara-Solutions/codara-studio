// Focused contract checks for the desktop-only mark-ready path. Provider and
// transaction behavior live in test-github-cli.cjs and test-github-ready.cjs;
// this test keeps the trusted IPC/preload/renderer wiring exact and reviewable.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) =>
  readFileSync(path.join(ROOT, relativePath), "utf8");

const ipc = read("src/main/ipc.ts");
const preload = read("src/preload/index.ts");
const surface = read(
  "src/renderer/src/components/git/GitHubSection.tsx",
);

assert.match(
  ipc,
  /let githubReadyMod:\s*typeof import\("\.\/github-ready"\)\s*\|\s*undefined;/,
  "main should lazy-load the bounded mark-ready service",
);
assert.match(
  ipc,
  /handle\(\s*"github:markReady",[\s\S]*?markGitHubPullRequestReady\(cwd,\s*request\?\.input\)/,
  "trusted desktop IPC should delegate only cwd and the guarded input",
);
assert.match(
  ipc,
  /"github:markReady"[\s\S]*?isRemotePath\(cwd\)[\s\S]*?local workspaces only/,
  "desktop IPC should reject remote workspace paths",
);

assert.match(
  preload,
  /markReady:\s*\(\s*cwd:\s*string,\s*input:\s*GitHubMarkReadyInput,\s*\):\s*Promise<GitHubMarkReadyResult>/,
  "preload should expose a typed mark-ready method",
);
assert.match(
  preload,
  /ipcRenderer\.invoke\("github:markReady",\s*\{\s*cwd,\s*input\s*\}\)/,
  "preload should forward only cwd and the guarded input",
);

assert.match(
  surface,
  /window\.spark\.github\.markReady\(cwd,\s*\{/,
  "the Source Control surface should use the native desktop transaction",
);
for (const field of [
  /repository:\s*readyStatus\.repository\.nameWithOwner/,
  /pullRequestNumber:\s*pullRequest\.number/,
  /baseBranch:\s*pullRequest\.baseBranch/,
  /headBranch:\s*pullRequest\.headBranch/,
  /expectedHeadCommitOid:\s*pullRequest\.headCommitOid/,
]) {
  assert.match(surface, field, `renderer must preserve ${field}`);
}
assert.match(surface, /label=\{markingReady \? "Marking ready…" : "Mark ready"\}/);
assert.match(
  surface,
  /markReadyRequestId\.current !== id/,
  "stale action responses must not update a newly selected workspace",
);
assert.match(
  surface,
  /status:\s*\{\s*\.\.\.current\.status,\s*pullRequest:\s*result\.pullRequest\s*\}/,
  "verified success should update the bounded local PR snapshot",
);
assert.match(
  surface,
  /if \(result\.ok\)[\s\S]*?onPublished\(\);/,
  "verified success should trigger the normal Source Control refresh",
);

console.log("GitHub desktop mark-ready wiring checks passed.");
