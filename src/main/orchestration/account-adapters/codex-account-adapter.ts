import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
  activateCodexCliAccount,
  codexCliPersonalAuthFile,
  readCodexCliSelection,
  withCodexSelectionLock,
} from "../codex-cli-auth-selector";
import {
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
  atomicCopyPrivateFile,
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
import { countExternalNativeCliProcesses } from "../native-cli-process-shutdown";
import {
  nativeCodexProfileLeases,
  nativeCodexProfileStore,
} from "../native-codex-profile-runtime";
import { loadPiAuthStorage, type PiAuthStorageLoader } from "../pi-auth-storage";
import { UnifiedAccountSessionsError } from "../unified-account-errors";
import type {
  AccountIdentity,
  AccountProviderAdapter,
  CliProfileStatus,
  SwitchContext,
} from "./account-adapter";
import {
  codexAccountIdFromAccessToken,
  createCodexCredentialCodec,
  type CodexAuthFile,
} from "./codex-credential-codec";

/**
 * Codex CLI keeps one state home and one auth.json for every terminal, so a
 * managed account is an auth-only vault slot (codex-cli/accounts/<id>/auth.json,
 * codex-cli/personal/auth.json for Account 1) and the marker names which
 * slot is live in ~/.codex/auth.json. Three slots, one logical credential:
 * while a profile is live, its slot is read and written through the live
 * file and the vault copy trails it; otherwise the vault is the slot.
 *
 * What differs from the per-directory CLIs: a switch has to move the live
 * file, so Codex sessions are closed first (after the caller agreed), and a
 * Cora-only account cannot become a Codex half without a refresh grant,
 * because Codex insists on an id_token pi-ai never kept.
 *
 * The live file is shared with every terminal, so a `codex login` as another
 * account while a managed profile owns it is an ordinary event. The vault
 * copy names the profile's account; a live file of a different account is
 * reported as foreign rather than as that profile's rotation.
 */

export interface CodexLocation {
  cliProfileId: string;
  vaultFile: string;
  liveFile: string;
  rootDir: string;
}

export interface CodexAccountAdapterOptions {
  store?: CodexCliAccountProfileStore;
  leases?: CodexCliProfileLeaseRegistry;
  loadAuthStorage?: PiAuthStorageLoader;
  /** Test seam for the refresh grant. */
  fetchImpl?: CodexRefreshFetch;
  /** Test seam for the count of codex processes outside Studio. */
  externalSessionCount?: () => number | Promise<number>;
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
  const externalSessionCount =
    options.externalSessionCount ?? (() => countExternalNativeCliProcesses("codex"));

  const activeId = async (rootDir: string): Promise<string> =>
    (await readCodexCliSelection(rootDir).catch(() => null)) ?? CODEX_CLI_PERSONAL_PROFILE_ID;
  const isLive = async (location: CodexLocation): Promise<boolean> =>
    (await activeId(location.rootDir)) === location.cliProfileId;

  const readFile = async (path: string): Promise<CliSideRead<CodexAuthFile>> => {
    const read = await readPrivateJsonFile(path);
    if (read.kind === "none") return { kind: "credential", raw: null };
    if (read.kind === "unreadable" || !isRecord(read.value)) return { kind: "unreadable" };
    return { kind: "credential", raw: read.value as CodexAuthFile };
  };

  const locate = (cliProfileId: string): CodexLocation => {
    const current = resolveStore();
    return {
      cliProfileId,
      rootDir: current.rootDir,
      liveFile: join(current.personalHomeDir, CODEX_CLI_AUTH_FILE),
      vaultFile:
        cliProfileId === CODEX_CLI_PERSONAL_PROFILE_ID
          ? codexCliPersonalAuthFile(current.rootDir)
          : codexCliManagedProfilePaths(current.rootDir, cliProfileId).authFile,
    };
  };

  const accountIdOf = (raw: CodexAuthFile | null): string | undefined =>
    codec.canonicalFromCli(raw)?.extra?.accountId as string | undefined;
  const fingerprintOf = (canonical: CanonicalCredential): string | undefined => {
    const accountId =
      (typeof canonical.extra?.accountId === "string" && canonical.extra.accountId) ||
      codexAccountIdFromAccessToken(canonical.access);
    return accountId ? nativeCliAccountFingerprint(accountId) : undefined;
  };

  const readCli = async (location: CodexLocation): Promise<CliSideRead<CodexAuthFile>> => {
    if (!(await isLive(location))) return readFile(location.vaultFile);
    const live = await readFile(location.liveFile);
    if (location.cliProfileId === CODEX_CLI_PERSONAL_PROFILE_ID || live.kind !== "credential") {
      return live;
    }
    // A managed profile's vault copy names its account. A live file of
    // another account is an external login into the shared slot, not this
    // profile's rotation: it is neither mirrored to Cora nor saved into the
    // profile's vault on the next switch.
    const vault = await readFile(location.vaultFile);
    const liveAccount = accountIdOf(live.raw);
    const vaultAccount = vault.kind === "credential" ? accountIdOf(vault.raw) : undefined;
    if (liveAccount && vaultAccount && liveAccount !== vaultAccount) {
      options.log?.(
        `[accounts] ~/.codex/auth.json holds a login of another account than the live Codex profile ${location.cliProfileId}`,
      );
      return { kind: "foreign" };
    }
    return live;
  };

  return {
    provider: "openai-codex",
    runtime: "codex",
    personalId: CODEX_CLI_PERSONAL_PROFILE_ID,
    labels: { cliLabel: "Codex", loginHint: "codex login" },
    get store() {
      return resolveStore();
    },
    get leases() {
      return resolveLeases();
    },
    codec,
    // Codex rewrites auth.json in place on every refresh; the watcher sees it.
    pollWhenWatchBlind: null,
    locate,
    isManagedProfileId: isCodexCliManagedProfileId,
    async inspectCli(): Promise<CliProfileStatus[]> {
      const inspection = await resolveStore().inspect();
      const now = Date.now();
      return Promise.all(
        inspection.profiles.map(async (connection) => {
          // The store checks a fixed file; the slot that answers for a profile
          // depends on the marker, so the codec reads the dynamic location.
          const side = await readCli(locate(connection.id));
          const canonical =
            side.kind === "credential" ? codec.canonicalFromCli(side.raw) : null;
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
      const contents = `${JSON.stringify(raw, null, 2)}\n`;
      if (await isLive(location)) {
        // One logical write: the live file is what Codex reads, the vault
        // copy is what the next switch saves and restores.
        await atomicWritePrivateFile(location.liveFile, contents, {
          privateDirectory: false,
        });
        await atomicCopyPrivateFile(location.liveFile, location.vaultFile);
        return;
      }
      await atomicWritePrivateFile(location.vaultFile, contents);
    },
    async clearCli(location) {
      // A revoked login must not come back on a later switch: the vault copy
      // goes with the live file.
      if (await isLive(location)) {
        await removePrivateFile(location.liveFile).catch(() => undefined);
      }
      await removePrivateFile(location.vaultFile).catch(() => undefined);
    },
    async cliSideExists(location) {
      if (location.cliProfileId === CODEX_CLI_PERSONAL_PROFILE_ID) return true;
      return fs.lstat(dirname(location.vaultFile)).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
    },
    mirrorPaths(location) {
      // ~/.codex is noisy (sessions/, history.jsonl); only auth.json counts.
      return [
        { directory: dirname(location.vaultFile), file: CODEX_CLI_AUTH_FILE },
        { directory: dirname(location.liveFile), file: CODEX_CLI_AUTH_FILE },
      ];
    },
    cliWritePaths(location) {
      return [location.liveFile, location.vaultFile];
    },
    lockCli(location, operation) {
      return withCodexSelectionLock(location.rootDir, operation);
    },
    fingerprintOf,
    async afterPersonalLogout(location) {
      if (location.cliProfileId !== CODEX_CLI_PERSONAL_PROFILE_ID) return;
      await removePrivateFile(location.vaultFile).catch(() => undefined);
    },
    personalProbePaths() {
      const current = resolveStore();
      return [
        { directory: current.personalHomeDir, file: CODEX_CLI_AUTH_FILE },
        { directory: dirname(codexCliPersonalAuthFile(current.rootDir)), file: CODEX_CLI_AUTH_FILE },
      ];
    },
    async readCliIdentity(location) {
      const file = (await isLive(location)) ? location.liveFile : location.vaultFile;
      return readCodexCliAccountIdentity(file).catch((): NativeCliAccountIdentity => ({}));
    },
    async connectTimeIdentity(canonical: CanonicalCredential): Promise<AccountIdentity> {
      const fingerprint = fingerprintOf(canonical);
      const email = jwtEmailClaim(canonical.extra?.idToken) ?? jwtEmailClaim(canonical.access);
      return {
        ...(fingerprint ? { fingerprint } : {}),
        ...(email ? { email } : {}),
      };
    },
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
    activeCliProfileId() {
      return activeId(resolveStore().rootDir);
    },
    switchSideEffects: {
      async beforeSwitch(target: string, context: SwitchContext) {
        const current = resolveStore();
        if ((await activeId(current.rootDir)) === target) return { closedSessionCount: 0 };
        const count = (await context.liveSessionCount()) + (await externalSessionCount());
        if (count === 0) return { closedSessionCount: 0 };
        if (!context.closeSessions || !context.sessionShutdown) {
          throw new UnifiedAccountSessionsError(count, "switch");
        }
        return context.sessionShutdown();
      },
      async afterDefault(target: string, effectOptions = {}) {
        const current = resolveStore();
        await activateCodexCliAccount(current, target, {
          allowSignedOut: effectOptions.allowSignedOut === true,
          profileExists: async (profileId) =>
            (await current.snapshot()).profiles.some((profile) => profile.id === profileId),
          ...(options.log ? { log: options.log } : {}),
        });
      },
    },
  };
}

export const codexAccountAdapter = createCodexAccountAdapter();
