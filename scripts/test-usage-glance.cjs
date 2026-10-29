#!/usr/bin/env node
"use strict";

// What the title bar's hairlines and the usage panel say about each limit,
// from src/renderer/src/components/usage/usage-glance.ts: the forecast in
// display terms ("ends around 35% at reset", "out 17:40", "not enough
// history yet"), which limit a hairline draws and its sentence, when the
// panel suggests another account, and which banked ChatGPT reset is spent
// and when spending one is off.

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

process.env.TZ = "Europe/Madrid";

const ROOT = path.resolve(__dirname, "..");
const result = esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/renderer/src/components/usage/usage-glance.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
  alias: { "@shared": path.join(ROOT, "src/shared") },
});
const shim = { exports: {} };
new Function("module", "exports", "require", result.outputFiles[0].text)(shim, shim.exports, require);
const glance = shim.exports;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Thursday 29 October 2026, 17:00 in Madrid.
const NOW = Date.parse("2026-10-29T16:00:00.000Z");
const at = (offset) => new Date(NOW + offset).toISOString();

function view(profileId, windowId, used, resetsAtMs, { end = used, hit = null, odds = hit === null ? 0.05 : 0.8, analogDays = 10, inUse = true } = {}) {
  return {
    key: `${profileId}|${windowId}`,
    profileId,
    provider: "anthropic",
    accountLabel: profileId,
    active: true,
    windowId,
    windowLabel: windowId,
    source: "live",
    calibration: { method: "readings", anchors: 10, spread: [1, 1], note: "" },
    learning: null,
    result: {
      nowMs: NOW,
      windowStartMs: resetsAtMs - 5 * HOUR,
      resetsAtMs,
      usedPercent: used,
      kind: "5h",
      observed: [],
      cone: [],
      endPercent: { p10: end, p50: end, p90: end },
      hitProbability: odds,
      growthQuantiles: [],
      hitAt: { p10: hit, p50: hit, p90: hit },
      pace: { recentPerHour: 1, usualPerHour: 1, ratio: 1 },
      analogDays,
      level: 1,
      inUse,
    },
    verdict: { tone: "calm", headline: "", detail: "" },
    nudge: null,
    goAhead: null,
  };
}

function win(id, label, usedPercent, resetsAt, scope) {
  return { id, label, usedPercent, remainingPercent: 100 - usedPercent, resetsAt, ...(scope ? { scope } : {}) };
}

// ── forecast to display ───────────────────────────────────────────────────
const reset = NOW + 3 * HOUR + 30 * MINUTE;
assert.deepEqual(glance.limitOutlook(view("p", "w", 0, reset, { end: 34.6 }), 0, true), { kind: "end", endPercent: 35 });
assert.deepEqual(
  glance.limitOutlook(view("p", "w", 82, reset, { hit: NOW + 40 * MINUTE }), 82, true),
  { kind: "out", atMs: NOW + 40 * MINUTE, earlyMs: 2 * HOUR + 50 * MINUTE },
);
// Running out is said only when it is more likely than not.
assert.deepEqual(
  glance.limitOutlook(view("p", "w", 60, reset, { hit: NOW + HOUR, odds: 0.4, end: 92 }), 60, true),
  { kind: "end", endPercent: 92 },
);
// A median end below what is used already never reads lower than now.
assert.deepEqual(glance.limitOutlook(view("p", "w", 50, reset, { end: 40 }), 50, true), { kind: "end", endPercent: 50 });
// Too little history: no window in the report, or no past day like today.
assert.deepEqual(glance.limitOutlook(null, 12, true), { kind: "no-history" });
assert.deepEqual(glance.limitOutlook(view("p", "w", 12, reset, { end: 40, analogDays: 0 }), 12, true), { kind: "no-history" });
assert.deepEqual(glance.limitOutlook(view("p", "w", 12, reset, { end: 40 }), 12, false), { kind: "off" });
assert.deepEqual(glance.limitOutlook(view("p", "w", 100, reset), 100, true), { kind: "used-up" });
assert.deepEqual(glance.limitOutlook(null, 100, false), { kind: "used-up" });
console.log("ok - the forecast reads as an end percent, a run-out time, or not enough history");

assert.equal(glance.limitTitle(win("a", "5-hour", 0)), "5-hour");
assert.equal(glance.limitTitle(win("a", "7-day", 0)), "Week");
assert.equal(glance.limitTitle(win("a", "Fable 7-day", 0)), "Fable week");
console.log("ok - limits are named 5-hour, Week and Fable week");

