// The verify gate: the only thing that closes a task. It reads the checks the
// repository owns (.codara/verify.json on the base branch, fetched from
// origin), runs the ones the change can affect in the task's folder, writes
// each check's full output to a log, and
// hands the store the exit codes and log paths as evidence. The store closes
// the task when every check passed and otherwise sends it back to its worker,
// or to the user with one plain sentence; no model's opinion is involved.
//
// Preview steps in verify.json are accepted and not run yet: phase 1 proves
// tasks with commands only.
//
// No Electron import, so the unit suite bundles it directly; index.ts wires
// it to the app and supplies the codara-heavy wrapper.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";

import type { Task, TaskEvidence } from "@shared/cos-tasks";
import { isRemotePath } from "@shared/remote";
import { processEnvWithoutElectronViteDev } from "../env-sanitize";
import { gitChildEnv } from "../git-env";
import type { TaskStore } from "./task-store";

export const VERIFY_CONFIG_PATH = join(".codara", "verify.json");
const REMOTE = "origin";
// Where the gate fetches the base branch and the task's commit to, in its
// own repository (originFlags), overwritten before every read.
const BASE_REF_PREFIX = "refs/codara/verify-base";
const HEAD_REF_PREFIX = "refs/codara/verify-head";
const GIT_TIMEOUT_MS = 90_000;
const DEFAULT_TIMEOUT_SEC = 20 * 60;
const MAX_TIMEOUT_SEC = 2 * 60 * 60;
/** How long a check waits for codara-heavy's slot before the wait is its own failure. */
const SLOT_WAIT_MAX_MS = 2 * 60 * 60 * 1000;
const SLOT_WAIT_LABEL = "2 hours";
const CHECK_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

export interface VerifyCheck {
  id: string;
  run: string;
  /** Globs over repo-relative paths; the check runs when a changed file matches one. Absent: always. */
  when?: string[];
  timeoutSec?: number;
}

/** The base branch is the app's choice (VerifyGateOptions.baseBranch); a `base` key an older file has is ignored. */
export interface VerifyConfig {
  checks: VerifyCheck[];
}

export class VerifyConfigError extends Error {}

function stringList(raw: unknown, what: string): string[] {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || !item.trim())) {
    throw new VerifyConfigError(`${what} must be a list of text`);
  }
  return raw.map((item: string) => item.trim());
}

export function parseVerifyConfig(raw: unknown): VerifyConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new VerifyConfigError("it must be a JSON object");
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.checks) || value.checks.length === 0) throw new VerifyConfigError("it needs at least one check in checks");
  const seen = new Set<string>();
  const checks = value.checks.map((entry, index): VerifyCheck => {
    if (!entry || typeof entry !== "object") throw new VerifyConfigError(`check ${index + 1} must be an object`);
    const check = entry as Record<string, unknown>;
    if (typeof check.id !== "string" || !CHECK_ID.test(check.id)) {
      throw new VerifyConfigError(`check ${index + 1} needs an id of letters, digits, - or _`);
    }
    if (seen.has(check.id)) throw new VerifyConfigError(`two checks are called ${check.id}`);
    seen.add(check.id);
    if (typeof check.run !== "string" || !check.run.trim()) throw new VerifyConfigError(`check ${check.id} needs a run command`);
    const out: VerifyCheck = { id: check.id, run: check.run.trim() };
    if (check.when !== undefined) out.when = stringList(check.when, `check ${check.id}'s when`);
    if (check.timeoutSec !== undefined) {
      if (typeof check.timeoutSec !== "number" || !(check.timeoutSec > 0) || check.timeoutSec > MAX_TIMEOUT_SEC) {
        throw new VerifyConfigError(`check ${check.id}'s timeoutSec must be between 1 and ${MAX_TIMEOUT_SEC}`);
      }
      out.timeoutSec = check.timeoutSec;
    }
    return out;
  });
  return { checks };
}

/** "src/**", "scripts/*.cjs", "**\/*.ts": `**` crosses folders, `*` and `?` stay inside one. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * The checks this change needs. Unknown changes (git could not say) and
 * changes no `when` matches run every check, so a closed task always
 * carries evidence.
 */
export function selectChecks(config: VerifyConfig, changed: readonly string[] | null): VerifyCheck[] {
  if (!changed) return config.checks;
  const picked = config.checks.filter(
    (check) => !check.when || check.when.some((glob) => changed.some((file) => globToRegExp(glob).test(file))),
  );
  return picked.length ? picked : config.checks;
}

export interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Stopped because a newer verify run of the task, or the app quitting, superseded it. */
  cancelled?: boolean;
  /** Never started: codara-heavy's slot stayed taken for the whole wait. */
  noSlot?: boolean;
  spawnError?: string;
}

export type CommandRunner = (
  command: string,
  options: {
    cwd: string;
    env: Record<string, string>;
    logFile: string;
    timeoutMs: number;
    /** The cap on waiting for the heavy slot; 2 hours by default. */
    slotWaitMs?: number;
    signal?: AbortSignal;
  },
) => Promise<CommandResult>;

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

function quoteForShell(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function loginShell(): string {
  const sh = process.env.SHELL && /\/(zsh|bash|sh)$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/bash";
  return process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : sh;
}

// Every check still running, so the app can stop them when it quits instead
// of leaving a build holding the machine-wide heavy slot.
const liveChecks = new Set<() => void>();

/** Stops every check this process started; for app quit. */
export function stopRunningChecks(): void {
  for (const stop of [...liveChecks]) stop();
}

/**
 * Runs `command` through the user's login shell (PATH from their profile, as
 * in a terminal), output to `logFile`. The check is over when its shell
 * exits, times out or is cancelled; its whole process group is killed then,
 * so a background process it left cannot hold the gate open. With `heavy` it
 * runs inside codara-heavy: one machine-wide slot and a memory cap, the same
 * wrapper workflow agents use. The timeout then counts from when the command
 * starts, not while the wrapper waits for the slot: the command writes one
 * byte to fd 3 first.
 */
export function createCommandRunner(heavy?: { bin: string; env: Record<string, string> } | null): CommandRunner {
  return (command, options) =>
    new Promise((resolve) => {
      const signalsStart = Boolean(heavy) && process.platform !== "win32";
      const inner = signalsStart ? `printf . >&3 2>/dev/null; exec 3>&-; ${command}` : command;
      const line = heavy ? `${quoteForShell(heavy.bin)} /bin/sh -c ${quoteForShell(inner)}` : command;
      const shell = loginShell();
      const args = process.platform === "win32" ? ["/d", "/s", "/c", line] : ["-lc", line];
      const log = createWriteStream(options.logFile, { flags: "w", mode: 0o600 });
      log.on("error", () => undefined);
      log.write(`$ ${command}\n\n`);
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let noSlot = false;
      let timer: NodeJS.Timeout | undefined;
      let slotTimer: NodeJS.Timeout | undefined;
      let child: ReturnType<typeof spawn> | null = null;
      const killGroup = () => {
        if (!child?.pid) return;
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      };
      const stop = () => {
        cancelled = true;
        finish({ exitCode: null });
      };
      const finish = (result: Omit<CommandResult, "timedOut" | "cancelled" | "noSlot">) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (slotTimer) clearTimeout(slotTimer);
        liveChecks.delete(stop);
        options.signal?.removeEventListener("abort", stop);
        killGroup();
        for (const stream of [child?.stdout, child?.stderr]) {
          stream?.unpipe(log);
          stream?.destroy();
        }
        child?.stdio[3]?.destroy();
        const tail = result.spawnError
          ? `\n[could not start: ${result.spawnError}]\n`
          : `\n[exit ${result.exitCode ?? "none"}${timedOut ? ", timed out" : ""}${noSlot ? ", no heavy-work slot" : ""}${cancelled ? ", cancelled" : ""}]\n`;
        log.end(tail, () => resolve({ ...result, timedOut, ...(cancelled ? { cancelled } : {}), ...(noSlot ? { noSlot } : {}) }));
      };
      if (options.signal?.aborted) {
        cancelled = true;
        finish({ exitCode: null });
        return;
      }
      try {
        child = spawn(shell, args, {
          cwd: options.cwd,
          env: { ...processEnvWithoutElectronViteDev(), ...(heavy?.env ?? {}), ...options.env },
          stdio: signalsStart ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (error) {
        finish({ exitCode: null, spawnError: error instanceof Error ? error.message : String(error) });
        return;
      }
      liveChecks.add(stop);
      options.signal?.addEventListener("abort", stop);
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      child.on("error", (error) => finish({ exitCode: null, spawnError: error.message }));
      // "exit", not "close": a background process the check started can keep
      // the pipes open long after the shell is gone.
      child.on("exit", (code) => finish({ exitCode: code }));
      const startClock = () => {
        if (slotTimer) clearTimeout(slotTimer);
        if (timer || settled) return;
        timer = setTimeout(() => {
          timedOut = true;
          finish({ exitCode: null });
        }, options.timeoutMs);
      };
      const started = signalsStart ? child.stdio[3] : null;
      if (started) {
        slotTimer = setTimeout(() => {
          noSlot = true;
          finish({ exitCode: null });
        }, options.slotWaitMs ?? SLOT_WAIT_MAX_MS);
        started.on("error", () => undefined);
        started.once("data", () => {
          startClock();
          started.destroy();
        });
      } else startClock();
    });
}

// Config that would run a program, or tell git the working tree is other
// than it is, during the gate's own git calls: hooks (reference-transaction
// fires on every ref a fetch writes), an fsmonitor, a stale untracked cache,
// ext:: transports, an SSH command other than ssh (in ~/.gitconfig, the
// checkout's or the gate's repository's config, or GIT_SSH and
// GIT_SSH_COMMAND, which win over the config) that could answer a fetch from
// any repository. ssh's own config still picks keys and hosts.
const GIT_HARDENING = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.sshCommand=ssh",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.ext.allow=never",
];

// A fetch that waits on a network or an SSH prompt ends with the gate
// blocked instead of holding the task in verifying.
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    // Replace refs are the agent's to write; they could stand another
    // commit's checks in for the base's.
    const child = spawn("git", [...GIT_HARDENING, ...args], {
      cwd,
      env: gitChildEnv({ ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_SSH_COMMAND: "ssh" }),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`git ${args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c")} exited ${code}`));
    });
  });

