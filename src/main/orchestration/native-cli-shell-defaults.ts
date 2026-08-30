import type { ClaudeCliExecutionProfile } from "./claude-cli-profile-execution";
import type { GrokCliExecutionProfile } from "./grok-cli-profile-execution";
import { resolveNewNativeClaudeProfile } from "./native-claude-profile-runtime";
import { resolveNewNativeGrokProfile } from "./native-grok-profile-runtime";

/**
 * The Active native CLI accounts, projected onto plain Studio shells.
 *
 * Claude and Grok select managed accounts with their documented home
 * variables: a managed Claude account is a CLAUDE_CONFIG_DIR, a managed Grok
 * account is a GROK_HOME of its own under grok-cli/accounts, and the personal
 * account of each is the CLI's default home. A plain terminal tab has no
 * startup command, so these two selectors are added when Settings marks a
 * managed account Active. Codex is intentionally absent: it has one state
 * home and its switch moves only auth.json.
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
 * Resolving through the runtime stores also repairs the selected Claude/Grok
 * state before the first shell after a switch opens.
 */
export interface PlainShellAccountSelectors {
  /** Managed CLAUDE_CONFIG_DIR for the Active Claude account; absent when personal. */
  claudeConfigDir?: string;
  /** Managed GROK_HOME for the Active Grok Build account; absent when personal. */
  grokHome?: string;
}

export interface PlainShellAccountSelectorDeps {
  resolveClaude?: () => Promise<ClaudeCliExecutionProfile>;
  resolveGrok?: () => Promise<GrokCliExecutionProfile>;
}

export async function resolvePlainShellAccountSelectors(
  deps: PlainShellAccountSelectorDeps = {},
): Promise<PlainShellAccountSelectors | null> {
  const resolveClaude = deps.resolveClaude ?? (() => resolveNewNativeClaudeProfile());
  const resolveGrok = deps.resolveGrok ?? (() => resolveNewNativeGrokProfile());

  const [claude, grok] = await Promise.all([
    resolveClaude().catch(() => null),
    resolveGrok().catch(() => null),
  ]);

  const selectors: PlainShellAccountSelectors = {};
  // A managed profile always carries its selector in the built environment;
  // a missing one means the resolution was not usable, so the shell is left
  // alone rather than pointed at an empty selection.
  const claudeConfigDir = claude?.managed ? claude.env.CLAUDE_CONFIG_DIR : undefined;
  if (claudeConfigDir) selectors.claudeConfigDir = claudeConfigDir;
  const grokHome = grok?.managed ? grok.env.GROK_HOME : undefined;
  if (grokHome) selectors.grokHome = grokHome;

  return selectors.claudeConfigDir || selectors.grokHome
    ? selectors
    : null;
}
