import { isAbsolute, resolve } from "node:path";

/**
 * Environment routes that can bypass the selected Claude subscription,
 * inject a bearer credential, or redirect Claude Code to a third-party cloud
 * provider. Matching is case-insensitive so Windows cannot retain a second,
 * differently-cased copy.
 */
export const CLAUDE_CLI_CREDENTIAL_OVERRIDE_ENV_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  // Claude Code 2.1.220 uses this internal selector to derive both its
  // secure-storage directory and the macOS Keychain service name. It must
  // never survive independently of Codara's selected CLAUDE_CONFIG_DIR.
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  // Host-managed and development OAuth routes can inject credentials without
  // consulting the selected profile. They are intentionally stripped even
  // though they are not part of Claude Code's public environment contract.
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "USE_LOCAL_OAUTH",
  "USE_STAGING_OAUTH",
  "CLAUDE_LOCAL_OAUTH_API_BASE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
]);

export function normalizeClaudeCliConfigDir(configDir: string): string {
  if (
    typeof configDir !== "string" ||
    !configDir.trim() ||
    !isAbsolute(configDir) ||
    resolve(configDir) !== configDir
  ) {
    throw new TypeError(
      "Native Claude config directory must be a non-empty canonical absolute path",
    );
  }
  return configDir;
}

/**
 * Construct a fresh child environment pinned to exactly one
 * CLAUDE_CONFIG_DIR. Generic AWS/Google credentials remain available to shell
 * tools; removing the Claude provider-selection flags above prevents them from
 * changing which provider authenticates Claude itself. The caller's object is
 * never mutated or aliased.
 */
export function buildClaudeCliProfileEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  configDir: string | null,
): NodeJS.ProcessEnv {
  const exactConfigDir =
    configDir === null ? null : normalizeClaudeCliConfigDir(configDir);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    const upper = key.toUpperCase();
    if (
      upper === "CLAUDE_CONFIG_DIR" ||
      CLAUDE_CLI_CREDENTIAL_OVERRIDE_ENV_NAMES.has(upper)
    ) {
      continue;
    }
    env[key] = value;
  }
  if (exactConfigDir !== null) env.CLAUDE_CONFIG_DIR = exactConfigDir;
  return env;
}
