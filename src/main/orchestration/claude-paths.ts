// Claude Code on-disk path helpers.
//
// Claude Code stores each session transcript at
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// where the encoding replaces path separators (and the Windows drive-letter
// colon) with '-'. This is a pure string transform of the absolute cwd, not a
// hash. Kept in a tiny dep-free module so the chat backend and the
// session-restore IPC probe share one definition.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isCodaraManagedCliPath } from "./codara-managed-cli-roots";
import {
  CLAUDE_CLI_SHARED_STATE_DIR_SET,
  CLAUDE_CLI_SHARED_STATE_FILE_SET,
} from "./native-cli-shared-state";

/**
 * Mirror Claude Code's project-dir naming: EVERY non-alphanumeric character in
 * the absolute cwd is replaced with `-` (1:1, no collapsing of runs). This
 * covers path separators, the drive-letter colon, AND spaces / dots / parens —
 * e.g. `C:\Users\jorge\Codara Repos\spark-agent-1` →
 * `C--Users-jorge-Codara-Repos-spark-agent-1` (note "Codara Repos" → "Codara-Repos").
 * An earlier version only replaced `[:\\/]`, which left spaces intact and looked
 * in a folder that never existed for any path containing a space.
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The PERSONAL Claude Code config root, mirroring the CLI's own resolution:
 * `CLAUDE_CONFIG_DIR ?? ~/.claude`. Users relocate this (e.g. to keep $HOME
 * tidy), and every reader/writer of Claude's user-scope config has to follow
 * or the app and the CLI silently diverge onto two config trees.
 *
 * A Codara-managed account root inherited from the shell is NOT the personal
 * login, so it is ignored here — same rule as
 * `defaultPersonalClaudeConfigDirEnv` in claude-cli-account-profiles.ts.
 */
export function personalClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured && !isCodaraManagedCliPath(configured)) return resolve(configured);
  return join(homedir(), ".claude");
}

export function claudeConfigDir(stateDir?: string | null): string {
  return stateDir || personalClaudeConfigDir();
}

/**
 * Claude Code's user-scope config FILE. The asymmetry here is deliberate and
 * mirrors the CLI exactly: with CLAUDE_CONFIG_DIR set the file is
 * `<dir>/.claude.json`, but with it UNSET the file is `~/.claude.json` — not
 * `~/.claude/.claude.json`. Deriving it as join(claudeConfigDir(), …) would be
 * wrong in the unset case, which is every default install.
 */
export function claudeUserConfigFile(stateDir?: string | null): string {
  if (stateDir) return join(stateDir, ".claude.json");
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured && !isCodaraManagedCliPath(configured)) {
    return join(resolve(configured), ".claude.json");
  }
  return join(homedir(), ".claude.json");
}

export function claudeProjectsDirForCwd(
  cwd: string,
  stateDir?: string | null,
): string {
  return join(
    claudeConfigDir(stateDir),
    "projects",
    encodeCwdForClaudeProjects(cwd),
  );
}

// Deterministic path to a session's transcript. Because Codara forces the
// session id at launch (`claude --session-id <uuid>`), this path is knowable
// before the process starts and is exactly what a resume probe stats.
export function claudeSessionTranscriptPath(
  cwd: string,
  sessionId: string,
  stateDir?: string | null,
): string {
  return join(
    claudeProjectsDirForCwd(cwd, stateDir),
    `${sessionId}.jsonl`,
  );
}

/**
 * True when a symlink inside a Claude state root is one of Codara's own
 * share links: a Codara-managed account shares an allowlisted set of
 * top-level state names (projects, history.jsonl, …) with the personal
 * ~/.claude via symlinks (see native-cli-shared-state.ts). Only a link
 * sitting DIRECTLY under a managed root at one of those names qualifies —
 * the personal home and every deeper component keep the strict no-symlink
 * rule, so a planted link can still never reroute storage paths.
 */
function isCodaraSharedClaudeStateLink(root: string, path: string): boolean {
  if (dirname(path) !== root) return false;
  const name = basename(path);
  if (
    !CLAUDE_CLI_SHARED_STATE_DIR_SET.has(name) &&
    !CLAUDE_CLI_SHARED_STATE_FILE_SET.has(name)
  ) {
    return false;
  }
  return isCodaraManagedCliPath(root);
}

