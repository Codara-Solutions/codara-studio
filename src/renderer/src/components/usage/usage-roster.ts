// What the title bar's Usage roster shows: one row per provider with the
// windows of the account new sessions use, and per provider the details its
// flyout lists (every window, credits, resets, every account with its email
// and limits). The layout follows Orca's usage roster (github.com/stablyai/orca,
// MIT); the rules are Codara's own. Pure, so scripts/test-usage-roster.cjs
// pins them without a renderer.

import type {
  NativeCliAccountsInspection,
  PiSubscriptionOverview,
  PiSubscriptionProfileConnection,
  PiSubscriptionProvider,
  PiUsageCredits,
  PiUsageOverview,
  PiUsageProfile,
  PiUsageWindow,
} from "@shared/types";
import { familyForSubscription, runtimeForSubscription } from "@shared/agent-families";
import {
  ACCOUNT_PROVIDER_DESCRIPTORS,
  systemLoginBadge,
  type AccountProviderDescriptor,
} from "../../lib/account-provider-descriptors";

/** Detailed draws every window as a bar; Compact one number per provider. */
export type UsageDensity = "detailed" | "compact";

export const USAGE_DENSITY_KEY = "spark.usage.density";

export function normalizeUsageDensity(value: unknown): UsageDensity {
  return value === "compact" ? "compact" : "detailed";
}

/** One short window in a row: "5h", "wk" or a model's name. */
export interface RosterChip {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  /** A plan-wide window rather than one model's cap. */
  general: boolean;
}

export interface RosterAccount {
  /** The profile id, or `system:<provider>` for the System login without a row. */
  key: string;
  /** Null for the System login without a row. */
  profileId: string | null;
  label: string;
  /** Shown under the label; null when it says the same as the label or is unknown. */
  email: string | null;
  active: boolean;
  /** The CLI's own login on this computer, with or without a row. */
  system: boolean;
  /** Its own reading, when Codara reads one for it. */
  usage: PiUsageProfile | null;
  chips: RosterChip[];
  /** Why no limits are drawn, when none are. */
  note: string | null;
  /** What choosing it does here; null when it cannot be chosen from the roster. */
  action: "use" | "use-system" | null;
  /** Why it cannot be chosen, when it is not the active one. */
  blocked: string | null;
}

export interface RosterProvider {
  provider: PiSubscriptionProvider;
  /** "Claude", "Codex", "Grok". */
  name: string;
  /** "Claude Code", "Codex", "Grok": what the System login is called. */
  cliLabel: string;
  plan: string | null;
  /** The account new sessions use, or null when none can be named. */
  active: RosterAccount | null;
  usage: PiUsageProfile | null;
  chips: RosterChip[];
  /** Every window of the active reading, in reading order. */
  windows: PiUsageWindow[];
  /** What the row says in place of bars. */
  status: string | null;
  /** The longer form of status, for the flyout. */
  detail: string | null;
  accounts: RosterAccount[];
}

export interface RosterInputs {
  usage: PiUsageOverview | null;
  accounts: PiSubscriptionOverview | null;
  cli: NativeCliAccountsInspection | null;
  /** True until the first usage read settles. */
  usageLoading?: boolean;
}

const PROVIDER_ORDER: readonly PiSubscriptionProvider[] = ACCOUNT_PROVIDER_DESCRIPTORS.map(
  (descriptor) => descriptor.provider,
);

function descriptorFor(provider: PiSubscriptionProvider): AccountProviderDescriptor {
  return ACCOUNT_PROVIDER_DESCRIPTORS.find((entry) => entry.provider === provider)!;
}

const LENGTH = /^(\d+)-(hour|day|minute)$/;

function windowLength(label: string): { amount: number; unit: string } | null {
  const match = LENGTH.exec(label.trim());
  return match ? { amount: Number(match[1]), unit: match[2] } : null;
}

