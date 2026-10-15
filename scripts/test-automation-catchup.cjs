// Unit suite for missed-run catch-up and the precheck gate.
//
//   1. The pure slot math and decisions (src/main/orchestration/
//      automation-catchup.ts): which cron/interval times were missed, run
//      once or skip, and how a trigger fire is classified (punctual, late
//      after a sleep, already settled).
//   2. The real scheduler.ts + automation-loop.ts with run-store, event-log
//      and friends stubbed (as in test-automations.cjs): the start and wake
//      catch-up runs at most one pass and never a burst, records skips, and
//      the precheck gates trigger and cadence passes but never Run now.
//
//   node scripts/test-automation-catchup.cjs

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const ORCH_DIR = path.join(ROOT, "src", "main", "orchestration");

// The scheduler reads the wall clock and the suite uses hourly and per-minute
// crons, so a run that straddled a full hour or minute saw an extra slot (and
// croner fired a real one). The clock starts at a fixed mid-hour time and
// advances with real elapsed time, so timers and sleeps still mean what they say.
function installFixedClock(startIso) {
  const RealDate = Date;
  const base = RealDate.parse(startIso);
  const t0 = process.hrtime.bigint();
  const now = () => base + Number((process.hrtime.bigint() - t0) / 1_000_000n);
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now());
      else super(...args);
    }
    static now() {
      return now();
    }
  }
  globalThis.Date = FakeDate;
}
installFixedClock("2026-10-15T12:30:20.000Z");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

let passed = 0;
function pass(name) {
  passed += 1;
  console.log(`  PASS ${name}`);
}

const harnessPlugin = {
  name: "automation-catchup-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve(
      { filter: /^(\.\/(run-queue|run-store|event-log)|\.\.\/(codara-home|fs-atomic|agent-runtimes|pty-manager|notify|git-exec|git-events))$/ },
      (args) => ({ path: args.path.replace(/^\.\.?\//, ""), namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      const init = "globalThis.__CU ??= { launches: [], runs: {}, events: [] };\n";
      switch (args.path) {
        case "codara-home":
          return {
            contents:
              "export function codaraHome(){ return process.env.SPARK_HOME_DIR; }\nexport function ensureCodaraHomeSync(){}\n",
            loader: "js",
          };
        case "fs-atomic":
          return {
            contents: "const fs = require('fs');\nexport async function writeFileAtomic(p, c){ fs.writeFileSync(p, c); }\n",
            loader: "js",
          };
        case "git-exec":
          return { contents: "export async function runGit(){ return { stdout: '', stderr: '', code: 0 }; }\n", loader: "js" };
        case "git-events":
          return {
            contents: "export function emitGitRemoteUpdated(){}\nexport function onGitRemoteUpdated(){ return () => {}; }\n",
            loader: "js",
          };
        case "notify":
          return {
            contents:
              "export const automationSourceKey = (id) => `automation:${id}`;\n" +
              "export function publish(){}\nexport function rearm(){}\nexport function settleAutomationQuestions(){}\n",
            loader: "js",
          };
        case "agent-runtimes":
          return { contents: "export async function detectAgentRuntimes(){ return []; }\n", loader: "js" };
        case "pty-manager":
          return {
            contents: "export function exists(){ return false; }\nexport function killImmediate(){}\nexport function dispose(){}\n",
            loader: "js",
          };
        case "run-queue":
          return { contents: "export async function enqueue(){ return {}; }\nexport async function burnDown(){ return {}; }\n", loader: "js" };
        case "run-store":
          // Every launched run HOLDS (never completes): a launch is the event
          // under test, and a live run must hold further fires.
          return {
            contents:
              init +
              "export async function startDirectWorkerRun(input){ const id = 'run-' + (globalThis.__CU.launches.length + 1); globalThis.__CU.launches.push({ id, automationId: input.automationId }); globalThis.__CU.runs[id] = { id, status: 'running', humanMessages: [], workerAttempts: [] }; return globalThis.__CU.runs[id]; }\n" +
              "export async function addDirectIteration(input){ return { id: input.runId, status: 'running', humanMessages: [], workerAttempts: [] }; }\n" +
              "export async function getRun(id){ return globalThis.__CU.runs[id] ?? null; }\n" +
              "export async function forcePauseRun(id){ const r = globalThis.__CU.runs[id]; if (r) r.status = 'cancelled'; return r; }\n" +
              "export async function failWorkerAttempt(){ return null; }\n",
            loader: "js",
          };
        default:
          return {
            contents:
              init +
              "export async function appendEvent(e){ globalThis.__CU.events.push(e); return e; }\nexport function subscribeToEvents(){ return () => {}; }\n",
            loader: "js",
          };
      }
    });
  },
};

