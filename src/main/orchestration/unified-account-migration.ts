import type { PiSubscriptionProvider } from "@shared/types";
import type { ClaudeAccountAdapter } from "./account-adapters/claude-account-adapter";
import { refreshActiveCliEnvPointer } from "./active-cli-env-pointer";
import type { ClaudeCliAccountProfileStore } from "./claude-cli-account-profiles";
import type { ClaudeCliCredentialBackend } from "./claude-cli-credentials";
import { undoLiveSlotSwap, type UndoLiveSlotSwapResult } from "./claude-live-slot-undo";
import type { CodexCliAccountProfileStore } from "./codex-cli-account-profiles";
import { ensureCodexCliAuthVault } from "./codex-cli-auth-selector";
import type { GrokCliAccountProfileStore } from "./grok-cli-account-profiles";
import { undoGrokLiveSlotSwap, type UndoGrokLiveSlotSwapResult } from "./grok-live-slot-undo";
import { setNativeClaudeProfileResolutionHooks } from "./native-claude-profile-runtime";
import { setNativeCodexProfileResolutionHooks } from "./native-codex-profile-runtime";
import { setNativeGrokProfileResolutionHooks } from "./native-grok-profile-runtime";
import { defaultPiAccountAuthStore, type PiAccountAuthStore } from "./pi-account-auth-store";
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
 * pre-pairing repair (Claude: undo the live-slot swap; Codex: ensure the
 * auth vault; Grok: undo the live-slot swap), clear dangling links, pair
 * halves, Account 1, repair defaults, start the mirror. Then the runtime
 * resolution hooks are installed and the gate resolves.
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
  beforePairing: UndoLiveSlotSwapResult | UndoGrokLiveSlotSwapResult | { active: string } | null;
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
    return result;
  }
  if (adapter.runtime === "codex") {
    const store = (deps.codexStore ?? adapter.store) as CodexCliAccountProfileStore;
    return { active: await ensureCodexCliAuthVault(store) };
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
    beforeFrozenProfile: async (profileId) => {
      await anthropic.reconcileCliProfile(profileId);
    },
    afterLeaseReleased: async (profileId) => {
      await anthropic.reconcileCliProfile(profileId);
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

/** Test seam: forget the process-wide gate so a suite can run the pass again. */
export function resetUnifiedAccountMigrationForTests(): void {
  readyPromise = null;
  setNativeClaudeProfileResolutionHooks(null);
  setNativeCodexProfileResolutionHooks(null);
  setNativeGrokProfileResolutionHooks(null);
}
