"use strict";

// Focused multi-account usage coverage. The harness stubs only the sanitized
// account registry/resolver boundary and vendor HTTP; credentials stay in
// private temporary auth files so the production parser/permission checks run.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-profile-usage-"));
const OUTFILE = path.join(TMP, "usage.cjs");
let failures = 0;

function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : `: ${detail}`}`);
  if (!condition) failures += 1;
}

const profiles = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "openai-codex",
    label: "Codex default",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    provider: "openai-codex",
    label: "Codex second",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    provider: "anthropic",
    label: "Claude offline",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    provider: "anthropic",
    label: "Claude connected",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  },
];

function writeAuth(profile, token, accountId) {
  const dir = path.join(TMP, profile.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      [profile.provider]: {
        type: "oauth",
        access: token,
        refresh: "refresh-secret",
        expires: Date.now() + 3_600_000,
        accountId,
      },
    }),
    { mode: 0o600 },
  );
  return authFile;
}

const authFiles = {
  [profiles[0].id]: writeAuth(profiles[0], "access-secret-default", "vendor-account-default"),
  [profiles[1].id]: writeAuth(profiles[1], "access-secret-second", "vendor-account-second"),
  [profiles[3].id]: writeAuth(profiles[3], "access-secret-claude", undefined),
};

globalThis.__profileUsageInspection = {
  snapshot: {
    version: 1,
    profiles,
    defaults: {
      "openai-codex": profiles[0].id,
      anthropic: profiles[2].id,
    },
  },
  statuses: [
    {
      profileId: profiles[0].id,
      provider: "openai-codex",
      connected: true,
      expired: false,
      canRefresh: true,
      expiresAt: Date.now() + 3_600_000,
    },
    {
      profileId: profiles[1].id,
      provider: "openai-codex",
      connected: true,
      expired: false,
      canRefresh: true,
      expiresAt: Date.now() + 3_600_000,
    },
    {
      profileId: profiles[2].id,
      provider: "anthropic",
      connected: false,
      expired: false,
      canRefresh: false,
      expiresAt: null,
      error: "/private/credential/path must stay private",
    },
    {
      profileId: profiles[3].id,
      provider: "anthropic",
      connected: true,
      expired: false,
      canRefresh: true,
      expiresAt: Date.now() + 3_600_000,
    },
  ],
  reconciliation: {
    migratedProfileIds: [],
    missingCredentialProfileIds: [profiles[2].id],
    orphanCredentialProfileIds: [],
  },
};
globalThis.__profileUsageAuthFiles = authFiles;
globalThis.__profileUsageRefreshCalls = [];

const stubPlugin = {
  name: "profile-usage-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /pi-account-auth-store$/ }, () => ({
      path: "account-auth-store",
      namespace: "stub",
    }));
    build.onLoad({ filter: /account-auth-store/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `
        export async function inspectPiAccountProfileAuthStore() {
          return globalThis.__profileUsageInspection;
        }
        export function defaultPiAccountAuthStore() { throw new Error("not used"); }
        export function piAccountProfilePaths() { throw new Error("not used"); }
        export async function resolvePiAccountRuntimeProfile(input) {
          const profile = globalThis.__profileUsageInspection.snapshot.profiles
            .find((entry) => entry.id === input.preferredAccountProfileId);
          if (!profile || profile.provider !== input.provider) throw new Error("invalid profile");
          return {
            accountProfileId: profile.id,
            profile,
            configDir: "private",
            authFile: globalThis.__profileUsageAuthFiles[profile.id],
          };
        }
      `,
    }));
    build.onResolve({ filter: /pi-subscription-auth$/ }, () => ({
      path: "subscription-auth",
      namespace: "stub",
    }));
    build.onLoad({ filter: /subscription-auth/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `
        export async function refreshPiSubscriptionProfileCredential(profileId) {
          globalThis.__profileUsageRefreshCalls.push(profileId);
          return null;
        }
      `,
    }));
  },
};

async function main() {
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "pi-subscription-usage.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: OUTFILE,
    plugins: [stubPlugin],
    logLevel: "silent",
  });

  let fetches = 0;
  let anthropicFetches = 0;
  let anthropicHeaders = null;
  let rateLimitAnthropic = false;
  const realDateNow = Date.now;
  let syntheticNow = realDateNow();
  Date.now = () => syntheticNow;
  globalThis.fetch = async (url, options) => {
    fetches += 1;
    if (String(url).includes("api.anthropic.com")) {
      anthropicFetches += 1;
      anthropicHeaders = options.headers;
      if (rateLimitAnthropic) {
        return new Response('{"error":{"type":"rate_limit_error"}}', {
          status: 429,
          headers: { "retry-after": "300" },
        });
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            five_hour: { utilization: 12, resets_at: "2026-08-01T00:00:00.000Z" },
            seven_day: { utilization: 34, resets_at: "2026-08-07T00:00:00.000Z" },
          });
        },
      };
    }
    const authorization = options.headers.authorization;
    const used = authorization === "Bearer access-secret-default" ? 20 : 70;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          plan_type: "pro",
          limit_reached: true,
          rate_limit: {
            primary_window: {
              used_percent: used,
              limit_window_seconds: 18_000,
              reset_after_seconds: 600,
            },
          },
          code_review_rate_limit: {
            limit_reached: true,
            primary_window: {
              used_percent: 100,
              limit_window_seconds: 604_800,
              reset_after_seconds: 86_400,
            },
          },
        });
      },
    };
  };

  const usage = require(OUTFILE);
  const first = await usage.inspectPiSubscriptionUsage(true);
  check("one sanitized usage row is returned per account", first.profiles.length === 4);
  check(
    "same-provider accounts keep independent quota windows",
    first.profiles.find((entry) => entry.profileId === profiles[0].id).windows[0].usedPercent === 20 &&
      first.profiles.find((entry) => entry.profileId === profiles[1].id).windows[0].usedPercent === 70,
    JSON.stringify(first.profiles),
  );
  check(
    "the compatibility provider projection follows the provider default",
    first.providers.find((entry) => entry.provider === "openai-codex").windows[0].usedPercent === 20,
    JSON.stringify(first.providers),
  );
  const defaultUsage = first.profiles.find(
    (entry) => entry.profileId === profiles[0].id,
  );
  check(
    "normal Codex and dedicated code-review windows keep explicit scopes",
    defaultUsage.windows[0].scope?.kind === "general" &&
      defaultUsage.windows[1].scope?.kind === "code_review" &&
      defaultUsage.generalLimitReached === false &&
      defaultUsage.limitReached === true,
    JSON.stringify(defaultUsage),
  );
  check(
    "a root aggregate limit does not become a normal-agent limit",
    defaultUsage.generalLimitReached === false &&
      defaultUsage.limitReached === true,
    JSON.stringify(defaultUsage),
  );
  check(
    "disconnected account errors are sanitized",
    first.profiles.find((entry) => entry.profileId === profiles[2].id).message ===
      "Subscription credentials are unavailable. Reconnect this account.",
  );
  check(
    "Claude usage identifies as Claude Code and carries the OAuth beta contract",
    anthropicHeaders?.["user-agent"] === "claude-code/2.1.0" &&
      anthropicHeaders?.["anthropic-beta"] === "oauth-2025-04-20",
    JSON.stringify(anthropicHeaders),
  );
  const serialized = JSON.stringify(first);
  check(
    "tokens, vendor identities and auth paths never cross the DTO boundary",
    !serialized.includes("access-secret") &&
      !serialized.includes("refresh-secret") &&
      !serialized.includes("vendor-account") &&
      !serialized.includes(TMP) &&
      !serialized.includes("/private/credential/path"),
  );

  await usage.inspectPiSubscriptionUsage(false);
  check("each connected account has its own cache entry", fetches === 3, `fetches=${fetches}`);
  const peek = usage.inspectCachedPiSubscriptionUsageProfiles();
  peek[0].windows[0].usedPercent = 999;
  check(
    "the synchronous cache peek is sanitized and mutation-safe",
    usage.inspectCachedPiSubscriptionUsageProfiles()[0].windows[0].usedPercent === 20,
  );
  syntheticNow += 59_000;
  await usage.inspectPiSubscriptionUsage(false);
  check(
    "an aggregate read near Codex expiry does not refetch profile usage",
    fetches === 3,
    `fetches=${fetches}`,
  );
  syntheticNow += 2_000;
  check(
    "the synchronous projection expires Codex after a minute but keeps Claude's safer cadence",
    usage.inspectCachedPiSubscriptionUsageProfiles().length === 1 &&
      usage.inspectCachedPiSubscriptionUsageProfiles()[0].provider === "anthropic",
  );
  await usage.inspectPiSubscriptionUsage(true);
  check("forced refresh bypasses every profile cache", fetches === 6, `fetches=${fetches}`);

  usage.invalidatePiSubscriptionUsageCache();
  rateLimitAnthropic = true;
  const throttled = await usage.inspectPiSubscriptionUsage(true);
  const throttledClaude = throttled.profiles.find((entry) => entry.profileId === profiles[3].id);
  check(
    "Claude 429 explains that only the usage probe is throttled",
    throttledClaude.status === "error" &&
      throttledClaude.message.includes("account is still connected") &&
      throttledClaude.message.includes("5m"),
    JSON.stringify(throttledClaude),
  );
  const anthropicFetchesAtThrottle = anthropicFetches;
  await usage.inspectPiSubscriptionUsage(true);
  check(
    "Retry-After prevents a forced refresh from immediately hitting Claude again",
    anthropicFetches === anthropicFetchesAtThrottle,
    `anthropicFetches=${anthropicFetches}`,
  );
  usage.invalidatePiSubscriptionUsageCache();
  check(
    "invalidation clears the synchronous profile projection",
    usage.inspectCachedPiSubscriptionUsageProfiles().length === 0,
  );
  Date.now = realDateNow;

  if (failures > 0) {
    console.log(`\n${failures} profile usage check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll profile usage checks passed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
