import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentEffortLevel,
  AgentRuntimeDiagnostic,
  AgentRuntimeKind,
  AgentRuntimeSelection,
  AppSettings,
} from "@shared/types";

import { listProviders } from "./providers";
import type { CliProvider } from "./providers/types";

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 4000;

async function probeVersion(
  executable: string,
  args: string[],
): Promise<{ output: string | null; error: string | null }> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: VERSION_TIMEOUT_MS,
    });
    const out = (stdout || stderr).trim();
    return { output: out || null, error: null };
  } catch (err) {
    return { output: null, error: (err as Error).message };
  }
}

async function diagnoseProvider(provider: CliProvider): Promise<AgentRuntimeDiagnostic> {
  // Use the binary resolver so installs that aren't on the inherited PATH
  // (npm-global behind a sparse Electron-from-Finder PATH, scoop shims,
  // nvm versions, etc.) still get found. The resolver internally falls
  // through which/where -> npm prefix -g -> common install dirs and caches
  // hits per-name.
  const executablePath = await provider.resolveBinary();
  const installed = executablePath !== null;
  let version: string | null = null;
  let versionError: string | null = null;
  if (installed) {
    // Prefer the absolute path for version probing so we hit the same binary
    // we just resolved, even if PATH lookup would have found a different
    // install. The exec call still applies its own timeout.
    const probe = await probeVersion(executablePath!, provider.versionArgs);
    version = probe.output ? provider.parseVersion(probe.output) : null;
    versionError = probe.error;
  }
  const defaultModel =
    provider.models.find((m) => m.isDefault) ?? provider.models[0];
  const defaultEffort: AgentEffortLevel = defaultModel?.effortLevels.includes("medium")
    ? "medium"
    : (defaultModel?.effortLevels[0] ?? "medium");
  const recommendedWorkerCommand =
    installed && defaultModel
      ? provider.recommendedWorkerCommand(defaultModel, defaultEffort)
      : null;

  return {
    kind: provider.id,
    label: provider.displayName,
    installed,
    executablePath,
    version,
    versionError,
    models: provider.models,
    recommendedWorkerCommand,
    installHint: provider.installHint,
    lastCheckedAt: new Date().toISOString(),
    capabilities: provider.capabilities,
  };
}

let cache: { value: AgentRuntimeDiagnostic[]; expires: number } | null = null;
const CACHE_MS = 30_000;

export async function detectAgentRuntimes(force = false): Promise<AgentRuntimeDiagnostic[]> {
  const now = Date.now();
  if (!force && cache && cache.expires > now) {
    return cache.value;
  }
  const masked = (process.env.SPARK_DISABLE_RUNTIMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const providers = listProviders();
  const value = await Promise.all(
    providers.map(async (provider) => {
      const diag = await diagnoseProvider(provider);
      if (masked.includes(provider.id.toLowerCase())) {
        return { ...diag, installed: false, version: null };
      }
      return diag;
    }),
  );
  cache = { value, expires: now + CACHE_MS };
  return value;
}

export function applyAgentRuntimeSettings(
  runtimes: AgentRuntimeDiagnostic[],
  settings?: Pick<AppSettings, "agentRuntimeSelection"> | null,
): AgentRuntimeDiagnostic[] {
  const enabled = enabledAgentRuntimeKinds(settings?.agentRuntimeSelection ?? "auto");
  return runtimes.map((runtime) => {
    if (enabled.has(runtime.kind)) return runtime;
    return {
      ...runtime,
      installed: false,
      disabledBySettings: true,
      disabledReason: "Disabled by Settings > Agents runtime selector.",
      recommendedWorkerCommand: null,
      installHint: "Disabled by Settings > Agents runtime selector.",
    };
  });
}

// The runtime kinds Spark recognizes today. Derived from the provider
// registry so adding a new provider automatically expands this set.
const ALL_RUNTIMES: readonly AgentRuntimeKind[] = listProviders().map((p) => p.id);

export function enabledAgentRuntimeKinds(
  selection: AgentRuntimeSelection = "auto",
): Set<AgentRuntimeKind> {
  // Array form: explicit subset chosen by the user in Settings. Empty array
  // disables every runtime (the user has opted out of all of them).
  if (Array.isArray(selection)) {
    return new Set(selection.filter((kind) => ALL_RUNTIMES.includes(kind)));
  }
  // Legacy string tokens kept for backwards-compat reads from older settings.
  if (selection === "claude") return new Set<AgentRuntimeKind>(["claude"]);
  if (selection === "codex") return new Set<AgentRuntimeKind>(["codex"]);
  // "auto" and "both" both mean "every runtime Spark knows about". The
  // historical "cursor" token migrates here implicitly (we no longer support
  // Cursor as a runtime — Spark App only spawns Claude or Codex workers).
  return new Set<AgentRuntimeKind>(ALL_RUNTIMES);
}

export function normalizeAgentRuntimeSelection(
  selection: AgentRuntimeSelection | undefined,
): AgentRuntimeKind[] {
  return Array.from(enabledAgentRuntimeKinds(selection ?? "auto"));
}
