import type { PiSubscriptionProvider } from "@shared/types";
import type { CliRuntime } from "./account-adapters/account-adapter";
import { claudeAccountAdapter } from "./account-adapters/claude-account-adapter";
import { codexAccountAdapter } from "./account-adapters/codex-account-adapter";
import { grokAccountAdapter } from "./account-adapters/grok-account-adapter";
import { UnifiedAccountService, type UnifiedTerminalStatus } from "./unified-accounts";

/**
 * The three unified account services, one per provider, and the lookups the
 * IPC, socket and Pi flows dispatch through. Every mutation of an account
 * goes through the service of its provider; nothing else writes a default
 * or a credential of either half.
 */

const log = (message: string): void => console.warn(message);

const defaultsChanged = async (): Promise<void> => {
  // Imported lazily: the pointer module reads the two profile stores, which
  // this registry's adapters also resolve, and a plain shell follows the
  // pointer rather than any service.
  const { refreshActiveCliEnvPointer } = await import("./active-cli-env-pointer");
  await refreshActiveCliEnvPointer();
};

export const anthropicAccounts = new UnifiedAccountService(claudeAccountAdapter, {
  log,
  defaultsChanged,
});
export const codexAccounts = new UnifiedAccountService(codexAccountAdapter, { log, defaultsChanged });
export const grokAccounts = new UnifiedAccountService(grokAccountAdapter, { log, defaultsChanged });

const services: Record<PiSubscriptionProvider, UnifiedAccountService> = {
  anthropic: anthropicAccounts as unknown as UnifiedAccountService,
  "openai-codex": codexAccounts as unknown as UnifiedAccountService,
  xai: grokAccounts as unknown as UnifiedAccountService,
};

/** Providers in the order the startup pass handles them. */
export const UNIFIED_ACCOUNT_PROVIDERS: readonly PiSubscriptionProvider[] = [
  "anthropic",
  "openai-codex",
  "xai",
];

export function unifiedAccountsFor(provider: PiSubscriptionProvider): UnifiedAccountService {
  const service = services[provider];
  if (!service) throw new TypeError(`Unsupported account provider: ${String(provider)}`);
  return service;
}

export function cliRuntimeFor(provider: PiSubscriptionProvider): CliRuntime {
  return unifiedAccountsFor(provider).adapter.runtime;
}

export function providerForRuntime(runtime: CliRuntime): PiSubscriptionProvider {
  for (const provider of UNIFIED_ACCOUNT_PROVIDERS) {
    if (services[provider].adapter.runtime === runtime) return provider;
  }
  throw new TypeError(`Unsupported CLI runtime: ${String(runtime)}`);
}

/**
 * Token-blind terminal status of every CLI profile, keyed by provider and
 * then by CLI profile id ("personal" exists once per provider, so a flat map
 * would collide). A provider whose inspection fails contributes nothing.
 */
export async function terminalStatusesByProvider(): Promise<
  Map<PiSubscriptionProvider, Map<string, UnifiedTerminalStatus>>
> {
  const entries = await Promise.all(
    UNIFIED_ACCOUNT_PROVIDERS.map(async (provider) => {
      const statuses = await services[provider]
        .terminalStatuses()
        .catch(() => new Map<string, UnifiedTerminalStatus>());
      return [provider, statuses] as const;
    }),
  );
  return new Map(entries);
}
