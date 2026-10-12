import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { BrowserWindow, shell, type WebContents } from "electron";
import { credentialMirror } from "./credential-mirror";
import { loadPiAuthStorage } from "./pi-auth-storage";
import {
  terminalStatusesByProvider,
  unifiedAccountsFor,
} from "./unified-account-registry";
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
import { resolveCodaraPiLibrary, resolveUserPiRuntime } from "./pi-runtime-electron";
import { CODARA_PI_MIN_VERSION, CODARA_PI_VERSION, resolvePiAiModulePath } from "./pi-runtime";
import { installPiCli, isPiCliInstalling } from "./pi-runtime-install";
import {
  deletePiAccountCredentialProfile,
  inspectPiAccountProfileAuthStore,
  piAccountCredentialAccountEmail,
  piAccountCredentialIdentityFingerprint,
  preparePiAccountCredentialTarget,
  renamePiAccountProfile,
  resolvePiAccountRuntimeProfile,
  setDefaultPiAccountProfile,
  PiOAuthLoginGate,
} from "./pi-account-auth-store";
import { SYSTEM_CLI_PROFILE_ID } from "./pi-account-profiles";
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
  owner: PiSubscriptionAuthOwner;
  abort: AbortController;
  releaseLoginGate: () => void;
  pendingPrompt: {
    promptId: string;
    resolve(value: string): void;
    reject(error: Error): void;
    removeAbortListener(): void;
  } | null;
  /** The started event and the newest browser/code/prompt step, replayed to a
   * Settings panel that lost the flow (tab switch, dialog closed). */
  startedEvent: PiSubscriptionAuthEvent;
  lastInteraction: PiSubscriptionAuthEvent | null;
  /** Set only by an explicit cancel, so a provider's own "aborted" timeout
   * text is never mistaken for one. */
  userCancelled: boolean;
  /** Why the app stopped the flow itself (stall, overall timeout, a browser
   * that would not open). Wins over whatever the aborted login throws. */
  failureReason?: string;
  /** A newer sign-in from the same owner replaced this one; it ends silently. */
  superseded: boolean;
  finalized: boolean;
  finished: Promise<void>;
  markFinished: () => void;
  timers: ReturnType<typeof setTimeout>[];
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
/** Pi refreshes five minutes ahead; one more covers a short child's run. */
const REFRESH_HEADROOM_MS = 6 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;

const activeFlows = new Map<string, ActiveFlow>();
const oauthLoginGate = new PiOAuthLoginGate();

const loginTiming = {
  /** No sign-in URL or prompt by now means Pi is wedged (a held port). */
  stallMs: 45_000,
  /** A browser sign-in the user walked away from must not hold the
   * process-wide gate forever; Pi's Anthropic flow has no deadline of its own. */
  flowMs: 10 * 60 * 1000,
  /** How long a stopped flow may take to unwind before it is released anyway,
   * for a provider module that ignores its abort signal. */
  graceMs: 5_000,
};

export function setPiLoginTimingForTests(timing: Partial<typeof loginTiming>): void {
  Object.assign(loginTiming, timing);
}

const LOGIN_GATE_BUSY_MESSAGE =
  "Another sign-in is already in progress in another Codara Studio window or in the cora CLI. Finish it in your browser or cancel it there, then try again.";

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

/**
 * What a failed sign-in tells the user. Pi's errors carry request details and
 * stack frames that mean nothing to them, so known causes get a plain next
 * step and anything else is cut before its diagnostic tail. The console keeps
 * the raw text.
 */