const BRANCH_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

// A path URL ("../origin.git") is relative to the checkout, not to the
// gate's repository the fetch runs in.
function fetchableUrl(url: string, top: string): string {
  const local = !isAbsolute(url) && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) && !/^[^/]*:/.test(url);
  return local ? resolvePath(top, url) : url;
}

/** origin's URL as the checkout's config gives it (url.insteadOf applied), or null. */
export async function originUrl(dir: string, git: GitRunner = defaultGitRunner): Promise<string | null> {
  return (await git(["remote", "get-url", REMOTE], dir).catch(() => "")).trim() || null;
}

/**
 * origin's URL per workspace as Codara recorded it when the workspace was
 * added (index.ts), before any agent worked in it; the gate fetches from
 * nothing else. A checkout's config is the agent's to edit, and a worktree
 * shares its main checkout's, so the URL it holds when the gate first runs
 * proves nothing.
 */
export interface OriginRecords {
  get(workspaceId: string): Promise<string | null>;
  /** Keeps the first URL recorded for a workspace. */
  record(workspaceId: string, url: string): Promise<void>;
}

/** Records kept in one JSON file in Codara's own folder ({ workspaceId: url }). */
export function createOriginRecords(file: string): OriginRecords {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Record<string, unknown>> => {
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return {
    async get(workspaceId) {
      const url = (await read())[workspaceId];
      return typeof url === "string" && url ? url : null;
    },
    record(workspaceId, url) {
      const next = queue.then(async () => {
        const all = await read();
        if (typeof all[workspaceId] === "string" && all[workspaceId]) return;
        all[workspaceId] = url;
        await fs.mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temp, file);
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/**
 * Records origin's URL for each workspace not in `seen` (the ones there when
 * the app started, and every one handled since): the first time a newly
 * added workspace is saved, before any agent has worked in it. A copy branch
 * takes its source workspace's record; an agent's worktree records nothing
 * (the agent could already have changed the shared config), and neither do
 * SSH workspaces. Workspaces that were there at start are recorded by the
 * gate on its first run, which asks the user to confirm.
 */
export async function recordAddedWorkspaces(
  workspaces: readonly GateWorkspace[],
  seen: Set<string>,
  records: OriginRecords,
  git: GitRunner = defaultGitRunner,
): Promise<void> {
  for (const workspace of workspaces) {
    if (seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    if (workspace.remote || isRemotePath(workspace.cwd) || workspace.copyBranch?.createdBy?.kind === "agent") continue;
    if (await records.get(workspace.id)) continue;
    const source = workspace.copyBranch
      ? workspaces.find((other) => other.id !== workspace.id && other.cwd === workspace.copyBranch?.repoCwd)
      : undefined;
    const url = (source && (await records.get(source.id))) || (await originUrl(workspace.copyBranch?.repoCwd ?? workspace.cwd, git));
    if (url) await records.record(workspace.id, url);
  }
}

// The checkout's origin must still be the recorded one. A workspace added
// before Codara recorded origins has its URL recorded now from its own
// checkout, and the task goes to the user once with that URL to confirm.
async function recordedOrigin(
  workspaceId: string,
  top: string,
  home: string,
  origins: OriginRecords,
  git: GitRunner,
): Promise<{ url: string } | { blocked: string }> {
  const current = await originUrl(top, git);
  if (!current) return { blocked: `Codara cannot reach ${REMOTE} to find the base branch the repository's checks are read from.` };
  const recorded = await origins.get(workspaceId);
  if (!recorded) {
    const found = await originUrl(home, git);
    if (!found) return { blocked: `Codara cannot reach ${REMOTE} to find the base branch the repository's checks are read from.` };
    await origins.record(workspaceId, found);
    return {
      blocked: `Codara had no record of this workspace's ${REMOTE} and recorded ${found} from its checkout; if that is the right repository, verify again.`,
    };
  }
  if (recorded !== current) {
    return {
      blocked: `${REMOTE} now points at ${current}, not ${recorded} as Codara recorded when the workspace was added; set it back to verify this task.`,
    };
  }
  return { url: fetchableUrl(recorded, home) };
}

// The gate's own bare repository for a repository a workspace works in,
// under Codara's folder. origin's base branch is fetched into it, and so is
// the task's commit, from the checkout; the checks file, the merge base and
// the committed change are all read here. Nothing in the checkout (its
// hooks, its config, its refs, objects planted in its store) takes part.
// It holds commits and trees; a blob comes from origin when first read.
function originFlags(url: string): string[] {
  return ["-c", `remote.${REMOTE}.url=${url}`, "-c", `remote.${REMOTE}.promisor=true`, "-c", `remote.${REMOTE}.partialclonefilter=blob:none`];
}

async function ensureBaseRepo(dir: string, objectFormat: string, git: GitRunner): Promise<boolean> {
  if (await fs.stat(join(dir, "HEAD")).then(() => true, () => false)) return true;
  await fs.mkdir(dirname(dir), { recursive: true });
  const format = objectFormat === "sha256" ? "sha256" : "sha1";
  return git(["init", "--quiet", "--bare", `--object-format=${format}`, dir], dirname(dir)).then(() => true, () => false);
}

// Two gates of one workspace share its repository; git's ref locks would
// fail the second fetch, so they take turns.
const repoTurns = new Map<string, Promise<unknown>>();
function inTurn<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const next = (repoTurns.get(dir) ?? Promise.resolve()).catch(() => undefined).then(work);
  repoTurns.set(dir, next);
  next.then(
    () => repoTurns.get(dir) === next && repoTurns.delete(dir),
    () => repoTurns.get(dir) === next && repoTurns.delete(dir),
  );
  return next;
}

/** The branch origin's HEAD points at, asked of origin itself: a local origin/HEAD is the agent's to move. */
async function remoteDefaultBranch(repo: string, url: string, git: GitRunner): Promise<string | null> {
  try {
    const out = await git(["ls-remote", "--symref", url, "HEAD"], repo);
    const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out);
    return match && BRANCH_NAME.test(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}

/** Fetches origin's `branch` into the gate's repository and returns its commit, or null. */
async function fetchBase(repo: string, url: string, branch: string, git: GitRunner): Promise<string | null> {
  const ref = `${BASE_REF_PREFIX}/${branch}`;
  try {
    await git([...originFlags(url), "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--filter=blob:none", REMOTE, `+refs/heads/${branch}:${ref}`], repo);
    return (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo)).trim() || null;
  } catch {
    return null;
  }
}

/** Fetches the checkout's HEAD into the gate's repository as `ref` and returns its commit, or null. */
async function fetchHead(repo: string, url: string, top: string, ref: string, git: GitRunner): Promise<string | null> {
  try {
    await git([...originFlags(url), "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", top, `+HEAD:${ref}`], repo);
    return (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo)).trim() || null;
  } catch {
    return null;
  }
}

/** The merge base of `head` with `baseCommit` and the files its commits changed since, or null when git cannot say. */
export async function changedSince(
  repo: string,
  baseCommit: string,
  head: string,
  git: GitRunner,
): Promise<{ base: string; files: string[] } | null> {
  try {
    const base = (await git(["merge-base", head, baseCommit], repo)).trim();
    if (!base) return null;
    const files = await git(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, head], repo);
    return { base, files: files.split("\0").filter(Boolean) };
  } catch {
    return null;
  }
}

/** Every path in `commit` with its mode and object id. */
async function commitTree(repo: string, commit: string, git: GitRunner): Promise<Map<string, { mode: string; oid: string }>> {
  const tree = new Map<string, { mode: string; oid: string }>();
  for (const line of (await git(["ls-tree", "-r", "-z", "--full-tree", commit], repo)).split("\0")) {
    const match = /^(\d+) \w+ ([0-9a-f]+)\t(.+)$/s.exec(line);
    if (match) tree.set(match[3], { mode: match[1], oid: match[2] });
  }
  return tree;
}

const HASH_MAX_BYTES = 16 * 1024 * 1024;

/**
 * What the checkout changes beyond its commit, or null when git cannot list
 * its files. Codara hashes the files itself: the index is the agent's to
 * mark (assume-unchanged, skip-worktree) and a clean filter its program to
 * run. A file too big to hash counts as changed.
 */
async function workingTreeChanges(top: string, tree: Map<string, { mode: string; oid: string }>, git: GitRunner): Promise<string[] | null> {
  const hash = (data: Buffer, oid: string) =>
    createHash(oid.length === 64 ? "sha256" : "sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  const differs = async (path: string, { mode, oid }: { mode: string; oid: string }): Promise<boolean> => {
    if (mode === "160000") return false;
    const file = join(top, path);
    try {
      if (mode === "120000") return hash(Buffer.from(await fs.readlink(file)), oid) !== oid;
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > HASH_MAX_BYTES) return true;
      return hash(await fs.readFile(file), oid) !== oid;
    } catch {
      return true;
    }
  };
  const changed = new Set<string>();
  const entries = [...tree];
  for (let i = 0; i < entries.length; i += 32) {
    const batch = entries.slice(i, i + 32);
    const results = await Promise.all(batch.map(([path, entry]) => differs(path, entry)));
    batch.forEach(([path], index) => results[index] && changed.add(path));
  }
  // New files, whether or not the index holds them.
  try {
    const listed = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], top);
    for (const path of listed.split("\0")) if (path && !tree.has(path)) changed.add(path);
  } catch {
    return null;
  }
  return [...changed];
}

