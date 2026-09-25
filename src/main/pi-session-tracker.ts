// Session identity for the user's own `pi` running in Studio panes, so a Pi
// pane can come back with `pi --session <id>` after a restart.
//
// Pi has no hook and prints nothing that names its session while it runs.
// Its session file, `<agent dir>/sessions/--<cwd>--/<created>_<id>.jsonl`,
// appears only after the first reply and is opened and closed on every
// write, so neither a startup banner nor lsof can tie it to a process. The
// tracker attributes files to processes from what it can observe instead:
// every Pi process the user runs while a pane has one (ps), when it started
// and when it was last seen, its working directory (lsof, /proc), and the
// creation stamp Pi writes into each file name. It reads file names and
// modification times only; transcripts stay unread.
//
// A file created at t, among the Pi processes known in its directory:
//   - exactly one was running at t: it created the file, at startup or with
//     /new, /fork or /clone;
//   - several were: the most recently started one, if it started at most
//     STARTUP_SESSION_WINDOW_MS before t, since a fresh `pi` creates its
//     session half a second after launch;
//   - otherwise the file is ambiguous and nobody claims it.
// Processes that already exited stay known, so a file left behind by a Pi in
// another terminal is never handed to a pane. A pane binds the attributed
// file it wrote most recently. A file created before its process started
// (`pi --session`, `--continue`, /resume) is never attributed, so a restored
// pane keeps the binding it was restored from. Cora's own Pi processes,
// children of the app, write to Codara's session directory and are ignored.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeFromProcessCommand } from "@shared/agent-patterns";
import { agentProcessForPane } from "./codex-session-tracker";
import { latestSessionStart, recordSessionStart, type SessionStartRecord } from "./agent-session-registry";
import { listProcessesWithCommands, processStartMs } from "./owned-process-tree";

interface ProcessEntry { pid: number; parentPid: number; startedAt: string; command: string }

export interface PiTrackedPane {
  paneId: string;
  pid: number;
  generationId: string;
}

const REFRESH_MS = 3_000;
// A process last seen at a refresh may have run until just before the next.
const EXIT_SLACK_MS = REFRESH_MS + 1_000;
const STARTUP_SESSION_WINDOW_MS = 10_000;
// Pi's own id rule (assertValidSessionId), narrowed to what the session
// registry and the resume command accept.
const SESSION_FILE_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/;

