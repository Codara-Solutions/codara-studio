import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { isRemotePath } from "@shared/remote";
import {
  DEFAULT_GIT_AUTO_FETCH_INTERVAL_MINUTES,
  type AppPreferences,
  type AppState,
  type Workspace,
} from "@shared/types";
import {
  errorText,
  isGitNetworkOpInFlight,
  onGitNetworkOpSucceeded,
  runGit,
  type RunResult,
} from "./git-exec";
import { invalidateGitCache } from "./git-ops";
import { createLimiter, workQueueRelevantFingerprint } from "./github-work-queue";
import { getPreferenceCached } from "./preferences-store";
import { loadState, onStateSaved } from "./storage";

// Background auto-fetch: keeps every workspace's remote-tracking refs current
// so ahead/behind, the branch list and the history graph are right without the
// user pressing Fetch.
//
// One `git fetch` per unique repository (worktree workspaces share their
// parent's .git and are fetched once), on a timer, against the one remote the
// checked-out branch tracks. Remote refs are snapshotted before/after; when a
// ref moved, the Source Control panel is told to refresh.
//
// This module deliberately raises NO notifications. Attributing a push from
// local commit metadata means guessing identity from author/committer emails,
// which misfires on exactly the common case (a squash-merged PR is authored by
// a users.noreply.github.com address matching nobody's user.email, so the
// user's own merges looked like a teammate's). github-push-watch.ts owns
// "someone pushed" alerts and asks GitHub who pushed instead of inferring it.
//
// The whole point of this module is to be cheap:
//   - a chained, unref'd setTimeout to the next due repository — no heartbeat;
//   - at most GIT_AUTO_FETCH_CONCURRENCY fetches at once, each bounded by
//     GIT_AUTO_FETCH_TIMEOUT_MS;
//   - git's own background work (auto-gc, maintenance, commit-graph writes,
//     FETCH_HEAD) is switched off per invocation — that, not the network, is
//     what would make a fetch feel like a CPU spike;
//   - nothing runs while offline; the interval stretches ×5 while the machine
//     is idle; hard failures back off exponentially; auth failures pause the
//     repository until the user's next successful network op proves the
//     credentials work again;
//   - a no-change pass has zero side effects (no cache bust, no IPC);
//   - the first successful pass per repository seeds the snapshot silently, so
//     opening the app after a week away never produces a 137-commit alert.
//
// No `electron` import: the two electron-only probes (online / idle) and the
// renderer broadcast are injected by main/index.ts, which keeps this module
// bundle-able by the plain-node test harness (scripts/test-git-auto-fetch.cjs)
// with the same dependency-injection shape as github-work-queue.ts.

export const GIT_AUTO_FETCH_MAX_REPOS = 32;
export const GIT_AUTO_FETCH_CONCURRENCY = 2;
export const GIT_AUTO_FETCH_TIMEOUT_MS = 45_000;
export const GIT_AUTO_FETCH_MAX_REFS = 2_000;
export const GIT_AUTO_FETCH_IDLE_THRESHOLD_S = 900;
export const GIT_AUTO_FETCH_IDLE_MULTIPLIER = 5;
export const GIT_AUTO_FETCH_FIRST_DELAY_MS = 30_000;
export const GIT_AUTO_FETCH_MIN_TICK_MS = 10_000;
export const GIT_AUTO_FETCH_MAX_TICK_MS = 300_000;
export const GIT_AUTO_FETCH_MAX_BACKOFF_MS = 3_600_000;
export const GIT_AUTO_FETCH_NUDGE_DELAY_MS = 10_000;

const UNIT = "\x1f";

