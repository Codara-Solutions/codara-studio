import type { ClaudeCliExecutionProfile } from "./claude-cli-profile-execution";
import type { CodexCliExecutionProfile } from "./codex-cli-profile-execution";
import { resolveNewNativeClaudeProfile } from "./native-claude-profile-runtime";
import { resolveNewNativeCodexProfile } from "./native-codex-profile-runtime";

/**
 * The Active native CLI accounts, projected onto plain Studio shells.
 *
 * Studio's own agent panes launch `claude` / `codex` as a startup command and
 * resolve their account at spawn (pty-manager.ts). A plain terminal tab has no
 * startup command, so a hand-typed `claude` used to inherit Studio's own
 * environment and silently open the personal login regardless of which
 * account Settings marked Active. With managed accounts now sharing every
 * user-state surface with the personal home (native-cli-shared-state.ts),
 * pointing a plain shell at the Active account is pure gain: same chats,
 * settings, and /resume — only the sign-in follows the switch.
 *
 * Two invariants:
 *
 *  - A PERSONAL default contributes nothing. The shell keeps its inherited
 *    environment byte-for-byte, exactly the pre-feature behavior — an unset
 *    CLAUDE_CONFIG_DIR is not equivalent to an exported one, and a personal
 *    shell must also keep credential-override variables the profile builders
 *    would strip.
 *  - Resolution is best-effort and independent per CLI. A shell must always
 *    open: one unreadable account store costs that CLI's selector, never the
 *    spawn and never the other CLI's selector.
 *
 * Resolving through the runtime stores also runs the shared-state heal for
 * the selected managed directories, so the first shell after a switch already
 * sees the migrated/linked state.
 */
export interface PlainShellAccountSelectors {
  /** Managed CODEX_HOME for the Active Codex account; absent when personal. */
  codexHome?: string;
  /** Managed CLAUDE_CONFIG_DIR for the Active Claude account; absent when personal. */
  claudeConfigDir?: string;
}

export interface PlainShellAccountSelectorDeps {
  resolveClaude?: () => Promise<ClaudeCliExecutionProfile>;
  resolveCodex?: () => Promise<CodexCliExecutionProfile>;
}

export async function resolvePlainShellAccountSelectors(
  deps: PlainShellAccountSelectorDeps = {},
): Promise<PlainShellAccountSelectors | null> {
  const resolveClaude = deps.resolveClaude ?? (() => resolveNewNativeClaudeProfile());
  const resolveCodex = deps.resolveCodex ?? (() => resolveNewNativeCodexProfile());

  const [claude, codex] = await Promise.all([
    resolveClaude().catch(() => null),
    resolveCodex().catch(() => null),
  ]);

  const selectors: PlainShellAccountSelectors = {};
  // A managed profile always carries its selector in the built environment;
  // a missing one means the resolution was not usable, so the shell is left
  // alone rather than pointed at an empty selection.
  const claudeConfigDir = claude?.managed ? claude.env.CLAUDE_CONFIG_DIR : undefined;
  if (claudeConfigDir) selectors.claudeConfigDir = claudeConfigDir;
  const codexHome = codex?.managed ? codex.env.CODEX_HOME : undefined;
  if (codexHome) selectors.codexHome = codexHome;

  return selectors.claudeConfigDir || selectors.codexHome ? selectors : null;
}
