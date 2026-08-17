// Agent config shield — stop Cora-spawned CLI sessions (workers AND the manager
// chat backends) from inheriting the user's PERSONAL agent configuration.
//
// THE LEAK
// Claude Code walks ancestor directories from cwd up to the filesystem root and
// picks up `~/.claude/CLAUDE.md` and `~/.claude/agents/*` for ANY project that
// lives under the user's home directory. Cora's workspaces do, so every
// Cora-spawned `claude` session silently absorbs the user's private global
// instructions (subagent routing policy, custom agent names like
// advisor/adversary/fable-coder, hooks, skills, …). Those instructions are
// meant for the user's own interactive sessions, not for the fleet Cora drives,
// and they actively break worker behaviour (workers try to spawn personally
// named subagents that don't exist in their context).
//
// WHY sandbox-exec AND NOT the "obvious" knobs (empirically tested, claude CLI
// 2.1.201, macOS, on 2026-07-05):
//   * CLAUDE_CONFIG_DIR / HOME overrides do NOT stop the ancestor walk — the
//     binary resolves the real home via passwd(3), not $HOME (upstream issues
//     #55456 / #47056). The personal CLAUDE.md + agents still leak.
//   * `--bare` removes the config but breaks Keychain auth ("Not logged in").
//   * `--safe-mode` keeps auth and drops personal config, but ALSO disables
//     every MCP server — even with an explicit `--mcp-config
//     --strict-mcp-config`. Workers need the codara-studio MCP, so this is
//     unacceptable.
//   * VALIDATED recipe: run the CLI under `sandbox-exec` with a surgical
//     read-denial over just the personal-config paths. Personal CLAUDE.md +
//     custom agents disappear, Keychain auth works, project trust/onboarding is
//     untouched, MCP from the global ~/.claude.json still loads, and runs
//     complete normally with cwd inside the repo.
//
// SCOPE / SAFETY
//   * darwin-only. sandbox-exec is a macOS facility; on every other platform
//     the shield is inert and callers fall back to a prompt-level note (see
//     worker-prompt.ts) telling the agent to ignore personal user-level policy.
//   * We deny reads of ONLY the personal-config surface. We deliberately do NOT
//     deny `~/.claude.json` (login / trust / MCP registry — must stay
//     readable), nor `~/.claude/projects` or the `~/.claude` dir as a whole
//     (transcript read/write + `-r` resume live there).
//   * Escape hatch: set SPARK_NO_CONFIG_SHIELD=1 to disable entirely.
//
// Workers are launched by typing a command string into a shell, so callers
// take `buildClaudeShieldPrefix()` / `buildCodexShieldPrefix()` and splice
// the `sandbox-exec -p '…' ` prefix in front of the `claude`/`codex` word.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Seatbelt does NOT nest: a process already under sandbox-exec cannot apply
// another profile. Callers must never wrap a CLI that applies Seatbelt itself —
// codex with `-s read-only` / `--sandbox workspace-write` is the known case
// (every command dies with "sandbox_apply: Operation not permitted"). Claude
// workers run --dangerously-skip-permissions, so Claude Code's own bash
// sandbox is off and the claude wrap is safe; if that ever changes, the same
// nesting failure would appear there.
const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

// Feature-detect sandbox-exec once. The binary either exists for the whole
// process lifetime or it doesn't, so caching a boolean is safe.
let sandboxExecAvailable: boolean | null = null;
function hasSandboxExec(): boolean {
  if (sandboxExecAvailable === null) {
    sandboxExecAvailable = existsSync(SANDBOX_EXEC_PATH);
  }
  return sandboxExecAvailable;
}

/**
 * True when Cora-spawned CLI sessions are (or will be) wrapped in the
 * sandbox-exec config shield: macOS, sandbox-exec present, and the escape hatch
 * (SPARK_NO_CONFIG_SHIELD=1) not set. When false, callers must fall back to a
 * prompt-level note so the leaked personal policy is at least neutralized in
 * text.
 */
export function isConfigShieldActive(): boolean {
  if (process.platform !== "darwin") return false;
  if (process.env.SPARK_NO_CONFIG_SHIELD === "1") return false;
  return hasSandboxExec();
}

