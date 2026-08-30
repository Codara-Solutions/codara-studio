import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, shell, type WebContents } from "electron";
import { anthropicAccounts } from "./anthropic-accounts";
import { anthropicCredentialMirror, canonicalFromPi } from "./anthropic-credential-mirror";
import { loadPiAuthStorage } from "./pi-auth-storage";
import type {
  PiRuntimeInstallEvent,
  PiSubscriptionAuthEvent,
  PiSubscriptionConnection,
  PiSubscriptionOverview,
  PiSubscriptionProfileConnection,
  PiSubscriptionPrompt,
  PiSubscriptionProvider,
} from "@shared/types";

import { familyForSubscription, PI_SUBSCRIPTION_PROVIDERS, isPiSubscriptionProvider } from "../../shared/agent-families";
import { resolveCodaraPiRuntime } from "./pi-runtime-electron";
import { CODARA_PI_VERSION } from "./pi-runtime";
import { installPinnedPiRuntime, isPinnedPiRuntimeInstalling } from "./pi-runtime-install";
import {
  deletePiAccountCredentialProfile,
  inspectPiAccountProfileAuthStore,
  piAccountCredentialAccountEmail,
  piAccountCredentialIdentityFingerprint,
  preparePiAccountCredentialTarget,
  renamePiAccountProfile,
  resolvePiAccountRuntimeProfile,
  setDefaultPiAccountProfile,
  type PiAccountProfileOwnershipGuard,
  PiOAuthLoginGate,
} from "./pi-account-auth-store";
import {
  readAnthropicAccountProfile,
  type AnthropicAccountProfile,
} from "./anthropic-account-identity";
import {
  startPiOAuthCallbackServer,
  type PiOAuthCallbackServer,
} from "./pi-oauth-callback-server";
import { focusStudioWindow } from "../window-focus";

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
  /** Exchange the refresh token for a fresh credential. Network call; throws on
   * failure. Pi's own runtime calls this under the auth-store lock, and so must
   * we do; see refreshPiSubscriptionProfileCredential. The signal is deliberately NOT
   * optional here: Anthropic's module feeds it straight to AbortSignal.any,
   * which rejects undefined, so the type keeps that mistake from returning. */
  refresh?(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
}

interface ActiveFlow {
  requestId: string;
  provider: PiSubscriptionProvider;
  targetProfileId?: string;
  label?: string;
  makeDefault?: boolean;
  ownerId: string;
  abort: AbortController;
  releaseLoginGate: () => void;
  pendingPrompt: {
    promptId: string;
    resolve(value: string): void;
    reject(error: Error): void;
    removeAbortListener(): void;
  } | null;
}

/**
 * Transport-neutral owner for an OAuth ceremony. The desktop renderer and the
 * Cora CLI each provide one; only sanitized progress events cross this seam.
 * Credentials remain inside this main-process module and are persisted
 * directly into the isolated Pi auth store.
 */
export interface PiSubscriptionAuthOwner {
  id: string;
  emit(event: PiSubscriptionAuthEvent): void;
  focus?(): void;
}

export interface StartPiSubscriptionProfileLoginInput {
  provider: PiSubscriptionProvider;
  /** Reconnect this profile. Omit to add another account. */
  profileId?: string;
  /** Required by future multi-account UI; compatibility callers get a provider label. */
  label?: string;
  makeDefault?: boolean;
}

export interface PiSubscriptionProfileLoginRequest {
  requestId: string;
  provider: PiSubscriptionProvider;
  targetProfileId?: string;
}

const PROVIDER_META: Record<
  PiSubscriptionProvider,
  { label: string; model: string; oauthModule: string; exportName: string }
> = {
  "openai-codex": {
    label: familyForSubscription("openai-codex").planLabel,
    model: "GPT-5.6 Sol",
    oauthModule: "openai-codex.js",
    exportName: "openaiCodexOAuth",
  },
  anthropic: {
    label: familyForSubscription("anthropic").planLabel,
    model: "Fable 5",
    oauthModule: "anthropic.js",
    exportName: "anthropicOAuth",
  },
  xai: {
    label: familyForSubscription("xai").planLabel,
    model: "Grok 4.6",
    oauthModule: "xai.js",
    exportName: "xaiOAuth",
  },
};

