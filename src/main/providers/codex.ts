// Codex CLI provider.
//
// Wraps OpenAI's `codex` binary. Reads:
//   - https://developers.openai.com/codex/cli
//   - https://developers.openai.com/codex/config-reference
//
// Notes
// -----
// Codara launches Codex with `--yolo` so the agent can run tools without
// per-tool approval. `-m <model>` picks the model; effort is configured via
// `-c "model_reasoning_effort=<level>"` rather than a dedicated flag —
// Codex's `-c` switch sets any config-reference key, so it's the same syntax
// the user would put in `~/.codex/config.toml`.
//
// Directory trust is a separate concern Codara handles outside the provider
// by writing a `[projects.'<cwd>']` block into `~/.codex/config.toml` before
// spawning. The provider is the place to centralize that later if we want
// — but today the trust write lives in run-store next to the launch path
// and is intentionally untouched to keep this refactor behaviour-preserving.

import { join } from "node:path";
import { homedir } from "node:os";

import type { AgentEffortLevel, AgentRuntimeCapabilities, AgentRuntimeModel } from "@shared/types";
import { CODEX_MODEL_CATALOG } from "@shared/model-catalog";

import { resolveBinary } from "../binary-resolver";

import type { CliProvider, ResumeOpts, SpawnOpts } from "./types";

// GPT-5.6 offers three concrete Codex variants. The shared catalog is also
// consumed by the chat composer and automation editor so every Cora surface
// exposes the same model/effort choices. `codex doctor` on CLI 0.144.1 accepts
// the full low → max effort range used by these models.
const CODEX_MODELS: AgentRuntimeModel[] = CODEX_MODEL_CATALOG.map((model) => ({
  id: model.id,
  label: model.label,
  effortLevels: [...model.effortLevels],
  isDefault: model.isDefault,
  tier: model.tier,
}));

const CODEX_CAPABILITIES: AgentRuntimeCapabilities = {
  sessionResume: true,
  costTracking: false,
  contextWindow: false,
  hookStatus: true,
  shiftEnterNewline: false,
  planModeArg: false,
  systemPromptInjection: true,
  defaultContextWindowSize: 200000,
};

const CODEX_INSTALL_HINT =
  "Install with: npm i -g @openai/codex  (then run `codex` once to log in)";

export const codexProvider: CliProvider = {
  id: "codex",
  displayName: "Codex CLI",
  binaryName: "codex",
  // `~/.codex/config.toml` is the writable config — Codara's directory-trust
  // write targets it, and future hook ingestion will read it for hook
  // declarations.
  hookConfigPath: join(homedir(), ".codex", "config.toml"),
  capabilities: CODEX_CAPABILITIES,
  versionArgs: ["--version"],
  models: CODEX_MODELS,
  installHint: CODEX_INSTALL_HINT,

  resolveBinary(): Promise<string | null> {
    return resolveBinary("codex");
  },

  buildArgs(opts: SpawnOpts): string[] {
    const args: string[] = ["--yolo"];
    const model = opts.model?.trim();
    if (model) {
      args.push("-m", model);
    }
    if (opts.effort) {
      args.push("-c", `model_reasoning_effort=${opts.effort}`);
    }
    return args;
  },

  // Codex stores transcripts under `~/.codex/sessions/`. The CLI accepts
  // `codex resume <id>` (subcommand, not a flag) — for parity with the
  // other providers we still return an argv tail; the spawn site treats
  // resume args the same as fresh args. When this is invoked, callers
  // should NOT also pass `--yolo` separately; this function returns the
  // complete tail.
  buildResumeArgs(opts: ResumeOpts): string[] {
    const args: string[] = ["resume", opts.sessionId, "--yolo"];
    const model = opts.model?.trim();
    if (model) {
      args.push("-m", model);
    }
    if (opts.effort) {
      args.push("-c", `model_reasoning_effort=${opts.effort}`);
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
    return `codex --yolo -m ${model.id} -c "model_reasoning_effort=${effort}"`;
  },
};
