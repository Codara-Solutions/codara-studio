import type { PiAccountCliHalf } from "../orchestration/pi-account-profiles";
import {
  adoptClaudeLiveLogin,
  readClaudeForeignLiveLogin,
  type ClaudeLoginSlotStore,
} from "../orchestration/claude-cli-live-login";
import type { ClaudeCredentialStoreOptions } from "../orchestration/claude-cli-credentials";
import { anthropicAccountFingerprint } from "../orchestration/native-cli-account-identity";

/**
 * `/login` typed in a terminal that follows Codara. Claude Code signs the
 * live slot in as whoever the user chose, which is exactly what a `/login`
 * does in any other terminal; Codara then makes that account the active one
 * instead of setting the login aside as a stranger's:
 *
 *  - an account that already has this identity with a Codara-managed
 *    terminal login takes the new login and becomes active;
 *  - the row of the user's own login, when it is that account, becomes
 *    active (the live slot's copy is left alone: the user's own login is
 *    theirs, and new terminals use it again);
 *  - otherwise a new account is added for it, shared with Cora like any
 *    account added in Settings, and made active.
 *
 * The account the slot held before keeps its own saved login. Runs from the
 * login keeper's pass, only while plain `claude` follows Codara.
 */

export interface ClaudeLoginAdoptionDeps {
  slot: ClaudeLoginSlotStore;
  /** A new managed Claude profile; answers its id. */
  createCliProfile: (label: string) => Promise<string>;
  deleteCliProfile: (cliProfileId: string) => Promise<void>;
  /** The account row recording this identity fingerprint, if any. */
  rowForIdentity: (fingerprint: string) => Promise<{ id: string; cli: PiAccountCliHalf } | null>;
  /** Give a managed profile its account row (UnifiedAccountService.shareLogin). */
  shareCliLogin: (cliProfileId: string) => Promise<{ coraProfileId: string }>;
  /** Make a row the active account for Cora and the terminal. */
  useAccount: (coraProfileId: string) => Promise<void>;
  storeOptions?: ClaudeCredentialStoreOptions;
  log?: (message: string) => void;
}

export type ClaudeLoginAdoption =
  | "none"
  | "adopted-existing"
  | "adopted-new"
  | "switched-to-own-login"
  | "not-adopted";

export async function adoptFollowingTerminalLogin(deps: ClaudeLoginAdoptionDeps): Promise<ClaudeLoginAdoption> {
  const foreign = await readClaudeForeignLiveLogin(deps.slot);
  if (!foreign) return "none";
  const fingerprint = anthropicAccountFingerprint(foreign.accountUuid);
  const row = await deps.rowForIdentity(fingerprint);

  if (row?.cli.kind === "system") {
    await deps.useAccount(row.id);
    return "switched-to-own-login";
  }
  if (row?.cli.kind === "managed") {
    const adopted = await adoptClaudeLiveLogin(deps.slot, row.cli.profileId, foreign.accountUuid, deps.storeOptions);
    if (!adopted) return "not-adopted";
    await deps.useAccount(row.id);
    return "adopted-existing";
  }

  const cliProfileId = await deps.createCliProfile(foreign.email ?? "Claude account");
  let adopted = false;
  try {
    adopted = await adoptClaudeLiveLogin(deps.slot, cliProfileId, foreign.accountUuid, deps.storeOptions);
  } finally {
    if (!adopted) await deps.deleteCliProfile(cliProfileId).catch(() => undefined);
  }
  if (!adopted) return "not-adopted";
  const { coraProfileId } = await deps.shareCliLogin(cliProfileId);
  await deps.useAccount(coraProfileId);
  deps.log?.("[claude-follow] a terminal sign-in was added as an account and made active");
  return "adopted-new";
}
