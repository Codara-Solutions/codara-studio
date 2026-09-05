import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { isRemotePath } from "@shared/remote";
import {
  DEFAULT_GIT_AUTO_FETCH_INTERVAL_MINUTES,
  type AppPreferences,
  type AppState,
  type Workspace,
} from "@shared/types";
import { runGit } from "./git-exec";
import { createLimiter, workQueueRelevantFingerprint } from "./github-work-queue";
import { publish, rearm, type PublishInput } from "./notify";
import { getPreferenceCached } from "./preferences-store";
import { loadState, onStateSaved } from "./storage";
import { subscribeToEvents } from "./sse-client";

// "A teammate pushed" alerts, sourced from GitHub rather than from the local
// git remote-tracking refs.
//
// The local-git version of this feature had to infer WHO pushed from commit
// author/committer emails, which is unreliable in exactly the case that
// matters: a squash-merged PR is authored by a `users.noreply.github.com`
// address that matches nobody's `user.email`, so the user's own merges were
// reported back to them as teammate pushes (measured 2026-08-29: 6 of 42).
// GitHub's Events API answers the identity question directly — `actor.login`
// is the account that pushed — so there is nothing to infer.
//
// Cost: one conditional GET per repository per poll. GitHub returns 304 with
// an `If-None-Match`, and a 304 does not consume rate limit at all (verified
// against the live API), so a quiet repository is free to watch. `X-Poll-
// Interval` (60s today) is honoured as a floor on top of the user's interval.
//
// Authorized website subscriptions deliver webhook events immediately. The
// conditional Events API poll reconciles reconnect gaps and missed webhooks.
// The public release stream never carries repository events.
//
// Private-repository push events arrive with `commits: []` and `size: null`,
// but they do carry `before` and `head`, so one `/compare` call per alert
// recovers the exact commit count and subject line.
//
// The same feed carries PullRequestEvent, so "someone opened a pull request"
// alerts ride on the identical poll at no extra request: one notification per
// PR opened, reopened, or marked ready for review by anyone but the viewer.

export const GITHUB_PUSH_WATCH_MAX_REPOS = 32;
export const GITHUB_PUSH_WATCH_CONCURRENCY = 2;
// GitHub's own advertised floor for the Events API.
export const GITHUB_PUSH_WATCH_MIN_INTERVAL_MS = 60_000;
export const GITHUB_PUSH_WATCH_FIRST_DELAY_MS = 20_000;
export const GITHUB_PUSH_WATCH_MAX_TICK_MS = 300_000;
export const GITHUB_PUSH_WATCH_MAX_BACKOFF_MS = 3_600_000;
export const GITHUB_PUSH_WATCH_EVENTS_PER_PAGE = 30;
// Bounded per-repo memory of event ids already reported.
export const GITHUB_PUSH_WATCH_SEEN_CAP = 200;
export const GITHUB_PUSH_WATCH_REQUEST_TIMEOUT_MS = 15_000;
export const GITHUB_PUSH_WATCH_TOKEN_TTL_MS = 600_000;

const API_ROOT = "https://api.github.com";

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface GitHubPushWatchDependencies {
  loadState(): Promise<AppState>;
  onStateSaved(listener: (state: AppState) => void): () => void;
  runGit(
    cwd: string,
    args: string[],
    opts?: { timeout?: number; internal?: boolean },
  ): Promise<{ stdout: string; stderr: string }>;
  /** The GitHub token to authenticate with, or null when `gh` is signed out. */
  getToken(): Promise<string | null>;
  subscribe: typeof subscribeToEvents;
  nudgeRepos(cwds: string[]): void;
  httpGet(url: string, headers: Record<string, string>): Promise<HttpResponse>;
  publish(input: PublishInput): void;
  rearm(sourceKey: string): void;
  getPreference<K extends keyof AppPreferences>(key: K): AppPreferences[K];
  pathExists(path: string): Promise<boolean>;
  isOnline(): boolean;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
  log(message: string): void;
}

const execFileAsync = promisify(execFile);

