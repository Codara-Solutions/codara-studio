#!/usr/bin/env node
"use strict";

// The Usage page's figures and labels: src/renderer/src/components/usage/
// usage-format.ts and usage-derive.ts, bundled as the renderer sees them.

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const USAGE_DIR = path.join(ROOT, "src/renderer/src/components/usage");

const result = esbuild.buildSync({
  stdin: {
    contents: 'export * from "./usage-format"; export * from "./usage-derive";',
    resolveDir: USAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
  alias: { "@shared": path.join(ROOT, "src/shared") },
});
const shim = { exports: {} };
new Function("module", "exports", result.outputFiles[0].text)(shim, shim.exports);
const {
  formatTokens,
  formatShare,
  formatDayShort,
  formatDayRange,
  spansYears,
  intensityColumns,
  buildDailyTotals,
  busiestDay,
  summarizeBuckets,
  buildModelRows,
  buildProjectRows,
  buildProviderCards,
  PROVIDER_ORDER,
  PROVIDER_READING_ORDER,
} = shim.exports;

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

function totals(overrides = {}) {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  };
}

function bucket(overrides) {
  return {
    day: "2026-10-01",
    provider: "claude",
    model: "claude-opus-5",
    totals: totals(),
    costUsd: 0,
    cacheSavingsUsd: 0,
    costSource: "priced",
    recordCount: 1,
    sessions: 1,
    ...overrides,
  };
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

check("formatTokens keeps three significant figures with a unit", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(1234), "1.23K");
  assert.equal(formatTokens(804_000), "804K");
  assert.equal(formatTokens(76_700_000), "76.7M");
  assert.equal(formatTokens(19_900_000_000), "19.9B");
  assert.equal(formatTokens(-1500), "-1.50K");
  assert.equal(formatTokens(Number.NaN), "0");
});

check("formatTokens carries a rounded value into the next unit", () => {
  assert.equal(formatTokens(999.6), "1K");
  assert.equal(formatTokens(999_499), "999K");
  assert.equal(formatTokens(999_999), "1M");
  assert.equal(formatTokens(999_999_999), "1B");
  assert.equal(formatTokens(-999_999), "-1M");
});

check("formatShare never rounds a visible part to 0% or 100%", () => {
  assert.equal(formatShare(0), "0%");
  assert.equal(formatShare(0.004), "<1%");
  assert.equal(formatShare(0.5), "50%");
  assert.equal(formatShare(0.996), ">99%");
  assert.equal(formatShare(1), "100%");
  assert.equal(formatShare(Number.NaN), "0%");
});

check("day labels carry the year only when asked", () => {
  assert.equal(formatDayShort("2026-08-07"), "Aug 7");
  assert.equal(formatDayShort("2026-08-07", true), "Aug 7, 2026");
  assert.equal(formatDayShort("not-a-day"), "not-a-day");
});

check("a range crossing a year names both years", () => {
  assert.equal(spansYears("2026-09-15", "2026-10-14"), false);
  assert.equal(spansYears("2025-10-15", "2026-10-14"), true);
  assert.equal(formatDayRange("2026-09-15", "2026-10-14"), "Sep 15 to Oct 14");
  // The one-year window used to read "Oct 15 – Oct 14".
  assert.equal(formatDayRange("2025-10-15", "2026-10-14"), "Oct 15, 2025 to Oct 14, 2026");
});

check("the intensity grid fills its rows evenly", () => {
  assert.equal(intensityColumns(3), 7);
  assert.equal(intensityColumns(7), 7);
  assert.equal(intensityColumns(21), 21);
  assert.equal(intensityColumns(22), 11);
  assert.equal(intensityColumns(30), 15);
  assert.equal(intensityColumns(42), 21);
});

/* ── Derivations ────────────────────────────────────────────────────────── */

check("cache hits count cache writes as prompt tokens", () => {
  const summary = summarizeBuckets([
    bucket({
      totals: totals({
        uncachedInputTokens: 100,
        cachedInputTokens: 800,
        cacheCreationTokens: 100,
        outputTokens: 50,
        reasoningTokens: 20,
      }),
      costUsd: 2,
      cacheSavingsUsd: 1.5,
      recordCount: 3,
    }),
    bucket({
      provider: "cora",
      totals: totals({ outputTokens: 10 }),
      costUsd: 0.5,
      costSource: "reported",
      recordCount: 2,
    }),
    bucket({
      provider: "codex",
      model: "mystery",
      totals: totals({ uncachedInputTokens: 0, outputTokens: 5 }),
      costSource: "unpriced",
      recordCount: 4,
    }),
  ]);
  // 800 read of 1,000 prompt tokens, not 800 of the 900 that were not writes.
  assert.equal(summary.cacheHitShare, 0.8);
  assert.equal(summary.tokens, 1065);
  assert.equal(summary.outputTokens, 65);
  assert.equal(summary.reasoningTokens, 20);
  assert.equal(summary.costUsd, 2.5);
  assert.equal(summary.cacheSavingsUsd, 1.5);
  assert.equal(summary.records, 9);
  assert.equal(summary.pricedRecords, 3);
  assert.equal(summary.unpricedRecords, 4);
});

