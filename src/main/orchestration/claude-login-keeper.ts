import {
  claudeCliVaultFile,
  claudeLiveHome,
  claudeLiveSlotHoldsProfile,
  claudeLoginRecordOf,
  readClaudeVaultedLogin,
  claudeLiveLoginRecord,
  readClaudeLiveProfileId,
  readClaudeProfileLogin,
  withClaudeSelectionLock,
  writeClaudeVaultLogin,
  type ClaudeLiveHome,
  type ClaudeLoginSlotStore,
} from "./claude-cli-live-login";
import {
  readClaudeCredentialStores,
  updateClaudeCredentialStores,
  withClaudeCodeRefreshLock,
  type ClaudeCredentialRecord,
  type ClaudeCredentialStoreOptions,
} from "./claude-cli-credentials";
import type { ClaudeCliProfileId } from "./claude-cli-profile-ids";

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
 * matches the store), and the credential mirror carries it to Cora. When
 * Cora does find its copy due, it asks Studio (renewClaudeLoginForCora)
 * rather than spending the refresh token itself.
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
  /** The OAuth refresh grant; production uses the bundled Pi library's Anthropic module. */
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
  | "failed"
  /** The live login is another account's (a terminal `/login`); left alone. */
  | "foreign";

function isDue(record: ClaudeCredentialRecord, now: number, leadMs: number): boolean {
  return record.expiresAt > 0 && record.expiresAt - now <= leadMs;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

function withTokens(
  record: ClaudeCredentialRecord,
  tokens: RefreshedAnthropicTokens,
): ClaudeCredentialRecord {
  return {
    ...record,
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: tokens.expires + PI_EXPIRY_PADDING_MS,
  };
}

/**
 * Claude Code's compare-and-swap on the live slot: only a store that still
 * holds the refresh token just spent takes the result.
 */
async function swapLiveLogin(
  home: ClaudeLiveHome,
  spent: string,
  next: ClaudeCredentialRecord,
  options: ClaudeCredentialStoreOptions,
): Promise<boolean> {
  return updateClaudeCredentialStores(
    home.configDir,
    home.configDirEnv,
    (latest) => {
      const login = claudeLiveLoginRecord(latest);
      if (login?.refreshToken !== spent) return { result: false };
      return {
        result: true,
        transform: (store) => {
          store.claudeAiOauth = next;
          return store;
        },
      };
    },
    options,
  );
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
  if (!(await claudeLiveSlotHoldsProfile(deps.store, liveId))) return "foreign";
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
          if (!(await claudeLiveSlotHoldsProfile(deps.store, liveId))) return "foreign";
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
              `[accounts] the live Claude login could not be refreshed ahead of time: ${firstLine(error)}`,
            );
            return "failed";
          }
          const next = withTokens(current, tokens);
          if (!(await swapLiveLogin(home, current.refreshToken, next, storeOptions))) return "adopted";
          // The vault copy trails the live slot.
          await writeClaudeVaultLogin(deps.store, liveId, next).catch(() => undefined);
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

export interface ClaudeLoginRenewal {
  outcome: "adopted" | "refreshed";
  tokens: RefreshedAnthropicTokens;
}

/**
 * An adopted login must outlast Pi's padding plus the window in which Pi
 * already asks again (five minutes since Pi 0.87), or Pi would ask at once.
 */
const ADOPT_MIN_VALIDITY_MS = PI_EXPIRY_PADDING_MS + 6 * 60 * 1000;
/** Pi gives a refresh 15 seconds; a Claude Code refresh in flight is waited for about 10. */
const RENEW_LOCK_RETRIES = 12;

