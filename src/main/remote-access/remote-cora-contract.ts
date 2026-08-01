/**
 * Exact byte contract shared by Studio's Cora wire projections.
 *
 * Keep this module dependency-free so the same constants and helpers can be
 * lifted into the mobile protocol package without importing Electron or the
 * orchestration store. All budgets cover UTF-8 JSON bytes, not JavaScript
 * string length or the pre-escaping UTF-8 length of an individual field.
 */

export const CORA_HISTORY_RUNS_JSON_MAX_BYTES = 72 * 1024;
export const CORA_RUN_JSON_MAX_BYTES = 400 * 1024;
// A full run plus revision/cursor needs 143 bytes today. Four KiB leaves an
// explicit protocol-evolution reserve while remaining far below the 1 MiB RPC
// frame and the phone's 416 KiB durable run-row ceiling.
export const CORA_RUN_RESULT_JSON_MAX_BYTES = 404 * 1024;
export const CORA_WIRE_ID_MAX_BYTES = 256;
export const CORA_WIRE_TIMESTAMP_MAX_BYTES = 64;

export function jsonUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return Number.POSITIVE_INFINITY;
  return Buffer.byteLength(serialized, "utf8");
}

/** Returns the longest in-order prefix whose complete JSON array fits. */
export function takeJsonArrayPrefixWithinBudget<T>(
  values: readonly T[],
  maxBytes: number,
): T[] {
  const result: T[] = [];
  for (const value of values) {
    const candidate = [...result, value];
    if (jsonUtf8Bytes(candidate) > maxBytes) break;
    result.push(value);
  }
  return result;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function isRemoteCoraIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Bytes(value) <= CORA_WIRE_ID_MAX_BYTES
  );
}

export function requireRemoteCoraIdentity(
  value: unknown,
  field: string,
): string {
  if (!isRemoteCoraIdentity(value)) {
    throw new TypeError(
      `${field} must be a non-empty Cora identity of at most ${CORA_WIRE_ID_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  return value;
}

export function isRemoteCoraTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Bytes(value) <= CORA_WIRE_TIMESTAMP_MAX_BYTES &&
    Number.isFinite(Date.parse(value))
  );
}

export function requireRemoteCoraTimestamp(
  value: unknown,
  field: string,
): string {
  if (!isRemoteCoraTimestamp(value)) {
    throw new TypeError(
      `${field} must be a parseable timestamp of at most ${CORA_WIRE_TIMESTAMP_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  return value;
}

export function isOneOf<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): value is T {
  return typeof value === "string" && allowed.has(value as T);
}
