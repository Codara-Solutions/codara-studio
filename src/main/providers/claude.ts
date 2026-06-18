// Claude Code CLI provider.
//
// Wraps Anthropic's `claude` binary. Reads:
//   - https://docs.anthropic.com/en/docs/claude-code/cli-usage
//   - https://docs.anthropic.com/en/docs/claude-code/hooks (for hookConfigPath)
//
// Notes
// -----
// Spark always launches Claude with `--dangerously-skip-permissions` because
// it owns the pty and there is no human present to click "approve". `--model`
// and `--effort` are appended only when callers pass them; the CLI falls back
// to its own defaults otherwise.
//
// `--effort` rejects "minimal" (Codex's lowest tier) — see mapClaudeEffort
// in run-store for the historical mapping. Providers don't translate effort
// today: the manager profile is what emits effort hints, and it already
// targets values the CLI accepts. The mapping function stays in run-store
// for now to keep this provider focused on argv construction.

import { join } from "node:path";
import { homedir } from "node:os";

import type { AgentEffortLevel, AgentRuntimeCapabilities, AgentRuntimeModel } from "@shared/types";

import { resolveBinary } from "../binary-resolver";

import type { CliProvider, ResumeOpts, SpawnOpts } from "./types";

// Claude --effort accepts low/medium/high/xhigh/max — NOT minimal. Fable 5,
// Opus 4.8, and Sonnet 4.6 share the same 5-tier ladder; tier sizing affects
// throughput/latency, not the available knobs.
//
// Fable 5 is Anthropic's top-tier model (above Opus 4.8). It is allowed as a
// main chat-session model and as an opt-in automation (loom) worker model — the
// automation engine validates pinned/handoff models against THIS list, so its
// presence here is what unblocks `worker.model = "claude-fable-5"`. Opus 4.8
// stays the default (isDefault) so nothing silently upgrades to fable. Workers
// that Spark itself spawns (execute-mode spark_spawn_workers, plan-council,
// autopilot) must NEVER run fable — that block lives at the spawn chokepoints
// (agent-socket handleOrchestratorSpawnWorkers) plus a buildLaunchCommandLine
// backstop, not here; see sanitizeWorkerModelHint in run-store.ts.
const CLAUDE_MODELS: AgentRuntimeModel[] = [
  {
    id: "claude-fable-5",
    label: "Fable 5",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    tier: "top",
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    isDefault: true,
    tier: "top",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    tier: "mid",
  },
];

const CLAUDE_CAPABILITIES: AgentRuntimeCapabilities = {
  sessionResume: true,
  costTracking: true,
  contextWindow: true,
  hookStatus: true,
  shiftEnterNewline: true,
  planModeArg: true,
  systemPromptInjection: true,
  defaultContextWindowSize: 200000,
};

const CLAUDE_INSTALL_HINT =
  "Install with: npm i -g @anthropic-ai/claude-code  (then run `claude` once to log in)";

export const claudeProvider: CliProvider = {
  id: "claude",
  displayName: "Claude Code",
  binaryName: "claude",
  hookConfigPath: join(homedir(), ".claude", "settings.json"),
  capabilities: CLAUDE_CAPABILITIES,
  versionArgs: ["--version"],
  models: CLAUDE_MODELS,
  installHint: CLAUDE_INSTALL_HINT,

  resolveBinary(): Promise<string | null> {
    return resolveBinary("claude");
  },

  buildArgs(opts: SpawnOpts): string[] {
    const args: string[] = ["--dangerously-skip-permissions"];
    const model = opts.model?.trim();
    if (model) {
      args.push("--model", model);
    }
    if (opts.effort) {
      args.push("--effort", opts.effort);
    }
    return args;
  },

  // Claude exposes session resume via `claude -r <uuid>`. The uuid is the
  // session id printed on first launch. Models / effort flags layer on top
  // exactly like a fresh session.
  buildResumeArgs(opts: ResumeOpts): string[] {
    const args: string[] = ["-r", opts.sessionId, "--dangerously-skip-permissions"];
    const model = opts.model?.trim();
    if (model) {
      args.push("--model", model);
    }
    if (opts.effort) {
      args.push("--effort", opts.effort);
    }
    return args;
  },

  env(_opts: SpawnOpts): NodeJS.ProcessEnv {
    // No required env beyond what's already inherited — Claude reads its
    // auth token from `~/.claude/credentials` which the CLI manages itself.
    return {};
  },

  parseVersion(output: string): string | null {
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  },

  recommendedWorkerCommand(model: AgentRuntimeModel, effort: AgentEffortLevel): string {
    return `claude --dangerously-skip-permissions --model ${model.id} --effort ${effort}`;
  },
};
