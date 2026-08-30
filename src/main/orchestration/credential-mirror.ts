import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PiSubscriptionProvider } from "@shared/types";
import {
  loadPiAuthStorage,
  type PiAuthStorageLoader,
  type PiOAuthCredential,
} from "./pi-auth-storage";

/**
 * Keeps the two halves of one account converged: the Pi credential
 * (pi-agent/accounts/<coraId>/auth.json) and the CLI credential (the slot
 * the provider's adapter locates: a CLAUDE_CONFIG_DIR, a Grok home, a Codex
 * vault or live file).
 *
 * Both sides refresh the same OAuth grant independently and every provider
 * here rotates or may rotate refresh tokens, so whichever side refreshed
 * last holds the only refresh token that still works. The mirror copies that
 * side over the other. The rules are deliberately small:
 *
 *  - The same access token on both sides is "in sync" before anything else
 *    is compared, which absorbs Pi's client-clock expiry drifting from the
 *    expiry a JWT carries.
 *  - "Newer" means a strictly greater expiry; an equal expiry falls back to a
 *    greater issue time when both sides report one. Equal expiry with
 *    different tokens is a conflict the mirror never resolves by writing
 *    (the next rotation on either side breaks the tie).
 *  - A side without a refresh token never wins over a side with one.
 *  - A Pi write goes through Pi's own AuthStorage lock and repeats the
 *    comparison inside it, so a Pi session refreshing at the same moment is
 *    never clobbered. A CLI write goes through the adapter's atomic store,
 *    re-reading the slot immediately before writing it.
 *  - The personal slot is the user's own login: the mirror updates a
 *    credential that exists there but never creates one, and the only
 *    deletion it propagates is that slot going from credential to none,
 *    which signs Account 1 out of Cora as well.
 *  - A credential that names another account than the row (a `codex login`
 *    as someone else while a managed profile owns the live file) is never
 *    copied in either direction: the row keeps its identity and the mirror
 *    logs the foreign login instead of adopting it.
 *  - Unparsable or half-written files are "unreadable", not "empty": the
 *    reconcile retries briefly and never writes on unreadable input.
 *
 * Provider shapes live in the codecs; this module only compares and copies.
 */

const UNREADABLE_RETRIES = 5;
const UNREADABLE_RETRY_DELAY_MS = 250;
const DEBOUNCE_MS = 300;

export interface CanonicalCredential {
  access: string;
  /** Empty when the side holds no refresh token. */
  refresh: string;
  /** Raw expiry in epoch ms, as the provider issued it. */
  expiresAt: number;
  /** Issue time in epoch ms when the credential reports one; breaks an expiry tie. */
  issuedAt?: number;
  /**
   * Provider fields that must survive a cross-side write (a Codex id_token
   * and account id, Grok slot metadata). Never compared, only carried.
   */
  extra?: Record<string, unknown>;
}

/**
 * One provider's shape conversions. `Raw` is the CLI slot's parsed file (or
 * record) as the adapter reads and writes it.
 */
export interface CredentialCodec<Raw = unknown> {
  /** The key inside a Pi auth.json this codec reads and writes. */
  readonly provider: PiSubscriptionProvider;
  canonicalFromPi(record: unknown): CanonicalCredential | null;
  piRecordFromCanonical(
    canonical: CanonicalCredential,
    previousPi?: unknown,
  ): PiOAuthCredential;
  canonicalFromCli(raw: Raw | null | undefined): CanonicalCredential | null;
  /**
   * The CLI record to write, merged into the previous one (previous wins for
   * every field the credential does not replace). Null means the codec
   * cannot produce a usable file from this credential alone (no previous
   * file to inherit mandatory fields from); the caller writes nothing.
   */
  cliRecordFromCanonical(canonical: CanonicalCredential, previousRaw?: Raw | null): Raw | null;
}

