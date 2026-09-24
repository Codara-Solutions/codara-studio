import { promises as fs } from "node:fs";
import type { PiSubscriptionProvider } from "@shared/types";
import type { ClaudeAccountAdapter } from "./account-adapters/claude-account-adapter";
import { refreshActiveCliEnvPointer } from "./active-cli-env-pointer";
import type { ClaudeCliAccountProfileStore } from "./claude-cli-account-profiles";
import type { ClaudeCliCredentialBackend } from "./claude-cli-credentials";
import {
  migrateClaudeToOneHome,
  type MigrateClaudeToOneHomeResult,
} from "./claude-cli-live-login";
import { undoLiveSlotSwap, type UndoLiveSlotSwapResult } from "./claude-live-slot-undo";
import {
  claudeLoginKeeperDeps,
  renewClaudeLoginForCora,
  startClaudeLoginKeeper,
  type RefreshedAnthropicTokens,
} from "./claude-login-keeper";
import type { CodexCliAccountProfileStore } from "./codex-cli-account-profiles";
import {
  ensureCodexCliAuthVault,
  retireSupersededCodexPersonalLogin,
} from "./codex-cli-auth-selector";
import type { GrokCliAccountProfileStore } from "./grok-cli-account-profiles";
import { undoGrokLiveSlotSwap, type UndoGrokLiveSlotSwapResult } from "./grok-live-slot-undo";
import {
  nativeClaudeProfileStore,
  setNativeClaudeProfileResolutionHooks,
} from "./native-claude-profile-runtime";
import { setNativeCodexProfileResolutionHooks } from "./native-codex-profile-runtime";
import { setNativeGrokProfileResolutionHooks } from "./native-grok-profile-runtime";
import { loadPiAuthStorage, type PiOAuthCredential } from "./pi-auth-storage";
import {
  codaraPiAccountRootDir,
  defaultPiAccountAuthStore,
  piAccountProfilePaths,
  type PiAccountAuthStore,
} from "./pi-account-auth-store";
import {
  UNIFIED_ACCOUNT_PROVIDERS,
  unifiedAccountsFor,
} from "./unified-account-registry";
import type { UnifiedAccountService } from "./unified-accounts";

/**
 * The idempotent startup pass that turns whatever an earlier Studio left on
 * disk into the unified two-halves model for every provider, run at every
 * launch behind one ready gate that every account IPC and socket handler and
 * every CLI launch awaits. Each sub-step re-derives its state from disk, so
 * a crash at any point is finished by the next launch and no marker file is
 * needed. A failed step logs and the rest still run; a failed pass still
 * resolves the gate: the app must never block on account housekeeping.
 * Nothing in the pass performs a network call or closes a session.
 *
 * Order: the legacy fold once (pi-agent/auth.json into per-profile files),
 * then per provider (anthropic, openai-codex, xai): the provider's own
 * pre-pairing repair (Claude: undo the retired selector's swap, then move
 * every account directory into the one home; Codex: ensure the auth vault;
 * Grok: undo the live-slot swap), clear dangling links, pair halves,
 * Account 1, repair defaults (which also puts the default account's login in
 * the live slot), start the mirror. Then the runtime resolution hooks are
 * installed and the gate resolves.
 */

export interface UnifiedAccountMigrationDeps {
  /** Test seam: services per provider; production uses the registry. */
  services?: Partial<Record<PiSubscriptionProvider, UnifiedAccountService>>;
  /** Providers to run, in order; production runs all three. */
  providers?: readonly PiSubscriptionProvider[];
  piStore?: PiAccountAuthStore;
  claudeStore?: ClaudeCliAccountProfileStore;
  backend?: ClaudeCliCredentialBackend;
  codexStore?: CodexCliAccountProfileStore;
  grokStore?: GrokCliAccountProfileStore;
  /** Test seam for the shell pointer write that ends the pass. */
  refreshShellPointer?: () => Promise<void>;
  log?: (message: string) => void;
}

export interface ProviderMigrationReport {
  /** The provider's pre-pairing repair result (undo or vault), if it ran. */
  beforePairing:
    | (UndoLiveSlotSwapResult & { oneHome: MigrateClaudeToOneHomeResult })
    | UndoGrokLiveSlotSwapResult
    | { active: string }
    | null;
  clearedLinks: string[];
  paired: Array<{ coraProfileId: string; cliProfileId: string; by: "fingerprint" | "email" }>;
  accountOne: string | null;
  watchedPairs: number;
  failedStep: string | null;
}

