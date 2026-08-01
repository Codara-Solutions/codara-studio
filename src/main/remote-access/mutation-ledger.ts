import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const SCHEMA_VERSION = 1 as const;
const DEFAULT_FILE_NAME = "mutation-ledger.json";
const DEFAULT_MAX_COMPLETED_ENTRIES = 10_000;
const DEFAULT_COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type MutationLedgerStatus = "pending" | "completed" | "outcome_unknown";

export interface MutationLedgerRequest {
  /**
   * Stable identity of the caller, such as a paired-device public key.
   * requestId values are unique only inside this namespace.
   */
  callerNamespace: string;
  requestId: string;
  method: string;
  params: unknown;
}

export interface MutationLedgerRecord {
  callerNamespace: string;
  requestId: string;
  method: string;
  /**
   * SHA-256(method + NUL + canonical JSON params). The params themselves are
   * deliberately not retained: receipts should not become a second secret
   * store merely to detect an idempotency-key conflict.
   */
  requestSha256: string;
  status: MutationLedgerStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  outcomeUnknownAt?: number;
  outcomeUnknownReason?: string;
}

interface PersistedMutationRecord extends MutationLedgerRecord {
  encodedResult?: EncodedResult;
}

interface PersistedLedger {
  schemaVersion: typeof SCHEMA_VERSION;
  records: PersistedMutationRecord[];
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type EncodedResult =
  | { kind: "undefined" }
  | { kind: "json"; value: JsonValue };

export type MutationLedgerStorage =
  | {
      filePath: string;
      rootDir?: never;
      fileName?: never;
    }
  | {
      rootDir: string;
      /**
       * A relative path beneath rootDir. Defaults to mutation-ledger.json.
       * Nested relative paths are allowed and created on open.
       */
      fileName?: string;
      filePath?: never;
    };

export type MutationLedgerOptions = MutationLedgerStorage & {
  /**
   * Maximum completed receipts retained. Pending and outcome_unknown records
   * do not count toward this bound and are never evicted.
   */
  maxCompletedEntries?: number;
  /**
   * Age bound for completed receipts. Pending and outcome_unknown records are
   * never age-pruned. Set to Infinity to disable age pruning.
   */
  completedRetentionMs?: number;
  /** Test hook; production callers should use the default wall clock. */
  now?: () => number;
};

interface PreparedRequest {
  callerNamespace: string;
  requestId: string;
  method: string;
  requestSha256: string;
  key: string;
}

interface InFlightMutation {
  requestSha256: string;
  promise: Promise<unknown>;
}

/**
 * Raised when a requestId is reused with a different method or parameters.
 * The existing receipt always wins; the changed operation is never invoked.
 */
export class MutationRequestConflictError extends Error {
  readonly code = "MUTATION_REQUEST_CONFLICT";

  constructor(
    readonly callerNamespace: string,
    readonly requestId: string,
    readonly expectedRequestSha256: string,
    readonly actualRequestSha256: string,
  ) {
    super(`Mutation requestId "${requestId}" was reused with a different request`);
    this.name = "MutationRequestConflictError";
  }
}

/**
 * Raised when the mutation may have taken effect but no durable completed
 * receipt exists. Retrying under a new requestId is unsafe until the caller
 * reconciles the external state.
 */
export class MutationOutcomeUnknownError extends Error {
  readonly code = "MUTATION_OUTCOME_UNKNOWN";

  constructor(
    readonly record: MutationLedgerRecord,
    message = `Mutation "${record.requestId}" may have taken effect; reconcile before retrying`,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MutationOutcomeUnknownError";
  }
}

export class MutationLedgerCorruptError extends Error {
  readonly code = "MUTATION_LEDGER_CORRUPT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MutationLedgerCorruptError";
  }
}

/**
 * Durable idempotency receipts for side-effecting remote RPC calls.
 *
 * The ledger deliberately has no Electron dependency. Construct it with
 * open(), then route each mutating RPC through execute(). The pending receipt
 * is fsynced before the operation begins, and the completed receipt is
 * fsynced before its result is returned.
 */
