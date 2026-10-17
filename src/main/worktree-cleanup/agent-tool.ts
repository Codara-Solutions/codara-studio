import { isAbsolute } from "node:path";
import { isRemotePath } from "@shared/remote";
import type { WorktreeCleanupRow, WorktreeRemovalCheck, WorktreeSize } from "@shared/worktree-cleanup";
import { formatBytes } from "@shared/worktree-cleanup";
import {
  ADVICE_LABELS,
  DEFAULT_ADVICE_STALE_DAYS,
  adviseWorktree,
  hasUnsavedChanges,
  onlyIgnoredWork,
  remoteBranchVerdict,
  sortByAdvice,
  type AgentPullRequestState,
  type WorktreeAdvice,
  type WorktreeCleanupAgentResult,
  type WorktreeCleanupApprovalAnswer,
  type WorktreeCleanupApprovalItem,
  type WorktreeCleanupApprovalRequest,
  type WorktreeCleanupRemoteOutcome,
} from "@shared/worktree-cleanup-agent";
import { cleanText, type WorktreeCaller } from "../agent-worktrees";
import { NETWORK_TIMEOUT_MS, errorText, readGitText, runGit } from "../git-exec";
import { isAncestor } from "../git-worktrees";
import { canonicalPath, pathKey, type RepoPullRequests, type WorktreeCleanupDeps } from "./inspect";
import { checkCleanupTargets, removeCleanupWorktrees } from "./remove";
import { scanWorktreeCleanup } from "./scan";

// codara_worktree_cleanup: the cleanup screen's facts for an agent, with a
// recommendation per worktree, and removal only through the user's approval
// in Codara. The scan and the removal are the screen's own (scan.ts,
// inspect.ts, remove.ts), so every safety rule is identical; on top of them
// an agent's request can never remove a worktree with unsaved changes or
// one in use, and a remote branch is deleted only when the user ticked it,
// its pull request merged it and its tip has not moved since the dialog
// showed it. No Electron import: index.ts passes the app and the dialog in.

export interface ClosedPullRequest {
  number: number;
  url: string;
  headRefName: string;
  isCrossRepository: boolean;
}

export interface AgentCleanupDeps {
  cleanup: WorktreeCleanupDeps;
  sizeOf(id: string): WorktreeSize | null;
  /** Measures the given worktrees, waiting at most `budgetMs`; what lands is read back with sizeOf. */
  measureSizes(items: Array<{ id: string; path: string }>, budgetMs: number): Promise<void>;
  forgetSize?(id: string): void;
  /** The lists GitHub gives now, not the cached ones. */
  freshPullRequests?(root: string): Promise<RepoPullRequests>;
  /** Pull requests closed without merging. */
  closedPullRequests?(root: string): Promise<ClosedPullRequest[]>;
  remote: RemoteGitOps;
}

