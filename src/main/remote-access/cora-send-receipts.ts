import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SCHEMA_VERSION = 1 as const;
const DEFAULT_FILE_NAME = "cora-send-receipts.json";
// Worst-case bounded ids still keep the serialized file below MAX_FILE_BYTES.
const DEFAULT_MAX_RECORDS = 1_024;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ID_BYTES = 256;

export interface CoraSendReceiptInput {
  workspaceId: string;
  runId?: string;
  message: string;
  clientMessageId: string;
}

export interface CoraSendReceiptMessage {
  clientMessageId?: string;
  author: string;
  kind: string;
  message: string;
}

export interface CoraSendReceiptRun {
  id: string;
  workspaceId: string;
  humanMessages: CoraSendReceiptMessage[];
}

export interface CoraSendReceiptRecord {
  workspaceId: string;
  runId: string;
  clientMessageId: string;
  messageSha256: string;
  createdAt: number;
  updatedAt: number;
}

interface PersistedCoraSendReceipts {
  schemaVersion: typeof SCHEMA_VERSION;
  records: CoraSendReceiptRecord[];
}

export interface CoraSendReceiptIndexOptions {
  rootDir: string;
  fileName?: string;
  maxRecords?: number;
  retentionMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export class CoraSendReceiptConflictError extends Error {
  readonly code = "CORA_SEND_RECEIPT_CONFLICT";

  constructor(message = "clientMessageId is already used by another Cora message.") {
    super(message);
    this.name = "CoraSendReceiptConflictError";
  }
}

/**
 * Compact durable lookup for Cora send retries.
 *
 * The file intentionally contains only routing identities and a SHA-256
 * digest. Message text, provider credentials, tool output, and full run
 * projections never become a second mutation ledger.
 */
export class CoraSendReceiptIndex {
  readonly filePath: string;

