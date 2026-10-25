// Agent session search, main side: where each agent keeps its transcripts,
// when the index thread runs and at what pace, and the channels the renderer
// and the agent tool reach it through. The index itself lives on its own
// thread (session-index-worker.ts); nothing here parses a transcript.
//
// Pacing rules:
// - automatic passes run at background pace, wait while the computer is on
//   battery or busy, and start only when one is due (first build shortly
//   after launch, then every SYNC_EVERY_MS);
// - opening the panel or pressing Refresh runs an interactive pass, which
//   never waits;
// - the thread is stopped after IDLE_STOP_MS without work, so an idle app
//   holds none of its memory.

import { promises as fs, readFileSync, realpathSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { BrowserWindow, powerMonitor, shell } from "electron";

import {
  DEFAULT_SESSION_SEARCH_PREFERENCES,
  EMPTY_SESSION_SEARCH_STATUS,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  isSessionSearchAgent,
  normalizeSessionSearchPreferences,
  sessionCwdKey,
  type SessionSearchAgent,
  type SessionSearchHit,
  type SessionSearchPreferences,
  type SessionSearchRequest,
  type SessionSearchResult,
  type SessionSearchScope,
  type SessionSearchStatus,
  type SessionTranscript,
} from "@shared/session-search";
import { codaraHome } from "../codara-home";
import type { IpcHandle } from "../ipc";
import { getPreferenceCached, loadPreferences, onPreferenceChange, setPreference } from "../preferences-store";
import { provideAgentSessionSearch, type AgentSessionSearch } from "../preview-tools/session-search";
import type { IndexSessionRecord, IndexStats, SessionSourceRoot } from "./session-index";
import type { IndexPace, SessionIndexJob, SessionIndexMessage } from "./session-index-worker";

/** The index thread's heap cap; scripts/profile-session-index.cjs measures with the same. */
export const SESSION_INDEX_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 };

const WORKER_FILE = "session-index-worker.js";
const INDEX_DIR = "session-index";
const INDEX_FILE = "sessions.sqlite";
const IDLE_STOP_MS = 3 * 60_000;
const FIRST_BUILD_DELAY_MS = 10_000;
const BOOT_SYNC_DELAY_MS = 60_000;
const TICK_MS = 60_000;
const SYNC_EVERY_MS = 10 * 60_000;
/** An index synced this recently is fresh enough for a panel that just opened. */
const FRESH_MS = 60_000;
const PAUSE_CHECK_MS = 15_000;
/** One-minute load per core above which the computer counts as busy. */
const BUSY_LOAD_PER_CORE = 0.85;
const TRANSCRIPT_MESSAGES = 400;
/** Words around a match: what fits the rail's two lines, and more for an agent. */
const RAIL_SNIPPET_TOKENS = 10;
const AGENT_SNIPPET_TOKENS = 36;
const SEARCH_LIMIT_MAX = 100;
const STATUS_BROADCAST_MS = 250;
const PROJECT_SCOPE_TTL_MS = 60_000;

// ── Environment ───────────────────────────────────────────────────────────

const E2E = process.env.SPARK_E2E_BACKGROUND !== undefined;
/** e2e runs never see the intro dialog unless a spec asks for it. */
const INTRO_ALLOWED = !E2E || process.env.CODARA_E2E_SESSION_SEARCH_INTRO === "1";
/** e2e runs index only on demand unless a spec asks for automatic passes. */
const AUTO_INDEX_ALLOWED = !E2E || process.env.CODARA_E2E_SESSION_SEARCH === "1" || INTRO_ALLOWED;

export function sessionIndexPath(): string {
  return join(codaraHome(), INDEX_DIR, INDEX_FILE);
}

