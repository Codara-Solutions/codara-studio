import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { shell, type WebContents } from "electron";
import type {
  PiSubscriptionAuthEvent,
  PiSubscriptionConnection,
  PiSubscriptionOverview,
  PiSubscriptionPrompt,
  PiSubscriptionProvider,
} from "@shared/types";

import { codaraPiPaths, resolveCodaraPiRuntime } from "./pi-runtime-electron";
import { inspectPiSubscriptionAuth } from "./pi-runtime";

interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

interface OAuthInteractionPrompt {
  type: "text" | "secret" | "manual_code" | "select";
  message: string;
  placeholder?: string;
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>;
  signal?: AbortSignal;
}

interface OAuthInteractionEvent {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  links?: ReadonlyArray<{ url: string; label?: string }>;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  expiresInSeconds?: number;
}

interface OAuthAuth {
  name: string;
  login(interaction: {
    signal: AbortSignal;
    prompt(prompt: OAuthInteractionPrompt): Promise<string>;
    notify(event: OAuthInteractionEvent): void;
  }): Promise<OAuthCredential>;
}

interface AuthStorageInstance {
  modify(
    provider: string,
    fn: (current: unknown) => Promise<OAuthCredential | undefined>,
  ): Promise<unknown>;
  delete(provider: string): Promise<void>;
}

interface ActiveFlow {
  requestId: string;
  provider: PiSubscriptionProvider;
  ownerId: number;
  abort: AbortController;
  pendingPrompt: {
    promptId: string;
    resolve(value: string): void;
    reject(error: Error): void;
    removeAbortListener(): void;
  } | null;
}

const PROVIDER_META: Record<
  PiSubscriptionProvider,
  { label: string; model: string; oauthModule: string; exportName: string }
> = {
  "openai-codex": {
    label: "ChatGPT Plus / Pro",
    model: "GPT-5.6 Sol",
    oauthModule: "openai-codex.js",
    exportName: "openaiCodexOAuth",
  },
  anthropic: {
    label: "Claude Pro / Max",
    model: "Fable 5",
    oauthModule: "anthropic.js",
    exportName: "anthropicOAuth",
  },
};

const activeFlows = new Map<string, ActiveFlow>();

function providerFrom(value: unknown): PiSubscriptionProvider {
  if (value === "anthropic" || value === "openai-codex") return value;
  throw new Error("Unsupported Pi subscription provider");
}

function safeAuthError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/([?&#](?:code|state|access_token|refresh_token)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9._-]{20,})\b/g, "[redacted]")
    .slice(0, 600);
}

function publicPrompt(prompt: OAuthInteractionPrompt): PiSubscriptionPrompt {
  if (prompt.type === "select") {
    return {
      type: "select",
      message: prompt.message,
      options: (prompt.options ?? []).map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    };
  }
  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
  };
}

function send(owner: WebContents, event: PiSubscriptionAuthEvent): void {
  if (!owner.isDestroyed()) owner.send("pi-subscriptions:event", event);
}

async function openOAuthUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The subscription provider returned an invalid login URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The subscription provider returned an unsafe login URL");
  }
  await shell.openExternal(parsed.toString());
}

async function loadOAuth(provider: PiSubscriptionProvider): Promise<OAuthAuth> {
  const runtime = await resolveCodaraPiRuntime();
  const meta = PROVIDER_META[provider];
  const modulePath = join(
    runtime.packageRoot,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "auth",
    "oauth",
    meta.oauthModule,
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as Record<string, unknown>;
  const oauth = loaded[meta.exportName] as OAuthAuth | undefined;
  if (!oauth || typeof oauth.login !== "function") {
    throw new Error(`Pinned Pi does not expose the ${meta.label} OAuth flow`);
  }
  return oauth;
}

async function loadAuthStorage(): Promise<{ create(path: string): AuthStorageInstance }> {
  const runtime = await resolveCodaraPiRuntime();
  const modulePath = join(runtime.packageRoot, "dist", "core", "auth-storage.js");
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
    AuthStorage?: { create(path: string): AuthStorageInstance };
  };
  if (!loaded.AuthStorage?.create) throw new Error("Pinned Pi auth storage is unavailable");
  return loaded.AuthStorage;
}