export function friendlyPiSignInError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/EADDRINUSE/i.test(raw)) {
    return "Another app is using the sign-in port. Close other Codara Studio windows or builds and try again.";
  }
  if (/token exchange/i.test(raw) && /status=4\d\d\b/i.test(raw)) {
    return "The sign-in code expired or was already used. Start the sign-in again.";
  }
  if (/TimeoutError|ETIMEDOUT|timed out/i.test(raw)) {
    return "The provider took too long to answer. Check your connection and try again.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed/i.test(raw)) {
    return "Codara Studio could not reach the provider. Check your connection and try again.";
  }
  const head = raw
    .split(/\n\s+at\s/)[0]
    .split(/;?\s*\b(?:url|redirect_uri|response_type|body|details|cause|stack)=/i)[0]
    .trim();
  return safeAuthError(head) || "The sign-in failed. Try again.";
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
  void provider;
  credentialMirror.rearm();
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
  // Sign-in runs in this process through the bundled Pi, never the user's install.
  const runtime = await resolveCodaraPiLibrary();
  const meta = PROVIDER_META[provider];
  // Never assume where pi-ai lives relative to pi-coding-agent: the packaged
  // app hoists it to the top-level node_modules, a dev tree nests it.
  const modulePath = await resolvePiAiModulePath(
    runtime.packageRoot,
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

/**
 * One Anthropic refresh grant through the pinned Pi's own module, for the
 * Claude login keeper: the same client and endpoint Cora refreshes with.
 */
export async function refreshAnthropicOAuthToken(
  refreshToken: string,
  signal: AbortSignal,
): Promise<{ access: string; refresh: string; expires: number }> {
  const oauth = await loadOAuth("anthropic");
  if (typeof oauth.refresh !== "function") {
    throw new Error("Pinned Pi cannot refresh an Anthropic login");
  }
  const next = await oauth.refresh(
    { type: "oauth", access: "", refresh: refreshToken, expires: 0 },
    signal,
  );
  return { access: next.access, refresh: next.refresh, expires: next.expires };
}

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
  const [runtimeResult, inspection, terminals, systemOffers] = await Promise.all([
    // The user's own Pi runs Cora once installed; until then the bundled
    // build does, and the reason the user's is not used is shown beside the
    // Install Pi suggestion.
    resolveUserPiRuntime()
      .then((runtime) => ({
        installed: true as const,
        version: runtime.version,
        source: "user" as const,
        error: undefined,
      }))
      .catch((userError: unknown) =>
        resolveCodaraPiLibrary()
          .then((runtime) => ({
            installed: true as const,
            version: runtime.version,
            source: "bundled" as const,
            error: safeAuthError(userError),
          }))
          .catch((error: unknown) => ({
            installed: false as const,
            version: null,
            source: undefined,
            error: safeAuthError(error),
          })),
      ),
    inspectPiAccountProfileAuthStore(),
    terminalStatusesByProvider(),
    Promise.all(
      PI_SUBSCRIPTION_PROVIDERS.map(
        async (provider) =>
          [provider, await unifiedAccountsFor(provider).systemOffer().catch(() => null)] as const,
      ),
    ).then((entries) =>
      Object.fromEntries(entries.filter(([, offer]) => offer !== null)) as NonNullable<
        PiSubscriptionOverview["systemOffers"]
      >,
    ),
  ]);
  const statuses = new Map(inspection.statuses.map((status) => [status.profileId, status]));
  const profiles: PiSubscriptionProfileConnection[] = inspection.snapshot.profiles.map((profile) => {
    const status = statuses.get(profile.id);
    // The registry digest is authoritative; the credential read backfills
    // accounts connected before the registry recorded one. Only the hash
    // crosses IPC; the account id it was taken from stays in this process.
    const accountFingerprint = profile.identityFingerprint ?? status?.accountFingerprint;
    // The registry address was captured at connect time (Anthropic); the
    // credential read covers Codex, whose token carries its own claims.
    const email = profile.accountEmail ?? status?.accountEmail;
    // The CLI half is projected as status only: which id it is, and whether
    // it is signed in. Its directory and tokens stay in main.
    const cliProfileId = profile.cliProfileId;
    const terminal = cliProfileId ? terminals.get(profile.provider)?.get(cliProfileId) : undefined;
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
      ...(cliProfileId === SYSTEM_CLI_PROFILE_ID ? { builtIn: true as const } : {}),
      coraHalf: profile.cora,
      ...(terminal ? { terminal } : {}),
    };
  });
  const connections = PI_SUBSCRIPTION_PROVIDERS.map((provider) =>
    compatibilityConnection(provider, profiles),
  );
  return {
    runtimeInstalled: runtimeResult.installed,
    runtimeVersion: runtimeResult.version,
    ...(runtimeResult.source ? { runtimeSource: runtimeResult.source } : {}),
    ...(runtimeResult.error ? { runtimeError: runtimeResult.error } : {}),
    runtimeExpectedVersion: CODARA_PI_MIN_VERSION,
    runtimeTestedVersion: CODARA_PI_VERSION,
    ...(isPiCliInstalling() ? { runtimeInstalling: true } : {}),
    connections,
    profiles,
    ...(Object.keys(systemOffers).length > 0 ? { systemOffers } : {}),
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
  emit({ type: "started", message: "Installing Pi..." });
  try {
    const version = await installPiCli(({ message }) => {
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

function flowTimer(flow: ActiveFlow, ms: number, fn: () => void): void {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  flow.timers.push(timer);
}

/**
 * Release everything a flow holds, exactly once: its timers, its prompt, its
 * entry in activeFlows and the process-wide login gate. The closing event goes
 * out after the gate is free, so an owner reacting to it can start again.
 */
function finalizeFlow(flow: ActiveFlow, event: PiSubscriptionAuthEvent | null): void {
  if (flow.finalized) return;
  flow.finalized = true;
  for (const timer of flow.timers) clearTimeout(timer);
  settlePendingPrompt(flow, new Error("Login finished"));
  if (activeFlows.get(flow.requestId) === flow) activeFlows.delete(flow.requestId);
  flow.releaseLoginGate();
  flow.markFinished();
  if (event && !flow.superseded) send(flow.owner, event);
}

function stoppedFlowEvent(flow: ActiveFlow, error: unknown): PiSubscriptionAuthEvent {
  const { requestId, provider } = flow;
  if (flow.userCancelled) {
    return { type: "cancelled", requestId, provider, message: "Sign-in cancelled." };
  }
  return {
    type: "failed",
    requestId,
    provider,
    message: flow.failureReason ?? friendlyPiSignInError(error),
  };
}

/**
 * Stop a flow from outside its login call: a cancel, a stall, the overall
 * deadline, a superseding sign-in. The abort normally makes the login reject
 * and runLogin finalizes with the right event; the grace timer covers a
 * provider module that ignores the abort and would otherwise hold the gate
 * until the app restarts.
 */
function stopFlow(
  flow: ActiveFlow,
  reason: { userCancelled: true } | { failureReason: string } | { superseded: true },
): void {
  if (flow.finalized) return;
  if ("userCancelled" in reason) flow.userCancelled = true;
  else if ("failureReason" in reason) flow.failureReason ??= reason.failureReason;
  else flow.superseded = true;
  flow.abort.abort();
  settlePendingPrompt(flow, new Error("Login cancelled"));
  flowTimer(flow, loginTiming.graceMs, () => {
    finalizeFlow(flow, stoppedFlowEvent(flow, new Error("Login cancelled")));
  });
}

function rememberInteraction(flow: ActiveFlow, event: PiSubscriptionAuthEvent): void {
  flow.lastInteraction = event;
  send(flow.owner, event);
}

/** Re-send what a freshly mounted panel needs to show this flow again. */
function replayFlow(flow: ActiveFlow): void {
  send(flow.owner, flow.startedEvent);
  const last = flow.lastInteraction;
  if (!last) return;
  // A prompt that was answered or withdrawn is not shown again.
  if (last.type === "prompt" && flow.pendingPrompt?.promptId !== last.promptId) return;
  send(flow.owner, last);
}

/**
 * The anonymous account digest and the account's email address to record for a
 * credential that has just been issued. Codex carries both inside the
 * credential, so they come straight out of it. Anthropic's credential is opaque
 * tokens, so its account uuid and address are read once here (the single
 * moment a fresh access token is in hand) from Anthropic's OAuth profile
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
  // One sign-in serves both halves: the CLI side is written from the
  // credential just received (Codex grows it through a refresh grant first).
  // Its failure is not the sign-in's failure; the card then offers Share.
  const service = unifiedAccountsFor(flow.provider);
  const canonical = service.codec.canonicalFromPi(credential);
  if (canonical) {
    // A row on the System login gets no copy: its terminals use the CLI's
    // own login, and the new grant is Cora's alone.
    await service.ensureCliHalf(target.profile.id, canonical, identity).catch((cliError) => {
      console.warn(
        `[accounts] ${service.adapter.labels.cliLabel} half for ${target.profile.id} could not be written (the account is signed in to Cora; the card offers Share): ${safeAuthError(cliError)}`,
      );
    });
  }
  if (flow.makeDefault) {
    // The credential is stored and the row registered; making the account
    // active is a separate step that may fail (the live slot cannot be
    // written). That does not undo the sign-in; the card offers Use.
    await service.useAccount(target.profile.id).catch((error: unknown) => {
      console.warn(
        `[accounts] ${target.profile.id} was connected but not made active: ${safeAuthError(error)}`,
      );
    });
  }
  // A newly connected subscription must not read its limits (or its model
  // catalog) through a cache populated while it was still disconnected.
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

async function runLogin(flow: ActiveFlow): Promise<void> {
  const { provider, requestId, owner } = flow;
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
  flowTimer(flow, loginTiming.stallMs, () => {
    if (sawLoginSignal || flow.abort.signal.aborted) return;
    stopFlow(flow, {
      failureReason:
        "The sign-in stalled before producing a login URL. Another app (or a second Codara Studio) may be holding the sign-in port. Close other instances and try again.",
    });
  });
  flowTimer(flow, loginTiming.flowMs, () => {
    stopFlow(flow, {
      failureReason: `The sign-in was not finished within ${Math.round(loginTiming.flowMs / 60_000)} minutes. Start it again when you are ready.`,
    });
  });
  try {
    const oauth = await loadOAuth(provider);
    // Own the loopback callback so the browser's last page is Codara's, not
    // Pi's. Only the OpenAI flow tolerates losing its own listener; see
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
        rememberInteraction(flow, {
          type: "prompt",
          requestId,
          promptId,
          provider,
          prompt: publicPrompt(prompt),
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
        // A stopped flow whose module ignores the abort may still report a
        // URL; it must neither open a browser nor take over the owner's panel,
        // which may already show the sign-in that replaced it.
        if (flow.abort.signal.aborted) return;
        markLoginSignal();
        if (event.type === "auth_url" && event.url) {
          // Pi's authorize URL carries the state its callback expects. Learning
          // it here, before the browser opens, lets Codara's listener reject
          // anything that is not this sign-in, exactly as Pi's own would.
          const state = oauthStateFromAuthUrl(event.url);
          if (state) callback?.expectState(state);
          rememberInteraction(flow, {
            type: "auth_url",
            requestId,
            provider,
            url: event.url,
            ...(event.instructions ? { instructions: event.instructions } : {}),
          });
          void openOAuthUrl(event.url).catch((error) => {
            stopFlow(flow, { failureReason: friendlyPiSignInError(error) });
          });
          return;
        }
        if (event.type === "device_code" && event.userCode && event.verificationUri) {
          rememberInteraction(flow, {
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
    // One sign-in wrote both halves, and the picker promised as much; the
    // completion line says the same thing.
    const completedMessage = `${familyForSubscription(provider).displayName} is signed in to Cora and ${unifiedAccountsFor(provider).adapter.labels.cliLabel}.`;
    callback?.close();
    finalizeFlow(flow, {
      type: "completed",
      requestId,
      provider,
      message: completedMessage,
      overview: await inspectPiSubscriptions(),
    });
    // The user finished in the browser; bring them back to the Settings window
    // that started this instead of leaving them to find Studio themselves.
    owner.focus?.();
  } catch (error) {
    callback?.close();
    if (!flow.userCancelled && !flow.superseded) {
      console.warn(`[pi-subscription-auth] ${provider} sign-in failed: ${safeAuthError(error)}`);
    }
    const alreadyClosed = flow.finalized;
    finalizeFlow(flow, stoppedFlowEvent(flow, error));
    // A cancel came from Studio, so the user is already here; a real failure
    // happened out in the browser and needs the window pulled back.
    if (!alreadyClosed && !flow.userCancelled && !flow.superseded) owner.focus?.();
  } finally {
    callback?.close();
    finalizeFlow(flow, null);
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

  // One owner shows one sign-in at a time. Asking again for the same account
  // re-shows the open flow (a remounted Settings panel lost its view of it);
  // asking for another one replaces the owner's own abandoned flow rather
  // than failing on the gate it still holds.
  for (const flow of [...activeFlows.values()]) {
    if (flow.ownerId !== owner.id) continue;
    if (flow.provider === provider && flow.targetProfileId === targetProfileId && !flow.abort.signal.aborted) {
      replayFlow(flow);
      return {
        requestId: flow.requestId,
        provider,
        ...(targetProfileId ? { targetProfileId } : {}),
      };
    }
    stopFlow(flow, { superseded: true });
    await flow.finished;
  }

  const requestId = randomUUID();
  // Pi's OAuth implementations bind fixed loopback callback ports. One
  // process-wide flow at a time prevents windows from racing those ports or
  // delivering one account's callback into another account's request.
  let releaseLoginGate: () => void;
  try {
    releaseLoginGate = oauthLoginGate.acquire(requestId);
  } catch {
    throw new Error(LOGIN_GATE_BUSY_MESSAGE);
  }
  try {
    let markFinished: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    const startedEvent: PiSubscriptionAuthEvent = {
      type: "started",
      requestId,
      provider,
      message: `Signing in to ${PROVIDER_META[provider].label}…`,
    };
    const flow: ActiveFlow = {
      requestId,
      provider,
      ...(targetProfileId ? { targetProfileId } : {}),
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      ...(input.makeDefault ? { makeDefault: true } : {}),
      ownerId: owner.id,
      owner,
      abort: new AbortController(),
      releaseLoginGate,
      pendingPrompt: null,
      startedEvent,
      lastInteraction: null,
      userCancelled: false,
      superseded: false,
      finalized: false,
      finished,
      markFinished,
      timers: [],
    };
    activeFlows.set(requestId, flow);
    send(owner, startedEvent);
    void runLogin(flow);
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

/**
 * Re-send the owner's open sign-in, if any, so a Settings panel mounted after
 * the one that started it (tab switch, dialog reopened) can show it again
 * and cancel it.
 */
export function resumePiSubscriptionLoginForOwner(
  owner: PiSubscriptionAuthOwner,
): PiSubscriptionProfileLoginRequest | null {
  for (const flow of activeFlows.values()) {
    if (flow.ownerId !== owner.id || flow.abort.signal.aborted) continue;
    replayFlow(flow);
    return {
      requestId: flow.requestId,
      provider: flow.provider,
      ...(flow.targetProfileId ? { targetProfileId: flow.targetProfileId } : {}),
    };
  }
  return null;
}

export function resumePiSubscriptionLogin(owner: WebContents): PiSubscriptionProfileLoginRequest | null {
  return resumePiSubscriptionLoginForOwner(webContentsAuthOwner(owner));
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

/**
 * Cancel one of the owner's sign-ins, or every one it has open when no request
 * id is given: a panel that has not learned its request id yet can still
 * cancel what it started.
 */
export function cancelPiSubscriptionLoginForOwner(
  rawRequestId: unknown,
  owner: PiSubscriptionAuthOwner,
): void {
  const requestId = typeof rawRequestId === "string" ? rawRequestId : "";
  for (const flow of [...activeFlows.values()]) {
    if (flow.ownerId !== owner.id) continue;
    if (requestId && flow.requestId !== requestId) continue;
    stopFlow(flow, { userCancelled: true });
  }
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
      // Headroom past Pi's own window (0.87 refreshes five minutes before its
      // stored expiry), so a Pi process handed this credential right after
      // never finds it due and refreshes it on its own.
      if (
        typeof credential.expires === "number" &&
        credential.expires > Date.now() + REFRESH_HEADROOM_MS
      ) {
        access = nonEmptyString(credential.access) ? credential.access : null;
        return undefined;
      }
      if (!nonEmptyString(credential.refresh)) return undefined;
      // A Claude login is renewed through its terminal slot, under Claude
      // Code's lock, like the refresh Cora's own processes ask Studio for.
      // Elsewhere the signal is REQUIRED, not optional: Pi's OAuth modules
      // combine it with their own deadline through AbortSignal.any([signal,
      // ...]), which throws ERR_INVALID_ARG_TYPE on undefined before it ever
      // reaches the network, so omitting it failed every refresh, which then
      // read as "session expired" and locked the account out of routing.
      const next: OAuthCredential =
        provider === "anthropic"
          ? {
              ...credential,
              ...(await (await import("./unified-account-migration")).renewCoraAnthropicLogin(
                profileId,
                credential.refresh,
              )),
            }
          : await oauth.refresh!(credential, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
      access = nonEmptyString(next.access) ? next.access : null;
      refreshed = true;
      return next;
    });
    if (process.platform !== "win32") await chmod(paths.authFile, 0o600).catch(() => undefined);
    return { access, refreshed };
  };
  const service = unifiedAccountsFor(provider);
  let outcome: { access: string | null; refreshed: boolean };
  try {
    outcome = await attempt();
  } catch (error) {
    // The refresh token Cora holds may have been rotated by the CLI on the
    // same account. If the terminal copy is fresher, take it and try once
    // more before giving up.
    const repaired = await service.reconcileProfile(profileId).catch(() => null);
    if (repaired?.wrote !== "pi") throw error;
    outcome = await attempt();
  }
  if (outcome.refreshed) {
    await service.reconcileProfile(profileId).catch(() => null);
  }
  return outcome.access;
}

export { renamePiAccountProfile, setDefaultPiAccountProfile };
