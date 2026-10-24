// Unit tests for the usage forecast (Labs, behind the usageForecast
// preference): the model in src/shared/usage-forecast.ts and the transcript
// readers in src/main/usage-forecast-signals.ts.
//
// The forecast has two ways to be wrong without anyone noticing: a cone that
// does not contain its own median, and words that promise a time the numbers
// do not support. Both are pinned here on small synthetic histories whose
// answer is known.
//
//   node scripts/test-usage-forecast.cjs

// Time of day matters to the model (it replays past days at the same hour),
// so the suite runs in one fixed zone whatever the machine's.
process.env.TZ = "Europe/Madrid";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const FORECAST_TS = path.join(SHARED_DIR, "usage-forecast.ts");
const SIGNALS_TS = path.join(ROOT, "src", "main", "usage-forecast-signals.ts");

const harnessPlugin = {
  name: "usage-forecast-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BUCKET = 15 * MINUTE;

/** A history of `days` days in which the user burns `perHour` units each hour
 * from `fromHour` to `toHour` local time, every day. */
function workdayHistory(nowMs, days, perHour, fromHour, toHour) {
  const start = new Date(nowMs - days * DAY);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const values = [];
  for (let t = startMs; t <= nowMs; t += BUCKET) {
    const hour = new Date(t).getHours();
    values.push(t < nowMs && hour >= fromHour && hour < toHour ? perHour / 4 : 0);
  }
  return { startMs, bucketMs: BUCKET, values };
}

function at(day, hour, minute = 0) {
  const date = new Date(2026, 9, day, hour, minute, 0, 0);
  return date.getTime();
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-usage-forecast-"));
  const forecast = await bundle(FORECAST_TS, path.join(tmp, "forecast.bundle.cjs"));
  const signals = await bundle(SIGNALS_TS, path.join(tmp, "signals.bundle.cjs"));
  const {
    backtestForecast,
    burnNudge,
    calibrationFactors,
    describeForecast,
    forecastWindow,
    formatClock,
    goAheadNote,
    groupReadingsByWindow,
    normalizeForecastIdeas,
    pastWindowsFromReadings,
    percentSeriesFromReadings,
    suggestNextAccount,
    sumBetween,
    trimLeadingIdle,
    windowKindFor,
    windowLengthMs,
  } = forecast;
  const { parseClaudeLimitLine, parseCodexLimitLine, nextClockTime } = signals;

  /* ── Clock words ─────────────────────────────────────────────────────── */
  {
    // 25 Oct 2026 is 25 hours long in Madrid (the clocks go back at 03:00).
    const noon = new Date(2026, 9, 25, 12, 0).getTime();
    eq("clock: later today is just the time", formatClock(new Date(2026, 9, 25, 18, 30).getTime(), noon), "18:30");
    eq("clock: the day after a clock change is still tomorrow", formatClock(new Date(2026, 9, 26, 11, 0).getTime(), noon), "tomorrow 11:00");
    eq("clock: the day after a spring change is tomorrow", formatClock(new Date(2026, 2, 30, 9, 0).getTime(), new Date(2026, 2, 29, 12, 0).getTime()), "tomorrow 09:00");
    eq("clock: two days out names the day", formatClock(new Date(2026, 9, 27, 11, 0).getTime(), noon), "Tue 11:00");
  }

  /* ── Window labels ───────────────────────────────────────────────────── */

  eq("a 5-hour label is 5 hours long", windowLengthMs("5-hour"), 5 * HOUR);
  eq("a model-scoped 7-day label is 7 days long", windowLengthMs("Opus 7-day"), 7 * DAY);
  eq("a label with no length is 0", windowLengthMs("Credits"), 0);
  eq("5-hour is the short kind", windowKindFor("5-hour"), "5h");
  eq("7-day is the weekly kind", windowKindFor("7-day"), "7d");

  /* ── Series arithmetic ───────────────────────────────────────────────── */

  const flat = { startMs: 0, bucketMs: BUCKET, values: [4, 4, 4, 4] };
  eq("sumBetween counts whole buckets", sumBetween(flat, 0, HOUR), 16);
  eq("sumBetween counts a partial bucket pro rata", sumBetween(flat, 0, BUCKET / 2), 2);
  eq("sumBetween is 0 for an empty span", sumBetween(flat, HOUR, HOUR), 0);
  const leading = { startMs: at(1, 0), bucketMs: BUCKET, values: [...new Array(96 * 3).fill(0), 1, 2] };
  const trimmed = trimLeadingIdle(leading);
  eq("trimLeadingIdle starts on the day of the first burn", new Date(trimmed.startMs).getDate(), 4);
  eq("trimLeadingIdle keeps every burn", trimmed.values.reduce((a, b) => a + b, 0), 3);

  /* ── A heavy morning runs out before the reset ───────────────────────── */

  {
    // Every day from 9 to 14 the user burns 30% of the window per hour. The
    // window opened at 9:00; at 10:00 it reads 30%, so at this pace it is
    // full a little after 12:20, long before the 14:00 reset.
    const nowMs = at(20, 10);
    const history = workdayHistory(nowMs, 21, 30, 9, 14);
    const result = forecastWindow({
      nowMs,
      windowStartMs: at(20, 9),
      resetsAtMs: at(20, 14),
      usedPercent: 30,
      kind: "5h",
      history,
      percentPerUnit: [1],
      inUse: true,
      paths: 300,
      seed: 7,
    });
    check("heavy: almost every replay runs out", result.hitProbability > 0.9);
    check("heavy: the median hit is between 11:45 and 13:00", result.hitAt.p50 >= at(20, 11, 45) && result.hitAt.p50 <= at(20, 13));
    check("heavy: hit quantiles are ordered", result.hitAt.p10 <= result.hitAt.p50 && result.hitAt.p50 <= result.hitAt.p90);
    check(
      "heavy: every cone point has p10 <= p50 <= p90",
      result.cone.every((point) => point.p10 <= point.p50 + 1e-9 && point.p50 <= point.p90 + 1e-9),
    );
    check("heavy: the cone never falls", result.cone.every((point, i, all) => i === 0 || point.p50 >= all[i - 1].p50 - 1e-9));
    check("heavy: the cone never passes 100", result.cone.every((point) => point.p90 <= 100));
    eq("heavy: the cone starts at the reading", result.cone[0].p50, 30);
    eq("heavy: the cone ends at the reset", result.cone[result.cone.length - 1].ms, at(20, 14));
    const verdict = describeForecast(result, "5-hour");
    eq("heavy: the verdict is a warning", verdict.tone, "danger");
    check("heavy: the headline names the limit and the lead before reset", /hit the 5-hour limit at \d\d:\d\d, .* before it resets/.test(verdict.headline));
    eq("heavy: the observed curve ends at the reading", result.observed[result.observed.length - 1][1], 30);
  }

  /* ── A quiet evening has room to spare ───────────────────────────────── */

  {
    // Same habit, but it is 20:00: the user never works in the evening.
    const nowMs = at(20, 20);
    const history = workdayHistory(nowMs, 21, 30, 9, 14);
    const result = forecastWindow({
      nowMs,
      windowStartMs: at(20, 18),
      resetsAtMs: at(20, 23),
      usedPercent: 12,
      kind: "5h",
      history,
      percentPerUnit: [1],
      inUse: true,
      paths: 200,
      seed: 3,
    });
    eq("quiet: no replay runs out", result.hitProbability, 0);
    check("quiet: the window ends where it is", Math.abs(result.endPercent.p50 - 12) < 0.5);
    const verdict = describeForecast(result, "5-hour");
    check("quiet: the headline says room to spare", /about 12%\. Room to spare\./.test(verdict.headline));
    eq("quiet: the hit time is unknown", result.hitAt.p50, null);
  }

  /* ── An account not in use is forecast flat ──────────────────────────── */

  {
    const nowMs = at(20, 10);
    const result = forecastWindow({
      nowMs,
      windowStartMs: at(20, 9),
      resetsAtMs: at(20, 14),
      usedPercent: 40,
      kind: "5h",
      history: workdayHistory(nowMs, 21, 30, 9, 14),
      percentPerUnit: [1],
      inUse: false,
      paths: 50,
    });
    eq("idle account: nothing runs out", result.hitProbability, 0);
    eq("idle account: it ends where it is", result.endPercent.p90, 40);
    check("idle account: the headline says it is not in use", /^Not in use/.test(describeForecast(result, "5-hour").headline));
  }

  /* ── A used-up window says so ────────────────────────────────────────── */

  {
    const nowMs = at(20, 10);
    const result = forecastWindow({
      nowMs,
      windowStartMs: at(20, 9),
      resetsAtMs: at(20, 14),
      usedPercent: 100,
      kind: "5h",
      history: workdayHistory(nowMs, 7, 30, 9, 14),
      percentPerUnit: [1],
      inUse: true,
      paths: 20,
    });
    check("full: the headline says it is used up", /used up/.test(describeForecast(result, "5-hour").headline));
  }

  /* ── A burst well above the usual pace is named ──────────────────────── */

  {
    // Usually 4%/h from 9 to 18; the last hour burned 40%.
    const nowMs = at(20, 11);
    const history = workdayHistory(nowMs, 21, 4, 9, 18);
    for (let t = nowMs - HOUR; t < nowMs; t += BUCKET) {
      history.values[Math.floor((t - history.startMs) / BUCKET)] = 10;
    }
    const result = forecastWindow({
      nowMs,
      windowStartMs: at(20, 9),
      resetsAtMs: at(20, 14),
      usedPercent: 48,
      kind: "5h",
      history,
      percentPerUnit: [1],
      inUse: true,
      paths: 300,
      seed: 11,
    });
    check("burst: the pace ratio is about 10", result.pace.ratio > 8 && result.pace.ratio < 12);
    const nudge = burnNudge(result, 5, "5-hour");
    check("burst: the nudge counts the agents and the multiple", /^5 agents are burning 10× your usual rate\./.test(nudge ?? ""));
    eq("burst: one agent is 'You'", /^You are burning/.test(burnNudge(result, 1, "5-hour") ?? ""), true);
  }

  /* ── Go ahead near a reset ───────────────────────────────────────────── */

  {
    const nowMs = at(20, 13, 30);
    const result = forecastWindow({
      nowMs,
      windowStartMs: at(20, 9),
      resetsAtMs: at(20, 14),
      usedPercent: 20,
      kind: "5h",
      history: workdayHistory(nowMs, 14, 2, 9, 18),
      percentPerUnit: [1],
      inUse: true,
      paths: 100,
    });
    check("go ahead: plenty left close to the reset", /^Go ahead: about \d+% of the 5-hour limit will be left when it resets in 30 min/.test(goAheadNote(result, "5-hour") ?? ""));
    const early = forecastWindow({
      nowMs: at(20, 10),
      windowStartMs: at(20, 9),
      resetsAtMs: at(20, 14),
      usedPercent: 20,
      kind: "5h",
      history: workdayHistory(at(20, 10), 14, 2, 9, 18),
      percentPerUnit: [1],
      inUse: true,
      paths: 100,
    });
    eq("go ahead: not while the window is young", goAheadNote(early, "5-hour"), null);
  }

  /* ── Next account ────────────────────────────────────────────────────── */

  {
    const nowMs = at(20, 10);
    const line = suggestNextAccount(
      [
        { profileId: "a", label: "Main", active: true, tightestEnd: 96, tightestLabel: "5-hour", resetsAtMs: at(20, 12) },
        { profileId: "b", label: "Main 2", active: false, tightestEnd: 4, tightestLabel: "5-hour", resetsAtMs: at(20, 11) },
      ],
      nowMs,
    );
    eq("next account: the roomiest other account", line, "Use Main 2 next: 96% left, its 5-hour limit resets 11:00.");
    eq(
      "next account: nothing to say while the active one has room",
      suggestNextAccount(
        [
          { profileId: "a", label: "Main", active: true, tightestEnd: 50, tightestLabel: "5-hour", resetsAtMs: null },
          { profileId: "b", label: "Main 2", active: false, tightestEnd: 0, tightestLabel: "5-hour", resetsAtMs: null },
        ],
        nowMs,
      ),
      null,
    );
  }

  /* ── Calibration ─────────────────────────────────────────────────────── */

  {
    const history = { startMs: 0, bucketMs: BUCKET, values: new Array(40).fill(5) };
    const factors = calibrationFactors(
      history,
      [
        { windowStartMs: 0, atMs: 10 * BUCKET, usedPercent: 25, source: "live" },
        { windowStartMs: 0, atMs: BUCKET, usedPercent: 1, source: "recorded" },
        { windowStartMs: 0, atMs: 2 * BUCKET, usedPercent: 50, source: "recorded" },
      ],
      20,
    );
    eq("calibration: one factor per usable anchor", factors.length, 1);
    eq("calibration: percent over spend", factors[0], 0.5);
  }

  /* ── Readings ────────────────────────────────────────────────────────── */

  {
    const reset1 = at(10, 6);
    const reset2 = at(17, 6);
    const readings = [
      { atMs: at(5, 10), usedPercent: 2, resetsAtMs: reset1 },
      { atMs: at(5, 11), usedPercent: 2, resetsAtMs: reset1 + 30_000 },
      { atMs: at(6, 12), usedPercent: 9, resetsAtMs: reset1 },
      { atMs: at(11, 9), usedPercent: 3, resetsAtMs: reset2 },
    ];
    eq("readings: a reset that moves by seconds is the same window", groupReadingsByWindow(readings).length, 2);
    const series = percentSeriesFromReadings(readings, at(1, 0), at(12, 0));
    eq("readings: each rise is booked once, the first from zero", series.values.reduce((a, b) => a + b, 0), 12);
    const past = pastWindowsFromReadings(readings, 7 * DAY, at(12, 0));
    eq("readings: only windows that already reset are past", past.length, 1);
    eq("readings: a past window ends at its highest reading", past[0].endPercent, 9);
    eq("readings: used at a moment is the last reading before it", past[0].usedAt(at(6, 0)), 2);
  }

  /* ── Back-test ───────────────────────────────────────────────────────── */

  {
    const nowMs = at(25, 0);
    const history = workdayHistory(nowMs, 24, 10, 9, 14);
    const windows = [];
    for (let day = 2; day <= 23; day += 1) {
      const startMs = at(day, 9);
      windows.push({
        startMs,
        resetsAtMs: startMs + 5 * HOUR,
        endPercent: 50,
        hitAtMs: null,
        usedAt: (ms) => Math.min(50, Math.max(0, ((ms - startMs) / HOUR) * 10)),
      });
    }
    const { summary } = backtestForecast({ windows, history, percentPerUnit: [1], kind: "5h", paths: 100 });
    check("back-test: a perfectly regular habit is forecast within 2 points", summary.maeModel < 2);
    check("back-test: and the band holds the outcome", summary.coverage > 0.9);
    eq("back-test: windows without 3 days of history before them are skipped", summary.windows, 20);
  }

  /* ── Ideas ───────────────────────────────────────────────────────────── */

  eq("ideas: Cora's hint is off by default", normalizeForecastIdeas(undefined).coraHint, false);
  eq("ideas: the nudge is on by default", normalizeForecastIdeas({}).burnNudge, true);
  eq("ideas: a stored value wins", normalizeForecastIdeas({ goAhead: false }).goAhead, false);

  /* ── Transcript readers ──────────────────────────────────────────────── */

  {
    // Shaped like the synthetic message Claude Code writes when a window runs out.
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-23T23:45:08.525Z",
      isApiErrorMessage: true,
      error: "rate_limit",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "You've hit your session limit · resets 3am (Europe/Madrid)" }],
      },
    });
    const hit = parseClaudeLimitLine(line);
    eq("claude: a session-limit message is a hit", hit && hit.kind, "session");
    eq("claude: its reset is the next 3am in Madrid", hit && new Date(hit.resetsAtMs).toISOString(), "2026-09-24T01:00:00.000Z");
    const half = JSON.stringify({
      ...JSON.parse(line),
      message: { content: [{ type: "text", text: "You've hit your session limit · resets 12:30am (Europe/Madrid)" }] },
      timestamp: "2026-09-19T20:16:32.424Z",
    });
    eq("claude: half-hour resets read too", new Date(parseClaudeLimitLine(half).resetsAtMs).toISOString(), "2026-09-19T22:30:00.000Z");
    eq("claude: an ordinary line is not a hit", parseClaudeLimitLine('{"type":"assistant","message":{}}'), null);
    eq(
      "claude: a transcript that merely talks about limits is not a hit",
      parseClaudeLimitLine(JSON.stringify({ type: "user", message: { content: "why did I hit your rate_limit?" } })),
      null,
    );
    eq("clock: the next 3pm UTC after noon UTC", new Date(nextClockTime(Date.parse("2026-10-01T12:00:00Z"), 15, 0, "UTC")).toISOString(), "2026-10-01T15:00:00.000Z");
  }

  {
    // Shaped like a Codex token_count event (fields trimmed).
    const line = JSON.stringify({
      timestamp: "2026-10-24T21:43:34.976Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 1.0, window_minutes: 10080, resets_at: 1793383421 },
          secondary: null,
          plan_type: "pro",
        },
      },
    });
    const samples = parseCodexLimitLine(line);
    eq("codex: one sample per reported window", samples.length, 1);
    eq("codex: the window length is kept", samples[0].windowMinutes, 10080);
    eq("codex: the reset is in milliseconds", samples[0].resetsAtMs, 1793383421000);
    eq("codex: a line without limits gives nothing", parseCodexLimitLine('{"type":"event_msg"}').length, 0);
  }

  console.log(`\nAll ${pass} usage-forecast checks passed.`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