async function connectionStatus(provider: PiSubscriptionProvider): Promise<PiSubscriptionConnection> {
  const meta = PROVIDER_META[provider];
  try {
    const status = await inspectPiSubscriptionAuth(codaraPiPaths().authFile, provider);
    return {
      provider,
      label: meta.label,
      model: meta.model,
      connected: true,
      expired: status.expired,
      canRefresh: status.canRefresh,
      expiresAt: status.expiresAt,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const message = safeAuthError(error);
    const expectedMissing = code === "ENOENT" || /not authenticated|no OAuth access token/i.test(message);
    return {
      provider,
      label: meta.label,
      model: meta.model,
      connected: false,
      expired: false,
      canRefresh: false,
      expiresAt: null,
      ...(expectedMissing ? {} : { error: message }),
    };
  }
}

export async function inspectPiSubscriptions(): Promise<PiSubscriptionOverview> {
  const [runtimeResult, ...connections] = await Promise.all([
    resolveCodaraPiRuntime()
      .then((runtime) => ({ installed: true as const, version: runtime.version, error: undefined }))
      .catch((error) => ({ installed: false as const, version: null, error: safeAuthError(error) })),
    connectionStatus("openai-codex"),
    connectionStatus("anthropic"),
  ]);
  return {
    runtimeInstalled: runtimeResult.installed,
    runtimeVersion: runtimeResult.version,
    ...(runtimeResult.error ? { runtimeError: runtimeResult.error } : {}),
    connections,
  };
}

function settlePendingPrompt(flow: ActiveFlow, error: Error): void {
  const pending = flow.pendingPrompt;
  if (!pending) return;
  flow.pendingPrompt = null;
  pending.removeAbortListener();
  pending.reject(error);
}

async function persistCredential(provider: PiSubscriptionProvider, credential: OAuthCredential): Promise<void> {
  const paths = codaraPiPaths();
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  const AuthStorage = await loadAuthStorage();
  const storage = AuthStorage.create(paths.authFile);
  await storage.modify(provider, async () => credential);
  if (process.platform !== "win32") await chmod(paths.authFile, 0o600);
}

async function runLogin(flow: ActiveFlow, owner: WebContents): Promise<void> {
  const { provider, requestId } = flow;
  const meta = PROVIDER_META[provider];
  try {
    const oauth = await loadOAuth(provider);
    const credential = await oauth.login({
      signal: flow.abort.signal,
      prompt: async (prompt) => {
        if (flow.abort.signal.aborted) throw new Error("Login cancelled");
        // Browser login is the smooth default. Device-code login remains
        // available as an explicit choice if a future provider needs it, but a
        // normal desktop user should not have to answer a redundant question.
        if (prompt.type === "select") {
          const browser = prompt.options?.find((option) => option.id === "browser");
          if (browser) {
            send(owner, {
              type: "progress",
              requestId,
              provider,
              message: "Opening secure browser login…",
            });
            return browser.id;
          }
        }
        const promptId = randomUUID();
        send(owner, {
          type: "prompt",
          requestId,
          promptId,
          provider,
          prompt: publicPrompt(prompt),
        });
        return new Promise<string>((resolve, reject) => {
          const abort = () => {
            if (flow.pendingPrompt?.promptId !== promptId) return;
            flow.pendingPrompt = null;
            reject(new Error("Login cancelled"));
          };
          prompt.signal?.addEventListener("abort", abort, { once: true });
          flow.abort.signal.addEventListener("abort", abort, { once: true });
          flow.pendingPrompt = {
            promptId,
            resolve: (value) => {
              prompt.signal?.removeEventListener("abort", abort);
              flow.abort.signal.removeEventListener("abort", abort);
              resolve(value);
            },
            reject,
            removeAbortListener: () => {
              prompt.signal?.removeEventListener("abort", abort);
              flow.abort.signal.removeEventListener("abort", abort);
            },
          };
        });
      },
      notify: (event) => {
        if (event.type === "auth_url" && event.url) {
          send(owner, {
            type: "auth_url",
            requestId,
            provider,
            url: event.url,
            ...(event.instructions ? { instructions: event.instructions } : {}),
          });
          void openOAuthUrl(event.url).catch((error) => {
            send(owner, { type: "failed", requestId, provider, message: safeAuthError(error) });
            flow.abort.abort();
          });
          return;
        }
        if (event.type === "device_code" && event.userCode && event.verificationUri) {
          send(owner, {
            type: "device_code",
            requestId,
            provider,
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}),
          });
          void openOAuthUrl(event.verificationUri).catch(() => undefined);
          return;
        }
        const message = event.message?.trim();
        if (message) send(owner, { type: "progress", requestId, provider, message });
      },
    });
    if (flow.abort.signal.aborted) throw new Error("Login cancelled");
    await persistCredential(provider, credential);
    send(owner, {
      type: "completed",
      requestId,
      provider,
      message: `${meta.label} is connected to Cora through Pi.`,
      overview: await inspectPiSubscriptions(),
    });
  } catch (error) {
    const cancelled = flow.abort.signal.aborted || /cancelled|canceled|aborted/i.test(safeAuthError(error));
    send(owner, {
      type: cancelled ? "cancelled" : "failed",
      requestId,
      provider,
      message: cancelled ? "Subscription login cancelled." : safeAuthError(error),
    });
  } finally {
    settlePendingPrompt(flow, new Error("Login finished"));
    activeFlows.delete(requestId);
  }
}