/**
 * Renew a Claude login for its Cora half, which would otherwise refresh its
 * own copy of the same grant (resources/pi-cora/anthropic-refresh.ts routes
 * Pi's refresh here). Under the selection lock, and Claude Code's refresh
 * lock while the profile is live:
 *
 * - a slot whose access token is still good is adopted as it is (Claude
 *   Code or the keeper refreshed it already);
 * - otherwise the slot's refresh token is spent, then Cora's copy if that
 *   one fails (Claude Code blanked the slot, or the slot trails Cora), and
 *   the result is compare-and-swapped into the slot.
 *
 * A slot with no login at all stays signed out; Cora still gets its token.
 * Nothing here touches Pi's store: the caller holds Pi's lock and stores the
 * answer itself.
 */
export async function renewClaudeLoginForCora(
  deps: ClaudeLoginKeeperDeps,
  profileId: ClaudeCliProfileId,
  heldRefreshToken: string,
  options: { expectedFingerprint?: string } = {},
): Promise<ClaudeLoginRenewal> {
  const now = deps.now ?? Date.now;
  const storeOptions: ClaudeCredentialStoreOptions = deps.fileOnly ? { fileOnly: true } : {};
  const home = claudeLiveHome(deps.store);
  return withClaudeSelectionLock(deps.store.rootDir, async () => {
    // The live slot is this profile's only while it holds this profile's
    // account: after a terminal `/login` as someone else, the profile's own
    // login is the one its vault (and Cora) keeps, and the stranger's login
    // in the live slot is never handed out or saved as this profile's.
    const live =
      (await readClaudeLiveProfileId(deps.store.rootDir)) === profileId &&
      (await claudeLiveSlotHoldsProfile(deps.store, profileId, options.expectedFingerprint));
    const renew = async (): Promise<ClaudeLoginRenewal> => {
      let record: ClaudeCredentialRecord | null;
      if (live) {
        const slot = await readClaudeProfileLogin(deps.store, profileId, storeOptions);
        if (slot.kind === "unreadable") throw new Error("The Claude login could not be read");
        record = slot.record;
      } else {
        const vault = await readClaudeVaultedLogin(claudeCliVaultFile(deps.store.rootDir, profileId));
        if (vault.kind === "unreadable") throw new Error("The Claude login could not be read");
        record = vault.kind === "value" ? claudeLoginRecordOf(vault.login.store) : null;
      }
      if (record?.accessToken && record.expiresAt - now() > ADOPT_MIN_VALIDITY_MS) {
        return {
          outcome: "adopted",
          tokens: {
            access: record.accessToken,
            refresh: record.refreshToken,
            expires: record.expiresAt - PI_EXPIRY_PADDING_MS,
          },
        };
      }
      const candidates = [...new Set([record?.refreshToken, heldRefreshToken].filter(nonEmpty))];
      if (candidates.length === 0) throw new Error("The Claude login holds no refresh token");
      let tokens: RefreshedAnthropicTokens | null = null;
      let failure: unknown = null;
      for (const candidate of candidates) {
        try {
          tokens = await deps.refresh(candidate, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
          break;
        } catch (error) {
          failure = error;
        }
      }
      if (!tokens) throw failure;
      if (record) {
        const next = withTokens(record, tokens);
        const saved = live ? await swapLiveLogin(home, record.refreshToken, next, storeOptions) : true;
        if (saved) {
          await writeClaudeVaultLogin(deps.store, profileId, next).catch((error: unknown) => {
            deps.log?.(`[accounts] a renewed Claude login was not saved to its vault: ${firstLine(error)}`);
          });
        }
      }
      return { outcome: "refreshed", tokens };
    };
    return live
      ? withClaudeCodeRefreshLock(home.configDir, renew, {
          retries: deps.refreshLockRetries ?? RENEW_LOCK_RETRIES,
        })
      : renew();
  });
}

let keeperTimer: NodeJS.Timeout | null = null;
let keeperDeps: ClaudeLoginKeeperDeps | null = null;
let keeperRun: Promise<ClaudeLoginKeeperOutcome> | null = null;

/** The running keeper's dependencies, or null before Studio started it. */
export function claudeLoginKeeperDeps(): ClaudeLoginKeeperDeps | null {
  return keeperDeps;
}

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
