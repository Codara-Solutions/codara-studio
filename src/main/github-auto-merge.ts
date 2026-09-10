import { createHash } from "node:crypto";
import { validGitHubAutoMergeInput, type GitHubAutoMergeInput, type GitHubAutoMergeResult, type GitHubAutoMergeStatus, type GitHubAutoMergeStrategy } from "@shared/github-auto-merge";
import type { GitHubReviewTarget } from "@shared/github-review";
import { invalidateGitHubStatusCache, sanitizeGitHubFailure } from "./github-cli";
import { reviewSession } from "./github-review";

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    autoMergeAllowed mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      id number state headRefOid baseRefOid baseRefName headRefName isDraft viewerCanEnableAutoMerge viewerCanDisableAutoMerge isMergeQueueEnabled isInMergeQueue
      autoMergeRequest { enabledAt enabledBy { login } mergeMethod }
    }
  }
}`;
const ENABLE = `mutation($input: EnablePullRequestAutoMergeInput!) {
  enablePullRequestAutoMerge(input: $input) { pullRequest { id } }
}`;
const DISABLE = `mutation($input: DisablePullRequestAutoMergeInput!) {
  disablePullRequestAutoMerge(input: $input) { pullRequest { id } }
}`;

type Dependencies = Parameters<typeof reviewSession>[2];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned invalid auto-merge status.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error("GitHub returned invalid auto-merge metadata.");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("GitHub returned invalid auto-merge permissions.");
  return value;
}

async function sessionFor(cwd: string, target: GitHubReviewTarget, dependencies: Dependencies) {
  const session = await reviewSession(cwd, target, dependencies);
  const read = async () => {
    const data = object(await session.graphql(QUERY, { owner: session.repository.owner, name: session.repository.name, number: target.pullRequestNumber }));
    const repository = object(data.repository);
    const pr = object(repository.pullRequest);
    if (pr.number !== target.pullRequestNumber || !["OPEN", "CLOSED", "MERGED"].includes(String(pr.state)) ||
        pr.headRefOid !== target.expectedHeadCommitOid || target.expectedBaseCommitOid && pr.baseRefOid !== target.expectedBaseCommitOid) throw new Error("This PR changed. Reopen automatic merge for its current commit.");
    const id = text(pr.id);
    const strategies: GitHubAutoMergeStrategy[] = [];
    if (bool(repository.squashMergeAllowed)) strategies.push("squash");
    if (bool(repository.mergeCommitAllowed)) strategies.push("merge");
    if (bool(repository.rebaseMergeAllowed)) strategies.push("rebase");
    let request: GitHubAutoMergeStatus["request"] = null;
    if (pr.autoMergeRequest !== null) {
      const auto = object(pr.autoMergeRequest);
      if (!["SQUASH", "MERGE", "REBASE"].includes(String(auto.mergeMethod))) throw new Error("GitHub returned an invalid auto-merge strategy.");
      const enabledAt = auto.enabledAt === null ? null : text(auto.enabledAt, 64);
      if (enabledAt && !Number.isFinite(Date.parse(enabledAt))) throw new Error("GitHub returned an invalid auto-merge date.");
      request = { strategy: String(auto.mergeMethod).toLowerCase() as GitHubAutoMergeStrategy, enabledAt,
        enabledBy: auto.enabledBy === null ? null : text(object(auto.enabledBy).login, 256) };
    }
    const queued = bool(pr.isInMergeQueue);
    const fields: Omit<GitHubAutoMergeStatus, "revision"> = {
      state: pr.state as GitHubAutoMergeStatus["state"], headCommitOid: target.expectedHeadCommitOid,
      baseBranch: text(pr.baseRefName), headBranch: text(pr.headRefName), draft: bool(pr.isDraft),
      allowed: bool(repository.autoMergeAllowed), canEnable: bool(pr.viewerCanEnableAutoMerge), canDisable: bool(pr.viewerCanDisableAutoMerge) && !queued, strategies, request,
      mergeQueue: bool(pr.isMergeQueueEnabled), queued,
    };
    const revision = createHash("sha256").update(JSON.stringify([session.repository.url, id, fields])).digest("hex");
    return { id, status: { ...fields, revision } };
  };
  return { read, graphql: session.graphql };
}

export async function readGitHubAutoMerge(cwd: string, target: GitHubReviewTarget, dependencies: Dependencies = {}): Promise<GitHubAutoMergeStatus> {
  return (await (await sessionFor(cwd, target, dependencies)).read()).status;
}

export async function updateGitHubAutoMerge(cwd: string, input: GitHubAutoMergeInput, dependencies: Dependencies = {}): Promise<GitHubAutoMergeResult> {
  if (!validGitHubAutoMergeInput(input)) return { kind: "failed", message: "Check the automatic merge request." };
  let session: Awaited<ReturnType<typeof sessionFor>>;
  let current: Awaited<ReturnType<Awaited<ReturnType<typeof sessionFor>>["read"]>>;
  try {
    session = await sessionFor(cwd, input.target, dependencies);
    current = await session.read();
    const status = current.status;
    if (status.revision !== input.expectedRevision) throw new Error("Automatic merge changed since you opened this screen. Refresh and confirm again.");
    if (status.state !== "OPEN" || status.draft) throw new Error("Automatic merge requires an open PR that is ready for review.");
    if (input.action === "enable") {
      if (status.request || status.queued) throw new Error("Automatic merge is already enabled or queued. Refresh to manage it.");
      if ((!status.allowed && !status.mergeQueue) || !status.canEnable || (!status.mergeQueue && !status.strategies.includes(input.strategy))) throw new Error("GitHub does not allow this automatic merge request. Check repository settings and permissions.");
    } else if (status.queued) throw new Error("This PR is already in the merge queue. Manage its queue entry on GitHub.");
    else if (!status.request || !status.canDisable) throw new Error("GitHub does not allow cancelling this automatic merge request. Refresh its status.");
  } catch (cause) { return { kind: "failed", message: sanitizeGitHubFailure(cause) }; }

  let writeError: unknown;
  try {
    await session.graphql(input.action === "enable" ? ENABLE : DISABLE, { input: {
      pullRequestId: current.id,
      ...(input.action === "enable" ? { expectedHeadOid: input.target.expectedHeadCommitOid, mergeMethod: input.strategy.toUpperCase() } : {}),
    } });
  } catch (cause) { writeError = cause; }
  try {
    // A lost mutation reply may still have changed GitHub. Verify its state
    // before reporting success or allowing a different request.
    const { status } = await session.read();
    if (status.state === "MERGED") return { kind: "confirmed", outcome: "merged", status };
    if (status.queued) return { kind: "confirmed", outcome: "queued", status };
    if (input.action === "enable" && status.request && (status.mergeQueue || status.request.strategy === input.strategy) || input.action === "disable" && !status.request) {
      return { kind: "confirmed", outcome: input.action === "enable" ? "enabled" : "disabled", status };
    }
  } catch (cause) { writeError ??= cause; }
  finally { invalidateGitHubStatusCache(cwd); }
  return { kind: "unknown", message: `GitHub did not confirm the automatic merge outcome. Refresh this PR on GitHub before making another change. ${writeError ? sanitizeGitHubFailure(writeError) : ""}`.trim() };
}
