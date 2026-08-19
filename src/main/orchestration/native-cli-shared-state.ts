// Shared user-state surfaces between the personal CLI home (~/.claude /
// ~/.codex) and every Codara-managed account directory.
//
// A managed account used to be a born-empty, fully isolated config dir, so
// switching the Active account meant an empty /resume, no settings, and no
// history. The product intent is "logout + login in one home": chats,
// settings, and history are USER state that survives an account switch;
// only credentials and identity are per-account. This module realizes that by
// symlinking an explicit allowlist of state names in each managed directory
// at the personal home's equivalents, and by healing whatever a CLI (or a
// pre-feature Codara) left behind as real files/directories.
//
// Why an allowlist and not a denylist: an allowlist fails SAFE — when a new
// CLI version invents a new top-level name, that name silently stays
// per-account (a UX gap someone will notice and fix). A denylist fails
// DANGEROUS — a new credential-bearing name would be shared across accounts
// the day it ships. Unrecognized names found in the personal home are logged
// (once per name per process) so new CLI versions get noticed; classify them
// into one of the exported lists below to resolve the warning.
//
// Everything here is best-effort main-process work: ensureSharedCliState
// never throws, and one name's failure never blocks the others, because
// profile resolution (the caller) must keep launching terminals even when a
// single link could not be made.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type NativeCliSharedStateRuntime = "claude" | "codex" | "grok";

/**
 * How one shared name is established/healed:
 * - "link": always ensure the symlink, creating the personal target when it
 *   is missing (directories) or linking only when the personal file exists.
 * - "link-if-personal": like "link", but a missing managed entry is linked
 *   only when the personal home already has the name (legacy CLI layouts —
 *   creating them fresh would resurrect a retired layout).
 * - "line-union": JSONL logs. A real managed copy is merged into the
 *   personal file as a line union (personal lines in order, then managed
 *   lines not already present, deduped by exact line content). Claude has a
 *   cleanup pass that can compact/rewrite history (~/.claude/.last-cleanup),
 *   so after divergence one side may be compacted while the other holds
 *   fresh appends — newest-mtime-wins would lose data in both directions.
 * - "newest-wins": ordinary files. Identical copies just relink; on
 *   divergence the newest mtime wins and the losing content is preserved as
 *   a `.codara-backup-<ts>` file beside the personal target, so healing
 *   never silently discards either side's edits.
 */
export type NativeCliSharedStateHeal =
  | "link"
  | "link-if-personal"
  | "line-union"
  | "newest-wins";

export interface NativeCliSharedStateName {
  name: string;
  kind: "dir" | "file";
  heal: NativeCliSharedStateHeal;
}

/**
 * Claude Code state shared with the personal config dir. Closed list — never
 * add a name without confirming it can never carry a credential, an account
 * identity, or per-process live state.
 */
export const CLAUDE_CLI_SHARED_STATE: readonly NativeCliSharedStateName[] = [
  { name: "projects", kind: "dir", heal: "link" },
  { name: "tasks", kind: "dir", heal: "link" },
  { name: "teams", kind: "dir", heal: "link" },
  { name: "session-env", kind: "dir", heal: "link" },
  { name: "file-history", kind: "dir", heal: "link" },
  { name: "memory", kind: "dir", heal: "link" },
  { name: "paste-cache", kind: "dir", heal: "link" },
  { name: "shell-snapshots", kind: "dir", heal: "link" },
  { name: "agents", kind: "dir", heal: "link" },
  { name: "commands", kind: "dir", heal: "link" },
  { name: "skills", kind: "dir", heal: "link" },
  { name: "plugins", kind: "dir", heal: "link" },
  { name: "output-styles", kind: "dir", heal: "link" },
  { name: "hooks", kind: "dir", heal: "link" },
  // Older CLIs only; never resurrected on accounts that predate it.
  { name: "todos", kind: "dir", heal: "link-if-personal" },
  { name: "settings.json", kind: "file", heal: "newest-wins" },
  { name: "CLAUDE.md", kind: "file", heal: "newest-wins" },
  { name: "history.jsonl", kind: "file", heal: "line-union" },
];

