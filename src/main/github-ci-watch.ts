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
// while its checks run (for ten minutes of no change, then like the rest),
// and otherwise after 1, 2, 4, 8 and then every 15 minutes while nothing
// changes; a commit or a push asks at once and starts over at one minute.
// A push or fetch that moves the branch's upstream is seen through a watch
// on that one ref's folder and asks within a second, not at the next tick. A branch with no pull request, or a merged or closed
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
import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { AppState, Workspace } from "@shared/types";
import type { CiAgentNudger, CiAgentPane, CiFailure } from "./ci-agent-nudge";

// Repositories whose pull requests are read at the same time in one pass.
export const CI_WATCH_REPOSITORIES_AT_ONCE = 3;
export const CI_WATCH_FIRST_DELAY_MS = 45_000;
export const CI_WATCH_TICK_MS = 60_000;
// Nobody at the computer: a failure can wait a few minutes, so the watcher
// looks every five instead of every one (a git call per workspace each time).
export const CI_WATCH_IDLE_TICK_MS = 5 * 60_000;
export const CI_WATCH_IDLE_AFTER_MS = 10 * 60_000;
export const CI_WATCH_OPEN_REQUERY_MS = 60_000;
export const CI_WATCH_SETTLED_REQUERY_MS = 15 * 60_000;
export const CI_WATCH_ERROR_BACKOFF_MS = 10 * 60_000;
// Checks queued forever (a runner that never comes) would otherwise cost a
// read a minute for as long as the pull request is open.
export const CI_WATCH_PENDING_GRACE_MS = 10 * 60_000;
export const CI_WATCH_REFS_CHANGED_DELAY_MS = 1_000;
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
  soundKind: "failed" | "done";
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
  /**
   * The pull requests of several branches of one repository, read together,
   * by cwd: what readPullRequest answers, or an Error. A cwd left out reads
   * as an error. Absent: readPullRequest for each. `answer`, when given,
   * hears each row as soon as it is read, before the read is over.
   */
  readPullRequests?(
    items: ReadonlyArray<{ cwd: string; refs: CiLocalRefs }>,
    answer?: (cwd: string, pr: CiPullRequestSnapshot | null | Error) => void,
  ): Promise<Map<string, CiPullRequestSnapshot | null | Error>>;
  publish(input: CiNotifyInput): void;
  rearm(sourceKey: string): void;
  /** A workspace's row changed; null when it has nothing to show. */
  onEntry?(workspaceId: string, entry: PullRequestWatchEntry | null): void;
  nudger?: Pick<CiAgentNudger, "failing" | "settled" | "retain">;
  /**
   * Watches what moves when the workspace's branch is pushed or fetched (its
   * upstream ref); returns the unwatch. Absent means the minute tick finds it.
   */
  watchRefs?(cwd: string, refs: CiLocalRefs, onChange: () => void): () => void;
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
  /** The remote's owner/name, which the switch is keyed on. */
  repository: string;
  /** When the last read saw something new. */
  changedAt: number;
  /** The pull request ("owner/name#N") whose failure an agent may be waiting to hear about. */
  nudging: { repository: string; number: number } | null;
}

/** A row whose pull request is to be read this pass. */
interface DueRead {
  cwd: string;
  group: Workspace[];
  ids: string[];
  refs: CiLocalRefs;
  repositoryOn: boolean;
  now: number;
  track: WorkspaceTrack | undefined;
  moved: boolean;
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
  nudge(delayMs?: number): void;
  /** One pass now; tests drive the watcher with it. */
  runPass(): Promise<void>;
  /**
   * Withdraws at once the waiting lines the current settings no longer
   * allow, before the pass a setting change starts has read anything.
   */
  recheck(): void;
  /** What each workspace's row shows now. */
  entries(): PullRequestWatchEntry[];
}

