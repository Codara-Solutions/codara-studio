import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { CommitMessageModel, PiSubscriptionProvider } from "@shared/types";
import type {
  PiAccountAuthInspection,
  PiAccountRuntimeProfile,
} from "./pi-account-auth-store";
import type { PiRuntimeLocation } from "./pi-runtime";
import { buildPiSubscriptionEnvironment } from "./pi-runtime";

export const PI_COMMIT_TIMEOUT_MS = 45_000;
export const PI_COMMIT_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const PI_COMMIT_SYSTEM_PROMPT_LIMIT_CHARS = 4_096;

export interface PiCommitRoute {
  provider: PiSubscriptionProvider;
  model: "gpt-5.6-luna" | "claude-sonnet-5";
}

export interface PiCommitOneShotInput {
  cwd: string;
  modelSelection: CommitMessageModel;
  systemPrompt: string;
  prompt: string;
}

export interface PiCommitOneShotResult extends PiCommitRoute {
  text: string;
}

interface PiCommitChildProcess {
  stdin: Writable;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface PiCommitLaunchRuntime {
  runtime: PiRuntimeLocation;
  executable: string;
}

export interface PiCommitOneShotDependencies {
  inspectAccounts: () => Promise<PiAccountAuthInspection>;
  resolveAccount: (input: {
    provider: PiSubscriptionProvider;
    preferredAccountProfileId: string;
    requirePreferred: true;
  }) => Promise<PiAccountRuntimeProfile>;
  resolveLaunchRuntime: () => Promise<PiCommitLaunchRuntime>;
  spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => PiCommitChildProcess;
  createTemporaryDirectory: (prefix: string) => Promise<string>;
  removeTemporaryDirectory: (path: string) => Promise<void>;
  baseEnv: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputLimitBytes: number;
}

function usableProviders(
  inspection: PiAccountAuthInspection,
): Set<PiSubscriptionProvider> {
  const result = new Set<PiSubscriptionProvider>();
  for (const status of inspection.statuses) {
    if (status.connected && (!status.expired || status.canRefresh)) {
      result.add(status.provider);
    }
  }
  return result;
}

export function resolvePiCommitRoute(
  selection: CommitMessageModel,
  inspection: PiAccountAuthInspection,
): PiCommitRoute | null {
  const usable = usableProviders(inspection);
  if (selection === "gpt-5.6-luna") {
    return usable.has("openai-codex")
      ? { provider: "openai-codex", model: selection }
      : null;
  }
  if (selection === "claude-sonnet-5") {
    return usable.has("anthropic")
      ? { provider: "anthropic", model: selection }
      : null;
  }
  if (usable.has("openai-codex")) {
    return { provider: "openai-codex", model: "gpt-5.6-luna" };
  }
  if (usable.has("anthropic")) {
    return { provider: "anthropic", model: "claude-sonnet-5" };
  }
  return null;
}

function selectUsableProfileId(
  inspection: PiAccountAuthInspection,
  provider: PiSubscriptionProvider,
): string | null {
  const usableIds = new Set(
    inspection.statuses
      .filter(
        (status) =>
          status.provider === provider &&
          status.connected &&
          (!status.expired || status.canRefresh),
      )
      .map((status) => status.profileId),
  );
  const preferred = inspection.snapshot.defaults[provider];
  if (preferred && usableIds.has(preferred)) return preferred;
  return (
    inspection.snapshot.profiles.find(
      (profile) => profile.provider === provider && usableIds.has(profile.id),
    )?.id ?? null
  );
}

async function defaultInspectAccounts(): Promise<PiAccountAuthInspection> {
  const { inspectPiAccountProfileAuthStore } = await import("./pi-account-auth-store");
  return inspectPiAccountProfileAuthStore();
}

async function defaultResolveAccount(input: {
  provider: PiSubscriptionProvider;
  preferredAccountProfileId: string;
  requirePreferred: true;
}): Promise<PiAccountRuntimeProfile> {
  const { resolvePiAccountRuntimeProfile } = await import("./pi-account-auth-store");
  return resolvePiAccountRuntimeProfile(input);
}

async function defaultResolveLaunchRuntime(): Promise<PiCommitLaunchRuntime> {
  const { electronAsNodeInterpreter, resolveCodaraPiRuntime } = await import(
    "./pi-runtime-electron"
  );
  return {
    runtime: await resolveCodaraPiRuntime(),
    executable: electronAsNodeInterpreter(),
  };
}

const DEFAULT_DEPENDENCIES: PiCommitOneShotDependencies = {
  inspectAccounts: defaultInspectAccounts,
  resolveAccount: defaultResolveAccount,
  resolveLaunchRuntime: defaultResolveLaunchRuntime,
  spawnProcess: (command, args, options) =>
    nodeSpawn(command, [...args], options) as unknown as PiCommitChildProcess,
  createTemporaryDirectory: (prefix) => mkdtemp(prefix),
  removeTemporaryDirectory: (path) => rm(path, { recursive: true, force: true }),
  baseEnv: process.env,
  timeoutMs: PI_COMMIT_TIMEOUT_MS,
  outputLimitBytes: PI_COMMIT_OUTPUT_LIMIT_BYTES,
};

function runChild(
  child: PiCommitChildProcess,
  prompt: string,
  timeoutMs: number,
  outputLimitBytes: number,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const stdoutDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const stop = (message: string) => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already have exited.
      }
      finish(new Error(message));
    };
    const timer = setTimeout(
      () => stop("Pi commit generation timed out"),
      timeoutMs,
    );

    child.stdout.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > outputLimitBytes) {
        stop("Pi commit generation exceeded the output limit");
        return;
      }
      stdout += stdoutDecoder.write(buffer);
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      if (stderrBytes > outputLimitBytes) {
        stop("Pi commit generation exceeded the error output limit");
      }
    });
    child.stdin.once("error", () => {
      stop("Pi commit generation input failed");
    });
    child.once("error", () => {
      finish(new Error("Pi commit generation process failed to start"));
    });
    child.once("close", (...args: unknown[]) => {
      const code = typeof args[0] === "number" ? args[0] : null;
      if (code !== 0) {
        finish(new Error("Pi commit generation process failed"));
        return;
      }
      stdout += stdoutDecoder.end();
      const text = stdout.trim();
      if (!text) {
        finish(new Error("Pi commit generation returned no text"));
        return;
      }
      finish(null, text);
    });

    try {
      child.stdin.write(Buffer.from(prompt, "utf8"), (error) => {
        if (error) stop("Pi commit generation input failed");
      });
      // end() queues EOF behind buffered data even when write() reports
      // backpressure, so an early child exit cannot strand a drain wait.
      child.stdin.end();
    } catch {
      stop("Pi commit generation input failed");
    }
  });
}

