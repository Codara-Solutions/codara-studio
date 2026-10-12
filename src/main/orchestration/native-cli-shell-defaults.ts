import type { ClaudeCliExecutionProfile } from "./claude-cli-profile-execution";
import type { CodexCliExecutionProfile } from "./codex-cli-profile-execution";
import type { GrokCliExecutionProfile } from "./grok-cli-profile-execution";
import { resolveNewNativeClaudeProfile } from "./native-claude-profile-runtime";
import { resolveNewNativeCodexProfile } from "./native-codex-profile-runtime";
import { resolveNewNativeGrokProfile } from "./native-grok-profile-runtime";
import { resolve } from "node:path";
import { isCodaraManagedCliPath } from "./codara-managed-cli-roots";

/** Preserve personal selectors before a managed profile replaces the child env. */
export function personalCliShellHomeEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const personal = (key: string): string => {
    const value = baseEnv[key]?.trim();
    return value && !isCodaraManagedCliPath(value) ? resolve(value) : "";
  };
  return {
    SPARK_PERSONAL_CLAUDE_CONFIG_DIR: personal("CLAUDE_CONFIG_DIR"),
    SPARK_PERSONAL_CODEX_HOME: personal("CODEX_HOME"),
    SPARK_PERSONAL_GROK_HOME: personal("GROK_HOME"),
  };
}

/**
 * The Active native CLI accounts, projected onto plain Studio shells.
 *
 * A managed account is a home under Codara's: Claude's live slot (one
 * CLAUDE_CONFIG_DIR for every managed Claude account), a CODEX_HOME or a
 * GROK_HOME of its own. A plain terminal tab has no startup command, so the
 * Active account's variable is added at spawn, and `claude`, `codex` or
 * `grok` typed there runs as that account.
 *
 * Two invariants:
 *
 *  - The System login contributes nothing. The shell keeps its inherited
 *    environment byte-for-byte, so the CLI uses its own home exactly as in
 *    any other terminal app.
 *  - Resolution is best-effort. A shell must always open: an unreadable
 *    account store costs the selector, never the spawn.
 *
 * Later switches reach a running shell through the active account pointer
 * (active-cli-env-pointer.ts) and the bundled prompt hooks. That path only
 * exports or unsets the selector variables; it cannot strip the
 * credential-override variables the spawn-time builders strip here, so a
 * shell that started on the System login and follows to a managed account
 * keeps the overrides it inherited. Documented, not fixed: the hook must
 * never touch a variable it did not set.
 */
export interface PlainShellAccountSelectors {
  /** The Claude live slot while a managed Claude account is Active. */
  claudeConfigDir?: string;
  /** The Active Codex account's managed CODEX_HOME. */
  codexHome?: string;
  /** The Active Grok Build account's managed GROK_HOME. */
  grokHome?: string;
}

export interface PlainShellAccountSelectorDeps {
  resolveClaude?: () => Promise<ClaudeCliExecutionProfile>;
  resolveCodex?: () => Promise<CodexCliExecutionProfile>;
  resolveGrok?: () => Promise<GrokCliExecutionProfile>;
}

export async function resolvePlainShellAccountSelectors(
  deps: PlainShellAccountSelectorDeps = {},
): Promise<PlainShellAccountSelectors | null> {
  const [claude, codex, grok] = await Promise.all([
    (deps.resolveClaude ?? (() => resolveNewNativeClaudeProfile()))().catch(() => null),
    (deps.resolveCodex ?? (() => resolveNewNativeCodexProfile()))().catch(() => null),
    (deps.resolveGrok ?? (() => resolveNewNativeGrokProfile()))().catch(() => null),
  ]);
  // A managed profile always carries its selector in the built environment;
  // a missing one means the resolution was not usable, so the shell is left
  // alone rather than pointed at an empty selection.
  const selectors: PlainShellAccountSelectors = {};
  if (claude?.managed && claude.env.CLAUDE_CONFIG_DIR) {
    selectors.claudeConfigDir = claude.env.CLAUDE_CONFIG_DIR;
  }
  if (codex?.managed && codex.env.CODEX_HOME) selectors.codexHome = codex.env.CODEX_HOME;
  if (grok?.managed && grok.env.GROK_HOME) selectors.grokHome = grok.env.GROK_HOME;
  return Object.keys(selectors).length > 0 ? selectors : null;
}