function minutes(seconds: number): string {
  const value = Math.round(seconds / 60);
  return value === 1 ? "1 minute" : `${value} minutes`;
}

/** One plain sentence on what failed, for the task's needs_you reason. */
export function failureSentence(
  evidence: readonly TaskEvidence[],
  timedOut: ReadonlySet<string>,
  timeouts: Record<string, number>,
  noSlot: ReadonlySet<string> = new Set(),
): string {
  const failed = evidence.filter((item) => !item.ok);
  if (failed.length === 1) {
    const [item] = failed;
    const why = noSlot.has(item.checkId)
      ? `never got a heavy-work slot in ${SLOT_WAIT_LABEL}`
      : timedOut.has(item.checkId)
      ? `timed out after ${minutes(timeouts[item.checkId] ?? DEFAULT_TIMEOUT_SEC)}`
      : item.exitCode === undefined
        ? "could not start"
        : `failed with exit code ${item.exitCode}`;
    return `The ${item.checkId} check ${why}; its log is ${item.artifact}.`;
  }
  const names = failed.map((item) => item.checkId);
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `The ${list} checks failed; their logs are in ${failed[0].artifact ? failed[0].artifact.replace(/[\\/][^\\/]+$/, "") : "the task's verify folder"}.`;
}

/** What the gate needs of a workspace record (@shared/types Workspace). */
export interface GateWorkspace {
  id: string;
  name?: string;
  cwd: string;
  remote?: unknown;
  copyBranch?: { repoCwd: string; baseBranch?: string; createdBy?: { kind: string } };
}