function productionDependencies(): GitHubPushWatchDependencies {
  return {
    loadState,
    onStateSaved,
    subscribe: subscribeToEvents,
    nudgeRepos: (cwds) => { void import("./git-auto-fetch").then((m) => m.nudgeGitAutoFetchNow(cwds)); },
    runGit,
    getToken: async () => {
      try {
        const { stdout } = await execFileAsync("gh", ["auth", "token"], {
          windowsHide: true,
          timeout: 10_000,
        });
        const token = stdout.toString().trim();
        return token.length > 0 ? token : null;
      } catch {
        return null;
      }
    },
    httpGet: async (url, headers) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        GITHUB_PUSH_WATCH_REQUEST_TIMEOUT_MS,
      );
      try {
        const response = await fetch(url, { headers, signal: controller.signal });
        const collected: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          collected[key.toLowerCase()] = value;
        });
        // 304 carries no body, and an error body is JSON we never read.
        const body = response.status === 200 ? await response.json() : null;
        return { status: response.status, headers: collected, body };
      } finally {
        clearTimeout(timer);
      }
    },
    publish,
    rearm,
    getPreference: (key) => getPreferenceCached(key),
    pathExists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    isOnline: () => true,
    now: Date.now,
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    random: Math.random,
    log: (message) => console.warn(`[github-push-watch] ${message}`),
  };
}

// ── Remote URL → owner/name ─────────────────────────────────────────────────

export interface RepoRef {
  owner: string;
  name: string;
}

// Accepts every shape `git remote get-url` can print for github.com:
// https://github.com/o/n(.git), git@github.com:o/n(.git), ssh://git@…, and
// github.com/o/n. Non-GitHub hosts return null so the repo is simply not
// watched (the workspace still works, it just has no push alerts).
export function parseGitHubRemote(url: string): RepoRef | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const match =
    /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  if (!match) return null;
  const [, owner, name] = match;
  if (!owner || !name || name.includes("/")) return null;
  return { owner, name };
}

// ── Notification copy ───────────────────────────────────────────────────────

export interface BranchPush {
  branch: string;
  /** Commits the push added, from /compare. 0 when the count is unknown. */
  count: number;
  subject: string;
}

function listNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} teammates`;
}

export function formatPushNotification(
  repoName: string,
  actors: string[],
  pushes: BranchPush[],
): { title: string; body: string } {
  const title = `${listNames(actors)} pushed to ${repoName}`;
  const total = pushes.reduce((sum, push) => sum + push.count, 0);
  if (pushes.length === 1) {
    const [push] = pushes;
    const subject = push.subject ? ` — ${push.subject}` : "";
    const count = push.count > 0 ? `${push.count} commit${push.count === 1 ? "" : "s"}` : "New commits";
    return { title, body: `${count} to ${push.branch}${subject}` };
  }
  const shown = pushes.slice(0, 2).map((push) => push.branch);
  const more = pushes.length - shown.length;
  const tail = more > 0 ? ` and ${more} more` : "";
  const count = total > 0 ? `${total} commits` : "New commits";
  return { title, body: `${count} to ${shown.join(", ")}${tail}` };
}

// ── Runtime state ───────────────────────────────────────────────────────────

interface WatchedRepo {
  key: string;
  owner: string;
  name: string;
  displayName: string;
  workspaces: Workspace[];
  etag: string | null;
  seeded: boolean;
  seenEventIds: string[];
  nextDueAt: number;
  backoffMs: number;
  pollFloorMs: number;
  paused: boolean;
}

export interface GitHubPushWatchSnapshot {
  key: string;
  cwds: string[];
  seeded: boolean;
  paused: boolean;
  nextDueAt: number;
  backoffMs: number;
}

interface PushRecord {
  id: string;
  actor: string;
  branch: string;
  before: string;
  head: string;
}

let deps: GitHubPushWatchDependencies = productionDependencies();
let started = false;
let repos = new Map<string, WatchedRepo>();
let timer: unknown = null;
let passRunning = false;
let lastFingerprint: string | null = null;
let limiter = createLimiter(GITHUB_PUSH_WATCH_CONCURRENCY);
let rebuildChain: Promise<void> = Promise.resolve();
let viewerLogin: string | null = null;
let viewerRetryAt = 0;
let stopEvents: (() => void) | null = null;
let eventFingerprint = "";
let queuedEvents = 0;
let eventChain: Promise<void> = Promise.resolve();
let cachedToken: { value: string | null; expiresAt: number } | null = null;
const unsubscribes: Array<() => void> = [];
// cwd → GitHub repo, memoized for the process lifetime.
const repoRefByCwd = new Map<string, Promise<RepoRef | null>>();

function pushesEnabled(): boolean {
  return deps.getPreference("notifyTeammatePushes") !== false;
}

function pullRequestsEnabled(): boolean {
  return deps.getPreference("notifyPullRequests") !== false;
}

function enabled(): boolean {
  return (
    deps.getPreference("gitAutoFetchEnabled") !== false &&
    (pushesEnabled() || pullRequestsEnabled())
  );
}

function intervalMs(): number {
  const minutes = deps.getPreference("gitAutoFetchIntervalMinutes");
  const base =
    typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 1
      ? minutes * 60_000
      : DEFAULT_GIT_AUTO_FETCH_INTERVAL_MINUTES * 60_000;
  return Math.max(GITHUB_PUSH_WATCH_MIN_INTERVAL_MS, base);
}

async function token(): Promise<string | null> {
  const now = deps.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.value;
  const value = await deps.getToken();
  if (cachedToken && cachedToken.value !== value) {
    viewerLogin = null;
    viewerRetryAt = 0;
    for (const repo of repos.values()) { repo.paused = false; repo.backoffMs = 0; repo.etag = null; }
  }
  cachedToken = { value, expiresAt: now + GITHUB_PUSH_WATCH_TOKEN_TTL_MS };
  return value;
}

function apiHeaders(auth: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${auth}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Codara-Studio",
    ...extra,
  };
}

// The signed-in account. Every push by this login is the user's own — including
// the squash merges whose commit emails match nobody.
async function resolveViewer(auth: string): Promise<string | null> {
  if (viewerLogin || deps.now() < viewerRetryAt) return viewerLogin;
  try {
    const response = await deps.httpGet(`${API_ROOT}/user`, apiHeaders(auth));
    const login = (response.body as { login?: unknown } | null)?.login;
    if (response.status === 200 && typeof login === "string" && login) {
      viewerLogin = login;
      return viewerLogin;
    }
  } catch {
    /* fall through to the failure path */
  }
  viewerRetryAt = deps.now() + intervalMs();
  deps.log("could not resolve the signed-in GitHub account; push alerts stay off");
  return null;
}

function primaryWorkspace(workspaces: Workspace[]): Workspace {
  return workspaces.find((workspace) => !workspace.copyBranch) ?? workspaces[0];
}

async function resolveRepoRef(cwd: string, deps_: GitHubPushWatchDependencies): Promise<RepoRef | null> {
  let pending = repoRefByCwd.get(cwd);
  if (!pending) {
    pending = (async () => {
      // The remote the checked-out branch tracks, else origin, else the sole
      // remote — same precedence the fetcher uses.
      const read = async (args: string[]): Promise<string> => {
        try {
          return (await deps_.runGit(cwd, args, { internal: true })).stdout.trim();
        } catch {
          return "";
        }
      };
      const remotes = (await read(["remote"])).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
      if (remotes.length === 0) return null;
      let remote = "";
      const branch = await read(["branch", "--show-current"]);
      if (branch) {
        const tracked = await read(["config", "--get", `branch.${branch}.remote`]);
        if (tracked && remotes.includes(tracked)) remote = tracked;
      }
      if (!remote) remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : "";
      if (!remote) return null;
      const url = await read(["remote", "get-url", remote]);
      return url ? parseGitHubRemote(url) : null;
    })();
    repoRefByCwd.set(cwd, pending);
  }
  return pending;
}

function jitter(ms: number): number {
  return Math.floor(deps.random() * ms);
}

async function rebuildRepoTable(state: AppState): Promise<void> {
  const now = deps.now();
  const next = new Map<string, WatchedRepo>();
  let dropped = 0;
  for (const workspace of state.workspaces) {
    if (isRemotePath(workspace.cwd)) continue;
    if (!(await deps.pathExists(workspace.cwd))) continue;
    const ref = await resolveRepoRef(workspace.cwd, deps);
    if (!ref) continue;
    const key = `${ref.owner}/${ref.name}`.toLowerCase();
    const existing = next.get(key);
    if (existing) {
      existing.workspaces.push(workspace);
      continue;
    }
    if (next.size >= GITHUB_PUSH_WATCH_MAX_REPOS) {
      dropped += 1;
      continue;
    }
    const previous = repos.get(key);
    next.set(key, {
      key,
      owner: ref.owner,
      name: ref.name,
      displayName: workspace.name,
      workspaces: [workspace],
      etag: previous?.etag ?? null,
      seeded: previous?.seeded ?? false,
      seenEventIds: previous?.seenEventIds ?? [],
      nextDueAt:
        previous?.nextDueAt ??
        now + GITHUB_PUSH_WATCH_FIRST_DELAY_MS + jitter(GITHUB_PUSH_WATCH_FIRST_DELAY_MS),
      backoffMs: previous?.backoffMs ?? 0,
      pollFloorMs: previous?.pollFloorMs ?? GITHUB_PUSH_WATCH_MIN_INTERVAL_MS,
      paused: previous?.paused ?? false,
    });
  }
  for (const entry of next.values()) {
    entry.displayName = primaryWorkspace(entry.workspaces).name;
  }
  if (dropped > 0) {
    deps.log(`${dropped} repositories beyond the ${GITHUB_PUSH_WATCH_MAX_REPOS}-repo cap are not watched`);
  }
  repos = next;
  syncEventSubscription();
  scheduleNextPass();
}

function syncEventSubscription(): void {
  const keys = deps.getPreference("gitAutoFetchEnabled") === false ? [] : [...repos.keys()].sort();
  const fingerprint = keys.join("\n");
  if (fingerprint === eventFingerprint) return;
  stopEvents?.();
  eventFingerprint = fingerprint;
  stopEvents = null;
  if (!keys.length) return;
  stopEvents = deps.subscribe({
    url: "https://studio.codarasolutions.com/api/github/events",
    request: async () => {
      const auth = await deps.getToken();
      if (auth !== cachedToken?.value) cachedToken = cachedToken ? { ...cachedToken, expiresAt: 0 } : null;
      if (!auth) throw new Error("GitHub is signed out");
      return { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify({ repos: keys }) };
    },
    onEvent: (message) => {
      if (!started || fingerprint !== eventFingerprint) return;
      if (message.event === "resync") {
        deps.nudgeRepos(keys.flatMap((key) => repos.get(key)?.workspaces.map((workspace) => workspace.cwd) ?? []));
        nudgeGitHubPushWatch();
        return;
      }
      if (message.event !== "github") return;
      let data: { repo?: string; event?: unknown };
      try { data = JSON.parse(message.data); } catch { return; }
      const repo = typeof data.repo === "string" ? repos.get(data.repo) : undefined;
      if (!repo || !data.event) return;
      deps.nudgeRepos(repo.workspaces.map((workspace) => workspace.cwd));
      if (queuedEvents >= 128) return;
      queuedEvents += 1;
      eventChain = eventChain.then(async () => {
        if (!started || fingerprint !== eventFingerprint || !enabled()) return;
        const auth = await token();
        const viewer = auth ? await resolveViewer(auth) : null;
        if (auth && viewer) await deliverEvents(repo, [data.event], auth, viewer, true);
      }).catch(() => { /* The conditional poll reconciles failed delivery. */ })
        .finally(() => { queuedEvents -= 1; });
    },
    onError: (message) => deps.log(`${message}; reconnecting event stream`),
  });
}

function eventIdentity(raw: unknown): string | null {
  const event = raw as { id?: string; type?: string; payload?: { ref?: string; head?: string;
    action?: string; pull_request?: { number?: number; updated_at?: string; head?: { sha?: string } } } } | null;
  if (!event || typeof event !== "object") return null;
  if (event.type === "PushEvent" && event.payload?.head) return `push:${event.payload.ref}:${event.payload.head}`;
  const pr = event.payload?.pull_request;
  if (event.type === "PullRequestEvent" && pr?.number) {
    return `pr:${pr.number}:${event.payload?.action}:${pr.updated_at ?? pr.head?.sha ?? ""}`;
  }
  return typeof event.id === "string" ? event.id : null;
}

export function waitForGitHubWebhookEvents(): Promise<void> { return eventChain; }

function queueRebuild(state: AppState): Promise<void> {
  rebuildChain = rebuildChain
    .then(() => (started ? rebuildRepoTable(state) : undefined))
    .catch((err) => deps.log(`repo table rebuild failed: ${String(err)}`));
  return rebuildChain;
}

// ── Polling one repository ──────────────────────────────────────────────────

function parsePushEvents(body: unknown, viewer: string): PushRecord[] {
  if (!Array.isArray(body)) return [];
  const out: PushRecord[] = [];
  for (const raw of body) {
    const event = raw as {
      id?: unknown;
      type?: unknown;
      actor?: { login?: unknown };
      payload?: { ref?: unknown; head?: unknown; before?: unknown };
    };
    if (event.type !== "PushEvent") continue;
    const id = typeof event.id === "string" ? event.id : null;
    const actor = typeof event.actor?.login === "string" ? event.actor.login : null;
    const ref = typeof event.payload?.ref === "string" ? event.payload.ref : null;
    const head = typeof event.payload?.head === "string" ? event.payload.head : "";
    const before = typeof event.payload?.before === "string" ? event.payload.before : "";
    if (!id || !actor || !ref) continue;
    // Branch pushes only: tag pushes carry refs/tags/* and are not "someone
    // moved the work forward".
    if (!ref.startsWith("refs/heads/")) continue;
    // The identity question, answered rather than inferred.
    if (actor.toLowerCase() === viewer.toLowerCase()) continue;
    out.push({ id, actor, branch: ref.slice("refs/heads/".length), before, head });
  }
  return out;
}

interface PullRequestRecord {
  id: string;
  actor: string;
  action: "opened" | "reopened" | "ready_for_review";
  number: number;
  title: string;
  url: string;
  headBranch: string;
  draft: boolean;
}

const PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);

export function parsePullRequestEvents(body: unknown, viewer: string): PullRequestRecord[] {
  if (!Array.isArray(body)) return [];
  const out: PullRequestRecord[] = [];
  for (const raw of body) {
    const event = raw as {
      id?: unknown;
      type?: unknown;
      actor?: { login?: unknown };
      payload?: {
        action?: unknown;
        pull_request?: {
          number?: unknown;
          title?: unknown;
          html_url?: unknown;
          draft?: unknown;
          head?: { ref?: unknown };
        };
      };
    };
    if (event.type !== "PullRequestEvent") continue;
    const id = typeof event.id === "string" ? event.id : null;
    const actor = typeof event.actor?.login === "string" ? event.actor.login : null;
    const action = typeof event.payload?.action === "string" ? event.payload.action : "";
    const pr = event.payload?.pull_request;
    if (!id || !actor || !pr || !PULL_REQUEST_ACTIONS.has(action)) continue;
    if (typeof pr.number !== "number") continue;
    const draft = pr.draft === true;
    // A draft being opened is not a request for anyone's attention yet; the
    // ready_for_review event covers the moment it becomes one.
    if (draft && action !== "ready_for_review") continue;
    if (actor.toLowerCase() === viewer.toLowerCase()) continue;
    out.push({
      id,
      actor,
      action: action as PullRequestRecord["action"],
      number: pr.number,
      title: typeof pr.title === "string" ? pr.title.trim() : "",
      url: typeof pr.html_url === "string" ? pr.html_url : "",
      headBranch: typeof pr.head?.ref === "string" ? pr.head.ref : "",
      draft,
    });
  }
  return out;
}

export function formatPullRequestNotification(
  repoName: string,
  pr: { actor: string; action: string; number: number; title: string },
): { title: string; body: string } {
  const verb =
    pr.action === "reopened"
      ? "reopened"
      : pr.action === "ready_for_review"
        ? "marked ready"
        : "opened";
  return {
    title: `${pr.actor} ${verb} PR #${pr.number} in ${repoName}`,
    body: pr.title || `Pull request #${pr.number}`,
  };
}

