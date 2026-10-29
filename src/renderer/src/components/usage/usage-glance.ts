// What the title bar's hairlines and the usage panel say about each limit:
// used now, where the forecast says it ends at the reset (or when it runs
// out first), which account to switch to when one runs out, and which banked
// ChatGPT reset to spend. Pure, so scripts/test-usage-glance.cjs pins the
// rules without a renderer. The words follow the mock-up Etienne picked
// (DESIGN.md, "Usage in the title bar").

import type { PiUsageProfile, PiUsageResetCredit, PiUsageWindow } from "@shared/types";
import { formatClock, type UsageForecastReport, type WindowForecastView } from "@shared/usage-forecast";
import { formatResetDuration, orderWindows, type RosterAccount, type RosterProvider } from "./usage-roster";

/** Where a limit is heading by its reset. */
export type LimitOutlook =
  /** The forecast is off: only what is used now is shown. */
  | { kind: "off" }
  /** Too little history to forecast this window honestly. */
  | { kind: "no-history" }
  /** Already at 100%. */
  | { kind: "used-up" }
  /** Runs out before the reset. */
  | { kind: "out"; atMs: number; earlyMs: number }
  /** Lasts until the reset, ending around this percent. */
  | { kind: "end"; endPercent: number };

export interface GlanceLimit {
  windowId: string;
  /** "5-hour", "Week", "Fable week". */
  title: string;
  usedPercent: number;
  resetsAtMs: number | null;
  outlook: LimitOutlook;
  /** Runs out before the reset, or already has. The only state drawn red. */
  risk: boolean;
}

/** A forecast whose more-likely-than-not answer is "runs out" counts as risk. */
const RUN_OUT_ODDS = 0.5;

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

/**
 * The forecast for one window, in display terms. A window the report has no
 * view for, or whose replays found no past day like today, has too little
 * history: it says so rather than drawing a guess.
 */
export function limitOutlook(
  view: WindowForecastView | null | undefined,
  usedPercent: number,
  forecastOn: boolean,
): LimitOutlook {
  if (clampPercent(usedPercent) >= 100) return { kind: "used-up" };
  if (!forecastOn) return { kind: "off" };
  if (!view) return { kind: "no-history" };
  const { result } = view;
  if (result.inUse && result.analogDays <= 0) return { kind: "no-history" };
  const hit = result.hitAt.p50;
  if (result.inUse && result.hitProbability >= RUN_OUT_ODDS && hit !== null && hit < result.resetsAtMs) {
    return { kind: "out", atMs: hit, earlyMs: Math.max(0, result.resetsAtMs - hit) };
  }
  const end = Math.round(Math.max(clampPercent(usedPercent), clampPercent(result.endPercent.p50)));
  return { kind: "end", endPercent: end };
}

/** "5-hour", "Week", "Fable week": short enough for one line in the panel. */
export function limitTitle(window: PiUsageWindow): string {
  const label = window.label.trim();
  if (label === "7-day") return "Week";
  return label.replace(/ ?7-day$/, " week").trim();
}

/** The windows the panel draws: plan-wide and per-model caps, never Codex's
 * code-review quota, which no agent session spends. */
export function glanceWindows(usage: PiUsageProfile | null | undefined): PiUsageWindow[] {
  if (!usage || usage.status !== "ok") return [];
  return orderWindows(usage.windows).filter((window) => {
    const kind = window.scope?.kind ?? "general";
    return kind === "general" || kind === "model";
  });
}

export function glanceLimits(
  usage: PiUsageProfile | null | undefined,
  report: UsageForecastReport | null,
  forecastOn: boolean,
): GlanceLimit[] {
  return glanceWindows(usage).map((window) => {
    const view =
      report?.windows.find((entry) => entry.profileId === usage?.profileId && entry.windowId === window.id) ?? null;
    const usedPercent = clampPercent(window.usedPercent);
    const outlook = limitOutlook(view, usedPercent, forecastOn);
    const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    return {
      windowId: window.id,
      title: limitTitle(window),
      usedPercent,
      resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
      outlook,
      risk: outlook.kind === "out" || outlook.kind === "used-up",
    };
  });
}

/** Where a limit is drawn to: the forecast end, the full track when it runs
 * out, or nothing past the used part when there is no forecast. */
export function outlookEnd(limit: GlanceLimit): number | null {
  if (limit.risk) return 100;
  return limit.outlook.kind === "end" ? limit.outlook.endPercent : null;
}

