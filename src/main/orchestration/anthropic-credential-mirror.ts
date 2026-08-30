import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  CLAUDE_CREDENTIALS_FILE,
  readClaudeCredentialRecord,
  writeClaudeCredentialRecord,
  type ClaudeCliCredentialBackend,
  type ClaudeCredentialRecord,
} from "./claude-cli-credentials";
import {
  loadPiAuthStorage,
  type PiAuthStorageLoader,
  type PiOAuthCredential,
} from "./pi-auth-storage";

/**
 * Keeps the two halves of one Anthropic account converged: the Pi credential
 * (pi-agent/accounts/<coraId>/auth.json) and the Claude Code credential
 * (the slot of the paired CLAUDE_CONFIG_DIR, or ~/.claude for Account 1).
 *
 * Both sides refresh the same OAuth grant independently and Anthropic rotates
 * refresh tokens, so whichever side refreshed last holds the only refresh
 * token that still works. The mirror copies that side over the other. The
 * rules are deliberately small:
 *
 *  - "Newer" means a strictly greater raw expiry. Equal expiry with the same
 *    tokens is in sync; equal expiry with different tokens is a conflict the
 *    mirror never resolves by writing (the next rotation on either side
 *    breaks the tie because expiry strictly increases).
 *  - A side without a refresh token never wins over a side with one.
 *  - A Pi write goes through Pi's own AuthStorage lock and repeats the
 *    comparison inside it, so a Pi session refreshing at the same moment is
 *    never clobbered. A Claude write goes through the atomic credential store.
 *  - ~/.claude is the user's own login: the mirror updates a credential that
 *    exists there but never creates one, and the only deletion it propagates
 *    is ~/.claude going from credential to none, which signs Account 1 out
 *    of Cora as well.
 *  - Unparsable or half-written files are "unreadable", not "empty": the
 *    reconcile retries briefly and never writes on unreadable input.
 */

export const PI_EXPIRY_PADDING_MS = 5 * 60 * 1000;

/** The scope list pi-ai requests for its Anthropic OAuth login, verbatim. */
export const ANTHROPIC_OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;

export const CLAUDE_CLI_PERSONAL_PROFILE_ID = "personal";
const PI_PROVIDER = "anthropic";
const UNREADABLE_RETRIES = 5;
const UNREADABLE_RETRY_DELAY_MS = 250;
const DEBOUNCE_MS = 300;
const KEYCHAIN_POLL_ACTIVE_MS = 20_000;
const KEYCHAIN_POLL_IDLE_MS = 60_000;

export interface AnthropicCanonicalCredential {
  access: string;
  /** Empty when the side holds no refresh token. */
  refresh: string;
  /** Raw expiry in epoch ms, as Anthropic issued it. */
  expiresAt: number;
}

export type CredentialComparison =
  | "equal"
  | "pi-newer"
  | "claude-newer"
  | "conflict"
  | "pi-only"
  | "claude-only"
  | "none";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function canonicalFromPi(value: unknown): AnthropicCanonicalCredential | null {
  if (!isRecord(value) || value.type !== "oauth") return null;
  if (typeof value.access !== "string" || value.access.length === 0) return null;
  if (!finite(value.expires)) return null;
  return {
    access: value.access,
    refresh: typeof value.refresh === "string" ? value.refresh : "",
    expiresAt: value.expires + PI_EXPIRY_PADDING_MS,
  };
}

export function canonicalFromClaude(
  record: ClaudeCredentialRecord | null | undefined,
): AnthropicCanonicalCredential | null {
  if (!record) return null;
  if (typeof record.accessToken !== "string" || record.accessToken.length === 0) return null;
  return {
    access: record.accessToken,
    refresh: typeof record.refreshToken === "string" ? record.refreshToken : "",
    expiresAt: finite(record.expiresAt) ? record.expiresAt : 0,
  };
}

export function piRecordFromCanonical(
  credential: AnthropicCanonicalCredential,
): PiOAuthCredential {
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expiresAt - PI_EXPIRY_PADDING_MS,
  };
}

/**
 * Every field the previous Claude record carried survives; only the tokens
 * and expiry change. Scopes are invented solely for a brand-new file, and
 * subscriptionType / rateLimitTier are never invented at all.
 */
export function claudeRecordFromCanonical(
  credential: AnthropicCanonicalCredential,
  previous?: ClaudeCredentialRecord | null,
): ClaudeCredentialRecord {
  return {
    ...(previous ?? {}),
    accessToken: credential.access,
    refreshToken: credential.refresh,
    expiresAt: credential.expiresAt,
    scopes: previous?.scopes ?? [...ANTHROPIC_OAUTH_SCOPES],
  };
}