/** Ceiling for a background token refresh. Pi's own resolver uses 15s. */
const REFRESH_TIMEOUT_MS = 15_000;

const activeFlows = new Map<string, ActiveFlow>();
const oauthLoginGate = new PiOAuthLoginGate();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function providerFrom(value: unknown): PiSubscriptionProvider {
  if (isPiSubscriptionProvider(value)) return value;
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

function webContentsAuthOwner(owner: WebContents): PiSubscriptionAuthOwner {
  return {
    id: `window:${owner.id}`,
    emit: (event) => {
      if (!owner.isDestroyed()) owner.send("pi-subscriptions:event", event);
    },
    focus: () => focusStudioWindow(owner),
  };
}

function send(owner: PiSubscriptionAuthOwner, event: PiSubscriptionAuthEvent): void {
  owner.emit(event);
}

// Auth-store mutations reach EVERY window, not just the one that ran the login
// flow. The title-bar usage pills poll on a slow interval and hide anything
// that is not status "ok", so without this push a reconnected subscription
// stayed invisible until the next poll or an app restart.
function broadcastSubscriptionsChanged(provider: PiSubscriptionProvider): void {
  const event: PiSubscriptionAuthEvent = { type: "changed", provider };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("pi-subscriptions:event", event);
  }
  // An account mutation may have created or removed a credential directory;
  // re-create the watchers so the mirror sees the new layout.
  if (provider === "anthropic") anthropicCredentialMirror.rearm();
}

