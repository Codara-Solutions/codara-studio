// Focused structural regression checks for App's issue-worktree transaction.
// App.tsx is intentionally not bundled into this Node harness: doing so would
// execute the whole Electron renderer. These assertions pin the dangerous
// ordering and cleanup calls while the storage harness exercises real failure
// semantics.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(ROOT, "src", "renderer", "src", "App.tsx"),
  "utf8",
);
const serviceSource = fs.readFileSync(
  path.join(ROOT, "src", "main", "github-issue-workspace.ts"),
  "utf8",
);

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const create = section(
  "const createCopyBranchWs = useCallback(",
  "const handleStartGitHubIssue = useCallback(",
);
const saveAt = create.indexOf("await window.spark.state.save(nextState)");
const publishAt = create.indexOf("workspacesRef.current = coloredNextWorkspaces");
assert.ok(saveAt >= 0 && publishAt > saveAt, "workspace state publishes only after durable save");
assert.match(create, /removeCopyWorktree\(\{[\s\S]*force:\s*true/);
assert.match(create, /deleteBranch\([\s\S]*res\.branch,[\s\S]*true/);
assert.match(create, /setAllowedRoots\(existingCwds\)/);
assert.match(create, /await window\.spark\.state\.save\(previousState\)/);
assert.match(
  create,
  /deleteBranch[\s\S]*pathState\.exists[\s\S]*worktree directory was removed/i,
  "rollback distinguishes branch-only cleanup from a worktree path that remains",
);

const issue = section(
  "const handleStartGitHubIssue = useCallback(",
  "const handleCreateCopyBranch = useCallback(",
);
assert.match(issue, /window\.spark\.github\.startIssue\(\{/);
assert.match(issue, /sourceWorkspaceId:\s*sourceWs\.id/);
assert.match(issue, /issueNumber:\s*issue\.number/);
assert.doesNotMatch(issue, /createCopyBranchWs/, "renderer no longer owns issue provisioning");
assert.doesNotMatch(issue, /startAutopilot/, "renderer no longer owns issue run creation");

const servicePersistAt = serviceSource.indexOf("persistedState = await dependencies.updateState");
const serviceStartAt = serviceSource.indexOf("return startAndActivateIssueWorkspace");
assert.ok(
  servicePersistAt >= 0 && serviceStartAt > servicePersistAt,
  "main service persists the workspace before starting Cora",
);
assert.match(serviceSource, /initialUserNoteClientMessageId:\s*clientMessageId/);
assert.match(serviceSource, /FIRST STEP[\s\S]*configured_workspace_setup_command/);
assert.match(serviceSource, /rollbackCreatedWorktree/);
assert.match(
  serviceSource,
  /dependencies\.getIssue\(source\.cwd, issueNumber, repository\)/,
  "issue metadata is read only after resolving and pinning its repository",
);

console.log("All GitHub issue transaction checks passed.");
