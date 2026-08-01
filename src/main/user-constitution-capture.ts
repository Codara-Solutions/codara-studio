import type { RunState, UserConstitutionCapture } from "@shared/types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Validate persisted provenance without consulting current Settings. A
 * present capture is all-or-nothing: unknown keys and malformed values fail
 * closed, while callers decide separately whether legacy absence is allowed.
 */
export function normalizeUserConstitutionCapture(
  value: unknown,
): UserConstitutionCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("User constitution capture is invalid.");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["enabledAtCapture", "revision", "sha256"];
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index])
  ) {
    throw new TypeError("User constitution capture is invalid.");
  }

  const capture = value as Partial<UserConstitutionCapture>;
  if (
    typeof capture.enabledAtCapture !== "boolean" ||
    !Number.isSafeInteger(capture.revision) ||
    capture.revision! < 0 ||
    (capture.enabledAtCapture && capture.revision === 0) ||
    typeof capture.sha256 !== "string" ||
    !SHA256_PATTERN.test(capture.sha256)
  ) {
    throw new TypeError("User constitution capture is invalid.");
  }

  return Object.freeze({
    enabledAtCapture: capture.enabledAtCapture,
    revision: capture.revision!,
    sha256: capture.sha256,
  });
}

/** Return a separately owned, runtime-frozen provenance record. */
export function copyUserConstitutionCapture(
  capture: UserConstitutionCapture,
): UserConstitutionCapture {
  return normalizeUserConstitutionCapture({ ...capture });
}

/**
 * Clone the capture frozen on a run. Legacy absence stays absent and never
 * triggers a read of the current global setting.
 */
export function copyRunUserConstitutionCapture(
  run: Pick<RunState, "userConstitution">,
): UserConstitutionCapture | undefined {
  return run.userConstitution
    ? copyUserConstitutionCapture(run.userConstitution)
    : undefined;
}

function normalizePresentCapture(
  owner: object,
  label: string,
): UserConstitutionCapture | undefined {
  if (!Object.prototype.hasOwnProperty.call(owner, "userConstitution")) {
    return undefined;
  }
  try {
    return normalizeUserConstitutionCapture(
      (owner as { userConstitution?: unknown }).userConstitution,
    );
  } catch {
    throw new Error(`${label} user constitution capture is invalid or corrupted.`);
  }
}

/**
 * Persistence-edge validation for run provenance. Every present value is
 * rebuilt as its own frozen object; missing legacy values are left missing.
 */
export function normalizeRunUserConstitutionProvenance(run: RunState): void {
  const runCapture = normalizePresentCapture(run, "Run");
  if (runCapture) run.userConstitution = runCapture;

  if (Array.isArray(run.sparkCalls)) {
    for (const call of run.sparkCalls) {
      const capture = normalizePresentCapture(call, "Spark call");
      if (capture) call.userConstitution = capture;
    }
  }
  if (Array.isArray(run.workerAttempts)) {
    for (const attempt of run.workerAttempts) {
      const capture = normalizePresentCapture(attempt, "Worker attempt");
      if (capture) attempt.userConstitution = capture;
    }
  }
}