/**
 * The one limit a provider's hairline draws: the one that runs out first,
 * else the one forecast to end highest (or used most, without a forecast).
 * Plan-wide windows win over a model's cap, which leaves other models usable.
 */
export function hairlineLimit(limits: readonly GlanceLimit[]): GlanceLimit | null {
  if (limits.length === 0) return null;
  const outAt = (limit: GlanceLimit) =>
    limit.outlook.kind === "used-up" ? -Infinity : limit.outlook.kind === "out" ? limit.outlook.atMs : Infinity;
  const risky = limits.filter((limit) => limit.risk).sort((a, b) => outAt(a) - outAt(b));
  if (risky.length > 0) return risky[0]!;
  const height = (limit: GlanceLimit) => outlookEnd(limit) ?? limit.usedPercent;
  return limits.reduce((best, limit) => (height(limit) > height(best) ? limit : best));
}

export function percentText(value: number): string {
  return `${Math.round(value)}%`;
}

/** The hairline's tooltip and accessible name: one plain sentence. */
export function hairlineSentence(who: string, limit: GlanceLimit, nowMs: number): string {
  const name = limit.title.toLowerCase() === "week" ? "weekly" : limit.title;
  const reset = limit.resetsAtMs !== null ? formatClock(limit.resetsAtMs, nowMs) : null;
  const used = percentText(limit.usedPercent);
  switch (limit.outlook.kind) {
    case "used-up":
      return reset
        ? `${who}: the ${name} limit is used up until ${reset}.`
        : `${who}: the ${name} limit is used up.`;
    case "out":
      return `${who} runs out at ${formatClock(limit.outlook.atMs, nowMs)}, ${formatResetDuration(limit.outlook.earlyMs)} before the ${name} limit resets.`;
    case "end":
      return reset
        ? `${who}: ${limit.title} at ${used}, ends around ${limit.outlook.endPercent}% when it resets at ${reset}.`
        : `${who}: ${limit.title} at ${used}, ends around ${limit.outlook.endPercent}% at reset.`;
    case "no-history":
      return `${who}: ${limit.title} at ${used}${reset ? ` until ${reset}` : ""}, not enough history yet to forecast.`;
    default:
      return `${who}: ${limit.title} at ${used}${reset ? `, resets ${reset}` : ""}.`;
  }
}

/* ── Switching when a limit runs out ─────────────────────────────────────── */

export interface SwitchSuggestion {
  account: RosterAccount;
  /** Room left on its tightest plan-wide window. */
  leftPercent: number;
}

/** Less room than this is not worth moving new sessions for. */
const MIN_ROOM = 25;

/**
 * The account to move new sessions to, shown only while one of the active
 * account's limits runs out before its reset: the switchable account with
 * the most room, when that room is real and beats the active account's.
 */
export function switchSuggestion(
  entry: RosterProvider,
  limits: readonly GlanceLimit[],
): SwitchSuggestion | null {
  if (!limits.some((limit) => limit.risk)) return null;
  const left = (account: RosterAccount): number | null => {
    const general = account.chips.filter((chip) => chip.general);
    const pool = general.length > 0 ? general : account.chips;
    if (pool.length === 0) return null;
    return 100 - Math.max(...pool.map((chip) => chip.usedPercent));
  };
  const activeLeft = entry.active ? (left(entry.active) ?? 0) : 0;
  let best: SwitchSuggestion | null = null;
  for (const account of entry.accounts) {
    if (account.active || account.action === null) continue;
    const room = left(account);
    if (room === null || room < MIN_ROOM || room <= activeLeft) continue;
    if (!best || room > best.leftPercent) best = { account, leftPercent: Math.round(room) };
  }
  return best;
}

/* ── ChatGPT's banked resets ─────────────────────────────────────────────── */

export interface BankedReset {
  id: string | null;
  expiresAtMs: number | null;
  grantedAtMs: number | null;
  /** Expires within a day: drawn in the warn tone. */
  soon: boolean;
}

