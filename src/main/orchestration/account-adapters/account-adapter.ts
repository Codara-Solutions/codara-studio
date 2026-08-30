import type {
  CanonicalCredential,
  CredentialMirrorAdapter,
  MirrorWatchTarget,
} from "../credential-mirror";
import type { NativeCliAccountIdentity } from "../native-cli-account-identity";

/**
 * The seam between the provider-neutral account service and one CLI. An
 * adapter knows where a CLI keeps a login, how to read and write that slot,
 * how to identify the account behind it, and which side effects a switch
 * needs. The service knows registries, defaults, pairing, mirroring and
 * deletion, and never a provider-specific path.
 *
 * Locations are opaque to everything but the adapter that produced them and
 * live in the main process only.
 */

export type CliRuntime = "claude" | "codex" | "grok";

/** What a login can be identified by; the raw uuids never cross IPC. */
export interface AccountIdentity extends NativeCliAccountIdentity {
  /** Claude only: written into a managed directory's .claude.json. */
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
  deleteProfile(profileId: string): Promise<{ deleted: boolean }>;
  setDefaultProfile(profileId: string | null | undefined): Promise<unknown>;
}

export interface AccountCliLeases {
  isLeased(profileId: string): boolean;
  owners(profileId: string): string[];
  sweep(liveOwnerIds: ReadonlySet<string>, ownerPrefix?: string): string[];
}

export interface SwitchContext {
  closeSessions: boolean;
  /** Studio panes holding a lease on any profile of this CLI, dead ones swept. */
  liveSessionCount(): Promise<number>;
  /** Closes every session of this CLI; null when the host wired none. */
  sessionShutdown: (() => Promise<{ closedSessionCount: number }>) | null;
}

export interface SwitchSideEffects {
  /**
   * Runs before either default moves. Throws UnifiedAccountSessionsError
   * when the switch would close sessions the caller did not agree to close.
   */
  beforeSwitch(target: string, context: SwitchContext): Promise<{ closedSessionCount: number }>;
  /** Runs after both defaults moved; a throw rolls both back. */
  afterDefault(target: string, options?: { allowSignedOut?: boolean }): Promise<void>;
}

export interface AccountProviderAdapter<Loc = unknown, Raw = unknown>
  extends CredentialMirrorAdapter<Loc, Raw> {
  readonly runtime: CliRuntime;
  readonly labels: { cliLabel: string; loginHint: string };
  readonly store: AccountCliStore;
  readonly leases: AccountCliLeases;
  locate(cliProfileId: string): Loc;
  isManagedProfileId(value: unknown): value is string;
  /** Every profile of the CLI with a token-blind status, from one read each. */
  inspectCli(): Promise<CliProfileStatus[]>;
  clearCli(location: Loc): Promise<void>;
  /** The slots the personal probe watches while no Account 1 row exists. */
  personalProbePaths(): MirrorWatchTarget[];
  readCliIdentity(location: Loc): Promise<NativeCliAccountIdentity>;
  /**
   * Who a freshly issued Cora credential belongs to. Anthropic asks its
   * profile endpoint (network); Codex and Grok read JWT claims.
   */
  connectTimeIdentity(canonical: CanonicalCredential): Promise<AccountIdentity>;
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
  /** The CLI profile whose login is live right now, when that differs from the store default. */
  activeCliProfileId?(): Promise<string>;
  readonly switchSideEffects?: SwitchSideEffects;
}
