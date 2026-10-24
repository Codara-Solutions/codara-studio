// The pull request watcher. For each local workspace on a branch with a pull
// request (every worktree an agent works in is one), it follows the pull
// request through the user's own `gh` and acts when its state changes:
//
// - The rail row shows the pull request, its phase (draft, open, merged,
//   closed) and its checks (running, passing, failing).
// - When the checks fail, the agent working on that branch is told in one
//   line (ci-agent-nudge.ts), once per failing head commit, never mid-turn.
// - The user gets "CI failed on pull request #N" (Settings, Git: "Notify me
//   when CI fails on my pull request"), once per failing head commit, and a
//   quiet note when the checks go green again.
//
// Cost: every read is a conditional request (github-conditional.ts). GitHub
// answers 304 Not Modified when nothing changed, which does not count
// against the rate limit. Each minute the watcher reads the local HEAD and
// upstream of every workspace (plain git, no network); a branch without an
// upstream, or one that tracks the remote's default branch, has no pull
// request and is skipped. An open pull request is asked about every minute
// while its checks run, and otherwise after 1, 2, 4, 8 and then every 15
// minutes while nothing changes; a commit or a push asks at once and starts
// over at one minute. A branch with no pull request, or a merged or closed
// one, is asked every 15 minutes. While nobody has touched the computer for
// ten minutes it looks every five minutes instead of every minute.
//
// A repository switched off in the row menu shows nothing on its rows and
// its agents are not told; it is still read for the user's own CI alert
// when that is on, as before the watcher existed.
//
// A pull request whose checks had already failed before the watcher started
// (Codara was closed, or the setting off) is not news, so it stays quiet;
// every later failure of a new head commit, or of a re-run that went back to
// running first, is. That includes a pull request the watcher first sees
// already failing, when GitHub says the check failed after the watcher
// started: one opened in the browser after the push the watcher saw is first
// read up to 15 minutes later, and its checks have usually finished by then.

import { latestCheckContexts } from "@shared/git-fix";
import {
  normalizeRepository,
  PULL_REQUEST_WATCH_CHANGED_CHANNEL,
  type PullRequestChecks,
  type PullRequestWatchEntry,
  type PullRequestWatchPhase,
} from "@shared/pull-request-watch";
import { isRemotePath } from "@shared/remote";
import type { AppState, Workspace } from "@shared/types";
import type { CiAgentNudger, CiAgentPane, CiFailure } from "./ci-agent-nudge";

export const CI_WATCH_FIRST_DELAY_MS = 45_000;
export const CI_WATCH_TICK_MS = 60_000;
// Nobody at the computer: a failure can wait a few minutes, so the watcher
// looks every five instead of every one (a git call per workspace each time).
export const CI_WATCH_IDLE_TICK_MS = 5 * 60_000;
export const CI_WATCH_IDLE_AFTER_MS = 10 * 60_000;
export const CI_WATCH_OPEN_REQUERY_MS = 60_000;
export const CI_WATCH_SETTLED_REQUERY_MS = 15 * 60_000;
export const CI_WATCH_ERROR_BACKOFF_MS = 10 * 60_000;
export const CI_WATCH_MAX_WORKSPACES = 24;
const NOTIFIED_HEADS_CAP = 20;

export interface CiPullRequestSnapshot {
  /** owner/name, from the pull request's link. */
  repository: string;
  number: number;
  url: string;
  title: string;
  phase: PullRequestWatchPhase;
  headOid: string;
  /** Names of the failing checks. */
  failed: string[];
  /** When the last of the failing checks finished, by GitHub's clock; 0 when unknown. */
  failedAt?: number;
  /** Checks still queued or running. */
  pending: number;
  /** Checks that passed (or were skipped or neutral). */
  passed: number;
}

/** A workspace's branch as git knows it: what moves when you commit or push, and where its pull request lives. */
export interface CiLocalRefs {
  /** HEAD and upstream commits, as one key. */
  key: string;
  /** The GitHub host, "github.com" unless it is Enterprise. */
  host: string;
  /** owner/name of the upstream remote, lowercase. */
  repository: string;
  /** The upstream branch's name on that remote. */
  branch: string;
}

export interface CiNotifyInput {
  kind: "git.ci-failed" | "git.ci-passed";
  sourceKey: string;
  title: string;
  body: string;
  tone: "danger" | "success";
  soundKind: "needs-you" | "done";
  silent?: boolean;
  target: { type: "workspace"; workspaceId: string; panel: "git" };
}

