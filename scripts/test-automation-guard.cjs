// Pure unit tests for an automation's spending limits: the month's spend, its
// tally, what a malformed limit reads as, and the worst case the editor shows.
//
//   node scripts/test-automation-guard.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const NOW = new Date(2026, 10, 18, 15, 40, 0).getTime();
const LAST_MONTH = new Date(2026, 9, 31, 23, 0, 0).toISOString();
const THIS_MONTH = new Date(2026, 10, 2, 9, 0, 0).toISOString();

function load() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-guard-"));
  const entry = path.join(dir, "entry.ts");
  fs.writeFileSync(
    entry,
    `export * from ${JSON.stringify(path.join(ROOT, "src/shared/automation-guard.ts"))};\n` +
      `export * from ${JSON.stringify(path.join(ROOT, "src/renderer/src/components/automations/cost-forecast.ts"))};\n`,
  );
  const out = path.join(ROOT, "node_modules", ".cache", `automation-guard-${process.pid}.cjs`);
  esbuild.buildSync({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    alias: { "@shared": path.join(ROOT, "src/shared") },
    logLevel: "silent",
  });
  const mod = require(out);
  fs.rmSync(out, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}

const g = load();
const rec = (startedAt, costUsd) => ({ iteration: 0, runId: `r-${startedAt}`, startedAt, status: "complete", costUsd });

// The month's spend: whichever source knows more, and only this month.
assert.equal(g.monthKey(NOW), "2026-11");
assert.equal(g.monthSpentUsd({ history: [rec(THIS_MONTH, 2), rec(LAST_MONTH, 50)] }, NOW), 2);
assert.equal(g.monthSpentUsd({ history: [rec(THIS_MONTH, 2)], monthSpend: { month: "2026-11", costUsd: 9, measuredCostUsd: 0 } }, NOW), 9, "the tally outlasts the capped history");
assert.equal(g.monthSpentUsd({ history: [rec(THIS_MONTH, 4)], monthSpend: { month: "2026-11", costUsd: 1, measuredCostUsd: 0 } }, NOW), 4, "runs from before the tally existed still count");
assert.equal(g.monthSpentUsd({ history: [], monthSpend: { month: "2026-10", costUsd: 99, measuredCostUsd: 0 } }, NOW), 0, "a new month starts at nothing");
assert.equal(g.monthSpentUsd({ history: [rec(THIS_MONTH, Number.NaN), rec("not a date", 5), rec(THIS_MONTH, -3)] }, NOW), 0, "junk never counts");

// The cap: reached at exactly the cap, and absent means never.
assert.equal(g.monthlyCapReached({ guard: { monthlyCapUsd: 2 }, history: [rec(THIS_MONTH, 2)] }, NOW), true);
assert.equal(g.monthlyCapReached({ guard: { monthlyCapUsd: 2.01 }, history: [rec(THIS_MONTH, 2)] }, NOW), false);
assert.equal(g.monthlyCapReached({ history: [rec(THIS_MONTH, 2000)] }, NOW), false, "no cap, no limit");
assert.equal(g.monthlyCapReached({ guard: { pauseAfterFailures: 2 }, history: [rec(THIS_MONTH, 2000)] }, NOW), false);

// The tally: starts over in a new month, and a free run adds no field.
const run = (startedAt, costUsd, measuredCostUsd) => ({ runId: `n-${startedAt}`, iteration: 0, startedAt, costUsd, measuredCostUsd });
assert.deepEqual(g.addToMonthSpend(undefined, run(THIS_MONTH, 2, 1), []), { month: "2026-11", costUsd: 2, measuredCostUsd: 1 });
assert.deepEqual(
  g.addToMonthSpend({ month: "2026-11", costUsd: 2, measuredCostUsd: 1 }, run(THIS_MONTH, 3), [rec(THIS_MONTH, 2)]),
  { month: "2026-11", costUsd: 5, measuredCostUsd: 1 },
  "an existing tally already holds the history",
);
assert.deepEqual(
  g.addToMonthSpend({ month: "2026-10", costUsd: 40, measuredCostUsd: 40 }, run(THIS_MONTH, 3), []),
  { month: "2026-11", costUsd: 3, measuredCostUsd: 0 },
);
assert.equal(g.addToMonthSpend(undefined, run(THIS_MONTH, 0), []), undefined);