function preferences(): SessionSearchPreferences {
  return normalizeSessionSearchPreferences(
    getPreferenceCached("sessionSearch") ?? DEFAULT_SESSION_SEARCH_PREFERENCES,
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Transcript folders ────────────────────────────────────────────────────

/**
 * Every folder an agent writes transcripts to, resolved through the same
 * helpers the launch paths use and deduped by real path (Codara's Claude
 * home links its projects folder to the personal one). Missing folders are
 * left out.
 */
export async function resolveSessionRoots(): Promise<SessionSourceRoot[]> {
  const candidates: SessionSourceRoot[] = [];
  try {
    const { defaultPersonalClaudeConfigDir, codaraClaudeCliAccountRootDir } = await import(
      "../orchestration/claude-cli-account-profiles"
    );
    candidates.push({ agent: "claude", dir: join(defaultPersonalClaudeConfigDir(), "projects") });
    const { claudeLiveConfigDir } = await import("../orchestration/claude-cli-live-login");
    candidates.push({ agent: "claude", dir: join(claudeLiveConfigDir(codaraClaudeCliAccountRootDir()), "projects") });
  } catch {
    // An unreadable account layout hides Claude's sessions, nothing else.
  }
  try {
    const { resolveCodexHomePaths } = await import("../orchestration/codex-home");
    const { sessionsRoot } = resolveCodexHomePaths();
    candidates.push({ agent: "codex", dir: sessionsRoot });
    candidates.push({ agent: "codex", dir: join(dirname(sessionsRoot), "archived_sessions") });
  } catch {
    // resolveCodexHomePaths refuses a home it does not recognize.
  }
  try {
    const { grokSessionsRoot } = await import("../orchestration/grok-sessions");
    candidates.push({ agent: "grok", dir: grokSessionsRoot() });
  } catch {
    // Grok is optional.
  }
  const { piAgentDir } = await import("../pi-session-tracker");
  candidates.push({ agent: "pi", dir: join(piAgentDir(), "sessions") });
  candidates.push({ agent: "cora", dir: join(codaraHome(), "runs") });

  const roots: SessionSourceRoot[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let real: string;
    try {
      real = await fs.realpath(candidate.dir);
      if (!(await fs.stat(real)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push({ agent: candidate.agent, dir: real });
  }
  return roots;
}

async function anyTranscriptFolderHasEntries(agents: readonly SessionSearchAgent[]): Promise<boolean> {
  for (const root of await resolveSessionRoots()) {
    if (!agents.includes(root.agent)) continue;
    const dir = await fs.opendir(root.dir).catch(() => null);
    if (!dir) continue;
    try {
      if ((await dir.read()) !== null) return true;
    } finally {
      await dir.close().catch(() => undefined);
    }
  }
  return false;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

// ── Scope ─────────────────────────────────────────────────────────────────

const projectFolders = new Map<string, { at: number; folders: string[] }>();

/** The folders of every worktree of `cwd`'s repository, Codara's removed ones included. */
async function projectFoldersFor(cwd: string): Promise<string[]> {
  const cached = projectFolders.get(cwd);
  if (cached && Date.now() - cached.at < PROJECT_SCOPE_TTL_MS) return cached.folders;
  const folders = new Set<string>();
  try {
    const { listWorktreeRegistrations, managedWorktreesRoot } = await import("../git-worktrees");
    const registrations = await listWorktreeRegistrations(cwd);
    for (const registration of registrations) folders.add(registration.path);
    // The first registration is the main checkout; Codara's worktrees of it
    // live under one folder, which still holds the sessions of removed ones.
    if (registrations[0]) folders.add(managedWorktreesRoot(codaraHome(), registrations[0].path));
  } catch {
    // Not a repository: the project is the folder itself.
  }
  const list = [...folders];
  projectFolders.set(cwd, { at: Date.now(), folders: list });
  return list;
}

/** The folder keys a scope admits, or null for every session. */
export async function scopeKeysFor(scope: SessionSearchScope, cwd: string | null): Promise<string[] | null> {
  if (scope === "all" || !cwd) return null;
  const folders = new Set<string>([resolve(cwd)]);
  try {
    folders.add(realpathSync.native(cwd));
  } catch {
    // A folder that is gone still scopes by its name.
  }
  if (scope === "project") {
    for (const folder of await projectFoldersFor(cwd)) folders.add(folder);
  }
  return [...folders].map((folder) => sessionCwdKey(folder, process.platform));
}

// ── The index thread ──────────────────────────────────────────────────────

let cachedWorkerCode: string | null | undefined;

// Run from source text (`eval: true`) so loading never depends on the thread
// resolving a path inside the packaged app's asar. The build writes it to
// out/main; this module may itself land in out/main/chunks.
function workerCode(): string | null {
  if (cachedWorkerCode !== undefined) return cachedWorkerCode;
  cachedWorkerCode = null;
  for (const dir of [__dirname, dirname(__dirname)]) {
    try {
      cachedWorkerCode = readFileSync(join(dir, WORKER_FILE), "utf8");
      break;
    } catch {
      // Not here; try the parent of a chunk directory.
    }
  }
  return cachedWorkerCode;
}

type JobInput = SessionIndexJob extends infer J ? (J extends { id: number } ? Omit<J, "id"> : never) : never;

interface PendingJob {
  resolve: (value: unknown) => void;
  reject: (err: Error & { aborted?: boolean }) => void;
}

let worker: Worker | null = null;
let opened: Promise<void> | null = null;
let nextJobId = 1;
const pending = new Map<number, PendingJob>();
let idleTimer: NodeJS.Timeout | null = null;

function settleAll(err: Error): void {
  for (const job of pending.values()) job.reject(err);
  pending.clear();
}

function startWorker(code: string): Worker {
  const thread = new Worker(code, { eval: true, resourceLimits: SESSION_INDEX_RESOURCE_LIMITS });
  thread.unref();
  thread.on("message", (message: SessionIndexMessage) => {
    if (message.type === "progress") {
      onPassProgress(message.filesTotal, message.filesDone);
      return;
    }
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    if (message.ok) job.resolve(message.value);
    else job.reject(Object.assign(new Error(message.error), { aborted: message.aborted === true }));
  });
  const lost = (reason: string) => {
    if (worker === thread) {
      worker = null;
      opened = null;
    }
    settleAll(new Error(reason));
  };
  thread.on("error", (err) => lost(`The session index stopped: ${messageOf(err)}`));
  thread.on("exit", (code) => lost(`The session index exited (code ${code}).`));
  return thread;
}

function call<T>(job: JobInput): Promise<T> {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const code = workerCode();
  if (code === null) return Promise.reject(new Error("Session search is not part of this build."));
  if (worker === null) worker = startWorker(code);
  const thread = worker;
  const id = nextJobId++;
  return new Promise<T>((resolvePromise, reject) => {
    pending.set(id, {
      resolve: (value) => {
        resolvePromise(value as T);
        if (pending.size === 0) armIdleStop();
      },
      reject: (err) => {
        reject(err);
        if (pending.size === 0) armIdleStop();
      },
    });
    thread.postMessage({ ...job, id });
  });
}

function control(message: { type: "pace"; pace: IndexPace } | { type: "pause"; paused: boolean } | { type: "abort" }): void {
  worker?.postMessage(message);
}

async function ensureOpen(): Promise<void> {
  if (!opened) {
    const attempt = call<IndexStats>({ type: "open", dbPath: sessionIndexPath(), platform: process.platform }).then(
      (stats) => applyStats(stats),
    );
    opened = attempt;
    attempt.catch(() => {
      if (opened === attempt) opened = null;
    });
  }
  return opened;
}

function armIdleStop(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size > 0 || pass !== null) return;
    void stopWorker();
  }, IDLE_STOP_MS);
  idleTimer.unref();
}

/** Closes the index cleanly (bounded) and ends the thread. */
async function stopWorker(): Promise<void> {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const thread = worker;
  if (!thread) return;
  control({ type: "abort" });
  await Promise.race([
    call({ type: "close" }).catch(() => undefined),
    new Promise<void>((done) => setTimeout(done, 2_000).unref()),
  ]);
  if (worker === thread) {
    worker = null;
    opened = null;
  }
  await thread.terminate().catch(() => undefined);
}

// ── Status ────────────────────────────────────────────────────────────────

let status: SessionSearchStatus = { ...EMPTY_SESSION_SEARCH_STATUS };
let statsLoaded = false;
let sourcesFound = false;
let broadcastTimer: NodeJS.Timeout | null = null;
let lastBroadcastAt = 0;

function broadcastNow(): void {
  lastBroadcastAt = Date.now();
  // App windows only: preview pages are webContents too.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send("sessionSearch:status", status);
  }
}

function setStatus(patch: Partial<SessionSearchStatus>, opts: { throttle?: boolean } = {}): void {
  const prefs = preferences();
  status = {
    ...status,
    ...patch,
    enabled: prefs.enabled,
    introPending: prefs.enabled && !prefs.introSeen && INTRO_ALLOWED && sourcesFound,
  };
  if (!prefs.enabled) status.phase = "off";
  if (!opts.throttle) {
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    broadcastNow();
    return;
  }
  if (broadcastTimer) return;
  const wait = Math.max(0, STATUS_BROADCAST_MS - (Date.now() - lastBroadcastAt));
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastNow();
  }, wait);
}