// One /compare per branch turns `before...head` into an exact commit count and
// the newest subject line — the detail the private-repo event payload omits.
async function describeRange(
  repo: WatchedRepo,
  auth: string,
  branch: string,
  before: string,
  head: string,
): Promise<BranchPush> {
  const fallback: BranchPush = { branch, count: 0, subject: "" };
  if (!head) return fallback;
  const zero = /^0*$/.test(before);
  const url = zero
    ? `${API_ROOT}/repos/${repo.owner}/${repo.name}/commits/${head}`
    : `${API_ROOT}/repos/${repo.owner}/${repo.name}/compare/${before}...${head}`;
  try {
    const response = await deps.httpGet(url, apiHeaders(auth));
    if (response.status !== 200) return fallback;
    if (zero) {
      const message = (response.body as { commit?: { message?: unknown } } | null)?.commit?.message;
      return {
        branch,
        count: 1,
        subject: typeof message === "string" ? message.split("\n")[0].trim() : "",
      };
    }
    const body = response.body as {
      ahead_by?: unknown;
      commits?: Array<{ commit?: { message?: unknown } }>;
    } | null;
    const commits = Array.isArray(body?.commits) ? body.commits : [];
    const newest = commits.length > 0 ? commits[commits.length - 1] : null;
    const message = newest?.commit?.message;
    return {
      branch,
      count: typeof body?.ahead_by === "number" ? body.ahead_by : commits.length,
      subject: typeof message === "string" ? message.split("\n")[0].trim() : "",
    };
  } catch {
    return fallback;
  }
}

