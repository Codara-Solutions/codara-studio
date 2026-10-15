// "CI failed on your pull request" alerts (Settings, Git: "Notify me when CI
// fails on my pull request"). Watches the pull request of each local
// workspace's branch through the user's own `gh` and raises one notification
// per failing head commit, which "Fix with agent" in Source Control can then
// hand to an agent.
//
// Cost: the watcher asks GitHub only when it has a reason to. Each minute it
// reads the local HEAD and upstream of every workspace (plain git, no
// network); a branch without an upstream, or one that tracks the remote's
// default branch, has no pull request and is skipped. `gh pr view` runs when
// those refs moved (a commit or a push), every 90 seconds while checks are
// still running, and otherwise every 15 minutes, so a quiet repository costs
// a handful of calls an hour.
//
// A pull request already failing when the watcher first sees it is not news,
// so it stays quiet; every later failure of a new head commit, or of a re-run
// that went back to running first, alerts once.

import { isRemotePath } from "@shared/remote";
import type { AppState, Workspace } from "@shared/types";

export const CI_WATCH_FIRST_DELAY_MS = 45_000;
export const CI_WATCH_TICK_MS = 60_000;
export const CI_WATCH_PENDING_REQUERY_MS = 90_000;
export const CI_WATCH_SETTLED_REQUERY_MS = 15 * 60_000;
export const CI_WATCH_ERROR_BACKOFF_MS = 10 * 60_000;
export const CI_WATCH_MAX_WORKSPACES = 24;
const NOTIFIED_HEADS_CAP = 20;

export interface CiPullRequestSnapshot {
  /** owner/name, from the pull request's link. */
  repository: string;
  number: number;
  title: string;
  state: string;
  headOid: string;
  /** Names of the failing checks. */
  failed: string[];
  /** Checks still queued or running. */
  pending: number;
}

export interface CiNotifyInput {
  kind: "git.ci-failed";
  sourceKey: string;
  title: string;
  body: string;
  tone: "danger";
  soundKind: "needs-you";
  target: { type: "workspace"; workspaceId: string; panel: "git" };
}

