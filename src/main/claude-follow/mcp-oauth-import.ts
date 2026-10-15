import {
  readClaudeCredentialStores,
  updateClaudeCredentialStores,
  type ClaudeCredentialStoreObject,
  type ClaudeCredentialStoreOptions,
} from "../orchestration/claude-cli-credentials";

/**
 * The one-time copy of the user's MCP sign-ins into the live slot, made when
 * plain `claude` starts following Codara. Claude Code keeps an MCP server's
 * OAuth grant in its credential store (`mcpOAuth`, next to the login); a
 * following terminal reads the live slot's store, so without the copy every
 * server the user had signed in to would ask again.
 *
 * The user's store is only read (the macOS Keychain item and the file, the
 * way Claude Code reads them), and only `mcpOAuth` entries the live slot
 * lacks are added: an entry the live slot already has is newer or its own.
 * Nothing else of the user's store, the login above all, is read into
 * anything or written anywhere.
 *
 * The copy shares a grant between two stores. A server that rotates its
 * refresh token on every refresh spends the other copy the first time one
 * side refreshes, and that side asks the user to sign in to the server
 * again, once.
 */

const MCP_OAUTH_KEY = "mcpOAuth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function grantsOf(store: ClaudeCredentialStoreObject | null): Record<string, unknown> {
  return store && isRecord(store[MCP_OAUTH_KEY]) ? (store[MCP_OAUTH_KEY] as Record<string, unknown>) : {};
}

export interface McpOAuthImportInput {
  /** The user's own Claude home and the CLAUDE_CONFIG_DIR it runs with (null for ~/.claude). */
  userConfigDir: string;
  userConfigDirEnv: string | null;
  liveConfigDir: string;
  options?: ClaudeCredentialStoreOptions;
}

export interface McpOAuthImportResult {
  /** Entry keys added to the live slot (server names, never tokens). */
  added: string[];
}

export async function importMcpOAuthGrants(input: McpOAuthImportInput): Promise<McpOAuthImportResult> {
  const options = input.options ?? {};
  const user = await readClaudeCredentialStores(input.userConfigDir, input.userConfigDirEnv, options);
  // Claude Code reads the Keychain item when it exists; a file beside it
  // can only add entries the item lacks.
  const grants = { ...grantsOf(user.file), ...grantsOf(user.keychain) };
  if (Object.keys(grants).length === 0) return { added: [] };
  return updateClaudeCredentialStores(
    input.liveConfigDir,
    input.liveConfigDir,
    (stores) => {
      const read = stores.keychain ?? stores.file;
      const present = grantsOf(read);
      const added = Object.keys(grants).filter((key) => present[key] === undefined);
      if (added.length === 0) return { result: { added } };
      return {
        result: { added },
        transform: (store) => {
          const current = { ...grantsOf(store) };
          for (const key of Object.keys(grants)) {
            if (current[key] === undefined) current[key] = grants[key];
          }
          store[MCP_OAUTH_KEY] = current;
          return store;
        },
      };
    },
    options,
  );
}
