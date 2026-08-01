import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import {
  USER_CONSTITUTION_MAX_BYTES,
  type UserConstitutionCapture,
  type UserConstitutionDocument,
  type UserConstitutionSaveInput,
} from "@shared/types";
import { writeFileAtomic } from "./fs-atomic";
import { sparkHome } from "./spark-home";
import { normalizeUserConstitutionCapture } from "./user-constitution-capture";

export const USER_CONSTITUTION_FILE = "user-constitution.json";
export const USER_CONSTITUTION_DATA_DIRECTORY = "user-constitution";
export const USER_CONSTITUTION_REVISIONS_DIRECTORY = "revisions";
export const USER_CONSTITUTION_BLOBS_DIRECTORY = "blobs";
export const USER_CONSTITUTION_SCHEMA_VERSION = 2;

const LEGACY_USER_CONSTITUTION_SCHEMA_VERSION = 1;
const LEGACY_USER_CONSTITUTION_FILE_MAX_BYTES = 64 * 1024;
const USER_CONSTITUTION_POINTER_MAX_BYTES = 8 * 1024;
const USER_CONSTITUTION_REVISION_MAX_BYTES = 8 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// Main owns this store, but tests and future callers may construct more than
// one facade. Serialize by canonical root so compare-and-swap remains one
// durable operation across every in-process instance, not merely per object.
const STORE_OPERATION_QUEUES = new Map<string, Promise<void>>();

export const DEFAULT_USER_CONSTITUTION_BODY = `# Codara user constitution

This is my global working agreement for agents managed by Codara Studio.
It cannot broaden a task, grant access, or authorize destructive or irreversible
actions. System, tool, security, and repository-owned instructions remain
authoritative; more specific project constraints win on conflict.

## Evidence over assertion

- Inspect relevant code, state, and tool output before making a claim.
- Cite concrete files, commands, tests, and observable results.
- Mark assumptions and unresolved uncertainty explicitly.

## Model lanes

- Prefer the provider and model best suited to the task, based on evidence.
- Use independent cross-provider verification when it adds useful confidence.
- Do not impose quotas, forced alternation, or subscription-burning busywork.

## Dispatch discipline

- Give each worker one bounded objective, a clear owner, and a verifiable deliverable.
- Avoid duplicate ownership and overlapping edits; re-read shared files before patching.
- Do not expand scope merely because another agent or tool is available.

## Cleanup ritual

- Record every exact process, terminal, worktree, and temporary path created by the task.
- Stop or remove only task-owned resources; preserve pre-existing and uncertain state.
- Never use broad cleanup commands, guessed paths, or repository-wide deletion.
`;

interface LegacyPersistedUserConstitution {
  schemaVersion: typeof LEGACY_USER_CONSTITUTION_SCHEMA_VERSION;
  enabled: boolean;
  body: string;
  revision: number;
  sha256: string;
  updatedAt: string;
}

interface PersistedUserConstitutionPointer {
  schemaVersion: typeof USER_CONSTITUTION_SCHEMA_VERSION;
  enabled: boolean;
  revision: number;
  sha256: string;
  updatedAt: string;
}

interface PersistedUserConstitutionRevision {
  schemaVersion: typeof USER_CONSTITUTION_SCHEMA_VERSION;
  enabledAtCapture: boolean;
  revision: number;
  sha256: string;
  updatedAt: string;
}

export class UserConstitutionRevisionConflictError extends Error {
  readonly code = "USER_CONSTITUTION_REVISION_CONFLICT";

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `The user constitution changed since it was opened (expected revision ${expectedRevision}, current revision ${actualRevision}). Reload it before saving again.`,
    );
    this.name = "UserConstitutionRevisionConflictError";
  }
}