function windowSeconds(window: PiUsageWindow): number {
  const length = windowLength(window.label);
  if (!length) return Number.MAX_SAFE_INTEGER;
  if (length.unit === "day") return length.amount * 86_400;
  if (length.unit === "hour") return length.amount * 3600;
  return length.amount * 60;
}

function scopeKind(window: PiUsageWindow): string {
  return window.scope?.kind ?? "general";
}

/**
 * The window's name in a row: "5h", "wk" for a week, or the model a scoped
 * window caps ("Fable"). Null for the windows only the flyout lists, such as
 * Codex's code review quota.
 */
export function windowChipLabel(window: PiUsageWindow): string | null {
  const scope = window.scope;
  if (scope?.kind === "model") return scope.modelLabel.trim() || null;
  if (scope && scope.kind !== "general") return null;
  const length = windowLength(window.label);
  if (!length) return window.label.trim() || null;
  if (length.unit === "hour") return `${length.amount}h`;
  if (length.unit === "minute") return `${length.amount}m`;
  if (length.amount === 7) return "wk";
  return length.amount % 7 === 0 ? `${length.amount / 7}w` : `${length.amount}d`;
}

/** The window's name in the flyout: "Session", "Weekly", "Fable weekly". */
export function windowTitle(window: PiUsageWindow): string {
  const label = window.label.trim();
  if (scopeKind(window) === "general") {
    if (label === "5-hour") return "Session";
    if (label === "7-day") return "Weekly";
    return label;
  }
  return label.replace(/ 7-day$/, " weekly");
}

function windowRank(window: PiUsageWindow): number {
  const kind = scopeKind(window);
  if (kind === "general") return 0;
  if (kind === "model") return 1;
  if (kind === "code_review") return 2;
  return 3;
}

/** General windows shortest first, then model caps, then the rest. */
export function orderWindows(windows: readonly PiUsageWindow[]): PiUsageWindow[] {
  return [...windows].sort(
    (left, right) =>
      windowRank(left) - windowRank(right) ||
      windowSeconds(left) - windowSeconds(right) ||
      left.label.localeCompare(right.label),
  );
}

export function usageChips(usage: PiUsageProfile | null | undefined): RosterChip[] {
  if (!usage || usage.status !== "ok") return [];
  const chips: RosterChip[] = [];
  for (const window of orderWindows(usage.windows)) {
    const label = windowChipLabel(window);
    if (!label) continue;
    chips.push({
      id: window.id,
      label,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
      general: scopeKind(window) === "general",
    });
  }
  return chips;
}

/**
 * The plan-wide chip closest to its limit: what a provider's single number
 * shows. A model's cap counts only when nothing plan-wide was reported, since
 * reaching it leaves every other model usable.
 */
export function tightestChip(chips: readonly RosterChip[]): RosterChip | null {
  const general = chips.filter((chip) => chip.general);
  return (general.length > 0 ? general : chips).reduce<RosterChip | null>(
    (worst, chip) => (worst === null || chip.usedPercent > worst.usedPercent ? chip : worst),
    null,
  );
}

/** What a title-bar pill shows: every plan-wide window, or in Compact the tightest. */
export function pillChips(chips: readonly RosterChip[], density: UsageDensity): RosterChip[] {
  if (density === "compact") {
    const worst = tightestChip(chips);
    return worst ? [worst] : [];
  }
  const general = chips.filter((chip) => chip.general);
  return general.length > 0 ? general : chips.slice(0, 1);
}

/**
 * Headroom as a colour: green with plenty left, through amber, to red as the
 * window fills. The title bar's scale, so a row and its pill always agree.
 * Two segments, because a straight green-to-red mix passes through olive.
 */