export interface GitAutoFetchDependencies {
  runGit(
    cwd: string,
    args: string[],
    opts?: { timeout?: number; env?: NodeJS.ProcessEnv; internal?: boolean },
  ): Promise<RunResult>;
  isGitNetworkOpInFlight(cwd: string): boolean;
  onGitNetworkOpSucceeded(listener: (cwd: string) => void): () => void;
  invalidateGitCache(cwd: string): void;
  loadState(): Promise<AppState>;
  onStateSaved(listener: (state: AppState) => void): () => void;
  getPreference<K extends keyof AppPreferences>(key: K): AppPreferences[K];
  canonicalizePath(p: string): Promise<string>;
  pathExists(p: string): Promise<boolean>;
  /** Electron `net.isOnline()`; injected by main/index.ts. */
  isOnline(): boolean;
  /** Electron `powerMonitor.getSystemIdleTime()` (seconds); injected. */
  idleSeconds(): number;
  /** ipc.broadcastGitRemoteUpdated; injected. */
  broadcastRemoteUpdated(cwds: string[]): void;
  env(): NodeJS.ProcessEnv;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
  log(message: string): void;
}

function productionDependencies(): GitAutoFetchDependencies {
  return {
    runGit,
    isGitNetworkOpInFlight,
    onGitNetworkOpSucceeded,
    invalidateGitCache,
    loadState,
    onStateSaved,
    getPreference: (key) => getPreferenceCached(key),
    canonicalizePath: (p) => realpath(p),
    pathExists: async (p) => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    },
    isOnline: () => true,
    idleSeconds: () => 0,
    broadcastRemoteUpdated: () => undefined,
    env: () => process.env,
    now: Date.now,
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    random: Math.random,
    log: (message) => console.warn(`[git-auto-fetch] ${message}`),
  };
}

// ── Git invocation shape ────────────────────────────────────────────────────

// Keep the user's git environment (credential helpers, url rewrites, proxies,
// ssh config) and only add the knobs that turn a would-be prompt into a fast
// failure. Deliberately NOT github-pull-request-git's hardenedGitEnvironment:
// that blanks global config and forbids ssh, which is right for untrusted PR
// import and would break every private-repo fetch here. GIT_SSH_COMMAND is
// left alone too — overriding it would clobber core.sshCommand users, and a
// tty-less ssh prompt already fails on its own (the timeout bounds the rest).
export function autoFetchEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    SSH_ASKPASS: "echo",
    SSH_ASKPASS_REQUIRE: "never",
    GCM_INTERACTIVE: "never",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

// The `-c` overrides are what keep a background fetch from turning into a
// CPU spike: git otherwise runs auto-gc / maintenance and rewrites the
// commit-graph after fetching. Expressed as config (not --no-auto-maintenance)
// so older gits accept them. No --prune: pruning behind the user's back can
// break @{upstream} in an open panel; the manual Fetch button stays the pruner.
// No --tags: tag-heavy repos pay real bandwidth for tags nobody is alerted on.
export function autoFetchGitArgs(remote: string): string[] {
  return [
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "fetch.writeCommitGraph=false",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.version=2",
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    "--no-recurse-submodules",
    "--no-show-forced-updates",
    "--",
    remote,
  ];
}

export type FetchFailureClass = "auth" | "soft" | "hard";