// A tally's first run takes in the month's history, or those runs would be lost
// as they rotate out: $50 kept, then twenty $1 runs, is $70.
{
  const kept = Array.from({ length: 50 }, (_, i) => ({ ...rec(THIS_MONTH, 1), runId: `old-${i}` }));
  let tally;
  let history = kept;
  for (let i = 0; i < 20; i += 1) {
    const next = { ...run(THIS_MONTH, 1), runId: `new-${i}` };
    tally = g.addToMonthSpend(tally, next, history);
    history = [...history, next].slice(-50);
  }
  assert.equal(tally.costUsd, 70);
  assert.equal(g.monthSpentUsd({ history, monthSpend: tally }, NOW), 70);
  const lastMonthRuns = [rec(LAST_MONTH, 30), rec(THIS_MONTH, 4)];
  assert.equal(g.addToMonthSpend(undefined, run(THIS_MONTH, 1), lastMonthRuns).costUsd, 5, "only that month's runs");
  const self = { ...run(THIS_MONTH, 9), runId: "same" };
  assert.equal(g.addToMonthSpend(undefined, self, [self]).costUsd, 9, "the run itself is not counted twice");
}

// Seeded before a new row can push older runs out, even when the new run is free.
{
  const kept = Array.from({ length: 50 }, (_, i) => ({ ...rec(THIS_MONTH, 1), runId: `old-${i}` }));
  assert.deepEqual(g.seedMonthSpend({ history: kept }, NOW), { month: "2026-11", costUsd: 50, measuredCostUsd: 0 });
  assert.equal(g.seedMonthSpend({ history: [] }, NOW), undefined, "a free month adds no field");
  const had = { month: "2026-11", costUsd: 70, measuredCostUsd: 0 };
  assert.equal(g.seedMonthSpend({ history: kept, monthSpend: had }, NOW), had, "only ever once");
  assert.deepEqual(g.seedMonthSpend({ history: [rec(THIS_MONTH, 3)], monthSpend: { month: "2026-10", costUsd: 9, measuredCostUsd: 0 } }, NOW).costUsd, 3);
}

// A run belongs to the month it started in, even if recovered after a restart.
assert.equal(g.addToMonthSpend(undefined, run(LAST_MONTH, 5), []).month, "2026-10");
assert.equal(g.monthSpentUsd({ history: [], monthSpend: g.addToMonthSpend(undefined, run(LAST_MONTH, 5), []) }, NOW), 0, "and does not eat this month's cap");
assert.deepEqual(
  g.addToMonthSpend({ month: "2026-11", costUsd: 8, measuredCostUsd: 0 }, run(LAST_MONTH, 5), []),
  { month: "2026-11", costUsd: 8, measuredCostUsd: 0 },
  "a late run from an older month does not wipe this month's tally",
);

// A limit that does not parse is dropped: a cap of zero would stop every run.
assert.equal(g.normalizeAutomationGuard(undefined), undefined);
assert.equal(g.normalizeAutomationGuard({}), undefined);
assert.equal(g.normalizeAutomationGuard({ monthlyCapUsd: 0 }), undefined);
assert.equal(g.normalizeAutomationGuard({ monthlyCapUsd: -1 }), undefined);
assert.equal(g.normalizeAutomationGuard({ monthlyCapUsd: "20" }), undefined);
assert.equal(g.normalizeAutomationGuard({ monthlyCapUsd: Number.POSITIVE_INFINITY }), undefined);
assert.equal(g.normalizeAutomationGuard({ pauseAfterFailures: 0 }), undefined);
assert.equal(g.normalizeAutomationGuard({ pauseAfterFailures: 1.5 }), undefined);
assert.equal(g.normalizeAutomationGuard({ pauseAfterFailures: 51 }), undefined);
assert.deepEqual(g.normalizeAutomationGuard({ monthlyCapUsd: 20, pauseAfterFailures: 3, other: 1 }), { monthlyCapUsd: 20, pauseAfterFailures: 3 });
assert.equal(g.normalizeMonthSpend({ month: "soon", costUsd: 1 }), undefined);
assert.deepEqual(g.normalizeMonthSpend({ month: "2026-11", costUsd: "x", measuredCostUsd: -1 }), { month: "2026-11", costUsd: 0, measuredCostUsd: 0 });

