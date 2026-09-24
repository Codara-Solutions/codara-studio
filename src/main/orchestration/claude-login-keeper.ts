import {
  claudeLiveHome,
  claudeLiveLoginRecord,
  readClaudeLiveProfileId,
  readClaudeProfileLogin,
  withClaudeSelectionLock,
  writeClaudeProfileLogin,
  type ClaudeLoginSlotStore,
} from "./claude-cli-live-login";
import {
  readClaudeCredentialStores,
  updateClaudeCredentialStores,
  withClaudeCodeRefreshLock,
  type ClaudeCredentialRecord,
  type ClaudeCredentialStoreOptions,
} from "./claude-cli-credentials";

/**
 * One refresher for the live Claude login.
 *
 * Anthropic rotates the refresh token on every refresh, so only one holder of
 * a login can refresh it; any other copy is spent the moment it does. Claude
 * Code refreshes five minutes before expiry, and so does Pi (it stores the
 * expiry minus five minutes and refreshes once that passes): two refreshers
 * of one login, due at the same instant. The loser holds a spent token, and
 * Claude Code answers that by blanking its login on disk.
 *
 * The keeper refreshes the live login earlier than either, under Claude
 * Code's own refresh lock and with its compare-and-swap on the refresh
 * token, so neither finds it due while Studio runs. Running sessions adopt
 * the new token the next time they check (their access token no longer
 * matches the store), and the credential mirror carries it to Cora.
 */

export const CLAUDE_LOGIN_KEEPER_LEAD_MS = 15 * 60 * 1000;
const KEEPER_INTERVAL_MS = 60 * 1000;
const REFRESH_TIMEOUT_MS = 20_000;
/** Pi reports expiry minus its own five minutes; Claude Code stores the raw one. */
const PI_EXPIRY_PADDING_MS = 5 * 60 * 1000;

export interface RefreshedAnthropicTokens {
  access: string;
  refresh: string;
  /** Pi's expiry: the raw expiry minus five minutes. */
  expires: number;
}

export interface ClaudeLoginKeeperDeps extends ClaudeCredentialStoreOptions {
  store: ClaudeLoginSlotStore;
  /** The OAuth refresh grant; production uses the pinned Pi's Anthropic module. */
  refresh: (refreshToken: string, signal: AbortSignal) => Promise<RefreshedAnthropicTokens>;
  /** Carry a changed login to Cora; production reconciles the default pair. */
  afterChange?: () => Promise<void>;
  now?: () => number;
  leadMs?: number;
  /** How long to wait for a Claude Code refresh already in flight. */
  refreshLockRetries?: number;
  log?: (message: string) => void;
}

export type ClaudeLoginKeeperOutcome =
  | "no-login"
  | "not-due"
  | "adopted"
  | "refreshed"
  | "busy"
  | "failed";

function isDue(record: ClaudeCredentialRecord, now: number, leadMs: number): boolean {
  return record.expiresAt > 0 && record.expiresAt - now <= leadMs;
}

/**
 * Refresh the live login when it is due within the lead time. Idempotent and
 * safe to call from anywhere: a login another process refreshed meanwhile is
 * adopted rather than refreshed again, and a failed grant changes nothing.
 */