function applyStats(stats: IndexStats): void {
  statsLoaded = true;
  if (stats.lastSyncAt) lastPassAt = Math.max(lastPassAt, stats.lastSyncAt);
  setStatus({
    sessions: stats.sessions,
    messages: stats.messages,
    firstBuild: !stats.built,
    lastSyncAt: stats.lastSyncAt,
  });
  void measureIndexBytes();
}

async function measureIndexBytes(): Promise<void> {
  let bytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const stat = await fs.stat(`${sessionIndexPath()}${suffix}`).catch(() => null);
    if (stat) bytes += stat.size;
  }
  if (bytes !== status.indexBytes) setStatus({ indexBytes: bytes });
}

let statsRefreshAt = 0;

function onPassProgress(filesTotal: number, filesDone: number): void {
  setStatus({ filesTotal, filesDone }, { throttle: true });
  // The message count climbs during a build; a stats read is a few ms.
  const now = Date.now();
  if (now - statsRefreshAt > 1_500 || filesDone === filesTotal) {
    statsRefreshAt = now;
    void call<IndexStats>({ type: "stats" })
      .then((stats) => setStatus({ sessions: stats.sessions, messages: stats.messages }, { throttle: true }))
      .catch(() => undefined);
  }
}

// ── Passes ────────────────────────────────────────────────────────────────