export class UserConstitutionStore {
  private readonly rootDirectory: string;
  private cached: UserConstitutionDocument | null = null;

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim()) {
      throw new TypeError("User constitution storage directory is required.");
    }
    this.rootDirectory = resolve(rootDirectory);
  }

  load(): Promise<UserConstitutionDocument> {
    return this.enqueue(async () => {
      const document = await this.loadCachedOrDisk();
      return cloneDocument(document);
    });
  }

  save(input: unknown): Promise<UserConstitutionDocument> {
    return this.enqueue(async () => {
      // Re-read under the root-wide queue. Another facade may have advanced
      // the pointer since this instance last loaded it.
      const current = await this.readFromDisk();
      this.cached = current;
      const normalized = normalizeSaveInput(input);
      if (normalized.expectedRevision !== current.revision) {
        throw new UserConstitutionRevisionConflictError(
          normalized.expectedRevision,
          current.revision,
        );
      }

      const next: UserConstitutionDocument = {
        enabled: normalized.enabled,
        body: normalized.body,
        revision: current.revision + 1,
        sha256: hashBody(normalized.body),
        updatedAt: new Date().toISOString(),
      };
      const persisted = await this.writeDocument(next);
      this.cached = persisted;
      return cloneDocument(persisted);
    });
  }

  /** Freeze the current pointer without copying its body. */
  captureCurrent(): Promise<UserConstitutionCapture> {
    return this.enqueue(async () => {
      const document = await this.readFromDisk();
      this.cached = document;
      return captureFromDocument(document);
    });
  }

  /**
   * Resolve only the exact immutable enabled revision/hash pair supplied by
   * the caller. Current settings are intentionally never consulted as a
   * fallback, so retries and recovered launches cannot drift to newer text.
   */
  resolveEnabledCapture(capture: unknown): Promise<string> {
    return this.enqueue(async () => {
      const normalized = normalizeCapture(capture);
      if (!normalized.enabledAtCapture) {
        throw new Error("The captured user constitution revision is disabled.");
      }
      if (normalized.revision < 1) {
        throw new Error("An enabled user constitution capture requires a persisted revision.");
      }
      await this.ensureStorageDirectories();
      const revision = await this.readRevision(normalized.revision);
      assertRevisionMatchesCapture(revision, normalized);
      return this.readBodyBlob(normalized.sha256);
    });
  }

  private async loadCachedOrDisk(): Promise<UserConstitutionDocument> {
    if (!this.cached) this.cached = await this.readFromDisk();
    return this.cached;
  }

  private pointerPath(): string {
    return join(this.rootDirectory, USER_CONSTITUTION_FILE);
  }

  private dataDirectory(): string {
    return join(this.rootDirectory, USER_CONSTITUTION_DATA_DIRECTORY);
  }

  private revisionsDirectory(): string {
    return join(this.dataDirectory(), USER_CONSTITUTION_REVISIONS_DIRECTORY);
  }

  private blobsDirectory(): string {
    return join(this.dataDirectory(), USER_CONSTITUTION_BLOBS_DIRECTORY);
  }

  private revisionPath(revision: number): string {
    return join(this.revisionsDirectory(), `${revision}.json`);
  }

  private blobPath(sha256: string): string {
    return join(this.blobsDirectory(), `${sha256}.txt`);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = STORE_OPERATION_QUEUES.get(this.rootDirectory) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    STORE_OPERATION_QUEUES.set(this.rootDirectory, settled);
    void settled.then(() => {
      if (STORE_OPERATION_QUEUES.get(this.rootDirectory) === settled) {
        STORE_OPERATION_QUEUES.delete(this.rootDirectory);
      }
    });
    return result;
  }

  private async readFromDisk(): Promise<UserConstitutionDocument> {
    let raw: string;
    try {
      raw = await readUtf8RegularFile(
        this.pointerPath(),
        LEGACY_USER_CONSTITUTION_FILE_MAX_BYTES,
        "The user constitution current pointer",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await validateOptionalPrivateDirectory(this.rootDirectory);
        return defaultDocument();
      }
      throw error;
    }

    const value = parseJson(raw, "The user constitution current pointer");
    const schemaVersion = recordSchemaVersion(value);
    if (schemaVersion === LEGACY_USER_CONSTITUTION_SCHEMA_VERSION) {
      const legacy = normalizeLegacyDocument(value);
      const document = documentFromLegacy(legacy);
      // Migration is prerequisite-first: both immutable records are durable
      // and verified before the only file containing the legacy body is
      // replaced by the body-free schema-2 pointer.
      return this.writeDocument(document);
    }
    if (schemaVersion !== USER_CONSTITUTION_SCHEMA_VERSION) {
      throw invalidStoreError("The user constitution current pointer");
    }
    if (Buffer.byteLength(raw, "utf8") > USER_CONSTITUTION_POINTER_MAX_BYTES) {
      throw new Error("The user constitution current pointer exceeds its size limit.");
    }

    const pointer = normalizePointer(value);
    await this.ensureStorageDirectories();
    const capture = captureFromPointer(pointer);
    const revision = await this.readRevision(pointer.revision);
    assertRevisionMatchesCapture(revision, capture);
    if (revision.updatedAt !== pointer.updatedAt) {
      throw invalidStoreError("The user constitution current pointer/revision pair");
    }
    const body = await this.readBodyBlob(pointer.sha256);
    return {
      enabled: pointer.enabled,
      body,
      revision: pointer.revision,
      sha256: pointer.sha256,
      updatedAt: pointer.updatedAt,
    };
  }

  private async writeDocument(document: UserConstitutionDocument): Promise<UserConstitutionDocument> {
    if (document.revision < 1 || !document.updatedAt) {
      throw new TypeError("A persisted user constitution requires revision metadata.");
    }
    validateUserConstitutionBody(document.body);
    if (hashBody(document.body) !== document.sha256) {
      throw new TypeError("The user constitution document hash is invalid.");
    }

    await this.ensureStorageDirectories();
    await this.ensureBodyBlob(document.sha256, document.body);
    const revision = await this.ensureRevision({
      schemaVersion: USER_CONSTITUTION_SCHEMA_VERSION,
      enabledAtCapture: document.enabled,
      revision: document.revision,
      sha256: document.sha256,
      updatedAt: document.updatedAt,
    });
    await this.writePointer({
      schemaVersion: USER_CONSTITUTION_SCHEMA_VERSION,
      enabled: document.enabled,
      revision: document.revision,
      sha256: document.sha256,
      updatedAt: revision.updatedAt,
    });
    return {
      ...document,
      updatedAt: revision.updatedAt,
    };
  }

  private async ensureStorageDirectories(): Promise<void> {
    await ensurePrivateDirectory(this.rootDirectory, true);
    await ensurePrivateDirectory(this.dataDirectory());
    await ensurePrivateDirectory(this.revisionsDirectory());
    await ensurePrivateDirectory(this.blobsDirectory());
  }

  private async ensureBodyBlob(sha256: string, body: string): Promise<void> {
    const path = this.blobPath(sha256);
    try {
      const existing = await readUtf8RegularFile(
        path,
        USER_CONSTITUTION_MAX_BYTES,
        "The user constitution body blob",
      );
      validateUserConstitutionBody(existing);
      if (existing !== body || hashBody(existing) !== sha256) {
        throw invalidStoreError("The user constitution body blob");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await writeFileAtomic(path, body, { mode: PRIVATE_FILE_MODE });
    const verified = await readUtf8RegularFile(
      path,
      USER_CONSTITUTION_MAX_BYTES,
      "The user constitution body blob",
    );
    validateUserConstitutionBody(verified);
    if (verified !== body || hashBody(verified) !== sha256) {
      throw invalidStoreError("The user constitution body blob");
    }
  }

  private async ensureRevision(
    revision: PersistedUserConstitutionRevision,
  ): Promise<PersistedUserConstitutionRevision> {
    const path = this.revisionPath(revision.revision);
    try {
      const existing = await this.readRevision(revision.revision);
      if (!sameRevisionIdentity(existing, revision)) {
        throw invalidStoreError("The user constitution immutable revision");
      }
      // A crash may have durably committed this immutable revision before the
      // current pointer. Its original timestamp is canonical on restart.
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await writeFileAtomic(path, `${JSON.stringify(revision, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
    });
    const verified = await this.readRevision(revision.revision);
    if (!sameRevision(verified, revision)) {
      throw invalidStoreError("The user constitution immutable revision");
    }
    return verified;
  }

  private async readRevision(revision: number): Promise<PersistedUserConstitutionRevision> {
    const raw = await readUtf8RegularFile(
      this.revisionPath(revision),
      USER_CONSTITUTION_REVISION_MAX_BYTES,
      "The user constitution immutable revision",
    );
    return normalizeRevision(
      parseJson(raw, "The user constitution immutable revision"),
    );
  }

  private async readBodyBlob(sha256: string): Promise<string> {
    const body = await readUtf8RegularFile(
      this.blobPath(sha256),
      USER_CONSTITUTION_MAX_BYTES,
      "The user constitution body blob",
    );
    validateUserConstitutionBody(body);
    if (hashBody(body) !== sha256) {
      throw invalidStoreError("The user constitution body blob");
    }
    return body;
  }

  private async writePointer(pointer: PersistedUserConstitutionPointer): Promise<void> {
    await writeFileAtomic(
      this.pointerPath(),
      `${JSON.stringify(pointer, null, 2)}\n`,
      { mode: PRIVATE_FILE_MODE },
    );
    const raw = await readUtf8RegularFile(
      this.pointerPath(),
      USER_CONSTITUTION_POINTER_MAX_BYTES,
      "The user constitution current pointer",
    );
    const verified = normalizePointer(
      parseJson(raw, "The user constitution current pointer"),
    );
    if (!samePointer(verified, pointer)) {
      throw invalidStoreError("The user constitution current pointer");
    }
  }
}

function normalizeSaveInput(value: unknown): UserConstitutionSaveInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("User constitution save input is invalid.");
  }
  const input = value as Partial<UserConstitutionSaveInput>;
  if (
    typeof input.enabled !== "boolean" ||
    typeof input.body !== "string" ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision! < 0
  ) {
    throw new TypeError("User constitution save input is invalid.");
  }
  validateUserConstitutionBody(input.body);
  return {
    enabled: input.enabled,
    body: input.body,
    expectedRevision: input.expectedRevision!,
  };
}

function normalizeCapture(value: unknown): UserConstitutionCapture {
  return normalizeUserConstitutionCapture(value);
}

function normalizeLegacyDocument(value: unknown): LegacyPersistedUserConstitution {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidStoreError("The legacy user constitution document");
  }
  const document = value as Partial<LegacyPersistedUserConstitution>;
  if (
    !hasExactKeys(document, ["schemaVersion", "enabled", "body", "revision", "sha256", "updatedAt"]) ||
    document.schemaVersion !== LEGACY_USER_CONSTITUTION_SCHEMA_VERSION ||
    typeof document.enabled !== "boolean" ||
    typeof document.body !== "string" ||
    !Number.isSafeInteger(document.revision) ||
    document.revision! < 1 ||
    typeof document.sha256 !== "string" ||
    !SHA256_PATTERN.test(document.sha256) ||
    typeof document.updatedAt !== "string" ||
    !validIsoTimestamp(document.updatedAt)
  ) {
    throw invalidStoreError("The legacy user constitution document");
  }
  validateUserConstitutionBody(document.body);
  if (hashBody(document.body) !== document.sha256) {
    throw invalidStoreError("The legacy user constitution document");
  }
  return {
    schemaVersion: LEGACY_USER_CONSTITUTION_SCHEMA_VERSION,
    enabled: document.enabled,
    body: document.body,
    revision: document.revision!,
    sha256: document.sha256,
    updatedAt: document.updatedAt,
  };
}

function normalizePointer(value: unknown): PersistedUserConstitutionPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidStoreError("The user constitution current pointer");
  }
  const pointer = value as Partial<PersistedUserConstitutionPointer> & { body?: unknown };
  if (
    !hasExactKeys(pointer, ["schemaVersion", "enabled", "revision", "sha256", "updatedAt"]) ||
    pointer.schemaVersion !== USER_CONSTITUTION_SCHEMA_VERSION ||
    Object.prototype.hasOwnProperty.call(pointer, "body") ||
    typeof pointer.enabled !== "boolean" ||
    !Number.isSafeInteger(pointer.revision) ||
    pointer.revision! < 1 ||
    typeof pointer.sha256 !== "string" ||
    !SHA256_PATTERN.test(pointer.sha256) ||
    typeof pointer.updatedAt !== "string" ||
    !validIsoTimestamp(pointer.updatedAt)
  ) {
    throw invalidStoreError("The user constitution current pointer");
  }
  return {
    schemaVersion: USER_CONSTITUTION_SCHEMA_VERSION,
    enabled: pointer.enabled,
    revision: pointer.revision!,
    sha256: pointer.sha256,
    updatedAt: pointer.updatedAt,
  };
}

function normalizeRevision(value: unknown): PersistedUserConstitutionRevision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidStoreError("The user constitution immutable revision");
  }
  const revision = value as Partial<PersistedUserConstitutionRevision> & { body?: unknown };
  if (
    !hasExactKeys(revision, ["schemaVersion", "enabledAtCapture", "revision", "sha256", "updatedAt"]) ||
    revision.schemaVersion !== USER_CONSTITUTION_SCHEMA_VERSION ||
    Object.prototype.hasOwnProperty.call(revision, "body") ||
    typeof revision.enabledAtCapture !== "boolean" ||
    !Number.isSafeInteger(revision.revision) ||
    revision.revision! < 1 ||
    typeof revision.sha256 !== "string" ||
    !SHA256_PATTERN.test(revision.sha256) ||
    typeof revision.updatedAt !== "string" ||
    !validIsoTimestamp(revision.updatedAt)
  ) {
    throw invalidStoreError("The user constitution immutable revision");
  }
  return {
    schemaVersion: USER_CONSTITUTION_SCHEMA_VERSION,
    enabledAtCapture: revision.enabledAtCapture,
    revision: revision.revision!,
    sha256: revision.sha256,
    updatedAt: revision.updatedAt,
  };
}

export function validateUserConstitutionBody(body: string): void {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.toString("utf8") !== body) {
    throw new TypeError("The user constitution must be valid UTF-8 text.");
  }
  if (!body.trim()) {
    throw new TypeError("The user constitution cannot be empty.");
  }
  if (bytes.byteLength > USER_CONSTITUTION_MAX_BYTES) {
    throw new TypeError(
      `The user constitution is limited to ${USER_CONSTITUTION_MAX_BYTES / 1024} KiB of UTF-8 text.`,
    );
  }
  if (DISALLOWED_CONTROLS.test(body)) {
    throw new TypeError("The user constitution contains an unsupported control character.");
  }
}

async function ensurePrivateDirectory(path: string, recursive = false): Promise<void> {
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("The user constitution storage path is not an app-owned directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(path, { recursive, mode: PRIVATE_DIRECTORY_MODE });
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("The user constitution storage path is not an app-owned directory.");
    }
  }
  if (process.platform !== "win32") {
    await fs.chmod(path, PRIVATE_DIRECTORY_MODE);
  }
}

async function validateOptionalPrivateDirectory(path: string): Promise<void> {
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("The user constitution storage path is not an app-owned directory.");
    }
    if (process.platform !== "win32") {
      await fs.chmod(path, PRIVATE_DIRECTORY_MODE);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readUtf8RegularFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const noFollow =
    process.platform === "win32"
      ? 0
      : ((fsConstants.O_NOFOLLOW as number | undefined) ?? 0);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`${label} is not a regular app-owned file.`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`${label} exceeds its size limit.`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${label} exceeds its size limit.`);
    }
    if (process.platform !== "win32") {
      await handle.chmod(PRIVATE_FILE_MODE);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalidStoreError(label);
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ELOOP" ||
      (error as NodeJS.ErrnoException).code === "EMLINK"
    ) {
      throw new Error(`${label} is not a regular app-owned file.`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalidStoreError(label);
  }
}

function recordSchemaVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  return typeof schemaVersion === "number" ? schemaVersion : null;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function documentFromLegacy(document: LegacyPersistedUserConstitution): UserConstitutionDocument {
  return {
    enabled: document.enabled,
    body: document.body,
    revision: document.revision,
    sha256: document.sha256,
    updatedAt: document.updatedAt,
  };
}

function captureFromDocument(document: UserConstitutionDocument): UserConstitutionCapture {
  return {
    enabledAtCapture: document.enabled,
    revision: document.revision,
    sha256: document.sha256,
  };
}

function captureFromPointer(pointer: PersistedUserConstitutionPointer): UserConstitutionCapture {
  return {
    enabledAtCapture: pointer.enabled,
    revision: pointer.revision,
    sha256: pointer.sha256,
  };
}

function assertRevisionMatchesCapture(
  revision: PersistedUserConstitutionRevision,
  capture: UserConstitutionCapture,
): void {
  if (
    revision.revision !== capture.revision ||
    revision.sha256 !== capture.sha256 ||
    revision.enabledAtCapture !== capture.enabledAtCapture
  ) {
    throw invalidStoreError("The user constitution revision/capture pair");
  }
}

function sameRevision(
  left: PersistedUserConstitutionRevision,
  right: PersistedUserConstitutionRevision,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.enabledAtCapture === right.enabledAtCapture &&
    left.revision === right.revision &&
    left.sha256 === right.sha256 &&
    left.updatedAt === right.updatedAt
  );
}

function sameRevisionIdentity(
  left: PersistedUserConstitutionRevision,
  right: PersistedUserConstitutionRevision,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.enabledAtCapture === right.enabledAtCapture &&
    left.revision === right.revision &&
    left.sha256 === right.sha256
  );
}

function samePointer(
  left: PersistedUserConstitutionPointer,
  right: PersistedUserConstitutionPointer,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.enabled === right.enabled &&
    left.revision === right.revision &&
    left.sha256 === right.sha256 &&
    left.updatedAt === right.updatedAt
  );
}

function defaultDocument(): UserConstitutionDocument {
  return {
    enabled: false,
    body: DEFAULT_USER_CONSTITUTION_BODY,
    revision: 0,
    sha256: hashBody(DEFAULT_USER_CONSTITUTION_BODY),
    updatedAt: null,
  };
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function validIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function invalidStoreError(label: string): Error {
  return new Error(`${label} is invalid or corrupted.`);
}

function cloneDocument(document: UserConstitutionDocument): UserConstitutionDocument {
  return { ...document };
}

let defaultStore: UserConstitutionStore | null = null;

function getDefaultStore(): UserConstitutionStore {
  defaultStore ??= new UserConstitutionStore(sparkHome());
  return defaultStore;
}

export function loadUserConstitution(): Promise<UserConstitutionDocument> {
  return getDefaultStore().load();
}

export function saveUserConstitution(
  input: unknown,
): Promise<UserConstitutionDocument> {
  return getDefaultStore().save(input);
}

export function captureCurrentUserConstitution(): Promise<UserConstitutionCapture> {
  return getDefaultStore().captureCurrent();
}

export function resolveEnabledUserConstitutionCapture(
  capture: unknown,
): Promise<string> {
  return getDefaultStore().resolveEnabledCapture(capture);
}
