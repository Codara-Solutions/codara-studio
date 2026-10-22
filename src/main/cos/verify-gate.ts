// The verify gate: the only thing that closes a task. It reads the checks the
// repository owns (<repo>/.codara/verify.json), runs the ones the change can
// affect in the task's folder, writes each check's full output to a log, and
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
import { join } from "node:path";

import type { Task, TaskEvidence } from "@shared/cos-tasks";
import { processEnvWithoutElectronViteDev } from "../env-sanitize";
import type { TaskStore } from "./task-store";

export const VERIFY_CONFIG_PATH = join(".codara", "verify.json");
const DEFAULT_BASES = ["origin/main", "main"];
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

export interface VerifyConfig {
  /** Refs the change is measured against, first that resolves wins. */
  base: string[];
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
  const base = value.base === undefined ? DEFAULT_BASES : stringList(typeof value.base === "string" ? [value.base] : value.base, "base");
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
  return { base, checks };
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
  spawnError?: string;
}

export type CommandRunner = (
  command: string,
  options: { cwd: string; env: Record<string, string>; logFile: string; timeoutMs: number },
) => Promise<CommandResult>;

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

function quoteForShell(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function loginShell(): string {
  const sh = process.env.SHELL && /\/(zsh|bash|sh)$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/bash";
  return process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : sh;
}

/**
 * Runs `command` through the user's login shell (PATH from their profile, as
 * in a terminal), output to `logFile`, killing the whole process group on
 * timeout. With `heavy` it runs inside codara-heavy: one machine-wide slot
 * and a memory cap, the same wrapper workflow agents use.
 */
export function createCommandRunner(heavy?: { bin: string; env: Record<string, string> } | null): CommandRunner {
  return (command, options) =>
    new Promise((resolve) => {
      const line = heavy ? `${quoteForShell(heavy.bin)} /bin/sh -c ${quoteForShell(command)}` : command;
      const shell = loginShell();
      const args = process.platform === "win32" ? ["/d", "/s", "/c", line] : ["-lc", line];
      const log = createWriteStream(options.logFile, { flags: "w", mode: 0o600 });
      log.write(`$ ${command}\n\n`);
      let settled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: Omit<CommandResult, "timedOut">) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const tail = result.spawnError
          ? `\n[could not start: ${result.spawnError}]\n`
          : `\n[exit ${result.exitCode ?? "none"}${timedOut ? ", timed out" : ""}]\n`;
        log.end(tail, () => resolve({ ...result, timedOut }));
      };
      let child: ReturnType<typeof spawn>;
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
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      child.on("error", (error) => finish({ exitCode: null, spawnError: error.message }));
      child.on("close", (code) => finish({ exitCode: code }));
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, options.timeoutMs);
    });
}

export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} exited ${code}`))));
  });

/** The merge base the change is measured from and the files it touches, or null when git cannot say. */
export async function changedSinceBase(
  cwd: string,
  bases: readonly string[],
  git: GitRunner,
): Promise<{ base: string; files: string[] } | null> {
  for (const ref of bases) {
    let base: string;
    try {
      base = (await git(["merge-base", "HEAD", ref], cwd)).trim();
    } catch {
      continue;
    }
    if (!base) continue;
    try {
      const tracked = await git(["diff", "--name-only", base], cwd);
      const untracked = await git(["ls-files", "--others", "--exclude-standard"], cwd);
      const files = [...new Set(`${tracked}\n${untracked}`.split("\n").map((line) => line.trim()).filter(Boolean))];
      return { base, files };
    } catch {
      return null;
    }
  }
  return null;
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

export interface VerifyGateOptions {
  store: TaskStore;
  workspaceId: string;
  taskId: string;
  runId: string;
  /** The folder the task's work is in: its worktree, else the workspace's folder. */
  cwd: string | null;
  runCommand: CommandRunner;
  git?: GitRunner;
  now?: () => number;
}

/** Runs the gate for one verify run and records its result; resolves to the task as it then stands. */
export async function runVerifyGate(options: VerifyGateOptions): Promise<Task> {
  const { store, workspaceId, taskId, runId } = options;
  const now = options.now ?? (() => Date.now());
  const blocked = (sentence: string) => store.finishVerify(workspaceId, taskId, { runId, evidence: [], blocked: sentence });

  const cwd = options.cwd;
  if (!cwd || !(await fs.stat(cwd).then((stat) => stat.isDirectory(), () => false))) {
    return blocked("Codara cannot tell which folder this task's work is in, so nothing could be checked; set the task's worktree.");
  }
  let config: VerifyConfig;
  try {
    config = parseVerifyConfig(JSON.parse(await fs.readFile(join(cwd, VERIFY_CONFIG_PATH), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return blocked("This repository has no .codara/verify.json, so nothing can prove the task is done.");
    }
    const detail = error instanceof VerifyConfigError ? error.message : "it is not valid JSON";
    return blocked(`The repository's .codara/verify.json cannot be used: ${detail}.`);
  }

  const changed = await changedSinceBase(cwd, config.base, options.git ?? defaultGitRunner);
  const checks = selectChecks(config, changed?.files ?? null);
  const logDir = join(store.paths(workspaceId).dir, "verify", taskId, runId);
  await fs.mkdir(logDir, { recursive: true });

  const evidence: TaskEvidence[] = [];
  const timedOut = new Set<string>();
  const timeouts: Record<string, number> = {};
  for (const check of checks) {
    const logFile = join(logDir, `${check.id}.log`);
    const timeoutSec = check.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    timeouts[check.id] = timeoutSec;
    const result = await options.runCommand(check.run, {
      cwd,
      env: changed ? { CODARA_VERIFY_BASE: changed.base } : {},
      logFile,
      timeoutMs: timeoutSec * 1000,
    });
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
