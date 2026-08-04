import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isCodaraManagedCliPath } from "./codara-managed-cli-roots";

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function withoutTrailingSeparators(path: string): string {
  const parsed = resolve(path);
  if (samePath(path, parsed)) return path;
  return path.replace(/[\\/]+$/, "");
}

function assertCanonicalAbsolutePath(path: string, label: string): string {
  if (!path || !isAbsolute(path)) {
    throw new TypeError(`${label} must be a non-empty absolute path.`);
  }
  const canonical = resolve(path);
  if (!samePath(withoutTrailingSeparators(path), canonical)) {
    throw new Error(
      `${label} must be canonical and cannot contain traversal segments.`,
    );
  }
  return canonical;
}

function assertExistingNodeNotSymlink(
  path: string,
  label: string,
  expected: "directory" | "file",
  requireExisting = false,
): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (requireExisting) {
        throw new Error(`${label} does not exist.`);
      }
      return false;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symbolic link.`);
  }
  if (expected === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${label} must be a ${expected}.`);
  }
  return true;
}

/**
 * Like assertExistingNodeNotSymlink, but tolerant of the share links Codara
 * itself plants inside its managed account homes: a managed profile shares
 * sessions/, history.jsonl, and config.toml with the personal ~/.codex via
 * symlinks (see native-cli-shared-state.ts), so inside a Codara-managed home
 * a symlink at one of those names is the designed state, not an attack. The
 * link must still resolve to a real node of the expected type; a dangling
 * link behaves as missing. Personal (non-managed) homes keep the strict
 * no-symlink rule unchanged.
 */
function assertSharedNodeAllowingManagedLink(
  homeDir: string,
  path: string,
  label: string,
  expected: "directory" | "file",
): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    return assertExistingNodeNotSymlink(path, label, expected);
  }
  if (!isCodaraManagedCliPath(homeDir)) {
    throw new Error(`${label} cannot be a symbolic link.`);
  }
  let real: ReturnType<typeof statSync>;
  try {
    real = statSync(path);
  } catch {
    // The personal target disappeared; the next profile resolution re-heals.
    return false;
  }
  if (expected === "directory" ? !real.isDirectory() : !real.isFile()) {
    throw new Error(`${label} must be a ${expected}.`);
  }
  return true;
}

/**
 * The inherited CODEX_HOME, unless it names a directory Codara manages: Studio
 * itself may have been launched from a shell that sources the Active-account
 * env file, and following that selector would route "personal" work into a
 * managed account (see codara-managed-cli-roots.ts).
 */
function legacyPersonalCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  if (configured && !isCodaraManagedCliPath(configured)) return configured;
  return join(homedir(), ".codex");
}

/**
 * Resolve the exact native Codex home used by one helper operation.
 *
 * Explicit homes are deliberately stricter than ordinary path inputs: callers
 * must pass the already-resolved value returned by the account-profile store.
 * Omitting the argument preserves the legacy personal-home behavior.
 */
export function resolveCodexHomeDir(explicitHome?: string | null): string {
  const isExplicit = explicitHome !== undefined && explicitHome !== null;
  const configured = isExplicit
    ? explicitHome.trim()
    : legacyPersonalCodexHome();
  // Legacy personal routing resolves the configured/default path as it always
  // has. Selected account homes are already-resolved store output and must be
  // passed back exactly, preventing ambiguous `..` or relative routing.
  const home = isExplicit
    ? assertCanonicalAbsolutePath(configured, "Native Codex home")
    : resolve(configured);
  assertExistingNodeNotSymlink(home, "Native Codex home", "directory");
  return home;
}

export interface CodexHomePaths {
  homeDir: string;
  configPath: string;
  sessionsRoot: string;
  historyPath: string;
  memoriesRoot: string;
  shellSnapshotsRoot: string;
}

export function resolveCodexHomePaths(
  explicitHome?: string | null,
): CodexHomePaths {
  const homeDir = resolveCodexHomeDir(explicitHome);
  const configPath = join(homeDir, "config.toml");
  const sessionsRoot = join(homeDir, "sessions");
  const historyPath = join(homeDir, "history.jsonl");
  const memoriesRoot = join(homeDir, "memories");
  const shellSnapshotsRoot = join(homeDir, "shell_snapshots");
  // config/sessions/history/memories are shared-state names inside managed
  // homes and may legitimately be Codara's own links; shell_snapshots is
  // per-account and keeps the strict rule.
  assertSharedNodeAllowingManagedLink(
    homeDir,
    configPath,
    "Native Codex config",
    "file",
  );
  assertSharedNodeAllowingManagedLink(
    homeDir,
    sessionsRoot,
    "Native Codex session root",
    "directory",
  );
  assertSharedNodeAllowingManagedLink(
    homeDir,
    historyPath,
    "Native Codex history",
    "file",
  );
  assertSharedNodeAllowingManagedLink(
    homeDir,
    memoriesRoot,
    "Native Codex memories root",
    "directory",
  );
  assertExistingNodeNotSymlink(
    shellSnapshotsRoot,
    "Native Codex shell-snapshot root",
    "directory",
  );
  return {
    homeDir,
    configPath,
    sessionsRoot,
    historyPath,
    memoriesRoot,
    shellSnapshotsRoot,
  };
}

export function pathIsInsideCodexHome(
  homeDir: string,
  candidate: string,
): boolean {
  const relativePath = relative(homeDir, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export function resolveCodexSessionDirectoryPath(
  directoryPath: string,
  explicitHome?: string | null,
): string {
  const { sessionsRoot } = resolveCodexHomePaths(explicitHome);
  const candidate = assertCanonicalAbsolutePath(
    directoryPath,
    "Native Codex session directory",
  );
  if (!pathIsInsideCodexHome(sessionsRoot, candidate)) {
    throw new Error(
      "Native Codex session directory is outside the selected session store.",
    );
  }
  assertExistingNodeNotSymlink(
    candidate,
    "Native Codex session directory",
    "directory",
  );
  try {
    const realSessionsRoot = realpathSync(sessionsRoot);
    const realCandidate = realpathSync(candidate);
    if (!pathIsInsideCodexHome(realSessionsRoot, realCandidate)) {
      throw new Error(
        "Native Codex session directory resolves outside the selected session store.",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return candidate;
}

/**
 * Validate an existing transcript before reading, resuming, or deleting it.
 * The realpath check prevents a nested symlink from turning a lexically-safe
 * path into a file owned by another Codex home.
 */
export function resolveCodexTranscriptPath(
  transcriptPath: string,
  explicitHome?: string | null,
  options: { requireExisting?: boolean } = {},
): string {
  const { sessionsRoot } = resolveCodexHomePaths(explicitHome);
  const candidate = assertCanonicalAbsolutePath(
    transcriptPath,
    "Native Codex transcript path",
  );
  if (!pathIsInsideCodexHome(sessionsRoot, candidate)) {
    throw new Error(
      "Native Codex transcript is outside the selected session store.",
    );
  }
  assertExistingNodeNotSymlink(
    candidate,
    "Native Codex transcript",
    "file",
    options.requireExisting,
  );
  try {
    const realSessionsRoot = realpathSync(sessionsRoot);
    const realCandidate = realpathSync(candidate);
    if (!pathIsInsideCodexHome(realSessionsRoot, realCandidate)) {
      throw new Error(
        "Native Codex transcript resolves outside the selected session store.",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return candidate;
}