/**
 * The branch the user forked the workspace from, or null for origin's
 * default branch. An agent-made worktree's fork point was the agent's choice,
 * so it does not count.
 */
export function workspaceBaseBranch(workspace: GateWorkspace | null | undefined): string | null {
  const copy = workspace?.copyBranch;
  if (!copy?.baseBranch?.trim() || copy.createdBy?.kind === "agent") return null;
  return copy.baseBranch.trim().replace(/^(?:refs\/heads\/|refs\/remotes\/origin\/|origin\/)/, "") || null;
}

export type GateTarget = { cwd: string; workspaceDir: string; baseBranch: string | null } | { blocked: string };

function atOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Where a task's checks run: its worktree, else the workspace's folder. The
 * folder must be the workspace's own checkout (or inside it), or a worktree
 * an agent made of the same repository; the workspace that holds it decides,
 * the deepest one when they nest. Another workspace's checkout of the same
 * repository (a user's branch, the tree a running app reloads from) is
 * refused, and so is an SSH workspace: the checks run on this machine.
 */
export async function resolveGateTarget(
  workspaces: readonly GateWorkspace[],
  workspaceId: string,
  worktree: string | null | undefined,
  realpath: (path: string) => Promise<string> = (path) => fs.realpath(path),
): Promise<GateTarget> {
  const real = (path: string) => realpath(path).catch(() => null);
  const local = (workspace: GateWorkspace) => !workspace.remote && !isRemotePath(workspace.cwd);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return { blocked: "This task's workspace is no longer in Codara, so nothing could be checked." };
  if (!local(workspace) || (worktree && isRemotePath(worktree))) {
    return { blocked: "The verify gate runs checks on this machine only, so it cannot check an SSH workspace's work yet." };
  }
  const folder = await real(worktree?.trim() || workspace.cwd);
  const home = await real(workspace.cwd);
  if (!folder || !home) {
    return { blocked: "Codara cannot tell which folder this task's work is in, so nothing could be checked; set the task's worktree." };
  }
  let owner: { workspace: GateWorkspace; root: string } | null = null;
  for (const candidate of workspaces) {
    if (!local(candidate)) continue;
    const root = await real(candidate.cwd);
    if (root && atOrUnder(folder, root) && (!owner || root.length > owner.root.length)) owner = { workspace: candidate, root };
  }
  if (!owner) return { blocked: "The task's worktree is not a folder of this workspace or of a worktree made for it, so its checks cannot run." };
  if (owner.workspace.id !== workspace.id) {
    const copy = owner.workspace.copyBranch;
    const repo = await real(workspace.copyBranch?.repoCwd ?? workspace.cwd);
    const madeForIt = copy?.createdBy?.kind === "agent" && repo !== null && (await real(copy.repoCwd)) === repo;
    if (!madeForIt) {
      const name = owner.workspace.name?.trim() || "another workspace";
      return { blocked: `The task's worktree is ${name}'s checkout, not this workspace's, so its checks cannot run from here.` };
    }
  }
  return { cwd: folder, workspaceDir: home, baseBranch: workspaceBaseBranch(workspace) };
}

export interface VerifyGateOptions {
  store: TaskStore;
  workspaceId: string;
  taskId: string;
  runId: string;
  /** The folder the task's work is in: its worktree, else the workspace's folder. */
  cwd: string | null;
  /**
   * The branch on origin the change is measured against and the checks are
   * read from: the app's choice from the workspace, never anything in the
   * task's folder. Absent: the branch origin's HEAD names.
   */
  baseBranch?: string | null;
  /** The workspace's own folder; a different `cwd` must be a checkout of the same repository. */
  workspaceDir?: string | null;
  /** origin's URL per workspace as Codara recorded it; the gate fetches from nothing else. */
  origins: OriginRecords;
  runCommand: CommandRunner;
  git?: GitRunner;
  now?: () => number;
  /** Aborted when a newer verify run of the task starts; this one then records nothing. */
  signal?: AbortSignal;
}

async function gitCommonDir(cwd: string, git: GitRunner): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Runs the gate for one verify run and records its result; resolves to the
 * task as it then stands, or null when the run was cancelled.
 *
 * The checks come from .codara/verify.json at the tip of the base branch as
 * origin has it, fetched now into Codara's own ref; the merge base with it is
 * what the change is measured from. Nothing in the task's folder (its
 * working tree, its commits, its local or remote-tracking refs) can choose
 * the base or loosen the checks.
 */