export async function runSessionlessPiCommitMessage(
  input: PiCommitOneShotInput,
  overrides: Partial<PiCommitOneShotDependencies> = {},
): Promise<PiCommitOneShotResult | null> {
  if (input.systemPrompt.length > PI_COMMIT_SYSTEM_PROMPT_LIMIT_CHARS) {
    throw new Error("Pi commit system prompt exceeded the argument limit");
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  // This inspection is read-only with respect to OAuth. It may report an
  // expired but refreshable credential as usable, but Pi alone refreshes it
  // after the user actually requests generation.
  const inspection = await dependencies.inspectAccounts();
  const route = resolvePiCommitRoute(input.modelSelection, inspection);
  if (!route) return null;
  const profileId = selectUsableProfileId(inspection, route.provider);
  if (!profileId) return null;

  const [account, launch] = await Promise.all([
    dependencies.resolveAccount({
      provider: route.provider,
      preferredAccountProfileId: profileId,
      requirePreferred: true,
    }),
    dependencies.resolveLaunchRuntime(),
  ]);

  const temporarySessionDir = await dependencies.createTemporaryDirectory(
    join(tmpdir(), "codara-pi-commit-"),
  );
  try {
    const env = buildPiSubscriptionEnvironment(
      dependencies.baseEnv,
      account.configDir,
      temporarySessionDir,
    );
    for (const key of [
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
      "PI_PROVIDER",
      "PI_MODEL",
      "PI_REASONING_LEVEL",
    ]) {
      delete env[key];
    }
    env.PI_SKIP_VERSION_CHECK = "1";

    const args = [
      launch.runtime.entrypoint,
      "-p",
      "--no-session",
      "--no-tools",
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-approve",
      "--provider",
      route.provider,
      "--model",
      route.model,
      "--thinking",
      "off",
      "--system-prompt",
      input.systemPrompt,
    ];
    const child = dependencies.spawnProcess(launch.executable, args, {
      cwd: input.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });
    const text = await runChild(
      child,
      input.prompt,
      dependencies.timeoutMs,
      dependencies.outputLimitBytes,
    );
    return { ...route, text };
  } finally {
    await dependencies.removeTemporaryDirectory(temporarySessionDir);
  }
}
