import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  readAnthropicAccountProfile,
  type AnthropicAccountProfile,
} from "../anthropic-account-identity";
import {
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  claudeCliManagedProfileConfigDir,
  isClaudeCliManagedProfileId,
  type ClaudeCliAccountProfileStore,
} from "../claude-cli-account-profiles";
import {
  CLAUDE_CREDENTIALS_FILE,
  defaultClaudeCliCredentialBackend,
  removeClaudeCredentialStores,
  type ClaudeCliCredentialBackend,
  type ClaudeCredentialRecord,
  type ClaudeCredentialStoreOptions,
} from "../claude-cli-credentials";
import {
  activateClaudeCliAccount,
  adoptClaudeNativeLogin,
  claudeCliVaultFile,
  detectClaudeNativeLogin,
  clearClaudeProfileLogin,
  forgetClaudeVaultIdentity,
  readClaudeLiveProfileId,
  readClaudeProfileIdentity,
  readClaudeProfileLogin,
  withClaudeSelectionLock,
  writeClaudeProfileIdentity,
  writeClaudeProfileLogin,
} from "../claude-cli-live-login";
import type { ClaudeCliProfileLeaseRegistry } from "../claude-cli-profile-execution";
import type { CanonicalCredential, CliSideRead } from "../credential-mirror";
import type { NativeCliAccountIdentity } from "../native-cli-account-identity";
import {
  nativeClaudeProfileLeases,
  nativeClaudeProfileStore,
} from "../native-claude-profile-runtime";
import type { AccountIdentity, AccountProviderAdapter, CliProfileStatus } from "./account-adapter";
import { claudeCredentialCodec } from "./claude-credential-codec";

/**
 * Claude Code: one home for every account. Terminals always run in the
 * user's own Claude home; the live profile's login sits in that home's
 * credential store and every other profile's login in its vault (see
 * claude-cli-live-login.ts). A switch moves logins, never terminals, so it
 * closes nothing: running sessions adopt the new login the next time they
 * check their credentials, exactly as after a `/login` in another terminal.
 */

const KEYCHAIN_POLL_ACTIVE_MS = 20_000;
const KEYCHAIN_POLL_IDLE_MS = 60_000;

export interface ClaudeLocation {
  cliProfileId: string;
  rootDir: string;
  /** The Claude home every terminal runs in. */
  configDir: string;
  /** Null for ~/.claude: CLAUDE_CONFIG_DIR stays unset. */
  configDirEnv: string | null;
  /** Where the profile's login waits while another profile is live. */
  vaultFile: string;
}

export interface ClaudeAccountAdapterOptions {
  store?: ClaudeCliAccountProfileStore;
  leases?: ClaudeCliProfileLeaseRegistry;
  /** The retired selector's backend, still needed to undo that swap once. */
  backend?: ClaudeCliCredentialBackend;
  /** Test seam: keep every live-slot read and write away from the Keychain. */
  fileOnly?: boolean;
  /** Test seam. Production asks Anthropic's OAuth profile endpoint. */
  readIdentity?: (accessToken: string) => Promise<AnthropicAccountProfile>;
  /** Test seam. Production checks process.platform for the Keychain poll. */
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}

export interface ClaudeAccountAdapter
  extends AccountProviderAdapter<ClaudeLocation, ClaudeCredentialRecord> {
  /** The per-directory backend the retired selector used, for its one-time undo. */
  readonly credentialBackend: ClaudeCliCredentialBackend;
}