export interface GitHubCiWatchDeps {
  loadState(): Promise<AppState>;
  enabled(): boolean;
  pathExists(path: string): Promise<boolean>;
  /**
   * The local HEAD and upstream commits as one key, or null when the branch
   * cannot have a pull request (detached, no upstream, the default branch).
   */
  localRefs(cwd: string): Promise<string | null>;
  /** The open pull request of the branch, null when there is none (or no gh). Throws when GitHub cannot be read. */
  readPullRequest(cwd: string): Promise<CiPullRequestSnapshot | null>;
  publish(input: CiNotifyInput): void;
  rearm(sourceKey: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(message: string): void;
}

interface WorkspaceTrack {
  refs: string;
  queriedAt: number;
  pending: boolean;
  retryAt: number;
}

interface PullRequestTrack {
  firstHead: string;
  firstFailed: boolean;
  notified: string[];
}

export function formatCiFailure(pr: CiPullRequestSnapshot): { title: string; body: string } {
  const shown = pr.failed.slice(0, 3).join(", ");
  const more = pr.failed.length > 3 ? ` and ${pr.failed.length - 3} more` : "";
  const title = pr.title.length > 80 ? `${pr.title.slice(0, 77)}...` : pr.title;
  return {
    title: `CI failed on pull request #${pr.number}`,
    body: `${shown}${more} · ${title}`,
  };
}

export interface GitHubCiWatch {
  start(): void;
  stop(): void;
  /** Runs a pass soon (after a push, on resume). */
  nudge(): void;
  /** One pass now; tests drive the watcher with it. */
  runPass(): Promise<void>;
}

export function createGitHubCiWatch(deps: GitHubCiWatchDeps): GitHubCiWatch {
  const workspaces = new Map<string, WorkspaceTrack>();
  const pullRequests = new Map<string, PullRequestTrack>();
  let started = false;
  let timer: unknown = null;
  let running: Promise<void> | null = null;

  function observe(workspace: Workspace, pr: CiPullRequestSnapshot): void {
    const key = `${pr.repository.toLowerCase()}#${pr.number}`;
    let track = pullRequests.get(key);
    if (!track) {
      track = { firstHead: pr.headOid, firstFailed: pr.failed.length > 0, notified: [] };
      pullRequests.set(key, track);
    }
    if (!pr.failed.length) {
      // Running or green again (a re-run): its next failure is news.
      track.notified = track.notified.filter((head) => head !== pr.headOid);
      if (pr.headOid === track.firstHead) track.firstFailed = false;
      return;
    }
    if (track.notified.includes(pr.headOid)) return;
    track.notified.push(pr.headOid);
    if (track.notified.length > NOTIFIED_HEADS_CAP) track.notified.shift();
    if (pr.headOid === track.firstHead && track.firstFailed) return;
    const sourceKey = `github-ci:${key}`;
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

  async function pass(): Promise<void> {
    if (!deps.enabled()) {
      workspaces.clear();
      pullRequests.clear();
      return;
    }
    const state = await deps.loadState();
    const seen = new Set<string>();
    const local = state.workspaces.filter((workspace) => !isRemotePath(workspace.cwd)).slice(0, CI_WATCH_MAX_WORKSPACES);
    for (const workspace of local) {
      if (seen.has(workspace.cwd) || !(await deps.pathExists(workspace.cwd))) continue;
      seen.add(workspace.cwd);
      const refs = await deps.localRefs(workspace.cwd).catch(() => null);
      if (!refs) {
        workspaces.delete(workspace.cwd);
        continue;
      }
      const now = deps.now();
      const track = workspaces.get(workspace.cwd);
      // New refs are asked about at once; otherwise after an error's backoff,
      // or when running checks (or settled ones) are due another look.
      const due =
        !track ||
        track.refs !== refs ||
        (track.retryAt
          ? now >= track.retryAt
          : now - track.queriedAt >= (track.pending ? CI_WATCH_PENDING_REQUERY_MS : CI_WATCH_SETTLED_REQUERY_MS));
      if (!due) continue;
      let pr: CiPullRequestSnapshot | null;
      try {
        pr = await deps.readPullRequest(workspace.cwd);
      } catch (cause) {
        // Once per streak of errors, not every retry.
        if (!track?.retryAt) {
          deps.log(`could not read the pull request of ${workspace.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        workspaces.set(workspace.cwd, { refs, queriedAt: now, pending: false, retryAt: now + CI_WATCH_ERROR_BACKOFF_MS });
        continue;
      }
      const open = pr !== null && pr.state === "OPEN";
      workspaces.set(workspace.cwd, { refs, queriedAt: now, pending: open && pr!.pending > 0, retryAt: 0 });
      if (open) observe(workspace, pr!);
    }
    for (const cwd of [...workspaces.keys()]) if (!seen.has(cwd)) workspaces.delete(cwd);
  }

  function schedule(ms: number): void {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    if (!started) return;
    timer = deps.setTimeout(() => {
      timer = null;
      void runPass().finally(() => schedule(CI_WATCH_TICK_MS));
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
      schedule(CI_WATCH_FIRST_DELAY_MS);
    },
    stop() {
      started = false;
      schedule(0);
    },
    nudge() {
      if (started) schedule(5_000);
    },
    runPass,
  };
}

// ── Production wiring ───────────────────────────────────────────────────────

const SUCCESS_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

/** The CI part of `gh pr view --json number,title,url,state,headRefOid,statusCheckRollup`. */
export function parseCiPullRequest(stdout: string): CiPullRequestSnapshot | null {
  const value = JSON.parse(stdout) as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  const number = value.number;
  const url = typeof value.url === "string" ? value.url : "";
  const match = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  const headOid = typeof value.headRefOid === "string" ? value.headRefOid : "";
  if (!Number.isSafeInteger(number) || !match || !/^[a-f0-9]{40,64}$/i.test(headOid)) return null;
  const failed: string[] = [];
  let pending = 0;
  for (const raw of Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : []) {
    if (!raw || typeof raw !== "object") continue;
    const check = raw as Record<string, unknown>;
    const signal = [check.conclusion, check.state, check.status].find((part) => typeof part === "string" && part) as string | undefined;
    const name = String(check.name ?? check.context ?? "check").replace(/\s+/g, " ").slice(0, 80);
    if (signal && FAILED_STATES.has(signal.toUpperCase())) failed.push(name);
    else if (!signal || !SUCCESS_STATES.has(signal.toUpperCase())) pending += 1;
  }
  return {
    repository: match[1],
    number: Number(number),
    title: typeof value.title === "string" ? value.title.replace(/\s+/g, " ").trim() : "",
    state: typeof value.state === "string" ? value.state : "",
    headOid,
    failed,
    pending,
  };
}

let live: GitHubCiWatch | null = null;

async function productionDeps(): Promise<GitHubCiWatchDeps> {
  const [{ access }, { runGit }, { resolveBinary }, github, notify, prefs, storage] = await Promise.all([
    import("node:fs/promises"),
    import("./git-exec"),
    import("./binary-resolver"),
    import("./github-cli"),
    import("./notify"),
    import("./preferences-store"),
    import("./storage"),
  ]);
  const read = async (cwd: string, args: string[]): Promise<string> => {
    try {
      return (await runGit(cwd, args, { internal: true })).stdout.trim();
    } catch {
      return "";
    }
  };
  return {
    loadState: storage.loadState,
    enabled: () => prefs.getPreferenceCached("notifyCiFailures") !== false,
    pathExists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async localRefs(cwd) {
      const upstream = await read(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
      if (!upstream || !upstream.includes("/")) return null;
      const remote = upstream.slice(0, upstream.indexOf("/"));
      const defaultBranch = await read(cwd, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
      if (defaultBranch && defaultBranch === upstream) return null;
      const commits = await read(cwd, ["rev-parse", "HEAD", "@{upstream}"]);
      return commits ? commits.replace(/\s+/g, " ") : null;
    },
    async readPullRequest(cwd) {
      // Without gh there is nothing to watch; asked again in 15 minutes.
      const executablePath = await resolveBinary("gh");
      if (!executablePath) return null;
      try {
        const result = await github.runGitHubCliCommand({
          executablePath,
          cwd,
          args: ["pr", "view", "--json", "number,title,url,state,headRefOid,statusCheckRollup"],
          timeoutMs: github.GITHUB_CLI_READ_TIMEOUT_MS,
          maxOutputBytes: github.GITHUB_CLI_MAX_OUTPUT_BYTES,
        });
        return parseCiPullRequest(result.stdout);
      } catch (cause) {
        const detail = github.sanitizeGitHubFailure(cause, "gh failed");
        if (/no pull requests? found|no pull request (?:is )?associated|could not find (?:a )?pull request/i.test(detail)) return null;
        throw new Error(detail);
      }
    },
    publish: (input) => notify.publish(input),
    rearm: notify.rearm,
    now: Date.now,
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    log: (message) => console.warn(`[github-ci-watch] ${message}`),
  };
}

export async function startGitHubCiWatch(): Promise<void> {
  if (live) return;
  live = createGitHubCiWatch(await productionDeps());
  live.start();
}

export function nudgeGitHubCiWatch(): void {
  live?.nudge();
}

export function stopGitHubCiWatch(): void {
  live?.stop();
  live = null;
}
