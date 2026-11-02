// Pure unit tests for what the Automations inbox says about a job
// (src/renderer/src/components/automations/inbox-model.ts): its shelf, the
// plain sentence, the next run, the bar of recent runs and the month so far.
//
//   node scripts/test-automation-inbox.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const ENTRY = path.join(ROOT, "src", "renderer", "src", "components", "automations", "inbox-model.ts");

const NOW = new Date(2026, 10, 18, 15, 40, 0).getTime(); // Wed Nov 18 2026, 15:40 local

function job(over = {}) {
  return {
    id: "job-1",
    name: "Sample job",
    trigger: { kind: "manual" },
    enabled: true,
    input: { workspaceId: "ws", workspaceName: "sample-repo", cwd: "/tmp/sample-repo", initialUserNote: "", chatMode: "execute" },
    loop: { kind: "once", stop: {} },
    prompt: { template: "" },
    worker: { model: "claude-opus-5", effort: "medium" },
    graph: {
      version: 1,
      nodes: [{ id: "w0", kind: "worker", label: "Worker", prompt: "", worker: { model: "claude-opus-5", effort: "medium" } }],
      edges: [],
      entryNodeIds: ["w0"],
    },
    state: { status: "idle", iteration: 0 },
    history: [],
    createdAt: new Date(NOW - 30 * 86_400_000).toISOString(),
    ...over,
  };
}

function rec(over = {}) {
  const startedAt = over.startedAt ?? new Date(NOW - 3_600_000).toISOString();
  return {
    iteration: 0,
    runId: `run-${startedAt}`,
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + 600_000).toISOString(),
    status: "complete",
    costUsd: 0.5,
    measuredCostUsd: 0.5,
    ...over,
  };
}