export async function assertSafeClaudeStoragePath(
  stateDir: string,
  targetPath: string,
  options: {
    includeLeaf?: boolean;
    requireLeaf?: boolean;
    leafType?: "file" | "directory";
  } = {},
): Promise<string> {
  const root = resolve(stateDir);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.startsWith("/") ||
    rel.startsWith("\\")
  ) {
    throw new Error("Claude storage path escapes the selected account.");
  }
  const checkedTarget =
    target === root || options.includeLeaf ? target : dirname(target);
  const checkedRel = relative(root, checkedTarget);
  const pieces = checkedRel ? checkedRel.split(/[\\/]+/).filter(Boolean) : [];
  let cursor = root;
  let sawLeaf = false;
  for (let index = -1; index < pieces.length; index += 1) {
    if (index >= 0) cursor = join(cursor, pieces[index]);
    const isLeaf = options.includeLeaf && cursor === target;
    const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (!stat) {
      if (isLeaf && options.requireLeaf) {
        throw new Error("Claude transcript does not exist.");
      }
      break;
    }
    let effective = stat;
    if (stat.isSymbolicLink()) {
      if (!isCodaraSharedClaudeStateLink(root, cursor)) {
        throw new Error("Claude storage path contains a symbolic-link ancestor.");
      }
      // The share link must resolve to a real node; a dangling link behaves
      // exactly like a missing entry (the next resolution re-heals it).
      const real = await fs
        .stat(cursor)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        });
      if (!real) {
        if (isLeaf && options.requireLeaf) {
          throw new Error("Claude transcript does not exist.");
        }
        break;
      }
      effective = real;
    }
    if (!isLeaf && !effective.isDirectory()) {
      throw new Error("Claude storage ancestor is not a directory.");
    }
    if (isLeaf && options.leafType === "file" && !effective.isFile()) {
      throw new Error("Claude transcript is not a regular file.");
    }
    if (isLeaf && options.leafType === "directory" && !effective.isDirectory()) {
      throw new Error("Claude storage path is not a directory.");
    }
    if (isLeaf) sawLeaf = true;
  }
  if (options.requireLeaf && !sawLeaf) {
    throw new Error("Claude transcript does not exist.");
  }
  return target;
}

export async function resolveSafeClaudeTranscriptPath(
  cwd: string,
  sessionId: string,
  stateDir?: string | null,
  options: { requireExisting?: boolean } = {},
): Promise<string> {
  const root = claudeConfigDir(stateDir);
  const path = claudeSessionTranscriptPath(cwd, sessionId, stateDir);
  return assertSafeClaudeStoragePath(root, path, {
    includeLeaf: true,
    requireLeaf: options.requireExisting,
    leafType: "file",
  });
}

/**
 * Find the newest Claude session transcript for `cwd` whose mtime is at or
 * after `since`, returning its session id (the filename minus `.jsonl`) and
 * path. Used to capture the id of a `claude` session a manual terminal pane
 * just launched — Claude buckets transcripts per-cwd, so the newest file in
 * this cwd's project dir is the session that was just started.
 */