// Land the click where the push is most relevant: a copy-branch worktree
// checked out on one of the pushed branches, else the repository's main
// workspace. Read from the workspace record, so this costs no git call.
function pickTargetWorkspace(repo: WatchedRepo, branches: string[]): Workspace {
  const onBranch = repo.workspaces.find(
    (workspace) => workspace.copyBranch && branches.includes(workspace.copyBranch.branch),
  );
  return onBranch ?? primaryWorkspace(repo.workspaces);
}

function rememberSeen(repo: WatchedRepo, ids: string[]): void {
  repo.seenEventIds = [...ids, ...repo.seenEventIds].slice(0, GITHUB_PUSH_WATCH_SEEN_CAP);
}

async function pollRepo(repo: WatchedRepo, auth: string, viewer: string): Promise<void> {
  const url = `${API_ROOT}/repos/${repo.owner}/${repo.name}/events?per_page=${GITHUB_PUSH_WATCH_EVENTS_PER_PAGE}`;
  const headers = apiHeaders(auth, repo.etag ? { "If-None-Match": repo.etag } : {});
  let response: HttpResponse;
  try {
    response = await deps.httpGet(url, headers);
  } catch (err) {
    repo.backoffMs = Math.min(
      GITHUB_PUSH_WATCH_MAX_BACKOFF_MS,
      repo.backoffMs > 0 ? repo.backoffMs * 2 : intervalMs() * 2,
    );
    repo.nextDueAt = deps.now() + repo.backoffMs;
    deps.log(`${repo.key}: request failed (${String(err)})`);
    return;
  }

  const advertised = Number.parseInt(response.headers["x-poll-interval"] ?? "", 10);
  if (Number.isFinite(advertised) && advertised > 0) {
    repo.pollFloorMs = Math.max(GITHUB_PUSH_WATCH_MIN_INTERVAL_MS, advertised * 1_000);
  }
  const schedule = (): void => {
    repo.nextDueAt = deps.now() + Math.max(intervalMs(), repo.pollFloorMs);
  };

  if (response.status === 304) {
    repo.backoffMs = 0;
    schedule();
    return;
  }
  if (response.status === 429 || (response.status === 403 &&
      (response.headers["x-ratelimit-remaining"] === "0" || response.headers["retry-after"]))) {
    const retry = response.headers["retry-after"] ?? "";
    const retryMs = /^\d+$/.test(retry) ? Number(retry) * 1_000 : Date.parse(retry) - deps.now();
    const resetMs = Number(response.headers["x-ratelimit-reset"]) * 1_000 - deps.now();
    repo.backoffMs = Math.max(60_000, Number.isFinite(retryMs) ? retryMs : 0,
      Number.isFinite(resetMs) ? resetMs : 0);
    repo.nextDueAt = deps.now() + repo.backoffMs + jitter(5_000);
    return;
  }
  if (response.status === 404 || response.status === 403 || response.status === 401) {
    // No access, or the token lost the scope. Retrying on a timer would just
    // burn requests; a restart or a re-auth picks it up again.
    repo.paused = true;
    deps.log(`${repo.key}: HTTP ${response.status} — not watching (check \`gh auth status\`)`);
    return;
  }
  if (response.status !== 200) {
    repo.backoffMs = Math.min(
      GITHUB_PUSH_WATCH_MAX_BACKOFF_MS,
      repo.backoffMs > 0 ? repo.backoffMs * 2 : intervalMs() * 2,
    );
    repo.nextDueAt = deps.now() + repo.backoffMs;
    return;
  }

  repo.backoffMs = 0;
  repo.etag = response.headers["etag"] ?? repo.etag;
  schedule();

  await deliverEvents(repo, response.body, auth, viewer, false);
}

