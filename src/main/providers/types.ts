// CLI provider abstraction.
//
// One TypeScript interface per coding CLI that Codara can spawn (Claude Code
// and Codex CLI today; Aider, Amp, OpenCode, Grok CLI, Droid,
// Hermes, Pi, Kimi, Kiro, Antigravity, Cline tomorrow). The contract bundles
// everything callers need to launch the binary without baking CLI-specific
// branches into run-store / agent-runtimes / etc:
//
//   - where the binary lives on this machine
//   - what arguments to construct for a new session vs a resumed session
//   - what env vars to layer on top of the inherited process env
//   - where the hook config file lives (for free observability via fs.watch)
//   - what feature flags the runtime supports (capability gating)
//   - how to ask the binary for its version + parse the result
//
// Adding a new CLI later is one new file in this directory plus one line in
// providers/index.ts. The detectAgentRuntimes() detection loop and the
// run-store standing-terminal builder both iterate the provider list — no
// per-CLI conditionals needed.

import type {
  AgentEffortLevel,
  AgentRuntimeCapabilities,
  AgentRuntimeKind,
  AgentRuntimeModel,
} from "@shared/types";

/**
 * Options every provider knows about when shaping a spawn. Fields are
 * optional so callers can pass only what they have — providers ignore
 * fields they don't understand (for example, Codex ignores `--planMode`).
 */
export interface SpawnOpts {
  /** Workspace directory. Providers don't `cd` themselves; the spawn site does. */
  cwd: string;
  /**
   * Model id from the provider's model list (see provider.models). Optional —
   * when omitted, the CLI picks its own default and no model flag is added.
   */
  model?: string;
  /**
   * Reasoning-effort level. Translated per-provider: Claude takes
   * `--effort <low|medium|high|xhigh|max>`, Codex takes
   * `-c "model_reasoning_effort=<low|medium|high|xhigh|max>"`.
   */
  effort?: AgentEffortLevel;
  /**
   * Initial user prompt the CLI should run in headless / one-shot mode, if
   * the provider supports it. Today none of the spawn sites use this — kept
   * on the interface so future callers (eval harness, headless verifier
   * spawning, etc.) have a single place to plumb it through.
   */
  prompt?: string;
}

/**
 * Options for resuming an existing CLI-side session. `sessionId` is the
 * provider-specific identifier the CLI hands out — Claude prints a uuid on
 * first launch (`claude -r <uuid>`), while Codex stores transcripts under
 * `~/.codex/sessions/`. Providers that don't support resume return `null`.
 */
export interface ResumeOpts extends SpawnOpts {
  sessionId: string;
}

/**
 * Contract every coding CLI must implement. Implementations live in
 * `src/main/providers/<id>.ts` and are aggregated by `providers/index.ts`.
 */
export interface CliProvider {
  /** Stable identifier matching `AgentRuntimeKind` ("claude" | "codex" | ...). */
  id: AgentRuntimeKind;
  /** Human-readable label shown in UI ("Claude Code"). */
  displayName: string;
  /** Name passed to `resolveBinary()` (typically the CLI's command name). */
  binaryName: string;
  /**
   * Resolve the absolute path to the binary on this machine, or null if
   * the CLI isn't installed in any location the resolver probes. Wraps
   * `resolveBinary(binaryName)` so callers don't have to pass the name
   * twice.
   */
  resolveBinary(): Promise<string | null>;
  /**
   * Build the CLI argv for a brand-new session. Returns the argv tail to
   * pass after the resolved binary path — e.g. for Claude:
   *   ["--dangerously-skip-permissions", "--model", "claude-opus-5", "--effort", "high"]
   * The caller is responsible for choosing how to dispatch the binary
   * (direct spawn, pwsh, etc.).
   */
  buildArgs(opts: SpawnOpts): string[];
  /**
   * Build the CLI argv for resuming an existing session, or `null` if the
   * provider doesn't expose a session-resume operation.
   */
  buildResumeArgs(opts: ResumeOpts): string[] | null;
  /**
   * Extra env vars to layer on top of the inherited process env when
   * spawning. Empty object today — kept on the interface so future CLIs
   * with required env (API keys outside login, debug flags, etc.) have a
   * single integration point.
   */
  env(opts: SpawnOpts): NodeJS.ProcessEnv;
  /**
   * Absolute path to the CLI's own settings / hook config file (e.g.
   * `~/.claude/settings.json` for Claude). Used by the future hook
   * ingestion pipeline (research §50). Undefined when the CLI doesn't
   * expose a writable config file or Codara doesn't need to read one.
   */
  hookConfigPath?: string;
  /** Feature flags surfaced via the renderer's `<Capability />` wrapper. */
  capabilities: AgentRuntimeCapabilities;
  /** argv to print the CLI's version (almost always `["--version"]`). */
  versionArgs: string[];
  /**
   * Parse the raw stdout/stderr produced by `binary versionArgs...` into a
   * displayable version string. Most CLIs print exactly one line; this
   * method exists so a future CLI with a noisier banner has a place to
   * extract the version without touching detectAgentRuntimes.
   */
  parseVersion(output: string): string | null;
  /** Model catalog (id, label, allowed effort levels). */
  models: AgentRuntimeModel[];
  /** Hint shown to users when the binary isn't installed. */
  installHint: string;
  /**
   * Returns the recommended single-line shell command for a worker pane
   * using the provider's default model + effort. Surfaced in
   * detectAgentRuntimes diagnostics — the user pastes it into a terminal
   * to TEST the install before relying on Codara to spawn it.
   */
  recommendedWorkerCommand(model: AgentRuntimeModel, effort: AgentEffortLevel): string;
}
