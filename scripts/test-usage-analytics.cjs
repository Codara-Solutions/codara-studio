// Unit tests for the Usage tab's pure analytics layer:
// src/shared/usage-analytics.ts (transcript parsers + day aggregation) and the
// price lookup that feeds it, src/main/model-prices.ts#lookupUsagePrice.
//
// The parsers are where this feature can be silently, expensively wrong: each
// provider has its own double-counting hazard (Claude repeats a message's usage
// once per content block; Codex re-emits identical token_counts on stream
// boundaries and reports input inclusive of cache), and none of them announce
// themselves in the output — the totals just come out ~2.4x too high. Every
// rule below is pinned against a real-shaped line taken from this machine's
// transcripts.
//
//   node scripts/test-usage-analytics.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const SHARED_TS = path.join(SHARED_DIR, "usage-analytics.ts");
const PRICES_TS = path.join(ROOT, "src", "main", "model-prices.ts");

const SCANNER_TS = path.join(ROOT, "src", "main", "usage-analytics.ts");

const harnessPlugin = {
  name: "usage-analytics-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    // The scanner reaches Electron through codara-home (app.getPath) and the
    // provider-home resolvers. Nothing under test calls into it.
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "module.exports = { app: { getPath: () => '/dev/null' } };",
      loader: "js",
    }));
  },
};

