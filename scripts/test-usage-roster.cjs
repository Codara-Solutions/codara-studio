#!/usr/bin/env node
"use strict";

// What the title bar's Usage panel shows, from the pure model in
// src/renderer/src/components/usage/usage-roster.ts: row order, the chips each
// row draws, the active account and every other one with its email, what a
// switch does, and the copy for resets, credits and countdowns.

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const result = esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/renderer/src/components/usage/usage-roster.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
  alias: { "@shared": path.join(ROOT, "src/shared") },
});
const shim = { exports: {} };
new Function("module", "exports", "require", result.outputFiles[0].text)(
  shim,
  shim.exports,
  require,
);
const roster = shim.exports;

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const HOUR = 3_600_000;

function win(id, label, usedPercent, extra = {}) {
  return { id, label, usedPercent, remainingPercent: 100 - usedPercent, ...extra };
}

function usageProfile(profileId, provider, label, isDefault, windows, extra = {}) {
  return {
    profileId,
    provider,
    label,
    isDefault,
    status: "ok",
    windows,
    checkedAt: at(-2 * 60_000),
    ...extra,
  };
}

function row(id, provider, label, isDefault, extra = {}) {
  return {
    id,
    provider,
    label,
    isDefault,
    connected: true,
    expired: false,
    canRefresh: true,
    expiresAt: null,
    coraHalf: "linked",
    cliProfileId: `cli-${id}`,
    terminal: { connected: true, expired: false, canRefresh: true },
    ...extra,
  };
}

// ── window names ──────────────────────────────────────────────────────────
assert.equal(roster.windowChipLabel(win("a", "5-hour", 1)), "5h");
assert.equal(roster.windowChipLabel(win("a", "7-day", 1)), "wk");
assert.equal(roster.windowChipLabel(win("a", "14-day", 1)), "2w");
assert.equal(
  roster.windowChipLabel(
    win("a", "Fable 7-day", 1, { scope: { kind: "model", modelLabel: "Fable" } }),
  ),
  "Fable",
);
assert.equal(
  roster.windowChipLabel(win("a", "Code review 7-day", 1, { scope: { kind: "code_review" } })),
  null,
);
assert.equal(roster.windowTitle(win("a", "5-hour", 1)), "Session");
assert.equal(roster.windowTitle(win("a", "7-day", 1)), "Weekly");
assert.equal(
  roster.windowTitle(win("a", "Fable 7-day", 1, { scope: { kind: "model", modelLabel: "Fable" } })),
  "Fable weekly",
);
console.log("ok - windows are named 5h, wk and by model, Session and Weekly in full");

// ── countdowns ────────────────────────────────────────────────────────────
assert.equal(roster.formatResetDuration(47 * 60_000 + 30_000), "47m");
assert.equal(roster.formatResetDuration(20_000), "1m");
assert.equal(roster.formatResetDuration(3 * HOUR + 54 * 60_000), "3h 54m");
assert.equal(roster.formatResetDuration(2 * HOUR), "2h");
assert.equal(roster.formatResetDuration(6 * 24 * HOUR + 7 * HOUR + 59 * 60_000), "6d 7h");
assert.equal(roster.formatResetDuration(-5), "now");
assert.equal(roster.formatResetsIn(at(2 * HOUR + 14 * 60_000), NOW), "Resets in 2h 14m");
assert.equal(roster.formatResetsIn(at(-1000), NOW), "Resets now");
assert.equal(roster.formatResetsIn(undefined, NOW), null);
assert.equal(roster.formatUpdatedAgo(at(-20_000), NOW), "Updated just now");
assert.equal(roster.formatUpdatedAgo(at(-2 * 60_000), NOW), "Updated 2m ago");
assert.equal(roster.formatUpdatedAgo(at(-3 * HOUR), NOW), "Updated 3h ago");
assert.equal(roster.formatUpdatedAgo("garbage", NOW), null);
console.log("ok - countdowns and freshness read in plain units");

// ── plans, credits and resets ─────────────────────────────────────────────
assert.equal(roster.formatPlan("plus"), "Plus");
assert.equal(roster.formatPlan("chatgpt_business"), "ChatGPT Business");
assert.equal(roster.formatPlan(""), null);
assert.deepEqual(roster.describeCredits({ kind: "balance", balance: 1234.5, unlimited: false }), {
  title: "Credits",
  line: "1,234.5 credits available",
  usedPercent: null,
});
assert.equal(
  roster.describeCredits({ kind: "balance", balance: 0, unlimited: true }).line,
  "Unlimited credits",
);
assert.deepEqual(
  roster.describeCredits({ kind: "spend", currency: "USD", spent: 12.5, limit: 50, usedPercent: 25 }),
  { title: "Extra Usage", line: "$12.50 of $50.00 spent", usedPercent: 25 },
);
assert.equal(
  roster.describeCredits({ kind: "spend", currency: "EUR", spent: 3, limit: null, usedPercent: null })
    .line,
  "€3.00 spent, no cap",
);
assert.equal(roster.describeCredits(undefined), null);