export function createClaudeAccountAdapter(
  options: ClaudeAccountAdapterOptions = {},
): ClaudeAccountAdapter {
  const platform = options.platform ?? process.platform;
  const storeOptions: ClaudeCredentialStoreOptions = options.fileOnly ? { fileOnly: true } : {};
  let store: ClaudeCliAccountProfileStore | null = options.store ?? null;
  let leases: ClaudeCliProfileLeaseRegistry | null = options.leases ?? null;
  const resolveStore = (): ClaudeCliAccountProfileStore => {
    store ??= nativeClaudeProfileStore;
    return store;
  };
  const resolveLeases = (): ClaudeCliProfileLeaseRegistry => {
    leases ??= nativeClaudeProfileLeases;
    return leases;
  };
  const readIdentity = options.readIdentity ?? readAnthropicAccountProfile;

  const locate = (cliProfileId: string): ClaudeLocation => {
    const current = resolveStore();
    return {
      cliProfileId,
      rootDir: current.rootDir,
      configDir: current.personalConfigDir,
      configDirEnv: current.personalConfigDirEnv,
      vaultFile: claudeCliVaultFile(current.rootDir, cliProfileId),
    };
  };

  const identityBlock = (identity: AccountIdentity) =>
    identity.accountUuid
      ? {
          accountUuid: identity.accountUuid,
          ...(identity.email ? { emailAddress: identity.email } : {}),
          ...(identity.organizationUuid ? { organizationUuid: identity.organizationUuid } : {}),
        }
      : null;

  const readCli = async (location: ClaudeLocation): Promise<CliSideRead<ClaudeCredentialRecord>> => {
    const read = await readClaudeProfileLogin(resolveStore(), location.cliProfileId, storeOptions);
    if (read.kind === "unreadable") return { kind: "unreadable" };
    return { kind: "credential", raw: read.record };
  };

  const knownProfileIds = async (): Promise<string[]> => [
    CLAUDE_CLI_PERSONAL_PROFILE_ID,
    ...(await resolveStore().snapshot()).profiles.map((profile) => profile.id),
  ];

  const profileExists = async (profileId: string): Promise<boolean> =>
    (await resolveStore().snapshot()).profiles.some((profile) => profile.id === profileId);

  return {
    provider: "anthropic",
    runtime: "claude",
    credentialBackend: options.backend ?? defaultClaudeCliCredentialBackend,
    personalId: CLAUDE_CLI_PERSONAL_PROFILE_ID,
    labels: { cliLabel: "Claude Code", loginHint: "claude login" },
    sessionsFollowLiveLogin: true,
    get store() {
      return resolveStore();
    },
    get leases() {
      return resolveLeases();
    },
    codec: claudeCredentialCodec,
    // Claude Code refreshes into the Keychain on macOS, which no file watcher
    // sees; elsewhere every rotation rewrites the file.
    pollWhenWatchBlind:
      platform === "darwin"
        ? { activeMs: KEYCHAIN_POLL_ACTIVE_MS, idleMs: KEYCHAIN_POLL_IDLE_MS }
        : null,
    locate,
    isManagedProfileId: isClaudeCliManagedProfileId,
    async inspectCli(): Promise<CliProfileStatus[]> {
      const inspection = await resolveStore().inspect();
      return inspection.profiles.map((connection) => ({
        id: connection.id,
        label: connection.label,
        managed: connection.managed,
        isDefault: connection.isDefault,
        connected: connection.connected,
        expired: connection.expired,
        canRefresh: connection.canRefresh,
      }));
    },
    readCli,
    async writeCli(location, raw) {
      await writeClaudeProfileLogin(resolveStore(), location.cliProfileId, raw, storeOptions);
    },
    async clearCli(location) {
      await clearClaudeProfileLogin(resolveStore(), location.cliProfileId, storeOptions);
      if (isClaudeCliManagedProfileId(location.cliProfileId)) {
        // A directory from the per-directory model may still name a Keychain
        // item of its own; it goes with the account.
        const legacyDir = claudeCliManagedProfileConfigDir(location.rootDir, location.cliProfileId);
        await removeClaudeCredentialStores(legacyDir, legacyDir, storeOptions).catch(() => undefined);
      }
    },
    async cliSideExists(location) {
      if (location.cliProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID) return true;
      return fs.lstat(dirname(location.vaultFile)).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
    },
    mirrorPaths(location) {
      return [
        { directory: dirname(location.vaultFile), file: basename(location.vaultFile) },
        { directory: location.configDir, file: CLAUDE_CREDENTIALS_FILE },
      ];
    },
    cliWritePaths(location) {
      return [location.vaultFile, join(location.configDir, CLAUDE_CREDENTIALS_FILE)];
    },
    lockCli(location, operation) {
      return withClaudeSelectionLock(location.rootDir, operation);
    },
    personalProbePaths() {
      const current = resolveStore();
      const personalVault = claudeCliVaultFile(current.rootDir, CLAUDE_CLI_PERSONAL_PROFILE_ID);
      return [
        { directory: current.personalConfigDir, file: CLAUDE_CREDENTIALS_FILE },
        { directory: dirname(personalVault), file: basename(personalVault) },
      ];
    },
    isDeliberateSignOut(raw) {
      // Claude Code blanks the tokens of a login whose refresh token turned
      // out to be spent and keeps the record; a `/logout` removes it.
      return raw === null || raw === undefined;
    },
    async mayCreatePersonalSlot(location) {
      // Account 1's vault is Codara's; only the live slot is the user's own.
      return (await readClaudeLiveProfileId(location.rootDir)) !== location.cliProfileId;
    },
    // Claude Code's tokens are opaque, so the mirror's foreign check reads
    // the account the slot records next to them.
    cliIdentityFingerprint(location) {
      return readClaudeProfileIdentity(resolveStore(), location.cliProfileId)
        .then((identity) => identity.fingerprint)
        .catch(() => undefined);
    },
    readCliIdentity(location) {
      return readClaudeProfileIdentity(resolveStore(), location.cliProfileId).catch(
        (): NativeCliAccountIdentity => ({}),
      );
    },
    connectTimeIdentity(canonical: CanonicalCredential) {
      return readIdentity(canonical.access).catch((): AnthropicAccountProfile => ({}));
    },
    async afterCliHalfWritten(location, identity) {
      const block = identityBlock(identity);
      if (!block) return;
      await withClaudeSelectionLock(location.rootDir, () =>
        writeClaudeProfileIdentity(resolveStore(), location.cliProfileId, block),
      );
    },
    async afterCliSlotFilled(location, canonical, expectedFingerprint) {
      // The token answers for itself; offline, a record that disagrees with
      // the row is dropped, since no record beats a wrong one.
      const identity = await readIdentity(canonical.access).catch((): AnthropicAccountProfile => ({}));
      const block = identityBlock(identity);
      await withClaudeSelectionLock(location.rootDir, async () => {
        const current = resolveStore();
        if (block) {
          await writeClaudeProfileIdentity(current, location.cliProfileId, block);
          return;
        }
        if (!expectedFingerprint) return;
        const recorded = await readClaudeProfileIdentity(current, location.cliProfileId);
        if (recorded.fingerprint && recorded.fingerprint !== expectedFingerprint) {
          await forgetClaudeVaultIdentity(current, location.cliProfileId);
        }
      });
    },
    activeCliProfileId() {
      return readClaudeLiveProfileId(resolveStore().rootDir);
    },
    async detectNativeLogin() {
      const current = resolveStore();
      const change = await detectClaudeNativeLogin(
        current,
        await knownProfileIds(),
        async (accessToken) => (await readIdentity(accessToken)).accountUuid,
        storeOptions,
      );
      return change
        ? {
            from: change.from,
            to: change.to,
            adopt: () => adoptClaudeNativeLogin(current, change, storeOptions),
          }
        : null;
    },
    switchSideEffects: {
      async sessionCount() {
        return 0;
      },
      async beforeSwitch() {
        return { closedSessionCount: 0 };
      },
      async afterDefault(target, effectOptions = {}) {
        await activateClaudeCliAccount(resolveStore(), target, {
          ...storeOptions,
          allowSignedOut: effectOptions.allowSignedOut === true,
          profileExists,
          knownProfileIds,
          ...(options.log ? { log: options.log } : {}),
        });
      },
    },
  };
}

export const claudeAccountAdapter = createClaudeAccountAdapter({
  log: (message) => console.warn(message),
});
