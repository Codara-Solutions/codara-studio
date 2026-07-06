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

export function claudeProjectsDirForCwd(cwd: string): string {
  return join(homedir(), ".claude", "projects", encodeCwdForClaudeProjects(cwd));
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
): Promise<{ sessionId: string; transcriptPath: string } | null> {
  const dir = claudeProjectsDirForCwd(cwd);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  let bestPath: string | null = null;
  let bestMtime = -1;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const stat = await fs.stat(path);
      if (stat.mtimeMs + 5 < since) continue; // 5ms slack for clock skew
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestPath = path;
      }
    } catch {
      // vanished between readdir and stat — ignore
    }
  }
  if (!bestPath) return null;
  return { sessionId: basename(bestPath, ".jsonl"), transcriptPath: bestPath };
}