async function deliverEvents(repo: WatchedRepo, eventBody: unknown, auth: string, viewer: string, live: boolean): Promise<void> {
  const events = (Array.isArray(eventBody) ? eventBody : []).filter((event) => event && typeof event === "object")
    .map((event) => ({ ...event, id: eventIdentity(event) }));
  const pushes = pushesEnabled() ? parsePushEvents(events, viewer) : [];
  const fresh = pushes.filter((push) => !repo.seenEventIds.includes(push.id));
  const pullRequests = pullRequestsEnabled() ? parsePullRequestEvents(events, viewer) : [];
  const freshPullRequests = pullRequests.filter((pr) => !repo.seenEventIds.includes(pr.id));
  rememberSeen(repo, events.map((event) => event.id).filter((id): id is string => typeof id === "string"));
  if (!repo.seeded && !live) { repo.seeded = true; return; }
  // Oldest first, so several PRs opened between polls arrive in order.
  for (const pr of [...freshPullRequests].reverse()) {
    const { title, body } = formatPullRequestNotification(repo.displayName, pr);
    const target = pickTargetWorkspace(repo, pr.headBranch ? [pr.headBranch] : []);
    const sourceKey = `github-pr:${repo.key}#${pr.number}`;
    deps.rearm(sourceKey);
    deps.publish({
      kind: "git.pull-request",
      sourceKey,
      tone: "success",
      soundKind: "done",
      // A review request deserves a chime; it is a person waiting on you.
      title,
      body,
      target: { type: "workspace", workspaceId: target.id, panel: "git" },
    });
  }
  if (fresh.length === 0) return;

  // Collapse to one alert per repository: newest head per branch, oldest
  // `before` per branch, so the range spans everything that arrived.
  const byBranch = new Map<string, { before: string; head: string }>();
  const actors: string[] = [];
  for (const push of [...fresh].reverse()) {
    const existing = byBranch.get(push.branch);
    byBranch.set(push.branch, { before: existing?.before || push.before, head: push.head });
    if (!actors.includes(push.actor)) actors.push(push.actor);
  }
  const described: BranchPush[] = [];
  for (const [branch, range] of byBranch) {
    described.push(await describeRange(repo, auth, branch, range.before, range.head));
  }

  const { title, body } = formatPushNotification(repo.displayName, actors, described);
  const target = pickTargetWorkspace(repo, [...byBranch.keys()]);
  const sourceKey = `github-push:${repo.key}`;
  // The policy's no-repeat rule would swallow the second push to a repository;
  // we only reach here for genuinely new event ids, so stand it down first.
  deps.rearm(sourceKey);
  deps.publish({
    kind: "git.teammate-push",
    sourceKey,
    tone: "success",
    soundKind: "done",
    // Informational: a toast and a bell entry, never a chime.
    silent: true,
    title,
    body,
    target: { type: "workspace", workspaceId: target.id, panel: "git" },
  });
}