// Only a blank field removes a limit: a typo must not quietly drop one.
assert.equal(g.guardDraftProblem("", ""), null);
assert.equal(g.guardDraftProblem("  ", " "), null);
assert.equal(g.guardDraftProblem("20", "3"), null);
assert.match(g.guardDraftProblem("-1", ""), /monthly cap must be/);
assert.match(g.guardDraftProblem("0", ""), /monthly cap must be/);
assert.match(g.guardDraftProblem("abc", "3"), /monthly cap must be/);
assert.match(g.guardDraftProblem("", "51"), /Pause after must be/);
assert.match(g.guardDraftProblem("", "1.5"), /Pause after must be/);
assert.match(g.guardDraftProblem("20", "0"), /Pause after must be/);

// How often a schedule starts, from the real cron engine.
const daily = { kind: "cron", expr: "0 2 * * *" };
const hourly = { kind: "interval", everyMs: 3_600_000 };
assert.equal(g.startsPerMonth(daily, NOW).runs, 31, "the busiest month, not 30 days");
assert.equal(g.startsPerMonth(hourly, NOW).runs, 744);
assert.equal(g.startsPerMonth({ kind: "cron", expr: "0 * * * *" }, NOW).runs, 744, "a whole month is seen, however many starts");
assert.equal(g.startsPerMonth({ kind: "cron", expr: "0 9 1 1 *" }, NOW).runs, 1, "a yearly schedule still counts in the month it fires");
assert.equal(g.startsPerMonth({ kind: "cron", expr: "0 0 30 2 *" }, NOW), null, "a date that never comes");
assert.equal(g.startsPerMonth({ kind: "cron", expr: "not cron" }, NOW), null);
assert.equal(g.startsPerMonth({ kind: "manual" }, NOW), null);
assert.equal(g.startsPerMonth({ kind: "github", events: ["prOpened"] }, NOW), null);
assert.deepEqual(g.startsPerMonth({ kind: "cron", expr: "* * * * *" }, NOW), { runs: 1000, floor: true });

// The worst case, in words.
const says = (input) => g.costForecast({ stepsOnly: false, trigger: daily, ...input }, NOW);
assert.equal(says({ stepsOnly: true, budgetUsd: 5 }).headline, "Free: it has no AI steps.");
assert.equal(says({ budgetUsd: 5 }).headline, "On its schedule, worst case about $155.00 a month: $5.00 a run, up to 31 runs.");
assert.match(says({ budgetUsd: 5 }).detail, /Running it by hand adds to that\./, "a schedule is no ceiling on Run now");
assert.equal(says({ budgetUsd: 5 }).open, false);
assert.equal(says({ budgetUsd: 5, monthlyCapUsd: 20 }).headline, "Worst case about $20.00 a month: its monthly cap.");
assert.equal(says({ budgetUsd: 5, monthlyCapUsd: 500 }).headline, "On its schedule, worst case about $155.00 a month: $5.00 a run, up to 31 runs.");
assert.match(says({ budgetUsd: 5, monthlyCapUsd: 500 }).detail, /up to its \$500\.00 cap/);
assert.match(says({ trigger: { kind: "cron", expr: "0 9 1 1 *" }, budgetUsd: 5 }).headline, /\$5\.00 a month.*up to 1 run\./, "never $0 for a schedule that does fire");
assert.equal(says({ monthlyCapUsd: 20 }).headline, "Worst case about $20.00 a month: its monthly cap.");
assert.match(says({ monthlyCapUsd: 20 }).detail, /between runs/, "never firmer than the engine enforces");
assert.equal(says({}).open, true);
assert.match(says({}).headline, /^No ceiling/);
assert.match(says({ trigger: { kind: "manual" }, budgetUsd: 5 }).headline, /each time you run it/);
assert.equal(says({ trigger: { kind: "manual" }, budgetUsd: 5 }).open, false);
assert.match(says({ trigger: { kind: "github", events: ["ciFailed"] }, budgetUsd: 5 }).headline, /nothing limits how often/);
assert.equal(says({ trigger: { kind: "github", events: ["ciFailed"] }, budgetUsd: 5 }).open, true);
assert.equal(says({ trigger: { kind: "github", events: ["ciFailed"] }, budgetUsd: 5, monthlyCapUsd: 9 }).open, false);
assert.match(says({ trigger: { kind: "cron", expr: "* * * * *" }, budgetUsd: 1 }).headline, /\$1000\.00 or more a month.*1000\+ runs/);

console.log("automation guard: ok");
