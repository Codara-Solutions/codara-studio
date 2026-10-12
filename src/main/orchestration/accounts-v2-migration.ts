import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { PiSubscriptionProvider } from "@shared/types";
import { assertCodaraOwnedWrite, isPathInside } from "../outside-write-guard";
import { claudeCredentialCodec } from "./account-adapters/claude-credential-codec";
import { createCodexCredentialCodec } from "./account-adapters/codex-credential-codec";
import { createGrokCredentialCodec } from "./account-adapters/grok-credential-codec";
import { ensureCodexManagedHome } from "./cli-account-homes";
import {
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  type ClaudeCliAccountProfileStore,
} from "./claude-cli-account-profiles";
import {
  CLAUDE_CLI_LIVE_LOGIN_FILE,
  claudeCliVaultFile,
  claudeLoginRecordOf,
  readClaudeVaultedLogin,
} from "./claude-cli-live-login";
import {
  CODEX_CLI_ACCOUNTS_DIRECTORY,
  CODEX_CLI_AUTH_FILE,
  CODEX_CLI_PERSONAL_PROFILE_ID,
  codexCliManagedProfilePaths,
  type CodexCliAccountProfileStore,
} from "./codex-cli-account-profiles";
import type { CanonicalCredential, CredentialCodec } from "./credential-mirror";
import type { GrokCliAccountProfileStore } from "./grok-cli-account-profiles";
import { atomicWritePrivateFile, readPrivateJsonFile } from "./native-cli-atomic-file";
import { piAccountProfilePaths } from "./pi-account-auth-store";
import {
  emptyPiAccountProfilesSnapshot,
  parsePiAccountProfilesV1,
  PI_ACCOUNT_PROFILES_FILE,
  PI_ACCOUNT_PROFILES_VERSION,
  SYSTEM_CLI_PROFILE_ID,
  type PiAccountCliHalf,
  type PiAccountCoraHalf,
  type PiAccountLegacyProfile,
  type PiAccountProfile,
  type PiAccountProfileRegistry,
  type PiAccountProfilesSnapshot,
  type PiAccountTombstone,
} from "./pi-account-profiles";
import type { SystemLogin } from "./system-cli-login";

/**
 * Accounts v1 to v2, once, before the account services start (spec 11).
 *
 * v1 paired one row with the CLI's own login ("personal") and moved logins
 * in and out of the user's ~/.claude and ~/.codex. v2 never touches either:
 * a row whose account is the one the CLI is signed in to on this computer
 * becomes a System row, every other managed row keeps its login inside
 * Codara's home, and a dead old personal login is tombstoned rather than
 * carried over. Only files under Codara's home are read for secrets or
 * written; the System login is read for its identity alone.
 *
 * Crash safety: every Codara file the migration retires is copied into
 * backups/accounts-v2/<stamp>/ first, every step before the commit is
 * idempotent, the v2 registry write is the commit point, and the journal
 * written just before it lists what to retire afterwards, so a crash on
 * either side of the commit resumes cleanly at the next boot.
 */

const JOURNAL_FILE = "journal.json";
const JOURNAL_VERSION = 1;
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** An old personal login this long expired, with no live Cora copy, is dead. */
const DEAD_LOGIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PROVIDERS: readonly PiSubscriptionProvider[] = ["anthropic", "openai-codex", "xai"];

export type AccountsV2RowCase = "system" | "managed" | "dead" | "cora-only";

export interface AccountsV2Journal {
  version: typeof JOURNAL_VERSION;
  startedAt: string;
  state: "planned" | "committed" | "done";
  /** Rows given a new managed profile from an old personal login: row id to profile id. */
  materialized: Record<string, string>;
  /** Codara paths moved into the archive once the registry committed. */
  retireFiles: string[];
  /** Managed profiles whose login was a rotated-away copy of the System login. */
  retireCliProfiles: Partial<Record<PiSubscriptionProvider, string[]>>;
  /** Pi halves of rows the migration removed. */
  retirePiProfiles: string[];
  cases?: Record<string, AccountsV2RowCase>;
}