// ── Scheduler ───────────────────────────────────────────────────────────────

function clearScheduled(): void {
  if (timer !== null) {
    deps.clearTimeout(timer);
    timer = null;
  }
}

function scheduleNextPass(): void {
  clearScheduled();
  if (!started) return;
  const now = deps.now();
  let earliest = Number.POSITIVE_INFINITY;
  for (const repo of repos.values()) {
    if (repo.paused) continue;
    if (repo.nextDueAt < earliest) earliest = repo.nextDueAt;
  }
  const wanted = Number.isFinite(earliest) ? earliest - now : GITHUB_PUSH_WATCH_MAX_TICK_MS;
  const delay = Math.max(1_000, Math.min(GITHUB_PUSH_WATCH_MAX_TICK_MS, wanted));
  timer = deps.setTimeout(() => {
    timer = null;
    void runGitHubPushWatchPass();
  }, delay);
}

export async function runGitHubPushWatchPass(): Promise<void> {
  if (!started || passRunning) return;
  passRunning = true;
  try {
    syncEventSubscription();
    if (!enabled() || !deps.isOnline()) return;
    const auth = await token();
    const now = deps.now();
    const due = [...repos.values()].filter((repo) => !repo.paused && repo.nextDueAt <= now);
    if (due.length === 0) return;
    if (!auth) {
      for (const repo of due) repo.nextDueAt = now + intervalMs();
      return;
    }
    const viewer = await resolveViewer(auth);
    if (!viewer) {
      for (const repo of due) repo.nextDueAt = now + intervalMs();
      return;
    }
    await Promise.all(due.map((repo) => limiter(() => pollRepo(repo, auth, viewer))));
  } catch (err) {
    deps.log(`pass failed: ${String(err)}`);
  } finally {
    passRunning = false;
    scheduleNextPass();
  }
}

