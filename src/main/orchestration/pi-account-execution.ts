import { isAbsolute, resolve } from "node:path";
import type { PiSubscriptionProvider } from "./pi-runtime";

export const PI_ACCOUNT_PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PiExecutionAccountRequest {
  provider: PiSubscriptionProvider;
  /**
   * Explicit run/attempt pin. When present, a resolver must return this exact
   * profile rather than silently crossing subscription identities.
   */
  preferredAccountProfileId?: string;
}

export interface PiExecutionAccount {
  /** Actual opaque profile selected for this process, absent on the legacy route. */
  accountProfileId?: string;
  /** Private Pi config root containing this profile's auth and mutable caches. */
  configDir: string;
}

export type PiExecutionAccountResolver = (
  request: Readonly<PiExecutionAccountRequest>,
) => PiExecutionAccount | Promise<PiExecutionAccount>;

export function selectPiWorkerAccountProfile(input: {
  persistedAttemptProfileId?: string;
  runManagerProfileId?: string;
  runManagerProvider: PiSubscriptionProvider | null;
  workerProvider: PiSubscriptionProvider;
}): string | undefined {
  const persistedAttemptProfileId = normalizePiAccountProfileId(
    input.persistedAttemptProfileId,
    "Persisted worker account profile id",
  );
  // First precedence: an attempt that already ran on an account stays
  // attributed to it. Rewriting the pin would relabel work that genuinely
  // executed elsewhere.
  if (persistedAttemptProfileId) return persistedAttemptProfileId;
  if (input.runManagerProvider !== input.workerProvider) return undefined;
  const inheritedProfileId = normalizePiAccountProfileId(
    input.runManagerProfileId,
    "Run manager account profile id",
  );
  if (!inheritedProfileId) return undefined;
  return inheritedProfileId;
}

export function normalizePiAccountProfileId(
  value: string | null | undefined,
  label = "Pi account profile id",
): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !PI_ACCOUNT_PROFILE_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase UUIDv4`);
  }
  return value;
}

/**
 * Preserve the identity frozen before a call was persisted. A legacy backend
 * may omit the result field; a populated but different result is an invariant
 * violation rather than permission to rewrite provenance.
 */
export function preserveFrozenPiAccountProfileId(
  frozenValue: string | undefined,
  resultValue: string | undefined,
): string | undefined {
  const frozen = normalizePiAccountProfileId(
    frozenValue,
    "Frozen Pi account profile id",
  );
  const result = normalizePiAccountProfileId(
    resultValue,
    "Result Pi account profile id",
  );
  if (result === undefined) return frozen;
  if (frozen !== undefined && frozen !== result) {
    throw new Error("Pi execution account changed during a single turn");
  }
  return result;
}

/**
 * Validate an injected resolver's token-free output. An explicit profile is a
 * hard identity pin: falling back to another account would make a recovered
 * worker or resumed manager silently continue under different credentials.
 */
export function normalizePiExecutionAccount(
  request: Readonly<PiExecutionAccountRequest>,
  selection: Readonly<PiExecutionAccount>,
): PiExecutionAccount {
  const preferredAccountProfileId = normalizePiAccountProfileId(
    request.preferredAccountProfileId,
    "Preferred Pi account profile id",
  );
  const accountProfileId = normalizePiAccountProfileId(
    selection.accountProfileId,
    "Resolved Pi account profile id",
  );
  if (preferredAccountProfileId && accountProfileId !== preferredAccountProfileId) {
    throw new Error(
      `Pi account resolver did not honor the pinned profile ${preferredAccountProfileId}`,
    );
  }
  if (typeof selection.configDir !== "string" || !isAbsolute(selection.configDir)) {
    throw new TypeError("Resolved Pi account configDir must be an absolute path");
  }
  return {
    ...(accountProfileId ? { accountProfileId } : {}),
    configDir: resolve(selection.configDir),
  };
}