export type CredentialComparison =
  | "equal"
  | "pi-newer"
  | "cli-newer"
  | "conflict"
  | "pi-only"
  | "cli-only"
  | "none";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function compareCredentials(
  pi: CanonicalCredential | null,
  cli: CanonicalCredential | null,
): CredentialComparison {
  if (!pi && !cli) return "none";
  if (!pi) return "cli-only";
  if (!cli) return "pi-only";
  // The same access token is the same grant state whatever each side thinks
  // the expiry is; Pi stores a client-clock expiry a JWT's exp can drift from.
  if (pi.access === cli.access) return "equal";
  const piRefreshable = pi.refresh.length > 0;
  const cliRefreshable = cli.refresh.length > 0;
  if (piRefreshable !== cliRefreshable) {
    return piRefreshable ? "pi-newer" : "cli-newer";
  }
  if (pi.expiresAt > cli.expiresAt) return "pi-newer";
  if (pi.expiresAt < cli.expiresAt) return "cli-newer";
  if (pi.issuedAt !== undefined && cli.issuedAt !== undefined && pi.issuedAt !== cli.issuedAt) {
    return pi.issuedAt > cli.issuedAt ? "pi-newer" : "cli-newer";
  }
  return "conflict";
}

/** A directory to watch, optionally for one basename only. */
export interface MirrorWatchTarget {
  directory: string;
  file?: string;
}

export type CliSideRead<Raw> =
  | { kind: "unreadable" }
  /** The slot holds a login of an account other than the profile's. */
  | { kind: "foreign" }
  | { kind: "credential"; raw: Raw | null };

/**
 * The slice of a provider adapter the mirror needs. Locations are opaque to
 * the mirror: it hands them back to the adapter that produced them.
 */
export interface CredentialMirrorAdapter<Loc = unknown, Raw = unknown> {
  readonly provider: PiSubscriptionProvider;
  /** The CLI profile id of the user's own login; that slot is never created. */
  readonly personalId: string;
  readonly codec: CredentialCodec<Raw>;
  /**
   * Poll cadence for a slot no file watcher can see (the Claude Keychain on
   * macOS); null when every rotation produces a file event.
   */
  readonly pollWhenWatchBlind: { activeMs: number; idleMs: number } | null;
  readCli(location: Loc): Promise<CliSideRead<Raw>>;
  writeCli(location: Loc, raw: Raw): Promise<void>;
  /** Whether the managed side still exists; a gone one is never rebuilt. */
  cliSideExists(location: Loc): Promise<boolean>;
  mirrorPaths(location: Loc): MirrorWatchTarget[];
  /** Every path a writeCli may touch, for self-write suppression. */
  cliWritePaths(location: Loc): string[];
  /**
   * Serialize the re-read-then-write step against the provider's own slot
   * mutations (a Codex switch moving auth.json), when it has any.
   */
  lockCli?<T>(location: Loc, operation: () => Promise<T>): Promise<T>;
  /**
   * The identity fingerprint a credential carries, when the provider's
   * tokens name the account locally (a Codex account id, a Grok subject).
   * Undefined when only a network lookup could tell (Claude).
   */
  fingerprintOf?(canonical: CanonicalCredential): string | undefined;
  /**
   * The personal slot went from credential to none and Cora followed. A
   * provider that keeps a trailing copy of that slot (the Codex vault)
   * drops it here, so the logged-out login cannot come back on a switch.
   */
  afterPersonalLogout?(location: Loc): Promise<void>;
}

export interface CredentialPair<Loc = unknown, Raw = unknown> {
  provider: PiSubscriptionProvider;
  coraProfileId: string;
  cliProfileId: string;
  /** Main-process-only paths; nothing here ever crosses IPC. */
  authFile: string;
  location: Loc;
  adapter: CredentialMirrorAdapter<Loc, Raw>;
  /** The row's account fingerprint; a CLI credential of another account is never adopted. */
  identityFingerprint?: string;
}

export function isPersonalPair(
  pair: Pick<CredentialPair, "cliProfileId" | "adapter">,
): boolean {
  return pair.cliProfileId === pair.adapter.personalId;
}

export type PiSideRead =
  | { kind: "unreadable" }
  | { kind: "credential"; canonical: CanonicalCredential | null };

