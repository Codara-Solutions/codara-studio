// The user's global rules for their coding agents, which Cora's manager also
// reads (resources/pi-cora/user-rules.ts). Claude Code's file first, then
// Codex's: users who keep one file for both link one to the other.

import { statSync } from "node:fs";
import { join } from "node:path";
import { personalClaudeConfigDir } from "./claude-paths";
import { defaultPersonalCodexHomeDir } from "./codex-cli-account-profiles";

export function userAgentRulesCandidates(): string[] {
  return [join(personalClaudeConfigDir(), "CLAUDE.md"), join(defaultPersonalCodexHomeDir(), "AGENTS.md")];
}

/** The first candidate that is a file, or null. Only the path leaves here:
 *  the Pi process reads the file itself. */
export function userAgentRulesPath(candidates: readonly string[] = userAgentRulesCandidates()): string | null {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing or unreadable: try the next one.
    }
  }
  return null;
}