/**
 * Claude names that deliberately stay per-account. `sessions/` is a LIVE
 * session registry keyed by PID — sharing it would let a session under one
 * account try to attach to another account's running session. daemon/,
 * daemon.log, and jobs/ execute under the account that owns the daemon, so
 * sharing them would bill the wrong account. This list only informs the
 * unrecognized-name log; privacy is the default for every name not in the
 * share list. settings.local.json deliberately stays local to the account,
 * and statusline-command.sh keeps its per-account copy: the shared
 * settings.json references it by absolute path into ~/.claude, so the
 * personal script runs either way.
 */
export const CLAUDE_CLI_PRIVATE_STATE_NAMES: readonly string[] = [
  "sessions",
  "statsig",
  "logs",
  "ide",
  "local",
  "cache",
  "backups",
  "telemetry",
  "daemon",
  "daemon.log",
  "jobs",
  "downloads",
  "settings.local.json",
  "debug",
  "chrome",
  "image-cache",
  "mcp-needs-auth-cache.json",
  "statusline-command.sh",
];

/**
 * Codex state shared with the personal home. `memories` is the DIRECTORY
 * only — the top-level *.sqlite databases (and their -wal/-shm journals)
 * remain per-account in v1: concurrent writers from two accounts aliasing
 * one database file is a corruption risk the flat JSONL surfaces don't have.
 */
export const CODEX_CLI_SHARED_STATE: readonly NativeCliSharedStateName[] = [
  { name: "sessions", kind: "dir", heal: "link" },
  { name: "archived_sessions", kind: "dir", heal: "link" },
  { name: "prompts", kind: "dir", heal: "link" },
  { name: "skills", kind: "dir", heal: "link" },
  { name: "plugins", kind: "dir", heal: "link" },
  { name: "memories", kind: "dir", heal: "link" },
  { name: "generated_images", kind: "dir", heal: "link" },
  { name: "visualizations", kind: "dir", heal: "link" },
  { name: "session_index.jsonl", kind: "file", heal: "line-union" },
  { name: "history.jsonl", kind: "file", heal: "line-union" },
  { name: "config.toml", kind: "file", heal: "newest-wins" },
  { name: "AGENTS.md", kind: "file", heal: "newest-wins" },
  { name: "ssh-config.toml", kind: "file", heal: "newest-wins" },
];

/**
 * Codex names that deliberately stay per-account. auth.json is the
 * credential; browser/ and computer-use/ carry auth-adjacent browser state.
 * Like the Claude list, this only informs the log — privacy is the default.
 * (.codex-global-state.json, .personality_migration, .sandbox_migration and
 * config.toml.bak* are covered by the dot-prefix/backup-suffix rules.)
 */
export const GROK_CLI_SHARED_STATE: readonly NativeCliSharedStateName[] = [
  { name: "sessions", kind: "dir", heal: "link" },
  { name: "skills", kind: "dir", heal: "link" },
  { name: "personas", kind: "dir", heal: "link" },
  { name: "memory", kind: "dir", heal: "link" },
  { name: "config.toml", kind: "file", heal: "newest-wins" },
  { name: "AGENTS.md", kind: "file", heal: "newest-wins" },
];

export const GROK_CLI_PRIVATE_STATE_NAMES: readonly string[] = [
  "auth.json",
  "mcp_credentials.json",
  "logs",
  "crash",
  "trace-exports",
  "worktrees",
  "tmp",
  "cache",
  "version.json",
];

export const CODEX_CLI_PRIVATE_STATE_NAMES: readonly string[] = [
  "auth.json",
  "log",
  "ipc",
  "tmp",
  "installation_id",
  "version.json",
  "models_cache.json",
  "cache",
  "shell_snapshots",
  "browser",
  "computer-use",
  "mcp-oauth-locks",
  "node_repl",
  "pets",
  "process_manager",
  "recovery_backups",
  "sqlite",
  "vendor_imports",
  "chrome-native-hosts-v2.json",
];

export const CLAUDE_CLI_SHARED_STATE_DIR_SET: ReadonlySet<string> = new Set(
  CLAUDE_CLI_SHARED_STATE.filter((entry) => entry.kind === "dir").map((entry) => entry.name),
);
export const CLAUDE_CLI_SHARED_STATE_FILE_SET: ReadonlySet<string> = new Set(
  CLAUDE_CLI_SHARED_STATE.filter((entry) => entry.kind === "file").map((entry) => entry.name),
);
export const GROK_CLI_SHARED_STATE_DIR_SET: ReadonlySet<string> = new Set(
  GROK_CLI_SHARED_STATE.filter((entry) => entry.kind === "dir").map((entry) => entry.name),
);
export const GROK_CLI_SHARED_STATE_FILE_SET: ReadonlySet<string> = new Set(
  GROK_CLI_SHARED_STATE.filter((entry) => entry.kind === "file").map((entry) => entry.name),
);
export interface EnsureSharedCliStateInput {
  /** A Codara-managed account directory (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  managedDir: string;
  /** The personal home the state is shared with (~/.claude / ~/.codex). */
  personalDir: string;
  runtime: NativeCliSharedStateRuntime;
}

