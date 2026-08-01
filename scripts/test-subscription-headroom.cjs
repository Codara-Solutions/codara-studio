// Focused coverage for subscription-quota headroom routing.
//
// Three layers:
//   1. the pure math (src/main/orchestration/subscription-headroom.ts):
//      conservative min-across-windows headroom for every provider status and
//      window shape, the decisive-vs-neutral routing thresholds, the prompt
//      section's rendering and its omission, and the Electron-touching reader's
//      degrade-to-null contract (usage module stubbed).
//   2. the prompt injection (spark-agent-backend's buildManagerTurnPrompt): the
//      headroom section must land at the dynamic tail and must never render
//      when null.
//   3. the wiring that cannot be bundled standalone (run-store's manager turn,
//      agent-socket's spawn chokepoint), pinned by source assertion like the
//      workspace-lessons suite pins its run-store wiring.
//
//   node scripts/test-subscription-headroom.cjs
//
// Exits non-zero on any failed assertion.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-subscription-headroom-"));

let failures = 0;
function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : `: ${detail}`}`);
  if (!condition) failures += 1;
}

// The reader lazily imports pi-subscription-usage, which reaches Electron via
// pi-runtime-electron. Stub it behind a global hook so the reader's success,
// bad-shape, and thrown paths can all be driven from one bundle.
const stubPlugin = {
  name: "subscription-headroom-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /pi-subscription-usage$/ }, () => ({
      path: "pi-subscription-usage-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "export function inspectPiSubscriptionUsage() { return globalThis.__headroomUsageStub(); }",
      loader: "js",
    }));
  },
};

async function bundle(name, entry) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [stubPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const CHECKED_AT = "2026-07-26T00:00:00.000Z";

function win(id, label, remainingPercent, resetsIn, scope) {
  return {
    id,
    label,
    ...(scope ? { scope } : {}),
    usedPercent: Math.round((100 - remainingPercent) * 10) / 10,
    remainingPercent,
    ...(resetsIn ? { resetsIn } : {}),
  };
}

function provider(name, status, windows, extra) {
  return {
    provider: name,
    label: name === "anthropic" ? "Claude Pro / Max" : "ChatGPT Plus / Pro",
    status,
    windows,
    checkedAt: CHECKED_AT,
    ...extra,
  };
}

function overview(providers) {
  return { checkedAt: CHECKED_AT, providers };
}

function profile(profileId, providerName, label, isDefault, status, windows, extra) {
  return {
    profileId,
    provider: providerName,
    label,
    isDefault,
    status,
    windows,
    checkedAt: CHECKED_AT,
    ...extra,
  };
}

async function main() {
  const headroom = await bundle(
    "subscription-headroom",
    path.join(ROOT, "src", "main", "orchestration", "subscription-headroom.ts"),
  );
  const {
    COMFORTABLE_HEADROOM_PERCENT,
    TIGHT_HEADROOM_PERCENT,
    describeHeadroomForPrompt,
    headroomForRuntime,
    preferredRuntimeForHeadroom,
    rankProfilesForHeadroom,
    readSubscriptionHeadroomSummary,
    runtimeLimitReached,
    summarizeProfileHeadroom,
    summarizeProviderHeadroom,
  } = headroom;
  const { rosterModelFor } = await bundle(
    "worker-model-hint",
    path.join(ROOT, "src", "main", "orchestration", "worker-model-hint.ts"),
  );

  check(
    "thresholds are the documented 10/35 split",
    TIGHT_HEADROOM_PERCENT === 10 && COMFORTABLE_HEADROOM_PERCENT === 35,
    `tight=${TIGHT_HEADROOM_PERCENT} comfortable=${COMFORTABLE_HEADROOM_PERCENT}`,
  );

  // ── Headroom math across window shapes ────────────────────────────────────

  // Provider-wide guidance has no selected model. It must use only general
  // windows; a model-specific cap is evaluated later at the exact launch.
  const anthropicTight = provider("anthropic", "ok", [
    win("five_hour", "5-hour", 8, "2h 10m"),
    win("seven_day", "7-day", 55, "3d 4h"),
    win(
      "limit_fable-5",
      "Fable 5 7-day",
      2,
      "5d 1h",
      { kind: "model", modelId: "claude-fable-5", modelLabel: "Fable 5" },
    ),
  ]);
  const codexRoomy = provider("openai-codex", "ok", [
    win("primary", "5-hour", 78, "1h 3m"),
    win("secondary", "7-day", 90, "6d 2h"),
  ]);
  const both = summarizeProviderHeadroom(overview([anthropicTight, codexRoomy]));
  check(
    "provider-wide guidance excludes model-specific windows",
    both.claude.headroomPercent === 8 &&
      both.claude.tightestWindowLabel === "5-hour" &&
      both.claude.tightestWindowResetsIn === "2h 10m",
    JSON.stringify(both.claude),
  );
  check(
    "codex headroom derives from the windows present",
    both.codex.headroomPercent === 78 && both.codex.tightestWindowLabel === "5-hour",
    JSON.stringify(both.codex),
  );
  check(
    "summary carries runtime and provider identities",
    both.claude.provider === "anthropic" &&
      both.claude.runtime === "claude" &&
      both.codex.provider === "openai-codex" &&
      both.codex.runtime === "codex",
    JSON.stringify(both),
  );

  // Codex reporting a single window (the endpoint reports whatever windows
  // exist; shapes are never hardcoded).
  const singleWindow = summarizeProviderHeadroom(
    overview([provider("openai-codex", "ok", [win("primary", "7-day", 41)])]),
  );
  check(
    "a single reported window is enough for a headroom number",
    singleWindow.codex.headroomPercent === 41 && singleWindow.codex.tightestWindowResetsIn === null,
    JSON.stringify(singleWindow.codex),
  );
  check(
    "a provider absent from the overview reads as no signal",
    singleWindow.claude.headroomPercent === null && singleWindow.claude.limitReached === false,
    JSON.stringify(singleWindow.claude),
  );

  // Degraded provider statuses never fabricate a number.
  for (const status of ["expired", "error", "not_connected"]) {
    const degraded = summarizeProviderHeadroom(
      overview([provider("anthropic", status, []), codexRoomy]),
    );
    check(
      `status=${status} yields null headroom`,
      degraded.claude.headroomPercent === null,
      JSON.stringify(degraded.claude),
    );
  }
  const okNoWindows = summarizeProviderHeadroom(
    overview([provider("anthropic", "ok", [], { limitReached: true })]),
  );
  check(
    "status=ok with zero windows yields null headroom but keeps limitReached",
    okNoWindows.claude.headroomPercent === null && okNoWindows.claude.limitReached === true,
    JSON.stringify(okNoWindows.claude),
  );
  const nullOverview = summarizeProviderHeadroom(null);
  check(
    "a null overview degrades to no signal on both providers",
    nullOverview.claude.headroomPercent === null && nullOverview.codex.headroomPercent === null,
    JSON.stringify(nullOverview),
  );

  const limitHit = summarizeProviderHeadroom(
    overview([
      provider("anthropic", "ok", [win("five_hour", "5-hour", 0, "1h 12m")], { limitReached: true }),
      codexRoomy,
    ]),
  );
  check(
    "limitReached passes through beside the window math",
    limitHit.claude.limitReached === true && limitHit.claude.headroomPercent === 0,
    JSON.stringify(limitHit.claude),
  );
  check(
    "runtimeLimitReached reads the flag and never a missing summary",
    runtimeLimitReached(limitHit, "claude") === true &&
      runtimeLimitReached(limitHit, "codex") === false &&
      runtimeLimitReached(null, "claude") === false,
  );
  check(
    "headroomForRuntime looks up by runtime and tolerates null",
    headroomForRuntime(both, "codex")?.headroomPercent === 78 &&
      headroomForRuntime(null, "claude") === null,
  );

  // ── Decisive vs neutral routing thresholds ────────────────────────────────

  const mk = (claudePercent, codexPercent, extras = {}) =>
    summarizeProviderHeadroom(
      overview([
        provider(
          "anthropic",
          "ok",
          claudePercent === null ? [] : [win("five_hour", "5-hour", claudePercent)],
          extras.claude,
        ),
        provider(
          "openai-codex",
          "ok",
          codexPercent === null ? [] : [win("primary", "5-hour", codexPercent)],
          extras.codex,
        ),
      ]),
    );

  check("tight claude vs roomy codex routes to codex", preferredRuntimeForHeadroom(mk(8, 78)) === "codex");
  check("tight codex vs roomy claude routes to claude", preferredRuntimeForHeadroom(mk(90, 5)) === "claude");
  check(
    "limitReached alone is decisive when the peer is comfortable",
    preferredRuntimeForHeadroom(mk(50, 40, { claude: { limitReached: true } })) === "codex",
  );
  check(
    "exactly the tight threshold (10%) is not tight",
    preferredRuntimeForHeadroom(mk(10, 90)) === null,
  );
  check(
    "exactly the comfortable threshold (35%) is comfortable",
    preferredRuntimeForHeadroom(mk(9.9, 35)) === "codex",
  );
  check(
    "no reroute when the roomy side is below comfortable",
    preferredRuntimeForHeadroom(mk(8, 30)) === null,
  );
  check("no reroute on a mid-range pair", preferredRuntimeForHeadroom(mk(60, 55)) === null);
  check("no reroute when both are tight", preferredRuntimeForHeadroom(mk(4, 6)) === null);
  check(
    "no reroute toward a limit-reached provider even with windows showing room",
    preferredRuntimeForHeadroom(mk(8, 80, { codex: { limitReached: true } })) === null,
  );
  check(
    "a provider with no data is neither tight nor comfortable",
    preferredRuntimeForHeadroom(mk(null, 90)) === null &&
      preferredRuntimeForHeadroom(mk(8, null)) === null,
  );
  check("a null summary never routes", preferredRuntimeForHeadroom(null) === null);

  // ── Same-provider account ranking (never overrides an explicit pin) ────────

  const codexAccounts = {
    ...overview([codexRoomy]),
    profiles: [
      profile(
        "11111111-1111-4111-8111-111111111111",
        "openai-codex",
        "Codex default",
        true,
        "ok",
        [win("primary", "5-hour", 8)],
      ),
      profile(
        "22222222-2222-4222-8222-222222222222",
        "openai-codex",
        "Codex roomy",
        false,
        "ok",
        [win("primary", "5-hour", 82)],
      ),
      profile(
        "33333333-3333-4333-8333-333333333333",
        "openai-codex",
        "Codex expired",
        false,
        "expired",
        [],
      ),
    ],
  };
  const profileSignals = summarizeProfileHeadroom(codexAccounts, "openai-codex");
  check(
    "profile summary keeps opaque ids, labels and per-account windows",
    profileSignals.length === 3 &&
      profileSignals[0].profileId === "11111111-1111-4111-8111-111111111111" &&
      profileSignals[0].headroomPercent === 8 &&
      profileSignals.find((entry) => entry.profileId === "33333333-3333-4333-8333-333333333333")
        ?.headroomPercent === null,
    JSON.stringify(profileSignals),
  );
  check(
    "provider routing uses the roomiest usable account instead of the provider default",
    summarizeProviderHeadroom(codexAccounts).codex.headroomPercent === 82,
    JSON.stringify(summarizeProviderHeadroom(codexAccounts).codex),
  );
  const rankedProfiles = rankProfilesForHeadroom(codexAccounts, "openai-codex");
  check(
    "unpinned profile ranking puts usable account headroom first",
    rankedProfiles.map((entry) => entry.profileId).join(",") ===
      [
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
        "33333333-3333-4333-8333-333333333333",
      ].join(","),
    JSON.stringify(rankedProfiles),
  );
  const pinnedProfile = rankProfilesForHeadroom(
    codexAccounts,
    "openai-codex",
    "11111111-1111-4111-8111-111111111111",
  );
  check(
    "an explicit account pin is never replaced by a roomier account",
    pinnedProfile.length === 1 &&
      pinnedProfile[0].profileId === "11111111-1111-4111-8111-111111111111",
    JSON.stringify(pinnedProfile),
  );
  check(
    "an unknown explicit pin yields no candidate instead of silently falling back",
    rankProfilesForHeadroom(
      codexAccounts,
      "openai-codex",
      "44444444-4444-4444-8444-444444444444",
    ).length === 0,
  );

  // ── Prompt section rendering and omission ─────────────────────────────────

  const decisive = describeHeadroomForPrompt(both);
  check("decisive section renders", typeof decisive === "string", String(decisive));
  const decisiveLines = (decisive ?? "").split("\n");
  check("section stays within 4 lines", decisiveLines.length <= 4, String(decisive));
  check(
    "tight provider renders headroom with its binding window and reset",
    /Claude 8% left \(5-hour window, resets in 2h 10m\)/.test(decisive ?? ""),
    String(decisive),
  );
  check(
    "roomy provider renders bare headroom without window noise",
    /Codex 78% left(?!\s*\()/.test(decisive ?? ""),
    String(decisive),
  );
  check(
    "decisive gap adds the routing advice naming the roster standard model",
    (decisive ?? "").includes(`Prefer ${rosterModelFor("codex", "standard")} workers`) &&
      (decisive ?? "").includes("codex runtime"),
    String(decisive),
  );

  const neutral = describeHeadroomForPrompt(mk(60, 55));
  check(
    "neutral gap renders the numbers without a preference line",
    typeof neutral === "string" && !/Prefer /.test(neutral) && neutral.split("\n").length === 1,
    String(neutral),
  );
  const limitLine = describeHeadroomForPrompt(mk(50, 40, { claude: { limitReached: true } }));
  check(
    "limit-reached renders as such rather than as a percentage",
    /Claude limit reached/.test(limitLine ?? ""),
    String(limitLine),
  );
  check(
    "no usable data means no section at all",
    describeHeadroomForPrompt(mk(null, null)) === null && describeHeadroomForPrompt(null) === null,
  );
  const oneSided = describeHeadroomForPrompt(mk(null, 44));
  check(
    "a single usable provider still renders, without inventing the other",
    /Codex 44% left/.test(oneSided ?? "") && !/Claude/.test(oneSided ?? ""),
    String(oneSided),
  );

  // ── The Electron-touching reader degrades to null ─────────────────────────

  globalThis.__headroomUsageStub = async () => overview([anthropicTight, codexRoomy]);
  const readOk = await readSubscriptionHeadroomSummary();
  check(
    "reader folds a live overview into the summary",
    readOk?.claude?.headroomPercent === 8 && readOk?.codex?.headroomPercent === 78,
    JSON.stringify(readOk),
  );
  globalThis.__headroomUsageStub = async () => {
    throw new Error("usage endpoint down");
  };
  check("a throwing usage read degrades to null", (await readSubscriptionHeadroomSummary()) === null);

  // ── Injection into the manager turn prompt (dynamic tail) ─────────────────

  const backend = await bundle(
    "spark-agent-backend",
    path.join(ROOT, "src", "main", "orchestration", "spark-agent-backend.ts"),
  );
  const runFixture = {
    id: "run-headroom",
    title: "headroom",
    status: "running",
    workspaceId: "ws-headroom",
    cwd: "/tmp/workspace",
    createdAt: CHECKED_AT,
    updatedAt: CHECKED_AT,
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [],
    assumptions: [],
    humanMessages: [],
  };
  const message = {
    id: "u-1",
    runId: "run-headroom",
    author: "user",
    kind: "note",
    intent: "turn",
    deliveryState: "queued",
    conversationEpoch: 0,
    message: "Build the thing",
    createdAt: CHECKED_AT,
  };
  const withSection = backend.buildManagerTurnPrompt(runFixture, [message], {
    subscriptionHeadroom: decisive,
  });
  check(
    "buildManagerTurnPrompt appends the headroom section at the tail",
    withSection.endsWith(decisive) && withSection.startsWith("Build the thing"),
    withSection.slice(-200),
  );
  const withBoth = backend.buildManagerTurnPrompt(runFixture, [message], {
    coraMemory: "CORA MEMORY, THIS WORKSPACE (fixture)\n- [cora 2026-07-01] stagger searches\n[END CORA MEMORY WORKSPACE]",
    subscriptionHeadroom: decisive,
  });
  check(
    "headroom follows the cora memory block",
    withBoth.indexOf("[END CORA MEMORY WORKSPACE]") < withBoth.indexOf("Subscription headroom:"),
    withBoth.slice(-300),
  );
  const withoutSection = backend.buildManagerTurnPrompt(runFixture, [message], {
    subscriptionHeadroom: null,
  });
  check(
    "a null section appends nothing",
    !withoutSection.includes("Subscription headroom"),
    withoutSection.slice(-160),
  );

  // ── Source-pinned wiring (modules that cannot bundle standalone) ──────────

  const runStoreSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "orchestration", "run-store.ts"),
    "utf8",
  );
  check(
    "run-store feeds the section into buildManagerTurnPrompt beside the memory",
    /subscriptionHeadroom = describeHeadroomForPrompt\(await readSubscriptionHeadroomSummary\(\)\)/.test(
      runStoreSource,
    ) &&
      /coraMemory,\s*\n\s*subscriptionHeadroom,/.test(runStoreSource),
  );
  const socketSource = fs.readFileSync(path.join(ROOT, "src", "main", "agent-socket.ts"), "utf8");
  check(
    "spawn chokepoint consults the headroom signal once per batch",
    socketSource.includes("const headroomSummary = await readSubscriptionHeadroomSummary()"),
  );
  check(
    "verifier reroute health check also avoids a limit-reached provider",
    socketSource.includes("!runtimeLimitReached(headroomSummary, opposite)"),
  );
  check(
    "spawn reroute keys off the decisive preference and exempts fable pins",
    socketSource.includes("preferredRuntimeForHeadroom(headroomSummary)") &&
      /headroomReroute &&\s*\n\s*!verifierPeerOverride &&\s*\n\s*effectiveRuntime === headroomReroute\.from &&\s*\n\s*!\/fable\/i\.test\(effectiveModelHint \?\? ""\)/.test(
        socketSource,
      ),
  );
  check(
    "rerouted workers land on the equivalent tier via crossProviderPeerModel",
    socketSource.includes("crossProviderPeerModel(headroomReroute.to, effectiveModelHint)"),
  );
  check(
    "the reroute is explained to the manager through the tool-result notes",
    socketSource.includes("Subscription headroom reroute:"),
  );

  if (failures > 0) {
    console.log(`\n${failures} subscription-headroom check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll subscription-headroom checks passed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
