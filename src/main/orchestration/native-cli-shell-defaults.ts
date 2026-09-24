import type { GrokCliExecutionProfile } from "./grok-cli-profile-execution";
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
    SPARK_PERSONAL_GROK_HOME: personal("GROK_HOME"),
  };
}

/**
 * The Active native CLI accounts, projected onto plain Studio shells.
 *
 * Only Grok selects a managed account with a home variable: a managed Grok
 * account is a GROK_HOME of its own under grok-cli/accounts, and the
 * personal account is the CLI's default home. A plain terminal tab has no
 * startup command, so that selector is added when Settings marks a managed
 * account Active. Claude and Codex are intentionally absent: each has one
 * home, and a switch moves only the login inside it, so a shell needs
 * nothing to follow them and `claude` or `codex` typed anywhere, in Studio
 * or another terminal app, runs as the Active account.
 *
 * Two invariants:
 *
 *  - A PERSONAL default contributes nothing. The shell keeps its inherited
 *    environment byte-for-byte, exactly the pre-feature behavior.
 *  - Resolution is best-effort. A shell must always open: an unreadable
 *    account store costs the selector, never the spawn.
 *
 * Later switches reach a running shell through the active account pointer
 * (active-cli-env-pointer.ts) and the bundled prompt hooks. That path only
 * exports or unsets the selector variable; it cannot strip the
 * credential-override variables the spawn-time builders strip here, so a
 * shell that started personal and follows to a managed account keeps the
 * overrides it inherited. Documented, not fixed: the hook must never touch a
 * variable it did not set.
 */
export interface PlainShellAccountSelectors {
  /** Managed GROK_HOME for the Active Grok Build account; absent when personal. */
  grokHome?: string;
}

export interface PlainShellAccountSelectorDeps {
  resolveGrok?: () => Promise<GrokCliExecutionProfile>;
}

export async function resolvePlainShellAccountSelectors(
  deps: PlainShellAccountSelectorDeps = {},
): Promise<PlainShellAccountSelectors | null> {
  const resolveGrok = deps.resolveGrok ?? (() => resolveNewNativeGrokProfile());
  const grok = await resolveGrok().catch(() => null);
  // A managed profile always carries its selector in the built environment;
  // a missing one means the resolution was not usable, so the shell is left
  // alone rather than pointed at an empty selection.
  const grokHome = grok?.managed ? grok.env.GROK_HOME : undefined;
  return grokHome ? { grokHome } : null;
}
