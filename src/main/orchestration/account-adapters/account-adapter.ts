import type { CanonicalCredential, CredentialMirrorAdapter } from "../credential-mirror";
import type { NativeCliAccountIdentity } from "../native-cli-account-identity";

/**
 * The seam between the provider-neutral account service and one CLI. An
 * adapter knows where a managed account keeps its CLI login inside Codara's
 * home, how to read and write it, how to identify the account behind it,
 * and what activating an account means for that CLI. The service knows the
 * registry, defaults, pairing, mirroring and deletion, and never a
 * provider-specific path.
 *
 * The System login (the CLI's own login in its own home) is never located,
 * read for secrets or written through an adapter: Codara uses it by not
 * setting the CLI's home variable, and reads only who it is
 * (system-cli-login.ts).
 *
 * Locations are opaque to everything but the adapter that produced them and
 * live in the main process only.
 */

export type CliRuntime = "claude" | "codex" | "grok";

/** What a login can be identified by; the raw uuids never cross IPC. */
export interface AccountIdentity extends NativeCliAccountIdentity {
  /** Claude only: recorded beside the login as Claude Code's oauthAccount. */
  accountUuid?: string;
  organizationUuid?: string;
}

/** Token-blind status of one CLI profile, the shape the cards show. */
export interface CliProfileStatus {
  id: string;
  label: string;
  managed: boolean;
  isDefault: boolean;
  connected: boolean;
  expired: boolean;
  canRefresh: boolean;
}

/** The parts of the three CLI profile stores that already share a shape. */
export interface AccountCliStore {
  readonly rootDir: string;
  snapshot(): Promise<{ profiles: Array<{ id: string; label: string }>; defaultProfileId: string }>;
  createProfile(input: { label: string }): Promise<{ profile: { id: string; label: string } }>;
  deleteProfile(
    profileId: string,
    options?: { keepDirectory?: boolean },
  ): Promise<{ deleted: boolean }>;
  setDefaultProfile(profileId: string | null | undefined): Promise<unknown>;
}

export interface AccountCliLeases {
  isLeased(profileId: string): boolean;
  owners(profileId: string): string[];
  sweep(liveOwnerIds: ReadonlySet<string>, ownerPrefix?: string): string[];
}

/** A managed account's directory, removed when its account is deleted. */
export interface ManagedCliHome {
  /** The directory to purge, strictly inside `accountsRoot`. */
  path: string;
  accountsRoot: string;
  /**
   * Whether terminals run inside it. Claude sessions run in the shared live
   * slot, so its per-account directory never waits for a terminal to exit.
   */
  holdsSessions: boolean;
}

export interface AccountProviderAdapter<Loc = unknown, Raw = unknown>
  extends CredentialMirrorAdapter<Loc, Raw> {
  readonly runtime: CliRuntime;
  readonly labels: { cliLabel: string; loginHint: string };
  readonly store: AccountCliStore;
  readonly leases: AccountCliLeases;
  /** The per-CLI store's id for the System login. */
  readonly systemProfileId: string;
  locate(cliProfileId: string): Loc;
  isManagedProfileId(value: unknown): value is string;
  /** Every profile of the CLI with a token-blind status, from one read each. */
  inspectCli(): Promise<CliProfileStatus[]>;
  clearCli(location: Loc): Promise<void>;
  readCliIdentity(location: Loc): Promise<NativeCliAccountIdentity>;
  /**
   * Who a freshly issued Cora credential belongs to. Anthropic asks its
   * profile endpoint (network); Codex and Grok read JWT claims.
   */
  connectTimeIdentity(canonical: CanonicalCredential): Promise<AccountIdentity>;
  /** Create or refresh a managed home before its login is written into it. */
  prepareCliHome?(cliProfileId: string): Promise<void>;
  /** Claude: record the identity block Claude Code expects beside the credential. */
  afterCliHalfWritten?(location: Loc, identity: AccountIdentity): Promise<void>;
  /**
   * Turn a Cora credential the codec cannot write as a CLI file into one it
   * can (Codex needs an id_token only a refresh grant returns). The rotated
   * credential is persisted to Pi inside the call.
   */
  growCliCredential?(
    canonical: CanonicalCredential,
    authFile: string,
    signal: AbortSignal,
  ): Promise<CanonicalCredential>;
  /** The managed directory of a CLI profile, for the purge that follows a delete. */
  managedHome(cliProfileId: string): ManagedCliHome;
  /** The directory every managed home of this CLI sits in. */
  managedAccountsRoot(): string;
  /** Claude: the managed profile whose login the live slot holds, or null. */
  activeCliProfileId?(): Promise<string | null>;
  /**
   * Claude's hot swap: put a managed profile's login into the live slot
   * every Codara Claude session runs in. The System login moves nothing.
   */
  activate?(cliProfileId: string): Promise<void>;
  /** Claude: empty the live slot when the account it holds is deleted. */
  releaseActive?(cliProfileId: string): Promise<void>;
  /**
   * Every session runs in one live slot whatever account it started on
   * (Claude), so a lease only records which account a session started on
   * and deleting an account never waits for a terminal.
   */
  readonly sessionsFollowLiveLogin?: boolean;
}