export interface GitHubCiWatchDeps {
  loadState(): Promise<AppState>;
  /** Whether the watcher runs at all: rows and agents, or the user's CI alerts. */
  enabled(): boolean;
  /** "Notify me when CI fails on my pull request"; absent means on. */
  alertsEnabled?(): boolean;
  /** "Watch pull requests": rows, agents and the green note; absent means on. */
  watchEnabled?(): boolean;
  /** The per-repository switch (rows and agents), by the remote's owner/name; absent means every repository is watched. */
  repositoryWatched?(repository: string): boolean;
  pathExists(path: string): Promise<boolean>;
  /** The branch's refs and remote, or null when it cannot have a pull request (detached, no upstream, the default branch, not GitHub). */
  localRefs(cwd: string): Promise<CiLocalRefs | null>;
  /** The branch's newest pull request, null when there is none (or no gh). Throws when GitHub cannot be read. */
  readPullRequest(cwd: string, refs: CiLocalRefs): Promise<CiPullRequestSnapshot | null>;
  publish(input: CiNotifyInput): void;
  rearm(sourceKey: string): void;
  /** A workspace's row changed; null when it has nothing to show. */
  onEntry?(workspaceId: string, entry: PullRequestWatchEntry | null): void;
  nudger?: Pick<CiAgentNudger, "failing" | "settled">;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(message: string): void;
  /** How long the user has not touched the computer; absent means always present. */
  idleMs?(): number;
  /** Shorter waits for end-to-end runs; production uses the constants above. */
  intervals?: Partial<CiWatchIntervals>;
}

export interface CiWatchIntervals {
  first: number;
  tick: number;
  idleTick: number;
  open: number;
  settled: number;
  error: number;
}

interface WorkspaceTrack {
  refs: string;
  queriedAt: number;
  /** How long until the next read when nothing moves locally. */
  interval: number;
  /** What the last read said, to tell a change from a quiet minute. */
  fingerprint: string;
  retryAt: number;
  /** The repository's switch at that read: turning it back on reads at once. */
  on: boolean;
}

interface PullRequestTrack {
  firstHead: string;
  firstFailed: boolean;
  notified: string[];
  /** The checks as last seen, for the green note; null before the first look. */
  checks: PullRequestChecks | null;
  checksHead: string;
}

export function checksOf(pr: Pick<CiPullRequestSnapshot, "failed" | "pending" | "passed">): PullRequestChecks {
  if (pr.failed.length) return "failing";
  if (pr.pending) return "pending";
  return pr.passed ? "passing" : "none";
}

export function formatCiFailure(pr: CiPullRequestSnapshot): { title: string; body: string } {
  const shown = pr.failed.slice(0, 3).join(", ");
  const more = pr.failed.length > 3 ? ` and ${pr.failed.length - 3} more` : "";
  return {
    title: `CI failed on pull request #${pr.number}`,
    body: `${shown}${more} · ${shortTitle(pr.title)}`,
  };
}

function shortTitle(title: string): string {
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function fingerprintOf(pr: CiPullRequestSnapshot | null): string {
  if (!pr) return "none";
  return [pr.number, pr.phase, pr.headOid, pr.pending, pr.passed, pr.failed.join("\u0000")].join("\u0001");
}

function sameEntry(a: PullRequestWatchEntry | null | undefined, b: PullRequestWatchEntry | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b);
}

export interface GitHubCiWatch {
  start(): void;
  stop(): void;
  /** Runs a pass soon (after a push, on resume, a setting changed). */
  nudge(): void;
  /** One pass now; tests drive the watcher with it. */
  runPass(): Promise<void>;
  /** What each workspace's row shows now. */
  entries(): PullRequestWatchEntry[];
}