/** Re-read account metadata after a rename/default mutation and wake every UI. */
export async function refreshPiSubscriptionsAfterMetadataChange(
  provider: PiSubscriptionProvider,
): Promise<PiSubscriptionOverview> {
  const [{ invalidatePiSubscriptionUsageCache }, { invalidatePiModelCatalogCache }] =
    await Promise.all([
      import("./pi-subscription-usage"),
      import("./pi-model-catalog"),
    ]);
  invalidatePiSubscriptionUsageCache();
  invalidatePiModelCatalogCache();
  broadcastSubscriptionsChanged(provider);
  return inspectPiSubscriptions();
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

const loadAuthStorage = loadPiAuthStorage;

function disconnectedConnection(provider: PiSubscriptionProvider): PiSubscriptionConnection {
  const meta = PROVIDER_META[provider];
  return {
    provider,
    label: meta.label,
    model: meta.model,
    connected: false,
    expired: false,
    canRefresh: false,
    expiresAt: null,
  };
}

function compatibilityConnection(
  provider: PiSubscriptionProvider,
  profiles: readonly PiSubscriptionProfileConnection[],
): PiSubscriptionConnection {
  const meta = PROVIDER_META[provider];
  const selected =
    profiles.find((profile) => profile.provider === provider && profile.isDefault) ??
    profiles.find((profile) => profile.provider === provider && profile.connected) ??
    profiles.find((profile) => profile.provider === provider);
  return selected
    ? {
        provider,
        label: meta.label,
        model: meta.model,
        connected: selected.connected,
        expired: selected.expired,
        canRefresh: selected.canRefresh,
        expiresAt: selected.expiresAt,
        ...(selected.error ? { error: selected.error } : {}),
      }
    : disconnectedConnection(provider);
}

export async function inspectPiSubscriptions(): Promise<PiSubscriptionOverview> {
  const [runtimeResult, inspection, terminals] = await Promise.all([
    resolveCodaraPiRuntime()
      .then((runtime) => ({ installed: true as const, version: runtime.version, error: undefined }))
      .catch((error) => ({ installed: false as const, version: null, error: safeAuthError(error) })),
    inspectPiAccountProfileAuthStore(),
    anthropicAccounts.terminalStatuses().catch(() => new Map<string, never>()),
  ]);
  const statuses = new Map(inspection.statuses.map((status) => [status.profileId, status]));
  const profiles: PiSubscriptionProfileConnection[] = inspection.snapshot.profiles.map((profile) => {
    const status = statuses.get(profile.id);
    // The registry digest is authoritative; the credential read backfills
    // accounts connected before the registry recorded one. Only the hash
    // crosses IPC — the account id it was taken from stays in this process.
    const accountFingerprint = profile.identityFingerprint ?? status?.accountFingerprint;
    // The registry address was captured at connect time (Anthropic); the
    // credential read covers Codex, whose token carries its own claims.
    const email = profile.accountEmail ?? status?.accountEmail;
    // The Claude Code half is projected as status only: which id it is, and
    // whether it is signed in. Its directory and tokens stay in main.
    const cliProfileId = profile.provider === "anthropic" ? profile.cliProfileId : undefined;
    const terminal = cliProfileId ? terminals.get(cliProfileId) : undefined;
    return {
      id: profile.id,
      provider: profile.provider,
      label: profile.label,
      isDefault: inspection.snapshot.defaults[profile.provider] === profile.id,
      connected: status?.connected === true,
      expired: status?.expired === true,
      canRefresh: status?.canRefresh === true,
      expiresAt: status?.expiresAt ?? null,
      ...(status?.error ? { error: status.error } : {}),
      ...(accountFingerprint ? { accountFingerprint } : {}),
      ...(email ? { email } : {}),
      ...(cliProfileId ? { cliProfileId } : {}),
      ...(cliProfileId === "personal" ? { builtIn: true as const } : {}),
      ...(terminal ? { terminal } : {}),
    };
  });
  const connections = PI_SUBSCRIPTION_PROVIDERS.map((provider) =>
    compatibilityConnection(provider, profiles),
  );
  return {
    runtimeInstalled: runtimeResult.installed,
    runtimeVersion: runtimeResult.version,
    ...(runtimeResult.error ? { runtimeError: runtimeResult.error } : {}),
    runtimeExpectedVersion: CODARA_PI_VERSION,
    ...(isPinnedPiRuntimeInstalling() ? { runtimeInstalling: true } : {}),
    connections,
    profiles,
  };
}

/**
 * Install the pinned Pi runtime for a Settings window, streaming npm's
 * progress back to that window and finishing with a fresh overview so the
 * subscription rows re-enable without a manual refresh.
 */
export async function installPiRuntimeForWindow(owner: WebContents): Promise<PiSubscriptionOverview> {
  const emit = (event: PiRuntimeInstallEvent): void => {
    if (!owner.isDestroyed()) owner.send("pi-runtime:install-event", event);
  };
  emit({ type: "started", message: `Installing Pi ${CODARA_PI_VERSION}…` });
  try {
    const version = await installPinnedPiRuntime(({ message }) => {
      emit({ type: "progress", message });
    });
    const overview = await inspectPiSubscriptions();
    emit({
      type: "completed",
      message: `Pi ${version} is installed. Connect a subscription to finish setting up Cora.`,
      overview,
    });
    return overview;
  } catch (error) {
    // Registry URLs and local paths are fine to show; the redaction pass is
    // shared with auth so a token echoed by a proxy error never reaches the UI.
    const message = safeAuthError(error);
    emit({ type: "failed", message });
    throw new Error(message);
  }
}

function settlePendingPrompt(flow: ActiveFlow, error: Error): void {
  const pending = flow.pendingPrompt;
  if (!pending) return;
  flow.pendingPrompt = null;
  pending.removeAbortListener();
  pending.reject(error);
}

/**
 * The anonymous account digest and the account's email address to record for a
 * credential that has just been issued. Codex carries both inside the
 * credential, so they come straight out of it. Anthropic's credential is opaque
 * tokens, so its account uuid and address are read once here — the single
 * moment a fresh access token is in hand — from Anthropic's OAuth profile
 * endpoint. A stored credential is never read for this and a refresh is never
 * triggered: outside connect, an account without a digest simply stays
 * unpaired, and one without an address simply shows none.
 */
async function connectTimeIdentity(
  provider: PiSubscriptionProvider,
  credential: OAuthCredential,
): Promise<AnthropicAccountProfile> {
  const fingerprint = piAccountCredentialIdentityFingerprint(provider, credential);
  const email = piAccountCredentialAccountEmail(provider, credential);
  if (fingerprint || email) return { ...(fingerprint ? { fingerprint } : {}), ...(email ? { email } : {}) };
  if (provider !== "anthropic" || !nonEmptyString(credential.access)) return {};
  return readAnthropicAccountProfile(credential.access);
}

async function persistCredential(
  flow: ActiveFlow,
  credential: OAuthCredential,
): Promise<string> {
  const identity = await connectTimeIdentity(flow.provider, credential);
  const target = await preparePiAccountCredentialTarget({
    provider: flow.provider,
    ...(flow.targetProfileId ? { profileId: flow.targetProfileId } : {}),
    ...(flow.label ? { label: flow.label } : {}),
    ...(identity.fingerprint ? { identityFingerprint: identity.fingerprint } : {}),
    ...(identity.email ? { accountEmail: identity.email } : {}),
  });
  try {
    await mkdir(target.configDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(target.configDir, 0o700);
    const AuthStorage = await loadAuthStorage();
    await AuthStorage.create(target.authFile).modify(flow.provider, async () => credential);
    if (process.platform !== "win32") await chmod(target.authFile, 0o600);
  } catch (error) {
    // A failed first write must not leave a metadata row that looks usable.
    if (target.created) {
      await deletePiAccountCredentialProfile(target.profile.id).catch(() => undefined);
    }
    throw error;
  }
  if (flow.provider === "anthropic") {
    // One sign-in serves both halves: the Claude Code side is written from the
    // credential just received. Its failure is not the sign-in's failure; the
    // card then offers Share instead.
    const canonical = canonicalFromPi(credential);
    if (canonical) {
      await anthropicAccounts
        .ensureCliHalf(target.profile.id, canonical, identity)
        .catch((cliError) => {
          console.warn(
            `[accounts] Claude Code half for ${target.profile.id} was not written: ${safeAuthError(cliError)}`,
          );
        });
    }
    if (flow.makeDefault) {
      await anthropicAccounts.useAnthropicAccount(target.profile.id);
    }
  } else if (flow.makeDefault) {
    await setDefaultPiAccountProfile(flow.provider, target.profile.id);
  }
  // A newly connected subscription must not read its limits — or its model
  // catalog — through a cache populated while it was still disconnected.
  const { invalidatePiSubscriptionUsageCache } = await import("./pi-subscription-usage");
  invalidatePiSubscriptionUsageCache();
  const { invalidatePiModelCatalogCache } = await import("./pi-model-catalog");
  invalidatePiModelCatalogCache();
  broadcastSubscriptionsChanged(flow.provider);
  return target.profile.id;
}

function oauthStateFromAuthUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("state");
  } catch {
    return null;
  }
}