export interface RemoteGitOps {
  /** Every branch on the remote and its tip. Rejects when the remote cannot be reached. */
  heads(root: string, remote: string): Promise<Map<string, string>>;
  /** Deletes the branch only while the remote still has it at `tip`. */
  deleteBranch(root: string, remote: string, branch: string, tip: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

const LS_REMOTE_TIMEOUT_MS = 30_000;

export const gitRemoteOps: RemoteGitOps = {
  async heads(root, remote) {
    const { stdout } = await runGit(root, ["ls-remote", "--heads", "--end-of-options", remote], { timeout: LS_REMOTE_TIMEOUT_MS });
    const heads = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/i.exec(line.trim());
      if (match) heads.set(match[2], match[1].toLowerCase());
    }
    return heads;
  },
  async deleteBranch(root, remote, branch, tip) {
    try {
      // The lease makes the deletion a compare-and-delete: a push that
      // landed on the branch since the user approved keeps it.
      await runGit(
        root,
        ["push", "--porcelain", `--force-with-lease=refs/heads/${branch}:${tip}`, remote, "--delete", `refs/heads/${branch}`],
        { timeout: NETWORK_TIMEOUT_MS },
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: cleanText(errorText(err), 300) };
    }
  },
};

const SIZE_BUDGET_MS = 45_000;
const MAX_REMOVE_ITEMS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Facts ──────────────────────────────────────────────────────────────────

interface RepoRemote {
  remote: string | null;
  remoteNames: string[];
  /** Branch tips on the remote; null when unknown. */
  heads: Map<string, string> | null;
  asked: boolean;
  error?: string;
  pulls: RepoPullRequests | null;
  closed: ClosedPullRequest[] | null;
  githubError?: string;
  baseCommit: string | null;
  baseShort: string | null;
}

export interface AgentWorktreeFacts {
  row: WorktreeCleanupRow;
  check: WorktreeRemovalCheck | null;
  advice: WorktreeAdvice;
  reason: string;
  pullRequest: { number: number; url: string; state: AgentPullRequestState } | null;
  remoteName: string | null;
  remoteTip: string | null;
  onRemote: boolean | null;
  unpushed: number | null;
  remoteVerdict: { offered: boolean; reason: string };
}

function shortName(name: string, remotes: readonly string[]): string {
  for (const remote of remotes) if (name.startsWith(`${remote}/`)) return name.slice(remote.length + 1);
  return name;
}

async function repoRemote(
  deps: AgentCleanupDeps,
  root: string,
  base: string | null,
  checkMerge: boolean,
): Promise<RepoRemote> {
  const remoteNames = (await readGitText(root, ["remote"])).split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const remote = remoteNames.includes("origin") ? "origin" : (remoteNames[0] ?? null);
  const out: RepoRemote = {
    remote,
    remoteNames,
    heads: null,
    asked: false,
    pulls: null,
    closed: null,
    baseCommit: null,
    baseShort: base ? shortName(base, remoteNames) : null,
  };
  if (base) {
    const commit = await readGitText(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`]);
    out.baseCommit = /^[0-9a-f]{40,64}$/i.test(commit) ? commit.toLowerCase() : null;
  }
  if (remote) {
    if (checkMerge) {
      try {
        out.heads = await deps.remote.heads(root, remote);
        out.asked = true;
      } catch (err) {
        out.error = cleanText(errorText(err), 200);
      }
    }
    if (!out.heads) {
      // The last fetch: what git knows of the remote without asking it.
      const listed = await readGitText(root, ["for-each-ref", "--format=%(refname)%00%(objectname)", `refs/remotes/${remote}/`]);
      const heads = new Map<string, string>();
      for (const line of listed.split(/\r?\n/)) {
        const [ref, oid] = line.split("\0");
        if (!ref || !oid || ref.endsWith("/HEAD")) continue;
        heads.set(ref.slice(`refs/remotes/${remote}/`.length), oid.toLowerCase());
      }
      out.heads = heads;
    }
  }
  try {
    // With checkMerge the scan just asked GitHub afresh, and the cache holds that answer.
    out.pulls = await deps.cleanup.pullRequests(root);
  } catch (err) {
    out.githubError = cleanText(errorText(err), 200);
  }
  if (checkMerge && out.pulls && deps.closedPullRequests) {
    out.closed = await deps.closedPullRequests(root).catch(() => null);
  }
  return out;
}

async function countBetween(root: string, from: string, to: string): Promise<number | null> {
  const out = await readGitText(root, ["rev-list", "--count", `${from}..${to}`]);
  return /^\d+$/.test(out) ? Number(out) : null;
}

async function factsFor(
  row: WorktreeCleanupRow,
  check: WorktreeRemovalCheck | null,
  remote: RepoRemote,
  now: number,
  staleDays: number,
): Promise<AgentWorktreeFacts> {
  const branch = row.branch;
  const remoteTip = branch && remote.heads ? (remote.heads.get(branch) ?? null) : null;
  const onRemote = branch && remote.heads ? remoteTip !== null : null;
  let unpushed: number | null = null;
  if (remoteTip && row.head) unpushed = await countBetween(row.repoRoot, remoteTip, row.head);
  if (unpushed === null && onRemote && row.upstream && !row.upstream.gone) unpushed = row.upstream.ahead;

  let pullRequest: AgentWorktreeFacts["pullRequest"] = row.pullRequest
    ? { number: row.pullRequest.number, url: row.pullRequest.url, state: row.pullRequest.state }
    : null;
  if (!pullRequest && branch && remote.pulls) {
    const closed = remote.closed?.find((pr) => pr.headRefName === branch && !pr.isCrossRepository);
    pullRequest = closed ? { number: closed.number, url: closed.url, state: "closed" } : null;
  }
  const prState: AgentPullRequestState = pullRequest?.state ?? (remote.pulls ? "none" : "unknown");

  const hardBlockers = (check?.blockers ?? []).filter((entry) => entry.code !== "IN_USE" && entry.code !== "LOCKED");
  const { advice, reason } = adviseWorktree(
    {
      missing: row.missing,
      locked: row.locked,
      inUse: row.inUse,
      hardBlockers,
      dirty: row.dirty,
      localWork: check?.localWork ?? null,
      merge: check?.merge ?? row.merge,
      ahead: check?.unmerged?.ahead ?? row.base?.ahead ?? 0,
      pullRequest: pullRequest ? { number: pullRequest.number, state: prState } : null,
      onRemote,
      unpushed,
      lastActivityAt: row.lastActivityAt,
    },
    now,
    staleDays,
  );
  // A worktree the full check could not finish is never offered as safe.
  const checked = check ?? null;
  const settled = checked ? { advice, reason } : { advice: "keep" as const, reason: "The full check did not finish. Scan again." };

  const merged = branch
    ? (remote.pulls?.merged ?? []).filter((pr) => pr.headRefName === branch && !pr.isCrossRepository)
    : [];
  const mergedPullRequest = merged.find((pr) => pr.headRefOid.toLowerCase() === remoteTip) ?? merged[0] ?? null;
  const open = branch ? (remote.pulls?.open ?? []).find((pr) => pr.headBranch === branch && pr.isCrossRepository !== true) : undefined;
  const remoteTipInBase = Boolean(remoteTip && remote.baseCommit && (await isAncestor(row.repoRoot, remoteTip, remote.baseCommit)));
  const target = check?.merge.target ?? row.merge.target;
  const remoteVerdict = remoteBranchVerdict({
    branch,
    remote: remote.remote,
    remoteTip,
    remoteAsked: remote.asked,
    baseBranches: [remote.baseShort, target ? shortName(target, remote.remoteNames) : null].filter(
      (name): name is string => Boolean(name),
    ),
    mergedPullRequest: mergedPullRequest ? { number: mergedPullRequest.number, headRefOid: mergedPullRequest.headRefOid } : null,
    openPullRequest: open ? open.number : null,
    remoteTipInBase,
    ...(remote.githubError ? { githubError: remote.githubError } : {}),
  });
  return {
    row,
    check,
    ...settled,
    pullRequest,
    remoteName: remote.remote,
    remoteTip,
    onRemote,
    unpushed,
    remoteVerdict,
  };
}

interface Collected {
  facts: AgentWorktreeFacts[];
  repos: Array<{ root: string; name: string; base: string | null; remote: string | null; remoteChecked: boolean; note?: string }>;
  notCovered: Array<{ workspace: string; path: string; reason: string }>;
  processScan: boolean;
}

async function collect(
  deps: AgentCleanupDeps,
  options: { checkMerge: boolean; staleDays: number; only?: ReadonlySet<string> },
): Promise<Collected> {
  const state = await deps.cleanup.loadState();
  const notCovered = state.workspaces
    .filter((workspace) => workspace.remote || (workspace.cwd && isRemotePath(workspace.cwd)))
    .map((workspace) => ({
      workspace: workspace.name,
      path: workspace.cwd,
      reason: "SSH workspace: its worktrees live on the remote host and are not covered.",
    }));
  const cleanupDeps: WorktreeCleanupDeps =
    options.checkMerge && deps.freshPullRequests ? { ...deps.cleanup, pullRequests: deps.freshPullRequests } : deps.cleanup;
  const { scan } = await scanWorktreeCleanup(cleanupDeps, { sizeOf: deps.sizeOf });
  const rows = scan.rows.filter((row) => !row.isMain && (!options.only || options.only.has(pathKey(row.id)) || options.only.has(pathKey(row.path))));

  const unsized = rows.filter((row) => {
    if (row.missing) return false;
    const size = deps.sizeOf(row.id);
    return !size || !size.complete;
  });
  if (unsized.length) await deps.measureSizes(unsized.map((row) => ({ id: row.id, path: row.path })), SIZE_BUDGET_MS).catch(() => undefined);

  const checks = await checkCleanupTargets(
    deps.cleanup,
    rows.map((row) => ({ repoRoot: row.repoRoot, path: row.path })),
  ).catch(() => [] as WorktreeRemovalCheck[]);
  const checkOf = new Map(checks.map((check) => [`${pathKey(check.repoRoot)}\0${pathKey(check.path)}`, check]));

  const remotes = new Map<string, Promise<RepoRemote>>();
  const remoteFor = (root: string): Promise<RepoRemote> => {
    let pending = remotes.get(root);
    if (!pending) {
      const summary = scan.repos.find((repo) => repo.root === root);
      pending = repoRemote(deps, root, summary?.base ?? null, options.checkMerge);
      remotes.set(root, pending);
    }
    return pending;
  };
  const now = deps.cleanup.now().getTime();
  const facts: AgentWorktreeFacts[] = [];
  for (const row of rows) {
    const sized = { ...row, size: deps.sizeOf(row.id) ?? row.size };
    const check = checkOf.get(`${pathKey(row.repoRoot)}\0${pathKey(row.path)}`) ?? null;
    facts.push(await factsFor(sized, check, await remoteFor(row.repoRoot), now, options.staleDays));
  }
  const repos = [];
  for (const repo of scan.repos) {
    const remote = await remoteFor(repo.root);
    const notes = [
      repo.error,
      remote.error ? `the remote could not be asked: ${remote.error}` : null,
      remote.githubError ? `GitHub could not be asked: ${remote.githubError}` : null,
    ].filter(Boolean);
    repos.push({
      root: repo.root,
      name: repo.name,
      base: repo.base,
      remote: remote.remote,
      remoteChecked: remote.asked,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    });
  }
  return { facts, repos, notCovered, processScan: scan.processScan };
}

// ── Scan ───────────────────────────────────────────────────────────────────

function isoOrNull(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

function sizeBytesOf(facts: AgentWorktreeFacts): number | null {
  return facts.row.size ? facts.row.size.bytes : null;
}

function scanItem(facts: AgentWorktreeFacts, now: number): Record<string, unknown> {
  const { row, check } = facts;
  const work = check?.localWork ?? null;
  return {
    repo: row.repoName,
    repoRoot: row.repoRoot,
    branch: row.branch,
    path: row.path,
    workspace: row.workspace?.name ?? null,
    codaraManaged: Boolean(row.workspace?.createdBy),
    sizeBytes: sizeBytesOf(facts),
    size: row.size ? `${row.size.complete ? "" : "at least "}${formatBytes(row.size.bytes)}` : "not measured",
    lastActivity: isoOrNull(row.lastActivityAt),
    idleDays: row.lastActivityAt === null ? null : Math.floor(Math.max(0, now - row.lastActivityAt) / DAY_MS),
    missing: row.missing,
    dirtyFiles: row.dirty ? row.dirty.tracked + row.dirty.untracked : null,
    ...(row.dirty?.inProgress ? { inProgress: row.dirty.inProgress } : {}),
    ignoredFiles: work?.ignored ?? [],
    blockers: (check?.blockers ?? []).map((entry) => ({ code: entry.code, message: entry.message })),
    inUse: row.inUse.map((use) => use.label),
    merge: {
      state: check?.merge.state ?? row.merge.state,
      ...((check?.merge.proof ?? row.merge.proof) ? { proof: check?.merge.proof ?? row.merge.proof } : {}),
      ...((check?.merge.target ?? row.merge.target) ? { target: check?.merge.target ?? row.merge.target } : {}),
      ahead: check?.unmerged?.ahead ?? row.base?.ahead ?? 0,
    },
    pullRequest: facts.pullRequest,
    remoteBranch: {
      remote: facts.remoteName,
      exists: facts.onRemote,
      unpushedCommits: facts.unpushed,
      deletable: facts.remoteVerdict.offered,
      why: facts.remoteVerdict.reason,
    },
    recommendation: ADVICE_LABELS[facts.advice],
    reason: facts.reason,
  };
}

export async function scanForAgent(
  deps: AgentCleanupDeps,
  input: { checkMerge?: boolean; staleDays?: number },
): Promise<Record<string, unknown>> {
  const checkMerge = input.checkMerge === true;
  const staleDays = Math.max(1, Math.min(365, Math.floor(input.staleDays ?? DEFAULT_ADVICE_STALE_DAYS)));
  const collected = await collect(deps, { checkMerge, staleDays });
  const now = deps.cleanup.now().getTime();
  const sorted = sortByAdvice(
    collected.facts.map((facts) => ({ facts, advice: facts.advice, sizeBytes: sizeBytesOf(facts), path: facts.row.path })),
  );
  const totals = { safe: { count: 0, bytes: 0 }, review: { count: 0, bytes: 0 }, keep: { count: 0, bytes: 0 } };
  for (const entry of sorted) {
    totals[entry.advice].count += 1;
    totals[entry.advice].bytes += entry.sizeBytes ?? 0;
  }
  return {
    ok: true,
    checkMerge,
    staleDays,
    worktrees: sorted.map((entry) => scanItem(entry.facts, now)),
    totals: {
      worktrees: sorted.length,
      safeToRemove: totals.safe.count,
      review: totals.review.count,
      keep: totals.keep.count,
      safeRemovalFrees: formatBytes(totals.safe.bytes),
      safeRemovalFreesBytes: totals.safe.bytes,
      reviewHolds: formatBytes(totals.review.bytes),
    },
    repos: collected.repos,
    notCovered: collected.notCovered,
    ...(collected.processScan ? {} : { note: "Running programs are not checked on this system." }),
    next:
      "Explain the recommendations to the user in plain words. To remove, call again with action:\"remove\" and the paths; Codara asks the user to approve each one.",
  };
}

// ── Remove ─────────────────────────────────────────────────────────────────

export interface RemoveForAgentInput {
  items: Array<{ path: string; deleteRemoteBranch?: boolean }>;
  deleteRemoteBranch?: boolean;
  staleDays?: number;
}

/** Shows the request to the user; null when they did not answer in time, "no-window" when it could not be shown. */
export type ApprovalAsker = (request: Omit<WorktreeCleanupApprovalRequest, "id" | "expiresAt">) => Promise<WorktreeCleanupApprovalAnswer | null | "no-window">;

function blockedReason(facts: AgentWorktreeFacts): string | null {
  const { row, check } = facts;
  if (!check) return "The full check did not finish.";
  if (row.inUse.length) return `In use: ${row.inUse.map((use) => use.label).join(", ")}.`;
  if (hasUnsavedChanges({ dirty: row.dirty, localWork: check.localWork, missing: row.missing })) {
    return "It has unsaved changes. Only you can remove it, from Clean up worktrees.";
  }
  if (check.blockers.length) return check.blockers[0].message;
  return null;
}

function approvalItem(facts: AgentWorktreeFacts, suggestedRemote: boolean): WorktreeCleanupApprovalItem {
  const { row, check } = facts;
  const blocked = blockedReason(facts);
  return {
    repoRoot: row.repoRoot,
    repoName: row.repoName,
    path: row.path,
    branch: row.branch,
    workspaceName: row.workspace?.name ?? null,
    sizeBytes: sizeBytesOf(facts),
    advice: facts.advice,
    reason: facts.reason,
    blocked,
    preselected: blocked === null && facts.advice === "safe",
    ignored: check?.localWork?.ignored ?? [],
    unmergedCommits: check?.unmerged?.ahead ?? 0,
    remote: {
      offered: blocked === null && facts.remoteVerdict.offered,
      reason: facts.remoteVerdict.reason,
      name: facts.remoteName,
      suggested: suggestedRemote,
    },
  };
}

function emptyResult(status: WorktreeCleanupAgentResult["status"], note: string): WorktreeCleanupAgentResult {
  return { ok: status === "done" || status === "nothing-to-remove", status, removed: [], skipped: [], remoteBranches: [], note };
}

export async function removeForAgent(
  deps: AgentCleanupDeps,
  input: RemoveForAgentInput,
  context: { caller: WorktreeCaller; agent: { client: string; workspaceName: string | null } },
  ask: ApprovalAsker,
): Promise<WorktreeCleanupAgentResult> {
  const wanted = (Array.isArray(input.items) ? input.items : [])
    .filter((item) => item && typeof item.path === "string" && isAbsolute(item.path))
    .slice(0, MAX_REMOVE_ITEMS);
  if (!wanted.length) return { ...emptyResult("nothing-to-remove", "Pass the absolute paths from the scan."), ok: false };
  const keys = new Map<string, { path: string; deleteRemoteBranch: boolean }>();
  for (const item of wanted) {
    const entry = { path: item.path, deleteRemoteBranch: item.deleteRemoteBranch ?? input.deleteRemoteBranch === true };
    keys.set(pathKey(item.path), entry);
    keys.set(pathKey(await canonicalPath(item.path)), entry);
  }
  const staleDays = Math.max(1, Math.min(365, Math.floor(input.staleDays ?? DEFAULT_ADVICE_STALE_DAYS)));
  const collected = await collect(deps, { checkMerge: true, staleDays, only: new Set(keys.keys()) });
  const found = new Set<string>();
  const items: Array<{ facts: AgentWorktreeFacts; item: WorktreeCleanupApprovalItem }> = [];
  for (const facts of sortByAdvice(
    collected.facts.map((entry) => ({ ...entry, sizeBytes: sizeBytesOf(entry), path: entry.row.path })),
  )) {
    const request = keys.get(pathKey(facts.row.id)) ?? keys.get(pathKey(facts.row.path));
    if (!request) continue;
    found.add(request.path);
    items.push({ facts, item: approvalItem(facts, request.deleteRemoteBranch) });
  }
  const skipped: WorktreeCleanupAgentResult["skipped"] = wanted
    .filter((item) => !found.has(item.path))
    .map((item) => ({
      repoRoot: "",
      path: item.path,
      branch: null,
      reason: "Not a worktree of a repository behind your workspaces, or the main checkout, which is never removed.",
    }));
  if (!items.some((entry) => entry.item.blocked === null)) {
    for (const { item } of items) skipped.push({ repoRoot: item.repoRoot, path: item.path, branch: item.branch, reason: item.blocked ?? "" });
    return { ...emptyResult("nothing-to-remove", "Nothing asked for can be removed, so the user was not asked."), skipped };
  }

  const answer = await ask({ agent: context.agent, items: items.map((entry) => entry.item) });
  const unanswered = (status: "declined" | "timeout" | "no-window", note: string): WorktreeCleanupAgentResult => ({
    ...emptyResult(status, note),
    skipped: [
      ...skipped,
      ...items.map(({ item }) => ({ repoRoot: item.repoRoot, path: item.path, branch: item.branch, reason: item.blocked ?? note })),
    ],
  });
  if (answer === "no-window") return unanswered("no-window", "Codara has no open window to ask the user. Nothing was removed.");
  if (answer === null) return unanswered("timeout", "The user did not answer in time. Nothing was removed.");
  if (!answer.approved) return unanswered("declined", "The user declined. Nothing was removed.");

  const decisions = new Map<string, { remove: boolean; deleteRemoteBranch: boolean }>();
  for (const entry of Array.isArray(answer.items) ? answer.items : []) {
    if (!entry || typeof entry.path !== "string" || typeof entry.repoRoot !== "string") continue;
    decisions.set(`${pathKey(entry.repoRoot)}\0${pathKey(entry.path)}`, {
      remove: entry.remove === true,
      deleteRemoteBranch: entry.deleteRemoteBranch === true,
    });
  }
  const chosen: Array<{ facts: AgentWorktreeFacts; item: WorktreeCleanupApprovalItem; deleteRemoteBranch: boolean }> = [];
  for (const { facts, item } of items) {
    const decision = decisions.get(`${pathKey(item.repoRoot)}\0${pathKey(item.path)}`);
    if (item.blocked !== null) {
      skipped.push({ repoRoot: item.repoRoot, path: item.path, branch: item.branch, reason: item.blocked });
    } else if (!decision?.remove) {
      skipped.push({ repoRoot: item.repoRoot, path: item.path, branch: item.branch, reason: "The user left it unticked." });
    } else {
      chosen.push({ facts, item, deleteRemoteBranch: decision.deleteRemoteBranch && item.remote.offered });
    }
  }
  if (!chosen.length) return { ...emptyResult("done", "The user approved nothing. Nothing was removed."), skipped };

  const result = await removeCleanupWorktrees(
    deps.cleanup,
    {
      items: chosen.map(({ facts }) => {
        const check = facts.check!;
        return {
          repoRoot: check.repoRoot,
          path: check.path,
          fingerprint: check.fingerprint,
          // The dialog listed the ignored files and the commits the branch
          // keeps; the user ticked this item knowing them. Edits and new
          // files never get here: blockedReason refused them.
          confirmDirty: onlyIgnoredWork(check.localWork),
          confirmUnmerged: check.unmerged !== null,
        };
      }),
      deleteMergedBranches: answer.deleteMergedBranches === true,
    },
    { sizeOf: deps.sizeOf, ...(deps.forgetSize ? { forgetSize: deps.forgetSize } : {}), caller: context.caller },
  );

  const removed: WorktreeCleanupAgentResult["removed"] = [];
  const remoteBranches: WorktreeCleanupRemoteOutcome[] = [];
  for (const outcome of result.outcomes) {
    const pick = chosen.find((entry) => pathKey(entry.item.path) === pathKey(outcome.path) && pathKey(entry.item.repoRoot) === pathKey(outcome.repoRoot));
    if (outcome.status === "removed" || outcome.status === "already-removed") {
      removed.push({
        repoRoot: outcome.repoRoot,
        path: outcome.path,
        branch: outcome.branch,
        branchDeleted: outcome.branchDeleted,
        reclaimedBytes: outcome.reclaimedBytes ?? null,
        ...(outcome.recoveryRef ? { recoveryRef: outcome.recoveryRef } : {}),
      });
    } else {
      skipped.push({ repoRoot: outcome.repoRoot, path: outcome.path, branch: outcome.branch, reason: outcome.message ?? outcome.code ?? outcome.status });
    }
    if (!pick?.deleteRemoteBranch || !pick.item.branch) continue;
    const branch = pick.item.branch;
    const remote = pick.facts.remoteName;
    const base = { repoRoot: outcome.repoRoot, branch, remote };
    if (outcome.status !== "removed" && outcome.status !== "already-removed") {
      remoteBranches.push({ ...base, status: "skipped", message: "The worktree was not removed, so its remote branch stays." });
      continue;
    }
    remoteBranches.push({ ...base, ...(await deleteRemote(deps, outcome.repoRoot, remote, branch, pick.facts.remoteTip)) });
  }
  const freed = removed.reduce((total, entry) => total + (entry.reclaimedBytes ?? 0), 0);
  return {
    ok: true,
    status: "done",
    removed,
    skipped,
    remoteBranches,
    outcomes: result.outcomes,
    keptBranches: result.keptBranches,
    note: `${removed.length} removed${freed ? `, ${formatBytes(freed)} freed` : ""}, ${skipped.length} skipped.`,
  };
}

async function deleteRemote(
  deps: AgentCleanupDeps,
  root: string,
  remote: string | null,
  branch: string,
  shownTip: string | null,
): Promise<{ status: WorktreeCleanupRemoteOutcome["status"]; message: string }> {
  if (!remote || !shownTip) return { status: "skipped", message: "The repository has no remote, or the branch is not on it." };
  let heads: Map<string, string>;
  try {
    heads = await deps.remote.heads(root, remote);
  } catch (err) {
    return { status: "failed", message: `${remote} could not be reached: ${cleanText(errorText(err), 200)}` };
  }
  const tip = heads.get(branch) ?? null;
  if (!tip) return { status: "skipped", message: `The branch is no longer on ${remote}.` };
  if (tip !== shownTip) return { status: "skipped", message: `The branch moved on ${remote} since you approved, so it stays.` };
  const deleted = await deps.remote.deleteBranch(root, remote, branch, tip);
  return deleted.ok
    ? { status: "deleted", message: `Deleted ${branch} on ${remote}.` }
    : { status: "failed", message: `git push could not delete it (check your git or GitHub sign-in): ${deleted.error}` };
}