export class DurableMutationLedger {
  readonly filePath: string;

  private readonly maxCompletedEntries: number;
  private readonly completedRetentionMs: number;
  private readonly now: () => number;
  private readonly records = new Map<string, PersistedMutationRecord>();
  private readonly inFlight = new Map<string, InFlightMutation>();
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(options: MutationLedgerOptions) {
    this.filePath = resolveLedgerPath(options);
    this.maxCompletedEntries = normalizeMaxCompletedEntries(options.maxCompletedEntries);
    this.completedRetentionMs = normalizeRetention(options.completedRetentionMs);
    this.now = options.now ?? Date.now;
  }

  static async open(options: MutationLedgerOptions): Promise<DurableMutationLedger> {
    const ledger = new DurableMutationLedger(options);
    await ledger.load();
    return ledger;
  }

  /**
   * Execute a mutation at most once for (callerNamespace, requestId).
   *
   * Concurrent identical requests join the same Promise. A completed retry
   * returns the persisted result without invoking operation. Any exception
   * after the operation starts is conservatively recorded and surfaced as
   * outcome_unknown, because a generic ledger cannot prove the side effect
   * did not happen.
   */
  async execute<T>(
    request: MutationLedgerRequest,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    return this.executeWithPolicy(request, operation, false);
  }

  /**
   * Resume a receipt whose outcome is unknown only when the caller's domain
   * operation is independently crash-safe and idempotent. This is intentionally
   * separate from execute(): generic Git/terminal mutations must continue to
   * fail closed. PR import qualifies because its own exact-OID journal,
   * reserved identities, and deterministic first message reconcile every
   * checkpoint before applying another effect.
   */
  async executeRecoverable<T>(
    request: MutationLedgerRequest,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    return this.executeWithPolicy(request, operation, true);
  }

  private async executeWithPolicy<T>(
    request: MutationLedgerRequest,
    operation: () => T | Promise<T>,
    recoverUnknown: boolean,
  ): Promise<T> {
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }
    const prepared = prepareRequest(request);
    const active = this.inFlight.get(prepared.key);
    if (active) {
      assertSameRequest(prepared, active.requestSha256);
      return active.promise as Promise<T>;
    }