export function compareCredentials(
  pi: AnthropicCanonicalCredential | null,
  claude: AnthropicCanonicalCredential | null,
): CredentialComparison {
  if (!pi && !claude) return "none";
  if (!pi) return "claude-only";
  if (!claude) return "pi-only";
  const piRefreshable = pi.refresh.length > 0;
  const claudeRefreshable = claude.refresh.length > 0;
  if (piRefreshable !== claudeRefreshable) {
    return piRefreshable ? "pi-newer" : "claude-newer";
  }
  if (pi.expiresAt > claude.expiresAt) return "pi-newer";
  if (pi.expiresAt < claude.expiresAt) return "claude-newer";
  return pi.access === claude.access && pi.refresh === claude.refresh
    ? "equal"
    : "conflict";
}

export interface AnthropicCredentialPair {
  coraProfileId: string;
  cliProfileId: string;
  /** Main-process-only paths; nothing here ever crosses IPC. */
  authFile: string;
  configDir: string;
  configDirEnv: string | null;
}

export function isPersonalPair(pair: Pick<AnthropicCredentialPair, "cliProfileId">): boolean {
  return pair.cliProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID;
}

type PiSideRead =
  | { kind: "unreadable" }
  | { kind: "credential"; canonical: AnthropicCanonicalCredential | null };

/**
 * Plain read outside Pi's lock: a missing file or a file without an
 * anthropic entry is "no credential"; bytes that do not parse are unreadable
 * (Pi writes in place, so a reader can observe a half-written file).
 */
export async function readPiSide(authFile: string): Promise<PiSideRead> {
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
    return { kind: "credential", canonical: canonicalFromPi(parsed[PI_PROVIDER]) };
  } catch {
    // JSON.parse quotes the text it choked on; the bytes stay out of any error.
    return { kind: "unreadable" };
  }
}

type ClaudeSideRead =
  | { kind: "unreadable" }
  | { kind: "credential"; record: ClaudeCredentialRecord | null };

export async function readClaudeSide(
  pair: Pick<AnthropicCredentialPair, "configDir" | "configDirEnv">,
  backend?: ClaudeCliCredentialBackend,
): Promise<ClaudeSideRead> {
  try {
    const record = await readClaudeCredentialRecord(pair.configDir, pair.configDirEnv, {
      ...(backend ? { backend } : {}),
    });
    return { kind: "credential", record };
  } catch {
    return { kind: "unreadable" };
  }
}