/** The agent directory a Studio pane's `pi` uses, unless its shell overrides it. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  if (override) return resolve(override.replace(/^~(?=$|[\\/])/, homedir()));
  return join(homedir(), ".pi", "agent");
}

/** Pi's per-cwd session directory (getDefaultSessionDirPath). */
export function piSessionBucket(cwd: string, agentDir: string): string {
  const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

export function parsePiSessionFileName(name: string): { sessionId: string; createdMs: number } | null {
  const match = SESSION_FILE_RE.exec(name);
  if (!match) return null;
  const createdMs = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(createdMs) ? { sessionId: match[6], createdMs } : null;
}

/** A known Pi process; `endMs` is set once it exited. */
export interface PiProcess { pid: number; startMs: number; endMs?: number }
export interface PiSessionFile { sessionId: string; path: string; createdMs: number; modifiedMs: number }

/** Which Pi process created a file, or null when it cannot be told. */
export function attributePiSessionFile(file: PiSessionFile, processes: readonly PiProcess[]): number | null {
  // ps truncates start times to the second, so a start stamp is never later
  // than the real start.
  const running = processes.filter((proc) =>
    proc.startMs <= file.createdMs && (proc.endMs === undefined || proc.endMs >= file.createdMs));
  if (running.length === 0) return null;
  if (running.length === 1) return running[0].pid;
  const latest = running.reduce((a, b) => (b.startMs > a.startMs ? b : a));
  return file.createdMs - latest.startMs <= STARTUP_SESSION_WINDOW_MS ? latest.pid : null;
}

/** The file each process wrote most recently among those attributed to it. */
export function bindPiSessions(
  files: readonly PiSessionFile[],
  processes: readonly PiProcess[],
): Map<number, PiSessionFile> {
  const bound = new Map<number, PiSessionFile>();
  for (const file of files) {
    const pid = attributePiSessionFile(file, processes);
    if (pid === null) continue;
    const current = bound.get(pid);
    if (!current || file.modifiedMs > current.modifiedMs) bound.set(pid, file);
  }
  return bound;
}

async function listSessionFiles(dir: string, sinceMs: number): Promise<PiSessionFile[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(names.map(async (name) => {
    const parsed = parsePiSessionFileName(name);
    if (!parsed || parsed.createdMs < sinceMs) return null;
    const path = join(dir, name);
    const stat = await fs.stat(path).catch(() => null);
    if (!stat?.isFile()) return null;
    return { ...parsed, path, modifiedMs: stat.mtimeMs };
  }));
  return files.filter((file): file is PiSessionFile => file !== null);
}

/** The session file for `sessionId` in the pane's cwd, if Pi still has it. */
export async function findPiSessionFile(
  cwd: string,
  sessionId: string,
  agentDir: string = piAgentDir(),
): Promise<string | null> {
  const dir = piSessionBucket(cwd, agentDir);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const name = names.find((entry) => parsePiSessionFileName(entry)?.sessionId === sessionId);
  if (!name) return null;
  const stat = await fs.stat(join(dir, name)).catch(() => null);
  return stat?.isFile() ? join(dir, name) : null;
}

export function parseLsofCwds(output: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid = 0;
  for (const field of output.split(/\r?\n/)) {
    if (/^p\d+$/.test(field)) pid = Number(field.slice(1));
    else if (pid && field.startsWith("n/")) result.set(pid, field.slice(1));
  }
  return result;
}

async function processCwds(pids: number[]): Promise<Map<number, string> | null> {
  if (pids.length === 0) return new Map();
  if (process.platform === "linux") {
    const entries = await Promise.all(pids.map(async (pid) =>
      [pid, await fs.readlink(`/proc/${pid}/cwd`).catch(() => null)] as const));
    return new Map(entries.filter((entry): entry is readonly [number, string] => entry[1] !== null));
  }
  if (process.platform !== "darwin") return null;
  return new Promise((done) => {
    execFile("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"],
      { timeout: 1500, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => done(stdout ? parseLsofCwds(stdout) : error ? null : new Map()));
  });
}

interface KnownPi { pid: number; startMs: number; cwd: string | null; lastSeenMs: number; live: boolean }

export function createPiSessionTracker(deps: {
  panes: () => PiTrackedPane[];
  agentDir?: () => string;
  processes?: () => Promise<readonly ProcessEntry[] | null>;
  cwds?: (pids: number[]) => Promise<Map<number, string> | null>;
  appPid?: number;
  now?: () => number;
  latest?: (paneId: string) => SessionStartRecord | null;
  record?: (record: SessionStartRecord) => void;
}) {
  const observed = new Map<string, PiTrackedPane>();
  // Keyed by pid and start stamp, so a recycled pid is a new process.
  const known = new Map<string, KnownPi>();
  let pending: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let revision = 0;
  const latest = deps.latest ?? latestSessionStart;
  const record = deps.record ?? recordSessionStart;
  const appPid = deps.appPid ?? process.pid;
  const clock = deps.now ?? Date.now;
  const refresh = (): Promise<void> => {
    if (pending) return pending;
    const startedRevision = revision;
    pending = (async () => {
      const panes = deps.panes();
      if (panes.length === 0 && observed.size === 0 && known.size === 0) return;
      const processes = await (deps.processes?.() ?? listProcessesWithCommands(2000));
      if (!processes) return;
      const now = clock();
      const live = panes.map((pane) => {
        const agent = agentProcessForPane(pane.pid, processes);
        return { pane, pid: agent?.runtime === "pi" ? agent.pid : null };
      });
      const panePids = new Set(live.flatMap(({ pid }) => (pid ? [pid] : [])));
      const identity = (proc: ProcessEntry): string => `${proc.pid}:${proc.startedAt}`;
      // Every Pi the user runs can create files in a pane's directory, the
      // ones in other terminals too; only Cora's, started by the app, cannot.
      // A pane shell that exec'd `pi` is a child of the app as well.
      const userPis = panePids.size === 0 ? [] : processes.filter((proc) =>
        runtimeFromProcessCommand(proc.command) === "pi" &&
        (proc.parentPid !== appPid || panePids.has(proc.pid)));
      for (const entry of known.values()) entry.live = false;
      const lookups: ProcessEntry[] = [];
      for (const proc of userPis) {
        const startMs = processStartMs(proc.startedAt);
        if (startMs === null) continue;
        const entry = known.get(identity(proc));
        if (entry) {
          entry.live = true;
          entry.lastSeenMs = now;
        } else {
          known.set(identity(proc), { pid: proc.pid, startMs, cwd: null, lastSeenMs: now, live: true });
          lookups.push(proc);
        }
      }
      if (lookups.length > 0) {
        // Once per process: an unreadable cwd stays unknown.
        const found = await (deps.cwds ?? processCwds)(lookups.map((proc) => proc.pid));
        for (const proc of lookups) {
          const entry = known.get(identity(proc));
          const cwd = found?.get(proc.pid);
          if (entry && cwd) entry.cwd = cwd;
        }
      }
      // An exited process matters only while a pane Pi that ran alongside it
      // is still live.
      const oldestPane = Math.min(...[...known.values()]
        .filter((entry) => entry.live && panePids.has(entry.pid))
        .map((entry) => entry.startMs));
      for (const [key, entry] of known) {
        if (!entry.live && entry.lastSeenMs + EXIT_SLACK_MS < oldestPane) known.delete(key);
      }
      if (panePids.size === 0) known.clear();
      if (revision !== startedRevision) return;
      const agentDir = deps.agentDir?.() ?? piAgentDir();
      const liveByPid = new Map([...known.values()].filter((entry) => entry.live).map((entry) => [entry.pid, entry]));
      const bindings = new Map<number, PiSessionFile>();
      const cwdsToScan = new Set([...panePids].flatMap((pid) => {
        const cwd = liveByPid.get(pid)?.cwd;
        return cwd ? [cwd] : [];
      }));
      for (const cwd of cwdsToScan) {
        const here: PiProcess[] = [...known.values()].filter((entry) => entry.cwd === cwd).map((entry) => ({
          pid: entry.pid,
          startMs: entry.startMs,
          ...(entry.live ? {} : { endMs: entry.lastSeenMs + EXIT_SLACK_MS }),
        }));
        const panesHere = here.filter((proc) => panePids.has(proc.pid) && proc.endMs === undefined);
        const oldest = Math.min(...panesHere.map((proc) => proc.startMs));
        const files = await listSessionFiles(piSessionBucket(cwd, agentDir), oldest);
        for (const [pid, file] of bindPiSessions(files, here)) {
          if (panePids.has(pid)) bindings.set(pid, file);
        }
      }
      if (revision !== startedRevision) return;
      const stillLive = (pane: PiTrackedPane): boolean =>
        deps.panes().some((current) => current.paneId === pane.paneId && current.generationId === pane.generationId);
      for (const { pane, pid } of live) {
        if (!pid || !stillLive(pane)) continue;
        observed.set(pane.paneId, pane);
        const previous = latest(pane.paneId);
        const file = bindings.get(pid);
        const cwd = liveByPid.get(pid)?.cwd ?? null;
        if (file && cwd) {
          if (previous?.runtime === "pi" && previous.sessionId === file.sessionId &&
              previous.active === true && !previous.restoreOnBoot) continue;
          record({ paneId: pane.paneId, runtime: "pi", sessionId: file.sessionId,
            transcriptPath: file.path, cwd, active: true, source: "process",
            timestamp: new Date(now).toISOString() });
          continue;
        }
        // A resumed session predates its process: keep the pane's binding
        // live rather than guess, as long as Pi still runs where it was.
        if (
          previous?.runtime === "pi" &&
          (!previous.cwd || !cwd || previous.cwd === cwd) &&
          (previous.active !== true || previous.restoreOnBoot)
        ) {
          const { restoreOnBoot: _, ...persisted } = previous;
          record({ ...persisted, active: true, source: "process", timestamp: new Date(now).toISOString() });
        }
      }
      for (const paneId of observed.keys()) {
        if (live.some((entry) => entry.pane.paneId === paneId && entry.pid !== null)) continue;
        observed.delete(paneId);
        const previous = latest(paneId);
        if (previous?.runtime === "pi" && previous.active === true) {
          const { restoreOnBoot: _, ...persisted } = previous;
          record({ ...persisted, active: false, timestamp: new Date(now).toISOString() });
        }
      }
    })().catch(() => undefined).finally(() => { pending = null; });
    return pending;
  };
  return {
    refresh,
    start() { if (!timer) { timer = setInterval(() => { void refresh(); }, REFRESH_MS); timer.unref(); } },
    stop() { if (timer) clearInterval(timer); timer = null; revision += 1; },
    async flush() {
      if (timer) clearInterval(timer);
      timer = null;
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([refresh(), new Promise<void>((done) => { deadline = setTimeout(done, 1000); })]);
      if (deadline) clearTimeout(deadline);
      // A slow listing must not mark sessions inactive after shutdown has
      // killed their PTYs.
      revision += 1;
    },
  };
}
