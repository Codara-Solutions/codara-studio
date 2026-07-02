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

/**
 * Re-frames a generic Smart Merge context so the *incoming* side is a sandbox
 * worker's worktree branch instead of the remote upstream. The run workspace
 * repository is still the destination (`repositoryRoot`/`branch`); we only swap
 * the upstream label so {@link smartMergePlanTitle} and {@link buildSmartMergePlan}
 * speak in terms of the sandbox branch the agent should integrate back.
 */
function reframeForSandbox(
  context: GitSmartMergeContext,
  sandboxBranch: string,
): GitSmartMergeContext {
  return {
    ...context,
    upstream: sandboxBranch,
    // The destination is the live workspace branch (never detached for this flow);
    // the sandbox branch is a concrete local ref, so the target is unambiguous.
    detached: false,
    recommendedStrategy: recommendSmartMergeStrategy({
      upstream: sandboxBranch,
      detached: false,
      ahead: context.ahead,
      behind: context.behind,
      hasWorkingChanges: context.hasWorkingChanges,
      hasConflicts: context.hasConflicts,
      overlapCount: context.overlappingFiles.length,
    }),
  };
}

export function sandboxMergePlanTitle(context: GitSmartMergeContext): string {
  const branch = context.branch ?? "workspace";
  const sandboxBranch = context.upstream ?? "sandbox branch";
  return `Integrate sandbox ${sandboxBranch} -> ${branch}`;
}

export function buildSandboxMergePlan(context: GitSmartMergeContext): string {
  const branch = context.branch ?? "the workspace branch";
  const sandboxBranch = context.upstream ?? "(sandbox branch unknown)";

  // Reuse the conversational generic plan verbatim, then prepend a short banner
  // that orients the agent: the incoming work is a local sandbox worktree branch
  // forked from this run's checkpoint, not a remote upstream.
  return `# ${sandboxMergePlanTitle(context)}

An unattended worker ran inside an isolated git worktree on the branch \`${sandboxBranch}\`, forked from this run's checkpoint. Integrate that worktree's work back into \`${branch}\` in this repository (${context.repositoryRoot}). Treat \`${sandboxBranch}\` as the incoming side wherever the preflight below mentions the upstream — fast-forward if you can, otherwise a normal merge commit; ask me only if something looks risky or ambiguous.

${buildSmartMergePlan(context)}`;
}

/**
 * Drives the existing Smart Merge preflight to integrate a sandbox worker's
 * worktree branch back into the run workspace repository. Composes
 * {@link requestPrepareSmartMerge} (no duplicated preflight) and re-frames the
 * incoming side as `sandboxBranch` so the conversational Smart Merge can
 * fast-forward / merge the worktree work back.
 */
export async function prepareSandboxMerge(input: {
  repoCwd: string;
  sandboxBranch: string;
}): Promise<GitSmartMergeResult> {
  const result = await requestPrepareSmartMerge(input.repoCwd);
  if (!result.ok) return result;
  return { ok: true, context: reframeForSandbox(result.context, input.sandboxBranch) };
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
      ? `${formatCount(context.overlappingFiles.length)} file(s) changed on both sides`
      : "no files changed on both sides";

  return `# ${smartMergePlanTitle(context)}

I've already run \`git fetch --prune\`. Below is where this branch stands against ${upstream}. Read it over, tell me in a sentence or two what merging will involve, and ask me if anything looks ambiguous or risky before you act — otherwise go ahead and do the merge yourself. You can run git directly.

## Where things stand (Cora preflight)
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
- Where I'd start: ${context.recommendedStrategy}

## Current status
${fenced(context.statusShort, "(git status was empty)")}

## Remote commits not yet local
${fenced(context.remoteOnlyCommits, "(none)")}

## Local commits not on the remote
${fenced(context.localOnlyCommits, "(none)")}

## Remote changed files
${formatList(context.remoteChangedFiles, "No fetched remote file changes were detected.")}

## Local files you've touched (commits or working tree)
${formatList(localTouchedFiles, "No local file changes were detected.")}

## Files changed on both sides
${formatList(context.overlappingFiles, "No file was changed on both sides in the preflight.")}

## How to go about it
- Skim the incoming commits and any files changed on both sides so you understand what's coming. A quick non-mutating check like \`git merge-tree --write-tree --name-only HEAD ${upstream}\` shows where the real conflicts would land — a conflict there isn't a reason to stop, it's the list of files to resolve.
- Tell me what you're going to do (fast-forward, a normal merge commit, or resolving conflicts). If it's genuinely unclear or could lose work, ask me first; otherwise carry it out.
- Prefer the smallest safe operation: fast-forward when you can, otherwise a normal merge commit. Don't rebase unless I ask.
- Protect my local work before any branch-changing command — a clearly named, recoverable stash is fine; restore it afterward. Before risky steps, a backup ref like spark/smart-merge-backup/YYYYMMDD-HHMMSS at the current HEAD is welcome.
- Resolve conflicts semantically by reading both sides and the surrounding code; remove every conflict marker before staging. Stage only what the merge needs, and leave my unrelated changes alone.
- Never push, force-push, or run git reset --hard, git clean, checkout --, or restore — anything that discards my work.

## When you're done
- The branch is integrated with ${upstream}, or you've paused with one concise question.
- No unresolved conflicts and no leftover conflict markers in tracked files.
- Report what you did: run \`git status --short --branch\` and \`git diff --check\`, scan for conflict markers (e.g. \`rg -n "<{7}|={7}|>{7}"\`), run the cheapest relevant project check (typecheck or tests) if there is one, and tell me the results.`;
}