export interface ReconcilePairOptions {
  backend?: ClaudeCliCredentialBackend;
  loadAuthStorage?: PiAuthStorageLoader;
  /**
   * Whether the last observation of the Claude side held a credential. Only
   * the personal pair consults it: a credential-to-none transition there is
   * a `claude logout`, the one deletion the mirror propagates.
   */
  previousClaudePresent?: boolean;
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
  verdict: CredentialComparison | "unreadable";
  wrote: "pi" | "claude" | "pi-delete" | null;
  piPresent: boolean;
  claudePresent: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** At most one write, in the winning direction, and never on unreadable input. */
export async function reconcilePair(
  pair: AnthropicCredentialPair,
  options: ReconcilePairOptions = {},
): Promise<ReconcilePairResult> {
  const retryDelay = options.retryDelayMs ?? UNREADABLE_RETRY_DELAY_MS;
  let pi: PiSideRead = { kind: "unreadable" };
  let claude: ClaudeSideRead = { kind: "unreadable" };
  for (let attempt = 0; attempt <= UNREADABLE_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(retryDelay);
    [pi, claude] = await Promise.all([
      readPiSide(pair.authFile),
      readClaudeSide(pair, options.backend),
    ]);
    if (pi.kind === "credential" && claude.kind === "credential") break;
  }
  if (pi.kind !== "credential" || claude.kind !== "credential") {
    return { verdict: "unreadable", wrote: null, piPresent: false, claudePresent: false };
  }
  const piCanonical = pi.canonical;
  const claudeCanonical = canonicalFromClaude(claude.record);
  const verdict = compareCredentials(piCanonical, claudeCanonical);
  const personal = isPersonalPair(pair);
  const result: ReconcilePairResult = {
    verdict,
    wrote: null,
    piPresent: piCanonical !== null,
    claudePresent: claudeCanonical !== null,
  };

  if (verdict === "conflict") {
    options.log?.(
      `[accounts] credential conflict for ${pair.coraProfileId}: both sides expire together with different tokens; leaving both alone`,
    );
    return result;
  }
  if (verdict === "equal" || verdict === "none") return result;

  if (verdict === "pi-only" && personal) {
    // ~/.claude belongs to the user. A credential that was there and is gone
    // now is a `claude logout`; one that was never there is not Codara's to
    // create.
    if (options.previousClaudePresent === true && !options.cancelled?.()) {
      const AuthStorage = await (options.loadAuthStorage ?? loadPiAuthStorage)();
      await AuthStorage.create(pair.authFile).delete(PI_PROVIDER);
      await chmodPrivate(pair.authFile);
      result.wrote = "pi-delete";
    }
    return result;
  }

  if (verdict === "pi-newer" || verdict === "pi-only") {
    // A managed half is created by ensureCliHalf alone. Its directory being
    // gone here means the account is mid-delete; writing would resurrect it.
    if (!personal && !(await isDirectory(pair.configDir))) return result;
    // The Claude side has no lock to repeat the comparison under, and the
    // read above can be tens of milliseconds old on macOS. Read it again
    // immediately before writing so a terminal that refreshed in between
    // (rotating the refresh token Pi still holds) is not overwritten with
    // the token it just retired; the next reconcile then runs the other way.
    const latest = await readClaudeSide(pair, options.backend);
    if (latest.kind !== "credential") return result;
    const latestCanonical = canonicalFromClaude(latest.record);
    const latestVerdict = compareCredentials(piCanonical, latestCanonical);
    result.verdict = latestVerdict;
    result.claudePresent = latestCanonical !== null;
    if (latestVerdict !== "pi-newer" && (latestVerdict !== "pi-only" || personal)) {
      return result;
    }
    if (options.cancelled?.()) return result;
    await writeClaudeCredentialRecord(
      pair.configDir,
      pair.configDirEnv,
      claudeRecordFromCanonical(piCanonical!, latest.record),
      { ...(options.backend ? { backend: options.backend } : {}) },
    );
    result.wrote = "claude";
    return result;
  }

  // claude-newer or claude-only: the comparison is repeated under Pi's lock
  // so a Pi refresh that landed in the meantime wins instead of being undone.
  const winner = claudeCanonical!;
  if (options.cancelled?.()) return result;
  const AuthStorage = await (options.loadAuthStorage ?? loadPiAuthStorage)();
  let written = false;
  await AuthStorage.create(pair.authFile).modify(PI_PROVIDER, async (current) => {
    if (options.cancelled?.()) return undefined;
    const underLock = compareCredentials(canonicalFromPi(current), winner);
    if (underLock !== "claude-newer" && underLock !== "claude-only") return undefined;
    written = true;
    return piRecordFromCanonical(winner);
  });
  await chmodPrivate(pair.authFile);
  if (written) result.wrote = "pi";
  return result;
}

async function isDirectory(path: string): Promise<boolean> {
  return fs.lstat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
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

export interface AnthropicCredentialMirrorChange {
  coraProfileId: string;
  cliProfileId: string;
  wrote: NonNullable<ReconcilePairResult["wrote"]>;
}

export interface AnthropicCredentialMirrorOptions {
  backend?: ClaudeCliCredentialBackend;
  loadAuthStorage?: PiAuthStorageLoader;
  /** Test seam. Production reads process.platform. */
  platform?: NodeJS.Platform;
  /** Keychain poll cadence on darwin; null disables the poll entirely. */
  keychainPoll?: { activeMs: number; idleMs: number } | null;
  /** Whether a pair is the active account, which shortens its poll interval. */
  isActive?: (coraProfileId: string) => boolean | Promise<boolean>;
  /** Whether a Claude terminal currently runs on the pair's profile. */
  isLeased?: (cliProfileId: string) => boolean;
  debounceMs?: number;
  retryDelayMs?: number;
  log?: (message: string) => void;
}

interface PairState {
  pair: AnthropicCredentialPair;
  watchers: FSWatcher[];
  debounce: NodeJS.Timeout | null;
  poll: NodeJS.Timeout | null;
  /** When the poll last reconciled; the idle cadence is measured from here. */
  lastPolledAt: number;
  tail: Promise<void>;
  /** sha256 of the bytes the mirror itself last produced, per target path. */
  lastWritten: Map<string, string>;
  claudePresent: boolean | undefined;
  conflictLogged: boolean;
}

export class AnthropicCredentialMirror {
  private readonly pairs = new Map<string, PairState>();
  private readonly listeners = new Set<(change: AnthropicCredentialMirrorChange) => void>();
  private options: AnthropicCredentialMirrorOptions;
  private stopped = false;

  constructor(options: AnthropicCredentialMirrorOptions = {}) {
    this.options = options;
  }

  /**
   * The busy signals behind the poll cadence. The production singleton is
   * built before the lease registry and the account registry are loaded, so
   * the account service wires them in once it resolves the mirror.
   */
  setActivity(hooks: Pick<AnthropicCredentialMirrorOptions, "isActive" | "isLeased">): void {
    this.options = { ...this.options, ...hooks };
  }

  onChanged(listener: (change: AnthropicCredentialMirrorChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pairFor(coraProfileId: string): AnthropicCredentialPair | undefined {
    return this.pairs.get(coraProfileId)?.pair;
  }

  pairForCliProfile(cliProfileId: string): AnthropicCredentialPair | undefined {
    for (const state of this.pairs.values()) {
      if (state.pair.cliProfileId === cliProfileId) return state.pair;
    }
    return undefined;
  }

  watchedPairs(): AnthropicCredentialPair[] {
    return [...this.pairs.values()].map((state) => ({ ...state.pair }));
  }

  /** Arm watchers for a pair (replacing any earlier registration of the id). */
  watch(pair: AnthropicCredentialPair): void {
    this.stopped = false;
    const existing = this.pairs.get(pair.coraProfileId);
    if (existing) {
      const same =
        existing.pair.cliProfileId === pair.cliProfileId &&
        existing.pair.authFile === pair.authFile &&
        existing.pair.configDir === pair.configDir &&
        existing.pair.configDirEnv === pair.configDirEnv;
      if (same) {
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
      claudePresent: undefined,
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

  reconcileCliProfile(cliProfileId: string): Promise<ReconcilePairResult | null> {
    const pair = this.pairForCliProfile(cliProfileId);
    return pair ? this.reconcileNow(pair.coraProfileId) : Promise.resolve(null);
  }

  async reconcileAll(): Promise<void> {
    await Promise.all(
      [...this.pairs.keys()].map((id) => this.reconcileNow(id).catch(() => null)),
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
        ...(this.options.backend ? { backend: this.options.backend } : {}),
        ...(this.options.loadAuthStorage
          ? { loadAuthStorage: this.options.loadAuthStorage }
          : {}),
        ...(state.claudePresent !== undefined
          ? { previousClaudePresent: state.claudePresent }
          : {}),
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
      state.claudePresent = result.claudePresent;
      if (result.verdict !== "conflict") state.conflictLogged = false;
    }
    if (result.wrote === "claude") {
      await this.remember(state, claudeCredentialPath(state.pair));
    } else if (result.wrote === "pi" || result.wrote === "pi-delete") {
      await this.remember(state, state.pair.authFile);
    }
    if (result.wrote) {
      const change: AnthropicCredentialMirrorChange = {
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
    const targets: Array<{ directory: string; file: string }> = [
      { directory: dirname(state.pair.authFile), file: basename(state.pair.authFile) },
      { directory: state.pair.configDir, file: CLAUDE_CREDENTIALS_FILE },
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
      const fullPath = join(target.directory, target.file);
      watcher.on("change", (_event, filename) => {
        const name = typeof filename === "string" ? filename : filename?.toString();
        if (name !== undefined && name !== target.file) return;
        void this.onFileEvent(state, fullPath);
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

  private pollIntervals(): { activeMs: number; idleMs: number } | null {
    if (this.options.keychainPoll !== undefined) return this.options.keychainPoll;
    const platform = this.options.platform ?? process.platform;
    return platform === "darwin"
      ? { activeMs: KEYCHAIN_POLL_ACTIVE_MS, idleMs: KEYCHAIN_POLL_IDLE_MS }
      : null;
  }

  /**
   * Claude Code refreshes into the Keychain on macOS, which no file watcher
   * sees; a poll is the only way a terminal-side rotation reaches Cora
   * between the opportunistic reconciles. Busy pairs poll faster.
   *
   * One timer per pair, armed synchronously so a disarm always finds it:
   * the timer wakes at the active cadence and decides then whether the pair
   * is busy (reconcile now) or idle (reconcile once the idle interval has
   * passed since the last poll).
   */
  private schedulePoll(state: PairState): void {
    const intervals = this.pollIntervals();
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
    const busy =
      (await Promise.resolve(this.options.isActive?.(state.pair.coraProfileId)).catch(
        () => false,
      )) === true ||
      this.options.isLeased?.(state.pair.cliProfileId) === true;
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

function claudeCredentialPath(pair: Pick<AnthropicCredentialPair, "configDir">): string {
  return join(pair.configDir, CLAUDE_CREDENTIALS_FILE);
}

export const anthropicCredentialMirror = new AnthropicCredentialMirror({
  log: (message) => console.warn(message),
});

/** Arm every pair and run one reconcile each; safe to call repeatedly. */
export async function startAnthropicCredentialMirror(
  pairs: readonly AnthropicCredentialPair[],
  mirror: AnthropicCredentialMirror = anthropicCredentialMirror,
): Promise<void> {
  for (const pair of pairs) mirror.watch(pair);
  await mirror.reconcileAll();
}