const steps = {
  version: 1,
  nodes: [
    { id: "a", kind: "step", label: "A", action: { type: "command", command: "echo a" } },
    { id: "b", kind: "step", label: "B", action: { type: "command", command: "echo b" } },
  ],
  edges: [{ from: "a", to: "b" }],
  entryNodeIds: ["a"],
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-automation-inbox-"));
  const outfile = path.join(tmp, "inbox.bundle.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "shared-alias",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  const m = require(outfile);
  const sentence = (j, names) => m.plainSentence(j, names).map((p) => p.text).join("");
  const strong = (j) => m.plainSentence(j).filter((p) => p.strong).map((p) => p.text);

  // Shelves: what needs you first; a switched-off job leaves Failed.
  assert.equal(m.inboxGroup(job({ state: { status: "blocked", iteration: 1 } })), "needs");
  assert.equal(m.inboxGroup(job({ state: { status: "running", iteration: 1 } })), "running");
  assert.equal(m.inboxGroup(job({ state: { status: "paused", iteration: 1 } })), "paused");
  assert.equal(m.inboxGroup(job()), "scheduled");
  assert.equal(m.inboxGroup(job({ history: [rec({ status: "failed" })] })), "failed");
  assert.equal(m.inboxGroup(job({ history: [rec({ stopReason: "budget" })] })), "failed");
  assert.equal(m.inboxGroup(job({ history: [rec({ status: "cancelled", stopReason: "user-stop" })] })), "scheduled");
  assert.equal(m.inboxGroup(job({ history: [rec({ status: "failed" }), rec()] })), "scheduled", "a later good run clears it");
  assert.equal(m.inboxGroup(job({ enabled: false, history: [rec({ status: "failed" })] })), "paused");
  assert.equal(m.inboxGroup(job({ enabled: false, state: { status: "blocked", iteration: 1 } })), "needs", "a question outranks the switch");

  // Plain schedules.
  const cron = (expr, tz) => m.plainSchedule({ kind: "cron", expr, ...(tz ? { tz } : {}) });
  assert.equal(cron("* * * * *"), "Every minute");
  assert.equal(cron("*/15 * * * *"), "Every 15 minutes");
  assert.equal(cron("0 * * * *"), "Every hour");
  assert.equal(cron("30 * * * *"), "Every hour at :30");
  assert.equal(cron("0 */2 * * *"), "Every 2 hours");
  assert.equal(cron("0 3 * * *"), "Every day at 03:00");
  assert.equal(cron("0 2 * * 1-5"), "Every weekday at 02:00");
  assert.equal(cron("0 2 * * MON-FRI"), "Every weekday at 02:00");
  assert.equal(cron("0 9 * * 1"), "Mondays at 09:00");
  assert.equal(cron("0 9 * * 1,3"), "Mondays and Wednesdays at 09:00");
  assert.equal(cron("0 9 * * 7"), "Sundays at 09:00");
  assert.equal(cron("0 9 * * 0,6"), "Every weekend day at 09:00");
  assert.equal(cron("0 9 * * 0-7"), "Every day at 09:00", "a range ending in 7 still covers every day in it");
  assert.equal(cron("0 9 * * 5-7"), "Sundays, Fridays and Saturdays at 09:00");
  assert.equal(cron("0 9 * * 6-7"), "Every weekend day at 09:00");
  {
    const { Cron } = require("croner");
    const names = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
    for (const field of ["0-7", "5-7", "6-7", "1-5", "7", "0", "0,7", "1,7", "SUN-SAT", "MON-FRI", "2-3"]) {
      const job = new Cron(`0 9 * * ${field}`, { paused: true, timezone: "UTC" });
      const firing = new Set();
      let at = new Date("2026-01-01T00:00:00Z");
      for (let i = 0; i < 21; i += 1) {
        const next = job.nextRun(at);
        if (!next) break;
        firing.add(next.getUTCDay());
        at = next;
      }
      const phrase = cron(`0 9 * * ${field}`);
      const expected = [...firing].sort((a, b) => a - b);
      const said = expected.length === 7
        ? phrase === "Every day at 09:00"
        : expected.join() === "1,2,3,4,5"
          ? phrase === "Every weekday at 09:00"
          : expected.join() === "0,6"
            ? phrase === "Every weekend day at 09:00"
            : expected.every((d) => phrase.includes(names[d])) && names.filter((n) => phrase.includes(n)).length === expected.length;
      assert.ok(said, `"${field}" fires on ${expected} but reads "${phrase}"`);
    }
  }
  assert.equal(cron("0 9 1 * *"), "Day 1 of every month at 09:00");
  assert.equal(cron("0 3 * * *", "Europe/Madrid"), "Every day at 03:00 (Europe/Madrid)");
  assert.equal(cron("* * * * * *"), "Every second");
  assert.equal(cron("*/30 * * * * *"), "Every 30 seconds");
  assert.equal(cron("*/45 * * * *"), "On a schedule: */45 * * * *", "a step that restarts each hour is not a fixed interval");
  assert.equal(cron("0 */5 * * *"), "On a schedule: 0 */5 * * *");
  assert.equal(cron("*/45 * * * * *"), "On a schedule: */45 * * * * *");
  assert.equal(cron("*/0 * * * *"), "On a schedule: */0 * * * *");
  assert.equal(cron("0 9 * 1 *"), "On a schedule: 0 9 * 1 *", "an unread shape shows the expression");
  assert.equal(cron("*/5 9-17 * * 1-5"), "On a schedule: */5 9-17 * * 1-5");
  assert.equal(cron("not a cron"), "On a schedule: not a cron");
  assert.equal(m.plainSchedule({ kind: "interval", everyMs: 900_000 }), "Every 15 min");
  assert.equal(m.plainSchedule({ kind: "interval", everyMs: 3_600_000 }), "Every hour");
  assert.equal(m.plainSchedule({ kind: "interval", everyMs: 7_200_000 }), "Every 2 hours");
  assert.equal(m.plainSchedule({ kind: "interval", everyMs: 45_000 }), "Every 45 seconds");
  assert.equal(m.plainSchedule({ kind: "interval", everyMs: 90_000 }), "Every 90 seconds");
  assert.equal(
    m.plainSchedule({ kind: "folder", path: "/tmp/in/box", events: ["add", "change"], glob: "*.csv" }),
    "When a *.csv file is added or changes in box",
  );
  assert.equal(m.plainSchedule({ kind: "manual" }), "Only when you run it");
  assert.equal(m.plainSchedule({ kind: "continuous" }), "Back to back");
  const names = new Map([["job-2", "Release notes"]]);
  assert.equal(m.plainSchedule({ kind: "onFinishOf", automationId: "job-2" }, names), "After Release notes finishes");
  assert.equal(m.plainSchedule({ kind: "onFinishOf", automationId: "gone" }, names), "After another automation finishes");
  assert.equal(m.plainSchedule({ kind: "git", events: ["remoteUpdated"], branch: "main" }), "On every push on main");
  assert.equal(m.plainSchedule({ kind: "git", events: ["remoteUpdated", "localBranchMoved"] }), "On every push, commit or pull");
  assert.equal(m.plainSchedule({ kind: "onAutomationActivity", events: ["failed"] }), "When any automation fails");
  assert.equal(m.plainSchedule({ kind: "github", events: ["prOpened"] }), "When a pull request is opened");
  assert.equal(m.plainSchedule({ kind: "github", events: ["ciFailed"], branch: "main" }), "When CI fails on a pull request into main");
  assert.equal(
    m.plainSchedule({ kind: "github", events: ["prOpened", "ciFailed"] }),
    "When a pull request is opened or CI fails on a pull request",
  );
  assert.equal(
    m.plainSchedule({ kind: "onAutomationActivity", events: ["finished", "failed"], automationId: "job-2" }, names),
    "When Release notes finishes or fails",
  );

  // The sentence names the model, the place and the money.
  assert.equal(sentence(job()), "When you run it, Opus 5 works in sample-repo.");
  assert.deepEqual(strong(job()), ["Opus 5", "sample-repo"]);
  const capped = job({
    trigger: { kind: "cron", expr: "0 2 * * 1-5" },
    loop: { kind: "until", stop: { untilTestsPass: true, budgetUsd: 2, maxIterations: 5 } },
  });
  assert.equal(sentence(capped), "Every weekday at 02:00, Opus 5 works in sample-repo, until the tests pass, stopping at $2.00 or 5 runs.");
  assert.deepEqual(strong(capped), ["Opus 5", "sample-repo", "$2.00"]);
  assert.equal(
    sentence(job({ trigger: { kind: "cron", expr: "0 6 * * *" }, graph: steps })),
    "Every day at 06:00, 2 steps run in sample-repo. No AI.",
  );
  assert.equal(
    sentence(job({ trigger: { kind: "continuous" }, loop: { kind: "agent", stop: {} } })),
    "Back to back, Opus 5 works in sample-repo, until it says it is done.",
  );

  assert.equal(
    sentence(job({ trigger: { kind: "continuous" }, loop: { kind: "continuous", stop: { maxIterations: 20 } } })),
    "Back to back, Opus 5 works in sample-repo, stopping at 20 runs.",
    "a continuous loop does not stop when the agent says so",
  );

  // Next run: cron and a parked cadence loop; nothing when paused or unknowable.
  const next = m.nextRunAt(job({ trigger: { kind: "cron", expr: "0 2 * * 1-5" } }), NOW);
  assert.equal(next, new Date(2026, 10, 19, 2, 0, 0).getTime());
  assert.equal(m.nextRunAt(job({ enabled: false, trigger: { kind: "cron", expr: "0 2 * * *" } }), NOW), null);
  assert.equal(m.nextRunAt(job({ trigger: { kind: "cron", expr: "garbage" } }), NOW), null, "a bad expression never throws");
  assert.equal(m.nextRunAt(job({ trigger: { kind: "interval", everyMs: 60_000 } }), NOW), null);
  const parkedAt = new Date(NOW + 60_000).toISOString();
  assert.equal(m.nextRunAt(job({ state: { status: "idle", iteration: 1, nextFireAt: parkedAt } }), NOW), NOW + 60_000);

  // The row's word and line.
  assert.deepEqual(m.statusWord(job({ state: { status: "blocked", iteration: 1 } }), NOW), { word: "Needs you", tone: "danger" });
  assert.deepEqual(
    m.statusWord(job({ history: [rec({ status: "failed", startedAt: new Date(2026, 10, 18, 2, 0).toISOString(), finishedAt: new Date(2026, 10, 18, 2, 38).toISOString() })] }), NOW),
    { word: "Failed 02:38", tone: "danger" },
  );
  assert.deepEqual(
    m.statusWord(job({ state: { status: "running", iteration: 1 }, history: [rec({ status: "running", startedAt: new Date(NOW - 180_000).toISOString(), finishedAt: undefined })] }), NOW),
    { word: "Running 3m", tone: "info" },
  );
  assert.deepEqual(m.statusWord(job({ state: { status: "running", iteration: 1 } }), NOW), { word: "Running", tone: "info" });
  assert.deepEqual(m.statusWord(job({ enabled: false }), NOW), { word: "Paused", tone: "quiet" });
  assert.deepEqual(m.statusWord(job({ state: { status: "paused", iteration: 1 } }), NOW), { word: "On hold", tone: "quiet" });
  assert.deepEqual(m.statusWord(job(), NOW), { word: "Ready", tone: "quiet" });
  assert.deepEqual(m.statusWord(job({ trigger: { kind: "cron", expr: "0 16 * * *" } }), NOW), { word: "16:00", tone: "quiet" });
  assert.equal(m.rowSchedule(job({ trigger: { kind: "cron", expr: "0 16 * * *" } }), NOW), "Every day at 16:00 · next in 20m");
  assert.equal(m.rowSchedule(job({ enabled: false, trigger: { kind: "cron", expr: "0 16 * * *" } }), NOW), "Every day at 16:00");

  // Shelves in order, soonest scheduled first, created order elsewhere.
  const shelves = m.groupJobs(
    [
      job({ id: "later", trigger: { kind: "cron", expr: "0 18 * * *" } }),
      job({ id: "unknown" }),
      job({ id: "soon", trigger: { kind: "cron", expr: "0 16 * * *" } }),
      job({ id: "off", enabled: false }),
      job({ id: "ask", state: { status: "blocked", iteration: 1 } }),
    ],
    NOW,
  );
  assert.deepEqual(shelves.map((s) => s.id), ["needs", "scheduled", "paused"]);
  assert.deepEqual(shelves[1].jobs.map((j) => j.id), ["soon", "later", "unknown"]);

  // Recent runs: runs and skips in time order, the newest kept.
  const t = (mins) => new Date(NOW - mins * 60_000).toISOString();
  const recent = m.recentRuns(
    job({
      history: [rec({ startedAt: t(40) }), rec({ startedAt: t(20), status: "failed" }), rec({ startedAt: t(5), status: "running", finishedAt: undefined })],
      skips: [{ id: "s1", at: t(30), reason: "precheck", detail: "no" }],
    }),
    3,
    NOW,
  );
  assert.deepEqual(recent.map((r) => r.mark), ["skipped", "failed", "running"]);
  assert.match(recent[1].label, /^Today \d\d:\d\d: failed$/);
  assert.equal(m.recentRunsLabel(recent), "Last 3 runs, 1 failed, 1 skipped");

  // The month: only this month counts, money is marked as an estimate.
  const lastMonth = new Date(2026, 9, 30).toISOString();
  const totals = m.monthTotals(
    job({
      history: [
        rec({ startedAt: lastMonth, costUsd: 100 }),
        rec({ startedAt: new Date(2026, 10, 2).toISOString(), costUsd: 1, measuredCostUsd: 1 }),
        rec({ startedAt: new Date(2026, 10, 3).toISOString(), costUsd: 2, measuredCostUsd: 0, status: "failed", finishedAt: new Date(2026, 10, 3, 0, 30).toISOString() }),
        rec({ startedAt: new Date(2026, 10, 4).toISOString(), status: "running", finishedAt: undefined, costUsd: 0, measuredCostUsd: 0 }),
      ],
    }),
    NOW,
  );
  assert.equal(totals.runs, 3);
  assert.equal(totals.failed, 1);
  assert.equal(totals.costUsd, 3);
  assert.equal(totals.estimated, true);
  assert.equal(totals.typicalMs, (600_000 + 1_800_000) / 2, "the median ignores runs still going");
  assert.equal(totals.partial, false);
  assert.deepEqual(m.monthStats(job(), NOW), ["No runs this month"]);
  assert.deepEqual(m.monthStats(job({ history: [rec()] }), NOW), ["1 run this month", "$0.50", "10m typical"]);
  assert.deepEqual(
    m.monthStats(job({ graph: steps, history: [rec({ costUsd: 0, measuredCostUsd: 0 })] }), NOW),
    ["1 run this month", "free", "10m typical"],
  );

  // A full history that is all this month: the numbers are a floor, and say so.
  const full = Array.from({ length: 50 }, (_, i) => rec({ startedAt: new Date(NOW - i * 60_000).toISOString(), runId: `r${i}`, costUsd: 0.1, measuredCostUsd: 0.1 }));
  assert.equal(m.monthTotals(job({ history: full }), NOW).partial, true);
  assert.equal(m.monthStats(job({ history: full }), NOW)[0], "50+ runs this month");
  const reaching = [rec({ startedAt: lastMonth }), ...full.slice(1)];
  assert.equal(m.monthTotals(job({ history: reaching }), NOW).partial, false, "history reaching last month saw the whole month");

  // The result card.
  const none = m.resultCard(job({ trigger: { kind: "cron", expr: "0 16 * * *" } }), NOW);
  assert.equal(none.headline, "Not run yet");
  assert.match(none.body, /^It starts by itself today \d\d:\d\d\./);
  assert.match(m.resultCard(job({ enabled: false }), NOW).body, /paused/);
  const failed = m.resultCard(job({ history: [rec({ stopReason: "budget", summary: " Fixed one test. \n" })] }), NOW);
  assert.equal(failed.headline, "Stopped: budget reached");
  assert.equal(failed.body, "Fixed one test.");
  assert.equal(failed.failed, true);
  assert.ok(failed.runId);
  const done = m.resultCard(job({ history: [rec({ stopReason: "once", iteration: 2, catchUp: { scheduledFor: t(60), missedCount: 2 } })] }), NOW);
  assert.equal(done.headline, "Done");
  assert.match(done.body, /without leaving a summary/);
  assert.deepEqual(done.facts.slice(1), ["10m", "$0.50", "try 3", "caught up"]);
  assert.equal(m.resultCard(job({ history: [rec({ status: "cancelled", stopReason: "user-stop" })] }), NOW).headline, "Stopped by you");
  assert.equal(m.resultCard(job({ state: { status: "paused", iteration: 1 }, history: [rec()] }), NOW).headline, "On hold");
  assert.equal(m.resultCard(job({ history: [rec({ status: "running", finishedAt: undefined })] }), NOW).headline, "Did not finish");
  assert.equal(m.resultCard(job({ graph: steps, history: [rec({ costUsd: 0, measuredCostUsd: 0 })] }), NOW).facts[2], "free");

  // Time words.
  assert.match(m.fmtWhen(NOW - 3_600_000, NOW), /^Today \d\d:\d\d$/);
  assert.match(m.fmtWhen(NOW - 86_400_000, NOW), /^Yesterday \d\d:\d\d$/);
  assert.match(m.fmtWhen(NOW + 86_400_000, NOW), /^Tomorrow \d\d:\d\d$/);
  assert.equal(m.fmtWhen(undefined, NOW), "");
  assert.equal(m.fmtWhen("not a date", NOW), "");
  assert.equal(m.fmtSpan(45_000), "45s");
  assert.equal(m.fmtSpan(38 * 60_000), "38m");
  assert.equal(m.fmtSpan(125 * 60_000), "2h 5m");
  assert.equal(m.fmtSpan(72 * 3_600_000), "3d");
  assert.equal(m.fmtSpan(-5), "0s");

  // The prompt for Cora carries the name, the run and a bounded summary.
  const prompt = m.fixWithCoraPrompt(job({ name: "Nightly", history: [rec({ runId: "run-9", status: "failed", summary: "x".repeat(2000) })] }));
  assert.match(prompt, /^My automation "Nightly" failed \(run run-9\)\. Find out why and fix it\./);
  assert.ok(prompt.length < 1000);
  assert.equal(m.fixWithCoraPrompt(job({ name: "Empty" })), 'My automation "Empty" failed. Find out why and fix it.');

  // A message for a draft chat only reaches that workspace's draft, once.
  const prefillOut = path.join(tmp, "prefill.bundle.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "renderer", "src", "components", "chat", "composer", "pending-prefill.ts")],
    outfile: prefillOut,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const prefill = require(prefillOut);
  assert.equal(prefill.consumeDraftPrefill("ws-a:draft"), null);
  prefill.requestDraftPrefill("ws-a", "hello", 1_000);
  assert.equal(prefill.consumeDraftPrefill("ws-b:draft", 1_001), null, "another workspace never takes it");
  assert.equal(prefill.consumeDraftPrefill("ws-ab:draft", 1_001), null, "a longer id is another workspace");
  assert.equal(prefill.consumeDraftPrefill(undefined, 1_001), null);
  assert.equal(prefill.consumeDraftPrefill("ws-a:draft", 1_002), "hello");
  assert.equal(prefill.consumeDraftPrefill("ws-a:draft", 1_003), null, "taken once");
  prefill.requestDraftPrefill("ws-a", "stale", 1_000);
  assert.equal(prefill.consumeDraftPrefill("ws-a:draft", 1_000 + 16_000), null, "an abandoned hand-off expires");

  // A limit holding it back puts it on Needs you, and the card says why.
  {
    const thisMonth = new Date(NOW - 3_600_000).toISOString();
    const capped = job({ guard: { monthlyCapUsd: 20 }, monthSpend: { month: "2026-11", costUsd: 21, measuredCostUsd: 0 }, history: [rec({ startedAt: thisMonth, costUsd: 21 })] });
    assert.equal(m.inboxGroup(capped, NOW), "needs");
    assert.equal(m.statusWord(capped, NOW).word, "Needs you");
    assert.equal(m.resultCard(capped, NOW).headline, "Monthly cap reached");
    assert.match(m.resultCard(capped, NOW).body, /\$21\.00 of its \$20\.00 cap/);
    assert.ok(m.monthStats(capped, NOW).some((stat) => stat.includes("$21.00 of $20.00 cap")));
    // Under the cap, next month, switched off or mid-run: not held back.
    const under = { ...capped, guard: { monthlyCapUsd: 50 } };
    assert.equal(m.inboxGroup(under, NOW), "scheduled");
    const nextMonth = new Date(2026, 11, 2).getTime();
    assert.equal(m.guardHold(capped, nextMonth), null);
    assert.equal(m.inboxGroup({ ...capped, enabled: false }, NOW), "paused");
    assert.equal(m.inboxGroup({ ...capped, state: { status: "running", iteration: 1 } }, NOW), "running");

    const paused = job({ guard: { pauseAfterFailures: 3 }, autoPaused: { at: thisMonth, failures: 3 }, state: { status: "paused", iteration: 0 }, history: [rec({ status: "failed" })] });
    assert.equal(m.inboxGroup(paused, NOW), "needs");
    assert.equal(m.resultCard(paused, NOW).headline, "Paused after 3 failed runs");
    assert.match(m.resultCard(paused, NOW).body, /until you resume it/);
    const once = { ...paused, autoPaused: { at: thisMonth, failures: 1 } };
    assert.equal(m.resultCard(once, NOW).headline, "Paused after 1 failed run");
    // The user's own pause stays quiet.
    assert.equal(m.inboxGroup(job({ state: { status: "paused", iteration: 1 } }), NOW), "paused");
    // The tally answers for the whole month even when the runs are a floor.
    const busy = Array.from({ length: 50 }, (_, i) => rec({ runId: `r${i}`, startedAt: new Date(NOW - i * 60_000).toISOString(), costUsd: 1 }));
    const whole = job({ history: busy, monthSpend: { month: "2026-11", costUsd: 80, measuredCostUsd: 80 } });
    const stats = m.monthStats(whole, NOW);
    assert.ok(stats.includes("50+ runs this month"));
    assert.ok(stats.includes("$80.00"), "the cost needs no plus sign");
  }

  console.log("automation inbox model: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
