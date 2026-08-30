import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { CanonicalCredential, CliSideRead } from "../credential-mirror";
import {
  GROK_CLI_AUTH_FILE,
  GROK_CLI_PERSONAL_PROFILE_ID,
  grokCliManagedProfilePaths,
  isGrokCliManagedProfileId,
  type GrokCliAccountProfileStore,
} from "../grok-cli-account-profiles";
import type { GrokCliProfileLeaseRegistry } from "../grok-cli-profile-execution";
import {
  atomicWritePrivateFile,
  readPrivateJsonFile,
  removePrivateFile,
} from "../native-cli-atomic-file";
import {
  jwtEmailClaim,
  jwtStringClaim,
  nativeCliAccountFingerprint,
  readGrokCliAccountIdentity,
  type NativeCliAccountIdentity,
} from "../native-cli-account-identity";
import {
  nativeGrokProfileLeases,
  nativeGrokProfileStore,
} from "../native-grok-profile-runtime";
import type { AccountIdentity, AccountProviderAdapter, CliProfileStatus } from "./account-adapter";
import { createGrokCredentialCodec, type GrokAuthFile } from "./grok-credential-codec";

/**
 * Grok Build, on the Claude model: one GROK_HOME per managed account (with
 * sessions, skills and config linked to ~/.grok by the profile store) and
 * ~/.grok itself for Account 1. The credential is the home's auth.json,
 * which Grok hot-reloads and rewrites in place beside its own
 * auth.json.lock; Codara writes the file atomically next to that lock and
 * never touches the lock. Switching kills nothing: a terminal keeps the
 * home it started in.
 */

export interface GrokLocation {
  homeDir: string;
  authFile: string;
}

export interface GrokAccountAdapterOptions {
  store?: GrokCliAccountProfileStore;
  leases?: GrokCliProfileLeaseRegistry;
  /** Test seam for the create_time stamp of a synthesized slot. */
  now?: () => Date;
}

export type GrokAccountAdapter = AccountProviderAdapter<GrokLocation, GrokAuthFile>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createGrokAccountAdapter(
  options: GrokAccountAdapterOptions = {},
): GrokAccountAdapter {
  let store: GrokCliAccountProfileStore | null = options.store ?? null;
  let leases: GrokCliProfileLeaseRegistry | null = options.leases ?? null;
  const resolveStore = (): GrokCliAccountProfileStore => {
    store ??= nativeGrokProfileStore;
    return store;
  };
  const resolveLeases = (): GrokCliProfileLeaseRegistry => {
    leases ??= nativeGrokProfileLeases;
    return leases;
  };
  const codec = createGrokCredentialCodec(options.now ? { now: options.now } : {});

  const readCli = async (location: GrokLocation): Promise<CliSideRead<GrokAuthFile>> => {
    const read = await readPrivateJsonFile(location.authFile);
    if (read.kind === "none") return { kind: "credential", raw: null };
    if (read.kind === "unreadable" || !isRecord(read.value)) return { kind: "unreadable" };
    return { kind: "credential", raw: read.value };
  };

  const locate = (cliProfileId: string): GrokLocation => {
    const current = resolveStore();
    if (cliProfileId === GROK_CLI_PERSONAL_PROFILE_ID) {
      return {
        homeDir: current.personalHomeDir,
        authFile: join(current.personalHomeDir, GROK_CLI_AUTH_FILE),
      };
    }
    return grokCliManagedProfilePaths(current.rootDir, cliProfileId);
  };

  return {
    provider: "xai",
    runtime: "grok",
    personalId: GROK_CLI_PERSONAL_PROFILE_ID,
    labels: { cliLabel: "Grok", loginHint: "grok login" },
    get store() {
      return resolveStore();
    },
    get leases() {
      return resolveLeases();
    },
    codec,
    // Every Grok rotation rewrites auth.json; the file watcher sees all of them.
    pollWhenWatchBlind: null,
    locate,
    isManagedProfileId: isGrokCliManagedProfileId,
    async inspectCli(): Promise<CliProfileStatus[]> {
      const inspection = await resolveStore().inspect();
      const now = Date.now();
      return Promise.all(
        inspection.profiles.map(async (connection) => {
          // The store's lstat checker only knows "a private file exists"; the
          // codec knows whether it holds a login and when it lapses.
          const side = connection.connected ? await readCli(locate(connection.id)) : null;
          const canonical =
            side?.kind === "credential" ? codec.canonicalFromCli(side.raw) : null;
          return {
            id: connection.id,
            label: connection.label,
            managed: connection.managed,
            isDefault: connection.isDefault,
            connected: canonical !== null,
            expired: canonical !== null && canonical.expiresAt > 0 && canonical.expiresAt <= now,
            canRefresh: canonical !== null && canonical.refresh.length > 0,
          };
        }),
      );
    },
    readCli,
    async writeCli(location, raw) {
      // Grok keeps previous credentials on unreadable input and hot-reloads
      // the file, so a whole-file rename beside its lock is what it expects.
      await atomicWritePrivateFile(location.authFile, `${JSON.stringify(raw, null, 2)}\n`, {
        privateDirectory: location.homeDir !== resolveStore().personalHomeDir,
      });
    },
    async clearCli(location) {
      await removePrivateFile(location.authFile).catch(() => undefined);
    },
    async cliSideExists(location) {
      return fs.lstat(location.homeDir).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
    },
    mirrorPaths(location) {
      return [{ directory: location.homeDir, file: GROK_CLI_AUTH_FILE }];
    },
    cliWritePaths(location) {
      return [location.authFile];
    },
    personalProbePaths() {
      return [{ directory: resolveStore().personalHomeDir, file: GROK_CLI_AUTH_FILE }];
    },
    readCliIdentity(location) {
      return readGrokCliAccountIdentity(location.authFile).catch(
        (): NativeCliAccountIdentity => ({}),
      );
    },
    async connectTimeIdentity(canonical: CanonicalCredential): Promise<AccountIdentity> {
      // The xAI access token names the account in `sub`, which is what Pi's
      // own store hashes and what a Grok slot records as user_id.
      const subject = jwtStringClaim(canonical.access, "sub");
      const email = jwtEmailClaim(canonical.access);
      return {
        ...(subject ? { fingerprint: nativeCliAccountFingerprint(subject) } : {}),
        ...(email ? { email } : {}),
      };
    },
  };
}

export const grokAccountAdapter = createGrokAccountAdapter();
