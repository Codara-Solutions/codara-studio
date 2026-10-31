import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, sep, win32 } from "node:path";
import { lock } from "proper-lockfile";
import { isRemotePath } from "@shared/remote";
import type { Workspace } from "@shared/types";
import {
  CLAUDE_DEFAULT_PROJECT_CONFIG,
  claudePretrustedFoldersFile,
  formatClaudePretrustedFolders,
  readClaudePretrustedFolders,
} from "./claude-follow/config-sync";
import { logMain } from "./file-log";
import {
  claudeGlobalConfigFile,
  claudeLiveHome,
  updateClaudeGlobalConfig,
  type ClaudeLiveHome,
} from "./orchestration/claude-cli-live-login";
import { atomicWritePrivateFile } from "./orchestration/native-cli-atomic-file";
import { workspaceProjectPolicyModeForTerminalCwd } from "./orchestration/project-policy";
import { holdsPullRequestCode, isPullRequestRef } from "./pull-request-code";

/**
 * Folder trust for the Claude Code sessions Codara starts. Claude Code asks
 * "Quick safety check... Yes, I trust this folder" before it runs in a folder
 * with no trust record, and nobody can answer that for an agent Codara (or
 * another agent) opens in a new pane. Codex gets its trust per launch on the
 * command line (codexTrustOverride); Claude Code has no such flag, so the
 * record is written into the live slot's `.claude.json` before the launch.
 *
 * Only a folder the user added as a workspace, or a worktree Codara made from
 * one, is trusted: never pull-request code (an import, or a worktree made
 * from one), never a repository nested inside the workspace, never the home
 * folder, a folder above it or a filesystem root. Trust is only added: an
 * existing record and every other key stay as they are. The live slot's file
 * is written only when it already exists, because a managed home is seeded
 * from the user's own `.claude.json` on first use (cli-account-homes.ts) and
 * a file created here would stop that.
 *
 * The user's own `.claude.json` is never written, directly or through
 * claude-follow's sync: every folder trusted here is listed in Codara's
 * record next to the live slot, and the sync leaves those out. A session on
 * the System login still shows the prompt, on purpose: that user is at a
 * terminal of their own and can answer it.
 *
 * Claude Code 2.1.311 looks the record up under the physical path of its
 * working directory (symlinks resolved), and walks up from there to the
 * nearest folder holding `.git` (a directory, or a worktree's file), or to
 * the filesystem root outside a repository. A record on a parent of a
 * repository therefore does not cover it, and each repository and worktree
 * needs its own. The key written here is that nearest root: for a worktree
 * its own root, not the main repository Claude's own prompt records, so one
 * worktree never trusts its siblings. A workspace that is a folder inside a
 * repository is recorded as itself instead (it is on the same walk, and
 * trusting the whole repository would reach past what the user added).
 */

/** Claude Code reads no persisted trust at all while this is set. */
export const CLAUDE_IGNORE_PERSISTED_TRUST_ENV = "CLAUDE_CODE_IGNORE_PERSISTED_TRUST";

/** How long a launch waits for the record before it starts anyway. */
export const CLAUDE_PRETRUST_WAIT_MS = 3_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A path as Claude Code writes it into `projects`: forward slashes on Windows, NFC. */
export function claudeProjectKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = path.normalize("NFC");
  return platform === "win32" ? normalized.replaceAll("\\", "/") : normalized;
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

