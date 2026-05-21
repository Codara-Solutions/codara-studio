import type { GitSmartMergeContext, GitSmartMergeResult, GitStatus } from "@shared/types";

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

function collectWorkingFiles(status: GitStatus): string[] {
  return uniqueSorted(
    [...status.staged, ...status.unstaged].flatMap((file) =>
      file.oldPath ? [file.oldPath, file.path] : [file.path],
    ),
  );
}

function recommendSmartMergeStrategy(input: {
  upstream?: string;
  detached: boolean;
  ahead: number;
  behind: number;
  hasWorkingChanges: boolean;
  hasConflicts: boolean;
  overlapCount?: number;
}): string {
  if (input.hasConflicts) return "resolve existing conflicts before fetching more changes";
  if (input.detached) return "ask which branch should receive the remote changes";
  if (!input.upstream) return "ask which remote branch to integrate";
  if (input.behind === 0 && input.ahead === 0) {
    return input.hasWorkingChanges ? "preserve local work; upstream is current" : "already up to date";
  }
  if (input.behind > 0 && input.ahead === 0) {
    if (input.hasWorkingChanges && (input.overlapCount ?? 0) > 0) {
      return "review overlapping files, then stash or commit local work before fast-forward";
    }
    return input.hasWorkingChanges ? "preserve local work, then fast-forward" : "fast-forward";
  }
  if (input.behind > 0 && input.ahead > 0) {
    return (input.overlapCount ?? 0) > 0
      ? "review overlapping files, then merge by default; ask before rebase"
      : "merge by default; ask before rebase";
  }
  if (input.ahead > 0) return "local branch is ahead; no merge needed";
  return "inspect repository state";
}

function buildStatusShort(status: GitStatus): string {
  const branch = status.branch ?? "HEAD";
  const lines: string[] = [];
  let header = `## ${branch}`;
  if (status.upstream) {
    header += `...${status.upstream}`;
    if (status.ahead > 0) header += ` [ahead ${status.ahead}]`;
    if (status.behind > 0) header += ` [behind ${status.behind}]`;
  }
  lines.push(header);
  for (const file of status.staged) lines.push(`${file.status} ${file.path}`);
  for (const file of status.unstaged) lines.push(`${file.status} ${file.path}`);
  return lines.join("\n");
}

async function prepareSmartMergeFallback(cwd: string): Promise<GitSmartMergeResult> {
  const fetchResult = await window.spark.git.fetch(cwd);
  if (!fetchResult.ok) return fetchResult;

  const status = await window.spark.git.status(cwd);
  if (!status.isRepo) {
    return { ok: false, error: status.error ?? "Not a git repository." };
  }

  const workingFiles = collectWorkingFiles(status);
  const context: GitSmartMergeContext = {
    fetchedAt: new Date().toISOString(),
    repositoryRoot: cwd,
    branch: status.branch,
    upstream: status.upstream,
    detached: status.detached,
    head: status.branch ?? "(unknown)",
    ahead: status.ahead,
    behind: status.behind,
    stagedCount: status.staged.length,
    unstagedCount: status.unstaged.length,
    hasConflicts: status.hasConflicts,
    hasWorkingChanges: workingFiles.length > 0,
    workingFiles,
    localCommitFiles: [],
    remoteChangedFiles: [],
    overlappingFiles: [],
    statusShort: buildStatusShort(status),
    localOnlyCommits: "",
    remoteOnlyCommits: "",
    recommendedStrategy: recommendSmartMergeStrategy({
      upstream: status.upstream,
      detached: status.detached,
      ahead: status.ahead,
      behind: status.behind,
      hasWorkingChanges: workingFiles.length > 0,
      hasConflicts: status.hasConflicts,
      overlapCount: 0,
    }),
  };

  return { ok: true, context };
}

