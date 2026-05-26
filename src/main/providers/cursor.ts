// Cursor Agent CLI provider.
//
// Wraps Cursor's `agent` binary (the CLI is published under the name `agent`,
// not `cursor`). Reads:
//   - https://docs.cursor.com/cli
//
// Notes
// -----
// Cursor only exposes one model (`composer-2.5-fast`) for Spark workers and
// no reasoning-effort flag, so `effort` is ignored in `buildArgs`. The
// binary lookup is what makes Cursor interesting: `resolveBinary("agent")`
// already knows about the Cursor-specific install dirs (see binary-resolver
// "common dirs" for cursor-agent on Windows + the agent shim path on
// POSIX), so providers don't need to repeat that logic.
//
// PowerShell dispatch quirk
// -------------------------
// On Windows, typing bare `agent` into pwsh resolves to `agent.ps1`, which
// runs IN THE PARENT pwsh and triggers the user's $PROFILE (Terminal-Icons
// etc.). The `.cmd` shim spawns a fresh -NoProfile child. The provider's
// `buildArgs` returns the clean argv tail (no shell quoting); the spawn
// site (`run-store.buildStandingTerminalCommand`) decides how to invoke
// the binary — typically by passing the absolute path from `resolveBinary`.
//
// Directory trust is handled by run-store writing
// `~/.cursor/projects/<encoded>/.workspace-trusted` before spawn, same
// as the codex equivalent. Not centralized in the provider yet — keeping
// this refactor scope-limited.

import type { AgentEffortLevel, AgentRuntimeCapabilities, AgentRuntimeModel } from "@shared/types";

import { resolveBinary } from "../binary-resolver";

import type { CliProvider, ResumeOpts, SpawnOpts } from "./types";

// Source: Cursor CLI (May 2026). Spark only uses composer-2.5-fast — it is
// peer-quality (≈ opus-4-7-max ≈ gpt-5.5) but materially faster. Older
// Composer revisions are intentionally NOT exposed: there is no reason to
// downgrade the runtime to a slower or weaker model.
const CURSOR_MODELS: AgentRuntimeModel[] = [
  {
    id: "composer-2.5-fast",
    label: "Composer 2.5 Fast",
    effortLevels: ["medium"],
    isDefault: true,
    // Peer-quality vs opus/gpt-5.5 but tuned for wall-clock — best used as
    // the cheap pick for mechanical leaf work on small surfaces.
    tier: "cheap",
  },
];

const CURSOR_CAPABILITIES: AgentRuntimeCapabilities = {
  sessionResume: true,
  costTracking: false,
  contextWindow: false,
  hookStatus: false,
  shiftEnterNewline: false,
  planModeArg: false,
  systemPromptInjection: false,
  defaultContextWindowSize: 200000,
};

const CURSOR_INSTALL_HINT =
  "Install with: curl https://cursor.com/install -fsS | bash  (then run `agent login`)";

const CURSOR_DEFAULT_MODEL_ID = "composer-2.5-fast";

export const cursorProvider: CliProvider = {
  id: "cursor",
  displayName: "Cursor Agent",
  binaryName: "agent",
  // Cursor doesn't expose a writable settings.json equivalent — config
  // lives in the IDE app, not the CLI. Hook ingestion will skip cursor
  // until upstream surfaces a hook surface.
  hookConfigPath: undefined,
  capabilities: CURSOR_CAPABILITIES,
  versionArgs: ["--version"],
  models: CURSOR_MODELS,
  installHint: CURSOR_INSTALL_HINT,

  resolveBinary(): Promise<string | null> {
    return resolveBinary("agent");
  },

  buildArgs(opts: SpawnOpts): string[] {
    const args: string[] = ["--yolo"];
    const modelId = opts.model?.trim() || CURSOR_DEFAULT_MODEL_ID;
    args.push("--model", modelId);
    // Effort is intentionally ignored: Cursor CLI exposes no reasoning-effort
    // flag and rejects `--trust` in interactive mode (it is only valid with
    // `--print`). The model is always `composer-2.5-fast` in practice.
    return args;
  },

  // Cursor's CLI does not expose a stable session-resume flag today. The
  // capability flag `sessionResume: true` reflects that the renderer
  // surfaces history correctly via the transcript file path — not that the
  // CLI itself takes a resume argv. Return null until upstream ships it.
  buildResumeArgs(_opts: ResumeOpts): string[] | null {
    return null;
  },

  env(_opts: SpawnOpts): NodeJS.ProcessEnv {
    return {};
  },

  parseVersion(output: string): string | null {
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  },

  recommendedWorkerCommand(model: AgentRuntimeModel, _effort: AgentEffortLevel): string {
    return `agent --yolo --model ${model.id}`;
  },
};