export type SharedCliStateOutcome =
  | "linked"
  | "healed-file"
  | "merged-dir"
  | "skipped-missing"
  | "error";

export interface SharedCliStateEntry {
  name: string;
  kind: "dir" | "file";
  outcome: SharedCliStateOutcome;
  detail?: string;
}

export interface SharedCliStateResult {
  runtime: NativeCliSharedStateRuntime;
  /** Set when the whole pass was skipped; entries is empty then. */
  skipped?: "win32" | "unsafe-input";
  entries: SharedCliStateEntry[];
}

const SWAP_MAX_ATTEMPTS = 3;
const MERGE_MAX_DEPTH = 32;

const warnedUnrecognizedNames = new Set<string>();

function timestampToken(): string {
  // ISO instant with the characters Finder/renames dislike replaced, so the
  // backup/stash names sort chronologically and stay portable.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * SQLite artifacts (databases and their -wal/-shm journals) must never be
 * copied, moved, or linked anywhere near the personal side: a journal landing
 * beside a database it does not belong to corrupts that database on the next
 * open, and aliasing one database under two accounts invites concurrent
 * writers. Nothing on the share allowlists names one today — this guards the
 * merge/heal paths should a future CLI nest a database inside a shared dir.
 */
function isSqliteArtifactName(name: string): boolean {
  return /-(wal|shm)$/.test(name) || /\.sqlite[^/]*$/.test(name);
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  return fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
}

function sharedStateSpec(
  runtime: NativeCliSharedStateRuntime,
): readonly NativeCliSharedStateName[] {
  if (runtime === "claude") return CLAUDE_CLI_SHARED_STATE;
  if (runtime === "grok") return GROK_CLI_SHARED_STATE;
  return CODEX_CLI_SHARED_STATE;
}

function isRecognizedPersonalName(
  runtime: NativeCliSharedStateRuntime,
  name: string,
): boolean {
  if (name.startsWith(".")) return true; // dot-prefixed misc (.DS_Store, .last-*, migrations)
  if (sharedStateSpec(runtime).some((entry) => entry.name === name)) return true;
  const privateNames =
    runtime === "claude"
      ? CLAUDE_CLI_PRIVATE_STATE_NAMES
      : runtime === "grok"
        ? GROK_CLI_PRIVATE_STATE_NAMES
        : CODEX_CLI_PRIVATE_STATE_NAMES;
  if (privateNames.includes(name)) return true;
  if (name.includes(".sqlite") || isSqliteArtifactName(name)) return true;
  // Backup copies users, tools, and this module leave beside the originals.
  if (name.includes(".codara-backup-")) return true;
  if (/\.(bak|backup|before)([-.]|$)/.test(name)) return true;
  if (name.endsWith(".tmp")) return true;
  return false;
}

async function warnUnrecognizedPersonalNames(
  runtime: NativeCliSharedStateRuntime,
  personalDir: string,
): Promise<void> {
  const names = await fs.readdir(personalDir).catch(() => [] as string[]);
  for (const name of names) {
    if (isRecognizedPersonalName(runtime, name)) continue;
    const key = `${runtime}:${name}`;
    if (warnedUnrecognizedNames.has(key)) continue;
    warnedUnrecognizedNames.add(key);
    console.warn(
      `[native-cli-shared-state] unrecognized ${runtime} state name "${name}" stays per-account; ` +
        "classify it in the shared/private lists so a newer CLI version's state is not silently isolated",
    );
  }
}

/**
 * Atomically replace the managed entry with a symlink to the personal target.
 * The temp-link + rename dance (instead of unlink-then-symlink) closes the
 * TOCTOU window in which a launching CLI could observe the name missing and
 * recreate a private file. `expected` re-verifies the entry immediately before
 * the rename so content read (and merged) earlier is provably the content
 * being replaced; on POSIX, renaming a symlink over a regular file replaces
 * it atomically. Returns false when the entry changed underneath us — the
 * caller restarts the name.
 */
async function swapWithSymlink(
  managedDir: string,
  managedPath: string,
  personalPath: string,
  expected: { kind: "file"; ino: bigint | number; mtimeMs: number } | { kind: "symlink" },
): Promise<boolean> {
  const temp = join(
    managedDir,
    `.${basename(managedPath)}.codara-link-${randomBytes(6).toString("hex")}`,
  );
  await fs.symlink(personalPath, temp);
  try {
    const now = await lstatOrNull(managedPath);
    if (expected.kind === "file") {
      if (
        !now ||
        !now.isFile() ||
        now.isSymbolicLink() ||
        now.ino !== expected.ino ||
        now.mtimeMs !== expected.mtimeMs
      ) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        return false;
      }
    } else if (!now || !now.isSymbolicLink()) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      return false;
    }
    await fs.rename(temp, managedPath);
    return true;
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** True when the managed entry is already a symlink at the personal target. */
async function isCorrectShareLink(
  managedPath: string,
  personalPath: string,
): Promise<boolean> {
  const raw = await fs.readlink(managedPath).catch(() => null);
  if (raw === null) return false;
  return resolve(dirname(managedPath), raw) === resolve(personalPath);
}

/**
 * Write `content` to `path` via a same-directory temp file + rename so a
 * reader never observes a torn file. Personal targets are user state, so the
 * existing mode is preserved when there is one.
 */
async function writeFileReplacingAtomic(
  path: string,
  content: Buffer,
  fallbackMode: number,
): Promise<void> {
  const mode = await fs
    .stat(path)
    .then((stat) => stat.mode & 0o777)
    .catch(() => fallbackMode);
  const temp = join(
    dirname(path),
    `.${basename(path)}.codara-heal-${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await fs.open(temp, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(mode);
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Create a new sibling file that must not already exist (backups). */
async function writeNewFile(path: string, content: Buffer): Promise<void> {
  const handle = await fs.open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Merge two JSONL logs as a line union: every personal line in its original
 * order, then every managed line not already present (deduped by exact line
 * content). Lossless in both directions and idempotent, which is what makes
 * a failed swap safely retryable without duplicating history.
 */
function unionJsonlLines(
  personalContent: string,
  managedContent: string,
): { merged: string; additions: number } {
  const personalLines = personalContent.length === 0 ? [] : personalContent.split("\n");
  while (personalLines.length > 0 && personalLines[personalLines.length - 1] === "") {
    personalLines.pop();
  }
  const seen = new Set(personalLines);
  const out = [...personalLines];
  let additions = 0;
  for (const line of managedContent.split("\n")) {
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    additions += 1;
  }
  return { merged: out.length === 0 ? "" : `${out.join("\n")}\n`, additions };
}

interface MergeSummary {
  moved: number;
  stashed: string[];
  failed: string[];
}

/** rename with a copy+delete fallback for the cross-device edge case. */
async function moveEntry(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    await fs.rm(source, { recursive: true, force: true });
  }
}

/**
 * Merge a staged (pre-feature) managed directory into the personal target.
 * Entries missing on the personal side move over; real-directory pairs merge
 * recursively (Codex sessions nest by date, so one level is not enough); any
 * true collision keeps the PERSONAL copy and stashes the managed one under
 * the caller-provided stash path, preserving its relative layout — the merge
 * must never guess which copy the user meant to keep. SQLite databases and
 * their journals are quarantined into the stash unconditionally, never moved
 * to the target — even when the target name is free (see
 * isSqliteArtifactName).
 */
async function mergeDirectoryInto(
  sourceDir: string,
  targetDir: string,
  stashDir: string,
  relPath: string,
  summary: MergeSummary,
  depth: number,
): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    try {
      const sourceStats = await fs.lstat(source);
      if (!sourceStats.isDirectory() && isSqliteArtifactName(entry.name)) {
        const stashPath = join(stashDir, entry.name);
        await fs.mkdir(dirname(stashPath), { recursive: true, mode: 0o700 });
        await moveEntry(source, stashPath);
        summary.stashed.push(entryRel);
        continue;
      }
      const targetStats = await lstatOrNull(target);
      if (!targetStats) {
        await moveEntry(source, target);
        summary.moved += 1;
        continue;
      }
      if (
        depth < MERGE_MAX_DEPTH &&
        sourceStats.isDirectory() &&
        !sourceStats.isSymbolicLink() &&
        targetStats.isDirectory() &&
        !targetStats.isSymbolicLink()
      ) {
        await mergeDirectoryInto(
          source,
          target,
          join(stashDir, entry.name),
          entryRel,
          summary,
          depth + 1,
        );
        continue;
      }
      const stashPath = join(stashDir, entry.name);
      await fs.mkdir(dirname(stashPath), { recursive: true, mode: 0o700 });
      await moveEntry(source, stashPath);
      summary.stashed.push(entryRel);
    } catch (error) {
      summary.failed.push(
        `${entryRel}: ${(error as Error).message ?? String(error)}`,
      );
    }
  }
}

/**
 * Migrate a real managed directory (pre-feature account state, e.g. a
 * projects/ full of transcripts) into the shared personal target.
 *
 * Ordering is the point: the directory is first renamed OUT of the namespace
 * (atomic), the symlink is installed immediately, and only then is the staged
 * content merged — so anything that starts writing mid-migration already
 * writes through the link into the shared target instead of into a directory
 * about to disappear. Callers guarantee the profile is unleased.
 */
async function migrateRealDirectory(
  managedDir: string,
  managedPath: string,
  personalPath: string,
  name: string,
): Promise<SharedCliStateEntry> {
  const staged = join(
    managedDir,
    `.${name}.migrating-${randomBytes(6).toString("hex")}`,
  );
  await fs.rename(managedPath, staged);
  await fs.mkdir(personalPath, { recursive: true, mode: 0o700 });
  try {
    await fs.symlink(personalPath, managedPath, "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Something recreated the name in the gap. Keep going: the staged data
    // still merges into the shared target, and the recreated entry is healed
    // on the next resolution.
  }
  const stashRoot = join(managedDir, `.codara-stash-${timestampToken()}`);
  const summary: MergeSummary = { moved: 0, stashed: [], failed: [] };
  await mergeDirectoryInto(
    staged,
    personalPath,
    join(stashRoot, name),
    "",
    summary,
    0,
  );
  if (summary.failed.length === 0) {
    // Only empty scaffolding can remain once every entry moved or stashed.
    await fs.rm(staged, { recursive: true, force: true });
  } else {
    console.warn(
      `[native-cli-shared-state] ${summary.failed.length} entr(ies) of ${name} could not be merged; ` +
        `the remainder was left at ${staged} for manual recovery: ${summary.failed.join("; ")}`,
    );
  }
  if (summary.stashed.length > 0) {
    console.warn(
      `[native-cli-shared-state] kept the personal copy for ${summary.stashed.length} colliding ` +
        `${name} entr(ies); the managed copies were stashed under ${stashRoot}`,
    );
  }
  return {
    name,
    kind: "dir",
    outcome: summary.failed.length === 0 ? "merged-dir" : "error",
    detail:
      `moved ${summary.moved}, stashed ${summary.stashed.length}` +
      (summary.failed.length > 0 ? `, failed ${summary.failed.length}` : ""),
  };
}

/**
 * Finish a migration a previous run started but never completed: a crash
 * inside migrateRealDirectory leaves the not-yet-merged remainder in a
 * `.<name>.migrating-*` stage that nothing else looks at — physically intact
 * but permanently invisible to the CLI. Merging is idempotent and this runs
 * under the same per-profile serialization as the migration itself, so
 * completing the merge here is always safe. Best-effort: recovery must never
 * block the heal of the live entry.
 */
async function recoverStaleMigrationStages(
  managedDir: string,
  personalPath: string,
  name: string,
): Promise<void> {
  const prefix = `.${name}.migrating-`;
  const entries = await fs.readdir(managedDir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      const staged = join(managedDir, entry);
      const stats = await lstatOrNull(staged);
      if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) continue;
      await fs.mkdir(personalPath, { recursive: true, mode: 0o700 });
      const stashRoot = join(managedDir, `.codara-stash-${timestampToken()}`);
      const summary: MergeSummary = { moved: 0, stashed: [], failed: [] };
      await mergeDirectoryInto(
        staged,
        personalPath,
        join(stashRoot, name),
        "",
        summary,
        0,
      );
      if (summary.failed.length === 0) {
        await fs.rm(staged, { recursive: true, force: true });
      }
      if (summary.moved > 0 || summary.stashed.length > 0) {
        console.warn(
          `[native-cli-shared-state] recovered an interrupted ${name} migration: ` +
            `moved ${summary.moved}, stashed ${summary.stashed.length}`,
        );
      }
    } catch (error) {
      console.warn(
        `[native-cli-shared-state] could not recover an interrupted ${name} migration:`,
        (error as Error).message ?? error,
      );
    }
  }
}

async function ensureSharedDirName(
  managedDir: string,
  personalDir: string,
  spec: NativeCliSharedStateName,
): Promise<SharedCliStateEntry> {
  const { name } = spec;
  const managedPath = join(managedDir, name);
  const personalPath = join(personalDir, name);
  await recoverStaleMigrationStages(managedDir, personalPath, name);
  for (let attempt = 0; attempt < SWAP_MAX_ATTEMPTS; attempt += 1) {
    const stats = await lstatOrNull(managedPath);
    if (!stats) {
      if (spec.heal === "link-if-personal" && !(await lstatOrNull(personalPath))) {
        return { name, kind: "dir", outcome: "skipped-missing" };
      }
      // The personal target must exist BEFORE the link: mkdir on a dangling
      // dir symlink path fails EEXIST, which would break the CLI's own
      // mkdir-if-missing bootstrapping.
      await fs.mkdir(personalPath, { recursive: true, mode: 0o700 });
      try {
        await fs.symlink(personalPath, managedPath, "dir");
        return { name, kind: "dir", outcome: "linked" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
    if (stats.isSymbolicLink()) {
      if (await isCorrectShareLink(managedPath, personalPath)) {
        return { name, kind: "dir", outcome: "linked" };
      }
      await fs.mkdir(personalPath, { recursive: true, mode: 0o700 });
      if (
        await swapWithSymlink(managedDir, managedPath, personalPath, {
          kind: "symlink",
        })
      ) {
        return { name, kind: "dir", outcome: "linked", detail: "retargeted" };
      }
      continue;
    }
    if (!stats.isDirectory()) {
      // A regular file where a directory belongs is not a shape this heal
      // understands; leave it alone rather than destroy it.
      return {
        name,
        kind: "dir",
        outcome: "error",
        detail: "unexpected non-directory entry",
      };
    }
    return migrateRealDirectory(managedDir, managedPath, personalPath, name);
  }
  return { name, kind: "dir", outcome: "error", detail: "kept changing underneath the heal" };
}

async function ensureSharedFileName(
  managedDir: string,
  personalDir: string,
  spec: NativeCliSharedStateName,
): Promise<SharedCliStateEntry> {
  const { name } = spec;
  const managedPath = join(managedDir, name);
  const personalPath = join(personalDir, name);
  if (isSqliteArtifactName(name)) {
    // Unreachable with the current lists; guards a future list edit.
    return { name, kind: "file", outcome: "error", detail: "sqlite artifacts are never shared" };
  }
  for (let attempt = 0; attempt < SWAP_MAX_ATTEMPTS; attempt += 1) {
    const stats = await lstatOrNull(managedPath);
    if (!stats) {
      const personalStats = await lstatOrNull(personalPath);
      if (!personalStats) {
        // When the CLI later writes a real managed file, the next resolution
        // heals it into the personal home and relinks.
        return { name, kind: "file", outcome: "skipped-missing" };
      }
      try {
        await fs.symlink(personalPath, managedPath);
        return { name, kind: "file", outcome: "linked" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
    if (stats.isSymbolicLink()) {
      if (await isCorrectShareLink(managedPath, personalPath)) {
        return { name, kind: "file", outcome: "linked" };
      }
      if (
        await swapWithSymlink(managedDir, managedPath, personalPath, {
          kind: "symlink",
        })
      ) {
        return { name, kind: "file", outcome: "linked", detail: "retargeted" };
      }
      continue;
    }
    if (!stats.isFile()) {
      return {
        name,
        kind: "file",
        outcome: "error",
        detail: "unexpected non-file entry",
      };
    }

    // A real managed file: either pre-feature state or a writer's atomic
    // rename clobbered the link. Its content is user state and must reach the
    // personal side before the name becomes a link.
    const managedContent = await fs.readFile(managedPath);
    const expected = { kind: "file" as const, ino: stats.ino, mtimeMs: stats.mtimeMs };

    if (spec.heal === "line-union") {
      const personalStats = await lstatOrNull(personalPath);
      if (personalStats && (personalStats.isSymbolicLink() || !personalStats.isFile())) {
        return {
          name,
          kind: "file",
          outcome: "error",
          detail: "personal target is not a regular file",
        };
      }
      const personalContent = personalStats
        ? await fs.readFile(personalPath, "utf8")
        : "";
      const { merged, additions } = unionJsonlLines(
        personalContent,
        managedContent.toString("utf8"),
      );
      // Skip the write when the union adds nothing: gratuitous rewrites of
      // the personal log would churn its mtime for no content change.
      if (!personalStats || additions > 0) {
        await writeFileReplacingAtomic(personalPath, Buffer.from(merged, "utf8"), 0o600);
      }
      if (await swapWithSymlink(managedDir, managedPath, personalPath, expected)) {
        return {
          name,
          kind: "file",
          outcome: "healed-file",
          detail: `line-union (${additions} added)`,
        };
      }
      continue;
    }

    const personalStats = await lstatOrNull(personalPath);
    if (!personalStats) {
      try {
        await fs.rename(managedPath, personalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await writeFileReplacingAtomic(personalPath, managedContent, stats.mode & 0o777);
        await fs.unlink(managedPath);
      }
      try {
        await fs.symlink(personalPath, managedPath);
        return { name, kind: "file", outcome: "healed-file", detail: "moved to personal" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
    if (personalStats.isSymbolicLink() || !personalStats.isFile()) {
      return {
        name,
        kind: "file",
        outcome: "error",
        detail: "personal target is not a regular file",
      };
    }
    const personalContent = await fs.readFile(personalPath);
    if (managedContent.equals(personalContent)) {
      if (await swapWithSymlink(managedDir, managedPath, personalPath, expected)) {
        return { name, kind: "file", outcome: "healed-file", detail: "identical content" };
      }
      continue;
    }
    // Divergent copies: the newest write wins, and the loser is preserved
    // beside the personal target — healing must never silently discard the
    // only copy of either side's edits. This covers both a writer's
    // rename-over clobber and pre-feature divergence; in the latter case the
    // backup keeps whichever side loses recoverable. The backup lands first
    // so a crash between the two writes cannot lose the losing content.
    const backupPath = `${personalPath}.codara-backup-${timestampToken()}`;
    const managedWins = stats.mtimeMs > personalStats.mtimeMs;
    await writeNewFile(backupPath, managedWins ? personalContent : managedContent);
    if (managedWins) {
      await writeFileReplacingAtomic(personalPath, managedContent, 0o600);
    }
    if (await swapWithSymlink(managedDir, managedPath, personalPath, expected)) {
      return {
        name,
        kind: "file",
        outcome: "healed-file",
        detail: managedWins ? "managed content won" : "personal content won",
      };
    }
    continue;
  }
  return { name, kind: "file", outcome: "error", detail: "kept changing underneath the heal" };
}

/**
 * Idempotent, best-effort establishment of the shared-state links inside one
 * managed account directory. Callers serialize per profile and only invoke
 * this while the profile is unleased (no live CLI owns the directory).
 *
 * Windows is a deliberate no-op: symlink creation needs privileges most users
 * do not have, so managed accounts keep the old fully-isolated behavior there.
 */
export async function ensureSharedCliState(
  input: EnsureSharedCliStateInput,
): Promise<SharedCliStateResult> {
  const { runtime } = input;
  if (process.platform === "win32") {
    return { runtime, skipped: "win32", entries: [] };
  }
  const managedDir = resolve(input.managedDir);
  const personalDir = resolve(input.personalDir);
  // A self-referential or nested pair would create symlink cycles; refuse.
  if (
    managedDir === personalDir ||
    managedDir.startsWith(`${personalDir}/`) ||
    personalDir.startsWith(`${managedDir}/`)
  ) {
    return { runtime, skipped: "unsafe-input", entries: [] };
  }
  const entries: SharedCliStateEntry[] = [];
  for (const spec of sharedStateSpec(runtime)) {
    try {
      entries.push(
        spec.kind === "dir"
          ? await ensureSharedDirName(managedDir, personalDir, spec)
          : await ensureSharedFileName(managedDir, personalDir, spec),
      );
    } catch (error) {
      entries.push({
        name: spec.name,
        kind: spec.kind,
        outcome: "error",
        detail: (error as Error).message ?? String(error),
      });
    }
  }
  try {
    await warnUnrecognizedPersonalNames(runtime, personalDir);
  } catch {
    // Logging is observability, never a failure mode.
  }
  return { runtime, entries };
}