export async function discoverClaudeSessionForCwd(
  cwd: string,
  since: number,
  // Lowercased session ids that can NOT be this pane's session (already bound to
  // other panes). Without this, two `claude`s launched in the same cwd within
  // the discovery window both bind to the newest transcript — one pane steals
  // the other's session and its own conversation is lost to restore.
  excludeSessionIds?: ReadonlySet<string>,
  stateDir?: string | null,
): Promise<{ sessionId: string; transcriptPath: string } | null> {
  const dir = claudeProjectsDirForCwd(cwd, stateDir);
  await assertSafeClaudeStoragePath(claudeConfigDir(stateDir), dir, {
    includeLeaf: true,
    leafType: "directory",
  });
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  let bestPath: string | null = null;
  let bestCreated = -1;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    if (excludeSessionIds?.has(basename(name, ".jsonl").toLowerCase())) continue;
    const path = join(dir, name);
    try {
      await assertSafeClaudeStoragePath(claudeConfigDir(stateDir), path, {
        includeLeaf: true,
        requireLeaf: true,
        leafType: "file",
      });
      const stat = await fs.lstat(path);
      // Prefer CREATION time over modification time: a just-launched session's
      // file is born ~now, whereas a long-running Claude in another pane keeps
      // bumping its mtime. Picking newest-by-mtime therefore mis-binds a fresh
      // pane to a concurrent session; newest-by-birthtime picks the one that
      // actually just started. Fall back to mtime when the platform reports no
      // usable birthtime.
      const created =
        stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      if (created + 5 < since) continue; // 5ms slack for clock skew
      if (created > bestCreated) {
        bestCreated = created;
        bestPath = path;
      }
    } catch {
      // vanished between readdir and stat — ignore
    }
  }
  if (!bestPath) return null;
  return { sessionId: basename(bestPath, ".jsonl"), transcriptPath: bestPath };
}

/**
 * Read the tail of a transcript and report whether its final newline-terminated
 * record is a complete JSON line. An abrupt kill (sleep/crash mid-write) leaves
 * the head intact — so the head-only resumability scan passes — but truncates
 * the LAST line, which `claude --resume` can then refuse. `repairable:true`
 * means "resumable in principle, but the tail needs truncating first".
 *
 * Returns `{ repairable: false }` when the tail is clean (or the file can't be
 * read / is empty), so a healthy transcript is never touched.
 */
export async function inspectClaudeTranscriptTail(
  path: string,
): Promise<{ repairable: boolean }> {
  try {
    const stat = await fs.stat(path);
    if (!stat.size) return { repairable: false };
    const handle = await fs.open(path, "r");
    try {
      const window = 65_536;
      const readLen = Math.min(window, stat.size);
      const buf = Buffer.alloc(readLen);
      await handle.read(buf, 0, readLen, stat.size - readLen);
      const text = buf.toString("utf8");
      // The last record is everything after the final newline. A well-formed
      // transcript ends with `}\n`, so a non-empty trailing fragment means the
      // writer was cut mid-line. Verify the fragment is valid JSON; if it parses
      // it's a complete-but-unterminated last line (harmless), otherwise repair.
      const lastNl = text.lastIndexOf("\n");
      const trailing = (lastNl === -1 ? text : text.slice(lastNl + 1)).trim();
      if (!trailing) return { repairable: false };
      try {
        JSON.parse(trailing);
        return { repairable: false };
      } catch {
        return { repairable: true };
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    // Unreadable → don't claim repairable; the resume attempt will surface any
    // real problem and self-heal.
    return { repairable: false };
  }
}

/**
 * Truncate a transcript's trailing partial JSON line so `claude --resume`
 * accepts it. Keeps a `<path>.bak` copy first (best-effort), then rewrites the
 * file up to and including the last newline that precedes a fully-parseable
 * record. A no-op when the tail already parses. Claude only — Codex rollout
 * formats are not safely truncatable this way.
 *
 * Returns true when a repair was written.
 */
export async function repairClaudeTranscriptTail(path: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(path, "utf8");
  } catch {
    return false;
  }
  if (!content) return false;
  // Split into lines, dropping a single trailing empty element from the final
  // newline. Walk backwards to the last line that parses as JSON; everything
  // after it (the truncated write) is discarded.
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop(); // remove the empty element after the last \n
  let lastGood = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      JSON.parse(line);
      lastGood = i;
      break;
    } catch {
      /* keep walking up past truncated / partial lines */
    }
  }
  if (lastGood === -1) return false; // nothing parseable — leave it for self-heal
  // The last non-empty line already parses → nothing was truncated. A missing
  // trailing newline is not corruption (`claude --resume` tolerates it), so
  // don't rewrite just to normalize it.
  if (lastGood === lines.length - 1) return false;
  const repaired = lines.slice(0, lastGood + 1).join("\n") + "\n";
  if (repaired === content) return false;
  try {
    await fs.copyFile(path, `${path}.bak`).catch(() => undefined);
    await fs.writeFile(path, repaired, "utf8");
    return true;
  } catch {
    return false;
  }
}
