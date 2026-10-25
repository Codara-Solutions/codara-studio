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
  removeClaudeCredentialStores,
  type ClaudeCredentialRecord,
  type ClaudeCredentialStoreOptions,
} from "../claude-cli-credentials";
import {
  activateClaudeCliAccount,
  claudeCliVaultFile,
  clearClaudeProfileLogin,
  forgetClaudeVaultIdentity,
  readClaudeLiveProfileId,
  readClaudeProfileIdentity,
  readClaudeProfileLogin,
  releaseClaudeLiveSlot,
  withClaudeSelectionLock,
  writeClaudeProfileIdentity,
  writeClaudeProfileLogin,
} from "../claude-cli-live-login";
import type { ClaudeCliProfileLeaseRegistry } from "../claude-cli-profile-execution";
import type { CanonicalCredential, CliSideRead } from "../credential-mirror";
import type { NativeCliAccountIdentity } from "../native-cli-account-identity";
import {
  ensureClaudeLiveHome,
  nativeClaudeProfileLeases,
  nativeClaudeProfileStore,
} from "../native-claude-profile-runtime";
import type { AccountIdentity, AccountProviderAdapter, CliProfileStatus } from "./account-adapter";
import { claudeCredentialCodec } from "./claude-credential-codec";

/**
 * Claude Code: one Codara-owned live slot for every managed account. Every
 * Claude terminal and worker Codara starts on a managed account runs with
 * CLAUDE_CONFIG_DIR at that slot; the Active account's login sits in it and
 * every other managed account's login waits in its vault (see
 * claude-cli-live-login.ts). Activating an account moves logins, never
 * terminals: running sessions re-read the credential before each request and
 * continue on the new account with no restart (the hot swap). The user's own
 * login is never part of this: a terminal on the System login simply runs
 * without the variable.
 */

const KEYCHAIN_POLL_ACTIVE_MS = 20_000;
const KEYCHAIN_POLL_IDLE_MS = 60_000;

export interface ClaudeLocation {
  cliProfileId: string;
  rootDir: string;
  /** The live slot every managed session runs in. */
  configDir: string;
  configDirEnv: string;
  /** Where the profile's login waits while another profile is live. */
  vaultFile: string;
}

export interface ClaudeAccountAdapterOptions {
  store?: ClaudeCliAccountProfileStore;
  leases?: ClaudeCliProfileLeaseRegistry;
  /** Test seam: keep every live-slot read and write away from the Keychain. */
  fileOnly?: boolean;
  /** Test seam. Production asks Anthropic's OAuth profile endpoint. */
  readIdentity?: (accessToken: string) => Promise<AnthropicAccountProfile>;
  /** Test seam. Production checks process.platform for the Keychain poll. */
  platform?: NodeJS.Platform;
  /** Test seam: provision the live slot; production links it into the System home. */
  prepareLiveHome?: (store: ClaudeCliAccountProfileStore) => Promise<void>;
  log?: (message: string) => void;
}

export type ClaudeAccountAdapter = AccountProviderAdapter<ClaudeLocation, ClaudeCredentialRecord>;

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
  const prepareLiveHome =
    options.prepareLiveHome ?? ((current: ClaudeCliAccountProfileStore) => ensureClaudeLiveHome(current, options.log));

  const locate = (cliProfileId: string): ClaudeLocation => {
    const current = resolveStore();
    return {
      cliProfileId,
      rootDir: current.rootDir,
      configDir: current.liveConfigDir,
      configDirEnv: current.liveConfigDir,
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
    if (!isClaudeCliManagedProfileId(location.cliProfileId)) return { kind: "unreadable" };
    const read = await readClaudeProfileLogin(resolveStore(), location.cliProfileId, storeOptions);
    if (read.kind === "unreadable") return { kind: "unreadable" };
    return { kind: "credential", raw: read.record };
  };

  const knownProfileIds = async (): Promise<string[]> =>
    (await resolveStore().snapshot()).profiles.map((profile) => profile.id);

  const profileExists = async (profileId: string): Promise<boolean> =>
    (await resolveStore().snapshot()).profiles.some((profile) => profile.id === profileId);

  return {
    provider: "anthropic",
    runtime: "claude",
    systemProfileId: CLAUDE_CLI_PERSONAL_PROFILE_ID,
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
      if (!isClaudeCliManagedProfileId(location.cliProfileId)) return;
      await clearClaudeProfileLogin(resolveStore(), location.cliProfileId, storeOptions);
      // A directory from the per-directory model may still name a Keychain
      // item of its own; it goes with the account.
      const legacyDir = claudeCliManagedProfileConfigDir(location.rootDir, location.cliProfileId);
      await removeClaudeCredentialStores(legacyDir, legacyDir, storeOptions).catch(() => undefined);
    },
    async cliSideExists(location) {
      if (!isClaudeCliManagedProfileId(location.cliProfileId)) return false;
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
    // Claude Code's tokens are opaque, so the mirror's foreign check reads
    // the account the slot records next to them.
    cliIdentityFingerprint(location) {
      return readClaudeProfileIdentity(resolveStore(), location.cliProfileId)
        .then((identity) => identity.fingerprint)
        .catch(() => undefined);
    },
    readCliIdentity(location) {
      if (!isClaudeCliManagedProfileId(location.cliProfileId)) {
        return Promise.resolve({});
      }
      return readClaudeProfileIdentity(resolveStore(), location.cliProfileId).catch(
        (): NativeCliAccountIdentity => ({}),
      );
    },
    connectTimeIdentity(canonical: CanonicalCredential) {
      return readIdentity(canonical.access).catch((): AnthropicAccountProfile => ({}));
    },
    async prepareCliHome() {
      await prepareLiveHome(resolveStore());
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
    managedHome(cliProfileId) {
      const current = resolveStore();
      return {
        path: claudeCliManagedProfileConfigDir(current.rootDir, cliProfileId),
        accountsRoot: current.accountsDir,
        holdsSessions: false,
      };
    },
    managedAccountsRoot() {
      return resolveStore().accountsDir;
    },
    activeCliProfileId() {
      return readClaudeLiveProfileId(resolveStore().rootDir);
    },
    async activate(target) {
      if (!isClaudeCliManagedProfileId(target)) return;
      const current = resolveStore();
      await prepareLiveHome(current);
      await activateClaudeCliAccount(current, target, {
        ...storeOptions,
        profileExists,
        knownProfileIds,
        ...(options.log ? { log: options.log } : {}),
      });
    },
    async releaseActive(cliProfileId) {
      const current = resolveStore();
      await withClaudeSelectionLock(current.rootDir, () =>
        releaseClaudeLiveSlot(current, cliProfileId, storeOptions),
      );
    },
  };
}

export const claudeAccountAdapter = createClaudeAccountAdapter({
  log: (message) => console.warn(message),
});