/**
 * Plain read outside Pi's lock: a missing file or a file without the
 * provider's entry is "no credential"; bytes that do not parse are unreadable
 * (Pi writes in place, so a reader can observe a half-written file).
 */
export async function readPiSide(
  authFile: string,
  codec: Pick<CredentialCodec, "provider" | "canonicalFromPi">,
): Promise<PiSideRead> {
  let raw: string;
  try {
    raw = await fs.readFile(authFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "credential", canonical: null };
    }
    return { kind: "unreadable" };
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
    if (!isRecord(parsed)) return { kind: "unreadable" };
    return { kind: "credential", canonical: codec.canonicalFromPi(parsed[codec.provider]) };
  } catch {
    // JSON.parse quotes the text it choked on; the bytes stay out of any error.
    return { kind: "unreadable" };
  }
}

export interface ReconcilePairOptions {
  loadAuthStorage?: PiAuthStorageLoader;
  /**
   * Whether the last observation of the CLI side held a credential. Only the
   * personal pair consults it: a credential-to-none transition there is a
   * CLI logout, the one deletion the mirror propagates.
   */
  previousCliPresent?: boolean;
  retryDelayMs?: number;
  /**
   * Consulted right before every write. The mirror answers true once the
   * pair was unwatched (an account mid-delete) so a reconcile that was
   * already between its reads and its write cannot re-create a half.
   */
  cancelled?: () => boolean;
  log?: (message: string) => void;
}