async function bundle(tmp) {
  const outfile = path.join(tmp, "catchup.bundle.cjs");
  await esbuild.build({
    stdin: {
      contents: [
        `export * as sched from ${JSON.stringify(path.join(ORCH_DIR, "scheduler.ts"))};`,
        `export * as loop from ${JSON.stringify(path.join(ORCH_DIR, "automation-loop.ts"))};`,
        `export * as cu from ${JSON.stringify(path.join(ORCH_DIR, "automation-catchup.ts"))};`,
        `export * as shared from ${JSON.stringify(path.join(SHARED_DIR, "automation-catchup.ts"))};`,
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    resolveExtensions: [".ts", ".js", ".cjs", ".mjs", ".json"],
    plugins: [harnessPlugin],
  });
  return require(outfile);
}

function pureChecks(cu, shared) {
  const hourly = { kind: "cron", expr: "0 * * * *" };
  const t = (s) => Date.parse(s);

  // ── slot math ──────────────────────────────────────────────────────────────
  let slots = cu.scheduledSlotsBetween(hourly, t("2026-10-15T08:30:00Z"), t("2026-10-15T11:15:00Z"));
  assert.deepStrictEqual(slots, { count: 3, capped: false, latestMs: t("2026-10-15T11:00:00Z") });
  slots = cu.scheduledSlotsBetween(hourly, t("2026-10-15T09:00:00.000Z"), t("2026-10-15T11:00:00.000Z"));
  assert.deepStrictEqual(slots, { count: 2, capped: false, latestMs: t("2026-10-15T11:00:00Z") }, "strictly after since, up to and including now");
  assert.strictEqual(cu.scheduledSlotsBetween(hourly, t("2026-10-15T09:00:01Z"), t("2026-10-15T09:59:59Z")), null);
  assert.strictEqual(cu.scheduledSlotsBetween(hourly, t("2026-10-15T11:00:00Z"), t("2026-10-15T10:00:00Z")), null, "a clock that went back has no slots");
  pass("cron slots are counted strictly after the baseline and up to now");

  const perSecond = { kind: "cron", expr: "* * * * * *" };
  slots = cu.scheduledSlotsBetween(perSecond, t("2026-10-14T00:00:00Z"), t("2026-10-15T12:34:56.700Z"));
  assert.strictEqual(slots.capped, true);
  assert.strictEqual(slots.count, cu.MISSED_SLOT_SCAN_CAP);
  assert.strictEqual(slots.latestMs, t("2026-10-15T12:34:56Z"), "the latest slot is still exact when the scan is capped");
  pass("a dense schedule is capped at the scan limit with the exact latest time");

  const ny = { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" };
  slots = cu.scheduledSlotsBetween(ny, t("2026-10-14T14:00:00Z"), t("2026-10-15T14:00:00Z"));
  assert.deepStrictEqual(slots, { count: 1, capped: false, latestMs: t("2026-10-15T13:00:00Z") }, "09:00 New York in October is 13:00 UTC");
  assert.strictEqual(cu.scheduledSlotsBetween({ kind: "cron", expr: "not a cron" }, 0, Date.now()), null);
  assert.strictEqual(cu.scheduledSlotsBetween({ kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" }, 0, Date.now()), null);
  pass("timezones apply; an invalid expression or zone has no slots");

  slots = cu.scheduledSlotsBetween({ kind: "interval", everyMs: HOUR }, 0, 3.5 * HOUR);
  assert.deepStrictEqual(slots, { count: 3, capped: false, latestMs: 3 * HOUR });
  assert.strictEqual(cu.scheduledSlotsBetween({ kind: "interval", everyMs: HOUR }, 0, 0.9 * HOUR), null);
  assert.strictEqual(cu.scheduledSlotsBetween({ kind: "folder", path: "/x", events: ["add"] }, 0, 10 * HOUR), null);
  pass("interval times count whole intervals since the baseline; other triggers have none");

  // ── baseline ───────────────────────────────────────────────────────────────
  const now = t("2026-10-15T12:00:00Z");
  assert.strictEqual(
    cu.missedBaselineMs({ createdAt: "2026-10-01T00:00:00Z", lastRunAt: "2026-10-15T09:00:00Z", scheduleCheckedAt: "2026-10-15T08:00:00Z" }, undefined, now),
    t("2026-10-15T09:00:00Z"),
  );
  assert.strictEqual(
    cu.missedBaselineMs({ createdAt: "2026-10-01T00:00:00Z", scheduleCheckedAt: "2026-10-16T08:00:00Z" }, undefined, now),
    t("2026-10-01T00:00:00Z"),
    "a checkpoint in the future is ignored",
  );
  assert.strictEqual(cu.missedBaselineMs({ createdAt: "2026-10-01T00:00:00Z" }, t("2026-10-15T11:00:00Z"), now), t("2026-10-15T11:00:00Z"));
  pass("the baseline is the latest of check, run, session check and creation");

  // ── decisions ──────────────────────────────────────────────────────────────
  const three = { count: 3, capped: false, latestMs: now - 30 * 60_000 };
  assert.strictEqual(cu.decideMissed({}, three, now).kind, "skip", "the default policy is skip");
  let v = cu.decideMissed({ missedRuns: { policy: "runOnce", graceMinutes: 60 } }, three, now);
  assert.deepStrictEqual(v, { kind: "run", catchUp: { scheduledFor: iso(now - 30 * 60_000), missedCount: 3 } });
  v = cu.decideMissed({ missedRuns: { policy: "runOnce", graceMinutes: 20 } }, three, now);
  assert.strictEqual(v.kind, "skip");
  assert.strictEqual(v.policy, "runOnce");
  v = cu.decideMissed({ missedRuns: { policy: "runOnce" } }, { count: 1, capped: false, latestMs: now - 11 * HOUR }, now);
  assert.strictEqual(v.kind, "run", "the default grace is 12 hours");
  pass("run once only inside the grace window, otherwise skip");

  // ── fire classification ────────────────────────────────────────────────────
  const slot = t("2026-10-15T10:00:00Z");
  assert.deepStrictEqual(cu.classifyTick(hourly, slot + 5, slot - HOUR, slot - HOUR), { kind: "fire" });
  assert.deepStrictEqual(cu.classifyTick(hourly, slot + 5, slot + 2, slot - HOUR), { kind: "settled" }, "a wake check already handled this slot");
  // Asleep from 08:00 to 12:40: croner fires its 09:00 slot at wake.
  const late = cu.classifyTick(hourly, slot + 2 * HOUR + 40 * 60_000, slot - 2 * HOUR + 5, slot - 2 * HOUR + 5);
  assert.strictEqual(late.kind, "missed");
  assert.strictEqual(late.slots.count, 4, "slots 09:00 to 12:00 were missed");
  assert.strictEqual(late.slots.latestMs, slot + 2 * HOUR);
  assert.deepStrictEqual(cu.classifyTick(hourly, slot + 5, slot + 10 * HOUR, slot - HOUR), { kind: "fire" }, "a checkpoint ahead of the clock does not block a punctual fire");
  pass("cron fires: punctual fires run, late ones are missed runs, settled ones are dropped");

  const every = { kind: "interval", everyMs: HOUR };
  assert.deepStrictEqual(cu.classifyTick(every, 10 * HOUR, 9 * HOUR, 9 * HOUR), { kind: "fire" });
  assert.deepStrictEqual(cu.classifyTick(every, 10 * HOUR, 9.8 * HOUR, 9 * HOUR), { kind: "settled" });
  const lateInterval = cu.classifyTick(every, 15 * HOUR, 9 * HOUR, 9 * HOUR);
  assert.strictEqual(lateInterval.kind, "missed");
  assert.strictEqual(lateInterval.slots.count, 6);
  assert.deepStrictEqual(cu.classifyTick(every, 10 * HOUR, undefined, 0), { kind: "fire" });
  pass("interval fires: punctual, already settled, and late after a sleep");

  // ── shared normalizers and lines ──────────────────────────────────────────
  assert.strictEqual(shared.normalizeMissedRuns({ policy: "bogus" }), undefined);
  assert.deepStrictEqual(shared.normalizeMissedRuns({ policy: "skip", graceMinutes: 5 }), { policy: "skip" });
  assert.deepStrictEqual(shared.normalizeMissedRuns({ policy: "runOnce" }), { policy: "runOnce", graceMinutes: 720 });
  assert.deepStrictEqual(shared.normalizeMissedRuns({ policy: "runOnce", graceMinutes: 1e9 }), { policy: "runOnce", graceMinutes: 10080 });
  assert.strictEqual(shared.formatGraceMinutes(720), "12 hours");
  assert.strictEqual(shared.formatGraceMinutes(1440), "1 day");
  assert.strictEqual(shared.formatGraceMinutes(90), "90 minutes");
  const lines = [
    shared.missedSkipDetail({ count: 3, policy: "skip", graceMinutes: 720, noticedOn: "start" }),
    shared.missedSkipDetail({ count: 1, policy: "runOnce", graceMinutes: 60, noticedOn: "wake" }),
    shared.missedSkipDetail({ count: 1000, capped: true, policy: "skip", graceMinutes: 720, noticedOn: "wake" }),
  ];
  assert.deepStrictEqual(lines, [
    "3 scheduled runs were missed while Codara was closed and skipped.",
    "1 scheduled run was missed while the computer was asleep; the latest was more than 1 hour ago, so none ran.",
    "1000 or more scheduled runs were missed while the computer was asleep and skipped.",
  ]);
  for (const line of lines) assert.ok(!/[\u2013\u2014]/.test(line), "no en or em dashes in UI copy");
  assert.strictEqual(shared.missedRunsSummary({ trigger: { kind: "manual" } }), null);
  assert.strictEqual(shared.missedRunsSummary({ trigger: hourly }), "skip");
  assert.strictEqual(shared.triggerUsesPrecheck({ kind: "manual" }), false);
  assert.strictEqual(shared.triggerUsesPrecheck({ kind: "git", events: ["remoteUpdated"] }), true);
  assert.strictEqual(shared.triggerUsesPrecheck({ kind: "manual" }, "cadence"), true, "a cadence loop's passes are checked");
  assert.strictEqual(shared.triggerUsesPrecheck({ kind: "continuous" }, "cadence"), true);
  assert.strictEqual(shared.triggerUsesPrecheck({ kind: "continuous" }, "continuous"), false);
  pass("missed-run policy normalizes and its history lines read plainly");
}

async function integrationChecks({ sched, loop }, workspace) {
  const launches = () => globalThis.__CU.launches;
  const launchesFor = (id) => launches().filter((l) => l.automationId === id).length;
  const input = { workspaceId: "ws", workspaceName: "test", cwd: workspace, initialUserNote: "do it" };
  const get = async (id) => (await sched.listJobs()).find((j) => j.id === id);
  // A job that "was created and last checked" in the past, so the start
  // check sees the gap as Codara having been closed.
  const backdate = (id, checkedAgoMs, extra = {}) =>
    sched.patchJob(id, (j) => ({
      ...j,
      createdAt: iso(Date.now() - 10 * 24 * HOUR),
      scheduleCheckedAt: iso(Date.now() - checkedAgoMs),
      ...extra,
    }));

  // Never fires on its own during the test (yearly, Jan 1st 00:00 UTC).
  const yearly = { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" };
  const hourly = { kind: "cron", expr: "0 * * * *" };

  // ── catch-up at start: run once ──────────────────────────────────────────
  // Three hours of an hourly schedule passed; policy runOnce (12 h grace).
  const runOnce = await sched.createJob({
    name: "catch up",
    trigger: hourly,
    input,
    missedRuns: { policy: "runOnce", graceMinutes: 720 },
  });
  const skipper = await sched.createJob({ name: "skipper", trigger: hourly, input });
  const stale = await sched.createJob({
    name: "stale",
    trigger: { kind: "interval", everyMs: 2 * HOUR },
    input,
    missedRuns: { policy: "runOnce", graceMinutes: 60 },
  });
  const paused = await sched.createJob({ name: "paused", trigger: hourly, input, missedRuns: { policy: "runOnce" } });
  const off = await sched.createJob({ name: "off", trigger: hourly, input, missedRuns: { policy: "runOnce" } });
  await backdate(runOnce.id, 3 * HOUR - 1000);
  await backdate(skipper.id, 3 * HOUR - 1000);
  // interval 2 h, last check 5.5 h ago: missed twice, the latest 1.5 h ago.
  await backdate(stale.id, 5.5 * HOUR);
  await backdate(paused.id, 3 * HOUR, { state: { status: "paused", iteration: 0 } });
  await sched.setEnabled(off.id, false);
  await backdate(off.id, 3 * HOUR);

  await sched.catchUpScheduledJobs("start");
  await sleep(150); // the catch-up pass launches off the settle chain

  assert.strictEqual(launchesFor(runOnce.id), 1, "exactly one catch-up pass, not three");
  let job = await get(runOnce.id);
  const rec = job.history[job.history.length - 1];
  assert.ok(rec.catchUp, "the pass is marked as a catch-up");
  assert.ok(rec.catchUp.missedCount === 3 || rec.catchUp.missedCount === 2, `missed count ${rec.catchUp.missedCount}`);
  assert.strictEqual(rec.continuationSource, "trigger");
  assert.ok(Date.now() - Date.parse(job.scheduleCheckedAt) < 5000, "the start check moved the checkpoint to now");
  pass("start: a runOnce automation runs ONE catch-up pass for several missed times");

  job = await get(skipper.id);
  assert.strictEqual(launchesFor(skipper.id), 0, "skip never starts a pass");
  assert.strictEqual(job.skips.length, 1);
  assert.strictEqual(job.skips[0].reason, "missed");
  assert.strictEqual(job.skips[0].missed.noticedOn, "start");
  assert.match(job.skips[0].detail, /scheduled runs? (was|were) missed while Codara was closed and skipped\./);
  pass("start: the default policy records one skip and starts nothing");

  job = await get(stale.id);
  assert.strictEqual(launchesFor(stale.id), 0, "a missed time older than the grace window does not run");
  assert.strictEqual(job.skips.length, 1);
  assert.match(job.skips[0].detail, /^2 scheduled runs were missed while Codara was closed; the latest was more than 1 hour ago, so none ran\.$/);
  pass("start: runOnce outside its grace window records a skip instead");

  assert.strictEqual(launchesFor(paused.id), 0);
  assert.strictEqual((await get(paused.id)).skips, undefined, "a paused loop holds its missed time silently");
  assert.strictEqual(launchesFor(off.id), 0);
  assert.strictEqual((await get(off.id)).skips, undefined, "a disabled automation has no missed runs");
  pass("start: paused and disabled automations neither run nor record");

  // A second check right away finds nothing new: never a burst.
  const before = launches().length;
  await sched.catchUpScheduledJobs("start");
  await sched.catchUpScheduledJobs("wake");
  await sleep(100);
  assert.strictEqual(launches().length, before, "repeated checks start nothing");
  assert.strictEqual((await get(skipper.id)).skips.length, 1, "repeated checks record nothing");
  pass("repeated start and wake checks never start a second pass");

  // Turning an automation back on does not count the time it was off.
  await sched.setEnabled(off.id, true);
  await sched.catchUpScheduledJobs("start");
  await sleep(100);
  assert.strictEqual(launchesFor(off.id), 0);
  assert.strictEqual((await get(off.id)).skips, undefined);
  pass("enabling an automation settles its schedule: the off time is not missed");

  // A changed schedule starts fresh, too.
  await backdate(skipper.id, 3 * HOUR);
  await sched.updateJob({ id: skipper.id, trigger: { kind: "cron", expr: "30 * * * *" } });
  await sched.catchUpScheduledJobs("start");
  assert.strictEqual((await get(skipper.id)).skips.length, 1, "no new skip after the schedule changed");
  pass("editing the trigger settles its schedule");

  // ── wake: same policy, worded for a sleep ────────────────────────────────
  const sleeper = await sched.createJob({ name: "sleeper", trigger: yearly, input });
  await backdate(sleeper.id, 400 * 24 * HOUR, { createdAt: iso(Date.now() - 500 * 24 * HOUR) });
  await sched.catchUpScheduledJobs("wake");
  job = await get(sleeper.id);
  assert.strictEqual(job.skips.length, 1);
  assert.strictEqual(job.skips[0].missed.noticedOn, "wake");
  assert.match(job.skips[0].detail, /while the computer was asleep/);
  pass("wake: a missed time is reported as missed during the sleep");

  // A time that passed moments before the wake runs as usual, whichever of
  // the wake check and croner's late fire sees it first.
  const justNow = await sched.createJob({ name: "just now", trigger: { kind: "cron", expr: "* * * * *" }, input });
  await backdate(justNow.id, 2 * HOUR);
  await sched.catchUpScheduledJobs("wake");
  await sleep(150);
  assert.strictEqual(launchesFor(justNow.id), 1, "the slot of the last minute runs once");
  const jn = await get(justNow.id);
  assert.strictEqual(jn.skips, undefined, "and the earlier slots of the sleep are not reported");
  assert.strictEqual(jn.history[jn.history.length - 1].catchUp, undefined, "it is an ordinary pass, not a catch-up");
  await sched.setEnabled(justNow.id, false);
  pass("wake: a time that passed less than 2 minutes ago is on time, not missed");

  // ── skip records: removal, cap, normalization ────────────────────────────
  const skipId = job.skips[0].id;
  await sched.deleteHistoryEntry(sleeper.id, skipId, job.skips[0].at);
  assert.deepStrictEqual((await get(sleeper.id)).skips, []);
  for (let i = 0; i < 35; i += 1) {
    await sched.appendSkip(sleeper.id, { reason: "precheck", detail: `n${i}` });
  }
  job = await get(sleeper.id);
  assert.strictEqual(job.skips.length, 30);
  assert.strictEqual(job.skips[0].detail, "n5", "the oldest skips are dropped first");
  pass("a skip row can be removed and the list is capped at 30");

  // The same skip again updates the newest row; a pass in between splits it.
  const repeat = await sched.createJob({ name: "repeat", trigger: yearly, input });
  const t0 = Date.now();
  const same = { reason: "precheck", detail: "Skipped: the precheck exited with code 1.", precheck: { command: "false", passed: false, exitCode: 1, timedOut: false, durationMs: 1, outputTail: "first" } };
  await sched.appendSkip(repeat.id, same, t0);
  await sched.appendSkip(repeat.id, { ...same, precheck: { ...same.precheck, outputTail: "second" } }, t0 + 1000);
  await sched.appendSkip(repeat.id, { ...same, precheck: { ...same.precheck, outputTail: "third" } }, t0 + 2000);
  job = await get(repeat.id);
  assert.strictEqual(job.skips.length, 1, "repeated skips share one row");
  assert.strictEqual(job.skips[0].repeats, 3);
  assert.strictEqual(job.skips[0].firstAt, iso(t0));
  assert.strictEqual(job.skips[0].at, iso(t0 + 2000));
  assert.strictEqual(job.skips[0].precheck.outputTail, "third", "the row keeps the latest output");
  const rowId = job.skips[0].id;
  await sched.appendSkip(repeat.id, { ...same, detail: "Skipped: the precheck exited with code 2." }, t0 + 3000);
  await sched.appendHistory(repeat.id, { runId: "r-between", iteration: 0, startedAt: iso(t0 + 4000), status: "done" }, {});
  await sched.appendSkip(repeat.id, { ...same, detail: "Skipped: the precheck exited with code 2." }, t0 + 5000);
  job = await get(repeat.id);
  assert.deepStrictEqual(job.skips.map((x) => x.repeats ?? 1), [3, 1, 1], "a different line or a pass in between starts a new row");
  await sched.deleteHistoryEntry(repeat.id, rowId, "an older time of the row");
  assert.strictEqual((await get(repeat.id)).skips.length, 2, "a skip row is removed by its id, whatever time the view had");
  await sched.deleteJob(repeat.id);
  pass("a repeated skip updates and counts its row instead of adding one");

  // Patches of different jobs at the same moment must all land (the catch-up
  // settles jobs in parallel, and loop drivers patch on their own).
  const a = await sched.createJob({ name: "a", trigger: yearly, input });
  const b = await sched.createJob({ name: "b", trigger: yearly, input });
  await Promise.all([
    sched.appendSkip(a.id, { reason: "precheck", detail: "a1" }),
    sched.appendSkip(b.id, { reason: "precheck", detail: "b1" }),
    sched.appendSkip(a.id, { reason: "precheck", detail: "a2" }),
    sched.appendHistory(b.id, { runId: "r1", iteration: 1, startedAt: iso(Date.now()), status: "done" }, {}),
  ]);
  assert.deepStrictEqual((await get(a.id)).skips.map((x) => x.detail), ["a1", "a2"]);
  assert.deepStrictEqual((await get(b.id)).skips.map((x) => x.detail), ["b1"]);
  assert.strictEqual((await get(b.id)).history.length, 1);
  await sched.deleteJob(a.id);
  await sched.deleteJob(b.id);
  pass("concurrent patches of different automations do not drop each other's writes");

  await sched.updateJob({
    id: sleeper.id,
    precheck: { command: "   " },
    missedRuns: { policy: "sometimes" },
  });
  job = await get(sleeper.id);
  assert.strictEqual(job.precheck, undefined, "an empty precheck is dropped");
  assert.strictEqual(job.missedRuns, undefined, "an unknown policy falls back to the default");
  await sched.updateJob({ id: sleeper.id, precheck: { command: "true", timeoutSeconds: 5 }, missedRuns: { policy: "runOnce", graceMinutes: 60 } });
  job = await get(sleeper.id);
  assert.deepStrictEqual(job.precheck, { command: "true", timeoutSeconds: 5 });
  assert.deepStrictEqual(job.missedRuns, { policy: "runOnce", graceMinutes: 60 });
  await sched.updateJob({ id: sleeper.id, precheck: null, missedRuns: null });
  job = await get(sleeper.id);
  assert.strictEqual(job.precheck, undefined, "null removes the precheck");
  assert.strictEqual(job.missedRuns, undefined, "null restores the default policy");
  pass("precheck and policy normalize on write; null removes them");

  // ── the precheck gate ─────────────────────────────────────────────────────
  if (process.platform === "win32") {
    console.log("  SKIP precheck gate cases (they run POSIX shell commands)");
    return;
  }
  const gated = await sched.createJob({
    name: "gated",
    trigger: yearly,
    input,
    precheck: { command: "echo nothing to do; exit 1" },
  });
  await loop.startIteration(gated.id, { source: "trigger" });
  job = await get(gated.id);
  assert.strictEqual(launchesFor(gated.id), 0, "a failed precheck starts no worker");
  assert.strictEqual(job.skips.length, 1);
  assert.strictEqual(job.skips[0].reason, "precheck");
  assert.strictEqual(job.skips[0].detail, "Skipped: the precheck exited with code 1.");
  assert.strictEqual(job.skips[0].precheck.outputTail, "nothing to do");
  assert.strictEqual(job.skips[0].precheck.command, "echo nothing to do; exit 1");
  assert.strictEqual(job.history.length, 0, "history keeps only real passes");
  await loop.startIteration(gated.id, { source: "trigger" });
  job = await get(gated.id);
  assert.strictEqual(job.skips.length, 1, "the same skip again counts on the same row");
  assert.strictEqual(job.skips[0].repeats, 2);
  pass("a trigger pass whose precheck fails is skipped and recorded with the output tail");

  await sched.runJobNow(gated.id);
  assert.strictEqual(launchesFor(gated.id), 1, "Run now never runs the precheck");
  pass("Run now bypasses the precheck");

  const open = await sched.createJob({
    name: "open",
    trigger: yearly,
    input,
    precheck: { command: 'sleep 0.3; test "$SPARK_AUTOMATION_ID" = "$EXPECTED_ID"' },
  });
  process.env.EXPECTED_ID = open.id;
  // Two fires at once: one check, one pass.
  await Promise.all([
    loop.startIteration(open.id, { source: "trigger" }),
    loop.startIteration(open.id, { source: "trigger" }),
  ]);
  assert.strictEqual(launchesFor(open.id), 1, "a passing precheck starts exactly one pass");
  assert.strictEqual((await get(open.id)).skips, undefined);
  // A live pass holds the next fire before any check runs.
  await loop.startIteration(open.id, { source: "trigger" });
  assert.strictEqual(launchesFor(open.id), 1);
  assert.strictEqual((await get(open.id)).skips, undefined, "a held fire is not a skip");
  pass("a passing precheck starts one pass; concurrent and held fires do not stack");

  // A cadence loop keeps its rhythm through skipped passes.
  const cadence = await sched.createJob({
    name: "cadence",
    trigger: { kind: "manual" },
    input,
    loop: { kind: "cadence", everyMs: 1000, stop: {} },
    precheck: { command: "exit 4" },
  });
  await sched.patchJob(cadence.id, (j) => ({ ...j, state: { status: "idle", iteration: 1 } }));
  await loop.startIteration(cadence.id, { source: "cadence" });
  job = await get(cadence.id);
  assert.strictEqual(job.skips.length, 1);
  assert.ok(job.state.nextFireAt, "the next cadence pass is scheduled");
  await sleep(1500);
  job = await get(cadence.id);
  assert.ok((job.skips[0].repeats ?? 1) >= 2, `the cadence re-checked on time (${job.skips[0].repeats ?? 1} skips)`);
  assert.strictEqual(job.state.iteration, 1, "skipped passes do not count as iterations");
  assert.strictEqual(launchesFor(cadence.id), 0);
  await sched.setEnabled(cadence.id, false);
  pass("a cadence loop re-schedules after a skipped pass and counts no iteration");

  // A cadence tick that lands on a trigger's check waits for its verdict; a
  // skip re-arms the cadence instead of leaving the loop waiting forever.
  const overlap = await sched.createJob({
    name: "overlap",
    trigger: { kind: "manual" },
    input,
    loop: { kind: "cadence", everyMs: 60_000, stop: {} },
    precheck: { command: "sleep 0.4; exit 4" },
  });
  await sched.patchJob(overlap.id, (j) => ({ ...j, state: { status: "idle", iteration: 1 } }));
  const triggerFire = loop.startIteration(overlap.id, { source: "trigger" });
  await sleep(100);
  await loop.startIteration(overlap.id, { source: "cadence" });
  await triggerFire;
  job = await get(overlap.id);
  assert.strictEqual(job.skips.length, 1, "one check ran, one skip");
  assert.ok(job.state.nextFireAt, "the cadence tick that waited on the check is re-armed");
  assert.strictEqual(launchesFor(overlap.id), 0);
  await sched.setEnabled(overlap.id, false);
  pass("a cadence tick during a trigger's failing check is re-armed, not lost");

  // The start check's catch-up pass goes through the precheck too.
  const both = await sched.createJob({
    name: "both",
    trigger: hourly,
    input,
    missedRuns: { policy: "runOnce" },
    precheck: { command: "exit 9" },
  });
  await backdate(both.id, 2 * HOUR);
  await sched.catchUpScheduledJobs("start");
  await sleep(1000);
  job = await get(both.id);
  assert.strictEqual(launchesFor(both.id), 0);
  assert.strictEqual(job.skips.length, 1);
  assert.strictEqual(job.skips[0].reason, "precheck");
  pass("a catch-up pass is gated by the precheck as well");
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-catchup-"));
  const home = path.join(tmp, "home");
  const workspace = path.join(tmp, "ws");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  process.env.SPARK_HOME_DIR = home;
  // The precheck runs a LOGIN shell; keep it off the developer's startup files.
  process.env.HOME = path.join(tmp, "user");
  fs.mkdirSync(process.env.HOME);
  process.env.SHELL = "/bin/sh";

  const mod = await bundle(tmp);
  pureChecks(mod.cu, mod.shared);
  await integrationChecks(mod, workspace);

  // Once the scheduler is stopped (quit), a late wake starts and records nothing.
  const late = await mod.sched.createJob({
    name: "after stop",
    trigger: { kind: "cron", expr: "0 * * * *" },
    input: { workspaceId: "ws", workspaceName: "test", cwd: workspace, initialUserNote: "x" },
    missedRuns: { policy: "runOnce" },
  });
  await mod.sched.patchJob(late.id, (j) => ({
    ...j,
    createdAt: iso(Date.now() - 10 * HOUR),
    scheduleCheckedAt: iso(Date.now() - 3 * HOUR),
  }));
  const launchesBefore = globalThis.__CU.launches.length;
  mod.sched.stopScheduler();
  await mod.sched.catchUpScheduledJobs("wake");
  await sleep(100);
  assert.strictEqual(globalThis.__CU.launches.length, launchesBefore, "no pass after the scheduler stopped");
  assert.strictEqual((await mod.sched.listJobs()).find((j) => j.id === late.id).skips, undefined);
  pass("a wake after the scheduler stopped starts and records nothing");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAll ${passed} automation catch-up checks PASSED.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nAUTOMATION CATCH-UP TEST FAILED:\n", err);
    process.exit(1);
  },
);