export async function refreshLiveClaudeLoginIfDue(
  deps: ClaudeLoginKeeperDeps,
): Promise<ClaudeLoginKeeperOutcome> {
  const now = deps.now ?? Date.now;
  const leadMs = deps.leadMs ?? CLAUDE_LOGIN_KEEPER_LEAD_MS;
  const storeOptions: ClaudeCredentialStoreOptions = deps.fileOnly ? { fileOnly: true } : {};
  const liveId = await readClaudeLiveProfileId(deps.store.rootDir).catch(() => null);
  if (liveId === null) return "no-login";
  const seen = await readClaudeProfileLogin(deps.store, liveId, storeOptions);
  if (seen.kind !== "login" || !seen.record?.refreshToken) return "no-login";
  if (!isDue(seen.record, now(), leadMs)) return "not-due";

  const home = claudeLiveHome(deps.store);
  let outcome: ClaudeLoginKeeperOutcome;
  try {
    outcome = await withClaudeSelectionLock(deps.store.rootDir, () =>
      withClaudeCodeRefreshLock(
        home.configDir,
        async () => {
          // A switch may have landed while this waited for the lock.
          if ((await readClaudeLiveProfileId(deps.store.rootDir)) !== liveId) return "adopted";
          const stores = await readClaudeCredentialStores(home.configDir, home.configDirEnv, storeOptions);
          const current = claudeLiveLoginRecord(stores);
          if (!current?.refreshToken) return "no-login";
          if (current.refreshToken !== seen.record!.refreshToken) return "adopted";
          if (!isDue(current, now(), leadMs)) return "not-due";
          let tokens: RefreshedAnthropicTokens;
          try {
            tokens = await deps.refresh(current.refreshToken, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
          } catch (error) {
            // A spent refresh token means another holder already rotated this
            // login. Nothing is written: the mirror repairs the slot from the
            // fresher half, and Claude Code's own check does the rest.
            deps.log?.(
              `[accounts] the live Claude login could not be refreshed ahead of time: ${
                error instanceof Error ? error.message.split("\n")[0] : String(error)
              }`,
            );
            return "failed";
          }
          const next: ClaudeCredentialRecord = {
            ...current,
            accessToken: tokens.access,
            refreshToken: tokens.refresh,
            expiresAt: tokens.expires + PI_EXPIRY_PADDING_MS,
          };
          // Claude Code's compare-and-swap: only a store that still holds the
          // refresh token just spent takes the result.
          const saved = await updateClaudeCredentialStores(
            home.configDir,
            home.configDirEnv,
            (latest) => {
              const login = claudeLiveLoginRecord(latest);
              if (login?.refreshToken !== current.refreshToken) return { result: false };
              return {
                result: true,
                transform: (store) => {
                  store.claudeAiOauth = next;
                  return store;
                },
              };
            },
            storeOptions,
          );
          if (!saved) return "adopted";
          // The vault copy trails the live slot.
          await writeClaudeProfileLogin(deps.store, liveId, next, storeOptions).catch(() => undefined);
          return "refreshed";
        },
        { retries: deps.refreshLockRetries ?? 3 },
      ),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ELOCKED") return "busy";
    throw error;
  }
  if (outcome === "refreshed" || outcome === "adopted") {
    await deps.afterChange?.().catch(() => undefined);
  }
  return outcome;
}

let keeperTimer: NodeJS.Timeout | null = null;
let keeperDeps: ClaudeLoginKeeperDeps | null = null;
let keeperRun: Promise<ClaudeLoginKeeperOutcome> | null = null;

/** Run one pass now, joining a pass already in flight. */
export function nudgeClaudeLoginKeeper(): Promise<ClaudeLoginKeeperOutcome | null> {
  const deps = keeperDeps;
  if (!deps) return Promise.resolve(null);
  keeperRun ??= refreshLiveClaudeLoginIfDue(deps)
    .catch((error: unknown): ClaudeLoginKeeperOutcome => {
      deps.log?.(
        `[accounts] the Claude login keeper failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "failed";
    })
    .finally(() => {
      keeperRun = null;
    });
  return keeperRun;
}

export function startClaudeLoginKeeper(deps: ClaudeLoginKeeperDeps): void {
  keeperDeps = deps;
  if (keeperTimer) return;
  keeperTimer = setInterval(() => {
    void nudgeClaudeLoginKeeper();
  }, KEEPER_INTERVAL_MS);
  keeperTimer.unref?.();
  void nudgeClaudeLoginKeeper();
}

export function stopClaudeLoginKeeper(): void {
  if (keeperTimer) clearInterval(keeperTimer);
  keeperTimer = null;
  keeperDeps = null;
}
