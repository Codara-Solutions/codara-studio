import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
  readAnthropicAccountProfile,
  type AnthropicAccountProfile,
} from "../anthropic-account-identity";
import {
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  claudeCliManagedProfileConfigDir,
  isClaudeCliManagedProfileId,
  writeManagedClaudeIdentity,
  type ClaudeCliAccountProfileStore,
} from "../claude-cli-account-profiles";
import {
  CLAUDE_CREDENTIALS_FILE,
  clearClaudeCredentialRecord,
  defaultClaudeCliCredentialBackend,
  readClaudeCredentialRecord,
  writeClaudeCredentialRecord,
  type ClaudeCliCredentialBackend,
  type ClaudeCredentialRecord,
} from "../claude-cli-credentials";
import type { ClaudeCliProfileLeaseRegistry } from "../claude-cli-profile-execution";
import type { CanonicalCredential, CliSideRead } from "../credential-mirror";
import {
  readClaudeCliAccountIdentity,
  type NativeCliAccountIdentity,
} from "../native-cli-account-identity";
import {
  nativeClaudeProfileLeases,
  nativeClaudeProfileStore,
} from "../native-claude-profile-runtime";
import type { AccountIdentity, AccountProviderAdapter, CliProfileStatus } from "./account-adapter";
import { claudeCredentialCodec } from "./claude-credential-codec";

/**
 * Claude Code: one CLAUDE_CONFIG_DIR per managed account and ~/.claude for
 * Account 1. The credential lives in the directory's slot (the Keychain item
 * plus the 0600 file on macOS, the file elsewhere), the identity in the
 * directory's .claude.json. Switching kills nothing: a terminal keeps the
 * directory it started in.
 */

const KEYCHAIN_POLL_ACTIVE_MS = 20_000;
const KEYCHAIN_POLL_IDLE_MS = 60_000;

export interface ClaudeLocation {
  configDir: string;
  /** Null for ~/.claude: CLAUDE_CONFIG_DIR stays unset for the personal login. */
  configDirEnv: string | null;
}

export interface ClaudeAccountAdapterOptions {
  store?: ClaudeCliAccountProfileStore;
  leases?: ClaudeCliProfileLeaseRegistry;
  backend?: ClaudeCliCredentialBackend;
  /** Test seam. Production asks Anthropic's OAuth profile endpoint. */
  readIdentity?: (accessToken: string) => Promise<AnthropicAccountProfile>;
  /** Test seam. Production reads the config's oauthAccount block. */
  readCliIdentity?: (
    configDir: string,
    configDirEnv: string | null,
    homeDir: string,
  ) => Promise<NativeCliAccountIdentity>;
  /** Where ~/.claude.json lives; defaults to the parent of the personal directory. */
  homeDir?: string;
  /** Test seam. Production checks process.platform for the Keychain poll. */
  platform?: NodeJS.Platform;
}

export interface ClaudeAccountAdapter
  extends AccountProviderAdapter<ClaudeLocation, ClaudeCredentialRecord> {
  /** The Keychain-or-file backend behind readCli and writeCli, for the live-slot undo. */
  readonly credentialBackend: ClaudeCliCredentialBackend;
}

export function createClaudeAccountAdapter(
  options: ClaudeAccountAdapterOptions = {},
): ClaudeAccountAdapter {
  const credentialOptions = options.backend ? { backend: options.backend } : {};
  const platform = options.platform ?? process.platform;
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
  const homeDir = (): string => options.homeDir ?? dirname(resolveStore().personalConfigDir);
  const readCliIdentity = options.readCliIdentity ?? readClaudeCliAccountIdentity;
  const readIdentity = options.readIdentity ?? readAnthropicAccountProfile;

  const identityBlock = (identity: AccountIdentity) =>
    identity.accountUuid
      ? {
          accountUuid: identity.accountUuid,
          ...(identity.email ? { emailAddress: identity.email } : {}),
          ...(identity.organizationUuid ? { organizationUuid: identity.organizationUuid } : {}),
        }
      : null;

  return {
    provider: "anthropic",
    runtime: "claude",
    credentialBackend: options.backend ?? defaultClaudeCliCredentialBackend,
    personalId: CLAUDE_CLI_PERSONAL_PROFILE_ID,
    labels: { cliLabel: "Claude Code", loginHint: "claude login" },
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
    locate(cliProfileId) {
      const current = resolveStore();
      if (cliProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID) {
        return { configDir: current.personalConfigDir, configDirEnv: current.personalConfigDirEnv };
      }
      const configDir = claudeCliManagedProfileConfigDir(current.rootDir, cliProfileId);
      return { configDir, configDirEnv: configDir };
    },
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
    async readCli(location): Promise<CliSideRead<ClaudeCredentialRecord>> {
      try {
        const raw = await readClaudeCredentialRecord(
          location.configDir,
          location.configDirEnv,
          credentialOptions,
        );
        return { kind: "credential", raw };
      } catch {
        return { kind: "unreadable" };
      }
    },
    async writeCli(location, raw) {
      await writeClaudeCredentialRecord(
        location.configDir,
        location.configDirEnv,
        raw,
        credentialOptions,
      );
    },
    async clearCli(location) {
      await clearClaudeCredentialRecord(
        location.configDir,
        location.configDirEnv,
        credentialOptions,
      );
    },
    async cliSideExists(location) {
      return fs.lstat(location.configDir).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
    },
    mirrorPaths(location) {
      return [{ directory: location.configDir, file: CLAUDE_CREDENTIALS_FILE }];
    },
    cliWritePaths(location) {
      return [join(location.configDir, CLAUDE_CREDENTIALS_FILE)];
    },
    personalProbePaths() {
      return [{ directory: resolveStore().personalConfigDir, file: CLAUDE_CREDENTIALS_FILE }];
    },
    // Claude Code's tokens are opaque, so the mirror's foreign check reads
    // the identity the slot records next to them.
    cliIdentityFingerprint(location) {
      return readCliIdentity(location.configDir, location.configDirEnv, homeDir())
        .then((identity) => identity.fingerprint)
        .catch(() => undefined);
    },
    readCliIdentity(location) {
      return readCliIdentity(location.configDir, location.configDirEnv, homeDir()).catch(
        (): NativeCliAccountIdentity => ({}),
      );
    },
    connectTimeIdentity(canonical: CanonicalCredential) {
      return readIdentity(canonical.access).catch((): AnthropicAccountProfile => ({}));
    },
    async afterCliHalfWritten(location, identity) {
      const block = identityBlock(identity);
      if (!block) return;
      await writeManagedClaudeIdentity(location.configDir, block);
    },
  };
}

export const claudeAccountAdapter = createClaudeAccountAdapter();