/** Uses the main-process preflight when available; falls back after renderer-only reloads. */
export async function requestPrepareSmartMerge(cwd: string): Promise<GitSmartMergeResult> {
  const prepare = window.spark.git.prepareSmartMerge;
  if (typeof prepare === "function") {
    return prepare(cwd);
  }
  return prepareSmartMergeFallback(cwd);
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatList(items: string[], empty: string, max = 24): string {
  if (items.length === 0) return `- ${empty}`;
  const shown = items.slice(0, max).map((item) => `- ${item}`);
  if (items.length > max) shown.push(`- ... ${items.length - max} more`);
  return shown.join("\n");
}

function fenced(value: string, empty: string): string {
  const text = value.trim() || empty;
  return ["```text", text, "```"].join("\n");
}

export function smartMergePlanTitle(context: GitSmartMergeContext): string {
  const branch = context.branch ?? "detached HEAD";
  const upstream = context.upstream ?? "remote";
  return `Fetch and review ${branch} <- ${upstream}`;
}

export function buildSmartMergePlan(context: GitSmartMergeContext): string {
  const branch = context.branch ?? "detached HEAD";
  const upstream = context.upstream ?? "(no upstream configured)";
  const dirtySummary = context.hasWorkingChanges
    ? `${formatCount(context.stagedCount)} staged, ${formatCount(context.unstagedCount)} unstaged`
    : "clean";
  const localTouchedFiles = uniqueSorted([...context.localCommitFiles, ...context.workingFiles]);
  const overlapSummary =
    context.overlappingFiles.length > 0
      ? `${formatCount(context.overlappingFiles.length)} direct file overlap`
      : "no direct file overlap";

  return `# ${smartMergePlanTitle(context)}

Fetch has already run. This is a review checkpoint, not merge approval yet. First show the human exactly what would be integrated, then only merge after the human confirms the strategy.

## Spark preflight
- Repository: ${context.repositoryRoot}
- Fetched: git fetch --prune at ${context.fetchedAt}
- Branch: ${branch}
- Upstream: ${upstream}
- HEAD: ${context.head}
- Ahead / behind: ${formatCount(context.ahead)} ahead, ${formatCount(context.behind)} behind
- Working tree: ${dirtySummary}
- Existing conflicts: ${context.hasConflicts ? "yes" : "no"}
- Merge base: ${context.mergeBase ?? "(unknown)"}
- Overlap: ${overlapSummary}
- Recommended default: ${context.recommendedStrategy}

## Current status
${fenced(context.statusShort, "(git status was empty)")}

## Remote commits not local
${fenced(context.remoteOnlyCommits, "(none)")}

## Local commits not remote
${fenced(context.localOnlyCommits, "(none)")}

## Remote changed files
${formatList(context.remoteChangedFiles, "No fetched remote file changes were detected.")}

## Local files touched by commits or working tree
${formatList(localTouchedFiles, "No local file changes were detected.")}

## Files with likely overlap
${formatList(context.overlappingFiles, "No direct file overlap found in the preflight.")}

## Operating rules
- Ask the human at most two concise questions, only for real safety decisions.
- Mandatory first action: summarize the fetched upstream commits, changed files, exact overlapping files, working-tree state, and recommended strategy in the chat. If there are overlapping files, name every one before asking how to continue.
- Do not describe overlap as low risk unless the "Files with likely overlap" section is empty.
- The first question should be a review checkpoint, for example whether to inspect diffs, protect local work, or continue with the recommended path. Do not run merge, rebase, pull, stash, commit, or any command that changes the branch until the human explicitly approves.
- If the human approves the recommended path and the working tree is clean, proceed with the smallest safe git operation.
- Ask before stashing, committing, or otherwise moving uncommitted local work.
- Ask before choosing a target branch when HEAD is detached or no upstream is configured.
- Ask before rebase, force operations, history rewriting, or any choice that changes shared branch semantics.
- Prefer fast-forward when possible.
- If the branch is divergent, prefer a normal merge commit unless the human explicitly chooses rebase.
- Do not push. Do not force push. Do not run git reset --hard, git clean, or discard local changes.
- If conflicts occur, resolve them semantically, remove conflict markers, stage only the resolved merge files, and complete the merge commit only when required to finish the merge.
- Keep unrelated pre-existing user changes intact unless the human explicitly says to include them.

## Verification
- Run git status --short --branch before and after the merge work.
- Run git diff --check after conflict resolution.
- Run the cheapest relevant project verification command you can identify, such as typecheck or tests. If none is available, explain that clearly.

## Done means
- Before merge work starts, the human has seen what will be merged and approved the path.
- The current branch is integrated with the fetched upstream, or Spark has paused with the exact blocking question.
- There are no unresolved merge conflicts and no conflict markers left in tracked text files.
- Verification commands and final git status are reported with exit codes.`;
}
