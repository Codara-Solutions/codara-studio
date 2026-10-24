import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ensureCodexManagedHome } from "../cli-account-homes";
import {
  CODEX_CLI_ACCOUNTS_DIRECTORY,
  CODEX_CLI_AUTH_FILE,
  CODEX_CLI_PERSONAL_PROFILE_ID,
  codexCliManagedProfilePaths,
  isCodexCliManagedProfileId,
  type CodexCliAccountProfileStore,
} from "../codex-cli-account-profiles";
import type { CodexCliProfileLeaseRegistry } from "../codex-cli-profile-execution";
import { refreshCodexCredential, type CodexRefreshFetch } from "../codex-oauth-refresh";
import type { CanonicalCredential, CliSideRead } from "../credential-mirror";
import {
  atomicWritePrivateFile,
  readPrivateJsonFile,
  removePrivateFile,
} from "../native-cli-atomic-file";
import {
  jwtEmailClaim,
  nativeCliAccountFingerprint,
  readCodexCliAccountIdentity,
  type NativeCliAccountIdentity,
} from "../native-cli-account-identity";
import {
  nativeCodexProfileLeases,
  nativeCodexProfileStore,
} from "../native-codex-profile-runtime";
import { loadPiAuthStorage, type PiAuthStorageLoader } from "../pi-auth-storage";
import type { AccountIdentity, AccountProviderAdapter, CliProfileStatus } from "./account-adapter";
import {
  codexAccountIdFromAccessToken,
  createCodexCredentialCodec,
  type CodexAuthFile,
} from "./codex-credential-codec";

/**
 * Codex CLI: one CODEX_HOME per managed account under Codara's home
 * (codex-cli/accounts/<id>/home), with its shared state linked into the
 * user's own Codex home and auth.json private (cli-account-homes.ts).
 *
 * There is no live slot for Codex. A running Codex loads auth.json once and
 * keeps that account until it exits; on a 401 it reloads the file and
 * refuses to continue when the file names another account. Swapping one
 * shared file would therefore break every running session at its next
 * refresh, while a home per account keeps each session on the account it
 * started with. Activating an account only changes which home new sessions
 * start in (the shell pointer and the launch environment).
 *
 * A Cora-only account cannot become a Codex half without a refresh grant,
 * because Codex insists on an id_token pi-ai never kept.
 */

export interface CodexLocation {
  cliProfileId: string;
  rootDir: string;
  homeDir: string;
  authFile: string;
}

export interface CodexAccountAdapterOptions {
  store?: CodexCliAccountProfileStore;
  leases?: CodexCliProfileLeaseRegistry;
  loadAuthStorage?: PiAuthStorageLoader;
  /** Test seam for the refresh grant. */
  fetchImpl?: CodexRefreshFetch;
  /** Test seam for the last_refresh stamp. */
  now?: () => Date;
  log?: (message: string) => void;
}