interface RunningPass {
  promise: Promise<void>;
  pace: IndexPace;
}

let pass: RunningPass | null = null;
let lastPassAt = 0;
/** A pass is due before the usual interval (the agents to index changed). */
let passWanted = false;
let tickTimer: NodeJS.Timeout | null = null;
let pauseTimer: NodeJS.Timeout | null = null;
let started = false;

function onBattery(): boolean {
  try {
    return powerMonitor.isOnBatteryPower();
  } catch {
    return false;
  }
}

function busy(): boolean {
  // Windows reports no load average.
  if (process.platform === "win32") return false;
  const cores = Math.max(1, cpus().length);
  return loadavg()[0] / cores > BUSY_LOAD_PER_CORE;
}

function waitReason(): SessionSearchStatus["pausedReason"] {
  if (onBattery()) return "battery";
  if (busy()) return "busy";
  return null;
}

function watchPause(): void {
  if (pauseTimer) clearInterval(pauseTimer);
  pauseTimer = setInterval(() => {
    if (!pass || pass.pace !== "background") return;
    const reason = waitReason();
    control({ type: "pause", paused: reason !== null });
    setStatus({ phase: reason ? "paused" : "indexing", pausedReason: reason });
  }, PAUSE_CHECK_MS);
  pauseTimer.unref();
}

function runPass(pace: IndexPace): Promise<void> {
  if (pass) {
    if (pace === "interactive" && pass.pace !== "interactive") {
      pass.pace = "interactive";
      control({ type: "pace", pace });
      control({ type: "pause", paused: false });
      setStatus({ phase: "indexing", pausedReason: null });
    }
    return pass.promise;
  }
  const prefs = preferences();
  if (!prefs.enabled) return Promise.resolve();
  passWanted = false;
  const current: RunningPass = { pace, promise: Promise.resolve() };
  current.promise = (async () => {
    setStatus({ phase: "indexing", pausedReason: null, filesTotal: 0, filesDone: 0, error: null });
    try {
      await ensureOpen();
      const roots = await resolveSessionRoots();
      await call({ type: "sync", roots, agents: prefs.agents, pace: current.pace });
      lastPassAt = Date.now();
      applyStats(await call<IndexStats>({ type: "stats" }));
      setStatus({ phase: "idle", pausedReason: null });
    } catch (err) {
      const failed = (err as { aborted?: boolean }).aborted !== true && preferences().enabled;
      setStatus({ phase: failed ? "error" : "idle", pausedReason: null, error: failed ? messageOf(err) : null });
    } finally {
      if (pass === current) pass = null;
      if (pauseTimer) {
        clearInterval(pauseTimer);
        pauseTimer = null;
      }
      // A change that came in during the pass (agents added) gets its own.
      if (passWanted && preferences().enabled) scheduleTick(2_000);
    }
  })();
  pass = current;
  if (pace === "background") watchPause();
  return current.promise;
}