const usage = {
  profileId: "main",
  provider: "anthropic",
  label: "Main",
  isDefault: true,
  status: "ok",
  checkedAt: at(-MINUTE),
  windows: [
    win("five_hour", "5-hour", 82, new Date(reset).toISOString(), { kind: "general" }),
    win("seven_day", "7-day", 34, at(6 * DAY), { kind: "general" }),
    win("fable", "Fable 7-day", 12, at(6 * DAY), { kind: "model", modelLabel: "Fable" }),
    win("review", "Code review 7-day", 90, at(6 * DAY), { kind: "code_review" }),
  ],
};
const busyReport = {
  windows: [
    view("main", "five_hour", 82, reset, { hit: NOW + 40 * MINUTE }),
    view("main", "seven_day", 34, NOW + 6 * DAY, { end: 61 }),
  ],
};
const limits = glance.glanceLimits(usage, busyReport, true);
assert.deepEqual(
  limits.map((limit) => [limit.title, limit.outlook.kind, limit.risk]),
  [
    ["5-hour", "out", true],
    ["Week", "end", false],
    ["Fable week", "no-history", false],
  ],
);
assert.equal(glance.outlookEnd(limits[0]), 100);
assert.equal(glance.outlookEnd(limits[1]), 61);
assert.equal(glance.outlookEnd(limits[2]), null);
console.log("ok - the panel lists plan-wide and model limits, never the code-review quota");

// The hairline draws the limit that runs out first, else the highest end.
assert.equal(glance.hairlineLimit(limits).windowId, "five_hour");
const calmReport = {
  windows: [view("main", "five_hour", 0, reset, { end: 35 }), view("main", "seven_day", 1, NOW + 6 * DAY, { end: 24 })],
};
const calm = glance.glanceLimits(
  { ...usage, windows: [win("five_hour", "5-hour", 0, new Date(reset).toISOString()), win("seven_day", "7-day", 1, at(6 * DAY))] },
  calmReport,
  true,
);
assert.equal(glance.hairlineLimit(calm).windowId, "five_hour");
const off = glance.glanceLimits(
  { ...usage, windows: [win("five_hour", "5-hour", 10, new Date(reset).toISOString()), win("seven_day", "7-day", 30, at(6 * DAY))] },
  null,
  false,
);
assert.equal(glance.hairlineLimit(off).windowId, "seven_day");
assert.equal(glance.hairlineLimit([]), null);
assert.equal(
  glance.hairlineSentence("Claude · Main", limits[0], NOW),
  "Claude · Main runs out at 17:40, 2h 50m before the 5-hour limit resets.",
);
assert.equal(
  glance.hairlineSentence("Claude · Main", calm[0], NOW),
  "Claude · Main: 5-hour at 0%, ends around 35% when it resets at 20:30.",
);
assert.equal(
  glance.hairlineSentence("Claude · Main", limits[2], NOW),
  "Claude · Main: Fable week at 12% until Wed 17:00, not enough history yet to forecast.",
);
console.log("ok - a hairline draws the limit closest to running out and says so in one sentence");

// ── switching when a limit runs out ───────────────────────────────────────
const chip = (usedPercent, general = true) => ({ id: "c", label: "5h", usedPercent, general });
const account = (key, active, action, chips) => ({
  key,
  profileId: key,
  label: key,
  email: null,
  active,
  system: false,
  usage: null,
  chips,
  note: null,
  action,
  blocked: null,
});
const entry = {
  provider: "anthropic",
  active: account("Main", true, null, [chip(82)]),
  accounts: [
    account("Main", true, null, [chip(82)]),
    account("Main 2", false, "use", [chip(2), chip(1)]),
    account("Blocked", false, null, [chip(0)]),
    account("Tight", false, "use", [chip(90)]),
  ],
};
assert.deepEqual(
  (({ account: picked, leftPercent }) => [picked.label, leftPercent])(glance.switchSuggestion(entry, limits)),
  ["Main 2", 98],
);
assert.equal(glance.switchSuggestion(entry, calm), null, "no nudge while nothing runs out");
assert.equal(
  glance.switchSuggestion({ ...entry, accounts: [entry.accounts[0], entry.accounts[3]] }, limits),
  null,
  "no nudge when no other account has room",
);
console.log("ok - another account is suggested only when a limit runs out and it has room");

// ── ChatGPT's banked resets ───────────────────────────────────────────────
const credits = [
  { id: "later", expiresAt: at(8 * DAY + 7 * HOUR), grantedAt: at(-21 * DAY) },
  { id: "expired", expiresAt: at(-HOUR) },
  { id: "soon", expiresAt: at(2 * HOUR + 48 * MINUTE), grantedAt: at(-30 * DAY) },
];
assert.equal(glance.chooseResetCredit(credits, NOW).id, "soon");
assert.equal(glance.chooseResetCredit([{ id: "unknown" }, { id: "dated", expiresAt: at(DAY) }], NOW).id, "dated");
assert.equal(glance.chooseResetCredit([], NOW), null);
assert.equal(glance.chooseResetCredit(undefined, NOW), null);