export interface UnifiedAccountMigrationReport {
  providers: Partial<Record<PiSubscriptionProvider, ProviderMigrationReport>>;
  failedStep: string | null;
}

function emptyProviderReport(): ProviderMigrationReport {
  return {
    beforePairing: null,
    clearedLinks: [],
    paired: [],
    accountOne: null,
    watchedPairs: 0,
    failedStep: null,
  };
}

async function beforePairing(
  service: UnifiedAccountService,
  deps: UnifiedAccountMigrationDeps,
  log: (message: string) => void,
): Promise<ProviderMigrationReport["beforePairing"]> {
  const { adapter } = service;
  if (adapter.runtime === "claude") {
    const store = (deps.claudeStore ?? adapter.store) as ClaudeCliAccountProfileStore;
    const backend = deps.backend ?? (adapter as ClaudeAccountAdapter).credentialBackend;
    const result = await undoLiveSlotSwap({
      claudeRootDir: store.rootDir,
      personalConfigDir: store.personalConfigDir,
      personalConfigDirEnv: store.personalConfigDirEnv,
      managedProfileExists: async (profileId) =>
        (await store.snapshot()).profiles.some((profile) => profile.id === profileId),
      ...(backend ? { backend } : {}),
      log,
    });
    if (result.restoredFrom || result.retiredVaultDir) {
      log(
        `[accounts] retired the Claude login vault${
          result.restoredFrom ? " and returned ~/.claude to the personal login" : ""
        }`,
      );
    }
    // Every account now runs in the one Claude home: each account
    // directory's login becomes its vault and its MCP grants and projects
    // join the home, before pairing reads any identity.
    const snapshot = await store.snapshot();
    const oneHome = await migrateClaudeToOneHome({
      store,
      managedProfileIds: snapshot.profiles.map((profile) => profile.id),
      defaultProfileId: snapshot.defaultProfileId,
      log,
    });
    return { ...result, oneHome };
  }
  if (adapter.runtime === "codex") {
    const store = (deps.codexStore ?? adapter.store) as CodexCliAccountProfileStore;
    const active = await ensureCodexCliAuthVault(store);
    const piStore = deps.piStore ?? defaultPiAccountAuthStore();
    await retireSupersededCodexPersonalLogin(
      store,
      (await store.snapshot()).profiles.map((profile) => profile.id),
      {
        personalHasRow: async () =>
          Boolean(await piStore.registry.profileForCliProfileId("openai-codex", "personal")),
        log,
      },
    );
    return { active };
  }
  const store = (deps.grokStore ?? adapter.store) as GrokCliAccountProfileStore;
  const result = await undoGrokLiveSlotSwap({
    grokRootDir: store.rootDir,
    personalHomeDir: store.personalHomeDir,
    managedProfileExists: async (profileId) =>
      (await store.snapshot()).profiles.some((profile) => profile.id === profileId),
    log,
  });
  if (result.restoredFrom || result.personalRestored || result.retiredVaultDir) {
    log(
      `[accounts] retired the Grok login vault${
        result.restoredFrom ? " and returned ~/.grok to the personal login" : ""
      }`,
    );
  }
  return result;
}