async function stopPass(): Promise<void> {
  const running = pass;
  if (!running) return;
  control({ type: "abort" });
  await running.promise.catch(() => undefined);
}

function scheduleTick(delayMs: number): void {
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = setTimeout(() => void tick(), delayMs);
  tickTimer.unref();
}

async function tick(): Promise<void> {
  tickTimer = null;
  const prefs = preferences();
  if (!prefs.enabled || !AUTO_INDEX_ALLOWED) return;
  const due = !pass && (passWanted || Date.now() - lastPassAt >= SYNC_EVERY_MS);
  // On battery or busy, a due pass waits for a later tick.
  if (due && waitReason() === null) await runPass("background");
  scheduleTick(TICK_MS);
}

async function indexFileExists(): Promise<boolean> {
  return (await fs.stat(sessionIndexPath()).catch(() => null)) !== null;
}

async function refreshSourcesFound(): Promise<void> {
  const prefs = preferences();
  sourcesFound = prefs.enabled && !prefs.introSeen && INTRO_ALLOWED
    ? await anyTranscriptFolderHasEntries(prefs.agents).catch(() => false)
    : sourcesFound;
  setStatus({});
}

function onPreferencesChanged(previous: SessionSearchPreferences, next: SessionSearchPreferences): void {
  if (previous.enabled && !next.enabled) {
    void stopPass().then(() => stopWorker());
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = null;
    setStatus({ phase: "off", pausedReason: null, filesDone: 0, filesTotal: 0 });
    return;
  }
  if (!previous.enabled && next.enabled) {
    lastPassAt = 0;
    setStatus({ phase: "idle", error: null });
    void refreshSourcesFound();
    scheduleTick(FIRST_BUILD_DELAY_MS);
    return;
  }
  if (next.enabled && previous.agents.join() !== next.agents.join()) {
    // Agents taken out are dropped by the next pass; agents added are read.
    passWanted = true;
    scheduleTick(2_000);
  }
  setStatus({});
}

/** Starts automatic indexing. Called once the main window exists. */
export async function startSessionSearch(): Promise<void> {
  if (started) return;
  started = true;
  await loadPreferences();
  let previous = preferences();
  onPreferenceChange((key) => {
    if (key !== "sessionSearch") return;
    const next = preferences();
    const before = previous;
    previous = next;
    onPreferencesChanged(before, next);
  });
  const exists = await indexFileExists();
  setStatus({ phase: previous.enabled ? "idle" : "off", firstBuild: !exists });
  if (!previous.enabled) return;
  await refreshSourcesFound();
  scheduleTick(exists ? BOOT_SYNC_DELAY_MS : FIRST_BUILD_DELAY_MS);
}

/** Quit: abandon a pass and close the index. Bounded. */
export async function stopSessionSearch(): Promise<void> {
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = null;
  if (pauseTimer) clearInterval(pauseTimer);
  pauseTimer = null;
  await stopWorker();
}

// ── Answers ───────────────────────────────────────────────────────────────

/**
 * The status as last known. With `load`, an index on disk that has not been
 * read since launch is opened for its numbers (Settings shows them); without
 * it, asking never starts the index thread.
 */
export function sessionSearchStatus(load = false): SessionSearchStatus {
  const prefs = preferences();
  if (load && prefs.enabled && !statsLoaded && started) {
    statsLoaded = true;
    void indexFileExists().then((exists) => (exists ? ensureOpen().catch(() => undefined) : undefined));
  }
  return { ...status, enabled: prefs.enabled };
}

