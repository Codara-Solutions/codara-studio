import { promises as fs } from "node:fs";
import type { PiSubscriptionProvider } from "@shared/types";
import { codaraHomeDir } from "./codara-managed-cli-roots";
import { refreshActiveCliEnvPointer } from "./active-cli-env-pointer";
import { migrateAccountsToV2, type AccountsV2MigrationResult } from "./accounts-v2-migration";
import type { ClaudeCliAccountProfileStore } from "./claude-cli-account-profiles";
import {
  claudeLoginKeeperDeps,
  renewClaudeLoginForCora,
  startClaudeLoginKeeper,
  type RefreshedAnthropicTokens,
} from "./claude-login-keeper";
import type { CodexCliAccountProfileStore } from "./codex-cli-account-profiles";
import type { GrokCliAccountProfileStore } from "./grok-cli-account-profiles";
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
import { readSystemLogin, type SystemLogin } from "./system-cli-login";
import {
  UNIFIED_ACCOUNT_PROVIDERS,
  unifiedAccountsFor,
} from "./unified-account-registry";
import type { UnifiedAccountService } from "./unified-accounts";

/**
 * The startup pass, run at every launch behind one ready gate that every
 * account IPC and socket handler and every CLI launch awaits. A failed step
 * logs and the rest still run; a failed pass still resolves the gate: the
 * app must never block on account housekeeping. Nothing in the pass
 * performs a network call, closes a session, reads the System login for
 * more than its identity, or writes anything outside Codara's home.
 *
 * Order: the one-time accounts v2 migration (accounts-v2-migration.ts),
 * then per provider: clear links to managed profiles that are gone, project
 * the Active row onto the CLI store (Claude: and into the live slot when it
 * lags), purge the homes of deleted accounts whose terminals have exited,
 * start the mirror. Then the shell pointer is rewritten, the runtime
 * resolution hooks are installed and the gate resolves. No step adds,
 * pairs or adopts an account: the list changes only through the user.
 */

export interface UnifiedAccountMigrationDeps {
  /** Test seam: services per provider; production uses the registry. */
  services?: Partial<Record<PiSubscriptionProvider, UnifiedAccountService>>;
  /** Providers to run, in order; production runs all three. */
  providers?: readonly PiSubscriptionProvider[];
  piStore?: PiAccountAuthStore;
  claudeStore?: ClaudeCliAccountProfileStore;
  codexStore?: CodexCliAccountProfileStore;
  grokStore?: GrokCliAccountProfileStore;
  /** Test seam: Codara's home, where the migration archive lives. */
  codaraHome?: string;
  /** Test seam: what each CLI is signed in as on this computer. */
  readSystemLogin?: (provider: PiSubscriptionProvider) => Promise<SystemLogin>;
  /** Test seam for the shell pointer write that ends the pass. */
  refreshShellPointer?: () => Promise<void>;
  log?: (message: string) => void;
}

export interface ProviderMigrationReport {
  clearedLinks: string[];
  purged: string[];
  watchedPairs: number;
  failedStep: string | null;
}

export interface UnifiedAccountMigrationReport {
  accountsV2: AccountsV2MigrationResult | null;
  providers: Partial<Record<PiSubscriptionProvider, ProviderMigrationReport>>;
  failedStep: string | null;
}

function emptyProviderReport(): ProviderMigrationReport {
  return { clearedLinks: [], purged: [], watchedPairs: 0, failedStep: null };
}

/** Runs every sub-step in order; a failing step is logged and the rest still run. */
export async function migrateUnifiedAccounts(
  deps: UnifiedAccountMigrationDeps = {},
): Promise<UnifiedAccountMigrationReport> {
  const piStore = deps.piStore ?? defaultPiAccountAuthStore();
  const log = deps.log ?? ((message: string) => console.warn(message));
  const providers = deps.providers ?? UNIFIED_ACCOUNT_PROVIDERS;
  const report: UnifiedAccountMigrationReport = { accountsV2: null, providers: {}, failedStep: null };
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
  const serviceFor = (provider: PiSubscriptionProvider) =>
    deps.services?.[provider] ?? unifiedAccountsFor(provider);

  await step("accounts-v2", async () => {
    report.accountsV2 = await migrateAccountsToV2({
      codaraHome: deps.codaraHome ?? codaraHomeDir(),
      registry: piStore.registry,
      piRootDir: piStore.rootDir,
      claudeStore:
        deps.claudeStore ?? (serviceFor("anthropic").adapter.store as ClaudeCliAccountProfileStore),
      codexStore:
        deps.codexStore ?? (serviceFor("openai-codex").adapter.store as CodexCliAccountProfileStore),
      grokStore: deps.grokStore ?? (serviceFor("xai").adapter.store as GrokCliAccountProfileStore),
      readSystemLogin: deps.readSystemLogin ?? ((provider) => readSystemLogin(provider)),
      log,
    });
  });
  for (const provider of providers) {
    const service = serviceFor(provider);
    const entry = emptyProviderReport();
    report.providers[provider] = entry;
    const named = (name: string) => `${provider}:${name}`;
    await step(
      named("clear-dangling-links"),
      async () => {
        entry.clearedLinks = await service.clearDanglingLinks();
      },
      entry,
    );
    await step(named("project-defaults"), () => service.reprojectDefaults(), entry);
    await step(
      named("purge-deleted-homes"),
      async () => {
        entry.purged = await service.purgePending();
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
 * starts on a freshly reconciled credential pair. A terminal that exits may
 * have been the last one holding a deleted account's home, which is then
 * purged.
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
    // Every managed Claude terminal ran on the live login, whichever
    // account it started on, so that is the pair to reconcile.
    afterLeaseReleased: async () => {
      await anthropic.reconcileDefault();
    },
  });
  const codex = serviceFor("openai-codex");
  setNativeCodexProfileResolutionHooks({
    ready: () => unifiedAccountsReady(),
    beforeNewProfile: async () => {
      await codex.reconcileDefault();
    },
    afterLeaseReleased: async (profileId) => {
      await codex.reconcileCliProfile(profileId);
      await codex.purgePending();
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
      await grok.purgePending();
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

/**
 * Cora's Anthropic refresh, made by Studio instead of by Pi (the bundled
 * extension routes Pi's refresh here over the agent socket). A linked
 * managed account renews through its Claude slot, so Claude Code, the
 * keeper and Cora share one refresher; a row whose Cora grant is its own
 * has no other holder and is simply refreshed. A borrowed copy of the
 * System login's grant is never refreshed: spending it could revoke the
 * user's own login.
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
  const row = await defaultPiAccountAuthStore().registry.getProfile(coraProfileId);
  if (row && (row.cora === "borrowed" || row.cora === "none")) {
    throw new Error("Cora's login for this account must be reconnected");
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