export interface AccountsV2MigrationDeps {
  /** Codara's home: the archive and every retired path live under it. */
  codaraHome: string;
  registry: PiAccountProfileRegistry;
  piRootDir: string;
  claudeStore: ClaudeCliAccountProfileStore;
  codexStore: CodexCliAccountProfileStore;
  grokStore: GrokCliAccountProfileStore;
  readSystemLogin: (provider: PiSubscriptionProvider) => Promise<SystemLogin>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface AccountsV2MigrationResult {
  migrated: boolean;
  archiveDir: string | null;
  cases: Record<string, AccountsV2RowCase>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email ? email : undefined;
}

function archiveRoot(codaraHome: string): string {
  return join(resolve(codaraHome), "backups", "accounts-v2");
}

function stampOf(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function exists(path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    () => false,
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
}

async function writeJournal(archiveDir: string, journal: AccountsV2Journal): Promise<void> {
  await atomicWritePrivateFile(join(archiveDir, JOURNAL_FILE), `${JSON.stringify(journal, null, 2)}\n`);
}

async function readJournal(archiveDir: string): Promise<AccountsV2Journal | null> {
  const value = await readJson(join(archiveDir, JOURNAL_FILE)).catch(() => null);
  if (!isRecord(value) || value.version !== JOURNAL_VERSION) return null;
  return value as unknown as AccountsV2Journal;
}

/** The newest journal that has not finished, with its archive directory. */
async function unfinishedJournal(
  codaraHome: string,
): Promise<{ archiveDir: string; journal: AccountsV2Journal } | null> {
  const root = archiveRoot(codaraHome);
  const names = await fs.readdir(root).catch(() => [] as string[]);
  for (const name of names.sort().reverse()) {
    const archiveDir = join(root, name);
    const journal = await readJournal(archiveDir);
    if (journal && journal.state !== "done") return { archiveDir, journal };
  }
  return null;
}

/**
 * Copy one Codara path into the archive, keeping its place relative to
 * Codara's home. Links are copied as links, never followed.
 */
async function archiveCopy(codaraHome: string, archiveDir: string, path: string): Promise<void> {
  if (!(await exists(path))) return;
  const target = join(archiveDir, relative(resolve(codaraHome), resolve(path)));
  if (await exists(target)) return;
  assertCodaraOwnedWrite(target);
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await fs.cp(path, target, { recursive: true, verbatimSymlinks: true, errorOnExist: false });
}

/** Move a retired Codara path into the archive; the copy made first wins. */
async function archiveMove(codaraHome: string, archiveDir: string, path: string): Promise<void> {
  if (!isPathInside(path, codaraHome)) throw new Error(`Refusing to retire ${path}`);
  if (!(await exists(path))) return;
  assertCodaraOwnedWrite(path);
  const target = join(archiveDir, relative(resolve(codaraHome), resolve(path)));
  if (await exists(target)) {
    await fs.rm(path, { recursive: true, force: true });
    return;
  }
  assertCodaraOwnedWrite(target);
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await fs.rename(path, target);
}

/** The managed profile a v1 marker file (live-login.json, active-auth.json) names. */
async function liveMarker(file: string): Promise<string | null> {
  const value = await readJson(file).catch(() => null);
  return isRecord(value) && typeof value.profileId === "string" ? value.profileId : null;
}

/**
 * The v1 marker as the archive kept it. The Claude marker leaves its place
 * before the commit (v2 reuses the name), so a run resumed after a crash
 * there must still see which managed login v1 had moved into ~/.claude.
 */
async function archivedLiveMarker(codaraHome: string, archiveDir: string, file: string): Promise<string | null> {
  const archived = join(archiveDir, relative(resolve(codaraHome), resolve(file)));
  return (await liveMarker(archived)) ?? (await liveMarker(file));
}

function sameIdentity(
  row: Pick<PiAccountLegacyProfile, "identityFingerprint" | "accountEmail">,
  system: SystemLogin,
): boolean {
  if (row.identityFingerprint && system.identityFingerprint) {
    return row.identityFingerprint === system.identityFingerprint;
  }
  const email = normalizeEmail(row.accountEmail);
  return email !== undefined && email === normalizeEmail(system.email);
}

async function readPiCanonical(
  piRootDir: string,
  rowId: string,
  codec: Pick<CredentialCodec, "provider" | "canonicalFromPi">,
): Promise<CanonicalCredential | null> {
  const { authFile } = piAccountProfilePaths(piRootDir, rowId);
  const read = await readPrivateJsonFile(authFile).catch(() => ({ kind: "unreadable" as const }));
  if (read.kind !== "value" || !isRecord(read.value)) return null;
  return codec.canonicalFromPi(read.value[codec.provider]);
}

/**
 * Drop the refresh token of a Cora copy that shares a grant family with
 * the System login: spending a rotated-away member risks the provider
 * revoking the user's own login. The access token keeps Cora working
 * until it expires.
 */
async function stripPiRefresh(
  piRootDir: string,
  rowId: string,
  provider: PiSubscriptionProvider,
): Promise<void> {
  const { authFile } = piAccountProfilePaths(piRootDir, rowId);
  const read = await readPrivateJsonFile(authFile).catch(() => ({ kind: "unreadable" as const }));
  if (read.kind !== "value" || !isRecord(read.value)) return;
  const record = read.value[provider];
  if (!isRecord(record) || typeof record.refresh !== "string" || record.refresh === "") return;
  const next = { ...read.value, [provider]: { ...record, refresh: "" } };
  await atomicWritePrivateFile(authFile, `${JSON.stringify(next, null, 2)}\n`);
}

interface ProviderContext {
  provider: PiSubscriptionProvider;
  system: SystemLogin;
  /** The managed profile v1 had moved into the user's own login, if any. */
  liveId: string | null;
  managedIds: Set<string>;
  /** v1's vault of the old personal login, when one exists. */
  personalVault: string | null;
  codec: Pick<CredentialCodec, "provider" | "canonicalFromPi">;
  vaultExpiry: (file: string) => Promise<number | null>;
}

const UNREAD_SYSTEM = (provider: PiSubscriptionProvider): SystemLogin => ({
  provider,
  home: "",
  signedIn: false,
});

async function providerContexts(
  deps: AccountsV2MigrationDeps,
  archiveDir: string,
): Promise<Map<PiSubscriptionProvider, ProviderContext>> {
  const codexCodec = createCodexCredentialCodec();
  const grokCodec = createGrokCredentialCodec();
  const contexts = new Map<PiSubscriptionProvider, ProviderContext>();
  const systemOf = async (provider: PiSubscriptionProvider) =>
    deps.readSystemLogin(provider).catch(() => UNREAD_SYSTEM(provider));

  const claudeRoot = deps.claudeStore.rootDir;
  const claudePersonal = join(claudeRoot, "personal-login.json");
  contexts.set("anthropic", {
    provider: "anthropic",
    system: await systemOf("anthropic"),
    liveId: await archivedLiveMarker(deps.codaraHome, archiveDir, join(claudeRoot, CLAUDE_CLI_LIVE_LOGIN_FILE)),
    managedIds: new Set((await deps.claudeStore.snapshot()).profiles.map((profile) => profile.id)),
    personalVault: (await exists(claudePersonal)) ? claudePersonal : null,
    codec: claudeCredentialCodec,
    vaultExpiry: async (file) => {
      const vault = await readClaudeVaultedLogin(file).catch(() => ({ kind: "unreadable" as const }));
      if (vault.kind !== "value") return null;
      return claudeLoginRecordOf(vault.login.store)?.expiresAt ?? null;
    },
  });

  const codexRoot = deps.codexStore.rootDir;
  const codexPersonal = join(codexRoot, "personal", CODEX_CLI_AUTH_FILE);
  contexts.set("openai-codex", {
    provider: "openai-codex",
    system: await systemOf("openai-codex"),
    liveId: await archivedLiveMarker(deps.codaraHome, archiveDir, join(codexRoot, "active-auth.json")),
    managedIds: new Set((await deps.codexStore.snapshot()).profiles.map((profile) => profile.id)),
    personalVault: (await exists(codexPersonal)) ? codexPersonal : null,
    codec: codexCodec,
    vaultExpiry: async (file) => {
      const read = await readPrivateJsonFile(file).catch(() => ({ kind: "unreadable" as const }));
      if (read.kind !== "value" || !isRecord(read.value)) return null;
      return codexCodec.canonicalFromCli(read.value as never)?.expiresAt ?? null;
    },
  });

  contexts.set("xai", {
    provider: "xai",
    system: await systemOf("xai"),
    // Grok gave every managed account its own home; nothing was moved into ~/.grok.
    liveId: null,
    managedIds: new Set((await deps.grokStore.snapshot()).profiles.map((profile) => profile.id)),
    personalVault: null,
    codec: grokCodec,
    vaultExpiry: async () => null,
  });
  return contexts;
}

function isPersonal(row: PiAccountLegacyProfile): boolean {
  return row.cliProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID ||
    row.cliProfileId === CODEX_CLI_PERSONAL_PROFILE_ID;
}

interface RowPlan {
  row: PiAccountLegacyProfile;
  kase: AccountsV2RowCase;
  cli: PiAccountCliHalf;
  cora: PiAccountCoraHalf;
}

/**
 * Classify every v1 row (spec 11, step 3). At most one row per provider
 * becomes the System row: the first whose identity is the System login and
 * that v1 had in the System home (personal, or the managed profile it had
 * moved there).
 */
async function classify(
  deps: AccountsV2MigrationDeps,
  rows: readonly PiAccountLegacyProfile[],
  contexts: Map<PiSubscriptionProvider, ProviderContext>,
  journal: AccountsV2Journal,
  now: number,
): Promise<RowPlan[]> {
  const systemTaken = new Set<PiSubscriptionProvider>();
  const plans: RowPlan[] = [];
  for (const row of rows) {
    const context = contexts.get(row.provider)!;
    const personal = isPersonal(row);
    const managedId = !personal && row.cliProfileId ? row.cliProfileId : null;
    const inSystemHome = personal || (managedId !== null && managedId === context.liveId);
    // A personal row whose identity cannot be compared is treated as the
    // System login's: guessing wrong there would spend its token family.
    const identityKnown =
      Boolean(row.identityFingerprint && context.system.identityFingerprint) ||
      Boolean(normalizeEmail(row.accountEmail) && normalizeEmail(context.system.email));
    const isSystem =
      context.system.signedIn &&
      inSystemHome &&
      (sameIdentity(row, context.system) || (personal && !identityKnown));
    if (isSystem && !systemTaken.has(row.provider)) {
      systemTaken.add(row.provider);
      plans.push({ row, kase: "system", cli: { kind: "system" }, cora: "borrowed" });
      continue;
    }
    if (managedId && context.managedIds.has(managedId)) {
      plans.push({
        row,
        kase: "managed",
        cli: { kind: "managed", profileId: managedId },
        cora: "linked",
      });
      continue;
    }
    if (personal) {
      const pi = await readPiCanonical(deps.piRootDir, row.id, context.codec);
      const piAlive = pi !== null && (pi.expiresAt <= 0 || pi.expiresAt > now);
      const vaultExpiry = context.personalVault ? await context.vaultExpiry(context.personalVault) : null;
      const vaultDead = vaultExpiry === null || (vaultExpiry > 0 && vaultExpiry < now - DEAD_LOGIN_AGE_MS);
      if (vaultDead && !piAlive) {
        plans.push({ row, kase: "dead", cli: { kind: "none" }, cora: "none" });
        continue;
      }
      const materialized = journal.materialized[row.id];
      if (context.personalVault && vaultExpiry !== null && materialized) {
        plans.push({
          row,
          kase: "managed",
          cli: { kind: "managed", profileId: materialized },
          cora: "linked",
        });
        continue;
      }
      plans.push({ row, kase: "cora-only", cli: { kind: "none" }, cora: pi ? "own" : "none" });
      continue;
    }
    plans.push({ row, kase: "cora-only", cli: { kind: "none" }, cora: "own" });
  }
  return plans;
}

/**
 * Give an old personal login that is still alive, and is not the System
 * login, a managed profile of its own: the vault file v1 kept is copied
 * into the new profile's place. Recorded in the journal before anything
 * else, so a resumed migration reuses the profile instead of making another.
 */
async function materializePersonalVaults(
  deps: AccountsV2MigrationDeps,
  rows: readonly PiAccountLegacyProfile[],
  contexts: Map<PiSubscriptionProvider, ProviderContext>,
  journal: AccountsV2Journal,
  archiveDir: string,
  now: number,
): Promise<void> {
  for (const row of rows) {
    if (!isPersonal(row) || journal.materialized[row.id]) continue;
    const context = contexts.get(row.provider)!;
    if (!context.personalVault || row.provider === "xai") continue;
    if (context.system.signedIn && sameIdentity(row, context.system)) continue;
    const expiry = await context.vaultExpiry(context.personalVault);
    if (expiry === null || (expiry > 0 && expiry < now - DEAD_LOGIN_AGE_MS)) continue;
    const bytes = await fs.readFile(context.personalVault);
    if (row.provider === "anthropic") {
      const { profile } = await deps.claudeStore.createProfile({ label: row.label });
      journal.materialized[row.id] = profile.id;
      await writeJournal(archiveDir, journal);
      await atomicWritePrivateFile(claudeCliVaultFile(deps.claudeStore.rootDir, profile.id), bytes);
    } else {
      const { profile } = await deps.codexStore.createProfile({ label: row.label });
      journal.materialized[row.id] = profile.id;
      await writeJournal(archiveDir, journal);
      const { homeDir, authFile } = codexCliManagedProfilePaths(deps.codexStore.rootDir, profile.id);
      await ensureCodexManagedHome({
        home: homeDir,
        root: deps.codexStore.rootDir,
        systemHome: deps.codexStore.personalHomeDir,
        ...(deps.log ? { log: deps.log } : {}),
      });
      await atomicWritePrivateFile(authFile, bytes);
    }
    deps.log?.(`[accounts] the old ${row.provider} personal login of ${row.id} moved into Codara's home`);
  }
}

/** A v1 Codex vault (accounts/<id>/auth.json) becomes the managed home's login. */
async function moveCodexVaultsIntoHomes(deps: AccountsV2MigrationDeps, plans: readonly RowPlan[]): Promise<void> {
  const root = deps.codexStore.rootDir;
  for (const plan of plans) {
    if (plan.row.provider !== "openai-codex" || plan.cli.kind !== "managed") continue;
    const paths = codexCliManagedProfilePaths(root, plan.cli.profileId);
    await ensureCodexManagedHome({
      home: paths.homeDir,
      root,
      systemHome: deps.codexStore.personalHomeDir,
      ...(deps.log ? { log: deps.log } : {}),
    });
    const vault = join(paths.profileDir, CODEX_CLI_AUTH_FILE);
    if ((await exists(vault)) && !(await exists(paths.authFile))) {
      await atomicWritePrivateFile(paths.authFile, await fs.readFile(vault));
    }
  }
}

function buildSnapshot(
  legacyDefaults: Partial<Record<PiSubscriptionProvider, string>>,
  plans: readonly RowPlan[],
  deletedAt: string,
): PiAccountProfilesSnapshot {
  const snapshot = emptyPiAccountProfilesSnapshot();
  const surviving = new Set<string>();
  for (const plan of plans) {
    if (plan.kase === "dead") {
      const tombstone: PiAccountTombstone = {
        provider: plan.row.provider,
        ...(plan.row.identityFingerprint ? { identityFingerprint: plan.row.identityFingerprint } : {}),
        deletedAt,
      };
      if (tombstone.identityFingerprint) snapshot.tombstones.push(tombstone);
      continue;
    }
    surviving.add(plan.row.id);
    const profile: PiAccountProfile = {
      id: plan.row.id,
      provider: plan.row.provider,
      label: plan.row.label,
      createdAt: plan.row.createdAt,
      updatedAt: plan.row.updatedAt,
      ...(plan.row.identityFingerprint ? { identityFingerprint: plan.row.identityFingerprint } : {}),
      ...(plan.row.accountEmail ? { accountEmail: plan.row.accountEmail } : {}),
      cli: plan.cli,
      cora: plan.cora,
    };
    snapshot.profiles.push(profile);
  }
  for (const provider of PROVIDERS) {
    const id = legacyDefaults[provider];
    if (id && surviving.has(id)) snapshot.defaults[provider] = id;
  }
  return snapshot;
}

/** Everything v1 kept that v2 no longer reads, under Codara's home only. */
async function retiredPaths(deps: AccountsV2MigrationDeps, plans: readonly RowPlan[]): Promise<string[]> {
  const claudeRoot = deps.claudeStore.rootDir;
  const codexRoot = deps.codexStore.rootDir;
  const grokRoot = deps.grokStore.rootDir;
  const paths = [
    join(deps.piRootDir, "auth.json"),
    join(claudeRoot, "personal-login.json"),
    join(claudeRoot, "active-auth.json"),
    join(claudeRoot, "personal"),
    join(codexRoot, "active-auth.json"),
    join(codexRoot, "personal"),
    join(grokRoot, "active-auth.json"),
    join(grokRoot, "personal"),
  ];
  const codexAccounts = join(codexRoot, CODEX_CLI_ACCOUNTS_DIRECTORY);
  for (const name of await fs.readdir(codexAccounts).catch(() => [] as string[])) {
    if (name.startsWith(".")) continue;
    paths.push(join(codexAccounts, name, CODEX_CLI_AUTH_FILE));
  }
  for (const plan of plans) {
    if (plan.kase === "dead") paths.push(piAccountProfilePaths(deps.piRootDir, plan.row.id).configDir);
  }
  return paths;
}

/** What the archive keeps before anything moves. */
async function archiveSources(deps: AccountsV2MigrationDeps): Promise<string[]> {
  const claudeRoot = deps.claudeStore.rootDir;
  const sources = [
    join(deps.piRootDir, PI_ACCOUNT_PROFILES_FILE),
    join(deps.piRootDir, "auth.json"),
    join(deps.piRootDir, "accounts"),
    join(claudeRoot, "account-profiles.json"),
    join(claudeRoot, CLAUDE_CLI_LIVE_LOGIN_FILE),
    join(claudeRoot, "personal-login.json"),
    join(claudeRoot, "active-auth.json"),
    join(claudeRoot, "personal"),
    join(deps.codexStore.rootDir, "account-profiles.json"),
    join(deps.codexStore.rootDir, "active-auth.json"),
    join(deps.codexStore.rootDir, "personal"),
    join(deps.grokStore.rootDir, "account-profiles.json"),
    join(deps.grokStore.rootDir, "active-auth.json"),
    join(deps.grokStore.rootDir, "personal"),
  ];
  for (const profile of (await deps.claudeStore.snapshot()).profiles) {
    sources.push(claudeCliVaultFile(claudeRoot, profile.id));
  }
  const codexAccounts = join(deps.codexStore.rootDir, CODEX_CLI_ACCOUNTS_DIRECTORY);
  for (const name of await fs.readdir(codexAccounts).catch(() => [] as string[])) {
    if (!name.startsWith(".")) sources.push(join(codexAccounts, name, CODEX_CLI_AUTH_FILE));
  }
  return sources;
}

/** After the commit: retire what the journal lists. Safe to repeat. */
async function finish(
  deps: AccountsV2MigrationDeps,
  archiveDir: string,
  journal: AccountsV2Journal,
): Promise<void> {
  const log = deps.log ?? (() => undefined);
  for (const [provider, ids] of Object.entries(journal.retireCliProfiles) as Array<
    [PiSubscriptionProvider, string[]]
  >) {
    const store =
      provider === "anthropic" ? deps.claudeStore : provider === "openai-codex" ? deps.codexStore : deps.grokStore;
    for (const id of ids) {
      try {
        if ((await store.snapshot()).defaultProfileId === id) await store.setDefaultProfile(SYSTEM_CLI_PROFILE_ID);
        await store.deleteProfile(id);
      } catch (error) {
        log(`[accounts] could not retire the ${provider} profile ${id}: ${errorText(error)}`);
      }
    }
  }
  for (const path of [...journal.retireFiles, ...journal.retirePiProfiles]) {
    await archiveMove(deps.codaraHome, archiveDir, path).catch((error: unknown) => {
      log(`[accounts] could not archive ${path}: ${errorText(error)}`);
    });
  }
  journal.state = "done";
  await writeJournal(archiveDir, journal);
}

/** Archives of finished migrations older than 30 days go. */
async function purgeOldArchives(codaraHome: string, now: Date): Promise<void> {
  const root = archiveRoot(codaraHome);
  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    const archiveDir = join(root, name);
    const journal = await readJournal(archiveDir);
    if (!journal || journal.state !== "done") continue;
    const started = Date.parse(journal.startedAt);
    if (!Number.isFinite(started) || now.getTime() - started < ARCHIVE_RETENTION_MS) continue;
    assertCodaraOwnedWrite(archiveDir);
    await fs.rm(archiveDir, { recursive: true, force: true });
  }
}

export async function migrateAccountsToV2(
  deps: AccountsV2MigrationDeps,
): Promise<AccountsV2MigrationResult> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => undefined);
  const registryFile = join(deps.piRootDir, PI_ACCOUNT_PROFILES_FILE);
  const pending = await unfinishedJournal(deps.codaraHome);

  if (!(await deps.registry.needsMigration())) {
    if (pending && pending.journal.state === "committed") {
      await finish(deps, pending.archiveDir, pending.journal);
    }
    await purgeOldArchives(deps.codaraHome, now).catch(() => undefined);
    return { migrated: false, archiveDir: pending?.archiveDir ?? null, cases: pending?.journal.cases ?? {} };
  }
  if (!(await exists(registryFile))) {
    return { migrated: false, archiveDir: null, cases: {} };
  }

  const archiveDir = pending?.archiveDir ?? join(archiveRoot(deps.codaraHome), stampOf(now));
  const journal: AccountsV2Journal = pending?.journal ?? {
    version: JOURNAL_VERSION,
    startedAt: now.toISOString(),
    state: "planned",
    materialized: {},
    retireFiles: [],
    retireCliProfiles: {},
    retirePiProfiles: [],
  };
  await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
  await writeJournal(archiveDir, journal);

  // 1. Archive copies of every v1 Codara account file.
  for (const source of await archiveSources(deps)) {
    await archiveCopy(deps.codaraHome, archiveDir, source);
  }

  const legacy = parsePiAccountProfilesV1(await readJson(registryFile));
  // 2. Who each CLI is signed in as on this computer (identity only).
  const contexts = await providerContexts(deps, archiveDir);
  await materializePersonalVaults(deps, legacy.profiles, contexts, journal, archiveDir, now.getTime());
  // 3. Classify.
  const plans = await classify(deps, legacy.profiles, contexts, journal, now.getTime());
  await moveCodexVaultsIntoHomes(deps, plans);
  for (const plan of plans) {
    if (plan.kase === "system") await stripPiRefresh(deps.piRootDir, plan.row.id, plan.row.provider);
  }
  // v1's marker named a login in ~/.claude; v2 reuses the file name for the
  // live slot, so the old one must be gone before v2 can read it.
  await archiveMove(deps.codaraHome, archiveDir, join(deps.claudeStore.rootDir, CLAUDE_CLI_LIVE_LOGIN_FILE));

  journal.cases = Object.fromEntries(plans.map((plan) => [plan.row.id, plan.kase]));
  journal.retireFiles = await retiredPaths(deps, plans);
  journal.retirePiProfiles = [];
  journal.retireCliProfiles = {};
  for (const plan of plans) {
    const managedId = plan.row.cliProfileId;
    if (plan.kase !== "system" || !managedId || isPersonal(plan.row)) continue;
    (journal.retireCliProfiles[plan.row.provider] ??= []).push(managedId);
  }
  await writeJournal(archiveDir, journal);

  // 4 and 5. Defaults and the commit.
  const next = buildSnapshot(legacy.defaults, plans, now.toISOString());
  const { committed } = await deps.registry.commitMigration(next);
  if (!committed) {
    log("[accounts] the registry was already version 2; the migration did not overwrite it");
  }
  journal.state = "committed";
  await writeJournal(archiveDir, journal);
  // 6. Retire, then purge old archives.
  await finish(deps, archiveDir, journal);
  await purgeOldArchives(deps.codaraHome, now).catch(() => undefined);
  log(
    `[accounts] migrated accounts to version ${PI_ACCOUNT_PROFILES_VERSION}: ${plans
      .map((plan) => `${plan.row.provider}:${plan.kase}`)
      .join(", ")}`,
  );
  return { migrated: committed, archiveDir, cases: journal.cases };
}