// Escape a filesystem path for embedding inside a double-quoted string in a
// sandbox profile (Scheme-like syntax). Backslash and double-quote are the only
// characters that need escaping there. Home dirs almost never contain either,
// but a user could have one, so we handle it rather than emit a malformed
// profile.
function escapeForProfileString(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Build a `(deny file-read* …)` sandbox profile from a set of subpath (whole
// subtree) and literal (single file) targets. Anything not denied stays
// readable because the profile opens with `(allow default)`.
function buildDenyReadProfile(subpaths: string[], literals: string[]): string {
  const clauses: string[] = [];
  for (const p of subpaths) clauses.push(`(subpath "${escapeForProfileString(p)}")`);
  for (const p of literals) clauses.push(`(literal "${escapeForProfileString(p)}")`);
  return `(version 1)(allow default)(deny file-read* ${clauses.join(" ")})`;
}

// The personal Claude config surface. Subtrees (agents, hooks, skills, …) are
// denied wholesale; CLAUDE.md is denied as a literal so the rest of ~/.claude
// (projects/, transcripts, ~/.claude.json) stays readable.
//
// settings.json / settings.local.json are DELIBERATELY readable (verified live
// on 2026-07-05, claude 2.1.201): an EPERM stat on either makes the
// interactive TUI re-show the Bypass Permissions consent, and with an explicit
// --settings flag it escalates to a blocking "Settings file could not be
// read" dialog — either way a headless pty session hangs and the manager
// exits code=1. The user's settings.json is also where Cora's OWN
// codara-hook.py hooks are installed (worker state chips depend on them), so
// hiding it would break the app's telemetry too. The policy/agents leak the
// shield exists for lives in CLAUDE.md + agents/, which stay denied.
function claudeProfile(): string {
  const home = homedir();
  const dot = join(home, ".claude");
  const subpaths = [
    join(dot, "agents"),
    join(dot, "hooks"),
    join(dot, "skills"),
    join(dot, "commands"),
    join(dot, "plugins"),
    join(dot, "rules"),
  ];
  const literals = [join(dot, "CLAUDE.md")];
  return buildDenyReadProfile(subpaths, literals);
}

// Codex reads personal global instructions from ~/.codex/AGENTS.md. Deny only
// that literal — ~/.codex/config.toml (trust) and ~/.codex/auth.json (login)
// MUST stay readable. Harmless if the user has no AGENTS.md.
function codexProfile(): string {
  const home = homedir();
  return buildDenyReadProfile([], [join(home, ".codex", "AGENTS.md")]);
}

// Wrap a profile string in single quotes for embedding in a shell command line
// (the worker launch path types a command string into zsh/bash/pwsh). The
// profile itself contains double quotes and parens, which single-quoting makes
// literal; a single quote inside the profile (only possible via a quote in the
// home dir path) is escaped the POSIX way: close-quote, escaped quote,
// reopen-quote. pwsh also treats '' inside a single-quoted string as one quote,
// but a home-dir path with a literal quote is vanishingly rare and the POSIX
// form is what our shells (zsh/bash) use.
function singleQuoteForShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Shell-command prefix that runs the following program under the Claude config
 * shield, e.g. `sandbox-exec -p '…' `. Returns null when the shield is inactive
 * (non-darwin, no sandbox-exec, or escape hatch set) — callers then emit the
 * bare command unchanged. Note the trailing space: splice this directly in
 * front of the `claude` word.
 */
export function buildClaudeShieldPrefix(): string | null {
  if (!isConfigShieldActive()) return null;
  return `${SANDBOX_EXEC_PATH} -p ${singleQuoteForShell(claudeProfile())} `;
}

/**
 * Shell-command prefix that runs the following program under the Codex config
 * shield. See buildClaudeShieldPrefix.
 */
export function buildCodexShieldPrefix(): string | null {
  if (!isConfigShieldActive()) return null;
  return `${SANDBOX_EXEC_PATH} -p ${singleQuoteForShell(codexProfile())} `;
}

// One-line startup log so live verification ("is the shield on?") doesn't need
// re-instrumentation. Logged once at first use via logConfigShieldOnce.
export function describeShieldForLogs(): string {
  if (process.platform !== "darwin") {
    return "config shield INACTIVE (non-darwin platform; WORKER prompts get a fallback note; the manager runs unshielded)";
  }
  if (process.env.SPARK_NO_CONFIG_SHIELD === "1") {
    return "config shield INACTIVE (SPARK_NO_CONFIG_SHIELD=1 escape hatch set)";
  }
  if (!hasSandboxExec()) {
    return `config shield INACTIVE (${SANDBOX_EXEC_PATH} not found)`;
  }
  return `config shield ACTIVE (sandbox-exec denies reads of personal ~/.claude config surface + ~/.codex/AGENTS.md for Cora-spawned claude/codex sessions)`;
}

let shieldLogged = false;
export function logConfigShieldOnce(): void {
  if (shieldLogged) return;
  shieldLogged = true;
  console.log(`[agent-config-shield] ${describeShieldForLogs()}`);
}