    const promise = this.executeOnce(prepared, operation, recoverUnknown);
    this.inFlight.set(prepared.key, {
      requestSha256: prepared.requestSha256,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(prepared.key)?.promise === promise) {
        this.inFlight.delete(prepared.key);
      }
    }
  }

  getRecord(callerNamespace: string, requestId: string): MutationLedgerRecord | null {
    const record = this.records.get(recordKey(
      requiredIdentity(callerNamespace, "callerNamespace"),
      requiredIdentity(requestId, "requestId"),
    ));
    return record ? publicRecord(record) : null;
  }

  listRecords(): MutationLedgerRecord[] {
    return [...this.records.values()]
      .sort(compareRecords)
      .map(publicRecord);
  }

  private async executeOnce<T>(
    request: PreparedRequest,
    operation: () => T | Promise<T>,
    recoverUnknown: boolean,
  ): Promise<T> {
    const existing = this.records.get(request.key);
    if (existing) {
      assertSameRequest(request, existing.requestSha256);
      if (existing.status === "completed") {
        return decodeResult(existing);
      }
      if (!recoverUnknown) {
        throw new MutationOutcomeUnknownError(publicRecord(existing));
      }
    }

    const startedAt = this.now();
    const pending: PersistedMutationRecord =
      existing ?? {
        callerNamespace: request.callerNamespace,
        requestId: request.requestId,
        method: request.method,
        requestSha256: request.requestSha256,
        status: "pending",
        createdAt: startedAt,
        updatedAt: startedAt,
      };
    if (!existing) {
      this.records.set(request.key, pending);

      try {
        // This is the write-ahead boundary: no external effect starts before the
        // pending receipt is atomically renamed and fsynced.
        await this.persist();
      } catch (error) {
        // The effect never ran. Remove the speculative in-memory entry and make
        // a best effort to clean a pending snapshot another concurrent writer
        // may have included.
        if (this.records.get(request.key) === pending) {
          this.records.delete(request.key);
        }
        await this.persist().catch(() => undefined);
        throw error;
      }
    }

    let result: T;
    try {
      result = await operation();
    } catch (error) {
      const unknown = await this.transitionToOutcomeUnknown(
        request,
        "operation_threw_after_start",
      );
      throw new MutationOutcomeUnknownError(
        publicRecord(unknown),
        `Mutation "${request.requestId}" threw after it started; its outcome is unknown`,
        { cause: error },
      );
    }

    let encodedResult: EncodedResult;
    try {
      encodedResult = encodeResult(result);
    } catch (error) {
      const unknown = await this.transitionToOutcomeUnknown(
        request,
        "result_not_json_serializable",
      );
      throw new MutationOutcomeUnknownError(
        publicRecord(unknown),
        `Mutation "${request.requestId}" ran but its result could not be persisted`,
        { cause: error },
      );
    }

    const completedAt = this.now();
    const completed: PersistedMutationRecord = {
      callerNamespace: pending.callerNamespace,
      requestId: pending.requestId,
      method: pending.method,
      requestSha256: pending.requestSha256,
      status: "completed",
      createdAt: pending.createdAt,
      updatedAt: completedAt,
      completedAt,
      encodedResult,
    };
    this.records.set(request.key, completed);
    // Never evict the receipt this call is about before acknowledging it.
    // A wall-clock rollback can otherwise make the newest logical receipt
    // appear oldest by timestamp. With a positive count bound, older
    // completed receipts can always make room for this protected one.
    this.pruneCompleted(request.key);

    try {
      // A result is not acknowledged to the caller until its durable receipt
      // exists. Failure here is not a normal operation failure: the effect may
      // have happened, so returning result would invite an unsafe retry.
      await this.persist();
    } catch (error) {
      const unknownAt = this.now();
      const unknown: PersistedMutationRecord = {
        callerNamespace: pending.callerNamespace,
        requestId: pending.requestId,
        method: pending.method,
        requestSha256: pending.requestSha256,
        status: "outcome_unknown",
        createdAt: pending.createdAt,
        updatedAt: unknownAt,
        outcomeUnknownAt: unknownAt,
        outcomeUnknownReason: "completed_receipt_persistence_failed",
      };
      this.records.set(request.key, unknown);
      await this.persist().catch(() => undefined);
      throw new MutationOutcomeUnknownError(
        publicRecord(unknown),
        `Mutation "${request.requestId}" ran but its completed receipt was not durable`,
        { cause: error },
      );
    }

    return decodeEncodedResult(encodedResult) as T;
  }

  private async transitionToOutcomeUnknown(
    request: PreparedRequest,
    reason: string,
  ): Promise<PersistedMutationRecord> {
    const current = this.records.get(request.key);
    if (!current) {
      throw new Error("Mutation ledger invariant violated: pending record disappeared");
    }
    const unknownAt = this.now();
    const unknown: PersistedMutationRecord = {
      callerNamespace: current.callerNamespace,
      requestId: current.requestId,
      method: current.method,
      requestSha256: current.requestSha256,
      status: "outcome_unknown",
      createdAt: current.createdAt,
      updatedAt: unknownAt,
      outcomeUnknownAt: unknownAt,
      outcomeUnknownReason: reason,
    };
    this.records.set(request.key, unknown);
    try {
      await this.persist();
    } catch (error) {
      // The write-ahead pending record remains the durable fallback. On the
      // next open it is promoted to outcome_unknown before serving requests.
      throw new MutationOutcomeUnknownError(
        publicRecord(unknown),
        `Mutation "${request.requestId}" is outcome-unknown and that state could not be persisted`,
        { cause: error },
      );
    }
    return unknown;
  }

  private async load(): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new MutationLedgerCorruptError(
        `Mutation ledger is not valid JSON: ${this.filePath}`,
        { cause: error },
      );
    }
    const persisted = parseLedger(parsed, this.filePath);
    for (const record of persisted.records) {
      const key = recordKey(record.callerNamespace, record.requestId);
      if (this.records.has(key)) {
        throw new MutationLedgerCorruptError(
          `Mutation ledger contains duplicate caller/requestId: ${record.requestId}`,
        );
      }
      this.records.set(key, record);
    }

    let changed = false;
    const reopenedAt = this.now();
    // A process cannot join an old in-memory Promise. A durable pending entry
    // therefore means the process died somewhere after the write-ahead
    // receipt; replaying the operation would risk doing it twice.
    for (const [key, record] of this.records) {
      if (record.status !== "pending") continue;
      this.records.set(key, {
        ...record,
        status: "outcome_unknown",
        updatedAt: reopenedAt,
        outcomeUnknownAt: reopenedAt,
        outcomeUnknownReason: "process_restarted_while_pending",
      });
      changed = true;
    }
    if (this.pruneCompleted()) changed = true;
    if (changed) await this.persist();
  }

  private pruneCompleted(protectedKey?: string): boolean {
    const completed = [...this.records.entries()]
      .filter((entry): entry is [string, PersistedMutationRecord & { status: "completed"; completedAt: number }] =>
        entry[1].status === "completed")
      .sort((a, b) =>
        a[1].completedAt - b[1].completedAt ||
        a[1].createdAt - b[1].createdAt ||
        a[0].localeCompare(b[0]));

    const cutoff = this.now() - this.completedRetentionMs;
    const expiredKeys = this.completedRetentionMs === Infinity
      ? new Set<string>()
      : new Set(completed
          .filter(([key, record]) => key !== protectedKey && record.completedAt < cutoff)
          .map(([key]) => key));
    const retained = completed.filter(([key]) => !expiredKeys.has(key));
    const excess = Math.max(0, retained.length - this.maxCompletedEntries);
    const countEvictionCandidates = retained.filter(([key]) => key !== protectedKey);
    const evictedKeys = new Set<string>([
      ...expiredKeys,
      ...countEvictionCandidates.slice(0, excess).map(([key]) => key),
    ]);
    for (const key of evictedKeys) this.records.delete(key);
    return evictedKeys.size > 0;
  }

  private persist(): Promise<void> {
    const write = this.writeTail.then(async () => {
      const payload: PersistedLedger = {
        schemaVersion: SCHEMA_VERSION,
        records: [...this.records.values()]
          .sort(compareRecords)
          .map(clonePersistedRecord),
      };
      await writeJsonAtomic(this.filePath, payload);
    });
    // A failed write must not poison every later attempt.
    this.writeTail = write.catch(() => undefined);
    return write;
  }
}