const codex = (extra) =>
  usageProfile("c1", "openai-codex", "Work", true, [win("p", "5-hour", 12)], extra);
assert.equal(roster.describeResetCredits(codex({ resetCredits: { available: 0 } }), NOW), null);
assert.deepEqual(
  roster.describeResetCredits(
    codex({ resetCredits: { available: 2, nextExpiresAt: at(3 * 24 * HOUR + 4 * HOUR) } }),
    NOW,
  ),
  { count: 2, line: "2 rate-limit resets available", expiry: "Next expires in 3d 4h" },
);
assert.deepEqual(
  roster.describeResetCredits(codex({ resetCredits: { available: 1 } }), NOW),
  { count: 1, line: "1 rate-limit reset available", expiry: null },
);
assert.equal(
  roster.describeResetCredits(
    codex({ resetCredits: { available: 1, nextExpiresAt: at(50 * 60_000) } }),
    NOW,
  ).expiry,
  "Expires in 50m",
);
// A reset is only worth spending once a plan-wide window has use on it.
assert.equal(roster.resetWorthSpending(codex({})), true);
assert.equal(
  roster.resetWorthSpending(
    usageProfile("c1", "openai-codex", "Work", true, [
      win("p", "5-hour", 0.4),
      win("r", "Code review 7-day", 80, { scope: { kind: "code_review" } }),
    ]),
  ),
  false,
);
console.log("ok - credits, extra usage and resets say only what was reported");

// ── the roster ────────────────────────────────────────────────────────────
const usage = {
  checkedAt: at(0),
  providers: [],
  profiles: [
    usageProfile("a1", "anthropic", "Personal", true, [
      win("a5", "5-hour", 1, { resetsAt: at(2 * HOUR) }),
      win("a7", "7-day", 26, { resetsAt: at(5 * 24 * HOUR) }),
      win("af", "Fable 7-day", 0, {
        resetsAt: at(5 * 24 * HOUR),
        scope: { kind: "model", modelLabel: "Fable" },
      }),
    ], { plan: "max" }),
    usageProfile("a2", "anthropic", "Work", false, [win("b5", "5-hour", 64)]),
    usageProfile("o1", "openai-codex", "Team", true, [
      win("o5", "5-hour", 71, { resetsAt: at(30 * 60_000) }),
      win("o7", "7-day", 40),
    ], { plan: "plus", resetCredits: { available: 1 } }),
    usageProfile("g1", "xai", "SuperGrok", true, []),
  ],
};
const accounts = {
  profiles: [
    row("a1", "anthropic", "Personal", true, { email: "me@example.com" }),
    row("a2", "anthropic", "Work", false, { email: "me@work.example" }),
    row("o1", "openai-codex", "Team", true, { email: "team@example.com" }),
    row("g1", "xai", "SuperGrok", true, { email: "grok@example.com" }),
  ],
  systemOffers: {},
  runtimeInstalled: true,
  runtimeVersion: "1",
  runtimeExpectedVersion: "1",
};
const cli = {
  runtimes: [
    {
      runtime: "claude",
      defaultProfileId: "personal",
      profiles: [
        {
          runtime: "claude",
          id: "personal",
          label: "Claude Code",
          managed: false,
          isDefault: true,
          connected: true,
          inUse: false,
          status: "connected",
          email: "local@example.com",
        },
      ],
    },
  ],
};

