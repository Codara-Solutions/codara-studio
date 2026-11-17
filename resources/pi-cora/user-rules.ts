// The user's own global rules for their coding agents: the file Claude Code
// reads as ~/.claude/CLAUDE.md, or Codex as ~/.codex/AGENTS.md. Studio finds
// it at launch and names it in CODARA_PI_USER_RULES_PATH (pi-runtime-electron);
// Pi's own global context file lives in Codara's isolated agent dir and is
// empty, so without this Cora never saw the rules every other agent follows.
//
// Pure apart from one file read, so scripts/test-pi-cora-skill-commands.cjs
// can load it outside Pi.

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** A larger file is cut, so one stray paste cannot fill the context. */
export const USER_RULES_MAX_CHARS = 40_000;

/** At most this much of the file is read (four UTF-8 bytes per character),
 *  so a link to a huge file never stalls Cora's start. */
export const USER_RULES_MAX_BYTES = USER_RULES_MAX_CHARS * 4;

export function userRulesSection(path: string, content: string, fileWasLonger = false): string {
  const text = content.replace(/^﻿/, "").trim();
  if (!text) return "";
  const cut = fileWasLonger || text.length > USER_RULES_MAX_CHARS;
  return `User's global agent rules (from ${path}). The user wrote these for all
of their coding agents. Follow them where they apply to you; where they name
Claude Code or Codex tools, use your Codara equivalent (codara_ask_user for a
question, codara_spawn_workers for a subagent, codara_session_start for a
visible Claude Code or Codex session). Codara's own safety rules and the
user's words in this chat win over them.

<user-rules>
${cut ? `${text.slice(0, USER_RULES_MAX_CHARS)}\n[cut at ${USER_RULES_MAX_CHARS} characters]` : text}
</user-rules>`;
}

/** The section for the file named in the environment, or "" when none. */
export function loadUserRulesSection(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.CODARA_PI_USER_RULES_PATH?.trim();
  if (!path) return "";
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return "";
    const bytes = Buffer.alloc(Math.min(stat.size, USER_RULES_MAX_BYTES));
    const fd = openSync(path, "r");
    let read = 0;
    try {
      while (read < bytes.length) {
        const got = readSync(fd, bytes, read, bytes.length - read, read);
        if (got === 0) break;
        read += got;
      }
    } finally {
      closeSync(fd);
    }
    return userRulesSection(path, bytes.subarray(0, read).toString("utf8"), stat.size > USER_RULES_MAX_BYTES);
  } catch {
    return "";
  }
}
