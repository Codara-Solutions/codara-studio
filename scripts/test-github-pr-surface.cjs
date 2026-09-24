// Focused safety checks for the Source Control pull request affordances: the
// surface must go through the reviewed host transactions, never a raw publish
// or a bare compare-page link.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function main() {
  const surface = readFileSync(
    path.join(
      ROOT,
      "src",
      "renderer",
      "src",
      "components",
      "git",
      "GitHubSection.tsx",
    ),
    "utf8",
  );
  const workspaceRail = readFileSync(
    path.join(ROOT, "src", "renderer", "src", "components", "WorkspaceRail.tsx"),
    "utf8",
  );
  const createCopyDialog = readFileSync(
    path.join(ROOT, "src", "renderer", "src", "components", "CreateCopyDialog.tsx"),
    "utf8",
  );
  assert.match(surface, /<ShareButton/);
  assert.match(surface, /Share for review/);
  assert.match(
    surface,
    /window\.spark\.github\s*\n?\s*\.shareDraft\(cwd\)/,
    "the dialog must pre-fill from the AI share draft",
  );
  assert.match(
    surface,
    /window\.spark\.github\.share\(cwd,/,
    "the confirm button must use the share transaction (branch + publish)",
  );
  assert.doesNotMatch(
    surface,
    /label="Publish as PR"/,
    "the jargon publish affordance is replaced by Share for review",
  );
  assert.doesNotMatch(
    surface,
    /Issue → isolated worktree → draft PR/,
    "the jargon pipeline line must stay retired for the plain-language help disclosure",
  );
  assert.doesNotMatch(
    surface,
    /How this works/,
    "the obsolete help disclosure must stay removed",
  );
  const workQueue = readFileSync(
    path.join(
      ROOT,
      "src",
      "renderer",
      "src",
      "components",
      "git",
      "GitHubWorkQueue.tsx",
    ),
    "utf8",
  );
  assert.match(workQueue, /Start worktree/);
  assert.match(workspaceRail, /label="Create isolated worktree…"/);
  assert.match(
    createCopyDialog,
    /separate Git worktree,[\s\S]*agents[\s\S]*work in parallel without changing this checkout/,
  );
  assert.doesNotMatch(
    surface,
    /window\.spark\.github\.publish\(cwd,/,
    "the Source Control surface must route through the share transaction, not raw publish",
  );
  assert.match(surface, /const \[draft,\s*setDraft\]\s*=\s*useState\(true\)/);
  assert.match(
    surface,
    /Save all.*changed/,
    "the dialog explains committing in plain language",
  );
  assert.match(surface, /previousResult\.committed \|\| previousResult\.pushed/);
  assert.match(surface, /Review merge/);
  assert.match(surface, /Mark ready/);
  assert.match(surface, /window\.spark\.github\.markReady\(cwd,/);
  assert.match(surface, /repository:\s*readyStatus\.repository\.nameWithOwner/);
  assert.match(surface, /expectedHeadCommitOid:\s*pullRequest\.headCommitOid/);
  assert.match(surface, /window\.spark\.github\.merge\(cwd,/);
  assert.match(surface, /baseBranch:\s*pullRequest\.baseBranch/);
  assert.match(surface, /headCommitOid/);
  assert.match(surface, /I reviewed #\{pullRequest\.number\}, its checks and review state/);
  assert.match(surface, /not delete the branch or this worktree/);
  assert.doesNotMatch(
    surface,
    /label="Create PR on GitHub"/,
    "the old compare-page-only action must not return",
  );

  console.log("All GitHub PR surface checks passed.");
}

main();