export function createGitHubCiWatch(deps: GitHubCiWatchDeps): GitHubCiWatch {
  const workspaces = new Map<string, WorkspaceTrack>();
  const pullRequests = new Map<string, PullRequestTrack>();
  const shown = new Map<string, PullRequestWatchEntry>();
  let started = false;
  let timer: unknown = null;
  let dueAt = 0;
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

  /** True when an agent is (still) to be told about this failure. */
  function observe(workspace: Workspace, pr: CiPullRequestSnapshot, branch: string, repositoryOn: boolean): boolean {
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
      return false;
    }
    if (pr.headOid === track.firstHead && track.firstFailed) return false;
    // Every pass while it fails: the nudger tells an agent once per commit,
    // and one that opens after the failure still hears about it.
    const nudging = watching() && repositoryOn;
    if (nudging) {
      const failure: CiFailure = { repository: pr.repository, number: pr.number, headOid: pr.headOid, failed: pr.failed, branch };
      deps.nudger?.failing(workspace, failure);
    }
    if (track.notified.includes(pr.headOid)) return nudging;
    track.notified.push(pr.headOid);
    if (track.notified.length > NOTIFIED_HEADS_CAP) track.notified.shift();
    if (!alerts()) return nudging;
    const { title, body } = formatCiFailure(pr);
    // A new head failing is a new event for the same source.
    deps.rearm(sourceKey);
    deps.publish({
      kind: "git.ci-failed",
      sourceKey,
      title,
      body,
      tone: "danger",
      soundKind: "failed",
      target: { type: "workspace", workspaceId: workspace.id, panel: "git" },
    });
    return nudging;
  }

  const refWatches = new Map<string, { key: string; close: () => void }>();

  function watchRefsOf(cwd: string, refs: CiLocalRefs): void {
    if (!deps.watchRefs) return;
    const key = `${refs.repository}\u0000${refs.branch}`;
    const current = refWatches.get(cwd);
    if (current?.key === key) return;
    current?.close();
    try {
      refWatches.set(cwd, { key, close: deps.watchRefs(cwd, refs, () => refsChanged()) });
    } catch {
      refWatches.delete(cwd);
    }
  }

  function unwatchRefs(keep: (cwd: string) => boolean): void {
    for (const [cwd, watch] of [...refWatches]) {
      if (keep(cwd)) continue;
      watch.close();
      refWatches.delete(cwd);
    }
  }

  function refsChanged(): void {
    soon(CI_WATCH_REFS_CHANGED_DELAY_MS);
  }

  // Brings the next pass forward, never back.
  function soon(ms: number): void {
    if (!started) return;
    if (timer !== null && dueAt <= deps.now() + ms) return;
    schedule(ms);
  }

  // Lines still waiting for an agent stand only while their pull request was
  // last seen watched, open and failing in a workspace that is still here.
  function retainNudges(): void {
    const on = (track: WorkspaceTrack) => track.on && deps.repositoryWatched?.(track.repository) !== false;
    const keep =
      deps.enabled() && watching() ? [...workspaces.values()].flatMap((track) => (on(track) && track.nudging ? [track.nudging] : [])) : [];
    deps.nudger?.retain(keep);
  }

  function forgetAll(): void {
    workspaces.clear();
    pullRequests.clear();
    since = 0;
    deps.nudger?.retain([]);
    unwatchRefs(() => false);
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
    // Every local row: one with no upstream costs a git call a tick and no
    // GitHub call, and the rows of one repository share their reads below.
    const local = state.workspaces.filter((workspace) => !isRemotePath(workspace.cwd));
    for (const workspace of local) {
      const same = byCwd.get(workspace.cwd);
      if (same) same.push(workspace);
      else byCwd.set(workspace.cwd, [workspace]);
    }
    const rows = new Set<string>();
    const dueReads: DueRead[] = [];
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
      watchRefsOf(cwd, refs);
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
      dueReads.push({ cwd, group, ids, refs, repositoryOn, now, track, moved });
    }
    // Each repository's rows as soon as its read is back: a passing result
    // withdraws a queued failure line without waiting on a slow repository.
    const byCwdDue = new Map(dueReads.map((due) => [due.cwd, due]));
    await readGrouped(dueReads, (cwd, pr) => {
      const due = byCwdDue.get(cwd);
      if (due) apply(due, pr);
    });
    for (const cwd of [...workspaces.keys()]) if (!byCwd.has(cwd)) workspaces.delete(cwd);
    unwatchRefs((cwd) => workspaces.has(cwd) || byCwd.has(cwd));
    retainNudges();
    show([...shown.keys()].filter((id) => !rows.has(id)), null);
  }

  function apply({ group, ids, refs, repositoryOn, now, track, moved, cwd }: DueRead, pr: CiPullRequestSnapshot | null | Error): void {
    const switchedOff = (workspaceId: string): PullRequestWatchEntry => ({ workspaceId, repository: refs.repository, watching: false });
    if (pr instanceof Error) {
      // Once per streak of errors, not every retry.
      if (!track?.retryAt) deps.log(`could not read the pull request of ${group[0].name}: ${pr.message}`);
      workspaces.set(cwd, {
        refs: refs.key,
        queriedAt: now,
        interval: wait.open,
        fingerprint: track?.fingerprint ?? "",
        retryAt: now + wait.error,
        on: repositoryOn,
        repository: refs.repository,
        changedAt: track?.changedAt ?? now,
        nudging: track?.nudging ?? null,
      });
      return;
    }
    const fingerprint = fingerprintOf(pr);
    const open = pr !== null && (pr.phase === "open" || pr.phase === "draft");
    const quiet = !moved && track!.fingerprint === fingerprint && !track!.retryAt;
    const changedAt = quiet ? track!.changedAt : now;
    let interval = wait.settled;
    if (open) {
      // Nothing new since the last look: wait twice as long, up to the
      // settled interval. Running checks are asked every minute for a while
      // first: they usually finish within minutes.
      const running = pr!.pending > 0 && now - changedAt < CI_WATCH_PENDING_GRACE_MS;
      interval = quiet && !running ? Math.min(track!.interval * 2, wait.settled) : wait.open;
    }
    const next: WorkspaceTrack = { refs: refs.key, queriedAt: now, interval, fingerprint, retryAt: 0, on: repositoryOn, repository: refs.repository, changedAt, nudging: null };
    workspaces.set(cwd, next);
    if (!pr) {
      show(ids, repositoryOn ? null : switchedOff);
      return;
    }
    if (open && observe(group[0], pr, refs.branch, repositoryOn)) next.nudging = { repository: pr.repository, number: pr.number };
    else if (!open) deps.nudger?.settled(pr.repository, pr.number);
    if (!repositoryOn) {
      show(ids, switchedOff);
      return;
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

  // One read per repository for its due rows (readPullRequests), else one per
  // row; each answer goes to `answer` as soon as its read is back. A few
  // repositories are read at once, so a slow one holds up none of the others.
  async function readGrouped(
    items: ReadonlyArray<{ cwd: string; refs: CiLocalRefs }>,
    answer: (cwd: string, pr: CiPullRequestSnapshot | null | Error) => void,
  ): Promise<void> {
    const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));
    const byRepository = new Map<string, Array<{ cwd: string; refs: CiLocalRefs }>>();
    for (const item of items) {
      const key = `${item.refs.host}\u0000${item.refs.repository}`;
      byRepository.set(key, [...(byRepository.get(key) ?? []), item]);
    }
    const batches = [...byRepository.values()];
    const readBatch = async (batch: Array<{ cwd: string; refs: CiLocalRefs }>): Promise<void> => {
      if (deps.readPullRequests) {
        const heard = new Set<string>();
        const read = await deps
          .readPullRequests(batch, (cwd, pr) => {
            if (heard.has(cwd) || !batch.some((item) => item.cwd === cwd)) return;
            heard.add(cwd);
            answer(cwd, pr);
          })
          .catch(asError);
        for (const { cwd } of batch) {
          if (heard.has(cwd)) continue;
          answer(cwd, read instanceof Error ? read : read.has(cwd) ? read.get(cwd)! : new Error("GitHub gave no answer for this branch"));
        }
        return;
      }
      for (const { cwd, refs } of batch) answer(cwd, await deps.readPullRequest(cwd, refs).catch(asError));
    };
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < batches.length) await readBatch(batches[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(CI_WATCH_REPOSITORIES_AT_ONCE, batches.length) }, worker));
  }

  function schedule(ms: number): void {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    if (!started) return;
    dueAt = deps.now() + ms;
    timer = deps.setTimeout(() => {
      timer = null;
      // soon(), not schedule(): a push or nudge during the pass already set
      // an earlier timer, which the regular tick must not push back.
      void runPass().finally(() => soon((deps.idleMs?.() ?? 0) >= CI_WATCH_IDLE_AFTER_MS ? wait.idleTick : wait.tick));
    }, ms);
  }

  // A pass asked for while one runs (a push, a setting) runs once more after
  // it: the running pass may already have read that workspace.
  let again: Promise<void> | null = null;
  function runPass(): Promise<void> {
    if (running) {
      again ??= running.then(() => {
        again = null;
        return runPass();
      });
      return again;
    }
    running = pass()
      .catch((cause) => deps.log(`pass failed: ${cause instanceof Error ? cause.message : String(cause)}`))
      .finally(() => {
        running = null;
      });
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
      unwatchRefs(() => false);
    },
    nudge(delayMs = 5_000) {
      soon(delayMs);
    },
    runPass,
    recheck: retainNudges,
    entries: () => [...shown.values()],
  };
}