export async function runVerifyGate(options: VerifyGateOptions): Promise<Task | null> {
  const { store, workspaceId, taskId, runId } = options;
  const now = options.now ?? (() => Date.now());
  const git = options.git ?? defaultGitRunner;
  const blocked = (sentence: string) => store.finishVerify(workspaceId, taskId, { runId, evidence: [], blocked: sentence });

  const cwd = options.cwd;
  if (!cwd || !(await fs.stat(cwd).then((stat) => stat.isDirectory(), () => false))) {
    return blocked("Codara cannot tell which folder this task's work is in, so nothing could be checked; set the task's worktree.");
  }
  if (options.workspaceDir && options.workspaceDir !== cwd) {
    const [own, theirs] = await Promise.all([gitCommonDir(options.workspaceDir, git), gitCommonDir(cwd, git)]);
    if (!own || own !== theirs) {
      return blocked("The task's worktree is not a checkout of this workspace's repository, so its checks cannot be trusted.");
    }
  }

  // verify.json and its commands are written for the top of the checkout;
  // a subfolder could hold its own package.json with looser scripts.
  const top = (await git(["rev-parse", "--show-toplevel"], cwd).catch(() => "")).trim();
  if (!top) return blocked("The task's folder is not a git checkout, so its change cannot be measured.");
  const commonDir = await gitCommonDir(top, git);
  const repoId = createHash("sha256").update(commonDir ?? top).digest("hex").slice(0, 16);
  const origin = await recordedOrigin(workspaceId, top, options.workspaceDir ?? top, options.origins, git);
  if ("blocked" in origin) return blocked(origin.blocked);
  const objectFormat = (await git(["rev-parse", "--show-object-format"], top).catch(() => "sha1")).trim();
  const repo = join(store.paths(workspaceId).dir, "verify-repo", `${repoId}.git`);

  type BaseRead =
    | { blocked: string }
    | { ref: string; raw: string; committed: { base: string; files: string[] }; tree: Map<string, { mode: string; oid: string }> };
  const read = await inTurn(repo, async (): Promise<BaseRead> => {
    if (!(await ensureBaseRepo(repo, objectFormat, git))) {
      return { blocked: "Codara could not set up its own copy of the repository to read the checks from." };
    }
    // url.insteadOf in the user's or this repository's git config would
    // send the fetch somewhere else; credential helpers still apply.
    const expanded = (await git([...originFlags(origin.url), "ls-remote", "--get-url", REMOTE], repo).catch(() => "")).trim();
    if (expanded !== origin.url) {
      return { blocked: `A url.insteadOf rule in git's config sends ${REMOTE} (${origin.url}) to ${expanded || "another address"}, so Codara will not fetch from it.` };
    }
    const branch = options.baseBranch?.trim() || (await remoteDefaultBranch(repo, origin.url, git));
    if (!branch) return { blocked: `Codara cannot reach ${REMOTE} to find the base branch the repository's checks are read from.` };
    if (!BRANCH_NAME.test(branch)) return { blocked: `The base branch "${branch}" is not a branch name Codara can fetch.` };
    const ref = `${REMOTE}/${branch}`;
    const baseCommit = await fetchBase(repo, origin.url, branch, git);
    if (!baseCommit) return { blocked: `Codara could not fetch ${ref}, so the repository's checks could not be read.` };
    const listed = await git(["ls-tree", "--name-only", baseCommit, ".codara/verify.json"], repo).catch(() => "");
    if (!listed.trim()) return { blocked: `No .codara/verify.json on ${ref} yet` };
    let raw: string;
    try {
      raw = await git([...originFlags(origin.url), "cat-file", "blob", `${baseCommit}:.codara/verify.json`], repo);
    } catch {
      return { blocked: `Codara could not read .codara/verify.json from ${ref}.` };
    }
    const headRef = `${HEAD_REF_PREFIX}/${taskId}`;
    const head = await fetchHead(repo, origin.url, top, headRef, git);
    if (!head) return { blocked: "Codara could not read the task's commit from its checkout, so its change cannot be measured." };
    try {
      const committed = await changedSince(repo, baseCommit, head, git);
      if (!committed) return { blocked: `The task's work shares no history with ${ref}, so the change cannot be measured.` };
      return { ref, raw, committed, tree: await commitTree(repo, head, git) };
    } finally {
      await git(["update-ref", "-d", headRef], repo).catch(() => undefined);
    }
  });
  if ("blocked" in read) return blocked(read.blocked);
  const { ref, raw, committed } = read;
  let config: VerifyConfig;
  try {
    config = parseVerifyConfig(JSON.parse(raw));
  } catch (error) {
    const detail = error instanceof VerifyConfigError ? error.message : "it is not valid JSON";
    return blocked(`The .codara/verify.json on ${ref} cannot be used: ${detail}.`);
  }
  // Unknown changes in the working tree run every check.
  const local = await workingTreeChanges(top, read.tree, git);
  const changed = { base: committed.base, files: local ? [...new Set([...committed.files, ...local])] : null };

  const checks = selectChecks(config, changed.files);
  const logDir = join(store.paths(workspaceId).dir, "verify", taskId, runId);
  await fs.mkdir(logDir, { recursive: true });

  const evidence: TaskEvidence[] = [];
  const timedOut = new Set<string>();
  const noSlot = new Set<string>();
  const timeouts: Record<string, number> = {};
  for (const check of checks) {
    if (options.signal?.aborted) return null;
    const logFile = join(logDir, `${check.id}.log`);
    const timeoutSec = check.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    timeouts[check.id] = timeoutSec;
    const result = await options.runCommand(check.run, {
      cwd: top,
      env: { CODARA_VERIFY_BASE: changed.base },
      logFile,
      timeoutMs: timeoutSec * 1000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.cancelled) return null;
    if (result.timedOut) timedOut.add(check.id);
    if (result.noSlot) noSlot.add(check.id);
    evidence.push({
      checkId: check.id,
      kind: "command",
      ok: result.exitCode === 0 && !result.timedOut && !result.spawnError,
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      artifact: logFile,
      runId,
      at: new Date(now()).toISOString(),
    });
  }
  const ok = evidence.every((item) => item.ok);
  return store.finishVerify(workspaceId, taskId, {
    runId,
    evidence,
    ...(ok ? {} : { reason: failureSentence(evidence, timedOut, timeouts, noSlot) }),
  });
}

export interface GateJob {
  workspaceId: string;
  taskId: string;
  runId: string;
  /** Aborted when the task leaves this verify run: moved out of verifying, dropped, or a newer run started. */
  signal: AbortSignal;
}

export interface GateScheduler {
  /** Starts the gate for a verify run; a second start of the same run does nothing. */
  start(workspaceId: string, taskId: string, runId: string): void;
  /** The run whose gate is going for the task, or null. */
  running(workspaceId: string, taskId: string): string | null;
}

/**
 * One gate per task. A newer verify run cancels the older one, and so does
 * the task leaving verifying: either way the old result would be stale and
 * its checks would only hold the heavy slot. A gate that throws sends the
 * task to the user instead of leaving it in verifying.
 */
export function createGateScheduler(options: {
  store: TaskStore;
  run: (job: GateJob) => Promise<void>;
  log?: (line: string) => void;
}): GateScheduler {
  const gates = new Map<string, { workspaceId: string; taskId: string; runId: string; abort: AbortController }>();
  const keyOf = (workspaceId: string, taskId: string) => `${workspaceId}/${taskId}`;

  options.store.onChange((workspaceId, state) => {
    for (const gate of gates.values()) {
      if (gate.workspaceId !== workspaceId) continue;
      const task = state.tasks.find((candidate) => candidate.id === gate.taskId);
      if (task?.state !== "verifying" || task.verify?.runId !== gate.runId) gate.abort.abort();
    }
  });

  return {
    start(workspaceId, taskId, runId) {
      const key = keyOf(workspaceId, taskId);
      const current = gates.get(key);
      if (current?.runId === runId) return;
      current?.abort.abort();
      const abort = new AbortController();
      gates.set(key, { workspaceId, taskId, runId, abort });
      void options
        .run({ workspaceId, taskId, runId, signal: abort.signal })
        .catch(async (error) => {
          options.log?.(`verify ${workspaceId} ${taskId} ${runId} failed: ${String(error)}`);
          await options.store
            .finishVerify(workspaceId, taskId, {
              runId,
              evidence: [],
              blocked: "The verify gate itself failed before it could check anything; Codara's log has the error.",
            })
            .catch(() => undefined);
        })
        .finally(() => {
          if (gates.get(key)?.runId === runId) gates.delete(key);
        });
    },
    running(workspaceId, taskId) {
      const gate = gates.get(keyOf(workspaceId, taskId));
      return gate && !gate.abort.signal.aborted ? gate.runId : null;
    },
  };
}
