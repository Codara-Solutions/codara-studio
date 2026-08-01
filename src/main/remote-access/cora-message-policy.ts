export const CORA_MESSAGE_MAX_BYTES = 16 * 1024;

export class CoraMessageTooLargeError extends Error {
  readonly code = "CORA_MESSAGE_TOO_LARGE";

  constructor(
    readonly actualBytes: number,
    readonly maxBytes = CORA_MESSAGE_MAX_BYTES,
  ) {
    super(`Cora messages are limited to ${maxBytes / 1024} KiB.`);
    this.name = "CoraMessageTooLargeError";
  }
}

/**
 * One wire/storage policy for a Cora user message: trim first, then account
 * for exact UTF-8 bytes. Never truncate because doing so would change a
 * retry's durable message identity.
 */
export function normalizeCoraMessage(message: string): string {
  const normalized = message.trim();
  const actualBytes = Buffer.byteLength(normalized, "utf8");
  if (actualBytes > CORA_MESSAGE_MAX_BYTES) {
    throw new CoraMessageTooLargeError(actualBytes);
  }
  return normalized;
}