const AUTH_FAILURE =
  /could not read (Username|Password)|Authentication failed|terminal prompts disabled|Permission denied \(publickey|\b403\b|no such identity|Host key verification failed|unknown option/i;
const SOFT_FAILURE =
  /cannot lock ref|unable to (create|update)|\.lock.*File exists|Another git process|index\.lock/i;

// auth → pause the repository (retrying would only re-fail and, on some
//        setups, re-poke the credential manager). "unknown option" lands here
//        too: a git too old for our flags will never succeed on retry.
// soft → a user's own git invocation holds a lock; retry on the next pass
//        with no backoff escalation.
// hard → network / DNS / timeout; exponential backoff.
export function classifyFailure(message: string): FetchFailureClass {
  if (AUTH_FAILURE.test(message)) return "auth";
  if (SOFT_FAILURE.test(message)) return "soft";
  return "hard";
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export type RefSnapshot = Map<string, string>;

export interface RefChange {
  ref: string;
  oldSha: string | null;
  newSha: string;
}

export function parseRefSnapshot(stdout: string, cap = GIT_AUTO_FETCH_MAX_REFS): RefSnapshot {
  const refs: RefSnapshot = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const sep = line.indexOf(UNIT);
    if (sep <= 0) continue;
    const ref = line.slice(0, sep).trim();
    const sha = line.slice(sep + 1).trim();
    if (!ref || !sha) continue;
    refs.set(ref, sha);
    if (refs.size >= cap) break;
  }
  return refs;
}

// Deleted refs are ignored: we never prune, so a ref only disappears when the
// user pruned it themselves, and there is nothing to attribute.
export function diffSnapshots(before: RefSnapshot, after: RefSnapshot): RefChange[] {
  const changes: RefChange[] = [];
  for (const [ref, newSha] of after) {
    // Skip the symbolic remote HEAD: it moves with the default branch, which
    // is reported under its own ref.
    if (ref.endsWith("/HEAD")) continue;
    const oldSha = before.get(ref) ?? null;
    if (oldSha === newSha) continue;
    changes.push({ ref, oldSha, newSha });
  }
  return changes;
}

// ── Runtime state ───────────────────────────────────────────────────────────

interface RepoEntry {
  key: string;
  remote: string;
  workspaces: Workspace[];
  /** The workspace root git commands run in (first existing one). */
  cwd: string;
  displayName: string;
  nextDueAt: number;
  backoffMs: number;
  paused: boolean;
  seeded: boolean;
  lastRefs: RefSnapshot | null;
  lastFetchAt: number;
  nudgeAt: number | null;
}

export interface GitAutoFetchRepoSnapshot {
  key: string;
  remote: string;
  cwds: string[];
  nextDueAt: number;
  backoffMs: number;
  paused: boolean;
  seeded: boolean;
}

let deps: GitAutoFetchDependencies = productionDependencies();
let started = false;
let repos = new Map<string, RepoEntry>();
let timer: unknown = null;
let timerDueAt = Number.POSITIVE_INFINITY;
let passRunning = false;
let lastPassAt = 0;
let lastFingerprint: string | null = null;
let limiter = createLimiter(GIT_AUTO_FETCH_CONCURRENCY);
let rebuildChain: Promise<void> = Promise.resolve();
const unsubscribes: Array<() => void> = [];
// cwd → canonical common dir (null = not a repository). Process-lifetime memo
// so a state save that adds one workspace costs one rev-parse, not N.
const repoKeyByCwd = new Map<string, Promise<string | null>>();
const remoteByCwd = new Map<string, Promise<string | null>>();

function readText(cwd: string, args: string[]): Promise<string> {
  return deps
    .runGit(cwd, args, { internal: true })
    .then((r) => r.stdout.trim())
    .catch(() => "");
}

// `rev-parse --git-common-dir` prints a path relative to cwd on many gits
// (".git" from a main worktree), so resolve before canonicalizing. Lowercased
// on win32: realpath preserves drive/junction casing inconsistently.
function resolveRepoKey(cwd: string): Promise<string | null> {
  let pending = repoKeyByCwd.get(cwd);
  if (!pending) {
    pending = (async () => {
      const raw = await readText(cwd, ["rev-parse", "--git-common-dir"]);
      if (!raw) return null;
      const absolute = path.resolve(cwd, raw);
      let canonical = absolute;
      try {
        canonical = await deps.canonicalizePath(absolute);
      } catch {
        /* keep the resolved path */
      }
      return process.platform === "win32" ? canonical.toLowerCase() : canonical;
    })();
    repoKeyByCwd.set(cwd, pending);
  }
  return pending;
}

// The one remote worth fetching: what the checked-out branch tracks, else
// origin, else the sole remote. Two+ remotes with no origin (fork setups with
// odd names) are skipped rather than guessed — fetching the wrong one would
// spin auth failures forever.
function resolveRemote(cwd: string): Promise<string | null> {
  let pending = remoteByCwd.get(cwd);
  if (!pending) {
    pending = (async () => {
      const remotes = (await readText(cwd, ["remote"]))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (remotes.length === 0) return null;
      const branch = await readText(cwd, ["branch", "--show-current"]);
      if (branch) {
        const tracked = await readText(cwd, ["config", "--get", `branch.${branch}.remote`]);
        if (tracked && remotes.includes(tracked)) return tracked;
      }
      if (remotes.includes("origin")) return "origin";
      return remotes.length === 1 ? remotes[0] : null;
    })();
    remoteByCwd.set(cwd, pending);
  }
  return pending;
}

async function snapshotRemoteRefs(cwd: string, remote: string): Promise<RefSnapshot> {
  const { stdout } = await deps.runGit(
    cwd,
    ["for-each-ref", `--format=%(refname)${UNIT}%(objectname)`, `refs/remotes/${remote}/`],
    { internal: true },
  );
  return parseRefSnapshot(stdout);
}

function intervalMinutes(): number {
  const value = deps.getPreference("gitAutoFetchIntervalMinutes");
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? value
    : DEFAULT_GIT_AUTO_FETCH_INTERVAL_MINUTES;
}

function effectiveIntervalMs(): number {
  let ms = intervalMinutes() * 60_000;
  let idle = 0;
  try {
    idle = deps.idleSeconds();
  } catch {
    idle = 0;
  }
  if (idle > GIT_AUTO_FETCH_IDLE_THRESHOLD_S) ms *= GIT_AUTO_FETCH_IDLE_MULTIPLIER;
  return ms;
}

function enabled(): boolean {
  return deps.getPreference("gitAutoFetchEnabled") !== false;
}

function primaryWorkspace(workspaces: Workspace[]): Workspace {
  return workspaces.find((workspace) => !workspace.copyBranch) ?? workspaces[0];
}

function jitter(ms: number): number {
  return Math.floor(deps.random() * ms);
}

// ── Repo table ──────────────────────────────────────────────────────────────

async function rebuildRepoTable(state: AppState): Promise<void> {
  const now = deps.now();
  const next = new Map<string, RepoEntry>();
  let dropped = 0;
  for (const workspace of state.workspaces) {
    if (isRemotePath(workspace.cwd)) continue;
    if (!(await deps.pathExists(workspace.cwd))) continue;
    const key = await resolveRepoKey(workspace.cwd);
    if (!key) continue;
    const existing = next.get(key);
    if (existing) {
      existing.workspaces.push(workspace);
      continue;
    }
    if (next.size >= GIT_AUTO_FETCH_MAX_REPOS) {
      dropped += 1;
      continue;
    }
    const remote = await resolveRemote(workspace.cwd);
    if (!remote) continue;
    const previous = repos.get(key);
    next.set(key, {
      key,
      remote,
      workspaces: [workspace],
      cwd: workspace.cwd,
      displayName: workspace.name,
      nextDueAt:
        previous?.nextDueAt ??
        now + GIT_AUTO_FETCH_FIRST_DELAY_MS + jitter(GIT_AUTO_FETCH_FIRST_DELAY_MS),
      backoffMs: previous?.backoffMs ?? 0,
      paused: previous?.paused ?? false,
      seeded: previous?.seeded ?? false,
      lastRefs: previous?.lastRefs ?? null,
      lastFetchAt: previous?.lastFetchAt ?? 0,
      nudgeAt: previous?.nudgeAt ?? null,
    });
  }
  for (const entry of next.values()) {
    const primary = primaryWorkspace(entry.workspaces);
    entry.displayName = primary.name;
    entry.cwd = primary.cwd;
  }
  if (dropped > 0) {
    deps.log(
      `${dropped} repositor${dropped === 1 ? "y" : "ies"} beyond the ${GIT_AUTO_FETCH_MAX_REPOS}-repo cap are not auto-fetched`,
    );
  }
  repos = next;
  scheduleNextPass();
}

function queueRebuild(state: AppState): Promise<void> {
  rebuildChain = rebuildChain
    .then(() => (started ? rebuildRepoTable(state) : undefined))
    .catch((err) => {
      deps.log(`repo table rebuild failed: ${errorText(err)}`);
    });
  return rebuildChain;
}

// ── One repository, one pass ────────────────────────────────────────────────

async function runRepoPass(repo: RepoEntry, intervalMs: number): Promise<void> {
  const now = deps.now();
  if (repo.workspaces.some((workspace) => deps.isGitNetworkOpInFlight(workspace.cwd))) {
    // The user is pushing/pulling here right now; try again shortly.
    repo.nextDueAt = now + GIT_AUTO_FETCH_MIN_TICK_MS;
    return;
  }
  repo.nudgeAt = null;
  try {
    const before = repo.lastRefs ?? (await snapshotRemoteRefs(repo.cwd, repo.remote));
    await deps.runGit(repo.cwd, autoFetchGitArgs(repo.remote), {
      timeout: GIT_AUTO_FETCH_TIMEOUT_MS,
      env: autoFetchEnv(deps.env()),
      internal: true,
    });
    const after = await snapshotRemoteRefs(repo.cwd, repo.remote);
    repo.lastRefs = after;
    repo.backoffMs = 0;
    repo.lastFetchAt = deps.now();
    repo.nextDueAt = repo.nudgeAt ?? repo.lastFetchAt + intervalMs;
    if (!repo.seeded) {
      repo.seeded = true;
      return;
    }
    const changes = diffSnapshots(before, after);
    if (changes.length === 0) return;
    const cwds = repo.workspaces.map((workspace) => workspace.cwd);
    for (const cwd of cwds) deps.invalidateGitCache(cwd);
    deps.broadcastRemoteUpdated(cwds);
  } catch (err) {
    const message = errorText(err);
    const failure = classifyFailure(message);
    const at = deps.now();
    if (failure === "auth") {
      repo.paused = true;
      deps.log(
        `paused auto-fetch for ${repo.displayName} (${repo.remote}) until the next successful fetch/pull/push: ${message.split(/\r?\n/)[0]}`,
      );
      return;
    }
    if (failure === "soft") {
      repo.nextDueAt = at + GIT_AUTO_FETCH_MIN_TICK_MS;
      return;
    }
    repo.backoffMs = Math.min(
      GIT_AUTO_FETCH_MAX_BACKOFF_MS,
      repo.backoffMs > 0 ? repo.backoffMs * 2 : intervalMs * 2,
    );
    repo.nextDueAt = at + repo.backoffMs;
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────

function clearScheduled(): void {
  timerDueAt = Number.POSITIVE_INFINITY;
  if (timer !== null) {
    deps.clearTimeout(timer);
    timer = null;
  }
}

function scheduleNextPass(): void {
  if (!started || passRunning) return;
  const now = deps.now();
  let earliest = Number.POSITIVE_INFINITY;
  for (const repo of repos.values()) {
    if (repo.paused) continue;
    if (repo.nextDueAt < earliest) earliest = repo.nextDueAt;
  }
  // Nothing due (or the feature is off): still wake occasionally so a flipped
  // preference or an un-paused repository is noticed without a subscription.
  const wanted = Number.isFinite(earliest) ? earliest - now : GIT_AUTO_FETCH_MAX_TICK_MS;
  const urgent = [...repos.values()].some((repo) => !repo.paused && repo.nudgeAt !== null && repo.nextDueAt === repo.nudgeAt);
  const delay = Math.max(urgent ? 0 : GIT_AUTO_FETCH_MIN_TICK_MS, Math.min(GIT_AUTO_FETCH_MAX_TICK_MS, wanted));
  if (timer !== null && timerDueAt <= now + delay) return;
  clearScheduled();
  timerDueAt = now + delay;
  timer = deps.setTimeout(() => {
    timer = null;
    timerDueAt = Number.POSITIVE_INFINITY;
    void runGitAutoFetchPass();
  }, delay);
}

// One scheduler pass: fetch every due repository (bounded concurrency), then
// re-arm the timer for the next due one. Exported so tests — and a future
// "fetch everything now" action — can drive it directly.
export async function runGitAutoFetchPass(): Promise<void> {
  if (!started || passRunning) return;
  clearScheduled();
  passRunning = true;
  try {
    if (!enabled()) return;
    const now = deps.now();
    const intervalMs = effectiveIntervalMs();
    const due = [...repos.values()].filter((repo) => !repo.paused && repo.nextDueAt <= now);
    if (due.length === 0) return;
    if (!deps.isOnline()) {
      // Don't spin every tick while the network is down; the next
      // resume/focus nudge or the interval brings everything back.
      for (const repo of due) repo.nextDueAt = now + intervalMs;
      return;
    }
    lastPassAt = now;
    await Promise.all(due.map((repo) => limiter(() => runRepoPass(repo, intervalMs))));
  } catch (err) {
    deps.log(`pass failed: ${errorText(err)}`);
  } finally {
    passRunning = false;
    scheduleNextPass();
  }
}

// Bring every repository's next fetch forward (short jitter, never
// immediately). "resume" always nudges; "focus" only when the last pass is
// older than one interval, so ordinary alt-tabbing costs nothing.
// Webhook nudges coalesce without postponing an earlier deadline. A nudge
// received during fetch survives that fetch and schedules one follow-up.
export function nudgeGitAutoFetchNow(cwds?: readonly string[]): void {
  if (!started || !enabled()) return;
  const dueAt = deps.now() + jitter(500);
  for (const repo of repos.values()) {
    if (repo.paused || (cwds && !repo.workspaces.some((workspace) => cwds.includes(workspace.cwd)))) continue;
    repo.nudgeAt = Math.min(repo.nudgeAt ?? dueAt, dueAt);
    repo.nextDueAt = Math.min(repo.nextDueAt, repo.nudgeAt);
  }
  scheduleNextPass();
}

export function nudgeGitAutoFetch(reason: "resume" | "focus"): void {
  if (!started || !enabled()) return;
  const now = deps.now();
  if (reason === "focus" && now - lastPassAt < effectiveIntervalMs()) return;
  const dueAt = now + GIT_AUTO_FETCH_NUDGE_DELAY_MS + jitter(GIT_AUTO_FETCH_NUDGE_DELAY_MS / 2);
  for (const repo of repos.values()) {
    if (repo.paused) continue;
    if (repo.nextDueAt > dueAt) repo.nextDueAt = dueAt;
  }
  scheduleNextPass();
}

function installHooks(): void {
  unsubscribes.push(
    deps.onStateSaved((state) => {
      const fingerprint = workQueueRelevantFingerprint(state);
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      void queueRebuild(state);
    }),
  );
  unsubscribes.push(
    deps.onGitNetworkOpSucceeded((cwd) => {
      for (const repo of repos.values()) {
        if (!repo.workspaces.some((workspace) => workspace.cwd === cwd)) continue;
        // The user just fetched/pushed here successfully: credentials work
        // again, and whatever they pulled in is on their screen — drop the
        // snapshot so the next pass re-seeds instead of re-reporting it.
        repo.paused = false;
        repo.backoffMs = 0;
        repo.lastRefs = null;
      }
      scheduleNextPass();
    }),
  );
}

export async function startGitAutoFetch(
  overrides: Partial<GitAutoFetchDependencies> = {},
): Promise<void> {
  if (started) return;
  started = true;
  deps = { ...productionDependencies(), ...overrides };
  limiter = createLimiter(GIT_AUTO_FETCH_CONCURRENCY);
  installHooks();
  const state = await deps.loadState();
  lastFingerprint = workQueueRelevantFingerprint(state);
  await queueRebuild(state);
}

export function stopGitAutoFetch(): void {
  started = false;
  clearScheduled();
  for (const unsubscribe of unsubscribes.splice(0)) {
    try {
      unsubscribe();
    } catch {
      /* best-effort */
    }
  }
  repos = new Map();
  repoKeyByCwd.clear();
  remoteByCwd.clear();
  lastFingerprint = null;
  lastPassAt = 0;
  passRunning = false;
}

// Resolves once any queued repo-table rebuild has settled (tests).
export function waitForGitAutoFetchRebuild(): Promise<void> {
  return rebuildChain;
}

// Test/diagnostic view of the repo table.
export function getGitAutoFetchSnapshot(): GitAutoFetchRepoSnapshot[] {
  return [...repos.values()].map((repo) => ({
    key: repo.key,
    remote: repo.remote,
    cwds: repo.workspaces.map((workspace) => workspace.cwd),
    nextDueAt: repo.nextDueAt,
    backoffMs: repo.backoffMs,
    paused: repo.paused,
    seeded: repo.seeded,
  }));
}