export function usageTone(usedPercent: number): string {
  const used = clampPercent(usedPercent);
  const amber = "var(--warn, #d99a2b)";
  if (used <= 60) return `color-mix(in oklch, ${amber} ${(used / 60) * 100}%, var(--ok))`;
  return `color-mix(in oklch, var(--danger) ${((used - 60) / 40) * 100}%, ${amber})`;
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

/**
 * "47m", "3h 54m", "6d 7h", floored, or "now" once the moment has passed.
 * The same units both CLIs phrase a countdown in.
 */
export function formatResetDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${Math.max(1, totalMinutes)}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
  }
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** "Resets in 2h 14m", or "Resets now" for a moment already past. */
export function formatResetsIn(resetsAt: string | undefined, nowMs: number): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const duration = formatResetDuration(at - nowMs);
  return duration === "now" ? "Resets now" : `Resets in ${duration}`;
}

/** The soonest reset among the chips a row draws. */
export function soonestReset(chips: readonly RosterChip[], nowMs: number): string | null {
  const times = chips
    .map((chip) => (chip.resetsAt ? Date.parse(chip.resetsAt) : Number.NaN))
    .filter((at) => Number.isFinite(at));
  if (times.length === 0) return null;
  return formatResetsIn(new Date(Math.min(...times)).toISOString(), nowMs);
}