/** Starts an interactive pass when the index is stale (or always, with force). */
export function refreshSessionIndex(force: boolean): SessionSearchStatus {
  if (preferences().enabled && (force || pass !== null || Date.now() - lastPassAt > FRESH_MS)) {
    void runPass("interactive");
  }
  return sessionSearchStatus();
}

function selectedAgents(requested: readonly SessionSearchAgent[] | null | undefined): SessionSearchAgent[] {
  const enabled = preferences().agents;
  const wanted = (requested ?? []).filter(isSessionSearchAgent);
  return wanted.length === 0 ? enabled : enabled.filter((agent) => wanted.includes(agent));
}

async function folderExists(path: string | null, memo: Map<string, Promise<boolean>>): Promise<boolean> {
  if (!path) return false;
  let known = memo.get(path);
  if (!known) {
    known = fs
      .stat(path)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    memo.set(path, known);
  }
  return known;
}

export async function searchSessions(
  raw: SessionSearchRequest,
  snippetTokens = RAIL_SNIPPET_TOKENS,
): Promise<SessionSearchResult> {
  const t0 = Date.now();
  if (!preferences().enabled) return { hits: [], hasMore: false, tookMs: 0, status: sessionSearchStatus() };
  try {
    return await searchIndex(raw, snippetTokens, t0);
  } catch (err) {
    setStatus({ phase: "error", error: messageOf(err) });
    return { hits: [], hasMore: false, tookMs: Date.now() - t0, status: sessionSearchStatus() };
  }
}

async function searchIndex(raw: SessionSearchRequest, snippetTokens: number, t0: number): Promise<SessionSearchResult> {
  const request = raw && typeof raw === "object" ? raw : ({} as SessionSearchRequest);
  const scope: SessionSearchScope =
    request.scope === "workspace" || request.scope === "project" ? request.scope : "all";
  const cwd = typeof request.cwd === "string" && request.cwd ? request.cwd : null;
  const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(Number(request.limit) || 40)));
  const offset = Math.max(0, Math.floor(Number(request.offset) || 0));
  await ensureOpen();
  const found = await call<{ hits: Omit<SessionSearchHit, "cwdExists">[]; hasMore: boolean }>({
    type: "search",
    input: {
      query: typeof request.query === "string" ? request.query.slice(0, 512) : "",
      agents: selectedAgents(request.agents),
      scopeKeys: await scopeKeysFor(scope, cwd),
      limit,
      offset,
      now: Date.now(),
      snippetTokens,
    },
  });
  const memo = new Map<string, Promise<boolean>>();
  const hits = await Promise.all(
    found.hits.map(async (hit) => ({ ...hit, cwdExists: await folderExists(hit.cwd, memo) })),
  );
  return { hits, hasMore: found.hasMore, tookMs: Date.now() - t0, status: sessionSearchStatus() };
}

async function sessionRecord(key: unknown): Promise<IndexSessionRecord | null> {
  if (typeof key !== "string" || key.length > 300 || !preferences().enabled) return null;
  await ensureOpen();
  return call<IndexSessionRecord | null>({ type: "session", key });
}

/** The transcript file, only when it sits inside a folder the index reads. */
async function verifiedTranscriptPath(record: IndexSessionRecord): Promise<string | null> {
  if (!record.transcriptPath) return null;
  let real: string;
  try {
    real = await fs.realpath(record.transcriptPath);
  } catch {
    return null;
  }
  const roots = await resolveSessionRoots();
  return roots.some((root) => root.agent === record.agent && isUnder(real, root.dir)) ? real : null;
}

export async function sessionTranscript(key: unknown): Promise<SessionTranscript | null> {
  if (typeof key !== "string" || key.length > 300 || !preferences().enabled) return null;
  await ensureOpen();
  return call<SessionTranscript | null>({ type: "transcript", key, limit: TRANSCRIPT_MESSAGES });
}

export async function revealSessionTranscript(key: unknown): Promise<boolean> {
  const record = await sessionRecord(key);
  if (!record) return false;
  const path = await verifiedTranscriptPath(record);
  if (!path) return false;
  shell.showItemInFolder(path);
  return true;
}