async function bundle(entry, outfile) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [harnessPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

let pass = 0;
const check = (name, ok) => {
  if (!ok) {
    console.error(`FAIL ${name}`);
    process.exit(1);
  }
  pass += 1;
  console.log(`PASS ${name}`);
};
const eq = (name, actual, expected) =>
  check(
    `${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
    actual === expected,
  );
const near = (name, actual, expected) =>
  check(
    `${name} (got ${actual}, want ~${expected})`,
    Math.abs(actual - expected) < 1e-9,
  );

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-usage-"));
  const usage = await bundle(SHARED_TS, path.join(tmp, "usage.bundle.cjs"));
  const prices = await bundle(PRICES_TS, path.join(tmp, "prices.bundle.cjs"));

  const {
    UsageAggregator,
    enumerateDays,
    initialCodexScanState,
    initialPiScanState,
    makeUsageWindow,
    mightCarryUsage,
    parseClaudeLine,
    parseCodexLine,
    parsePiLine,
    priceUsageRecord,
    totalTokens,
  } = usage;
  const { lookupUsagePrice } = prices;

  /* ── Claude parser ─────────────────────────────────────────────────────── */

  const claudeLine = (over = {}) =>
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-25T13:29:23.522Z",
      sessionId: "87fb6e27-8da4-4286-bfbb-d287cf3525d0",
      requestId: "req_011CdNrbcRsyZmd4JJrecc1q",
      message: {
        model: "claude-opus-5",
        id: "msg_011CdNrbdTPobRkcnrYSRe5s",
        role: "assistant",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 9723,
          cache_read_input_tokens: 9757,
          output_tokens: 7,
        },
      },
      ...over,
    });

  const claude = parseClaudeLine(claudeLine());
  eq("claude: a line without cwd has no project", claude.project, null);
  eq(
    "claude: cwd is the project",
    parseClaudeLine(claudeLine({ cwd: "/Users/x/Projects/app" })).project,
    "/Users/x/Projects/app",
  );
  check("claude: a real-shaped assistant line parses", claude !== null);
  eq("claude: model carries through", claude.model, "claude-opus-5");
  eq("claude: uncached input", claude.totals.uncachedInputTokens, 2);
  eq("claude: cache reads", claude.totals.cachedInputTokens, 9757);
  eq("claude: cache creation", claude.totals.cacheCreationTokens, 9723);
  eq("claude: output", claude.totals.outputTokens, 7);
  eq("claude: reasoning is folded into output by Anthropic", claude.totals.reasoningTokens, 0);
  eq("claude: no costUSD means no reported cost", claude.reportedCostUsd, null);
  eq(
    "claude: dedupe key pairs message id and request id",
    claude.dedupeKey,
    "msg_011CdNrbdTPobRkcnrYSRe5s:req_011CdNrbcRsyZmd4JJrecc1q",
  );
  eq(
    "claude: costUSD passes through as the reported cost",
    parseClaudeLine(claudeLine({ costUSD: 0.42 })).reportedCostUsd,
    0.42,
  );
  eq(
    "claude: a record with neither id is inherently unique",
    parseClaudeLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-25T13:29:23.522Z",
        message: { model: "claude-opus-5", role: "assistant", usage: { output_tokens: 5 } },
      }),
    ).dedupeKey,
    null,
  );
  eq("claude: user lines are not usage", parseClaudeLine(JSON.stringify({ type: "user" })), null);
  eq(
    "claude: an assistant line without usage is skipped",
    parseClaudeLine(
      JSON.stringify({ type: "assistant", timestamp: "2026-07-25T13:29:23.522Z", message: {} }),
    ),
    null,
  );
  eq(
    "claude: a line with no model is skipped",
    parseClaudeLine(claudeLine({ message: { role: "assistant", usage: { output_tokens: 1 } } })),
    null,
  );
  eq(
    "claude: an unparseable timestamp is skipped",
    parseClaudeLine(claudeLine({ timestamp: "not a date" })),
    null,
  );
  eq("claude: malformed JSON is skipped", parseClaudeLine("{not json"), null);
  eq("claude: the pre-gate keys off the usage field", mightCarryUsage(claudeLine(), "claude"), true);
  eq("claude: the pre-gate rejects a tool-output line", mightCarryUsage("{}", "claude"), false);

  /* ── Codex parser ──────────────────────────────────────────────────────── */

  const tokenCount = (over = {}, timestamp = "2026-06-24T22:03:11.054Z") =>
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 12874,
            cached_input_tokens: 12672,
            output_tokens: 635,
            reasoning_output_tokens: 516,
            total_tokens: 13509,
            ...over,
          },
        },
      },
    });
  const turnContext = (model) =>
    JSON.stringify({
      timestamp: "2026-06-24T22:03:02.842Z",
      type: "turn_context",
      payload: { model },
    });
  const sessionMeta = JSON.stringify({
    timestamp: "2026-06-24T22:03:02.839Z",
    type: "session_meta",
    payload: { id: "019efba8-6f47-7fa2-b182-66ae4ed19230" },
  });

  {
    const state = initialCodexScanState();
    eq("codex: session_meta yields no record", parseCodexLine(sessionMeta, state), null);
    // The ordering rule that costs real tokens when it is wrong.
    eq(
      "codex: a token_count before any turn_context is skipped",
      parseCodexLine(tokenCount(), state),
      null,
    );
    eq("codex: turn_context yields no record", parseCodexLine(turnContext("gpt-5.5"), state), null);
    const record = parseCodexLine(tokenCount(), state);
    check(
      "codex: the re-emitted copy counts — the skipped one must not have consumed the dup signature",
      record !== null,
    );
    eq("codex: the model is carried forward from turn_context", record.model, "gpt-5.5");
    eq("codex: the session id comes from session_meta", record.sessionId, "019efba8-6f47-7fa2-b182-66ae4ed19230");
    eq("codex: session_meta without cwd leaves the project null", record.project, null);
    {
      const withCwd = initialCodexScanState();
      parseCodexLine(
        JSON.stringify({
          timestamp: "2026-06-24T22:03:02.839Z",
          type: "session_meta",
          payload: { id: "s2", cwd: "/Users/x/Projects/other" },
        }),
        withCwd,
      );
      parseCodexLine(turnContext("gpt-5.5"), withCwd);
      eq(
        "codex: session_meta cwd is carried onto every record",
        parseCodexLine(tokenCount(), withCwd).project,
        "/Users/x/Projects/other",
      );
    }
    eq("codex: input_tokens is inclusive of cache", record.totals.uncachedInputTokens, 12874 - 12672);
    eq("codex: cached input", record.totals.cachedInputTokens, 12672);
    eq("codex: output", record.totals.outputTokens, 635);
    eq("codex: reasoning is a subset of output", record.totals.reasoningTokens, 516);
    eq("codex: rollouts report no cost", record.reportedCostUsd, null);
    eq("codex: one file is one session, so no dedupe key", record.dedupeKey, null);
    eq(
      "codex: an identical consecutive token_count is skipped",
      parseCodexLine(tokenCount(), state),
      null,
    );
    const changed = parseCodexLine(tokenCount({ output_tokens: 700 }), state);
    check("codex: a changed token_count counts again", changed !== null);
    parseCodexLine(turnContext("gpt-5.6-sol"), state);
    eq(
      "codex: a mid-session model switch reattributes from the switch onward",
      parseCodexLine(tokenCount({ output_tokens: 900 }), state).model,
      "gpt-5.6-sol",
    );
  }
  {
    const state = initialCodexScanState();
    parseCodexLine(turnContext("gpt-5.5"), state);
    const clamped = parseCodexLine(
      tokenCount({ input_tokens: 100, cached_input_tokens: 90, cache_write_input_tokens: 40 }),
      state,
    );
    eq("codex: uncached input clamps at zero, never negative", clamped.totals.uncachedInputTokens, 0);
    eq("codex: cache writes are read from cache_write_input_tokens", clamped.totals.cacheCreationTokens, 40);
    const overReasoned = parseCodexLine(
      tokenCount({ output_tokens: 10, reasoning_output_tokens: 999 }),
      state,
    );
    eq("codex: reasoning is clamped to output", overReasoned.totals.reasoningTokens, 10);
    eq(
      "codex: a token_count with a null info payload is skipped",
      parseCodexLine(
        JSON.stringify({
          timestamp: "2026-06-24T22:03:11.054Z",
          type: "event_msg",
          payload: { type: "token_count", info: null },
        }),
        state,
      ),
      null,
    );
    eq("codex: the pre-gate keys off token_count", mightCarryUsage(tokenCount(), "codex"), true);
  }

  /* ── Pi (cora) parser ──────────────────────────────────────────────────── */

  const piHeader = JSON.stringify({
    type: "session",
    version: 3,
    id: "run-mshkh9ky-1ffh0j-auto-fast-0-1",
    timestamp: "2026-08-06T13:44:00.040Z",
  });
  const piMessage = (usageOver = {}) =>
    JSON.stringify({
      type: "message",
      id: "8b381664",
      timestamp: "2026-07-24T21:27:33.253Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-5",
        usage: {
          input: 2,
          output: 198,
          cacheRead: 0,
          cacheWrite: 14361,
          reasoning: 0,
          totalTokens: 14561,
          cost: { input: 1e-5, output: 0.00495, cacheRead: 0, cacheWrite: 0.08975625, total: 0.09471625 },
          ...usageOver,
        },
      },
    });

  {
    const state = initialPiScanState("fallback-id");
    eq("cora: the header line yields no record", parsePiLine(piHeader, state), null);
    const record = parsePiLine(piMessage(), state);
    check("cora: a real-shaped assistant message parses", record !== null);
    eq("cora: the session id comes from the header line", record.sessionId, "run-mshkh9ky-1ffh0j-auto-fast-0-1");
    {
      const withCwd = initialPiScanState();
      parsePiLine(
        JSON.stringify({ type: "session", id: "s3", cwd: "/Users/x/Projects/cora", timestamp: "2026-07-01T00:00:00Z", version: 1 }),
        withCwd,
      );
      eq("cora: the header cwd is the project", parsePiLine(piMessage(), withCwd).project, "/Users/x/Projects/cora");
    }
    eq("cora: input maps to uncached input", record.totals.uncachedInputTokens, 2);
    eq("cora: cacheRead maps to cached input", record.totals.cachedInputTokens, 0);
    eq("cora: cacheWrite maps to cache creation", record.totals.cacheCreationTokens, 14361);
    eq("cora: output", record.totals.outputTokens, 198);
    eq("cora: Pi's exact cost is taken as reported", record.reportedCostUsd, 0.09471625);
    eq("cora: one writer per file, so no dedupe key", record.dedupeKey, null);
    eq(
      "cora: a zero-token turn (a failed request) is skipped",
      parsePiLine(piMessage({ totalTokens: 0, input: 0, output: 0, cacheWrite: 0 }), state),
      null,
    );
    eq(
      "cora: a user message is not usage",
      parsePiLine(
        JSON.stringify({ type: "message", timestamp: "2026-07-24T21:27:33.253Z", message: { role: "user" } }),
        state,
      ),
      null,
    );
  }
  {
    // A file whose header line was lost still attributes to a session.
    const state = initialPiScanState("fallback-id");
    eq("cora: the file basename backs up a missing header", parsePiLine(piMessage(), state).sessionId, "fallback-id");
    const overReasoned = parsePiLine(piMessage({ reasoning: 9999 }), state);
    eq("cora: reasoning is clamped to output", overReasoned.totals.reasoningTokens, 198);
  }

  eq("totals: reasoning is never added on top of output", totalTokens({
    uncachedInputTokens: 1,
    cachedInputTokens: 2,
    cacheCreationTokens: 3,
    outputTokens: 4,
    reasoningTokens: 4,
  }), 10);

  /* ── Pricing ───────────────────────────────────────────────────────────── */

  for (const model of ["gpt-6-astra", "openai/gpt-6-astra", "gpt-6-astra@high", "gpt-6-astra-20260901"]) {
    const rate = lookupUsagePrice(model, "codex");
    check(`pricing: ${model} resolves`, rate !== null);
    eq(`pricing: ${model} input`, rate.input, 10);
    eq(`pricing: ${model} output`, rate.output, 50);
    eq(`pricing: ${model} cached input`, rate.cacheRead, 1);
    eq(`pricing: ${model} cache writes`, rate.cacheWrite, 12.5);
  }
  const opus = lookupUsagePrice("claude-opus-5", "claude");
  check("pricing: a listed model resolves", opus !== null);
  eq("pricing: input rate", opus.input, 5);
  eq("pricing: cache writes bill at 1.25x input", opus.cacheWrite, 6.25);
  eq(
    "pricing: a dated model id falls back to its base rate",
    lookupUsagePrice("claude-haiku-4-5-20251001", "claude").input,
    1,
  );
  eq(
    "pricing: a [1m] context tag falls back to the base rate",
    lookupUsagePrice("claude-opus-5[1m]", "claude").input,
    5,
  );
  eq(
    "pricing: a codex model resolves under the openai vendor",
    lookupUsagePrice("gpt-5.6-sol", "codex").output,
    30,
  );
  eq(
    "pricing: a Cora session running an Anthropic model prices as Anthropic",
    lookupUsagePrice("claude-sonnet-5", "cora").input,
    2,
  );
  eq(
    "pricing: a listed point release prices at its own row",
    lookupUsagePrice("claude-fable-5-1", "claude").input,
    10,
  );
  eq(
    "pricing: an unlisted point release falls back to its family's major version",
    lookupUsagePrice("claude-opus-5-2", "claude").input,
    5,
  );
  eq(
    "pricing: a dated unlisted point release still resolves",
    lookupUsagePrice("claude-fable-5-1-20260901[1m]", "claude").output,
    50,
  );
  eq("pricing: a bare family name is ambiguous and stays unpriced", lookupUsagePrice("opus", "claude"), null);
  eq("pricing: <synthetic> was never billed, so it prices at zero", lookupUsagePrice("<synthetic>", "claude").output, 0);
  eq("pricing: the claude-test fixture model prices at zero", lookupUsagePrice("claude-test", "claude").input, 0);
  eq("pricing: an unknown model stays unpriced", lookupUsagePrice("llama-9", "codex"), null);
  eq(
    "pricing: a model without a cacheRead rate falls back to the input rate",
    lookupUsagePrice("gpt-5.5", "codex").cacheRead,
    1.25,
  );

  const totals = {
    uncachedInputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 0,
  };
  eq(
    "pricing: a reported cost wins over the table",
    priceUsageRecord(lookupUsagePrice, "cora", "claude-opus-5", totals, 0.5).costSource,
    "reported",
  );
  near(
    "pricing: the reported figure is used verbatim",
    priceUsageRecord(lookupUsagePrice, "cora", "claude-opus-5", totals, 0.5).costUsd,
    0.5,
  );
  const astra = priceUsageRecord(lookupUsagePrice, "codex", "gpt-6-astra", totals, null);
  eq("pricing: Astra usage is priced instead of unpriced", astra.costSource, "priced");
  near("pricing: Astra charges input, output, cache reads and writes", astra.costUsd, 73.5);
  const priced = priceUsageRecord(lookupUsagePrice, "claude", "claude-opus-5", totals, null);
  eq("pricing: no reported cost falls to the table", priced.costSource, "priced");
  // 5 (input) + 0.5 (cache read) + 6.25 (cache write) + 25 (output).
  near("pricing: every dimension is billed, cache writes included", priced.costUsd, 36.75);
  const unpriced = priceUsageRecord(lookupUsagePrice, "claude", "opus", totals, null);
  eq("pricing: an unknown model reports as unpriced", unpriced.costSource, "unpriced");
  eq("pricing: an unpriced record contributes no cost", unpriced.costUsd, 0);

  /* ── Aggregation ───────────────────────────────────────────────────────── */

  const record = (over = {}) => ({
    provider: "claude",
    timestampMs: Date.parse("2026-07-25T12:00:00Z"),
    model: "claude-opus-5",
    sessionId: "session-a",
    totals: { ...totals },
    reportedCostUsd: null,
    dedupeKey: null,
    ...over,
  });

  {
    const aggregator = new UsageAggregator({
      timeZone: "Asia/Bangkok",
      sinceDay: "2026-07-01",
      untilDay: "2026-07-31",
      lookup: lookupUsagePrice,
    });
    // 23:30 UTC on the 25th is already 06:30 on the 26th in Bangkok (+07).
    check(
      "aggregation: a late-UTC record lands on the viewer's local day",
      aggregator.add(record({ timestampMs: Date.parse("2026-07-25T23:30:00Z") })),
    );
    const { buckets } = aggregator.finish();
    eq("aggregation: one cell", buckets.length, 1);
    eq("aggregation: bucketed by the zone's calendar day", buckets[0].day, "2026-07-26");
    eq("aggregation: the session is counted once", buckets[0].sessions, 1);
    eq("aggregation: the record is counted", buckets[0].recordCount, 1);
  }
  {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-07-20",
      untilDay: "2026-07-25",
      lookup: lookupUsagePrice,
    });
    check("aggregation: an in-window record contributes", aggregator.add(record()));
    check(
      "aggregation: a record before the window is dropped",
      aggregator.add(record({ timestampMs: Date.parse("2026-07-19T23:59:59Z") })) === false,
    );
    check(
      "aggregation: a record after the window is dropped",
      aggregator.add(record({ timestampMs: Date.parse("2026-07-26T00:00:00Z") })) === false,
    );
    const result = aggregator.finish();
    eq("aggregation: both out-of-window records are reported", result.outOfWindow, 2);
    eq("aggregation: only the in-window record survives", result.buckets.length, 1);
  }
  {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-07-20",
      untilDay: "2026-07-31",
      lookup: lookupUsagePrice,
    });
    aggregator.add(record({ project: "/p/one", sessionId: "s-1", timestampMs: Date.parse("2026-07-21T10:00:00Z") }));
    aggregator.add(record({ project: "/p/one", sessionId: "s-1", timestampMs: Date.parse("2026-07-21T11:00:00Z"), model: "claude-sonnet-5" }));
    aggregator.add(record({ project: "/p/one", sessionId: "s-1", timestampMs: Date.parse("2026-07-21T12:00:00Z") }));
    aggregator.add(record({ project: "/p/two", sessionId: "s-2", timestampMs: Date.parse("2026-07-22T10:00:00Z") }));
    aggregator.add(record({ project: null, sessionId: "s-3", timestampMs: Date.parse("2026-07-23T10:00:00Z"), provider: "codex", model: "gpt-5.5" }));
    const result = aggregator.finish();
    eq("projects: one row per provider and directory", result.projects.length, 3);
    eq("projects: the costliest project leads", result.projects[0].project, "/p/one");
    eq("projects: records are counted", result.projects[0].records, 3);
    eq("projects: sessions are distinct", result.projects[0].sessions, 1);
    eq("projects: a record without cwd lands on the empty project", result.projects.find((row) => row.provider === "codex").project, "");
    eq("sessions: newest first", result.recentSessions[0].sessionId, "s-3");
    const first = result.recentSessions.find((row) => row.sessionId === "s-1");
    eq("sessions: the majority model names the session", first.model, "claude-opus-5");
    eq("sessions: first and last stamps span the session", first.lastMs - first.firstMs, 2 * 60 * 60 * 1000);
    eq("sessions: records are turns", first.records, 3);
    eq("sessions: the project is carried", first.project, "/p/one");
  }
  {
    // The Claude content-block repeat: the same message written once per block,
    // each copy repeating the parent's full usage.
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-07-01",
      untilDay: "2026-07-31",
      lookup: lookupUsagePrice,
    });
    check("aggregation: the first copy of a message counts", aggregator.add(record({ dedupeKey: "msg_1:req_1" })));
    check(
      "aggregation: a repeated content block does not count again",
      aggregator.add(record({ dedupeKey: "msg_1:req_1" })) === false,
    );
    check(
      "aggregation: the same key in another file is still a duplicate (resumed session)",
      aggregator.add(record({ dedupeKey: "msg_1:req_1", sessionId: "session-b" })) === false,
    );
    check(
      "aggregation: a different message counts",
      aggregator.add(record({ dedupeKey: "msg_2:req_2" })),
    );
    const result = aggregator.finish();
    eq("aggregation: two duplicates were dropped", result.duplicatesDropped, 2);
    eq("aggregation: the cell holds two records, not four", result.buckets[0].recordCount, 2);
    eq(
      "aggregation: tokens were not double counted",
      result.buckets[0].totals.outputTokens,
      2_000_000,
    );
  }
  {
    // Provenance: a cell mixing reported and priced records reports the weaker.
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-07-01",
      untilDay: "2026-07-31",
      lookup: lookupUsagePrice,
    });
    aggregator.add(record({ provider: "cora", reportedCostUsd: 0.5 }));
    const reportedOnly = aggregator.finish().buckets[0];
    eq("aggregation: an all-reported cell says reported", reportedOnly.costSource, "reported");
    near("aggregation: cache savings use the input/cacheRead spread", reportedOnly.cacheSavingsUsd, 4.5);
  }
  {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-07-01",
      untilDay: "2026-07-31",
      lookup: lookupUsagePrice,
    });
    aggregator.add(record({ dedupeKey: "a", reportedCostUsd: 0.5 }));
    aggregator.add(record({ dedupeKey: "b" }));
    eq(
      "aggregation: a mixed-provenance cell reports the weaker source",
      aggregator.finish().buckets[0].costSource,
      "priced",
    );
  }
  {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-07-01",
      untilDay: "2026-07-31",
      lookup: lookupUsagePrice,
    });
    aggregator.add(record({ provider: "cora", model: "gpt-5.6-sol", timestampMs: Date.parse("2026-07-02T00:00:00Z") }));
    aggregator.add(record({ timestampMs: Date.parse("2026-07-01T00:00:00Z") }));
    const buckets = aggregator.finish().buckets;
    eq("aggregation: cells sort by day first", buckets[0].day, "2026-07-01");
    eq("aggregation: providers are kept apart", buckets[1].provider, "cora");
  }

  /* ── Window helpers ────────────────────────────────────────────────────── */

  const window = makeUsageWindow(7, new Date("2026-08-10T04:00:00Z"), "UTC");
  eq("window: the last day is today", window.untilDay, "2026-08-10");
  eq("window: a 7-day window spans 7 calendar days inclusive", window.sinceDay, "2026-08-04");
  eq("window: the days enumerate inclusively", enumerateDays(window.sinceDay, window.untilDay).length, 7);
  eq("window: an inverted range enumerates to nothing", enumerateDays("2026-08-10", "2026-08-01").length, 0);
  eq(
    "window: a zone west of UTC can still be on the previous day",
    makeUsageWindow(1, new Date("2026-08-10T04:00:00Z"), "America/Los_Angeles").untilDay,
    "2026-08-09",
  );

  /* ── Model names with spaces (the cell key must not be split apart) ────── */

  {
    // A Codex turn_context names whatever model the user configured, so a model
    // containing a space is reachable. A cell key that has to be parsed back
    // apart would truncate this label and merge it with a different model.
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-07-01",
      untilDay: "2026-07-31",
      lookup: lookupUsagePrice,
    });
    aggregator.add(record({ provider: "codex", model: "my custom gpt" }));
    aggregator.add(record({ provider: "codex", model: "my other gpt" }));
    const buckets = aggregator.finish().buckets;
    eq("keys: a model name containing spaces survives intact", buckets[0].model, "my custom gpt");
    eq("keys: two space-containing models stay distinct cells", buckets.length, 2);
  }

  /* ── Scanner: cache codec, pruning, and the filesystem walk ────────────── */

  // The scanner resolves its cache path through codaraHome(); point that at a
  // throwaway directory so a test run can never touch the real ~/.codarastudio.
  const scannerHome = path.join(tmp, "home");
  fs.mkdirSync(scannerHome, { recursive: true });
  process.env.CODARA_HOME_DIR = scannerHome;
  const scanner = await bundle(SCANNER_TS, path.join(tmp, "scanner.bundle.cjs"));
  const {
    decodeScanCache,
    encodeScanCache,
    listTranscriptFiles,
    pruneScanCache,
    readFileRecords,
    readTranscriptRecords,
    retentionCutoffMs,
  } = scanner;

  {
    const now = 1_800_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const slack = 36 * 60 * 60 * 1000;
    // On a short window the plain 90-day retention governs.
    eq(
      "retention: a short window leaves the 90-day cutoff alone",
      retentionCutoffMs(now, now - 7 * day - slack),
      now - 90 * day,
    );
    // On the longest window the 90-day cutoff would land inside the walked
    // range, so the boundary files would be cached and pruned on the same pass
    // and re-parsed on every scan. The clamp is what stops that.
    const longWindowStart = now - 90 * day - slack;
    eq(
      "retention: the 90-day window clamps the cutoff back to its own start",
      retentionCutoffMs(now, longWindowStart),
      longWindowStart,
    );
    check(
      "retention: nothing the longest scan just walked is ever evicted",
      retentionCutoffMs(now, longWindowStart) <= longWindowStart,
    );
  }

  const cachedRecord = (over = {}) => ({
    provider: "claude",
    timestampMs: 1_784_928_449_507,
    model: "claude-opus-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 2,
      cacheCreationTokens: 3,
      outputTokens: 4,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: null,
    project: null,
    ...over,
  });

  {
    const cache = new Map([
      [
        "/tmp/a.jsonl",
        {
          size: 10,
          mtimeMs: 1000,
          provider: "claude",
          // One row with both optional fields null, one with both populated:
          // the interned encoding must round-trip either.
          records: [cachedRecord(), cachedRecord({ dedupeKey: "m:r", reportedCostUsd: 0.25, project: "/Users/x/app" })],
        },
      ],
      ["/tmp/b.jsonl", { size: 20, mtimeMs: 2000, provider: "cora", records: [cachedRecord({ provider: "cora", model: "gpt-5.6-sol", sessionId: "session-b" })] }],
    ]);
    const restored = new Map();
    decodeScanCache(encodeScanCache(cache), restored);
    eq("cache codec: both file entries round-trip", restored.size, 2);
    eq("cache codec: size survives", restored.get("/tmp/a.jsonl").size, 10);
    eq("cache codec: mtime survives", restored.get("/tmp/a.jsonl").mtimeMs, 1000);
    eq("cache codec: provider survives", restored.get("/tmp/b.jsonl").provider, "cora");
    eq("cache codec: the interned model survives", restored.get("/tmp/b.jsonl").records[0].model, "gpt-5.6-sol");
    eq("cache codec: the interned session survives", restored.get("/tmp/b.jsonl").records[0].sessionId, "session-b");
    eq("cache codec: a null dedupe key stays null", restored.get("/tmp/a.jsonl").records[0].dedupeKey, null);
    eq("cache codec: a null cost stays null", restored.get("/tmp/a.jsonl").records[0].reportedCostUsd, null);
    eq("cache codec: a populated dedupe key survives", restored.get("/tmp/a.jsonl").records[1].dedupeKey, "m:r");
    eq("cache codec: a populated cost survives", restored.get("/tmp/a.jsonl").records[1].reportedCostUsd, 0.25);
    eq("cache codec: token totals survive", restored.get("/tmp/a.jsonl").records[0].totals.cacheCreationTokens, 3);
    eq("cache codec: a null project stays null", restored.get("/tmp/a.jsonl").records[0].project, null);
    eq("cache codec: the interned project survives", restored.get("/tmp/a.jsonl").records[1].project, "/Users/x/app");
    // A record cached by the version-1 writer never had the field at all.
    const legacy = new Map([["/tmp/c.jsonl", { size: 1, mtimeMs: 1, provider: "claude", records: [(() => { const r = cachedRecord(); delete r.project; return r; })()] }]]);
    const legacyRestored = new Map();
    decodeScanCache(encodeScanCache(legacy), legacyRestored);
    eq("cache codec: a record without the project field encodes as null", legacyRestored.get("/tmp/c.jsonl").records[0].project, null);
  }
  {
    // A corrupt row must disqualify its WHOLE file entry. Keeping the surviving
    // rows under the original (size, mtime) would read as a valid warm hit, and
    // the file would never be re-parsed — silently losing the dropped rows.
    const document = JSON.parse(
      encodeScanCache(
        new Map([
          ["/tmp/a.jsonl", { size: 10, mtimeMs: 1000, provider: "claude", records: [cachedRecord(), cachedRecord()] }],
          ["/tmp/b.jsonl", { size: 20, mtimeMs: 2000, provider: "claude", records: [cachedRecord()] }],
        ]),
      ),
    );
    document.files["/tmp/a.jsonl"].r[1] = [1, 0, 0, 1];
    const restored = new Map();
    decodeScanCache(JSON.stringify(document), restored);
    eq("cache codec: a corrupt row drops its whole file entry", restored.has("/tmp/a.jsonl"), false);
    eq("cache codec: an intact entry beside it is kept", restored.has("/tmp/b.jsonl"), true);
  }
  {
    const restored = new Map();
    decodeScanCache("{not json", restored);
    eq("cache codec: unparseable JSON yields an empty cache", restored.size, 0);
    decodeScanCache(JSON.stringify({ version: 999, models: [], sessions: [], files: {} }), restored);
    eq("cache codec: a future version is rejected wholesale", restored.size, 0);
    const document = JSON.parse(
      encodeScanCache(new Map([["/tmp/a.jsonl", { size: 1, mtimeMs: 1, provider: "claude", records: [cachedRecord()] }]])),
    );
    // A numeric intern entry would pass the per-row guards and land in a
    // record's model, so a corrupt table must reject the whole cache.
    document.models[0] = 7;
    decodeScanCache(JSON.stringify(document), restored);
    eq("cache codec: a corrupt intern table rejects the whole cache", restored.size, 0);
  }

  {
    const now = 1_800_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const cache = new Map([
      ["/root/live.jsonl", { size: 1, mtimeMs: now - day, provider: "claude", records: [] }],
      ["/root/gone.jsonl", { size: 1, mtimeMs: now - day, provider: "claude", records: [] }],
      ["/root/ancient.jsonl", { size: 1, mtimeMs: now - 200 * day, provider: "claude", records: [] }],
      ["/other/untouched.jsonl", { size: 1, mtimeMs: now - day, provider: "claude", records: [] }],
      ["/root/older-than-window.jsonl", { size: 1, mtimeMs: now - 40 * day, provider: "claude", records: [] }],
    ]);
    const removed = pruneScanCache(cache, {
      livePaths: new Set(["/root/live.jsonl"]),
      walkedRoots: ["/root"],
      windowStartMs: now - 30 * day,
      retentionCutoffMs: now - 90 * day,
    });
    eq("prune: a file the walk just saw is kept", cache.has("/root/live.jsonl"), true);
    eq("prune: a vanished in-window file is dropped", cache.has("/root/gone.jsonl"), false);
    eq("prune: an aged-out entry is dropped", cache.has("/root/ancient.jsonl"), false);
    // The walk only covers the requested window, so absence proves deletion
    // only inside it — otherwise a 7-day look would evict the 90-day entries.
    eq("prune: an entry under a root that was NOT walked is kept", cache.has("/other/untouched.jsonl"), true);
    eq("prune: an entry older than the walked window is kept", cache.has("/root/older-than-window.jsonl"), true);
    eq("prune: the removal count is reported", removed, 2);
  }

  /* ── Scanner: real filesystem behaviour in a temp tree ─────────────────── */

  const walkRoot = path.join(tmp, "walk");
  const realDir = path.join(walkRoot, "real");
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, "session.jsonl"), `${claudeLine()}\n`);
  fs.writeFileSync(path.join(realDir, "notes.txt"), "not a transcript\n");
  const staleFile = path.join(realDir, "stale.jsonl");
  fs.writeFileSync(staleFile, `${claudeLine()}\n`);
  const staleSeconds = Date.now() / 1000 - 400 * 24 * 60 * 60;
  fs.utimesSync(staleFile, staleSeconds, staleSeconds);
  // A managed CLI home links its transcripts back into the personal home, so a
  // walk that descends through a link counts the same sessions twice.
  fs.symlinkSync(realDir, path.join(walkRoot, "linked"), "dir");

  {
    const found = await listTranscriptFiles(walkRoot, Date.now() - 30 * 24 * 60 * 60 * 1000);
    const names = found.map((file) => path.relative(walkRoot, file.path)).sort();
    eq("walk: only the fresh .jsonl under the real directory is listed", JSON.stringify(names), JSON.stringify([path.join("real", "session.jsonl")]));
    eq("walk: a symlinked subdirectory is never descended", found.some((file) => file.path.includes("linked")), false);
    eq("walk: a non-.jsonl file is ignored", found.some((file) => file.path.endsWith(".txt")), false);
    eq("walk: a file older than the window is filtered by mtime", found.some((file) => file.path === staleFile), false);
    check("walk: the listing carries size and mtime", found[0].size > 0 && found[0].mtimeMs > 0);
    eq("walk: a missing root lists nothing rather than throwing", (await listTranscriptFiles(path.join(tmp, "nope"), 0)).length, 0);
  }

  {
    const transcript = path.join(realDir, "session.jsonl");
    const stats = fs.statSync(transcript);
    const file = { path: transcript, size: stats.size, mtimeMs: stats.mtimeMs };
    const cache = new Map();
    const records = await readFileRecords(cache, file, "claude");
    eq("scan: a real transcript parses to one record", records.length, 1);
    eq("scan: the parsed record is memoised", cache.size, 1);
    eq("scan: the memo is keyed by the file path", cache.get(transcript).provider, "claude");

    // Warm hit: the file is gone from disk, so anything returned now can only
    // have come from the memo.
    fs.renameSync(transcript, `${transcript}.moved`);
    const warm = await readFileRecords(cache, file, "claude");
    eq("scan: an unchanged file is served from the memo", warm.length, 1);
    fs.renameSync(`${transcript}.moved`, transcript);

    // Provider is part of the memo identity: a hit parsed by another provider's
    // parser must not be reused.
    const crossed = await readFileRecords(cache, file, "cora");
    eq("scan: a memo entry is not reused across providers", crossed.length, 0);
  }
  {
    // A read failure is not an empty transcript. Memoising it under this
    // (size, mtime) would silently drop the file's usage until it changed.
    const cache = new Map();
    const missing = path.join(realDir, "vanished.jsonl");
    eq("scan: an unreadable file reads as null, not empty", await readTranscriptRecords(missing, "claude"), null);
    const records = await readFileRecords(cache, { path: missing, size: 10, mtimeMs: 10 }, "claude");
    eq("scan: a read failure yields no records", records.length, 0);
    eq("scan: a read failure is NOT memoised", cache.size, 0);
  }
  {
    // A genuinely empty transcript IS a stable fact worth memoising.
    const empty = path.join(realDir, "empty.jsonl");
    fs.writeFileSync(empty, "");
    const stats = fs.statSync(empty);
    const cache = new Map();
    await readFileRecords(cache, { path: empty, size: stats.size, mtimeMs: stats.mtimeMs }, "claude");
    eq("scan: an empty transcript is memoised", cache.size, 1);
  }
  {
    // Within-file dedup happens before the entry is cached, so the repeated
    // content blocks never reach the aggregator at all.
    const repeated = path.join(realDir, "repeats.jsonl");
    fs.writeFileSync(repeated, `${claudeLine()}\n${claudeLine()}\n${claudeLine()}\n`);
    const stats = fs.statSync(repeated);
    const cache = new Map();
    const records = await readFileRecords(cache, { path: repeated, size: stats.size, mtimeMs: stats.mtimeMs }, "claude");
    eq("scan: repeated content blocks are deduped before caching", records.length, 1);
  }
  {
    // Codex needs its turn_context/session_meta lines to reach the reducer even
    // though they carry no usage of their own.
    const rollout = path.join(realDir, "rollout-x.jsonl");
    fs.writeFileSync(rollout, `${sessionMeta}\n${turnContext("gpt-5.5")}\n${tokenCount()}\n`);
    const records = await readTranscriptRecords(rollout, "codex");
    eq("scan: a codex rollout attributes its model", records.length === 1 && records[0].model, "gpt-5.5");
    eq("scan: a codex rollout attributes its session", records[0].sessionId, "019efba8-6f47-7fa2-b182-66ae4ed19230");
  }
  {
    const session = path.join(realDir, "2026-08-06T13-44-00-040Z_run-abc.jsonl");
    fs.writeFileSync(session, `${piHeader}\n${piMessage()}\n`);
    const records = await readTranscriptRecords(session, "cora");
    eq("scan: a pi session parses its assistant turn", records.length, 1);
    eq("scan: a pi session takes its id from the header line", records[0].sessionId, "run-mshkh9ky-1ffh0j-auto-fast-0-1");

    // A file whose header line was lost to truncation still attributes.
    const headless = path.join(realDir, "2026-08-06T13-44-00-040Z_run-fallback.jsonl");
    fs.writeFileSync(headless, `${piMessage()}\n`);
    const fallback = await readTranscriptRecords(headless, "cora");
    eq("scan: a pi session without a header falls back to the file name", fallback[0].sessionId, "run-fallback");
  }

  console.log(`\nAll ${pass} usage-analytics checks passed.`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
