import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentEffortLevel,
  AgentRuntimeDiagnostic,
  AgentRuntimeKind,
} from "@shared/types";

import { listProviders } from "./providers";
import type { CliProvider } from "./providers/types";

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 4000;

// ── Sign-in detection ────────────────────────────────────────────────────────
// `installed` only proves the binary resolves; a CLI can be present but signed
// out, which surfaces as a confusing launch failure much later. These probes
// establish credential PRESENCE only — the secret material itself is never
// read into a returned value, logged, or printed. Tri-state result:
// authenticated true/false when presence could be established, undefined
// (empty object) when it could not — callers must treat undefined as usable.
//
// IMPORTANT: `authenticated: false` is ADVISORY, never a gate. These probes
// cannot see the user's shell environment (an Electron app launched from
// Finder/Dock does not inherit profile-exported variables — the very premise
// of path-reconstruction.ts), nor every credential route the CLIs accept
// (apiKeyHelper scripts, cloud-provider SDK credentials, …). So "false" means
// "no credential detected from here", not "signed out": consumers may warn
// and prefer alternatives, but only `installed === false` may refuse work.

type RuntimeAuthProbe = Pick<AgentRuntimeDiagnostic, "authenticated" | "authHint">;

async function probeCodexAuth(): Promise<RuntimeAuthProbe> {
  // An exported API key authenticates codex without auth.json.
  if ((process.env.OPENAI_API_KEY ?? "").trim()) return { authenticated: true };
  try {
    const raw = await fs.readFile(join(homedir(), ".codex", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      OPENAI_API_KEY?: unknown;
      tokens?: { access_token?: unknown };
    };
    // Key presence only; values are never propagated.
    const hasOauthToken =
      typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.length > 0;
    const hasApiKey =
      typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0;
    if (hasOauthToken || hasApiKey) return { authenticated: true };
    return { authenticated: false, authHint: "Run `codex login` to sign in." };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { authenticated: false, authHint: "Run `codex login` to sign in." };
    }
    return {}; // unreadable/corrupt auth.json — cannot tell either way
  }
}

async function probeClaudeAuth(): Promise<RuntimeAuthProbe> {
  // Claude Code accepts several env credential routes besides the API key:
  // a raw bearer token, a long-lived OAuth token, and the Bedrock/Vertex
  // switches (which delegate auth to the cloud SDK's own credential chain).
  const envSignals = [
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
    process.env.CLAUDE_CODE_USE_BEDROCK,
    process.env.CLAUDE_CODE_USE_VERTEX,
  ];
  if (envSignals.some((value) => (value ?? "").trim())) return { authenticated: true };
  // An apiKeyHelper in settings hands the CLI a credential at launch time —
  // presence of the key (not its output) is the signal.
  try {
    const raw = await fs.readFile(join(homedir(), ".claude", "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { apiKeyHelper?: unknown };
    if (typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.trim()) {
      return { authenticated: true };
    }
  } catch {
    // Missing or unparsable settings.json says nothing either way.
  }
  // Non-Keychain installs (Linux, containers, keychain opt-outs) keep the
  // OAuth credential here. Check it first — it also covers macOS installs
  // that predate the Keychain move.
  try {
    const raw = await fs.readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
    JSON.parse(raw);
    return { authenticated: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return {};
  }
  if (process.platform === "darwin") {
    // Attribute-only Keychain lookup — deliberately NO `-w`. Reading item
    // metadata does not touch the secret, so the login Keychain answers
    // without a consent dialog (verified: ~10ms, no prompt; it is reading
    // the secret data that triggers one). Exit 44 = errSecItemNotFound.
    try {
      await execFileAsync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials"],
        { windowsHide: true, timeout: VERSION_TIMEOUT_MS },
      );
      return { authenticated: true };
    } catch (err) {
      const code = (err as { code?: number | string }).code;
      if (code === 44) {
        return { authenticated: false, authHint: "Run `claude` and sign in." };
      }
      return {}; // locked keychain / timeout / unexpected error — undetermined
    }
  }
  // Other platforms store credentials in OS-specific stores we do not probe;
  // stay undetermined rather than flag a healthy install as signed out.
  return {};
}

async function probeGrokAuth(): Promise<RuntimeAuthProbe> {
  if ((process.env.XAI_API_KEY ?? "").trim()) return { authenticated: true };
  try {
    const raw = await fs.readFile(join(homedir(), ".grok", "auth.json"), "utf8");
    JSON.parse(raw);
    return { authenticated: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { authenticated: false, authHint: "Run `grok login` to sign in." };
    }
    return {};
  }
}

async function probeRuntimeAuth(kind: AgentRuntimeKind): Promise<RuntimeAuthProbe> {
  if (kind === "codex") return probeCodexAuth();
  if (kind === "claude") return probeClaudeAuth();
  if (kind === "grok") return probeGrokAuth();
  return {};
}

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

async function diagnoseProvider(
  provider: CliProvider & { id: AgentRuntimeKind },
): Promise<AgentRuntimeDiagnostic> {
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
  // Only probe sign-in state for binaries that actually exist; runs behind
  // the same 30s detectAgentRuntimes cache as the version probe.
  const auth = installed ? await probeRuntimeAuth(provider.id) : {};

  return {
    kind: provider.id,
    label: provider.displayName,
    installed,
    ...auth,
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
  const providers = listProviders();
  const masked = (process.env.SPARK_DISABLE_RUNTIMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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