export function canonicalMutationParams(params: unknown): string {
  return canonicalJson(params);
}

export function mutationRequestSha256(method: string, params: unknown): string {
  const normalizedMethod = requiredIdentity(method, "method");
  return createHash("sha256")
    .update(normalizedMethod)
    .update("\0")
    .update(canonicalMutationParams(params))
    .digest("hex");
}

function prepareRequest(request: MutationLedgerRequest): PreparedRequest {
  if (!request || typeof request !== "object") {
    throw new TypeError("request must be an object");
  }
  const callerNamespace = requiredIdentity(request.callerNamespace, "callerNamespace");
  const requestId = requiredIdentity(request.requestId, "requestId");
  const method = requiredIdentity(request.method, "method");
  return {
    callerNamespace,
    requestId,
    method,
    requestSha256: mutationRequestSha256(method, request.params),
    key: recordKey(callerNamespace, requestId),
  };
}

function requiredIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.length > 1_024) {
    throw new TypeError(`${label} must be at most 1024 characters`);
  }
  return value;
}

function recordKey(callerNamespace: string, requestId: string): string {
  return JSON.stringify([callerNamespace, requestId]);
}

function assertSameRequest(request: PreparedRequest, existingSha256: string): void {
  if (request.requestSha256 === existingSha256) return;
  throw new MutationRequestConflictError(
    request.callerNamespace,
    request.requestId,
    existingSha256,
    request.requestSha256,
  );
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Mutation params contain a non-finite number");
      }
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError("Mutation params contain a cycle");
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) {
              throw new TypeError("Mutation params contain a sparse array");
            }
          }
          return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("Mutation params must contain only plain objects and arrays");
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new TypeError("Mutation params cannot contain symbol keys");
        }
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        return `{${keys
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
          .join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError(`Mutation params contain unsupported ${typeof value}`);
  }
}

function encodeResult(value: unknown): EncodedResult {
  if (value === undefined) return { kind: "undefined" };
  return {
    kind: "json",
    value: JSON.parse(canonicalJson(value)) as JsonValue,
  };
}

function decodeResult<T>(record: PersistedMutationRecord): T {
  if (record.status !== "completed" || !record.encodedResult) {
    throw new MutationLedgerCorruptError(
      `Completed mutation "${record.requestId}" has no encoded result`,
    );
  }
  return decodeEncodedResult(record.encodedResult) as T;
}

function decodeEncodedResult(result: EncodedResult): unknown {
  if (result.kind === "undefined") return undefined;
  // Return a clone so a caller cannot mutate the ledger's cached receipt.
  return JSON.parse(JSON.stringify(result.value)) as JsonValue;
}

function publicRecord(record: PersistedMutationRecord): MutationLedgerRecord {
  const {
    callerNamespace,
    requestId,
    method,
    requestSha256,
    status,
    createdAt,
    updatedAt,
    completedAt,
    outcomeUnknownAt,
    outcomeUnknownReason,
  } = record;
  return {
    callerNamespace,
    requestId,
    method,
    requestSha256,
    status,
    createdAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(outcomeUnknownAt === undefined ? {} : { outcomeUnknownAt }),
    ...(outcomeUnknownReason === undefined ? {} : { outcomeUnknownReason }),
  };
}

function clonePersistedRecord(record: PersistedMutationRecord): PersistedMutationRecord {
  return JSON.parse(JSON.stringify(record)) as PersistedMutationRecord;
}

function compareRecords(a: PersistedMutationRecord, b: PersistedMutationRecord): number {
  return a.createdAt - b.createdAt ||
    a.callerNamespace.localeCompare(b.callerNamespace) ||
    a.requestId.localeCompare(b.requestId);
}

function resolveLedgerPath(options: MutationLedgerOptions): string {
  if ("filePath" in options && typeof options.filePath === "string") {
    if (options.filePath.length === 0) throw new TypeError("filePath must not be empty");
    return resolve(options.filePath);
  }
  if (!("rootDir" in options) || typeof options.rootDir !== "string" || options.rootDir.length === 0) {
    throw new TypeError("Provide either filePath or rootDir");
  }
  const root = resolve(options.rootDir);
  const fileName = options.fileName ?? DEFAULT_FILE_NAME;
  if (typeof fileName !== "string" || fileName.length === 0 || isAbsolute(fileName)) {
    throw new TypeError("fileName must be a non-empty relative path beneath rootDir");
  }
  const target = resolve(root, fileName);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new TypeError("fileName must remain beneath rootDir");
  }
  return target;
}

function normalizeMaxCompletedEntries(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_COMPLETED_ENTRIES;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError("maxCompletedEntries must be a positive safe integer");
  }
  return normalized;
}

function normalizeRetention(value: number | undefined): number {
  const normalized = value ?? DEFAULT_COMPLETED_RETENTION_MS;
  if (normalized === Infinity) return normalized;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError("completedRetentionMs must be a non-negative safe integer or Infinity");
  }
  return normalized;
}

function parseLedger(value: unknown, filePath: string): PersistedLedger {
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.records)) {
    throw new MutationLedgerCorruptError(
      `Mutation ledger has an unsupported shape or schema: ${filePath}`,
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    records: value.records.map((record, index) => parseRecord(record, index)),
  };
}

function parseRecord(value: unknown, index: number): PersistedMutationRecord {
  const label = `records[${index}]`;
  if (!isObject(value)) throw corrupt(`${label} must be an object`);
  const callerNamespace = persistedString(value.callerNamespace, `${label}.callerNamespace`);
  const requestId = persistedString(value.requestId, `${label}.requestId`);
  const method = persistedString(value.method, `${label}.method`);
  const requestSha256 = persistedString(value.requestSha256, `${label}.requestSha256`);
  if (!/^[a-f0-9]{64}$/.test(requestSha256)) {
    throw corrupt(`${label}.requestSha256 must be a lowercase SHA-256 hex digest`);
  }
  if (value.status !== "pending" && value.status !== "completed" && value.status !== "outcome_unknown") {
    throw corrupt(`${label}.status is invalid`);
  }
  const createdAt = persistedTime(value.createdAt, `${label}.createdAt`);
  const updatedAt = persistedTime(value.updatedAt, `${label}.updatedAt`);
  const base: PersistedMutationRecord = {
    callerNamespace,
    requestId,
    method,
    requestSha256,
    status: value.status,
    createdAt,
    updatedAt,
  };

  if (value.status === "completed") {
    const completedAt = persistedTime(value.completedAt, `${label}.completedAt`);
    return {
      ...base,
      status: "completed",
      completedAt,
      encodedResult: parseEncodedResult(value.encodedResult, label),
    };
  }
  if (value.status === "outcome_unknown") {
    return {
      ...base,
      status: "outcome_unknown",
      outcomeUnknownAt: persistedTime(value.outcomeUnknownAt, `${label}.outcomeUnknownAt`),
      outcomeUnknownReason: persistedString(
        value.outcomeUnknownReason,
        `${label}.outcomeUnknownReason`,
      ),
    };
  }
  return base;
}

function parseEncodedResult(value: unknown, label: string): EncodedResult {
  if (!isObject(value)) throw corrupt(`${label}.encodedResult must be an object`);
  if (value.kind === "undefined") return { kind: "undefined" };
  if (value.kind !== "json" || !Object.hasOwn(value, "value")) {
    throw corrupt(`${label}.encodedResult has an invalid kind`);
  }
  try {
    return encodeResult(value.value);
  } catch (error) {
    throw new MutationLedgerCorruptError(
      `${label}.encodedResult is not canonical JSON-compatible data`,
      { cause: error },
    );
  }
}

function persistedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw corrupt(`${label} must be a non-empty string of at most 1024 characters`);
  }
  return value;
}

function persistedTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw corrupt(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function corrupt(message: string): MutationLedgerCorruptError {
  return new MutationLedgerCorruptError(message);
}

async function writeJsonAtomic(filePath: string, value: PersistedLedger): Promise<void> {
  const directory = dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: import("node:fs").promises.FileHandle | null = null;
  try {
    handle = await fs.open(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: import("node:fs").promises.FileHandle | null = null;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Directory fsync is not available on every platform/filesystem. The file
    // contents and rename are still atomic; do not make the ledger unusable on
    // Windows or virtual filesystems solely because directory fsync is absent.
    if (!isIgnorableDirectorySyncError(error)) throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function isIgnorableDirectorySyncError(error: unknown): boolean {
  return isNodeError(error, "EINVAL") ||
    isNodeError(error, "ENOTSUP") ||
    isNodeError(error, "EPERM") ||
    isNodeError(error, "EISDIR");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