/** Runs every sub-step in order; a failing step is logged and the rest still run. */
export async function migrateUnifiedAccounts(
  deps: UnifiedAccountMigrationDeps = {},
): Promise<UnifiedAccountMigrationReport> {
  const piStore = deps.piStore ?? defaultPiAccountAuthStore();
  const log = deps.log ?? ((message: string) => console.warn(message));
  const providers = deps.providers ?? UNIFIED_ACCOUNT_PROVIDERS;
  const report: UnifiedAccountMigrationReport = { providers: {}, failedStep: null };
  const step = async (
    name: string,
    run: () => Promise<void>,
    provider?: ProviderMigrationReport,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      report.failedStep ??= name;
      if (provider) provider.failedStep ??= name;
      log(
        `[accounts] migration step "${name}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  await step("legacy-fold", async () => {
    await piStore.inspect();
  });
  for (const provider of providers) {
    const service = deps.services?.[provider] ?? unifiedAccountsFor(provider);
    const entry = emptyProviderReport();
    report.providers[provider] = entry;
    const named = (name: string) => `${provider}:${name}`;
    await step(
      named("before-pairing"),
      async () => {
        entry.beforePairing = await beforePairing(service, deps, log);
      },
      entry,
    );
    await step(
      named("clear-dangling-links"),
      async () => {
        entry.clearedLinks = await service.clearDanglingLinks();
      },
      entry,
    );
    await step(
      named("pair-halves"),
      async () => {
        entry.paired = await service.pairHalves();
      },
      entry,
    );
    await step(
      named("account-one"),
      async () => {
        entry.accountOne = (await service.ensureAccountOne())?.id ?? null;
      },
      entry,
    );
    await step(
      named("repair-defaults"),
      async () => {
        await service.repairDefaults();
      },
      entry,
    );
    await step(
      named("start-mirror"),
      async () => {
        entry.watchedPairs = (await service.startMirror()).length;
      },
      entry,
    );
  }
  // Running plain shells follow the pointer; a fresh one after the pass
  // makes a shell that outlived a previous Studio converge on this default.
  await step("shell-pointer", async () => {
    await (deps.refreshShellPointer ?? refreshActiveCliEnvPointer)();
  });
  return report;
}

let readyPromise: Promise<void> | null = null;

/**
 * Every Claude, Codex and Grok terminal launch waits for the pass and
 * starts on a freshly reconciled credential pair; a Codex launch also
 * re-activates a marker that lags the store default.
 */
function installResolutionHooks(deps: UnifiedAccountMigrationDeps): void {
  const serviceFor = (provider: PiSubscriptionProvider) =>
    deps.services?.[provider] ?? unifiedAccountsFor(provider);
  const anthropic = serviceFor("anthropic");
  setNativeClaudeProfileResolutionHooks({
    ready: () => unifiedAccountsReady(),
    beforeNewProfile: async () => {
      await anthropic.reconcileDefault();
    },
    // Every Claude terminal ran on the live login, whichever account it
    // started on, so that is the pair to reconcile.
    afterLeaseReleased: async () => {
      await anthropic.reconcileDefault();
    },
  });
  const codex = serviceFor("openai-codex");
  setNativeCodexProfileResolutionHooks({
    ready: () => unifiedAccountsReady(),
    beforeNewProfile: async () => {
      await codex.reconcileDefault();
      await codex.alignActive().catch(() => undefined);
    },
    afterLeaseReleased: async (profileId) => {
      await codex.reconcileCliProfile(profileId);
    },
  });
  const grok = serviceFor("xai");
  setNativeGrokProfileResolutionHooks({
    ready: () => unifiedAccountsReady(),
    beforeNewProfile: async () => {
      await grok.reconcileDefault();
    },
    beforeFrozenProfile: async (profileId) => {
      await grok.reconcileCliProfile(profileId);
    },
    afterLeaseReleased: async (profileId) => {
      await grok.reconcileCliProfile(profileId);
    },
  });
}

/**
 * Kick off the pass once per process. Every account handler awaits
 * unifiedAccountsReady(), so no caller observes a half-migrated store; the
 * promise resolves even when the pass failed.
 */
export function startUnifiedAccountMigration(
  deps: UnifiedAccountMigrationDeps = {},
): Promise<void> {
  if (readyPromise) return readyPromise;
  installResolutionHooks(deps);
  readyPromise = migrateUnifiedAccounts(deps).then(
    () => undefined,
    (error) => {
      (deps.log ?? console.warn)(
        `[accounts] migration pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  return readyPromise;
}

export function unifiedAccountsReady(): Promise<void> {
  return readyPromise ?? Promise.resolve();
}

/**
 * Studio's one refresher for the live Claude login (claude-login-keeper.ts),
 * started once the pass has settled which login is live.
 */
export function startStudioClaudeLoginKeeper(): void {
  void unifiedAccountsReady().then(() => {
    startClaudeLoginKeeper({
      store: nativeClaudeProfileStore,
      refresh: async (refreshToken, signal) =>
        (await import("./pi-subscription-auth")).refreshAnthropicOAuthToken(refreshToken, signal),
      afterChange: async () => {
        await unifiedAccountsFor("anthropic").reconcileDefault();
      },
      log: (message) => console.warn(message),
    });
  });
}

/** CLIs whose terminal sign-ins are followed (Grok keeps one home per account). */
const NATIVE_LOGIN_PROVIDERS = ["anthropic", "openai-codex"] as const;
const NATIVE_LOGIN_FOLLOW_INTERVAL_MS = 60 * 1000;
let nativeLoginTimer: NodeJS.Timeout | null = null;

/**
 * One pass of following sign-ins made in terminals: a `/login` or `codex
 * login` as another account Codara knows makes that account the Active one.
 */
export async function followNativeLogins(): Promise<void> {
  await unifiedAccountsReady();
  for (const provider of NATIVE_LOGIN_PROVIDERS) {
    await unifiedAccountsFor(provider)
      .followNativeLogin()
      .catch(() => null);
  }
}

/** Follow terminal sign-ins once a minute while Studio runs. */
export function startNativeLoginFollower(): void {
  if (nativeLoginTimer) return;
  nativeLoginTimer = setInterval(() => {
    void followNativeLogins();
  }, NATIVE_LOGIN_FOLLOW_INTERVAL_MS);
  nativeLoginTimer.unref?.();
  void followNativeLogins();
}

/**
 * Cora's Anthropic refresh, made by Studio instead of by Pi (the bundled
 * extension routes Pi's refresh here over the agent socket). A linked
 * account renews through its Claude slot, so Claude Code, the keeper and
 * Cora share one refresher; a Cora-only account has no other holder and is
 * simply refreshed.
 */
export async function renewCoraAnthropicLogin(
  coraProfileId: string,
  heldRefreshToken: string,
  options: { provePossession?: boolean } = {},
): Promise<RefreshedAnthropicTokens> {
  // No wait for the startup pass here: the caller holds Pi's lock on this
  // account's store, which the pass may itself be waiting for. Before the
  // keeper starts, the renewal is a plain refresh of Cora's own token.
  if (options.provePossession) {
    // A socket caller shows the refresh token Cora's store holds for the
    // account (the Pi process asking has just read it under its lock), so
    // the socket never hands a login to a caller that did not already hold it.
    const { authFile } = piAccountProfilePaths(codaraPiAccountRootDir(), coraProfileId);
    const stored = await fs
      .readFile(authFile, "utf8")
      .then((raw) => (JSON.parse(raw) as { anthropic?: { refresh?: unknown } }).anthropic?.refresh)
      .catch(() => undefined);
    if (!heldRefreshToken || stored !== heldRefreshToken) {
      throw new Error("the refresh token does not match this account's Cora login");
    }
  }
  const pair = await unifiedAccountsFor("anthropic").pairFor(coraProfileId);
  const deps = claudeLoginKeeperDeps();
  let tokens: RefreshedAnthropicTokens;
  if (pair && deps) {
    const renewal = await renewClaudeLoginForCora(deps, pair.cliProfileId, heldRefreshToken, {
      ...(pair.identityFingerprint ? { expectedFingerprint: pair.identityFingerprint } : {}),
    });
    if (renewal.outcome === "adopted") return renewal.tokens;
    tokens = renewal.tokens;
  } else {
    const { refreshAnthropicOAuthToken } = await import("./pi-subscription-auth");
    tokens = await refreshAnthropicOAuthToken(heldRefreshToken, AbortSignal.timeout(20_000));
  }
  storeRenewalIfAbandoned(coraProfileId, heldRefreshToken, tokens);
  return tokens;
}

/**
 * Pi stores a renewal under its own lock once Studio answers. Pi bounds the
 * wait (15 seconds since 0.87), and a Claude Code refresh in flight or a
 * slow grant can outlast it: Pi then gives up with only the token Studio
 * just spent in its store, and the account would stay signed out. So once
 * Pi lets go of its lock, a store that still holds the token Cora asked
 * with takes the renewal; one Pi wrote (or that changed otherwise) is left
 * alone.
 */
function storeRenewalIfAbandoned(
  coraProfileId: string,
  heldRefreshToken: string,
  tokens: RefreshedAnthropicTokens,
): void {
  if (!heldRefreshToken) return;
  void (async () => {
    const { authFile } = piAccountProfilePaths(defaultPiAccountAuthStore().rootDir, coraProfileId);
    const AuthStorage = await loadPiAuthStorage();
    await AuthStorage.create(authFile).modify("anthropic", async (current) => {
      const record = current as PiOAuthCredential | undefined;
      if (record?.type !== "oauth" || record.refresh !== heldRefreshToken) return undefined;
      return { ...record, access: tokens.access, refresh: tokens.refresh, expires: tokens.expires };
    });
  })().catch(() => undefined);
}

/** Test seam: forget the process-wide gate so a suite can run the pass again. */
export function resetUnifiedAccountMigrationForTests(): void {
  readyPromise = null;
  setNativeClaudeProfileResolutionHooks(null);
  setNativeCodexProfileResolutionHooks(null);
  setNativeGrokProfileResolutionHooks(null);
}
