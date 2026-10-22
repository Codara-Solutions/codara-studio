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
import { createWriteStream, promises as fs } from "node:fs";
import { join, sep } from "node:path";

import type { Task, TaskEvidence } from "@shared/cos-tasks";
import { isRemotePath } from "@shared/remote";
import { processEnvWithoutElectronViteDev } from "../env-sanitize";
import { gitChildEnv } from "../git-env";
import type { TaskStore } from "./task-store";

export const VERIFY_CONFIG_PATH = join(".codara", "verify.json");
const REMOTE = "origin";
// Where the gate fetches the base branch to: a namespace of Codara's own that
// it overwrites before every read, so no ref the agent moved is ever trusted.
const BASE_REF_PREFIX = "refs/codara/verify-base";
const GIT_TIMEOUT_MS = 90_000;
const DEFAULT_TIMEOUT_SEC = 20 * 60;
const MAX_TIMEOUT_SEC = 2 * 60 * 60;
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
  spawnError?: string;
}

export type CommandRunner = (
  command: string,
  options: { cwd: string; env: Record<string, string>; logFile: string; timeoutMs: number; signal?: AbortSignal },
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
 * wrapper workflow agents use.
 */
export function createCommandRunner(heavy?: { bin: string; env: Record<string, string> } | null): CommandRunner {
  return (command, options) =>
    new Promise((resolve) => {
      const line = heavy ? `${quoteForShell(heavy.bin)} /bin/sh -c ${quoteForShell(command)}` : command;
      const shell = loginShell();
      const args = process.platform === "win32" ? ["/d", "/s", "/c", line] : ["-lc", line];
      const log = createWriteStream(options.logFile, { flags: "w", mode: 0o600 });
      log.on("error", () => undefined);
      log.write(`$ ${command}\n\n`);
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let timer: NodeJS.Timeout | undefined;
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
      const finish = (result: Omit<CommandResult, "timedOut" | "cancelled">) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        liveChecks.delete(stop);
        options.signal?.removeEventListener("abort", stop);
        killGroup();
        for (const stream of [child?.stdout, child?.stderr]) {
          stream?.unpipe(log);
          stream?.destroy();
        }
        const tail = result.spawnError
          ? `\n[could not start: ${result.spawnError}]\n`
          : `\n[exit ${result.exitCode ?? "none"}${timedOut ? ", timed out" : ""}${cancelled ? ", cancelled" : ""}]\n`;
        log.end(tail, () => resolve({ ...result, timedOut, ...(cancelled ? { cancelled } : {}) }));
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
          stdio: ["ignore", "pipe", "pipe"],
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
      timer = setTimeout(() => {
        timedOut = true;
        finish({ exitCode: null });
      }, options.timeoutMs);
    });
}

// A fetch that waits on a network or an SSH prompt ends with the gate
// blocked instead of holding the task in verifying.
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitChildEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
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
      else reject(new Error(`git ${args[0]} exited ${code}`));
    });
  });

const BRANCH_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** The branch origin's HEAD points at, asked of origin itself: a local origin/HEAD is the agent's to move. */
async function remoteDefaultBranch(cwd: string, git: GitRunner): Promise<string | null> {
  try {
    const out = await git(["ls-remote", "--symref", REMOTE, "HEAD"], cwd);
    const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out);
    return match && BRANCH_NAME.test(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}

/** Fetches origin's `branch` into Codara's own ref and returns its commit, or null. */
async function fetchBase(cwd: string, branch: string, git: GitRunner): Promise<string | null> {
  const ref = `${BASE_REF_PREFIX}/${branch}`;
  try {
    await git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", REMOTE, `+refs/heads/${branch}:${ref}`], cwd);
    return (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)).trim() || null;
  } catch {
    return null;
  }
}

/** The merge base with `baseCommit` and the files changed since it, or null when git cannot say. */
export async function changedSince(cwd: string, baseCommit: string, git: GitRunner): Promise<{ base: string; files: string[] } | null> {
  try {
    const base = (await git(["merge-base", "HEAD", baseCommit], cwd)).trim();
    if (!base) return null;
    const tracked = await git(["diff", "--name-only", base], cwd);
    const untracked = await git(["ls-files", "--others", "--exclude-standard"], cwd);
    const files = [...new Set(`${tracked}\n${untracked}`.split("\n").map((line) => line.trim()).filter(Boolean))];
    return { base, files };
  } catch {
    return null;
  }
}

function minutes(seconds: number): string {
  const value = Math.round(seconds / 60);
  return value === 1 ? "1 minute" : `${value} minutes`;
}

/** One plain sentence on what failed, for the task's needs_you reason. */
export function failureSentence(evidence: readonly TaskEvidence[], timedOut: ReadonlySet<string>, timeouts: Record<string, number>): string {
  const failed = evidence.filter((item) => !item.ok);
  if (failed.length === 1) {
    const [item] = failed;
    const why = timedOut.has(item.checkId)
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

  const branch = options.baseBranch?.trim() || (await remoteDefaultBranch(cwd, git));
  if (!branch) return blocked(`Codara cannot reach ${REMOTE} to find the base branch the repository's checks are read from.`);
  if (!BRANCH_NAME.test(branch)) return blocked(`The base branch "${branch}" is not a branch name Codara can fetch.`);
  const ref = `${REMOTE}/${branch}`;
  const baseCommit = await fetchBase(cwd, branch, git);
  if (!baseCommit) return blocked(`Codara could not fetch ${ref}, so the repository's checks could not be read.`);
  let raw: string;
  try {
    raw = await git(["show", `${baseCommit}:.codara/verify.json`], cwd);
  } catch {
    return blocked(`${ref} has no .codara/verify.json, so nothing can prove the task is done.`);
  }
  let config: VerifyConfig;
  try {
    config = parseVerifyConfig(JSON.parse(raw));
  } catch (error) {
    const detail = error instanceof VerifyConfigError ? error.message : "it is not valid JSON";
    return blocked(`The .codara/verify.json on ${ref} cannot be used: ${detail}.`);
  }
  const changed = await changedSince(cwd, baseCommit, git);
  if (!changed) return blocked(`The task's work shares no history with ${ref}, so the change cannot be measured.`);

  const checks = selectChecks(config, changed.files);
  const logDir = join(store.paths(workspaceId).dir, "verify", taskId, runId);
  await fs.mkdir(logDir, { recursive: true });

  const evidence: TaskEvidence[] = [];
  const timedOut = new Set<string>();
  const timeouts: Record<string, number> = {};
  for (const check of checks) {
    if (options.signal?.aborted) return null;
    const logFile = join(logDir, `${check.id}.log`);
    const timeoutSec = check.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    timeouts[check.id] = timeoutSec;
    const result = await options.runCommand(check.run, {
      cwd,
      env: { CODARA_VERIFY_BASE: changed.base },
      logFile,
      timeoutMs: timeoutSec * 1000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.cancelled) return null;
    if (result.timedOut) timedOut.add(check.id);
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
    ...(ok ? {} : { reason: failureSentence(evidence, timedOut, timeouts) }),
  });
}
