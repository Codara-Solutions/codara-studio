import { createHash } from "node:crypto";
import type { ManagerApplicationReceipt, SparkCall } from "@shared/types";

export const CODARA_COMPLETE_PAYLOAD_SCHEMA_VERSION = 1 as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_KEYS = new Set([
  "key",
  "method",
  "state",
  "payloadSchemaVersion",
  "payloadSha256",
  "result",
  "appliedAt",
  "summaryMessageId",
  "recoveryAccountProfileId",
]);

export function canonicalCodaraCompleteSummary(summary: string): string {
  return summary.trim();
}

export function codaraCompleteReceiptKey(callId: string): string {
  return `${callId}:codara_complete`;
}

export function hashCodaraCompletePayload(summary: string): string {
  const canonical = JSON.stringify({
    version: CODARA_COMPLETE_PAYLOAD_SCHEMA_VERSION,
    summary: canonicalCodaraCompleteSummary(summary),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function isOptionalBoundedString(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.length > 0 && value.length <= 256)
  );
}

export function isCodaraCompleteReceipt(
  value: unknown,
  callId: string,
): value is ManagerApplicationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).some((key) => !RECEIPT_KEYS.has(key))) return false;
  const result = receipt.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (
    Object.keys(result).length !== 1 ||
    (result as Record<string, unknown>).ok !== true
  ) {
    return false;
  }
  return (
    receipt.key === codaraCompleteReceiptKey(callId) &&
    receipt.method === "codara_complete" &&
    receipt.state === "effects_applied" &&
    receipt.payloadSchemaVersion === CODARA_COMPLETE_PAYLOAD_SCHEMA_VERSION &&
    typeof receipt.payloadSha256 === "string" &&
    SHA256_PATTERN.test(receipt.payloadSha256) &&
    typeof receipt.appliedAt === "string" &&
    Number.isFinite(Date.parse(receipt.appliedAt)) &&
    isOptionalBoundedString(receipt.summaryMessageId) &&
    isOptionalBoundedString(receipt.recoveryAccountProfileId)
  );
}

/**
 * Normalize the private application outbox without turning corruption into an
 * apparently-unused call. Invalid/duplicate records set a sticky marker so
 * boot recovery can acknowledge locally and refuse provider replay.
 */
export function normalizeManagerApplicationReceipts(call: SparkCall): void {
  const rawCall = call as SparkCall & {
    applicationReceipts?: unknown;
    applicationReceiptIntegrity?: unknown;
  };
  let invalid = rawCall.applicationReceiptIntegrity === "invalid";
  if (
    rawCall.applicationReceiptIntegrity !== undefined &&
    rawCall.applicationReceiptIntegrity !== "invalid"
  ) {
    invalid = true;
  }

  const raw = rawCall.applicationReceipts;
  if (raw === undefined) {
    delete call.applicationReceipts;
  } else if (!Array.isArray(raw)) {
    invalid = true;
    delete call.applicationReceipts;
  } else {
    const valid: ManagerApplicationReceipt[] = [];
    for (const entry of raw) {
      if (!isCodaraCompleteReceipt(entry, call.id)) {
        invalid = true;
        continue;
      }
      valid.push(entry);
    }
    if (valid.length !== raw.length || valid.length > 1) invalid = true;
    call.applicationReceipts = valid.slice(0, 1);
  }

  if (invalid) call.applicationReceiptIntegrity = "invalid";
  else delete call.applicationReceiptIntegrity;
}

export function codaraCompleteReceiptForCall(
  call: SparkCall,
): ManagerApplicationReceipt | undefined {
  if (call.applicationReceiptIntegrity === "invalid") return undefined;
  const receipts = call.applicationReceipts ?? [];
  if (receipts.length !== 1) return undefined;
  const receipt = receipts[0];
  return isCodaraCompleteReceipt(receipt, call.id) ? receipt : undefined;
}
