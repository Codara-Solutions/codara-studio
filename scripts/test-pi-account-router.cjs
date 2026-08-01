"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(
  ROOT,
  "src",
  "main",
  "orchestration",
  "pi-account-router.ts",
);
const IDS = {
  codexA: "10000000-0000-4000-8000-000000000001",
  codexB: "10000000-0000-4000-8000-000000000002",
  claude: "10000000-0000-4000-8000-000000000003",
};

function profile(id, provider, createdAt) {
  return {
    id,
    provider,
    label: `Local ${id.at(-1)}`,
    createdAt,
    updatedAt: createdAt,
  };
}

function usage(profileId, provider, status, remainingPercent, limitReached) {
  return {
    profileId,
    provider,
    label: "local",
    isDefault: false,
    status,
    checkedAt: "2026-07-31T00:00:00.000Z",
    windows:
      remainingPercent === null
        ? []
        : [
            {
              id: "primary",
              label: "Primary",
              usedPercent: 100 - remainingPercent,
              remainingPercent,
            },
          ],
    ...(limitReached === undefined ? {} : { limitReached }),
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-router-"));
  const outfile = path.join(temp, "router.cjs");
  try {
    await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
      plugins: [
        {
          name: "pi-router-stubs",
          setup(build) {
            build.onResolve(
              { filter: /^\.\/pi-account-auth-store$/ },
              () => ({ path: "auth", namespace: "router-stub" }),
            );
            build.onResolve(
              { filter: /^\.\/pi-subscription-usage$/ },
              () => ({ path: "usage", namespace: "router-stub" }),
            );
            build.onLoad(
              { filter: /.*/, namespace: "router-stub" },
              (args) => ({
                contents:
                  args.path === "auth"
                    ? "exports.inspectPiAccountProfileAuthStore = async () => globalThis.__piRouter.inspection;"
                    : "exports.inspectCachedPiSubscriptionUsageProfiles = () => globalThis.__piRouter.usage;",
                loader: "js",
              }),
            );
          },
        },
      ],
    });
    const router = require(outfile);
    const profiles = [
      profile(
        IDS.codexA,
        "openai-codex",
        "2026-07-30T00:00:00.000Z",
      ),
      profile(
        IDS.codexB,
        "openai-codex",
        "2026-07-30T00:01:00.000Z",
      ),
      profile(
        IDS.claude,
        "anthropic",
        "2026-07-30T00:02:00.000Z",
      ),
    ];
    globalThis.__piRouter = {
      inspection: {
        snapshot: {
          version: 1,
          profiles,
          defaults: {
            "openai-codex": IDS.codexA,
            anthropic: IDS.claude,
          },
        },
        statuses: profiles.map((entry) => ({
          profileId: entry.id,
          provider: entry.provider,
          connected: true,
          expired: false,
          canRefresh: true,
          expiresAt: null,
        })),
        reconciliation: {
          migratedProfileIds: [],
          missingCredentialProfileIds: [],
          orphanCredentialProfileIds: [],
        },
      },
      usage: [
        usage(IDS.codexA, "openai-codex", "ok", 25),
        usage(IDS.codexB, "openai-codex", "ok", 80),
        usage(IDS.claude, "anthropic", "ok", 99),
      ],
    };
    globalThis.__piRouter.usage[0].windows.push({
      id: "unknown-model",
      label: "Unknown model cap",
      scope: { kind: "model", modelLabel: "Unknown" },
      usedPercent: 10,
      remainingPercent: 90,
    });
    globalThis.__piRouter.usage[0].windows[0].usedPercent = 10;
    globalThis.__piRouter.usage[0].windows[0].remainingPercent = 90;

    // codexA is the provider's ACTIVE account (snapshot.defaults) but carries
    // only a partial quota signal; codexB has complete coverage and more
    // headroom. The user's explicit Settings pick still wins — one live login
    // at a time is the model the Active badge promises.
    let ranked = await router.rankImplicitPiAccounts("openai-codex");
    assert.deepEqual(
      ranked.map((entry) => entry.accountProfileId),
      [IDS.codexA, IDS.codexB],
      "the account marked Active in Settings outranks a rival with more complete cached headroom",
    );
    assert.equal(
      ranked.some((entry) => entry.accountProfileId === IDS.claude),
      false,
      "cross-provider accounts never enter candidates",
    );

    // With no account marked Active, cached quota is the only signal left and
    // the original coverage-beats-partial ordering still governs.
    globalThis.__piRouter.inspection.snapshot.defaults["openai-codex"] = undefined;
    ranked = await router.rankImplicitPiAccounts("openai-codex");
    assert.deepEqual(
      ranked.map((entry) => entry.accountProfileId),
      [IDS.codexB, IDS.codexA],
      "with no active account, complete quota coverage outranks a larger but partial signal",
    );
    globalThis.__piRouter.inspection.snapshot.defaults["openai-codex"] = IDS.codexA;

    // Failover: an exhausted Active account is filtered out before ranking, so
    // routing moves to the next usable account instead of parking on the pick.
    globalThis.__piRouter.usage = [
      usage(IDS.codexA, "openai-codex", "ok", 0, true),
      usage(IDS.codexB, "openai-codex", "ok", 60),
    ];
    ranked = await router.rankImplicitPiAccounts("openai-codex");
    assert.deepEqual(
      ranked.map((entry) => entry.accountProfileId),
      [IDS.codexB],
      "a limit-reached active account falls out and routing fails over",
    );
    assert.equal(
      (await router.selectImplicitPiAccount("openai-codex"))?.accountProfileId,
      IDS.codexB,
      "launch selection follows the same failover when the active account is exhausted",
    );
    globalThis.__piRouter.usage = [
      usage(IDS.codexA, "openai-codex", "ok", 25),
      usage(IDS.codexB, "openai-codex", "ok", 80),
      usage(IDS.claude, "anthropic", "ok", 99),
    ];
    globalThis.__piRouter.usage[0].windows.push({
      id: "unknown-model",
      label: "Unknown model cap",
      scope: { kind: "model", modelLabel: "Unknown" },
      usedPercent: 10,
      remainingPercent: 90,
    });
    globalThis.__piRouter.usage[0].windows[0].usedPercent = 10;
    globalThis.__piRouter.usage[0].windows[0].remainingPercent = 90;

    // No billing failover, by design: a provider billing decline (Anthropic's
    // Extra Usage 400) must fail the run visibly rather than silently reroute
    // to another account. Cached usage windows are therefore the ONLY signal
    // that can push an account out of implicit routing — the router must not
    // consult any account-decline/availability state.
    const routerSource = fs.readFileSync(ENTRY, "utf8");
    assert.doesNotMatch(
      routerSource,
      /pi-account-availability|isPiAccountTemporarilyUnavailable|SubscriptionDecline/,
      "the router must not consult any billing-decline availability state",
    );
    assert.equal(
      fs.existsSync(
        path.join(ROOT, "src", "main", "orchestration", "pi-account-availability.ts"),
      ),
      false,
      "the declined-account failover module must stay deleted",
    );
    ranked = await router.rankImplicitPiAccounts("openai-codex");
    assert.deepEqual(
      ranked.map((entry) => entry.accountProfileId),
      [IDS.codexA, IDS.codexB],
      "an account that just returned a billing decline keeps its place in routing",
    );

    globalThis.__piRouter.inspection.statuses.find(
      (entry) => entry.profileId === IDS.codexB,
    ).connected = false;
    ranked = await router.rankImplicitPiAccounts("openai-codex");
    assert.deepEqual(ranked.map((entry) => entry.accountProfileId), [
      IDS.codexA,
    ]);

    globalThis.__piRouter.inspection.statuses.find(
      (entry) => entry.profileId === IDS.codexB,
    ).connected = true;
    globalThis.__piRouter.usage = [
      usage(IDS.codexA, "openai-codex", "ok", 0, true),
      usage(IDS.codexB, "openai-codex", "error", null),
    ];
    ranked = await router.rankImplicitPiAccounts("openai-codex");
    assert.deepEqual(ranked, [
      { accountProfileId: IDS.codexB, headroomPercent: null },
    ]);

    globalThis.__piRouter.usage = [];
    ranked = await router.rankImplicitPiAccounts("openai-codex");
    assert.equal(
      ranked[0].accountProfileId,
      IDS.codexA,
      "unknown quota falls back deterministically to provider default",
    );
    assert.equal(
      JSON.stringify(ranked).includes("token") ||
        JSON.stringify(ranked).includes("identity") ||
        JSON.stringify(ranked).includes("Local"),
      false,
      "routing output contains only opaque ids and sanitized headroom",
    );

    globalThis.__piRouter.usage = [
      usage(IDS.codexA, "openai-codex", "ok", 0, true),
      usage(IDS.codexB, "openai-codex", "ok", 0, true),
    ];
    assert.deepEqual(
      await router.rankImplicitPiAccounts("openai-codex"),
      [],
      "all known-limited accounts produce no implicit route",
    );
    assert.deepEqual(
      await router.selectImplicitPiAccount("openai-codex"),
      {
        accountProfileId: IDS.codexA,
        headroomPercent: 0,
        knownLimitReached: true,
      },
      "launch selection freezes a deterministic exact account instead of drifting through the mutable default",
    );

    globalThis.__piRouter.usage = [
      usage(IDS.codexA, "anthropic", "ok", 100),
      usage(IDS.codexB, "openai-codex", "ok", 80),
    ];
    globalThis.__piRouter.inspection.statuses.find(
      (entry) => entry.profileId === IDS.codexA,
    ).provider = "anthropic";
    ranked = await router.rankImplicitPiAccounts("openai-codex");
    assert.deepEqual(
      ranked.map((entry) => entry.accountProfileId),
      [IDS.codexB],
      "cross-provider auth and usage projections cannot influence another provider route",
    );

    globalThis.__piRouter.inspection.statuses.find(
      (entry) => entry.profileId === IDS.codexA,
    ).provider = "openai-codex";
    globalThis.__piRouter.inspection.statuses.push({
      ...globalThis.__piRouter.inspection.statuses.find(
        (entry) => entry.profileId === IDS.codexB,
      ),
    });
    ranked = await router.rankImplicitPiAccounts("openai-codex");
    assert.deepEqual(
      ranked.map((entry) => entry.accountProfileId),
      [IDS.codexA],
      "duplicate auth projections fail the duplicated profile closed",
    );

    console.log(
      "PASS Pi implicit router ranks only connected token-free same-provider accounts",
    );
  } finally {
    delete globalThis.__piRouter;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
