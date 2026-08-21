// Grok Build CLI provider.
//
// Wraps SpaceXAI's `grok` binary. Reads:
//   - ~/.grok/docs/user-guide/01-getting-started.md
//   - ~/.grok/docs/user-guide/14-headless-mode.md
//   - ~/.grok/docs/user-guide/17-sessions.md
//
// Studio launches Grok with `--yolo` (always-approve) so the agent can run
// tools without a human clicking Allow. `--model` / `--effort` layer on when
// callers pass them. Resume is `grok --resume <id> --yolo`. New sessions can
// take `--session-id <uuid>` so the restore pointer is deterministic.

import { join } from "node:path";
import { homedir } from "node:os";

import type { AgentEffortLevel, AgentRuntimeCapabilities, AgentRuntimeModel } from "@shared/types";

import { resolveBinary } from "../binary-resolver";

import type { CliProvider, ResumeOpts, SpawnOpts } from "./types";

const GROK_MODELS: AgentRuntimeModel[] = [
  {
    id: "grok-4.6",
    label: "Grok 4.6",
    effortLevels: ["low", "medium", "high"],
    isDefault: true,
    tier: "top",
  },
];

const GROK_CAPABILITIES: AgentRuntimeCapabilities = {
  sessionResume: true,
  costTracking: true,
  contextWindow: true,
  hookStatus: true,
  shiftEnterNewline: true,
  planModeArg: true,
  systemPromptInjection: true,
  defaultContextWindowSize: 256000,
};

const GROK_INSTALL_HINT =
  "Install with: curl -fsSL https://x.ai/cli/install.sh | bash  (then run `grok login`)";

export const grokProvider: CliProvider = {
  id: "grok",
  displayName: "Grok Build",
  binaryName: "grok",
  hookConfigPath: join(process.env.GROK_HOME?.trim() || join(homedir(), ".grok"), "config.toml"),
  capabilities: GROK_CAPABILITIES,
  versionArgs: ["--version"],
  models: GROK_MODELS,
  installHint: GROK_INSTALL_HINT,

  resolveBinary(): Promise<string | null> {
    return resolveBinary("grok");
  },

  buildArgs(opts: SpawnOpts): string[] {
    const args: string[] = ["--yolo"];
    const model = opts.model?.trim();
    if (model) {
      args.push("-m", model);
    }
    if (opts.effort) {
      args.push("--effort", opts.effort);
    }
    return args;
  },

  buildResumeArgs(opts: ResumeOpts): string[] {
    const args: string[] = ["--resume", opts.sessionId, "--yolo"];
    const model = opts.model?.trim();
    if (model) {
      args.push("-m", model);
    }
    if (opts.effort) {
      args.push("--effort", opts.effort);
    }
    return args;
  },

  env(_opts: SpawnOpts): NodeJS.ProcessEnv {
    return {};
  },

  parseVersion(output: string): string | null {
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  },

  recommendedWorkerCommand(model: AgentRuntimeModel, effort: AgentEffortLevel): string {
    return `grok --yolo -m ${model.id} --effort ${effort}`;
  },
};