  private readonly records = new Map<string, CoraSendReceiptRecord>();
  private readonly maxRecords: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(options: CoraSendReceiptIndexOptions) {
    const fileName = options.fileName ?? DEFAULT_FILE_NAME;
    if (!fileName || basename(fileName) !== fileName) {
      throw new Error("Cora send receipt fileName must be a plain file name.");
    }
    this.filePath = resolve(options.rootDir, fileName);
    this.maxRecords = normalizePositiveInteger(
      options.maxRecords,
      DEFAULT_MAX_RECORDS,
    );
    this.retentionMs = normalizeRetention(options.retentionMs);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  static async open(
    options: CoraSendReceiptIndexOptions,
  ): Promise<CoraSendReceiptIndex> {
    const index = new CoraSendReceiptIndex(options);
    await index.load();
    return index;
  }

  /**
   * Resolve and authoritatively verify a receipt with exactly one run read.
   * A stale receipt is removed and treated as a miss so the caller may use its
   * one-time bounded legacy repair path.
   */
  async resolve<TRun extends CoraSendReceiptRun>(
    input: CoraSendReceiptInput,
    loadRun: (runId: string) => Promise<TRun | null>,
  ): Promise<TRun | null> {
    const prepared = prepareInput(input);
    const record = this.records.get(
      receiptKey(prepared.workspaceId, prepared.clientMessageId),
    );
    if (!record) return null;
    if (
      record.messageSha256 !== prepared.messageSha256 ||
      (prepared.runId !== undefined && record.runId !== prepared.runId)
    ) {
      throw new CoraSendReceiptConflictError(
        prepared.runId !== undefined && record.runId !== prepared.runId
          ? "clientMessageId is already used by another Cora run."
          : undefined,
      );
    }

    const run = await loadRun(record.runId);
    if (!run || run.workspaceId !== prepared.workspaceId) {
      await this.removeRecord(prepared.workspaceId, prepared.clientMessageId);
      return null;
    }
    const authoritative = run.humanMessages.find(
      (entry) => entry.clientMessageId === prepared.clientMessageId,
    );
    if (!authoritative) {
      await this.removeRecord(prepared.workspaceId, prepared.clientMessageId);
      return null;
    }
    if (
      authoritative.author !== "user" ||
      (authoritative.kind !== "note" && authoritative.kind !== "answer") ||
      hashCoraSendMessage(authoritative.message) !== prepared.messageSha256
    ) {
      throw new CoraSendReceiptConflictError();
    }
    const accessedAt = this.now();
    if (record.updatedAt !== accessedAt) {
      await this.mutate(() => {
        const current = this.records.get(
          receiptKey(prepared.workspaceId, prepared.clientMessageId),
        );
        if (current) current.updatedAt = accessedAt;
      });
    }
    return run;
  }

  async record(input: CoraSendReceiptInput, runId: string): Promise<void> {
    const prepared = prepareInput(input);
    const normalizedRunId = requiredBoundedIdentity(runId, "runId");
    if (prepared.runId !== undefined && prepared.runId !== normalizedRunId) {
      throw new CoraSendReceiptConflictError(
        "clientMessageId is already used by another Cora run.",
      );
    }
    await this.mutate(() => {
      const key = receiptKey(prepared.workspaceId, prepared.clientMessageId);
      const existing = this.records.get(key);
      if (
        existing &&
        (existing.runId !== normalizedRunId ||
          existing.messageSha256 !== prepared.messageSha256)
      ) {
        throw new CoraSendReceiptConflictError();
      }
      const now = this.now();
      this.records.set(key, {
        workspaceId: prepared.workspaceId,
        runId: normalizedRunId,
        clientMessageId: prepared.clientMessageId,
        messageSha256: prepared.messageSha256,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    });
  }

  async removeRun(workspaceId: string, runId: string): Promise<number> {
    const normalizedWorkspaceId = requiredBoundedIdentity(
      workspaceId,
      "workspaceId",
    );
    const normalizedRunId = requiredBoundedIdentity(runId, "runId");
    let removed = 0;
    await this.mutate(() => {
      for (const [key, record] of this.records) {
        if (
          record.workspaceId === normalizedWorkspaceId &&
          record.runId === normalizedRunId
        ) {
          this.records.delete(key);
          removed += 1;
        }
      }
    }, false);
    return removed;
  }

  listRecordsForTest(): CoraSendReceiptRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  private async removeRecord(
    workspaceId: string,
    clientMessageId: string,
  ): Promise<void> {
    await this.mutate(() => {
      this.records.delete(receiptKey(workspaceId, clientMessageId));
    }, false);
  }

  private async mutate(
    operation: () => void,
    persistWhenUnchanged = true,
  ): Promise<void> {
    const previous = this.writeTail;
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const before = this.records.size;
        operation();
        this.prune();
        if (persistWhenUnchanged || before !== this.records.size) {
          await this.persist();
        }
      });
    this.writeTail = next;
    await next;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error("receipt index exceeds its size limit");
      }
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.log(
        `[cora-send-receipts] ignoring unreadable index: ${errorMessage(error)}`,
      );
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION) {
        throw new Error("unsupported receipt index schema");
      }
      if (!Array.isArray(parsed.records)) {
        throw new Error("receipt index records are invalid");
      }
      for (const candidate of parsed.records) {
        const record = normalizeRecord(candidate);
        if (!record) throw new Error("receipt index contains an invalid record");
        const key = receiptKey(record.workspaceId, record.clientMessageId);
        const existing = this.records.get(key);
        if (!existing || existing.updatedAt < record.updatedAt) {
          this.records.set(key, record);
        }
      }
      this.prune();
    } catch (error) {
      this.records.clear();
      this.log(
        `[cora-send-receipts] ignoring corrupt index: ${errorMessage(error)}`,
      );
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [key, record] of this.records) {
      if (record.updatedAt < cutoff) this.records.delete(key);
    }
    if (this.records.size <= this.maxRecords) return;
    const oldest = [...this.records.entries()].sort(
      ([leftKey, left], [rightKey, right]) =>
        left.updatedAt - right.updatedAt || leftKey.localeCompare(rightKey),
    );
    for (const [key] of oldest.slice(0, this.records.size - this.maxRecords)) {
      this.records.delete(key);
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const payload: PersistedCoraSendReceipts = {
      schemaVersion: SCHEMA_VERSION,
      records: [...this.records.values()].sort(
        (left, right) =>
          left.updatedAt - right.updatedAt ||
          receiptKey(left.workspaceId, left.clientMessageId).localeCompare(
            receiptKey(right.workspaceId, right.clientMessageId),
          ),
      ),
    };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) {
      throw new Error("Cora send receipt index exceeds its size limit.");
    }
    const tempPath = join(
      dirname(this.filePath),
      `.${basename(this.filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(tempPath, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tempPath, this.filePath);
      await fs.chmod(this.filePath, 0o600).catch(() => undefined);
      const directory = await fs.open(dirname(this.filePath), "r").catch(
        () => null,
      );
      if (directory) {
        await directory.sync().catch(() => undefined);
        await directory.close().catch(() => undefined);
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export function hashCoraSendMessage(message: string): string {
  return createHash("sha256").update(message.trim(), "utf8").digest("hex");
}

function prepareInput(input: CoraSendReceiptInput): {
  workspaceId: string;
  runId?: string;
  clientMessageId: string;
  messageSha256: string;
} {
  return {
    workspaceId: requiredBoundedIdentity(input.workspaceId, "workspaceId"),
    ...(input.runId !== undefined
      ? { runId: requiredBoundedIdentity(input.runId, "runId") }
      : {}),
    clientMessageId: requiredBoundedIdentity(
      input.clientMessageId,
      "clientMessageId",
    ),
    messageSha256: hashCoraSendMessage(input.message),
  };
}

function normalizeRecord(value: unknown): CoraSendReceiptRecord | null {
  if (!isRecord(value)) return null;
  try {
    const workspaceId = requiredBoundedIdentity(
      value.workspaceId,
      "workspaceId",
    );
    const runId = requiredBoundedIdentity(value.runId, "runId");
    const clientMessageId = requiredBoundedIdentity(
      value.clientMessageId,
      "clientMessageId",
    );
    if (
      typeof value.messageSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.messageSha256) ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      typeof value.updatedAt !== "number" ||
      !Number.isFinite(value.updatedAt)
    ) {
      return null;
    }
    return {
      workspaceId,
      runId,
      clientMessageId,
      messageSha256: value.messageSha256,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  } catch {
    return null;
  }
}

function requiredBoundedIdentity(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > MAX_ID_BYTES
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function receiptKey(workspaceId: string, clientMessageId: string): string {
  return JSON.stringify([workspaceId, clientMessageId]);
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}

function normalizeRetention(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_RETENTION_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