export interface ReconcilePairResult {
  /** "foreign": the CLI side names another account; nothing was written. */
  verdict: CredentialComparison | "unreadable" | "foreign";
  wrote: "pi" | "cli" | "pi-delete" | null;
  piPresent: boolean;
  cliPresent: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** At most one write, in the winning direction, and never on unreadable input. */
export async function reconcilePair<Loc, Raw>(
  pair: CredentialPair<Loc, Raw>,
  options: ReconcilePairOptions = {},
): Promise<ReconcilePairResult> {
  const { adapter } = pair;
  const { codec } = adapter;
  const retryDelay = options.retryDelayMs ?? UNREADABLE_RETRY_DELAY_MS;
  let pi: PiSideRead = { kind: "unreadable" };
  let cli: CliSideRead<Raw> = { kind: "unreadable" };
  for (let attempt = 0; attempt <= UNREADABLE_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(retryDelay);
    [pi, cli] = await Promise.all([
      readPiSide(pair.authFile, codec),
      adapter.readCli(pair.location),
    ]);
    if (pi.kind === "credential" && cli.kind !== "unreadable") break;
  }
  if (pi.kind !== "credential" || cli.kind === "unreadable") {
    return { verdict: "unreadable", wrote: null, piPresent: false, cliPresent: false };
  }
  const piCanonical = pi.canonical;
  // A row's identity is fixed at pairing time. A CLI credential of another
  // account (an external login into a slot this row owns) must not become
  // the row's Cora half, and the row's Cora half must not overwrite it.
  const isForeign = (canonical: CanonicalCredential | null): boolean => {
    if (!canonical || !pair.identityFingerprint || !adapter.fingerprintOf) return false;
    const fingerprint = adapter.fingerprintOf(canonical);
    return fingerprint !== undefined && fingerprint !== pair.identityFingerprint;
  };
  const foreignResult = (): ReconcilePairResult => {
    options.log?.(
      `[accounts] the ${codec.provider} CLI slot of ${pair.coraProfileId} holds another account's login; leaving both halves alone`,
    );
    return { verdict: "foreign", wrote: null, piPresent: piCanonical !== null, cliPresent: false };
  };
  if (cli.kind === "foreign") return foreignResult();
  const cliCanonical = codec.canonicalFromCli(cli.raw);
  if (isForeign(cliCanonical)) return foreignResult();
  const verdict = compareCredentials(piCanonical, cliCanonical);
  const personal = isPersonalPair(pair);
  const result: ReconcilePairResult = {
    verdict,
    wrote: null,
    piPresent: piCanonical !== null,
    cliPresent: cliCanonical !== null,
  };
  const lock = adapter.lockCli
    ? <T>(operation: () => Promise<T>) => adapter.lockCli!(pair.location, operation)
    : <T>(operation: () => Promise<T>) => operation();

  if (verdict === "conflict") {
    options.log?.(
      `[accounts] credential conflict for ${pair.coraProfileId}: both sides expire together with different tokens; leaving both alone`,
    );
    return result;
  }
  if (verdict === "equal" || verdict === "none") return result;

  if (verdict === "pi-only" && personal) {
    // The personal slot belongs to the user. A credential that was there and
    // is gone now is a CLI logout; one that was never there is not Codara's
    // to create.
    if (options.previousCliPresent === true && !options.cancelled?.()) {
      const AuthStorage = await (options.loadAuthStorage ?? loadPiAuthStorage)();
      await AuthStorage.create(pair.authFile).delete(codec.provider);
      await chmodPrivate(pair.authFile);
      result.wrote = "pi-delete";
      await adapter.afterPersonalLogout?.(pair.location).catch(() => undefined);
    }
    return result;
  }

  if (verdict === "pi-newer" || verdict === "pi-only") {
    // A managed half is created by ensureCliHalf alone. Its directory being
    // gone here means the account is mid-delete; writing would resurrect it.
    if (!personal && !(await adapter.cliSideExists(pair.location))) return result;
    await lock(async () => {
      // The CLI side has no lock of its own to repeat the comparison under,
      // and the read above can be tens of milliseconds old. Read it again
      // immediately before writing so a terminal that refreshed in between
      // (rotating the refresh token Pi still holds) is not overwritten with
      // the token it just retired; the next reconcile then runs the other way.
      const latest = await adapter.readCli(pair.location);
      if (latest.kind !== "credential") return;
      const latestCanonical = codec.canonicalFromCli(latest.raw);
      if (isForeign(latestCanonical)) return;
      const latestVerdict = compareCredentials(piCanonical, latestCanonical);
      result.verdict = latestVerdict;
      result.cliPresent = latestCanonical !== null;
      if (latestVerdict !== "pi-newer" && (latestVerdict !== "pi-only" || personal)) return;
      if (options.cancelled?.()) return;
      const record = codec.cliRecordFromCanonical(piCanonical!, latest.raw);
      if (record === null) {
        options.log?.(
          `[accounts] the ${codec.provider} CLI slot of ${pair.coraProfileId} cannot be created from the Cora credential alone; sharing the login grows it`,
        );
        return;
      }
      await adapter.writeCli(pair.location, record);
      result.wrote = "cli";
    });
    return result;
  }

  // cli-newer or cli-only. The winner is read again under the slot lock, so
  // a switch that moved the live file since the read above (Codex) cannot
  // attribute another profile's login to this pair, and the comparison is
  // repeated under Pi's lock so a Pi refresh that landed in the meantime
  // wins instead of being undone.
  if (options.cancelled?.()) return result;
  const AuthStorage = await (options.loadAuthStorage ?? loadPiAuthStorage)();
  await lock(async () => {
    const latest = await adapter.readCli(pair.location);
    if (latest.kind !== "credential") return;
    const winner = codec.canonicalFromCli(latest.raw);
    if (isForeign(winner)) return;
    const latestVerdict = compareCredentials(piCanonical, winner);
    result.verdict = latestVerdict;
    result.cliPresent = winner !== null;
    if (!winner || (latestVerdict !== "cli-newer" && latestVerdict !== "cli-only")) return;
    let written = false;
    await AuthStorage.create(pair.authFile).modify(codec.provider, async (current) => {
      if (options.cancelled?.()) return undefined;
      const underLock = compareCredentials(codec.canonicalFromPi(current), winner);
      if (underLock !== "cli-newer" && underLock !== "cli-only") return undefined;
      written = true;
      return codec.piRecordFromCanonical(winner, current);
    });
    await chmodPrivate(pair.authFile);
    if (written) result.wrote = "pi";
  });
  return result;
}

async function chmodPrivate(path: string): Promise<void> {
  if (process.platform === "win32") return;
  await fs.chmod(path, 0o600).catch(() => undefined);
}

async function hashFile(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await fs.readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

export interface CredentialMirrorChange {
  provider: PiSubscriptionProvider;
  coraProfileId: string;
  cliProfileId: string;
  wrote: NonNullable<ReconcilePairResult["wrote"]>;
}

export interface CredentialMirrorActivity {
  /** Whether a pair is the active account, which shortens its poll interval. */
  isActive?: (coraProfileId: string) => boolean | Promise<boolean>;
  /** Whether a terminal currently runs on the pair's CLI profile. */
  isLeased?: (cliProfileId: string) => boolean;
}

export interface CredentialMirrorOptions {
  loadAuthStorage?: PiAuthStorageLoader;
  /**
   * Test seam: overrides every adapter's watch-blind poll cadence; null
   * disables polling entirely.
   */
  pollWhenWatchBlind?: { activeMs: number; idleMs: number } | null;
  debounceMs?: number;
  retryDelayMs?: number;
  log?: (message: string) => void;
}

interface PairState {
  pair: CredentialPair;
  watchers: FSWatcher[];
  debounce: NodeJS.Timeout | null;
  poll: NodeJS.Timeout | null;
  /** When the poll last reconciled; the idle cadence is measured from here. */
  lastPolledAt: number;
  tail: Promise<void>;
  /** sha256 of the bytes the mirror itself last produced, per target path. */
  lastWritten: Map<string, string>;
  cliPresent: boolean | undefined;
  conflictLogged: boolean;
}

function samePair(left: CredentialPair, right: CredentialPair): boolean {
  return (
    left.provider === right.provider &&
    left.cliProfileId === right.cliProfileId &&
    left.authFile === right.authFile &&
    left.identityFingerprint === right.identityFingerprint
  );
}

/** One mirror serves every provider; pairs carry the adapter that owns them. */
export class CredentialMirror {
  private readonly pairs = new Map<string, PairState>();
  private readonly listeners = new Set<(change: CredentialMirrorChange) => void>();
  private readonly activity = new Map<PiSubscriptionProvider, CredentialMirrorActivity>();
  private options: CredentialMirrorOptions;
  private stopped = false;

  constructor(options: CredentialMirrorOptions = {}) {
    this.options = options;
  }

  /**
   * The busy signals behind the poll cadence, per provider. The production
   * singleton is built before the lease registries and the account registry
   * are loaded, so each account service wires them in once it resolves the
   * mirror.
   */
  setActivity(provider: PiSubscriptionProvider, hooks: CredentialMirrorActivity): void {
    this.activity.set(provider, { ...this.activity.get(provider), ...hooks });
  }

  onChanged(listener: (change: CredentialMirrorChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pairFor(coraProfileId: string): CredentialPair | undefined {
    return this.pairs.get(coraProfileId)?.pair;
  }

  pairForCliProfile(
    provider: PiSubscriptionProvider,
    cliProfileId: string,
  ): CredentialPair | undefined {
    for (const state of this.pairs.values()) {
      if (state.pair.provider === provider && state.pair.cliProfileId === cliProfileId) {
        return state.pair;
      }
    }
    return undefined;
  }

  watchedPairs(provider?: PiSubscriptionProvider): CredentialPair[] {
    return [...this.pairs.values()]
      .filter((state) => provider === undefined || state.pair.provider === provider)
      .map((state) => ({ ...state.pair }));
  }

  /** Arm watchers for a pair (replacing any earlier registration of the id). */
  watch(pair: CredentialPair): void {
    this.stopped = false;
    const existing = this.pairs.get(pair.coraProfileId);
    if (existing) {
      if (samePair(existing.pair, pair)) {
        if (existing.watchers.length === 0) this.arm(existing);
        return;
      }
      void this.unwatch(pair.coraProfileId);
    }
    const state: PairState = {
      pair: { ...pair },
      watchers: [],
      debounce: null,
      poll: null,
      lastPolledAt: Date.now(),
      tail: Promise.resolve(),
      lastWritten: new Map(),
      cliPresent: undefined,
      conflictLogged: false,
    };
    this.pairs.set(pair.coraProfileId, state);
    this.arm(state);
  }

  /**
   * Drop a pair. Resolves once a reconcile already in flight for it has
   * finished, so a caller about to remove the pair's files can wait for the
   * last read to land (the write side is refused through `cancelled`).
   */
  unwatch(coraProfileId: string): Promise<void> {
    const state = this.pairs.get(coraProfileId);
    if (!state) return Promise.resolve();
    this.disarm(state);
    this.pairs.delete(coraProfileId);
    return state.tail;
  }

  /** Close and re-create every watcher; used after sleep and after account mutations. */
  rearm(): void {
    if (this.stopped) return;
    for (const state of this.pairs.values()) {
      this.disarm(state);
      this.arm(state);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.pairs.values()) this.disarm(state);
    this.pairs.clear();
  }

  /** Reconcile one pair now, serialized behind any in-flight reconcile of it. */
  reconcileNow(coraProfileId: string): Promise<ReconcilePairResult | null> {
    const state = this.pairs.get(coraProfileId);
    if (!state) return Promise.resolve(null);
    return this.enqueue(state);
  }

  reconcileCliProfile(
    provider: PiSubscriptionProvider,
    cliProfileId: string,
  ): Promise<ReconcilePairResult | null> {
    const pair = this.pairForCliProfile(provider, cliProfileId);
    return pair ? this.reconcileNow(pair.coraProfileId) : Promise.resolve(null);
  }

  async reconcileAll(provider?: PiSubscriptionProvider): Promise<void> {
    await Promise.all(
      [...this.pairs.values()]
        .filter((state) => provider === undefined || state.pair.provider === provider)
        .map((state) => this.reconcileNow(state.pair.coraProfileId).catch(() => null)),
    );
  }

  private enqueue(state: PairState): Promise<ReconcilePairResult | null> {
    const run = state.tail.then(() => this.reconcile(state));
    state.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reconcile(state: PairState): Promise<ReconcilePairResult | null> {
    if (this.stopped || this.pairs.get(state.pair.coraProfileId) !== state) return null;
    let result: ReconcilePairResult;
    try {
      result = await reconcilePair(state.pair, {
        ...(this.options.loadAuthStorage
          ? { loadAuthStorage: this.options.loadAuthStorage }
          : {}),
        ...(state.cliPresent !== undefined ? { previousCliPresent: state.cliPresent } : {}),
        ...(this.options.retryDelayMs !== undefined
          ? { retryDelayMs: this.options.retryDelayMs }
          : {}),
        cancelled: () => this.stopped || this.pairs.get(state.pair.coraProfileId) !== state,
        log: (message) => {
          if (state.conflictLogged) return;
          state.conflictLogged = true;
          this.options.log?.(message);
        },
      });
    } catch (error) {
      this.options.log?.(
        `[accounts] credential reconcile failed for ${state.pair.coraProfileId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    if (result.verdict !== "unreadable") {
      state.cliPresent = result.cliPresent;
      if (result.verdict !== "conflict" && result.verdict !== "foreign") {
        state.conflictLogged = false;
      }
    }
    if (result.wrote === "cli") {
      for (const path of state.pair.adapter.cliWritePaths(state.pair.location)) {
        await this.remember(state, path);
      }
    } else if (result.wrote === "pi" || result.wrote === "pi-delete") {
      await this.remember(state, state.pair.authFile);
    }
    if (result.wrote) {
      const change: CredentialMirrorChange = {
        provider: state.pair.provider,
        coraProfileId: state.pair.coraProfileId,
        cliProfileId: state.pair.cliProfileId,
        wrote: result.wrote,
      };
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch {
          // A listener failure must not stop the mirror.
        }
      }
    }
    return result;
  }

  private async remember(state: PairState, path: string): Promise<void> {
    const digest = await hashFile(path);
    if (digest) state.lastWritten.set(path, digest);
    else state.lastWritten.delete(path);
  }

  private arm(state: PairState): void {
    if (this.stopped) return;
    const targets: MirrorWatchTarget[] = [
      { directory: dirname(state.pair.authFile), file: basename(state.pair.authFile) },
      ...state.pair.adapter.mirrorPaths(state.pair.location),
    ];
    for (const target of targets) {
      let watcher: FSWatcher;
      try {
        watcher = watch(target.directory, { persistent: false, recursive: false });
      } catch {
        // A directory that does not exist yet (a managed profile mid-creation,
        // a personal home with no login) is picked up by the next rearm.
        continue;
      }
      watcher.on("change", (_event, filename) => {
        const name = typeof filename === "string" ? filename : filename?.toString();
        if (target.file !== undefined && name !== undefined && name !== target.file) return;
        const changed = join(target.directory, target.file ?? name ?? "");
        void this.onFileEvent(state, changed);
      });
      watcher.on("error", () => {
        watcher.close();
        state.watchers = state.watchers.filter((entry) => entry !== watcher);
      });
      state.watchers.push(watcher);
    }
    this.schedulePoll(state);
  }

  private disarm(state: PairState): void {
    for (const watcher of state.watchers) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
    state.watchers = [];
    if (state.debounce) {
      clearTimeout(state.debounce);
      state.debounce = null;
    }
    if (state.poll) {
      clearTimeout(state.poll);
      state.poll = null;
    }
  }

  private async onFileEvent(state: PairState, path: string): Promise<void> {
    if (this.stopped || this.pairs.get(state.pair.coraProfileId) !== state) return;
    const remembered = state.lastWritten.get(path);
    if (remembered) {
      const digest = await hashFile(path);
      if (digest === remembered) return;
    }
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => {
      state.debounce = null;
      void this.enqueue(state).catch(() => null);
    }, this.options.debounceMs ?? DEBOUNCE_MS);
    state.debounce.unref?.();
  }

  private pollIntervals(state: PairState): { activeMs: number; idleMs: number } | null {
    if (this.options.pollWhenWatchBlind !== undefined) return this.options.pollWhenWatchBlind;
    return state.pair.adapter.pollWhenWatchBlind;
  }

  /**
   * A slot no watcher sees (Claude Code refreshes into the Keychain on
   * macOS) is polled; that is the only way a terminal-side rotation reaches
   * Cora between the opportunistic reconciles. Busy pairs poll faster.
   *
   * One timer per pair, armed synchronously so a disarm always finds it:
   * the timer wakes at the active cadence and decides then whether the pair
   * is busy (reconcile now) or idle (reconcile once the idle interval has
   * passed since the last poll).
   */
  private schedulePoll(state: PairState): void {
    const intervals = this.pollIntervals(state);
    if (!intervals || this.stopped) return;
    if (state.poll) clearTimeout(state.poll);
    const timer = setTimeout(() => {
      if (state.poll !== timer) return;
      state.poll = null;
      void this.pollTick(state, intervals);
    }, intervals.activeMs);
    timer.unref?.();
    state.poll = timer;
  }

  private async pollTick(
    state: PairState,
    intervals: { activeMs: number; idleMs: number },
  ): Promise<void> {
    const current = () => !this.stopped && this.pairs.get(state.pair.coraProfileId) === state;
    if (!current()) return;
    const hooks = this.activity.get(state.pair.provider);
    const busy =
      (await Promise.resolve(hooks?.isActive?.(state.pair.coraProfileId)).catch(() => false)) ===
        true || hooks?.isLeased?.(state.pair.cliProfileId) === true;
    if (!current()) return;
    if (busy || Date.now() - state.lastPolledAt >= intervals.idleMs) {
      state.lastPolledAt = Date.now();
      await this.enqueue(state).catch(() => null);
    }
    // A rearm during the reconcile armed its own timer; never add a second.
    if (!current() || state.poll) return;
    this.schedulePoll(state);
  }
}

export const credentialMirror = new CredentialMirror({
  log: (message) => console.warn(message),
});