// ── Reading a pull request from GitHub's REST API ───────────────────────────

const SUCCESS_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
// STALE: GitHub gave up on a required check, which still blocks the merge.
const FAILED_STATES = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
// A run cancelled (by hand, or because a newer run of it started) did not
// fail: no failure to tell anyone about, and nothing still running either.
const SETTLED_STATES = new Set(["CANCELLED"]);

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
    else if (!upper || !SETTLED_STATES.has(upper)) pending += 1;
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

/**
 * Calls onChange when the workspace's upstream ref moves (a push or fetch
 * rewrites its file in the repository's common git dir); returns the
 * unwatch. One non-recursive watch on that ref's folder, or on its nearest
 * existing folder when the ref is only in packed-refs.
 */
export function watchUpstreamRef(read: (cwd: string, args: string[]) => Promise<string>, cwd: string, onChange: () => void): () => void {
  let closed = false;
  let watcher: FSWatcher | null = null;
  const arm = async (): Promise<void> => {
    const common = await read(cwd, ["rev-parse", "--git-common-dir"]);
    const upstream = await read(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
    if (closed || !common || !upstream.startsWith("refs/remotes/")) return;
    const root = isAbsolute(common) ? common : join(cwd, common);
    const file = join(root, ...upstream.split("/"));
    const stop = join(root, "refs", "remotes");
    let dir = dirname(file);
    while (dir.length > stop.length && !existsSync(dir)) dir = dirname(dir);
    if (!existsSync(dir)) return;
    const name = dir === dirname(file) ? basename(file) : null;
    // The watched folder can go away (git pack-refs empties it): watch again
    // from its nearest folder still there.
    const rearm = (): void => {
      watcher?.close();
      watcher = null;
      if (!closed) void arm();
    };
    try {
      const opened = watch(dir, { persistent: false }, (_event, changed) => {
        if (!existsSync(dir)) {
          rearm();
          onChange();
          return;
        }
        if (!name || !changed || String(changed).startsWith(name)) onChange();
      });
      opened.on("error", rearm);
      watcher = opened;
      if (closed) opened.close();
    } catch {
      watcher = null;
    }
  };
  void arm();
  return () => {
    closed = true;
    watcher?.close();
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

export function ghConfigDir(home: string): string {
  if (process.env.GH_CONFIG_DIR) return process.env.GH_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return `${process.env.APPDATA}\\GitHub CLI`;
  return `${process.env.XDG_CONFIG_HOME || `${home}/.config`}/gh`;
}

const PULLS_PAGE = 100;
const PULLS_JQ = "[.[] | {number, state, draft, merged_at, html_url, title, head: {sha: .head.sha, label: .head.label}}]";
// The pull requests read per branch name (other forks' branches of the same
// name included), and the rows whose checks are read at the same time.
const PULLS_PER_BRANCH = 10;
const CHECK_READS_AT_ONCE = 4;

type PullRequestReader = {
  get(path: string, options?: { jq?: string }): Promise<{ value: unknown }>;
  // One GraphQL query; absent: each branch is asked about alone.
  graphql?(query: string, variables: Record<string, string>): Promise<unknown>;
};

// `owner:branch`: the owner as GitHub spells it in any case, the branch exactly.
function sameHead(label: string, owner: string, branch: string): boolean {
  const colon = label.indexOf(":");
  return colon > 0 && label.slice(0, colon).toLowerCase() === owner.toLowerCase() && label.slice(colon + 1) === branch;
}

// The branch's newest pull request, asked about alone; on the parent when the
// branch was pushed to the user's fork.
async function branchPull(reader: PullRequestReader, refs: CiLocalRefs): Promise<ReturnType<typeof parseRestPullRequest>> {
  const [owner] = refs.repository.split("/");
  const pullsIn = async (repository: string) => {
    const value = (await reader.get(`repos/${repository}/pulls?head=${encodeURIComponent(`${owner}:${refs.branch}`)}&state=all&per_page=5`)).value;
    return Array.isArray(value) ? value.filter((item) => sameHead(text(record(record(item)?.head)?.label), owner, refs.branch)) : value;
  };
  let pull = parseRestPullRequest(await pullsIn(refs.repository));
  if (!pull) {
    const repo = record((await reader.get(`repos/${refs.repository}`, { jq: "{fork, parent: .parent.full_name}" })).value);
    const parent = repo?.fork === true ? normalizeRepository(repo.parent) : null;
    if (parent) pull = parseRestPullRequest(await pullsIn(parent));
  }
  return pull;
}

async function withChecks(reader: PullRequestReader, pull: NonNullable<ReturnType<typeof parseRestPullRequest>>): Promise<CiPullRequestSnapshot> {
  if (pull.phase === "merged" || pull.phase === "closed") return { ...pull, failed: [], failedAt: 0, pending: 0, passed: 0 };
  // Checks live on the repository the pull request is in.
  const base = `repos/${pull.repository}`;
  const [runs, status] = await Promise.all([
    reader.get(`${base}/commits/${pull.headOid}/check-runs?per_page=100`, { jq: CHECK_RUNS_JQ }),
    reader.get(`${base}/commits/${pull.headOid}/status?per_page=100`),
  ]);
  return { ...pull, ...summarizeRestChecks(runs.value, status.value) };
}

const GRAPHQL_PULL = `nodes { number state isDraft mergedAt url title headRefOid headRepositoryOwner { login } }`;

/**
 * The newest pull request of each branch, open or not, in the repository or,
 * for a branch with none there, in the parent it was forked from: one GraphQL
 * query for all of them. A branch whose page of same-named pull requests in
 * the repository is full without one of its own is left out (asked alone).
 */
async function branchesPulls(
  reader: PullRequestReader & { graphql: NonNullable<PullRequestReader["graphql"]> },
  repository: string,
  branches: readonly string[],
): Promise<Map<string, ReturnType<typeof parseRestPullRequest>>> {
  const [owner, name] = repository.split("/");
  const found = new Map<string, ReturnType<typeof parseRestPullRequest>>();
  const variables: Record<string, string> = { owner, name };
  const fields = branches.map((branch, i) => {
    variables[`b${i}`] = branch;
    return `b${i}: pullRequests(headRefName: $b${i}, first: ${PULLS_PER_BRANCH}, orderBy: {field: CREATED_AT, direction: DESC}) { ${GRAPHQL_PULL} }`;
  });
  const query = `query(${["$owner: String!", "$name: String!", ...branches.map((_, i) => `$b${i}: String!`)].join(", ")}) { repository(owner: $owner, name: $name) { ${fields.join(" ")} parent { ${fields.join(" ")} } } }`;
  const repo = record(record(record(await reader.graphql(query, variables))?.data)?.repository);
  if (!repo) throw new Error(`GitHub found no repository ${repository}`);
  branches.forEach((branch, i) => {
    const pick = (place: unknown): { pull: ReturnType<typeof parseRestPullRequest>; complete: boolean } => {
      const nodes = record(record(place)?.[`b${i}`])?.nodes;
      if (!Array.isArray(nodes)) return { pull: null, complete: place == null };
      const rest = nodes.flatMap((node) => {
        const pull = record(node);
        const login = text(record(pull?.headRepositoryOwner)?.login);
        if (!pull || !sameHead(`${login}:${branch}`, owner, branch)) return [];
        return [{
          number: pull.number,
          state: pull.state === "OPEN" ? "open" : "closed",
          draft: pull.isDraft === true,
          merged_at: pull.mergedAt ?? null,
          html_url: pull.url,
          title: pull.title,
          head: { sha: pull.headRefOid, label: `${login}:${branch}` },
        }];
      });
      const pull = parseRestPullRequest(rest);
      // A full page may hide an open one of its own: only an open one, or a
      // page with room left, settles the branch.
      const complete = nodes.length < PULLS_PER_BRANCH || (pull !== null && (pull.phase === "open" || pull.phase === "draft"));
      return { pull: complete ? pull : null, complete };
    };
    const own = pick(repo);
    if (own.pull) return void found.set(branch, own.pull);
    // An older one of its own may be past a full page: the parent's proves nothing yet.
    if (!own.complete) return;
    const parent = pick(repo.parent);
    if (parent.pull) return void found.set(branch, parent.pull);
    if (parent.complete) found.set(branch, null);
  });
  return found;
}

/**
 * GitHubCiWatchDeps.readPullRequests over GitHub's API, for rows of one
 * repository: its open pull requests in one conditional REST read, shared by
 * all of them; the branches with none open in one GraphQL query (a refused
 * query errs their rows); a branch neither settles is asked about alone, as
 * readPullRequest does. Then the checks of each open one, each row answered
 * as soon as it is read.
 */
export async function readRepositoryPullRequests(
  reader: PullRequestReader,
  items: ReadonlyArray<{ cwd: string; refs: CiLocalRefs }>,
  failure: (cause: unknown) => Error = (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  answer?: (cwd: string, pr: CiPullRequestSnapshot | null | Error) => void,
): Promise<Map<string, CiPullRequestSnapshot | null | Error>> {
  const answers = new Map<string, CiPullRequestSnapshot | null | Error>();
  const settle = (cwd: string, value: CiPullRequestSnapshot | null | Error) => {
    answers.set(cwd, value);
    answer?.(cwd, value);
  };
  if (!items.length) return answers;
  const { repository } = items[0].refs;
  const [owner] = repository.split("/");
  let open: unknown[];
  try {
    const value = (await reader.get(`repos/${repository}/pulls?state=open&per_page=${PULLS_PAGE}`, { jq: PULLS_JQ })).value;
    open = Array.isArray(value) ? value : [];
  } catch (cause) {
    for (const { cwd } of items) settle(cwd, failure(cause));
    return answers;
  }
  const openPull = (branch: string) =>
    parseRestPullRequest(
      open
        .filter((item) => sameHead(text(record(record(item)?.head)?.label), owner, branch))
        .sort((a, b) => Number(record(b)?.number) - Number(record(a)?.number)),
    );
  const pulls = new Map(items.map(({ refs }) => [refs.branch, openPull(refs.branch)]));
  const rest = [...new Set(items.map(({ refs }) => refs.branch).filter((branch) => !pulls.get(branch)))];
  // Asked while the open ones' checks are read. A refused query errs its
  // rows, which wait out the error backoff, rather than asking each branch
  // alone.
  const none = new Map<string, ReturnType<typeof parseRestPullRequest>>();
  const settled: Promise<Map<string, ReturnType<typeof parseRestPullRequest>> | Error> =
    rest.length && reader.graphql
      ? branchesPulls(reader as Parameters<typeof branchesPulls>[0], repository, rest).catch((cause: unknown) => failure(cause))
      : Promise.resolve(none);
  const readRow = async ({ cwd, refs }: { cwd: string; refs: CiLocalRefs }): Promise<void> => {
    try {
      let pull = pulls.get(refs.branch) ?? null;
      if (!pull) {
        const known = await settled;
        if (known instanceof Error) return settle(cwd, known);
        pull = known.has(refs.branch) ? known.get(refs.branch)! : await branchPull(reader, refs);
      }
      settle(cwd, pull ? await withChecks(reader, pull) : null);
    } catch (cause) {
      settle(cwd, failure(cause));
    }
  };
  // Open ones first, each answered as soon as its checks are read: a slow
  // read holds up no other row.
  const queue = [...items].sort((a, b) => Number(!pulls.get(a.refs.branch)) - Number(!pulls.get(b.refs.branch)));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) await readRow(queue[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_READS_AT_ONCE, queue.length) }, worker));
  // A query nobody waited on (every row open) is still settled before returning.
  await settled;
  return answers;
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
    { foregroundProcessGroup },
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
    import("./terminal-foreground"),
  ]);
  const read = async (cwd: string, args: string[]): Promise<string> => {
    try {
      return (await runGit(cwd, args, { internal: true })).stdout.trim();
    } catch {
      return "";
    }
  };
  const readers = new Map<string, PullRequestReader>();
  const readerFor = (executablePath: string, host: string): PullRequestReader => {
    let reader = readers.get(host);
    if (!reader) {
      const gh = (args: string[]) =>
        github.runGitHubCliCommand({
          executablePath,
          args: host === "github.com" ? args : [...args.slice(0, 1), "--hostname", host, ...args.slice(1)],
          timeoutMs: github.GITHUB_CLI_READ_TIMEOUT_MS,
          maxOutputBytes: github.GITHUB_CLI_MAX_OUTPUT_BYTES,
        });
      const rest = conditional.createConditionalGitHubReader(gh);
      reader = {
        get: (path, options) => rest.get(path, options),
        async graphql(query, variables) {
          const fields = Object.entries(variables).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
          return JSON.parse((await gh(["api", "graphql", "-f", `query=${query}`, ...fields])).stdout) as unknown;
        },
      };
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
  const typeLine = nudge.createAgentPaneTyper({
    hasSession: pty.hasSession,
    shellPid: (paneId) => pty.hibernationSessionInfo(paneId)?.pid ?? null,
    foregroundGroup: (pid) => foregroundProcessGroup(pid),
    inject: (paneId, line, opts) => pty.inject(paneId, line, opts),
    noteSubmit: (paneId) => agents.noteTerminalUserInput(paneId),
  });
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
        const runtime = String(entry.runtime);
        runtimes.set(entry.paneId, runtime);
        // Typed since the last submit: text may sit in the input box. Claude
        // stashes it; other agents would send it along with the line.
        const evidence = runtime === "claude" ? null : agents.terminalAgentHibernationEvidence(entry.paneId);
        panes.push({
          paneId: entry.paneId,
          state: entry.state,
          rank,
          lastInputAt: pty.hibernationSessionInfo(entry.paneId)?.lastInputAt ?? 0,
          draft: !!evidence && evidence.lastUserInputAt > evidence.lastSubmitAt,
        });
      }
      return panes;
    },
    // Claude parks a draft older than the quiet window (Ctrl+S) and brings
    // it back after the line is sent, so the two are never submitted together.
    type: (paneId, line, wanted) => typeLine(paneId, line, { stashDraft: runtimes.get(paneId) === "claude", wanted }),
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
  // At once: a line waiting for a busy agent is withdrawn by the pass, and
  // must not reach the agent first.
  const unsubscribe = prefs.onPreferenceChange((key) => {
    if (key !== "watchPullRequests" && key !== "notifyCiFailures" && key !== "pullRequestWatchOffRepos") return;
    live?.recheck();
    live?.nudge(0);
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
    watchRefs: (cwd, _refs, onChange) => watchUpstreamRef(read, cwd, onChange),
    async readPullRequest(_cwd, refs) {
      // Without gh there is nothing to watch; asked again in 15 minutes.
      const executablePath = await resolveBinary("gh");
      if (!executablePath) return null;
      const reader = readerFor(executablePath, refs.host);
      try {
        const pull = await branchPull(reader, refs);
        return pull ? await withChecks(reader, pull) : null;
      } catch (cause) {
        throw new Error(github.sanitizeGitHubFailure(cause, "gh failed"));
      }
    },
    async readPullRequests(items, answer) {
      const executablePath = await resolveBinary("gh");
      if (!executablePath || !items.length) return new Map(items.map(({ cwd }) => [cwd, null]));
      return readRepositoryPullRequests(
        readerFor(executablePath, items[0].refs.host),
        items,
        (cause) => new Error(github.sanitizeGitHubFailure(cause, "gh failed")),
        answer,
      );
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
