import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import type {
  AgentEffortLevel,
  AgentRuntimeDiagnostic,
  AgentRuntimeKind,
  AgentRuntimeModel,
} from "@shared/types";

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 4000;

// Neither Claude Code CLI nor Codex CLI exposes a `--list-models` command, so
// we hardcode the capability map here. Update this when new model aliases or
// effort levels ship.
const CLAUDE_MODELS: AgentRuntimeModel[] = [
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    isDefault: true,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    effortLevels: ["low", "medium", "high", "max"],
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    effortLevels: ["low", "medium", "high"],
  },
];

// Source: https://developers.openai.com/codex/models (May 2026).
// Effort levels: https://developers.openai.com/codex/config-reference —
// `model_reasoning_effort` accepts minimal | low | medium | high | xhigh,
// with the docs noting "xhigh is model-dependent". gpt-5.5 is ChatGPT-login
// only; the rest work via API key too. gpt-5.3-codex-spark is a research
// preview gated to ChatGPT Pro.
const CODEX_MODELS: AgentRuntimeModel[] = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
    isDefault: true,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    effortLevels: ["minimal", "low", "medium", "high"],
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3-Codex",
    effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3-Codex-Spark",
    effortLevels: ["minimal", "low", "medium", "high"],
  },
];

interface RuntimeSpec {
  kind: AgentRuntimeKind;
  label: string;
  executable: string;
  versionArgs: string[];
  models: AgentRuntimeModel[];
  installHint: string;
  recommendedWorkerCommand(model: AgentRuntimeModel, effort: AgentEffortLevel): string;
}

const RUNTIMES: RuntimeSpec[] = [
  {
    kind: "claude",
    label: "Claude Code",
    executable: "claude",
    versionArgs: ["--version"],
    models: CLAUDE_MODELS,
    installHint: "Install with: npm i -g @anthropic-ai/claude-code  (then run `claude` once to log in)",
    recommendedWorkerCommand: (model, effort) =>
      `claude --dangerously-skip-permissions --model ${model.id} --effort ${effort}`,
  },
  {
    kind: "codex",
    label: "Codex CLI",
    executable: "codex",
    versionArgs: ["--version"],
    models: CODEX_MODELS,
    installHint: "Install with: npm i -g @openai/codex-cli  (then run `codex` once to log in)",
    recommendedWorkerCommand: (model, effort) =>
      `codex --yolo -m ${model.id} -c "model_reasoning_effort=${effort}"`,
  },
];

async function findOnPath(executable: string): Promise<string | null> {
  const lookup = platform() === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(lookup, [executable], {
      windowsHide: true,
      timeout: VERSION_TIMEOUT_MS,
    });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

async function probeVersion(
  executable: string,
  args: string[],
): Promise<{ version: string | null; error: string | null }> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: VERSION_TIMEOUT_MS,
    });
    const out = (stdout || stderr).trim();
    return { version: out || null, error: null };
  } catch (err) {
    return { version: null, error: (err as Error).message };
  }
}

async function diagnoseRuntime(spec: RuntimeSpec): Promise<AgentRuntimeDiagnostic> {
  const executablePath = await findOnPath(spec.executable);
  const installed = executablePath !== null;
  let version: string | null = null;
  let versionError: string | null = null;
  if (installed) {
    const probe = await probeVersion(spec.executable, spec.versionArgs);
    version = probe.version;
    versionError = probe.error;
  }
  const defaultModel = spec.models.find((m) => m.isDefault) ?? spec.models[0];
  const defaultEffort: AgentEffortLevel = defaultModel?.effortLevels.includes("medium")
    ? "medium"
    : (defaultModel?.effortLevels[0] ?? "medium");
  const recommendedWorkerCommand =
    installed && defaultModel ? spec.recommendedWorkerCommand(defaultModel, defaultEffort) : null;

  return {
    kind: spec.kind,
    label: spec.label,
    installed,
    executablePath,
    version,
    versionError,
    models: spec.models,
    recommendedWorkerCommand,
    installHint: spec.installHint,
    lastCheckedAt: new Date().toISOString(),
  };
}

let cache: { value: AgentRuntimeDiagnostic[]; expires: number } | null = null;
const CACHE_MS = 30_000;

export async function detectAgentRuntimes(force = false): Promise<AgentRuntimeDiagnostic[]> {
  const now = Date.now();
  if (!force && cache && cache.expires > now) {
    return cache.value;
  }
  const value = await Promise.all(RUNTIMES.map(diagnoseRuntime));
  cache = { value, expires: now + CACHE_MS };
  return value;
}

export function listKnownRuntimes(): RuntimeSpec[] {
  return RUNTIMES;
}
