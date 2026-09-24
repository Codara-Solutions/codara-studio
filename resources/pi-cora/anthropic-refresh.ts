/**
 * Studio renews Cora's Claude login.
 *
 * Anthropic rotates the refresh token on every refresh, so a login has room
 * for one refresher: whoever refreshes second holds a spent token, and Claude
 * Code answers a spent token by blanking its login on disk. Claude Code
 * refreshes the terminal login under its own lock; a Pi process refreshing
 * its copy on its own would be a second refresher of the same grant.
 *
 * So this process never spends a Claude refresh token. When Pi finds the
 * login expired (under its own credential lock), it asks Studio over the
 * agent socket; Studio renews the login under Claude Code's lock, or adopts
 * the token Claude Code or Studio's keeper already got, and Pi stores the
 * answer. Only trusted plans name an account (CODARA_PI_ACCOUNT_PROFILE_ID);
 * an imported-PR process keeps Pi's own refresh.
 *
 * Import-free (types only) so it stays unit-testable outside Pi's loader.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CODARA_ANTHROPIC_RENEW_METHOD = "accounts.anthropic.renew";
const RENEW_TIMEOUT_MS = 60_000;

/** The bridge's authenticated agent-socket call (resources/codara-studio-mcp/server.js). */
export type CodaraSocketRequest = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
) => Promise<unknown>;

interface PiOAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

/** The Cora account this process renews through Studio, or null to keep Pi's own refresh. */
export function codaraAnthropicRenewalAccount(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CODARA_PI_PROVIDER !== "anthropic") return null;
  if (env.CODARA_PI_PROJECT_POLICY === "untrusted-pull-request") return null;
  // A scoped capability cannot reach the method; asking would only fail.
  if ((env.SPARK_AGENT_CAPABILITY ?? "").trim()) return null;
  const accountProfileId = env.CODARA_PI_ACCOUNT_PROFILE_ID?.trim();
  return accountProfileId || null;
}

function renewedCredentials(value: unknown): { access: string; refresh: string; expires: number } {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const { access, refresh, expires } = record;
  if (typeof access !== "string" || !access) throw new Error("Studio returned no access token");
  if (typeof refresh !== "string") throw new Error("Studio returned no refresh token");
  if (typeof expires !== "number" || !Number.isFinite(expires)) {
    throw new Error("Studio returned no expiry");
  }
  return { access, refresh, expires };
}

export function registerCodaraAnthropicRenewal(
  pi: Pick<ExtensionAPI, "registerProvider">,
  input: { accountProfileId: string; request: CodaraSocketRequest },
): void {
  pi.registerProvider("anthropic", {
    oauth: {
      name: "Anthropic (Claude Pro/Max)",
      async login() {
        throw new Error("Sign in to Claude from Codara's account settings.");
      },
      async refreshToken(credentials, signal) {
        const current = credentials as PiOAuthCredentials;
        if (signal?.aborted) throw new Error("The Claude login renewal was cancelled");
        let renewed: unknown;
        try {
          renewed = await input.request(
            CODARA_ANTHROPIC_RENEW_METHOD,
            { accountProfileId: input.accountProfileId, refreshToken: current.refresh },
            RENEW_TIMEOUT_MS,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Codara could not renew the Claude login: ${reason}`);
        }
        return { ...current, ...renewedCredentials(renewed) };
      },
      getApiKey(credentials) {
        return (credentials as PiOAuthCredentials).access;
      },
    },
  });
}
