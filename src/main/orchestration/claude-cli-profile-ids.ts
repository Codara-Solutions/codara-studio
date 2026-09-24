/**
 * The identifiers and file names of the Claude account store, kept apart from
 * the store itself so the live-login module can use them without importing
 * the store that in turn reads profiles through it.
 */

export const CLAUDE_CLI_PERSONAL_PROFILE_ID = "personal" as const;
export const CLAUDE_CLI_ACCOUNTS_DIRECTORY = "accounts";
export const CLAUDE_CLI_CONFIG_FILE = ".claude.json";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ClaudeCliProfileId =
  | typeof CLAUDE_CLI_PERSONAL_PROFILE_ID
  | string;

export function isClaudeCliManagedProfileId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

export function normalizeClaudeCliProfileId(
  value: unknown,
  label = "Native Claude account profile id",
): ClaudeCliProfileId {
  if (value === undefined || value === null || value === "") {
    return CLAUDE_CLI_PERSONAL_PROFILE_ID;
  }
  if (value === CLAUDE_CLI_PERSONAL_PROFILE_ID || isClaudeCliManagedProfileId(value)) {
    return value;
  }
  throw new TypeError(`${label} must be "personal" or a lowercase UUIDv4`);
}