/** "Updated just now", "Updated 2m ago", "Updated 3h ago". */
export function formatUpdatedAgo(checkedAt: string | undefined, nowMs: number): string | null {
  const at = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

/** "plus" to "Plus", "chatgpt_business" to "ChatGPT Business". */
export function formatPlan(plan: string | undefined | null): string | null {
  const trimmed = plan?.trim();
  if (!trimmed) return null;
  return trimmed
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      return lower === "chatgpt" ? "ChatGPT" : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

const CREDIT_COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The credits section of a flyout: its title, one line, and a bar when capped. */
export function describeCredits(
  credits: PiUsageCredits | undefined,
): { title: string; line: string; usedPercent: number | null } | null {
  if (!credits) return null;
  if (credits.kind === "balance") {
    return {
      title: "Credits",
      line: credits.unlimited
        ? "Unlimited credits"
        : `${CREDIT_COUNT.format(credits.balance)} credits available`,
      usedPercent: null,
    };
  }
  const spent = credits.spent === null ? null : formatMoney(credits.spent, credits.currency);
  const limit = credits.limit === null ? null : formatMoney(credits.limit, credits.currency);
  const line =
    spent !== null && limit !== null
      ? `${spent} of ${limit} spent`
      : spent !== null
        ? `${spent} spent, no cap`
        : limit !== null
          ? `Limit ${limit}`
          : null;
  if (!line) return null;
  return {
    title: "Extra Usage",
    line,
    usedPercent: credits.usedPercent === null ? null : clampPercent(credits.usedPercent),
  };
}

/** "3 rate-limit resets available" and when the soonest expires. */
export function describeResetCredits(
  usage: PiUsageProfile | null,
  nowMs: number,
): { count: number; line: string; expiry: string | null } | null {
  const available = usage?.resetCredits?.available ?? 0;
  if (available <= 0) return null;
  const at = usage?.resetCredits?.nextExpiresAt
    ? Date.parse(usage.resetCredits.nextExpiresAt)
    : Number.NaN;
  const duration = Number.isFinite(at) ? formatResetDuration(at - nowMs) : null;
  const expiry =
    duration === null
      ? null
      : duration === "now"
        ? available > 1
          ? "Next expires now"
          : "Expires now"
        : available > 1
          ? `Next expires in ${duration}`
          : `Expires in ${duration}`;
  return {
    count: available,
    line:
      available === 1
        ? "1 rate-limit reset available"
        : `${available} rate-limit resets available`,
    expiry,
  };
}

/** A reset is worth spending only once a general window has some use on it. */
export function resetWorthSpending(usage: PiUsageProfile | null): boolean {
  return (usage?.windows ?? []).some(
    (window) => scopeKind(window) === "general" && window.usedPercent >= 1,
  );
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(?:\s|$)/.exec(text.trim());
  return match ? match[1] : text.trim();
}

/** Why an account with a reading draws no bars: the row's line and the flyout's. */
function readingNote(
  usage: PiUsageProfile | null | undefined,
  descriptor: AccountProviderDescriptor,
  loading: boolean,
): { short: string; long: string } | null {
  if (!usage) {
    return loading
      ? { short: "Checking…", long: "Checking limits…" }
      : { short: "Not available", long: "Codara has no reading for this account yet." };
  }
  if (usage.status === "ok") {
    if (usageChips(usage).length > 0) return null;
    if (usage.windows.length > 0) return null;
    return descriptor.reportsUsage
      ? { short: "No limits reported", long: "No limit windows were reported for this account." }
      : {
          short: `Not reported by ${descriptor.label}`,
          long: `${descriptor.label} does not publish limits Codara can read.`,
        };
  }
  if (usage.status === "not_connected") {
    return {
      short: "Not connected",
      long: usage.message || "Cora is not connected to this account. Reconnect it in Accounts.",
    };
  }
  const message = usage.message?.trim();
  if (usage.status === "expired") {
    return {
      short: message ? firstSentence(message) : "Sign-in expired",
      long: message || "This sign-in expired. Reconnect it in Accounts.",
    };
  }
  return {
    short: message ? firstSentence(message) : "Could not read limits",
    long: message || "Could not read usage limits.",
  };
}

function coraUsable(profile: PiSubscriptionProfileConnection): boolean {
  return (
    profile.coraHalf !== "none" &&
    profile.connected &&
    !(profile.expired && !profile.canRefresh)
  );
}

function terminalUsable(profile: PiSubscriptionProfileConnection): boolean {
  return Boolean(profile.terminal?.connected) && !(profile.terminal?.expired && !profile.terminal.canRefresh);
}

function emailLine(email: string | undefined | null, label: string): string | null {
  const trimmed = email?.trim();
  return trimmed && trimmed !== label ? trimmed : null;
}

function rowAccount(
  profile: PiSubscriptionProfileConnection,
  usage: PiUsageProfile | undefined,
  descriptor: AccountProviderDescriptor,
  loading: boolean,
): RosterAccount {
  const system = profile.builtIn === true;
  const chips = usageChips(usage);
  let note: string | null = null;
  if (system && profile.coraHalf === "none") {
    note = "Limits show once Cora is connected";
  } else if (chips.length === 0) {
    note = readingNote(usage, descriptor, loading)?.short ?? null;
  }
  let action: RosterAccount["action"] = null;
  let blocked: string | null = null;
  if (!profile.isDefault) {
    if (system) {
      if (terminalUsable(profile)) action = "use";
      else blocked = `Your ${descriptor.cliLabel} login is signed out`;
    } else if (!coraUsable(profile) || profile.error) {
      blocked = "Needs a new sign-in. Reconnect it in Accounts.";
    } else if (!profile.cliProfileId) {
      blocked = `Share it with ${descriptor.cliLabel} in Accounts first`;
    } else {
      action = "use";
    }
  }
  return {
    key: profile.id,
    profileId: profile.id,
    label: profile.label,
    email: emailLine(profile.email, profile.label),
    active: profile.isDefault,
    system,
    usage: usage ?? null,
    chips,
    note,
    action,
    blocked,
  };
}

/**
 * The System login when no row stands for it: who it is, and whether it is
 * signed in (null until the command-line accounts have been read).
 */
function systemLogin(
  provider: PiSubscriptionProvider,
  inputs: RosterInputs,
): { signedIn: boolean | null; email: string | null } {
  const runtime = runtimeForSubscription(provider);
  const inspected = inputs.cli?.runtimes.find((entry) => entry.runtime === runtime);
  const personal = inspected?.profiles.find((profile) => !profile.managed);
  const offer = inputs.accounts?.systemOffers?.[provider];
  const signedIn =
    personal?.status === "connected" || offer
      ? true
      : inspected && !inspected.unavailable
        ? false
        : null;
  return { signedIn, email: personal?.email?.trim() || offer?.email?.trim() || null };
}

function buildProvider(provider: PiSubscriptionProvider, inputs: RosterInputs): RosterProvider | null {
  const descriptor = descriptorFor(provider);
  const loading = inputs.usageLoading === true;
  const usageProfiles = (inputs.usage?.profiles ?? []).filter((entry) => entry.provider === provider);
  const usageById = new Map(usageProfiles.map((entry) => [entry.profileId, entry] as const));
  // Until the account list arrives, the usage read already names every
  // account and the active one, without emails.
  const rows: PiSubscriptionProfileConnection[] = inputs.accounts
    ? (inputs.accounts.profiles ?? []).filter((profile) => profile.provider === provider)
    : usageProfiles.map((entry) => ({
        id: entry.profileId,
        provider,
        label: entry.label,
        isDefault: entry.isDefault,
        connected: entry.status !== "not_connected",
        expired: entry.status === "expired",
        canRefresh: false,
        expiresAt: null,
      }));
  const accounts = rows
    .map((profile) => rowAccount(profile, usageById.get(profile.id), descriptor, loading))
    .sort((left, right) => Number(right.system) - Number(left.system));
  const anyActive = accounts.some((account) => account.active);
  const hasSystemRow = accounts.some((account) => account.system);
  const login = systemLogin(provider, inputs);
  // As in Accounts: with rows but no System row, the own login is where new
  // sessions go when no row is Active, and a switch target when one is.
  if (!hasSystemRow && (accounts.length > 0 || login.signedIn === true)) {
    const label = systemLoginBadge(descriptor);
    const signedOut = login.signedIn === false;
    accounts.unshift({
      key: `system:${provider}`,
      profileId: null,
      label,
      email: emailLine(login.email, label),
      active: !anyActive,
      system: true,
      usage: null,
      chips: [],
      note: signedOut ? "Signed out on this computer" : "Limits not shown for your own login",
      action: anyActive && !signedOut ? "use-system" : null,
      blocked: null,
    });
  }
  if (accounts.length === 0) return null;

  const active = accounts.find((account) => account.active) ?? null;
  const usage = active?.usage ?? null;
  const chips = active?.chips ?? [];
  let status: string | null = null;
  let detail: string | null = null;
  if (!active) {
    status = "No account active";
    detail = "Choose an account below, or add one in Accounts.";
  } else if (active.system && active.profileId === null) {
    status = `Using your ${descriptor.cliLabel} login`;
    detail = `Codara never reads your own ${descriptor.cliLabel} login, so its limits are not shown. Add the account in Accounts to see them here.`;
  } else if (active.system && active.note === "Limits show once Cora is connected") {
    status = active.note;
    detail = `Limits are read with Cora's own sign-in. Connect Cora to this account in Accounts to see them.`;
  } else if (chips.length === 0) {
    const note = readingNote(usage, descriptor, loading);
    status = note?.short ?? null;
    detail = note?.long ?? null;
  }
  return {
    provider,
    name: familyForSubscription(provider).displayName,
    cliLabel: descriptor.cliLabel,
    plan: formatPlan(usage?.plan),
    active,
    usage,
    chips,
    windows: usage?.status === "ok" ? orderWindows(usage.windows) : [],
    status,
    detail,
    accounts,
  };
}

/**
 * One entry per provider that has any account or a System login, the one
 * nearest a limit first (as in Orca), and providers with nothing to draw last
 * in the Accounts order.
 */
export function buildUsageRoster(inputs: RosterInputs): RosterProvider[] {
  const providers = PROVIDER_ORDER.map((provider) => buildProvider(provider, inputs)).filter(
    (entry): entry is RosterProvider => entry !== null,
  );
  const worst = (entry: RosterProvider) => tightestChip(entry.chips)?.usedPercent ?? -1;
  return providers
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => worst(right.entry) - worst(left.entry) || left.index - right.index)
    .map(({ entry }) => entry);
}
