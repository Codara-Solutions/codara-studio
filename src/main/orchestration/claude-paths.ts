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
import { basename, join } from "node:path";

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

export function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured || join(homedir(), ".claude");
}

export function claudeProjectsDirForCwd(cwd: string): string {
  return join(claudeConfigDir(), "projects", encodeCwdForClaudeProjects(cwd));
}

// Deterministic path to a session's transcript. Because Codara forces the
// session id at launch (`claude --session-id <uuid>`), this path is knowable
// before the process starts and is exactly what a resume probe stats.
export function claudeSessionTranscriptPath(cwd: string, sessionId: string): string {
  return join(claudeProjectsDirForCwd(cwd), `${sessionId}.jsonl`);
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
): Promise<{ sessionId: string; transcriptPath: string } | null> {
  const dir = claudeProjectsDirForCwd(cwd);
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
      const stat = await fs.stat(path);
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
