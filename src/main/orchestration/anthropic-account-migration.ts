import type { AnthropicAccountService } from "./anthropic-accounts";
import type { ClaudeCliAccountProfileStore } from "./claude-cli-account-profiles";
import type { ClaudeCliCredentialBackend } from "./claude-cli-credentials";
import type { UndoLiveSlotSwapResult } from "./claude-live-slot-undo";
import type { PiAccountAuthStore } from "./pi-account-auth-store";
import {
  migrateUnifiedAccounts,
  resetUnifiedAccountMigrationForTests,
  startUnifiedAccountMigration,
  unifiedAccountsReady,
} from "./unified-account-migration";

/**
 * The Anthropic names of the provider-generic startup pass, kept for the
 * callers wired before the pass served every provider. The Anthropic-only
 * entry points run the unified runner restricted to the anthropic provider.
 */

export { undoLiveSlotSwap } from "./claude-live-slot-undo";
export type {
  UndoLiveSlotSwapInput,
  UndoLiveSlotSwapResult,
} from "./claude-live-slot-undo";
export { unifiedAccountsReady };

export interface AnthropicAccountMigrationDeps {
  service?: AnthropicAccountService;
  piStore?: PiAccountAuthStore;
  claudeStore?: ClaudeCliAccountProfileStore;
  backend?: ClaudeCliCredentialBackend;
  log?: (message: string) => void;
}

export interface AnthropicAccountMigrationReport {
  liveSlot: UndoLiveSlotSwapResult | null;
  clearedLinks: string[];
  paired: Array<{ coraProfileId: string; cliProfileId: string; by: "fingerprint" | "email" }>;
  accountOne: string | null;
  watchedPairs: number;
  failedStep: string | null;
}

function unifiedDeps(deps: AnthropicAccountMigrationDeps) {
  return {
    providers: ["anthropic" as const],
    ...(deps.service ? { services: { anthropic: deps.service } } : {}),
    ...(deps.piStore ? { piStore: deps.piStore } : {}),
    ...(deps.claudeStore ? { claudeStore: deps.claudeStore } : {}),
    ...(deps.backend ? { backend: deps.backend } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  };
}

export async function migrateAnthropicAccounts(
  deps: AnthropicAccountMigrationDeps = {},
): Promise<AnthropicAccountMigrationReport> {
  const report = await migrateUnifiedAccounts(unifiedDeps(deps));
  const entry = report.providers.anthropic;
  return {
    liveSlot: (entry?.beforePairing as UndoLiveSlotSwapResult | null) ?? null,
    clearedLinks: entry?.clearedLinks ?? [],
    paired: entry?.paired ?? [],
    accountOne: entry?.accountOne ?? null,
    watchedPairs: entry?.watchedPairs ?? 0,
    failedStep: report.failedStep?.replace(/^anthropic:/, "") ?? null,
  };
}

export function startAnthropicAccountMigration(
  deps: AnthropicAccountMigrationDeps = {},
): Promise<void> {
  return startUnifiedAccountMigration(unifiedDeps(deps));
}

export function resetAnthropicAccountMigrationForTests(): void {
  resetUnifiedAccountMigrationForTests();
}