export type CodexAccountAdapter = AccountProviderAdapter<CodexLocation, CodexAuthFile>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createCodexAccountAdapter(
  options: CodexAccountAdapterOptions = {},
): CodexAccountAdapter {
  let store: CodexCliAccountProfileStore | null = options.store ?? null;
  let leases: CodexCliProfileLeaseRegistry | null = options.leases ?? null;
  const resolveStore = (): CodexCliAccountProfileStore => {
    store ??= nativeCodexProfileStore;
    return store;
  };
  const resolveLeases = (): CodexCliProfileLeaseRegistry => {
    leases ??= nativeCodexProfileLeases;
    return leases;
  };
  const codec = createCodexCredentialCodec(options.now ? { now: options.now } : {});

  const locate = (cliProfileId: string): CodexLocation => {
    const current = resolveStore();
    if (!isCodexCliManagedProfileId(cliProfileId)) {
      return {
        cliProfileId,
        rootDir: current.rootDir,
        homeDir: current.personalHomeDir,
        authFile: current.personalAuthFile,
      };
    }
    const { homeDir, authFile } = codexCliManagedProfilePaths(current.rootDir, cliProfileId);
    return { cliProfileId, rootDir: current.rootDir, homeDir, authFile };
  };

  const readCli = async (location: CodexLocation): Promise<CliSideRead<CodexAuthFile>> => {
    // The System login's token is not Codara's to read.
    if (!isCodexCliManagedProfileId(location.cliProfileId)) return { kind: "unreadable" };
    const read = await readPrivateJsonFile(location.authFile);
    if (read.kind === "none") return { kind: "credential", raw: null };
    if (read.kind === "unreadable" || !isRecord(read.value)) return { kind: "unreadable" };
    return { kind: "credential", raw: read.value as CodexAuthFile };
  };

  const fingerprintOf = (canonical: CanonicalCredential): string | undefined => {
    const accountId =
      (typeof canonical.extra?.accountId === "string" && canonical.extra.accountId) ||
      codexAccountIdFromAccessToken(canonical.access);
    return accountId ? nativeCliAccountFingerprint(accountId) : undefined;
  };

  const prepareHome = async (cliProfileId: string): Promise<void> => {
    if (!isCodexCliManagedProfileId(cliProfileId)) return;
    const current = resolveStore();
    await ensureCodexManagedHome({
      home: codexCliManagedProfilePaths(current.rootDir, cliProfileId).homeDir,
      root: current.rootDir,
      systemHome: current.personalHomeDir,
      ...(options.log ? { log: options.log } : {}),
    });
  };

  return {
    provider: "openai-codex",
    runtime: "codex",
    systemProfileId: CODEX_CLI_PERSONAL_PROFILE_ID,
    labels: { cliLabel: "Codex", loginHint: "codex login" },
    get store() {
      return resolveStore();
    },
    get leases() {
      return resolveLeases();
    },
    codec,
    // Codex rewrites auth.json on every refresh; the watcher sees it.
    pollWhenWatchBlind: null,
    locate,
    isManagedProfileId: isCodexCliManagedProfileId,
    async inspectCli(): Promise<CliProfileStatus[]> {
      const inspection = await resolveStore().inspect();
      const now = Date.now();
      return Promise.all(
        inspection.profiles.map(async (connection) => {
          if (!connection.managed) {
            // The System login answers with presence only (the store lstats it).
            return {
              id: connection.id,
              label: connection.label,
              managed: false,
              isDefault: connection.isDefault,
              connected: connection.connected,
              expired: false,
              canRefresh: false,
            };
          }
          const side = await readCli(locate(connection.id));
          const canonical =
            side.kind === "credential" ? codec.canonicalFromCli(side.raw) : null;
          return {
            id: connection.id,
            label: connection.label,
            managed: true,
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
      if (!isCodexCliManagedProfileId(location.cliProfileId)) {
        throw new Error("The Codex System login is never written by Codara");
      }
      await atomicWritePrivateFile(location.authFile, `${JSON.stringify(raw, null, 2)}\n`);
    },
    async clearCli(location) {
      if (!isCodexCliManagedProfileId(location.cliProfileId)) return;
      await removePrivateFile(location.authFile).catch(() => undefined);
    },
    async cliSideExists(location) {
      if (!isCodexCliManagedProfileId(location.cliProfileId)) return false;
      return fs.lstat(location.homeDir).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
    },
    mirrorPaths(location) {
      // Most of a Codex home is linked shared state; only auth.json counts.
      return [{ directory: location.homeDir, file: CODEX_CLI_AUTH_FILE }];
    },
    cliWritePaths(location) {
      return [location.authFile];
    },
    fingerprintOf,
    async readCliIdentity(location) {
      if (!isCodexCliManagedProfileId(location.cliProfileId)) return {};
      return readCodexCliAccountIdentity(location.authFile).catch((): NativeCliAccountIdentity => ({}));
    },
    async connectTimeIdentity(canonical: CanonicalCredential): Promise<AccountIdentity> {
      const fingerprint = fingerprintOf(canonical);
      const email = jwtEmailClaim(canonical.extra?.idToken) ?? jwtEmailClaim(canonical.access);
      return {
        ...(fingerprint ? { fingerprint } : {}),
        ...(email ? { email } : {}),
      };
    },
    prepareCliHome: prepareHome,
    async growCliCredential(canonical, authFile, signal) {
      const refreshed = await refreshCodexCredential(canonical.refresh, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        signal,
      });
      const accountId =
        (typeof canonical.extra?.accountId === "string" && canonical.extra.accountId) ||
        codexAccountIdFromAccessToken(refreshed.access);
      const grown: CanonicalCredential = {
        access: refreshed.access,
        refresh: refreshed.refresh,
        expiresAt: refreshed.expiresAt,
        ...(refreshed.issuedAt !== undefined ? { issuedAt: refreshed.issuedAt } : {}),
        extra: {
          idToken: refreshed.idToken,
          ...(accountId ? { accountId } : {}),
          ...(typeof canonical.extra?.authMode === "string"
            ? { authMode: canonical.extra.authMode }
            : {}),
        },
      };
      // The grant rotated the refresh token: Pi must hold the new one before
      // anything else uses it. A Pi session that refreshed meanwhile holds a
      // different current refresh token and wins; this grant's tokens are
      // then dropped rather than written over a fresher rotation.
      const AuthStorage = await (options.loadAuthStorage ?? loadPiAuthStorage)();
      let written = false;
      await AuthStorage.create(authFile).modify("openai-codex", async (current) => {
        if (!isRecord(current) || current.refresh !== canonical.refresh) return undefined;
        written = true;
        return codec.piRecordFromCanonical(grown, current);
      });
      if (process.platform !== "win32") await fs.chmod(authFile, 0o600).catch(() => undefined);
      if (!written) {
        throw new Error("Cora refreshed this account while its Codex half was being prepared; try again");
      }
      return grown;
    },
    managedHome(cliProfileId) {
      const current = resolveStore();
      return {
        path: codexCliManagedProfilePaths(current.rootDir, cliProfileId).profileDir,
        accountsRoot: join(current.rootDir, CODEX_CLI_ACCOUNTS_DIRECTORY),
        holdsSessions: true,
      };
    },
    managedAccountsRoot() {
      return join(resolveStore().rootDir, CODEX_CLI_ACCOUNTS_DIRECTORY);
    },
  };
}

export const codexAccountAdapter = createCodexAccountAdapter();