export interface ResetPlan {
  count: number;
  /** Every listed reset, soonest expiry first. May be empty when only the
   * count was read. */
  credits: BankedReset[];
  /** The reset "Use a reset" spends: the unexpired one that expires first. */
  next: BankedReset | null;
  canUse: boolean;
  /** Why "Use a reset" is off, in plain words; null while it is on. */
  why: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseMs(value: string | undefined): number | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** The reset to spend: unexpired, soonest expiry first, an unknown expiry last. */
export function chooseResetCredit(
  credits: readonly PiUsageResetCredit[] | undefined,
  nowMs: number,
): PiUsageResetCredit | null {
  const live = (credits ?? [])
    .map((credit) => ({ credit, at: parseMs(credit.expiresAt) }))
    .filter(({ at }) => at === null || at > nowMs)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  return live[0]?.credit ?? null;
}

/** "today 19:48", "tomorrow 09:00", "Sat 7 Nov, 00:20". */
export function expiryWords(atMs: number, nowMs: number): string {
  const clock = formatClock(atMs, nowMs);
  if (!/^[A-Z]/.test(clock)) return /^\d/.test(clock) ? `today ${clock}` : clock;
  const date = new Date(atMs);
  const day = date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${day}, ${time}`;
}

/** "today", "tomorrow" or "on Sat": when the soonest reset lapses. */
function expiryDay(atMs: number, nowMs: number): string {
  const words = expiryWords(atMs, nowMs);
  if (words.startsWith("today")) return "today";
  if (words.startsWith("tomorrow")) return "tomorrow";
  return `on ${words.split(" ")[0]}`;
}

/**
 * What the ChatGPT reset block shows and allows. "Use a reset" is off when
 * ChatGPT says none applies now (applicable 0), or, when it did not say,
 * while no plan-wide window has use on it; either way the reason is given.
 */
export function planCodexReset(usage: PiUsageProfile | null | undefined, nowMs: number): ResetPlan | null {
  const banked = usage?.resetCredits;
  const count = banked?.available ?? 0;
  if (!banked || count <= 0) return null;
  const listed = (banked.credits ?? [])
    .map((credit) => ({ credit, at: parseMs(credit.expiresAt) }))
    .filter(({ at }) => at === null || at > nowMs)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
    .map(({ credit, at }) => ({
      id: credit.id ?? null,
      expiresAtMs: at,
      grantedAtMs: parseMs(credit.grantedAt),
      soon: at !== null && at - nowMs <= DAY_MS,
    }));
  const fallbackAt = parseMs(banked.nextExpiresAt);
  const credits: BankedReset[] =
    listed.length > 0
      ? listed
      : fallbackAt !== null && fallbackAt > nowMs
        ? [{ id: null, expiresAtMs: fallbackAt, grantedAtMs: null, soon: fallbackAt - nowMs <= DAY_MS }]
        : [];
  const next = credits[0] ?? null;
  const general = (usage?.windows ?? []).filter((window) => (window.scope?.kind ?? "general") === "general");
  const nothingUsed = general.every((window) => window.usedPercent < 1);
  const applicable = banked.applicable;
  const canUse = applicable !== undefined ? applicable > 0 : !nothingUsed;
  let why: string | null = null;
  if (!canUse) {
    const tightest = [...general].sort((a, b) => b.usedPercent - a.usedPercent)[0];
    const name = tightest ? limitTitle(tightest).toLowerCase() : null;
    why = nothingUsed
      ? `Nothing to reset yet: the ${name ?? "limit"} is at ${percentText(tightest?.usedPercent ?? 0)}.`
      : "ChatGPT says none can be used right now.";
    if (next?.soon && next.expiresAtMs !== null) {
      why += ` The one expiring ${expiryDay(next.expiresAtMs, nowMs)} may lapse unused.`;
    }
  }
  return { count, credits, next, canUse, why };
}

/** The confirm step's question and detail, naming the reset that is spent. */
export function resetConfirmWords(
  plan: ResetPlan,
  usage: PiUsageProfile | null | undefined,
  provider: string,
  nowMs: number,
): { question: string; detail: string } {
  const general = (usage?.windows ?? []).filter((window) => (window.scope?.kind ?? "general") === "general");
  const tightest = [...general].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const name = tightest ? limitTitle(tightest).toLowerCase() : null;
  const limit = name === "week" ? "weekly limit" : name ? `${name} limit` : "limits";
  const goes = tightest
    ? `${provider}'s ${limit} goes from ${percentText(tightest.usedPercent)} back to 0%.`
    : `${provider}'s limits go back to 0%.`;
  const which =
    plan.next && plan.next.expiresAtMs !== null
      ? ` The reset expiring ${expiryWords(plan.next.expiresAtMs, nowMs)} goes first.`
      : "";
  return {
    question: `Use 1 of ${plan.count} reset${plan.count === 1 ? "" : "s"} now?`,
    detail: `${goes}${which} This can't be undone.`,
  };
}