const codex = (used, resetCredits) => ({
  profileId: "codex",
  provider: "openai-codex",
  label: "Account 1",
  isDefault: true,
  status: "ok",
  checkedAt: at(0),
  windows: [win("secondary", "7-day", used, at(5 * DAY))],
  resetCredits,
});
const idle = glance.planCodexReset(codex(0, { available: 2, applicable: 0, credits }), NOW);
assert.equal(idle.count, 2);
assert.deepEqual(idle.credits.map((credit) => [credit.id, credit.soon]), [["soon", true], ["later", false]]);
assert.equal(idle.next.id, "soon");
assert.equal(idle.canUse, false);
assert.equal(idle.why, "Nothing to reset yet: the week is at 0%. The one expiring today may lapse unused.");
const refused = glance.planCodexReset(codex(40, { available: 2, applicable: 0, credits }), NOW);
assert.equal(refused.canUse, false);
assert.equal(refused.why, "ChatGPT says none can be used right now. The one expiring today may lapse unused.");
const busy = glance.planCodexReset(codex(91, { available: 2, applicable: 2, credits }), NOW);
assert.equal(busy.canUse, true);
assert.equal(busy.why, null);
assert.equal(busy.next.id, "soon");
// Without an applicable count, a reset is worth spending once a window has use.
assert.equal(glance.planCodexReset(codex(30, { available: 1, credits }), NOW).canUse, true);
assert.equal(glance.planCodexReset(codex(0, { available: 1, credits }), NOW).canUse, false);
assert.equal(glance.planCodexReset(codex(30, { available: 0 }), NOW), null);
// Only the count and the soonest expiry were read (the list fetch failed):
// one entry, no id, and nothing can be spent, because a spend must name the
// reset that expires first.
const unlisted = glance.planCodexReset(codex(91, { available: 2, applicable: 2, nextExpiresAt: at(3 * DAY) }), NOW);
assert.deepEqual(unlisted.credits.map((credit) => credit.id), [null]);
assert.equal(unlisted.canUse, false);
assert.equal(unlisted.why, "Codara could not read which reset expires first. Try again in a moment.");
assert.equal(glance.planCodexReset(codex(91, { available: 2, applicable: 2 }), NOW).canUse, false);
// The earliest reset has no usable id: no falling back to a later one.
for (const id of [undefined, "", "has space"]) {
  const plan = glance.planCodexReset(
    codex(91, { available: 2, applicable: 2, credits: [{ id, expiresAt: at(HOUR) }, { id: "later", expiresAt: at(DAY * 3) }] }),
    NOW,
  );
  assert.equal(plan.next.id, null);
  assert.equal(plan.canUse, false);
}
console.log("ok - Use a reset is off unless the reset that expires first has an id");
assert.deepEqual(glance.resetConfirmWords(busy, codex(91), "ChatGPT", NOW), {
  question: "Use 1 of 2 resets now?",
  detail: "ChatGPT's weekly limit goes from 91% back to 0%. The reset expiring today 19:48 goes first. This can't be undone.",
});
assert.equal(glance.expiryWords(NOW + 8 * DAY + 7 * HOUR + 20 * MINUTE, NOW), "Sat 7 Nov, 00:20");
assert.equal(glance.expiryWords(NOW + 16 * HOUR, NOW), "tomorrow 09:00");
console.log("ok - the reset that expires first is spent, and Use a reset is off with a reason when none applies");

// ── What the confirm spends ───────────────────────────────────────────────
const busyUsage = codex(91, { available: 2, applicable: 2, credits });
const captured = glance.resetTarget("codex", busyUsage, NOW);
assert.deepEqual(captured, { profileId: "codex", creditId: "soon" });
assert.equal(glance.sameResetTarget(captured, glance.resetTarget("codex", busyUsage, NOW + MINUTE)), true);
// The account switched while the confirm was open.
assert.equal(glance.sameResetTarget(captured, glance.resetTarget("codex-2", busyUsage, NOW)), false);
assert.equal(glance.sameResetTarget(captured, glance.resetTarget(null, busyUsage, NOW)), false);
// The captured reset expired: the next one is a different target.
const afterExpiry = glance.resetTarget("codex", busyUsage, NOW + 3 * HOUR);
assert.deepEqual(afterExpiry, { profileId: "codex", creditId: "later" });
assert.equal(glance.sameResetTarget(captured, afterExpiry), false);
// A refresh replaced the list, lost it, or made none applicable.
const refreshed = codex(91, { available: 2, applicable: 2, credits: [{ id: "new", expiresAt: at(HOUR) }, ...credits] });
assert.equal(glance.sameResetTarget(captured, glance.resetTarget("codex", refreshed, NOW)), false);
assert.equal(glance.resetTarget("codex", codex(91, { available: 2, applicable: 2, nextExpiresAt: at(DAY) }), NOW), null);
assert.equal(glance.resetTarget("codex", codex(91, { available: 2, applicable: 0, credits }), NOW), null);
assert.equal(glance.sameResetTarget(null, null), false);
console.log("ok - the confirm keeps the account and reset it opened for, and any change is a different target");