export function nudgeGitHubPushWatch(): void {
  if (!started || !enabled()) return;
  const dueAt = deps.now() + 5_000 + jitter(5_000);
  for (const repo of repos.values()) {
    if (repo.paused || repo.backoffMs > 0) continue;
    if (repo.nextDueAt > dueAt) repo.nextDueAt = dueAt;
  }
  scheduleNextPass();
}

export async function startGitHubPushWatch(
  overrides: Partial<GitHubPushWatchDependencies> = {},
): Promise<void> {
  if (started) return;
  started = true;
  deps = { ...productionDependencies(), ...overrides };
  limiter = createLimiter(GITHUB_PUSH_WATCH_CONCURRENCY);
  unsubscribes.push(
    deps.onStateSaved((state) => {
      const fingerprint = workQueueRelevantFingerprint(state);
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      void queueRebuild(state);
    }),
  );
  const state = await deps.loadState();
  lastFingerprint = workQueueRelevantFingerprint(state);
  await queueRebuild(state);
}

export function stopGitHubPushWatch(): void {
  started = false;
  stopEvents?.();
  stopEvents = null;
  eventFingerprint = "";
  clearScheduled();
  for (const unsubscribe of unsubscribes.splice(0)) {
    try {
      unsubscribe();
    } catch {
      /* best-effort */
    }
  }
  repos = new Map();
  repoRefByCwd.clear();
  lastFingerprint = null;
  viewerLogin = null;
  viewerRetryAt = 0;
  cachedToken = null;
  passRunning = false;
}

export function waitForGitHubPushWatchRebuild(): Promise<void> {
  return rebuildChain;
}

export function getGitHubPushWatchSnapshot(): GitHubPushWatchSnapshot[] {
  return [...repos.values()].map((repo) => ({
    key: repo.key,
    cwds: repo.workspaces.map((workspace) => workspace.cwd),
    seeded: repo.seeded,
    paused: repo.paused,
    nextDueAt: repo.nextDueAt,
    backoffMs: repo.backoffMs,
  }));
}
