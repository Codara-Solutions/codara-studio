// Claude Code on-disk path helpers.
//
// Claude Code stores each session transcript at
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// where the encoding replaces path separators (and the Windows drive-letter
// colon) with '-'. This is a pure string transform of the absolute cwd, not a
// hash. Kept in a tiny dep-free module so the chat backend and the worker
// watchdog share one definition.

import { homedir } from "node:os";
import { join } from "node:path";

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