check("an empty window has no cache hit share and no records", () => {
  const summary = summarizeBuckets([]);
  assert.equal(summary.cacheHitShare, null);
  assert.equal(summary.records, 0);
  assert.equal(summary.tokens, 0);
  const outputOnly = summarizeBuckets([bucket({ totals: totals({ outputTokens: 9 }) })]);
  assert.equal(outputOnly.cacheHitShare, null);
});

check("daily totals cover every day and drop buckets outside the range", () => {
  const days = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const daily = buildDailyTotals(days, [
    bucket({ day: "2026-10-01", totals: totals({ outputTokens: 10 }), costUsd: 1 }),
    bucket({ day: "2026-10-01", provider: "codex", totals: totals({ outputTokens: 5 }), costUsd: 0.25 }),
    bucket({ day: "2026-10-03", provider: "cora", totals: totals({ outputTokens: 40 }), costUsd: 3 }),
    bucket({ day: "2026-09-30", totals: totals({ outputTokens: 999 }), costUsd: 99 }),
  ]);
  assert.deepEqual(
    daily.map((day) => [day.day, day.tokens, day.costUsd]),
    [
      ["2026-10-01", 15, 1.25],
      ["2026-10-02", 0, 0],
      ["2026-10-03", 40, 3],
    ],
  );
  assert.equal(daily[0].byProvider.get("codex").tokens, 5);
  assert.equal(busiestDay(daily).day, "2026-10-03");
  assert.equal(busiestDay(buildDailyTotals(days, [])), null);
});

check("the same model under two providers stays two rows, costliest first", () => {
  const rows = buildModelRows([
    bucket({ provider: "claude", model: "claude-opus-5", costUsd: 1, totals: totals({ outputTokens: 1 }) }),
    bucket({ provider: "cora", model: "claude-opus-5", costUsd: 4, totals: totals({ outputTokens: 1 }) }),
    bucket({ provider: "claude", model: "claude-opus-5", costUsd: 2, totals: totals({ outputTokens: 1 }) }),
    bucket({ provider: "codex", model: "mystery", costSource: "unpriced", totals: totals({ outputTokens: 7 }) }),
  ]);
  assert.deepEqual(
    rows.map((row) => [row.provider, row.model, row.costUsd, row.unpriced]),
    [
      ["cora", "claude-opus-5", 4, false],
      ["claude", "claude-opus-5", 3, false],
      ["codex", "mystery", 0, true],
    ],
  );
});

check("a project shared by agents lists them in reading order", () => {
  const rows = buildProjectRows([
    { provider: "cora", project: "/w/app", totals: totals({ outputTokens: 10 }), costUsd: 1, sessions: 1, records: 2 },
    { provider: "claude", project: "/w/app", totals: totals({ outputTokens: 20 }), costUsd: 2, sessions: 2, records: 3 },
    { provider: "codex", project: "/w/lib", totals: totals({ outputTokens: 5 }), costUsd: 0.5, sessions: 1, records: 1 },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.project, row.providers, row.tokens, row.costUsd, row.sessions, row.records]),
    [
      ["/w/app", ["claude", "cora"], 30, 3, 3, 5],
      ["/w/lib", ["codex"], 5, 0.5, 1, 1],
    ],
  );
});

check("provider cards follow the legend and carry their share", () => {
  assert.deepEqual([...PROVIDER_READING_ORDER], ["claude", "codex", "cora"]);
  assert.deepEqual([...PROVIDER_ORDER], ["cora", "codex", "claude"]);
  const cards = buildProviderCards(
    [
      bucket({ provider: "claude", model: "claude-opus-5", totals: totals({ outputTokens: 60 }), costUsd: 3, recordCount: 2 }),
      bucket({ provider: "claude", model: "claude-haiku-5", totals: totals({ outputTokens: 15 }), costUsd: 1 }),
      bucket({ provider: "cora", model: "gpt-6", totals: totals({ outputTokens: 25 }), costUsd: 2 }),
    ],
    [
      { provider: "claude", dir: "/c", status: "ok", scannedFiles: 4, skippedFiles: 0, distinctSessions: 3, message: null },
      { provider: "codex", dir: "/x", status: "missing", scannedFiles: 0, skippedFiles: 0, distinctSessions: 0, message: "not found" },
    ],
    100,
  );
  assert.deepEqual(
    cards.map((card) => [card.provider, card.tokens, card.costUsd, card.sessions, card.records, card.topModel, card.share]),
    [
      ["claude", 75, 4, 3, 3, "claude-opus-5", 0.75],
      ["codex", 0, 0, 0, 0, null, 0],
      ["cora", 25, 2, 0, 1, "gpt-6", 0.25],
    ],
  );
  assert.equal(cards[1].source.status, "missing");
  assert.equal(cards[2].source, null);
});

check("a provider read from two folders sums them on its card", () => {
  const cards = buildProviderCards(
    [],
    [
      { provider: "codex", dir: "/x/sessions", status: "ok", scannedFiles: 2, skippedFiles: 1, distinctSessions: 2, message: null },
      { provider: "codex", dir: "/x/archived_sessions", status: "ok", scannedFiles: 30, skippedFiles: 0, distinctSessions: 29, message: null },
    ],
    0,
  );
  const codex = cards.find((card) => card.provider === "codex");
  assert.equal(codex.sessions, 31);
  assert.equal(codex.source.scannedFiles, 32);
  assert.equal(codex.source.status, "ok");
});

console.log(`\n${checks} usage page checks passed`);