const built = roster.buildUsageRoster({ usage, accounts, cli });
// Worst first: Codex's 71% outranks Claude's 26%; Grok draws nothing and
// goes last.
assert.deepEqual(
  built.map((entry) => entry.provider),
  ["openai-codex", "anthropic", "xai"],
);
const claude = built.find((entry) => entry.provider === "anthropic");
assert.equal(claude.name, "Claude");
assert.equal(claude.plan, "Max");
assert.deepEqual(
  claude.chips.map((chip) => `${chip.label} ${chip.usedPercent}`),
  ["5h 1", "wk 26", "Fable 0"],
);
assert.equal(claude.active.label, "Personal");
assert.equal(claude.active.email, "me@example.com");
assert.equal(roster.soonestReset(claude.chips, NOW), "Resets in 2h");
assert.equal(roster.tightestChip(claude.chips).label, "wk");
assert.deepEqual(
  roster.pillChips(claude.chips, "detailed").map((chip) => chip.label),
  ["5h", "wk"],
);
assert.deepEqual(
  roster.pillChips(claude.chips, "compact").map((chip) => chip.label),
  ["wk"],
);
// Every account, with its email and limits. The own login comes first and
// can be switched to, but its limits are never read.
assert.deepEqual(
  claude.accounts.map((account) => [account.label, account.email, account.active, account.action]),
  [
    ["Your Claude Code login", "local@example.com", false, "use-system"],
    ["Personal", "me@example.com", true, null],
    ["Work", "me@work.example", false, "use"],
  ],
);
assert.equal(claude.accounts[0].note, "Limits not shown for your own login");
assert.deepEqual(
  claude.accounts[2].chips.map((chip) => chip.label),
  ["5h"],
);
const grok = built.find((entry) => entry.provider === "xai");
assert.equal(grok.status, "Not reported by xAI");
assert.equal(grok.chips.length, 0);
console.log("ok - rows sort worst first and list every account with its email");

// Before the account list arrives, the usage read names the accounts.
const early = roster.buildUsageRoster({ usage, accounts: null, cli: null });
const earlyClaude = early.find((entry) => entry.provider === "anthropic");
assert.equal(earlyClaude.active.label, "Personal");
assert.equal(earlyClaude.active.email, null);
assert.equal(earlyClaude.chips.length, 3);
console.log("ok - the panel draws from the usage read alone");

// No Active row: new sessions use the CLI's own login, which Codara never
// reads, so the row says so instead of drawing numbers.
const systemOnly = roster.buildUsageRoster({
  usage: {
    checkedAt: at(0),
    providers: [],
    profiles: [usageProfile("a2", "anthropic", "Work", false, [win("b5", "5-hour", 64)])],
  },
  accounts: {
    ...accounts,
    profiles: [row("a2", "anthropic", "Work", false, { email: "me@work.example" })],
  },
  cli,
});
assert.equal(systemOnly.length, 1);
assert.equal(systemOnly[0].active.system, true);
assert.equal(systemOnly[0].active.profileId, null);
assert.equal(systemOnly[0].status, "Using your Claude Code login");
assert.equal(systemOnly[0].chips.length, 0);
assert.equal(systemOnly[0].accounts[1].action, "use");
console.log("ok - the own login is shown as active without made-up limits");

// Switch rules follow Accounts: an expired row and a Cora-only row cannot be
// switched to from here; a System row without Cora says why it has no limits.
const rules = roster.buildUsageRoster({
  usage: {
    checkedAt: at(0),
    providers: [],
    profiles: [
      usageProfile("o1", "openai-codex", "Team", true, [win("o5", "5-hour", 10)]),
      { ...usageProfile("o2", "openai-codex", "Old", false, []), status: "expired", message: "ChatGPT rejected the stored session. Reconnect." },
    ],
  },
  accounts: {
    ...accounts,
    profiles: [
      row("sys", "openai-codex", "Codex", false, { builtIn: true, coraHalf: "none", cliProfileId: "personal" }),
      row("o1", "openai-codex", "Team", true),
      row("o2", "openai-codex", "Old", false, { expired: true, canRefresh: false }),
      row("o3", "openai-codex", "Cora only", false, { cliProfileId: undefined }),
    ],
  },
  cli: null,
});
const codexRules = rules[0];
assert.deepEqual(
  codexRules.accounts.map((account) => [account.label, account.action, account.note]),
  [
    ["Codex", "use", "Limits show once Cora is connected"],
    ["Team", null, null],
    ["Old", null, "ChatGPT rejected the stored session."],
    ["Cora only", null, "Not available"],
  ],
);
assert.equal(codexRules.accounts[2].blocked, "Needs a new sign-in. Reconnect it in Accounts.");
assert.equal(codexRules.accounts[3].blocked, "Share it with Codex in Accounts first");
console.log("ok - switching is offered only where Accounts offers it");

assert.equal(roster.normalizeUsageDensity("compact"), "compact");
assert.equal(roster.normalizeUsageDensity("bogus"), "detailed");
assert.equal(roster.normalizeUsageDensity(null), "detailed");
console.log("ok - density falls back to Detailed");