export async function rebuildSessionIndex(): Promise<SessionSearchStatus> {
  if (!preferences().enabled) return sessionSearchStatus();
  await stopPass();
  if (opened) await call({ type: "remove" }).catch(() => undefined);
  opened = null;
  await removeIndexFiles();
  lastPassAt = 0;
  setStatus({ sessions: 0, messages: 0, indexBytes: 0, firstBuild: true, lastSyncAt: null, error: null });
  void runPass("interactive");
  return sessionSearchStatus();
}

async function removeIndexFiles(): Promise<void> {
  const path = sessionIndexPath();
  await Promise.all(["", "-wal", "-shm", "-journal"].map((suffix) => fs.rm(`${path}${suffix}`, { force: true })));
  await fs.rmdir(dirname(path)).catch(() => undefined);
}

async function setPreferences(next: SessionSearchPreferences): Promise<void> {
  await setPreference("sessionSearch", next);
  const { broadcastPreferencesChanged } = await import("../ipc");
  broadcastPreferencesChanged({ key: "sessionSearch", value: next });
}

/** Deletes the index and turns search off, so nothing rebuilds it. */
export async function deleteSessionIndex(): Promise<SessionSearchStatus> {
  await stopPass();
  await stopWorker();
  await removeIndexFiles();
  lastPassAt = 0;
  statsLoaded = false;
  setStatus({ sessions: 0, messages: 0, indexBytes: 0, firstBuild: true, lastSyncAt: null, filesDone: 0, filesTotal: 0 });
  await setPreferences({ ...preferences(), enabled: false });
  return sessionSearchStatus();
}

/** The intro dialog closed: never show it again, and let the build continue at background pace. */
export async function dismissSessionSearchIntro(): Promise<SessionSearchStatus> {
  if (pass && pass.pace === "interactive") {
    pass.pace = "background";
    control({ type: "pace", pace: "background" });
    watchPause();
  }
  const prefs = preferences();
  if (!prefs.introSeen) await setPreferences({ ...prefs, introSeen: true });
  return sessionSearchStatus();
}

// ── The agent tool ────────────────────────────────────────────────────────

const AGENT_SNIPPET_CHARS = 240;

/**
 * codara_session_search: the calling workspace's project only, unless the
 * person chose every session in Settings. Snippets are short and unmarked.
 */
export const searchSessionsForAgent: AgentSessionSearch = async (input) => {
  const prefs = preferences();
  if (!prefs.enabled) return { error: "Agent session search is turned off in Codara Settings." };
  const scope = prefs.agentToolScope === "all" ? "all" : "project";
  if (scope === "project" && !input.cwd) return { error: "This session has no local Codara workspace to search from." };
  const result = await searchSessions(
    { query: input.query, scope, cwd: input.cwd, limit: Math.max(1, Math.min(20, input.limit)) },
    AGENT_SNIPPET_TOKENS,
  );
  const strip = (text: string | null) =>
    text === null
      ? null
      : text.split(SNIPPET_MARK_START).join("").split(SNIPPET_MARK_END).join("").slice(0, AGENT_SNIPPET_CHARS);
  return {
    scope,
    hits: result.hits.map((hit) => ({
      agent: hit.agent,
      sessionId: hit.sessionId,
      title: hit.title.slice(0, 200),
      snippet: strip(hit.snippet),
      cwd: hit.cwd,
      lastAt: hit.lastAt ? new Date(hit.lastAt).toISOString() : null,
      messageCount: hit.messageCount,
    })),
  };
};

provideAgentSessionSearch(searchSessionsForAgent);

// ── Channels ──────────────────────────────────────────────────────────────

export function registerSessionSearchIpc(handle: IpcHandle): void {
  handle("sessionSearch:status", (_event, load: unknown) => sessionSearchStatus(load === true));
  handle("sessionSearch:search", (_event, request: SessionSearchRequest) => searchSessions(request));
  handle("sessionSearch:refresh", (_event, force: unknown) => refreshSessionIndex(force === true));
  handle("sessionSearch:transcript", (_event, key: unknown) => sessionTranscript(key));
  handle("sessionSearch:reveal", (_event, key: unknown) => revealSessionTranscript(key));
  handle("sessionSearch:rebuild", () => rebuildSessionIndex());
  handle("sessionSearch:delete", () => deleteSessionIndex());
  handle("sessionSearch:dismiss-intro", () => dismissSessionSearchIntro());
}
