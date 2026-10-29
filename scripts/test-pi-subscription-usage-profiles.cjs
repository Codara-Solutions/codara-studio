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
    // file-log reaches electron through codara-home; this harness never
    // needs the log, only the returned profiles.
    build.onResolve({ filter: /\/file-log$/ }, () => ({
      path: "file-log",
      namespace: "stub",
    }));
    build.onLoad({ filter: /^file-log$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: "export function logMain() {}",
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
  let anthropicFiveHour = { utilization: 12, resets_at: "2026-08-01T00:00:00.000Z" };
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
            five_hour: anthropicFiveHour,
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
  // The manager-prompt reader outlives the provider TTL but not its own bound.
  const lastKnown = usage.inspectLastKnownPiSubscriptionUsageProfiles(30 * 60_000);
  check(
    "the last-known reader keeps usage past the provider TTL",
    lastKnown.length === 3 && lastKnown.some((entry) => entry.provider === "openai-codex"),
    JSON.stringify(lastKnown.map((entry) => entry.provider)),
  );
  lastKnown[0].windows[0].usedPercent = 999;
  check(
    "the last-known reader is mutation-safe",
    usage.inspectLastKnownPiSubscriptionUsageProfiles(30 * 60_000)[0].windows[0].usedPercent !== 999,
  );
  check(
    "the last-known reader drops reads older than its bound",
    usage.inspectLastKnownPiSubscriptionUsageProfiles(30_000).length === 0,
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

  // A full window that resets inside the five-minute Claude TTL.
  rateLimitAnthropic = false;
  const claudeUsage = (overview) =>
    overview.profiles.find((entry) => entry.profileId === profiles[3].id);
  anthropicFiveHour = { utilization: 100, resets_at: new Date(syntheticNow + 60_000).toISOString() };
  await usage.inspectPiSubscriptionUsage(true);
  const fetchesBeforeReset = anthropicFetches;
  syntheticNow += 30_000;
  await usage.inspectPiSubscriptionUsage(false);
  check(
    "a read whose windows have not reset is served from cache",
    anthropicFetches === fetchesBeforeReset,
    `anthropicFetches=${anthropicFetches}`,
  );
  anthropicFiveHour = { utilization: 3, resets_at: new Date(syntheticNow + 5 * 3_600_000).toISOString() };
  syntheticNow += 45_000;
  check(
    "the synchronous projection drops a read whose window has since reset",
    !usage.inspectCachedPiSubscriptionUsageProfiles().some((entry) => entry.provider === "anthropic"),
    JSON.stringify(usage.inspectCachedPiSubscriptionUsageProfiles().map((entry) => entry.provider)),
  );
  const afterReset = claudeUsage(await usage.inspectPiSubscriptionUsage(false));
  check(
    "a window that reset since the read is read again inside the TTL",
    anthropicFetches === fetchesBeforeReset + 1 &&
      afterReset.windows.some((window) => window.usedPercent === 3) &&
      !afterReset.windows.some((window) => window.usedPercent === 100),
    JSON.stringify({ anthropicFetches, windows: afterReset.windows }),
  );
  // A vendor that has not rolled over yet still reports the passed reset; that
  // read is cached like any other instead of making every read live.
  anthropicFiveHour = { utilization: 100, resets_at: new Date(syntheticNow - 1_000).toISOString() };
  await usage.inspectPiSubscriptionUsage(true);
  const fetchesAtLateRollover = anthropicFetches;
  syntheticNow += 10_000;
  await usage.inspectPiSubscriptionUsage(false);
  check(
    "a reset that was already past when read does not defeat the cache",
    anthropicFetches === fetchesAtLateRollover,
    `anthropicFetches=${anthropicFetches}`,
  );

  // Codex credits and rate-limit resets ride the same wham/usage read; the
  // reset list is fetched only when there is a reset to spend, for its expiry.
  const codexRequests = [];
  let resetListStatus = 200;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    codexRequests.push({ href, method: options.method ?? "GET", headers: options.headers, body: options.body });
    if (href.includes("api.anthropic.com")) {
      return new Response(JSON.stringify({ five_hour: { utilization: 5 } }), { status: 200 });
    }
    if (href.endsWith("/wham/rate-limit-reset-credits")) {
      return new Response(
        JSON.stringify({
          available_count: 2,
          credits: [
            { id: "credit-late", status: "available", expires_at: new Date(syntheticNow + 9 * 86_400_000).toISOString() },
            { id: "credit-soon", status: "available", expires_at: new Date(syntheticNow + 3 * 86_400_000).toISOString() },
          ],
        }),
        { status: resetListStatus },
      );
    }
    if (href.endsWith("/wham/rate-limit-reset-credits/consume")) {
      return new Response(JSON.stringify({ code: consumeCode }), { status: consumeStatus });
    }
    const isDefault = options.headers.authorization === "Bearer access-secret-default";
    return new Response(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_after_seconds: 600 },
        },
        credits: { has_credits: true, unlimited: false, balance: "17" },
        rate_limit_reset_credits: { available_count: isDefault ? 2 : 0 },
      }),
      { status: 200 },
    );
  };
  let consumeCode = "reset";
  let consumeStatus = 200;
  usage.invalidatePiSubscriptionUsageCache();
  const withResets = await usage.inspectPiSubscriptionUsage(true);
  const resetDefault = withResets.profiles.find((entry) => entry.profileId === profiles[0].id);
  const resetSecond = withResets.profiles.find((entry) => entry.profileId === profiles[1].id);
  check(
    "Codex credits and resets are reported beside the windows",
    resetDefault.credits?.kind === "balance" &&
      resetDefault.credits.balance === 17 &&
      resetDefault.resetCredits?.available === 2 &&
      resetDefault.resetCredits.nextExpiresAt ===
        new Date(syntheticNow + 3 * 86_400_000).toISOString() &&
      resetDefault.resetCredits.credits?.map((credit) => credit.id).join(",") === "credit-soon,credit-late" &&
      resetSecond.resetCredits?.available === 0 &&
      resetSecond.resetCredits.nextExpiresAt === undefined,
    JSON.stringify({ resetDefault, resetSecond }),
  );
  check(
    "the reset list is read only for the account with a reset to spend",
    codexRequests.filter((request) => request.href.endsWith("/wham/rate-limit-reset-credits")).length === 1,
    JSON.stringify(codexRequests.map((request) => request.href)),
  );
  check(
    "credits and resets never change the windows routing reads",
    resetDefault.windows.length === 1 && resetDefault.windows[0].usedPercent === 30,
    JSON.stringify(resetDefault.windows),
  );
  resetListStatus = 500;
  usage.invalidatePiSubscriptionUsageCache();
  const listFailed = (await usage.inspectPiSubscriptionUsage(true)).profiles.find(
    (entry) => entry.profileId === profiles[0].id,
  );
  check(
    "a failed reset list keeps the count without an expiry",
    listFailed.status === "ok" &&
      listFailed.resetCredits?.available === 2 &&
      listFailed.resetCredits.nextExpiresAt === undefined,
    JSON.stringify(listFailed),
  );

  // A spend must name its reset: without a valid credit id nothing is sent,
  // so ChatGPT never picks one and a retry can never spend a second.
  codexRequests.length = 0;
  const unnamed = [];
  for (const creditId of [undefined, null, "", "has space", 42, "x".repeat(201)]) {
    try {
      await usage.redeemCodexRateLimitReset(profiles[0].id, creditId);
      unnamed.push(`spent with ${JSON.stringify(creditId)}`);
    } catch (error) {
      unnamed.push(error.message);
    }
  }
  check(
    "a reset without a valid credit id is refused before anything is sent",
    codexRequests.length === 0 &&
      unnamed.every((message) => message === "Codara could not tell which reset to use. Check the limits and try again."),
    JSON.stringify({ unnamed, requests: codexRequests.map((request) => request.href) }),
  );

  // Spending a reset: one POST with the credit id, the account's own token
  // and account id, and the cached reading dropped afterwards.
  codexRequests.length = 0;
  const outcome = await usage.redeemCodexRateLimitReset(profiles[0].id, "credit-soon");
  const consume = codexRequests.find((request) => request.href.endsWith("/consume"));
  let redeemBody = null;
  try {
    redeemBody = JSON.parse(consume?.body ?? "null");
  } catch {
    redeemBody = null;
  }
  check(
    "a confirmed reset is one POST with a request id for that account",
    outcome === "reset" &&
      codexRequests.length === 1 &&
      consume?.method === "POST" &&
      consume.headers.authorization === "Bearer access-secret-default" &&
      consume.headers["chatgpt-account-id"] === "vendor-account-default" &&
      redeemBody?.credit_id === "credit-soon" &&
      /^[0-9a-f-]{36}$/.test(redeemBody?.redeem_request_id ?? ""),
    JSON.stringify(codexRequests),
  );
  // Naming the reset: its id goes with the request, and the request id is
  // derived from the account and the credit, so a retry spends nothing more.
  codexRequests.length = 0;
  await usage.redeemCodexRateLimitReset(profiles[0].id, "credit-soon");
  await usage.redeemCodexRateLimitReset(profiles[0].id, "credit-soon");
  const named = codexRequests
    .filter((request) => request.href.endsWith("/consume"))
    .map((request) => JSON.parse(request.body));
  check(
    "a named reset sends its credit_id with a request id stable per account and credit",
    named.length === 2 &&
      named.every((body) => body.credit_id === "credit-soon") &&
      named[0].redeem_request_id === named[1].redeem_request_id &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(named[0].redeem_request_id) &&
      named[0].redeem_request_id !== usage.codexRedeemRequestId("vendor-account-default", "credit-late"),
    JSON.stringify(named),
  );
  codexRequests.length = 0;
  await usage.inspectPiSubscriptionUsage(false);
  check(
    "the account is read again after a reset",
    codexRequests.some(
      (request) =>
        request.href.endsWith("/wham/usage") &&
        request.headers.authorization === "Bearer access-secret-default",
    ),
    JSON.stringify(codexRequests.map((request) => request.href)),
  );
  consumeCode = "no_credit";
  check(
    "the provider's answer is passed on as an outcome",
    (await usage.redeemCodexRateLimitReset(profiles[0].id, "credit-soon")) === "no_credit",
  );
  const redeemError = async (profileId) => {
    try {
      await usage.redeemCodexRateLimitReset(profileId, "credit-soon");
      return null;
    } catch (error) {
      return error.message;
    }
  };
  consumeCode = "something_new";
  check(
    "an unknown answer is an error, never a guessed outcome",
    (await redeemError(profiles[0].id))?.includes("does not recognize"),
  );
  consumeCode = "reset";
  consumeStatus = 500;
  check(
    "an HTTP failure says the limits were not reset",
    (await redeemError(profiles[0].id)) === "ChatGPT did not reset the limits (HTTP 500).",
  );
  check(
    "only Codex accounts can spend a reset",
    (await redeemError(profiles[3].id)) === "This Codex account is no longer in Codara." &&
      (await redeemError("not-a-profile")) === "This Codex account is no longer in Codara.",
  );
  globalThis.fetch = async () => {
    throw new Error(`connect failed with access-secret-default at ${TMP}`);
  };
  const transportError = await redeemError(profiles[0].id);
  check(
    "a transport failure crosses IPC as fixed copy",
    transportError === "The reset could not be sent. Check your connection and try again.",
    transportError,
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
