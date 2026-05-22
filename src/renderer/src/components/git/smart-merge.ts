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
  if (input.hasConflicts) return "auto-resolve the existing merge conflicts";
  if (input.detached) return "pause; target branch is ambiguous";
  if (!input.upstream) return "pause; no upstream branch is configured";
  if (input.behind === 0 && input.ahead === 0) {
    return input.hasWorkingChanges ? "preserve local work; upstream is current" : "already up to date";
  }
  if (input.behind > 0 && input.ahead === 0) {
    if (input.hasWorkingChanges && (input.overlapCount ?? 0) > 0) {
      return "auto-merge after protecting local work and reviewing overlaps";
    }
    return input.hasWorkingChanges ? "auto-preserve local work, then fast-forward" : "auto fast-forward";
  }
  if (input.behind > 0 && input.ahead > 0) {
    return (input.overlapCount ?? 0) > 0
      ? "auto-merge with semantic conflict resolution if needed"
      : "auto-create a normal merge commit";
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
  if (!status.hasConflicts && status.behind === 0) {
    return {
      ok: false,
      error: status.upstream
        ? `Nothing to merge from ${status.upstream}.`
        : "Nothing to merge; no upstream branch is configured.",
    };
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
  return `Smart merge ${branch} <- ${upstream}`;
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
  const overlapRules =
    context.overlappingFiles.length > 0
      ? `
## Overlap handling
- These files overlap, so inspect their diffs before running the real merge:
${formatList(context.overlappingFiles, "No direct file overlap found in the preflight.")}
- Use non-mutating simulation first when possible, for example git merge-tree --write-tree --name-only HEAD ${upstream}. A conflict from the simulation is not a reason to ask yet; it is the list of files Spark must resolve.
- If the real merge creates conflicts, resolve them semantically by reading both sides and the surrounding code. Remove every conflict marker before staging.
- Only pause if the correct code cannot be determined after reading the relevant files and diffs.`
      : "";

  return `# ${smartMergePlanTitle(context)}

Fetch has already run. This run is an autonomous smart merge. The user approved Spark to integrate the fetched upstream into the current branch without another confirmation when it can do so safely.

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
${overlapRules}

## Autonomy rules
- During plan_analysis, create worker tasks immediately. Do not emit ask_user just to review commits, inspect diffs, stash, fast-forward, run a normal merge, resolve conflicts, stage resolved merge files, or complete a required merge commit.
- Report progress in chat as notes, not questions: what was fetched, what changed, what command Spark is running, and what finished.
- Prefer the smallest safe operation: fast-forward when possible; otherwise create a normal merge commit. Do not rebase unless a later human message explicitly asks for it.
- If the working tree has local changes, preserve them automatically before branch-changing commands. A recoverable stash is allowed. Name it clearly, then restore it after the upstream merge.
- Before risky merge work, create a recoverable safety ref when possible, for example spark/smart-merge-backup/YYYYMMDD-HHMMSS at the original HEAD.
- Do not push. Do not force push. Do not run git reset --hard, git clean, checkout --, restore, or any command that discards local work.
- Keep unrelated pre-existing user changes intact unless the human explicitly says to include them.

## Pause rules
Pause and ask one concise question only when:
- HEAD is detached or no upstream branch is configured.
- Git authentication or network access fails.
- Git requires a push, force operation, reset, clean, discard, branch target choice, or history rewrite to continue.
- After inspecting the relevant files and diffs, Spark cannot determine the correct conflict resolution with confidence.

## Merge playbook
- If behind is 0 and there are no existing conflicts, complete after reporting that the branch is current.
- If only behind and clean, run git merge --ff-only ${upstream}.
- If only behind and local work exists, protect the local work, run the fast-forward, then restore the local work.
- If ahead and behind, run a normal merge from ${upstream}; resolve conflicts if they appear.
- If an existing merge conflict is already present, finish resolving that conflict before starting any new merge.
- Stage only files needed for the merge resolution. Do not stage unrelated local edits unless they are part of restoring the user's pre-existing work.

## Verification
- Run git status --short --branch before and after the merge work.
- Run git diff --check after conflict resolution.
- Search tracked text files for conflict markers with rg -n "<{7}|={7}|>{7}".
- Run the cheapest relevant project verification command you can identify, such as typecheck or tests. If none is available, explain that clearly.

## Done means
- The current branch is integrated with the fetched upstream, or Spark has paused with the exact blocking question.
- There are no unresolved merge conflicts and no conflict markers left in tracked text files.
- Verification commands and final git status are reported with exit codes.`;
}
