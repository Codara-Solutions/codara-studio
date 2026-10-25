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
const LEARNING_TS = path.join(SHARED_DIR, "usage-forecast-learning.ts");
const MAIN_FORECAST_TS = path.join(ROOT, "src", "main", "usage-forecast.ts");
// The main module's own homes and the scan it would ask the worker for are
// stubbed, so its log and scoring run against a temporary folder.
const forecastHome = fs.mkdtempSync(path.join(os.tmpdir(), "codara-forecast-home-"));

const harnessPlugin = {
  name: "usage-forecast-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onResolve({ filter: /\/codara-home$/ }, () => ({ path: "codara-home", namespace: "stub" }));
    build.onResolve({ filter: /\/usage-analytics$/ }, () => ({ path: "usage-analytics", namespace: "stub" }));
    build.onResolve({ filter: /\/preferences-store$/ }, () => ({ path: "preferences-store", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents:
        args.path === "codara-home"
          ? `module.exports = { codaraHome: () => ${JSON.stringify(forecastHome)} };`
          : args.path === "usage-analytics"
            ? "module.exports = { readForecastScan: async () => { throw new Error('no scan in unit tests'); } };"
            : args.path === "preferences-store"
              ? "module.exports = { getPreferenceCached: () => undefined };"
              : "module.exports = { app: { getPath: () => '/dev/null' } };",
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
  const learning = await bundle(LEARNING_TS, path.join(tmp, "learning.bundle.cjs"));
  const mainForecast = await bundle(MAIN_FORECAST_TS, path.join(tmp, "main-forecast.bundle.cjs"));
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

  /* ── Learning from past errors ───────────────────────────────────────── */
  {
    const { confidenceLine, correctedEnd, describeLearning, fitErrorModel, learnedBacktest } = learning;
    // Growth quantiles of a forecast that says "about 10 more points, 6 to
    // 14", at the 21 levels the engine keeps.
    const band = (middle, half) =>
      Array.from({ length: 21 }, (_, k) => Math.max(0, middle + half * ((k - 10) / 8)));
    // Past windows that each really grew `ratio` times what was forecast,
    // with a little noise, one forecast per window halfway through.
    const history = (count, ratio, startMs = at(1, 0)) =>
      Array.from({ length: count }, (_, i) => {
        const windowStartMs = startMs + i * 5 * HOUR;
        const noise = ((i * 7) % 5) - 2;
        return {
          atMs: windowStartMs + 2.5 * HOUR,
          closedMs: windowStartMs + 5 * HOUR,
          windowStartMs,
          usedPercent: 20,
          growth: band(10, 4),
          actual: 20 + 10 * ratio + noise,
          source: "replay",
        };
      });
    // Just after the last of `count` windows, so none of them has faded.
    const after = (count) => at(1, 0) + count * 5 * HOUR + HOUR;
    const now = after(200);

    const none = fitErrorModel([], now, "5h");
    eq("learning: with no past forecasts there is no correction", `${none.growthBias},${none.spread}`, "1,1");
    const few = fitErrorModel(history(3, 2), now, "5h");
    eq("learning: fewer than 5 telling windows correct nothing", `${few.growthBias},${few.spread}`, "1,1");
    eq("learning: they still count as history", few.windows, 3);

    const some = fitErrorModel(history(10, 2), after(10), "5h");
    const many = fitErrorModel(history(200, 2), now, "5h");
    check(`learning: an underestimate is corrected upward (${some.growthBias.toFixed(2)})`, some.growthBias > 1.1);
    check(
      `learning: more history pulls the correction closer to the truth (${some.growthBias.toFixed(2)} < ${many.growthBias.toFixed(2)} <= 2.1)`,
      some.growthBias < many.growthBias && many.growthBias <= 2.1 && many.growthBias > 1.6,
    );
    const over = fitErrorModel(history(200, 0.5), now, "5h");
    check(`learning: an overestimate is corrected downward (${over.growthBias.toFixed(2)})`, over.growthBias < 0.7);

    // Idle windows (nothing forecast, nothing happened) teach nothing.
    const idle = history(50, 1).map((sample) => ({ ...sample, growth: band(0.2, 0.1), actual: sample.usedPercent }));
    const idleModel = fitErrorModel(idle, now, "5h");
    eq("learning: idle windows leave the forecast alone", `${idleModel.growthBias},${idleModel.spread}`, "1,1");

    // Outcomes far outside the band: it widens until 8 in 10 land inside.
    const offsets = [-12, -6, 0, 6, 12, -3, 3, 9, -9, 1];
    const wild = history(200, 1).map((sample, i) => ({ ...sample, actual: 30 + offsets[i % offsets.length] }));
    const wide = fitErrorModel(wild, now, "5h");
    check(`learning: misses outside the band widen it (${wide.spread.toFixed(2)})`, wide.spread > 1.5);
    const held = wild.filter((sample) => {
      const end = correctedEnd(sample.growth, sample.usedPercent, wide);
      return sample.actual >= end.p10 - 0.5 && sample.actual <= end.p90 + 0.5;
    }).length / wild.length;
    check(`learning: the widened band holds most outcomes (${held.toFixed(2)})`, held >= 0.7);

    // Outcomes always on the middle guess: the band narrows, but only with
    // a lot of evidence, since narrowing promises more than it knows.
    const exact = history(200, 1).map((sample) => ({ ...sample, actual: 30 }));
    const tightFew = fitErrorModel(exact.slice(0, 8), after(8), "5h");
    const tightMany = fitErrorModel(exact, now, "5h");
    check(
      `learning: the band narrows slowly (${tightFew.spread.toFixed(2)} with 8 windows, ${tightMany.spread.toFixed(2)} with 200)`,
      tightFew.spread > 0.8 && tightMany.spread < tightFew.spread,
    );

    // Old lessons fade: an old underestimate, then a long run of good guesses.
    const old = history(60, 2, at(1, 0));
    const recent = history(60, 1, at(1, 0) + 60 * 5 * HOUR + 120 * DAY);
    const faded = fitErrorModel([...old, ...recent], at(1, 0) + 60 * 5 * HOUR + 120 * DAY + 60 * 5 * HOUR, "5h");
    check(`learning: recent windows outweigh old ones (${faded.growthBias.toFixed(2)})`, faded.growthBias < 1.2);

    // Live forecasts count more than replays.
    const mixed = [...history(30, 1), ...history(30, 2, at(1, 0) + 30 * 5 * HOUR).map((s) => ({ ...s, source: "live" }))];
    const mixedModel = fitErrorModel(mixed, after(60), "5h");
    check(`learning: live forecasts weigh more than replays (${mixedModel.growthBias.toFixed(2)})`, mixedModel.growthBias > 1.4);
    eq("learning: live forecasts are counted apart", mixedModel.liveSamples, 30);

    // The correction moves the end band the way forecastWindow moves each replay.
    const corrected = correctedEnd(band(10, 4), 20, { growthBias: 2, spread: 1 });
    eq("learning: a doubled growth doubles the middle guess", Math.round(corrected.p50), 40);
    const runOut = correctedEnd(band(70, 20), 30, { growthBias: 1, spread: 1 });
    check(`learning: the share past the limit is the chance to run out (${runOut.hitProbability.toFixed(2)})`, runOut.hitProbability > 0.4 && runOut.hitProbability < 0.6);

    // Walk-forward: a forecast is only ever corrected with windows that had
    // reset before it was made.
    const cases = history(40, 2).map((sample) => ({
      startMs: sample.windowStartMs,
      closedMs: sample.closedMs,
      checkpoint: 0.5,
      atMs: sample.atMs,
      usedPercent: sample.usedPercent,
      predicted: { p10: 20 + 6, p50: 30, p90: 20 + 14 },
      naive: 30,
      actual: sample.actual,
      hitProbability: 0,
      hit: false,
      growth: sample.growth,
      warnedMinutesAhead: null,
    }));
    const walked = learnedBacktest(cases, "5h");
    eq("walk-forward: the first forecast had nothing to learn from", Math.round(walked.cases[0].predicted.p50), 30);
    check(
      `walk-forward: later forecasts miss less once it has learned (${walked.summary.maeModel.toFixed(1)} < 9)`,
      walked.summary.maeModel < 9,
    );
    const lateBand = walked.byHistory[walked.byHistory.length - 1];
    check(
      `walk-forward: with more history the miss shrinks (${lateBand.maeBefore.toFixed(1)} -> ${lateBand.maeAfter.toFixed(1)})`,
      lateBand.maeAfter < lateBand.maeBefore,
    );

    const sure = describeLearning(fitErrorModel(history(200, 1), now, "5h"), walked.cases.slice(-30).map((c) => ({ ...c, actual: c.predicted.p50 })));
    eq("confidence: much history and small misses is sure", sure.confidence, "good");
    const unsure = describeLearning(fitErrorModel(history(3, 1), now, "5h"), []);
    eq("confidence: three windows is still learning", confidenceLine(unsure), "still learning · 3 past windows");

    // A spend back-test checks the timing, not the scale, so it alone is at
    // most fairly sure; live forecasts scored on real readings lift the cap.
    const perfectCases = history(200, 1).map((sample) => ({
      startMs: sample.windowStartMs,
      closedMs: sample.closedMs,
      checkpoint: 0.5,
      atMs: sample.atMs,
      usedPercent: sample.usedPercent,
      predicted: { p10: 26, p50: 30, p90: 34 },
      naive: 30,
      actual: 30,
      hitProbability: 0,
      hit: false,
      growth: sample.growth,
      warnedMinutesAhead: null,
    }));
    const trackBase = (truth) => ({ provider: "anthropic", windowLabel: "5-hour", truth, summary: {}, recent: [] });
    const livePerfect = history(10, 1, after(200)).map((sample) => ({ ...sample, actual: 30, source: "live" }));
    const { learnTrack } = mainForecast;
    eq("confidence: replayed readings can be sure", learnTrack(trackBase("readings"), perfectCases, "5h", [], after(210)).learning.confidence, "good");
    eq("confidence: replayed spend alone is at most fairly sure", learnTrack(trackBase("spend"), perfectCases, "5h", [], after(210)).learning.confidence, "fair");
    eq("confidence: ten scored live forecasts make spend sure", learnTrack(trackBase("spend"), perfectCases, "5h", livePerfect, after(210)).learning.confidence, "good");

    // A window is one window however many forecasts of it were kept, and
    // whichever source kept them.
    const oneLiveWindow = Array.from({ length: 10 }, (_, k) => ({ ...livePerfect[0], atMs: livePerfect[0].atMs + k * MINUTE }));
    eq("confidence: ten live forecasts of one window are one live window", learnTrack(trackBase("spend"), perfectCases, "5h", oneLiveWindow, after(210)).learning.confidence, "fair");
    const jittered = history(20, 1).map((sample, i) => ({ ...sample, windowStartMs: sample.windowStartMs + (i % 3) * MINUTE }));
    const twice = [...history(20, 1), ...jittered.map((sample) => ({ ...sample, source: "live" }))];
    eq("learning: a window kept as replay and live, starts a few minutes apart, counts once", fitErrorModel(twice, after(20), "5h").windows, 20);
    eq("learning: live windows are counted", fitErrorModel(twice, after(20), "5h").liveWindows, 20);
    const chattyWeek = Array.from({ length: 300 }, (_, k) => ({ ...history(1, 3, after(100))[0], atMs: after(100) + k * MINUTE, source: "live" }));
    const outvoted = fitErrorModel([...history(100, 1), ...chattyWeek], after(102), "5h");
    check(
      `learning: one live window logged 300 times does not outvote 100 windows (${outvoted.growthBias.toFixed(2)})`,
      outvoted.growthBias < 1.2,
    );

    // One fit per closed window, not per forecast, keeps a long history quick.
    const manyCases = history(800, 1).flatMap((sample) =>
      [0.25, 0.5, 0.75].map((checkpoint) => ({
        startMs: sample.windowStartMs,
        closedMs: sample.closedMs,
        checkpoint,
        atMs: sample.windowStartMs + checkpoint * 5 * HOUR,
        usedPercent: sample.usedPercent,
        predicted: { p10: 26, p50: 30, p90: 34 },
        naive: 30,
        actual: sample.actual,
        hitProbability: 0,
        hit: false,
        growth: sample.growth,
        warnedMinutesAhead: null,
      })),
    );
    const manyLive = history(800, 1).flatMap((sample) =>
      Array.from({ length: 10 }, (_, k) => ({ ...sample, atMs: sample.windowStartMs + k * 30 * MINUTE, source: "live" })),
    );
    const walkStarted = Date.now();
    learnedBacktest(manyCases, "5h", manyLive);
    const walkMs = Date.now() - walkStarted;
    check(`walk-forward: 2400 forecasts and 8000 live ones replay in under 2 s (${walkMs} ms)`, walkMs < 2000);
  }

  /* ── Live forecasts are logged and scored once their window resets ──── */
  {
    const { logForecasts, readLoggedForecasts, scoreLoggedForecasts } = mainForecast;
    const start = at(20, 9);
    const reset = start + 5 * HOUR;
    const view = (over = {}) => ({
      profileId: "work",
      provider: "anthropic",
      windowId: "five_hour",
      windowLabel: "5-hour",
      source: "live",
      result: {
        inUse: true,
        windowStartMs: start,
        resetsAtMs: reset,
        usedPercent: 30,
        growthQuantiles: Array.from({ length: 21 }, (_, k) => 10 + k),
      },
      ...over,
    });
    await logForecasts([view(), view({ profileId: "other", result: { ...view().result, inUse: false } })], start + HOUR);
    await logForecasts([view()], start + HOUR + 10 * MINUTE);
    await logForecasts([view()], start + 2 * HOUR);
    const logged = await readLoggedForecasts(0);
    eq("log: only the account in use is logged, at most every 30 minutes", logged.length, 2);
    eq("log: the uncorrected growth is kept", logged[0].growth.length, 21);

    const reading = (t, used) => ({ t, profileId: "work", provider: "anthropic", windowId: "five_hour", label: "5-hour", used, resetsAt: reset });
    eq("score: nothing is scored before the window resets", scoreLoggedForecasts(logged, [reading(start + 4.9 * HOUR, 70)], reset - MINUTE).size, 0);
    const scored = scoreLoggedForecasts(logged, [reading(start + 3 * HOUR, 55), reading(start + 4.9 * HOUR, 70)], reset + MINUTE);
    const samples = scored.get("anthropic|5h") ?? [];
    eq("score: a reset window scores each logged forecast", samples.length, 2);
    eq("score: the truth is the highest reading of that window", samples[0].actual, 70);
    eq("score: a scored live forecast is marked live", samples[0].source, "live");
    eq(
      "score: an end nobody saw (last reading long before the reset) is not guessed",
      scoreLoggedForecasts(logged, [reading(start + 2 * HOUR, 40)], reset + MINUTE).size,
      0,
    );
    eq(
      "score: a window that hit 100 is known even without a late reading",
      (scoreLoggedForecasts(logged, [reading(start + 2 * HOUR, 100)], reset + MINUTE).get("anthropic|5h") ?? [])[0]?.actual,
      100,
    );

    // A reset computed from "resets in N seconds" moves a little on every
    // read; it is still the same window, logged on the same schedule.
    const drifting = (minutes, t) =>
      logForecasts([view({ profileId: "drift", result: { ...view().result, resetsAtMs: reset + minutes * MINUTE } })], t);
    await drifting(0, start + HOUR);
    await drifting(1, start + HOUR + 5 * MINUTE);
    await drifting(-1, start + HOUR + 10 * MINUTE);
    await drifting(0, start + 2 * HOUR);
    eq(
      "log: a reset that drifts by a minute between reads is the same window",
      (await readLoggedForecasts(0)).filter((entry) => entry.profileId === "drift").length,
      2,
    );
    const weekStart = at(20, 0);
    const week = (t) =>
      logForecasts(
        [view({ profileId: "weekly", windowId: "seven_day", windowLabel: "7-day", result: { ...view().result, windowStartMs: weekStart, resetsAtMs: weekStart + 7 * DAY } })],
        t,
      );
    for (let hour = 1; hour <= 48; hour += 1) await week(weekStart + hour * HOUR);
    const weekly = (await readLoggedForecasts(0)).filter((entry) => entry.profileId === "weekly").length;
    check(`log: a 7-day window is logged about ten times a week, not every half hour (${weekly} in 2 days)`, weekly <= 3);

    const weekEnd = weekStart + 7 * DAY;
    const weekLogged = [{ t: weekStart + DAY, profileId: "weekly", provider: "openai-codex", windowId: "seven_day", label: "7-day", windowStartMs: weekStart, resetsAt: weekEnd, used: 10, growth: Array.from({ length: 21 }, (_, k) => k) }];
    const weekReading = (t, used) => ({ t, profileId: "weekly", provider: "openai-codex", windowId: "seven_day", label: "7-day", used, resetsAt: weekEnd });
    eq(
      "score: a week whose last reading came 20 hours before the reset is not scored",
      scoreLoggedForecasts(weekLogged, [weekReading(weekEnd - 20 * HOUR, 50)], weekEnd + MINUTE).size,
      0,
    );
    eq(
      "score: a week read 2 hours before the reset is scored",
      scoreLoggedForecasts(weekLogged, [weekReading(weekEnd - 2 * HOUR, 50)], weekEnd + MINUTE).size,
      1,
    );

    const busyLogged = Array.from({ length: 7000 }, (_, i) => ({ ...logged[0], t: logged[0].t + i, resetsAt: reset + (i % 700) * 5 * HOUR, windowStartMs: start + (i % 700) * 5 * HOUR }));
    const busyReadings = Array.from({ length: 24000 }, (_, i) => ({ ...reading(start + (i % 700) * 5 * HOUR + 4.9 * HOUR, 50), resetsAt: reset + (i % 700) * 5 * HOUR }));
    const scoreStarted = Date.now();
    const busy = scoreLoggedForecasts(busyLogged, busyReadings, reset + 800 * 5 * HOUR);
    const scoreMs = Date.now() - scoreStarted;
    eq("score: every logged forecast of a full log is scored", (busy.get("anthropic|5h") ?? []).length, 7000);
    check(`score: a full log scores in under 300 ms (${scoreMs} ms)`, scoreMs < 300);
  }

  /* ── The engine applies a correction to every replay ─────────────────── */
  {
    const now = at(14, 12);
    const history = workdayHistory(now, 14, 8, 9, 18);
    const base = { nowMs: now, windowStartMs: now - 2 * HOUR, resetsAtMs: now + 3 * HOUR, usedPercent: 20, kind: "5h", history, percentPerUnit: [1], inUse: true, paths: 200, seed: 3 };
    const plain = forecastWindow(base);
    const doubled = forecastWindow({ ...base, correction: { growthBias: 2, spread: 1 } });
    eq("engine: growth quantiles are kept, one per level", plain.growthQuantiles.length, 21);
    check(
      `engine: a doubled growth doubles the forecast growth (${(plain.endPercent.p50 - 20).toFixed(1)} -> ${(doubled.endPercent.p50 - 20).toFixed(1)})`,
      Math.abs((doubled.endPercent.p50 - 20) - 2 * (plain.endPercent.p50 - 20)) < 1.5,
    );
    const identity = forecastWindow({ ...base, correction: { growthBias: 1, spread: 1 } });
    eq("engine: a neutral correction changes nothing", JSON.stringify(identity.endPercent), JSON.stringify(plain.endPercent));
    const wider = forecastWindow({ ...base, correction: { growthBias: 1, spread: 2 } });
    check(
      "engine: a wider spread widens the band around the same middle",
      wider.endPercent.p90 - wider.endPercent.p10 > plain.endPercent.p90 - plain.endPercent.p10 &&
        Math.abs(wider.endPercent.p50 - plain.endPercent.p50) < 1,
    );
    const hot = forecastWindow({ ...base, usedPercent: 60, correction: { growthBias: 3, spread: 1 } });
    check("engine: a corrected forecast can run out, with a time", hot.hitProbability > 0.5 && hot.hitAt.p50 !== null && hot.hitAt.p50 < base.resetsAtMs);
  }

  console.log(`\nAll ${pass} usage-forecast checks passed.`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(forecastHome, { recursive: true, force: true });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