async function holdsGit(dir: string): Promise<boolean> {
  try {
    const stats = await fs.stat(join(dir, ".git"));
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

/** The nearest folder at or above `dir` that holds `.git`, or null outside a repository. */
export async function claudeGitRoot(dir: string): Promise<string | null> {
  let current = dir;
  for (;;) {
    if (await holdsGit(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The folder Claude Code would record trust under for a session in `cwd`:
 * the repository root (a worktree's own root) when `cwd` is inside one,
 * otherwise `cwd` itself, both as physical paths. Null when `cwd` is gone.
 */
export async function claudeTrustRoot(cwd: string): Promise<string | null> {
  const real = await realpathOrNull(cwd);
  if (!real) return null;
  return (await claudeGitRoot(real)) ?? real;
}

type TrustWorkspace = Pick<Workspace, "cwd" | "copyBranch">;

/**
 * Claude Code never records trust for the home folder itself, and outside a
 * repository its lookup walks every parent up to the filesystem root: a
 * record on the home folder, on a folder above it, or on a root (a Windows
 * drive included) would trust every folder below it that is not a repository.
 */
export async function isTooBroadToTrust(
  key: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const paths = platform === "win32" ? win32 : posix;
  if (paths.dirname(key) === key || paths.parse(key).root === key) return true;
  const realHome = (await realpathOrNull(home)) ?? home;
  return isInside(key, realHome);
}

/**
 * The key to trust for a Claude session in `cwd`, or null when it must not
 * be trusted: `cwd` is outside every local workspace (a worktree Codara made
 * is one), inside pull-request code, in a repository nested in the workspace
 * (a clone, a vendored copy, a submodule), gone, or the key would be the home
 * folder, a folder above it or a filesystem root.
 */
export async function claudeTrustKeyForCwd(
  cwd: string,
  workspaces: readonly TrustWorkspace[],
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): Promise<string | null> {
  if (!cwd.trim() || isRemotePath(cwd)) return null;
  if ((await workspaceProjectPolicyModeForTerminalCwd(cwd, workspaces)) !== "trusted") return null;
  const real = await realpathOrNull(cwd);
  if (!real) return null;
  let scope: string | null = null;
  for (const workspace of workspaces) {
    if (!workspace.cwd.trim() || isRemotePath(workspace.cwd)) continue;
    const root = await realpathOrNull(workspace.cwd);
    if (!root || !isInside(root, real)) continue;
    if (holdsPullRequestCode(workspace)) return null;
    // The innermost workspace decides: a worktree kept inside its repository
    // is its own scope, not the enclosing one's.
    if (scope === null || root.length > scope.length) scope = root;
  }
  if (scope === null) return null;
  const gitRoot = await claudeGitRoot(real);
  if (gitRoot !== (await claudeGitRoot(scope))) return null;
  const key = gitRoot === null ? real : isInside(scope, gitRoot) ? gitRoot : scope;
  if (await isTooBroadToTrust(key, home, platform)) return null;
  return claudeProjectKey(key, platform);
}

export type ClaudeTrustWrite = "added" | "present" | "no-config" | "no-record";

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  const stats = await fs.lstat(file).catch(() => null);
  if (!stats?.isFile()) return null;
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Claude Code's config file is not an object");
  return parsed;
}

/**
 * Add `projects[key].hasTrustDialogAccepted = true` to a live slot's
 * `.claude.json` under Claude Code's own lock. A folder Claude Code has no
 * entry for gets the entry its prompt would write; an existing entry keeps
 * every other key. A missing file is not created, checked again inside the
 * lock. The folder is listed in Codara's record first (under that record's
 * own lock), so claude-follow never sees the trust without the listing and
 * never copies it into the user's `.claude.json`; a folder that was already
 * trusted by someone else is not listed.
 */
export async function addClaudeFolderTrust(home: ClaudeLiveHome, key: string): Promise<ClaudeTrustWrite> {
  const file = await claudeGlobalConfigFile(home);
  if (!(await fs.lstat(file).catch(() => null))?.isFile()) return "no-config";
  const record = claudePretrustedFoldersFile(home);
  const release = await lock(record, {
    realpath: false,
    lockfilePath: `${record}.lock`,
    retries: { retries: 20, minTimeout: 50, maxTimeout: 500 },
    stale: 10_000,
  });
  try {
    const current = await readJsonObject(file);
    if (!current) return "no-config";
    // An unreadable list is never rewritten: the folders it held would leave
    // it and claude-follow would copy their trust to the user's file.
    const list = await readClaudePretrustedFolders(home);
    if (list.kind === "unreadable") return "no-record";
    const listed = list.kind === "listed" ? list.folders : new Set<string>();
    const projects = isRecord(current.projects) ? current.projects : {};
    const entry = projects[key];
    if (isRecord(entry) && entry.hasTrustDialogAccepted === true) return "present";
    if (!listed.has(key)) {
      listed.add(key);
      await atomicWritePrivateFile(record, formatClaudePretrustedFolders(listed));
    }
    let seen = false;
    let added = false;
    await updateClaudeGlobalConfig(
      home,
      (config) => {
        seen = true;
        if (config.projects !== undefined && !isRecord(config.projects)) return null;
        const inner = (config.projects ?? {}) as Record<string, unknown>;
        const existing = inner[key];
        if (existing !== undefined && !isRecord(existing)) return null;
        if (isRecord(existing) && existing.hasTrustDialogAccepted === true) return null;
        added = true;
        const base = isRecord(existing) ? existing : structuredClone(CLAUDE_DEFAULT_PROJECT_CONFIG);
        return { ...config, projects: { ...inner, [key]: { ...base, hasTrustDialogAccepted: true } } };
      },
      undefined,
      { onlyIfExists: true },
    );
    if (!seen) return "no-config";
    return added ? "added" : "present";
  } finally {
    await release().catch(() => undefined);
  }
}

export interface ClaudePretrustDeps {
  workspaces(): Promise<readonly TrustWorkspace[]>;
  /** The live slot every managed Claude session runs in. */
  home(): ClaudeLiveHome;
  log(message: string): void;
  platform?: NodeJS.Platform;
  waitMs?: number;
}

async function productionDeps(): Promise<ClaudePretrustDeps> {
  const [{ loadState }, { nativeClaudeProfileStore }] = await Promise.all([
    import("./storage"),
    import("./orchestration/native-claude-profile-runtime"),
  ]);
  return {
    workspaces: async () => (await loadState()).workspaces,
    home: () => claudeLiveHome(nativeClaudeProfileStore),
    log: (message) => logMain("claude-trust", message),
  };
}

function logTo(deps: ClaudePretrustDeps | null): (message: string) => void {
  return deps?.log ?? ((message) => logMain("claude-trust", message));
}

function ignoresPersistedTrust(env: Record<string, string | undefined> | undefined): boolean {
  const value = env?.[CLAUDE_IGNORE_PERSISTED_TRUST_ENV] ?? process.env[CLAUDE_IGNORE_PERSISTED_TRUST_ENV];
  return typeof value === "string" && value.trim() !== "" && value.trim() !== "0" && value.trim().toLowerCase() !== "false";
}

/**
 * Trust `cwd` for the Claude session about to start there, when it is in
 * scope. Never throws and never holds a launch longer than `waitMs`: a write
 * that fails or is still waiting for the lock leaves the normal prompt.
 */
export async function pretrustClaudeFolder(
  cwd: string,
  options: {
    env?: Record<string, string | undefined>;
    workspaces?: readonly TrustWorkspace[];
    deps?: ClaudePretrustDeps;
  } = {},
): Promise<ClaudeTrustWrite | "skipped" | "failed" | "timed-out"> {
  if (ignoresPersistedTrust(options.env)) return "skipped";
  let deps: ClaudePretrustDeps | null = options.deps ?? null;
  const work = (async (): Promise<ClaudeTrustWrite | "skipped" | "failed"> => {
    try {
      deps ??= await productionDeps();
      const key = await claudeTrustKeyForCwd(cwd, options.workspaces ?? (await deps.workspaces()), deps.platform);
      if (!key) return "skipped";
      const result = await addClaudeFolderTrust(deps.home(), key);
      if (result === "added") deps.log(`trusted ${key} for Claude Code`);
      if (result === "no-record") deps.log(`did not trust ${key}: ${claudePretrustedFoldersFile(deps.home())} is unreadable`);
      return result;
    } catch (error) {
      logTo(deps)(`could not trust ${cwd} for Claude Code: ${error instanceof Error ? error.message : String(error)}`);
      return "failed";
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed-out">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timed-out"), options.deps?.waitMs ?? CLAUDE_PRETRUST_WAIT_MS);
  });
  try {
    const result = await Promise.race([work, timeout]);
    if (result === "timed-out") logTo(deps)(`gave up waiting to trust ${cwd} for Claude Code; the launch goes on`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trust a worktree Codara just made from `sourceCwd`, before it is saved as a
 * workspace of its own, so the first Claude pane there never asks. Only when
 * `sourceCwd` itself is in scope and the checked-out `branch` is not a
 * pull request's.
 */
export async function pretrustClaudeWorktree(
  worktreePath: string,
  sourceCwd: string,
  options: { branch?: string | null; deps?: ClaudePretrustDeps } = {},
): Promise<ClaudeTrustWrite | "skipped" | "failed" | "timed-out"> {
  if (isPullRequestRef(options.branch)) return "skipped";
  let deps: ClaudePretrustDeps | null = options.deps ?? null;
  try {
    deps ??= await productionDeps();
    const workspaces = await deps.workspaces();
    if ((await claudeTrustKeyForCwd(sourceCwd, workspaces, deps.platform)) === null) return "skipped";
    return await pretrustClaudeFolder(worktreePath, { workspaces: [...workspaces, { cwd: worktreePath }], deps });
  } catch (error) {
    logTo(deps)(`could not trust ${worktreePath} for Claude Code: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}