async function runLogin(flow: ActiveFlow, owner: PiSubscriptionAuthOwner): Promise<void> {
  const { provider, requestId } = flow;
  const meta = PROVIDER_META[provider];
  let callback: PiOAuthCallbackServer | null = null;
  // Stall watchdog: a login that produces neither a sign-in URL nor a prompt
  // is stuck (a held callback port, a silently wedged Pi runtime) and used to
  // strand the Settings card on "Opening your browser…" forever with only
  // Cancel. If Pi shows no sign of life in time, fail the flow with a real
  // message instead.
  let sawLoginSignal = false;
  const markLoginSignal = (): void => {
    sawLoginSignal = true;
  };
  const stallWatchdog = setTimeout(() => {
    if (sawLoginSignal || flow.abort.signal.aborted) return;
    send(owner, {
      type: "failed",
      requestId,
      provider,
      message:
        "The sign-in stalled before producing a login URL. Another app (or a second Codara Studio) may be holding the sign-in port. Close other instances and try again.",
    });
    flow.abort.abort();
  }, 45_000);
  try {
    const oauth = await loadOAuth(provider);
    // Own the loopback callback so the browser's last page is Codara's, not
    // Pi's. Only the OpenAI flow tolerates losing its own listener — see
    // pi-oauth-callback-server.ts. A null result means the port was taken and
    // Pi runs the callback itself, exactly as before.
    if (provider === "openai-codex") callback = await startPiOAuthCallbackServer();
    const credential = await oauth.login({
      signal: flow.abort.signal,
      prompt: async (prompt) => {
        markLoginSignal();
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
              message: "Opening your browser to sign in…",
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
        const typed = new Promise<string>((resolve, reject) => {
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
        if (!callback || prompt.type !== "manual_code") return typed;
        // Pi asks for a pasted code because it believes it has no listener of
        // its own; Codara's listener answers that prompt when the browser
        // lands, while a genuine paste still wins if it comes first. Attaching
        // the handlers here keeps the loser from surfacing as an unhandled
        // rejection when the flow settles the pending prompt on the way out.
        const typedOutcome = typed.then(
          (value) => ({ kind: "typed" as const, value }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        const outcome = await Promise.race([
          typedOutcome,
          callback.waitForRedirect().then((url) => ({ kind: "callback" as const, url })),
        ]);
        if (outcome.kind === "typed") return outcome.value;
        if (outcome.kind === "failed") throw outcome.error;
        if (outcome.url) {
          const pending = flow.pendingPrompt;
          if (pending?.promptId === promptId) {
            flow.pendingPrompt = null;
            pending.removeAbortListener();
          }
          return outcome.url;
        }
        // The listener gave up without a callback; the paste box is the answer.
        const settled = await typedOutcome;
        if (settled.kind === "typed") return settled.value;
        throw settled.error;
      },
      notify: (event) => {
        markLoginSignal();
        if (event.type === "auth_url" && event.url) {
          // Pi's authorize URL carries the state its callback expects. Learning
          // it here — before the browser opens — lets Codara's listener reject
          // anything that is not this sign-in, exactly as Pi's own would.
          const state = oauthStateFromAuthUrl(event.url);
          if (state) callback?.expectState(state);
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
    const profileId = await persistCredential(flow, credential);
    flow.targetProfileId = profileId;
    send(owner, {
      type: "completed",
      requestId,
      provider,
      message: `${meta.label} is connected to Cora.`,
      overview: await inspectPiSubscriptions(),
    });
    // The user finished in the browser; bring them back to the Settings window
    // that started this instead of leaving them to find Studio themselves.
    owner.focus?.();
  } catch (error) {
    const cancelled = flow.abort.signal.aborted || /cancelled|canceled|aborted/i.test(safeAuthError(error));
    send(owner, {
      type: cancelled ? "cancelled" : "failed",
      requestId,
      provider,
      message: cancelled ? "Sign-in cancelled." : safeAuthError(error),
    });
    // A cancel came from Studio, so the user is already here; a real failure
    // happened out in the browser and needs the window pulled back.
    if (!cancelled) owner.focus?.();
  } finally {
    clearTimeout(stallWatchdog);
    callback?.close();
    settlePendingPrompt(flow, new Error("Login finished"));
    activeFlows.delete(requestId);
    flow.releaseLoginGate();
  }
}

export async function startPiSubscriptionProfileLoginForOwner(
  input: StartPiSubscriptionProfileLoginInput,
  owner: PiSubscriptionAuthOwner,
): Promise<PiSubscriptionProfileLoginRequest> {
  const provider = providerFrom(input.provider);
  let targetProfileId: string | undefined;
  if (input.profileId) {
    const inspection = await inspectPiAccountProfileAuthStore();
    const profile = inspection.snapshot.profiles.find((entry) => entry.id === input.profileId);
    if (!profile) throw new Error(`Pi account profile not found: ${input.profileId}`);
    if (profile.provider !== provider) {
      throw new Error(`Pi account profile ${input.profileId} does not belong to provider ${provider}`);
    }
    targetProfileId = profile.id;
  }

  for (const flow of activeFlows.values()) {
    if (
      flow.provider === provider &&
      flow.ownerId === owner.id &&
      flow.targetProfileId === targetProfileId
    ) {
      return {
        requestId: flow.requestId,
        provider,
        ...(targetProfileId ? { targetProfileId } : {}),
      };
    }
    break;
  }

  const requestId = randomUUID();
  // Pi's OAuth implementations bind fixed loopback callback ports. One
  // process-wide flow at a time prevents windows from racing those ports or
  // delivering one account's callback into another account's request.
  const releaseLoginGate = oauthLoginGate.acquire(requestId);
  try {
    const flow: ActiveFlow = {
      requestId,
      provider,
      ...(targetProfileId ? { targetProfileId } : {}),
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      ...(input.makeDefault ? { makeDefault: true } : {}),
      ownerId: owner.id,
      abort: new AbortController(),
      releaseLoginGate,
      pendingPrompt: null,
    };
    activeFlows.set(requestId, flow);
    send(owner, {
      type: "started",
      requestId,
      provider,
      message: `Signing in to ${PROVIDER_META[provider].label}…`,
    });
    void runLogin(flow, owner);
    return {
      requestId,
      provider,
      ...(targetProfileId ? { targetProfileId } : {}),
    };
  } catch (error) {
    activeFlows.delete(requestId);
    releaseLoginGate();
    throw error;
  }
}

export async function startPiSubscriptionProfileLogin(
  input: StartPiSubscriptionProfileLoginInput,
  owner: WebContents,
): Promise<PiSubscriptionProfileLoginRequest> {
  return startPiSubscriptionProfileLoginForOwner(input, webContentsAuthOwner(owner));
}

/** Compatibility entry point: reconnect the provider default, or create it. */
export async function startPiSubscriptionLogin(
  rawProvider: unknown,
  owner: WebContents,
): Promise<PiSubscriptionProfileLoginRequest> {
  const provider = providerFrom(rawProvider);
  const inspection = await inspectPiAccountProfileAuthStore();
  const defaultId = inspection.snapshot.defaults[provider];
  const existing =
    inspection.snapshot.profiles.find((profile) => profile.id === defaultId) ??
    inspection.snapshot.profiles.find((profile) => profile.provider === provider);
  return startPiSubscriptionProfileLogin(
    {
      provider,
      ...(existing ? { profileId: existing.id } : { label: PROVIDER_META[provider].label }),
      makeDefault: true,
    },
    owner,
  );
}

export function answerPiSubscriptionPrompt(
  input: { requestId?: unknown; promptId?: unknown; value?: unknown },
  owner: WebContents,
): void {
  answerPiSubscriptionPromptForOwner(input, webContentsAuthOwner(owner));
}

export function answerPiSubscriptionPromptForOwner(
  input: { requestId?: unknown; promptId?: unknown; value?: unknown },
  owner: PiSubscriptionAuthOwner,
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
  cancelPiSubscriptionLoginForOwner(rawRequestId, webContentsAuthOwner(owner));
}

export function cancelPiSubscriptionLoginForOwner(
  rawRequestId: unknown,
  owner: PiSubscriptionAuthOwner,
): void {
  const requestId = typeof rawRequestId === "string" ? rawRequestId : "";
  const flow = activeFlows.get(requestId);
  if (!flow || flow.ownerId !== owner.id) return;
  flow.abort.abort();
  settlePendingPrompt(flow, new Error("Login cancelled"));
}

/**
 * Exchange a provider's refresh token for a fresh access token and persist it,
 * returning the new access token (or null when the credential cannot be
 * refreshed). Used by the usage-limits check, whose vendor endpoints reject an
 * expired bearer token.
 *
 * The refresh runs INSIDE Pi's `AuthStorage.modify` lock, which is not an
 * optimization but a correctness requirement: these providers rotate refresh
 * tokens, so a refresh racing a live Pi session's own refresh would write back
 * a superseded token and silently sign the user out. Under the lock we also
 * re-check expiry, because the session that beat us here may have already
 * produced a perfectly good token.
 */
export async function refreshPiSubscriptionProfileCredential(
  rawProfileId: unknown,
  rawProvider?: unknown,
): Promise<string | null> {
  const profileId = typeof rawProfileId === "string" ? rawProfileId : "";
  const inspection = await inspectPiAccountProfileAuthStore();
  const profile = inspection.snapshot.profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`Pi account profile not found: ${profileId}`);
  const provider = rawProvider === undefined ? profile.provider : providerFrom(rawProvider);
  if (profile.provider !== provider) {
    throw new Error(`Pi account profile ${profileId} does not belong to provider ${provider}`);
  }
  const oauth = await loadOAuth(provider);
  if (typeof oauth.refresh !== "function") return null;
  const paths = await resolvePiAccountRuntimeProfile({
    provider,
    preferredAccountProfileId: profileId,
    requirePreferred: true,
  });
  const AuthStorage = await loadAuthStorage();
  const storage = AuthStorage.create(paths.authFile);
  const attempt = async (): Promise<{ access: string | null; refreshed: boolean }> => {
    let access: string | null = null;
    let refreshed = false;
    await storage.modify(provider, async (current) => {
      if (!isRecord(current) || current.type !== "oauth") return undefined;
      const credential = current as unknown as OAuthCredential;
      // A minute of headroom: a token expiring as we speak is not worth a request.
      if (typeof credential.expires === "number" && credential.expires > Date.now() + 60_000) {
        access = nonEmptyString(credential.access) ? credential.access : null;
        return undefined;
      }
      if (!nonEmptyString(credential.refresh)) return undefined;
      // The signal is REQUIRED, not optional. Pi's Anthropic module combines it
      // with its own deadline through AbortSignal.any([signal, ...]), which
      // throws ERR_INVALID_ARG_TYPE on undefined before it ever reaches the
      // network, so omitting it failed every Claude refresh, which then read as
      // "session expired" and locked the account out of routing entirely.
      const next = await oauth.refresh!(credential, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
      access = nonEmptyString(next.access) ? next.access : null;
      refreshed = true;
      return next;
    });
    if (process.platform !== "win32") await chmod(paths.authFile, 0o600).catch(() => undefined);
    return { access, refreshed };
  };
  let outcome: { access: string | null; refreshed: boolean };
  try {
    outcome = await attempt();
  } catch (error) {
    if (provider !== "anthropic") throw error;
    // The refresh token Cora holds may have been rotated by Claude Code on
    // the same account. If the terminal copy is fresher, take it and try once
    // more before giving up.
    const repaired = await anthropicAccounts.reconcileProfile(profileId).catch(() => null);
    if (repaired?.wrote !== "pi") throw error;
    outcome = await attempt();
  }
  if (provider === "anthropic" && outcome.refreshed) {
    await anthropicAccounts.reconcileProfile(profileId).catch(() => null);
  }
  return outcome.access;
}

export async function deletePiSubscriptionProfile(
  rawProfileId: unknown,
  options: { ownershipGuard?: PiAccountProfileOwnershipGuard } = {},
): Promise<PiSubscriptionOverview> {
  const profileId = typeof rawProfileId === "string" ? rawProfileId : "";
  const inspection = await inspectPiAccountProfileAuthStore();
  const profile = inspection.snapshot.profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`Pi account profile not found: ${profileId}`);
  await deletePiAccountCredentialProfile(profile.id, options);
  const { invalidatePiSubscriptionUsageCache } = await import("./pi-subscription-usage");
  invalidatePiSubscriptionUsageCache();
  const { invalidatePiModelCatalogCache } = await import("./pi-model-catalog");
  invalidatePiModelCatalogCache();
  broadcastSubscriptionsChanged(profile.provider);
  return inspectPiSubscriptions();
}

export { renamePiAccountProfile, setDefaultPiAccountProfile };