export function startPiSubscriptionLogin(
  rawProvider: unknown,
  owner: WebContents,
): { requestId: string; provider: PiSubscriptionProvider } {
  const provider = providerFrom(rawProvider);
  for (const flow of activeFlows.values()) {
    if (flow.provider === provider && flow.ownerId === owner.id) {
      return { requestId: flow.requestId, provider };
    }
  }
  const requestId = randomUUID();
  const flow: ActiveFlow = {
    requestId,
    provider,
    ownerId: owner.id,
    abort: new AbortController(),
    pendingPrompt: null,
  };
  activeFlows.set(requestId, flow);
  send(owner, {
    type: "started",
    requestId,
    provider,
    message: `Connecting ${PROVIDER_META[provider].label}…`,
  });
  void runLogin(flow, owner);
  return { requestId, provider };
}

export function answerPiSubscriptionPrompt(
  input: { requestId?: unknown; promptId?: unknown; value?: unknown },
  owner: WebContents,
): void {
  const requestId = typeof input?.requestId === "string" ? input.requestId : "";
  const promptId = typeof input?.promptId === "string" ? input.promptId : "";
  const value = typeof input?.value === "string" ? input.value.trim() : "";
  const flow = activeFlows.get(requestId);
  if (!flow || flow.ownerId !== owner.id || flow.pendingPrompt?.promptId !== promptId) {
    throw new Error("This Pi subscription prompt is no longer active");
  }
  const pending = flow.pendingPrompt;
  flow.pendingPrompt = null;
  pending.removeAbortListener();
  pending.resolve(value);
}

export function cancelPiSubscriptionLogin(rawRequestId: unknown, owner: WebContents): void {
  const requestId = typeof rawRequestId === "string" ? rawRequestId : "";
  const flow = activeFlows.get(requestId);
  if (!flow || flow.ownerId !== owner.id) return;
  flow.abort.abort();
  settlePendingPrompt(flow, new Error("Login cancelled"));
}

export async function disconnectPiSubscription(rawProvider: unknown): Promise<PiSubscriptionOverview> {
  const provider = providerFrom(rawProvider);
  const paths = codaraPiPaths();
  const AuthStorage = await loadAuthStorage();
  await AuthStorage.create(paths.authFile).delete(provider);
  if (process.platform !== "win32") await chmod(paths.authFile, 0o600).catch(() => undefined);
  return inspectPiSubscriptions();
}