export function createGitHubCiWatch(deps: GitHubCiWatchDeps): GitHubCiWatch {
  const workspaces = new Map<string, WorkspaceTrack>();
  const pullRequests = new Map<string, PullRequestTrack>();
  const shown = new Map<string, PullRequestWatchEntry>();
  let started = false;
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  // Since when failures are news: the start, or turning the setting back on.
  let since = 0;

  const alerts = () => deps.alertsEnabled?.() !== false;
  const watching = () => deps.watchEnabled?.() !== false;
  const wait: CiWatchIntervals = {
    first: CI_WATCH_FIRST_DELAY_MS,
    tick: CI_WATCH_TICK_MS,
    idleTick: CI_WATCH_IDLE_TICK_MS,
    open: CI_WATCH_OPEN_REQUERY_MS,
    settled: CI_WATCH_SETTLED_REQUERY_MS,
    error: CI_WATCH_ERROR_BACKOFF_MS,
    ...deps.intervals,
  };

  // Rows show nothing while "Watch pull requests" is off, even when the
  // watcher runs for the user's CI alerts.
  function show(workspaceIds: readonly string[], make: ((workspaceId: string) => PullRequestWatchEntry) | null): void {
    for (const workspaceId of workspaceIds) {
      const next = make && watching() ? make(workspaceId) : null;
      if (sameEntry(shown.get(workspaceId), next)) continue;
      if (next) shown.set(workspaceId, next);
      else shown.delete(workspaceId);
      deps.onEntry?.(workspaceId, next);
    }
  }

  function observe(workspace: Workspace, pr: CiPullRequestSnapshot, branch: string, repositoryOn: boolean): void {
    const key = `${pr.repository.toLowerCase()}#${pr.number}`;
    let track = pullRequests.get(key);
    if (!track) {
      // Failed before the watcher could have told you: quiet. Without a time
      // from GitHub the failure counts as old.
      const failedEarlier = pr.failed.length > 0 && !(pr.failedAt && pr.failedAt >= since);
      track = { firstHead: pr.headOid, firstFailed: failedEarlier, notified: [], checks: null, checksHead: pr.headOid };
      pullRequests.set(key, track);
    }
    const checks = checksOf(pr);
    const before = track.checks;
    const sameHead = track.checksHead === pr.headOid;
    track.checks = checks;
    track.checksHead = pr.headOid;
    const sourceKey = `github-ci:${key}`;
    if (!pr.failed.length) {
      // Running or green again (a re-run): its next failure is news.
      track.notified = track.notified.filter((head) => head !== pr.headOid);
      if (pr.headOid === track.firstHead) track.firstFailed = false;
      deps.nudger?.settled(pr.repository, pr.number);
      // Green after the watcher saw it fail or run, never on a first look.
      if (checks === "passing" && before !== null && (before !== "passing" || !sameHead) && watching() && repositoryOn) {
        deps.rearm(sourceKey);
        deps.publish({
          kind: "git.ci-passed",
          sourceKey,
          title: `Checks passed on pull request #${pr.number}`,
          body: shortTitle(pr.title),
          tone: "success",
          soundKind: "done",
          silent: true,
          target: { type: "workspace", workspaceId: workspace.id, panel: "git" },
        });
      }
      return;
    }
    if (pr.headOid === track.firstHead && track.firstFailed) return;
    // Every pass while it fails: the nudger tells an agent once per commit,
    // and one that opens after the failure still hears about it.
    if (watching() && repositoryOn) {
      const failure: CiFailure = { repository: pr.repository, number: pr.number, headOid: pr.headOid, failed: pr.failed, branch };
      deps.nudger?.failing(workspace, failure);
    }
    if (track.notified.includes(pr.headOid)) return;
    track.notified.push(pr.headOid);
    if (track.notified.length > NOTIFIED_HEADS_CAP) track.notified.shift();
    if (!alerts()) return;
    const { title, body } = formatCiFailure(pr);
    // A new head failing is a new event for the same source.
    deps.rearm(sourceKey);
    deps.publish({
      kind: "git.ci-failed",
      sourceKey,
      title,
      body,
      tone: "danger",
      soundKind: "needs-you",
      target: { type: "workspace", workspaceId: workspace.id, panel: "git" },
    });
  }

  function forgetAll(): void {
    workspaces.clear();
    pullRequests.clear();
    since = 0;
    show([...shown.keys()], null);
  }

  async function pass(): Promise<void> {
    if (!deps.enabled()) {
      forgetAll();
      return;
    }
    if (!since) since = deps.now();
    const state = await deps.loadState();
    const byCwd = new Map<string, Workspace[]>();
    const local = state.workspaces.filter((workspace) => !isRemotePath(workspace.cwd)).slice(0, CI_WATCH_MAX_WORKSPACES);
    for (const workspace of local) {
      const same = byCwd.get(workspace.cwd);
      if (same) same.push(workspace);
      else byCwd.set(workspace.cwd, [workspace]);
    }
    const rows = new Set<string>();
    for (const [cwd, group] of byCwd) {
      const ids = group.map((workspace) => workspace.id);
      for (const id of ids) rows.add(id);
      if (!(await deps.pathExists(cwd))) {
        workspaces.delete(cwd);
        show(ids, null);
        continue;
      }
      const refs = await deps.localRefs(cwd).catch(() => null);
      if (!refs) {
        workspaces.delete(cwd);
        show(ids, null);
        continue;
      }
      const repositoryOn = deps.repositoryWatched?.(refs.repository) !== false;
      const switchedOff = (workspaceId: string): PullRequestWatchEntry => ({ workspaceId, repository: refs.repository, watching: false });
      if (!repositoryOn && !alerts()) {
        workspaces.delete(cwd);
        show(ids, switchedOff);
        continue;
      }
      const now = deps.now();
      const track = workspaces.get(cwd);
      // New refs are asked about at once; otherwise after an error's backoff,
      // or when the pull request is due another look.
      const moved = !track || track.refs !== refs.key || track.on !== repositoryOn;
      const due = moved || (track.retryAt ? now >= track.retryAt : now - track.queriedAt >= track.interval);
      if (!due) continue;
      let pr: CiPullRequestSnapshot | null;
      try {
        pr = await deps.readPullRequest(cwd, refs);
      } catch (cause) {
        // Once per streak of errors, not every retry.
        if (!track?.retryAt) {
          deps.log(`could not read the pull request of ${group[0].name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        workspaces.set(cwd, {
          refs: refs.key,
          queriedAt: now,
          interval: wait.open,
          fingerprint: track?.fingerprint ?? "",
          retryAt: now + wait.error,
          on: repositoryOn,
        });
        continue;
      }
      const fingerprint = fingerprintOf(pr);
      const open = pr !== null && (pr.phase === "open" || pr.phase === "draft");
      let interval = wait.settled;
      if (open && pr!.pending > 0) interval = wait.open;
      else if (open) {
        // Nothing new since the last look: wait twice as long, up to the settled interval.
        const quiet = !moved && track!.fingerprint === fingerprint && !track!.retryAt;
        interval = quiet ? Math.min(track!.interval * 2, wait.settled) : wait.open;
      }
      workspaces.set(cwd, { refs: refs.key, queriedAt: now, interval, fingerprint, retryAt: 0, on: repositoryOn });
      if (!pr) {
        show(ids, repositoryOn ? null : switchedOff);
        continue;
      }
      if (open) observe(group[0], pr, refs.branch, repositoryOn);
      else deps.nudger?.settled(pr.repository, pr.number);
      if (!repositoryOn) {
        show(ids, switchedOff);
        continue;
      }
      // The row's repository is the remote's, which is what the switch is
      // keyed on; a fork's pull request or a renamed repository can differ.
      show(ids, (workspaceId) => ({
        workspaceId,
        repository: refs.repository,
        watching: true,
        pullRequest: {
          workspaceId,
          repository: pr!.repository.toLowerCase(),
          number: pr!.number,
          url: pr!.url,
          title: pr!.title,
          phase: pr!.phase,
          checks: open ? checksOf(pr!) : "none",
          failed: open ? pr!.failed : [],
          headOid: pr!.headOid,
        },
      }));
    }
    for (const cwd of [...workspaces.keys()]) if (!byCwd.has(cwd)) workspaces.delete(cwd);
    show([...shown.keys()].filter((id) => !rows.has(id)), null);
  }

  function schedule(ms: number): void {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    if (!started) return;
    timer = deps.setTimeout(() => {
      timer = null;
      void runPass().finally(() =>
        schedule((deps.idleMs?.() ?? 0) >= CI_WATCH_IDLE_AFTER_MS ? wait.idleTick : wait.tick),
      );
    }, ms);
  }

  function runPass(): Promise<void> {
    if (!running) {
      running = pass()
        .catch((cause) => deps.log(`pass failed: ${cause instanceof Error ? cause.message : String(cause)}`))
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  return {
    start() {
      if (started) return;
      started = true;
      if (!since) since = deps.now();
      schedule(wait.first);
    },
    stop() {
      started = false;
      schedule(0);
    },
    nudge() {
      if (started) schedule(5_000);
    },
    runPass,
    entries: () => [...shown.values()],
  };
}

// ── Reading a pull request from GitHub's REST API ───────────────────────────

const SUCCESS_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

// GitHub writes 0001-01-01T00:00:00Z for a time it does not have.
function githubTime(value: unknown): number {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) && at > 0 ? at : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The branch's pull request in `GET /repos/{repo}/pulls?head=…&state=all`
 * (newest first), in the snapshot's terms: the newest open one, else the
 * newest; null when there is none or it is malformed. Checks come from
 * summarizeRestChecks.
 */
export function parseRestPullRequest(pulls: unknown): Omit<CiPullRequestSnapshot, "failed" | "failedAt" | "pending" | "passed"> | null {
  if (!Array.isArray(pulls)) return null;
  const pull = record(pulls.find((item) => record(item)?.state === "open") ?? pulls[0]);
  if (!pull) return null;
  const url = text(pull.html_url);
  const match = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  const headOid = text(record(pull.head)?.sha);
  const number = pull.number;
  if (!Number.isSafeInteger(number) || !match || !/^[a-f0-9]{40,64}$/i.test(headOid)) return null;
  const phase: PullRequestWatchPhase = pull.merged_at
    ? "merged"
    : pull.state === "closed"
      ? "closed"
      : pull.draft === true
        ? "draft"
        : "open";
  return {
    repository: match[1],
    number: Number(number),
    url,
    title: text(pull.title).replace(/\s+/g, " ").trim(),
    phase,
    headOid,
  };
}

/**
 * The checks of a commit from `GET …/commits/{sha}/check-runs` and
 * `GET …/commits/{sha}/status`: what fails, what still runs, what passed.
 * Each check is judged by its newest run, as Source Control does.
 */
export function summarizeRestChecks(
  checkRuns: unknown,
  status: unknown,
): Pick<CiPullRequestSnapshot, "failed" | "failedAt" | "pending" | "passed"> {
  const contexts: Record<string, unknown>[] = [];
  const runs = record(checkRuns)?.check_runs;
  for (const raw of Array.isArray(runs) ? runs : []) {
    const run = record(raw);
    if (!run) continue;
    const completed = text(run.status).toLowerCase() === "completed";
    // REST runs carry no workflow name; the suite stands for it, so a job
    // named like one in another workflow keeps its own result.
    const suite = record(run.check_suite)?.id;
    contexts.push({
      __typename: "CheckRun",
      workflowName: suite === undefined || suite === null ? "" : String(suite),
      name: text(run.name),
      status: text(run.status).toUpperCase(),
      conclusion: completed ? text(run.conclusion).toUpperCase() : "",
      startedAt: run.started_at,
      completedAt: run.completed_at,
    });
  }
  const statuses = record(status)?.statuses;
  for (const raw of Array.isArray(statuses) ? statuses : []) {
    const item = record(raw);
    if (!item) continue;
    contexts.push({ __typename: "StatusContext", context: text(item.context), state: text(item.state).toUpperCase(), startedAt: item.updated_at });
  }
  const failed: string[] = [];
  let failedAt = 0;
  let pending = 0;
  let passed = 0;
  for (const check of latestCheckContexts(contexts)) {
    const signal = [check.conclusion, check.state, check.status].find((part) => typeof part === "string" && part) as string | undefined;
    const name = String(check.name || check.context || "check").replace(/\s+/g, " ").slice(0, 80);
    const upper = signal?.toUpperCase();
    if (upper && FAILED_STATES.has(upper)) {
      failed.push(name);
      failedAt = Math.max(failedAt, githubTime(check.completedAt) || githubTime(check.startedAt));
    } else if (upper && SUCCESS_STATES.has(upper)) passed += 1;
    else pending += 1;
  }
  return { failed, failedAt, pending, passed };
}

/** owner/name, host and whether it goes over ssh, for any remote URL (https, ssh, scp-like); null for a local path. */
export function parseRemoteUrl(url: string): { host: string; repository: string; ssh: boolean } | null {
  const trimmed = url.trim();
  const web = /^(https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/)([^/:]+)(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  const scp = web ? null : /^(?:[^@/:]+@)?([^/:]+):([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  const host = (web ? web[2] : scp?.[1])?.toLowerCase();
  const repository = normalizeRepository(web ? web[3] : scp?.[2]);
  if (!host || !repository) return null;
  return { host, repository, ssh: !!scp || !!web?.[1].startsWith("ssh:") };
}

/** owner/name and host of a GitHub remote URL; null for anything else. */
export function parseGitHubRemoteUrl(url: string): { host: string; repository: string } | null {
  const remote = parseRemoteUrl(url);
  // Enterprise hosts are allowed when they say GitHub; gh knows which ones the user signed in to.
  if (!remote || (remote.host !== "github.com" && !remote.host.includes("github"))) return null;
  return { host: remote.host, repository: remote.repository };
}

/**
 * The GitHub host gh should be asked for a remote's host, or null when it is
 * not GitHub. An ssh remote's host may be an alias from ~/.ssh/config
 * ("github.com-work"), so the caller resolves it first; GitHub's own ssh
 * endpoints mean github.com; an Enterprise host counts when gh is signed in
 * to it or its name says GitHub.
 */
export function githubHostFor(resolved: string, signedIn: ReadonlySet<string>): string | null {
  const host = resolved.toLowerCase();
  if (host === "github.com" || host === "ssh.github.com" || host === "www.github.com") return "github.com";
  if (signedIn.has(host) || host.includes("github")) return host;
  return null;
}

/** The hosts in gh's hosts.yml (its top-level keys). */
export function parseGhHostsYaml(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9.-]+):\s*$/.exec(line);
    if (match) hosts.add(match[1].toLowerCase());
  }
  return hosts;
}

export interface CiRemoteHostResolver {
  /** The real host behind an ssh host alias (`ssh -G`), or the alias itself. */
  sshHost(alias: string): Promise<string>;
  /** Hosts gh is signed in to. */
  signedIn(): Promise<ReadonlySet<string>>;
}

/**
 * GitHubCiWatchDeps.localRefs on plain git: one `git rev-parse` a minute per
 * workspace for HEAD, its upstream and the upstream's name. Which branch the
 * remote calls its default and where the remote points rarely change, so
 * those answers are kept for the settled requery interval. Without a host
 * resolver only hosts that say GitHub count.
 */
export function createCiLocalRefsReader(
  read: (cwd: string, args: string[]) => Promise<string>,
  now: () => number,
  hosts?: CiRemoteHostResolver,
): (cwd: string) => Promise<CiLocalRefs | null> {
  const remotes = new Map<string, { defaultBranch: string; github: { host: string; repository: string } | null; at: number }>();
  const githubOf = async (url: string): Promise<{ host: string; repository: string } | null> => {
    if (!hosts) return parseGitHubRemoteUrl(url);
    const remote = parseRemoteUrl(url);
    if (!remote) return null;
    const resolved = remote.ssh && remote.host !== "github.com" ? await hosts.sshHost(remote.host).catch(() => remote.host) : remote.host;
    const host = githubHostFor(resolved, await hosts.signedIn().catch(() => new Set<string>()));
    return host ? { host, repository: remote.repository } : null;
  };
  return async (cwd) => {
    const lines = (await read(cwd, ["rev-parse", "HEAD", "@{upstream}", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]))
      .split(/\r?\n/)
      .map((line) => line.trim());
    if (lines.length !== 3) return null;
    const [head, upstreamOid, upstream] = lines;
    if (!head || !upstreamOid || !upstream.includes("/")) return null;
    const remote = upstream.slice(0, upstream.indexOf("/"));
    const key = `${cwd}\u0000${remote}`;
    let known = remotes.get(key);
    if (!known || now() - known.at >= CI_WATCH_SETTLED_REQUERY_MS) {
      const defaultBranch = await read(cwd, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
      const url = await read(cwd, ["config", "--get", `remote.${remote}.url`]);
      known = { defaultBranch, github: await githubOf(url), at: now() };
      remotes.set(key, known);
    }
    if (known.defaultBranch && known.defaultBranch === upstream) return null;
    if (!known.github) return null;
    return { key: `${head} ${upstreamOid}`, host: known.github.host, repository: known.github.repository, branch: upstream.slice(remote.length + 1) };
  };
}

// ── Production wiring ───────────────────────────────────────────────────────

let live: GitHubCiWatch | null = null;
let liveStop: (() => void) | null = null;

// Only under the e2e harness: a stray variable in a user's shell must not
// turn every backoff into a second.
function e2eTickMs(background: boolean): number | null {
  if (!background) return null;
  const value = Number(process.env.SPARK_E2E_PR_WATCH_TICK_MS);
  return Number.isFinite(value) && value >= 500 ? value : null;
}

const CHECK_RUNS_JQ =
  "{check_runs: [.check_runs[] | {name, status, conclusion, started_at, completed_at, check_suite: {id: .check_suite.id}}]}";

function ghConfigDir(home: string): string {
  if (process.env.GH_CONFIG_DIR) return process.env.GH_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return `${process.env.APPDATA}\\GitHub CLI`;
  return `${process.env.XDG_CONFIG_HOME || `${home}/.config`}/gh`;
}

async function productionDeps(): Promise<{ deps: GitHubCiWatchDeps; stop: () => void }> {
  const [
    { powerMonitor, webContents },
    { access, readFile },
    { execFile },
    { homedir },
    { E2E_BACKGROUND },
    { runGit },
    { resolveBinary },
    github,
    conditional,
    notify,
    prefs,
    storage,
    pty,
    agents,
    nudge,
  ] = await Promise.all([
    import("electron"),
    import("node:fs/promises"),
    import("node:child_process"),
    import("node:os"),
    import("./e2e-background"),
    import("./git-exec"),
    import("./binary-resolver"),
    import("./github-cli"),
    import("./github-conditional"),
    import("./notify"),
    import("./preferences-store"),
    import("./storage"),
    import("./pty-manager"),
    import("./terminal-agent-notify"),
    import("./ci-agent-nudge"),
  ]);
  const read = async (cwd: string, args: string[]): Promise<string> => {
    try {
      return (await runGit(cwd, args, { internal: true })).stdout.trim();
    } catch {
      return "";
    }
  };
  const readers = new Map<string, ReturnType<typeof conditional.createConditionalGitHubReader>>();
  const readerFor = (executablePath: string, host: string) => {
    let reader = readers.get(host);
    if (!reader) {
      reader = conditional.createConditionalGitHubReader((args) =>
        github.runGitHubCliCommand({
          executablePath,
          args: host === "github.com" ? args : [...args.slice(0, 1), "--hostname", host, ...args.slice(1)],
          timeoutMs: github.GITHUB_CLI_READ_TIMEOUT_MS,
          maxOutputBytes: github.GITHUB_CLI_MAX_OUTPUT_BYTES,
        }),
      );
      readers.set(host, reader);
    }
    return reader;
  };
  const inside = (root: string, path: string | null): boolean =>
    !!path && (path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`));
  // Every local workspace folder as of the last pass: a terminal inside a
  // folder nested in this one (a worktree under .claude/worktrees) belongs
  // to that nested workspace's branch, not this one.
  let roots: string[] = [];
  const runtimes = new Map<string, string>();
  const nudger = nudge.createCiAgentNudger({
    panesFor(workspace) {
      const agentPanes = agents.terminalAgentStateSnapshot().filter((entry) => entry.runtime && pty.hasSession(entry.paneId));
      const creator = workspace.copyBranch?.createdBy?.paneId;
      const nested = roots.filter((root) => root !== workspace.cwd && inside(workspace.cwd, root));
      const inFolder = (paneId: string): boolean => {
        const cwd = pty.sessionCwd(paneId);
        return inside(workspace.cwd, cwd) && !nested.some((root) => inside(root, cwd));
      };
      const rankOf = (entry: (typeof agentPanes)[number]): number | null => {
        if (entry.paneId === creator) return 0;
        if (entry.workspaceId === workspace.id) return 1;
        return inFolder(entry.paneId) ? 2 : null;
      };
      runtimes.clear();
      const panes: CiAgentPane[] = [];
      for (const entry of agentPanes) {
        const rank = rankOf(entry);
        if (rank === null) continue;
        runtimes.set(entry.paneId, String(entry.runtime));
        panes.push({ paneId: entry.paneId, state: entry.state, rank, lastInputAt: pty.hibernationSessionInfo(entry.paneId)?.lastInputAt ?? 0 });
      }
      return panes;
    },
    type(paneId, line) {
      if (!pty.hasSession(paneId)) return false;
      // Claude parks a draft older than the quiet window (Ctrl+S) and brings
      // it back after the line is sent, so the two are never submitted together.
      pty.inject(paneId, line, { submit: true, stashDraft: runtimes.get(paneId) === "claude" });
      // A submitted line starts the agent's turn, as the user's Enter would.
      agents.noteTerminalUserInput(paneId);
      return true;
    },
    now: Date.now,
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    log: (message) => console.warn(`[github-ci-watch] ${message}`),
  });
  const watchEnabled = () => prefs.getPreferenceCached("watchPullRequests") !== false;
  const alertsEnabled = () => prefs.getPreferenceCached("notifyCiFailures") !== false;
  const offRepositories = () => new Set(prefs.getPreferenceCached("pullRequestWatchOffRepos") ?? []);
  const unsubscribe = prefs.onPreferenceChange((key) => {
    if (key === "watchPullRequests" || key === "notifyCiFailures" || key === "pullRequestWatchOffRepos") live?.nudge();
  });
  const run = (file: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) =>
      execFile(file, args, { timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) =>
        error ? reject(error) : resolve(String(stdout)),
      ),
    );
  let signedIn: { hosts: Set<string>; at: number } | null = null;
  const hosts: CiRemoteHostResolver = {
    async sshHost(alias) {
      const config = await run("ssh", ["-G", "--", alias]);
      return /^hostname\s+(\S+)/m.exec(config)?.[1] ?? alias;
    },
    async signedIn() {
      if (!signedIn || Date.now() - signedIn.at >= CI_WATCH_SETTLED_REQUERY_MS) {
        const text = await readFile(`${ghConfigDir(homedir())}/hosts.yml`, "utf8").catch(() => "");
        signedIn = { hosts: parseGhHostsYaml(text), at: Date.now() };
      }
      return signedIn.hosts;
    },
  };
  const deps: GitHubCiWatchDeps = {
    async loadState() {
      const state = await storage.loadState();
      roots = state.workspaces.filter((workspace) => !isRemotePath(workspace.cwd)).map((workspace) => workspace.cwd);
      return state;
    },
    enabled: () => watchEnabled() || alertsEnabled(),
    alertsEnabled,
    watchEnabled,
    repositoryWatched: (repository) => !offRepositories().has(repository.toLowerCase()),
    pathExists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    localRefs: createCiLocalRefsReader(read, Date.now, hosts),
    async readPullRequest(_cwd, refs) {
      // Without gh there is nothing to watch; asked again in 15 minutes.
      const executablePath = await resolveBinary("gh");
      if (!executablePath) return null;
      const reader = readerFor(executablePath, refs.host);
      const [owner] = refs.repository.split("/");
      const pullsIn = (repository: string) =>
        reader.get(`repos/${repository}/pulls?head=${encodeURIComponent(`${owner}:${refs.branch}`)}&state=all&per_page=5`);
      try {
        let pull = parseRestPullRequest((await pullsIn(refs.repository)).value);
        if (!pull) {
          // A branch pushed to the user's fork has its pull request on the parent.
          const repo = record((await reader.get(`repos/${refs.repository}`, { jq: "{fork, parent: .parent.full_name}" })).value);
          const parent = repo?.fork === true ? normalizeRepository(repo.parent) : null;
          if (parent) pull = parseRestPullRequest((await pullsIn(parent)).value);
        }
        if (!pull) return null;
        if (pull.phase === "merged" || pull.phase === "closed") return { ...pull, failed: [], failedAt: 0, pending: 0, passed: 0 };
        // Checks live on the repository the pull request is in.
        const base = `repos/${pull.repository}`;
        const [runs, status] = await Promise.all([
          reader.get(`${base}/commits/${pull.headOid}/check-runs?per_page=100`, { jq: CHECK_RUNS_JQ }),
          reader.get(`${base}/commits/${pull.headOid}/status?per_page=100`),
        ]);
        return { ...pull, ...summarizeRestChecks(runs.value, status.value) };
      } catch (cause) {
        throw new Error(github.sanitizeGitHubFailure(cause, "gh failed"));
      }
    },
    publish: (input) => notify.publish(input),
    rearm: notify.rearm,
    onEntry(workspaceId, entry) {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue;
        try {
          contents.send(PULL_REQUEST_WATCH_CHANGED_CHANNEL, { workspaceId, entry });
        } catch {
          // A renderer may close between enumeration and send.
        }
      }
    },
    nudger,
    now: Date.now,
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    log: (message) => console.warn(`[github-ci-watch] ${message}`),
    idleMs: () => {
      try {
        return powerMonitor.getSystemIdleTime() * 1000;
      } catch {
        return 0;
      }
    },
  };
  const tick = e2eTickMs(E2E_BACKGROUND);
  // End-to-end runs ask every tick: nothing waits minutes for a requery.
  if (tick) deps.intervals = { first: tick, tick, idleTick: tick, open: tick, settled: tick, error: tick };
  return {
    deps,
    stop: () => {
      unsubscribe();
      nudger.stop();
    },
  };
}

export async function startGitHubCiWatch(): Promise<void> {
  if (live) return;
  const { deps, stop } = await productionDeps();
  live = createGitHubCiWatch(deps);
  liveStop = stop;
  live.start();
}

export function nudgeGitHubCiWatch(): void {
  live?.nudge();
}

export function stopGitHubCiWatch(): void {
  live?.stop();
  liveStop?.();
  live = null;
  liveStop = null;
}

/** What each workspace's row shows, for a renderer that just loaded. */
export function pullRequestWatchEntries(): PullRequestWatchEntry[] {
  return live?.entries() ?? [];
}
