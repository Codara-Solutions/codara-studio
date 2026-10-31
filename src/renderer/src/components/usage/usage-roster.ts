// Who is behind each provider in the title bar's usage panel: the account new
// sessions use with its reading, every other account with its email and
// limits, and what switching to it does. The account model follows Orca's
// usage roster (github.com/stablyai/orca, MIT); the rules are Codara's own.
// What the panel says about each limit is in usage-glance.ts. Pure, so
// scripts/test-usage-roster.cjs pins them without a renderer.

import type {
  NativeCliAccountsInspection,
  PiSubscriptionOverview,
  PiSubscriptionProfileConnection,
  PiSubscriptionProvider,
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

/** What a System login without Cora's half says in place of limits. */
const CORA_NOT_SIGNED_IN = "Limits appear once Cora is signed in";

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
    note = CORA_NOT_SIGNED_IN;
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
      note: signedOut ? "Signed out on this computer" : `${descriptor.cliLabel} keeps these private`,
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
    status = `${descriptor.cliLabel} keeps these private`;
    detail = `Codara never reads your own ${descriptor.cliLabel} login, so its limits are not shown. Add the account in Accounts to see them here.`;
  } else if (active.system && active.note === CORA_NOT_SIGNED_IN) {
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
 * One entry per provider that has any account or a System login, in the
 * Accounts order. The panel keeps that order whatever the numbers say, so a
 * provider never jumps place between two looks.
 */
export function buildUsageRoster(inputs: RosterInputs): RosterProvider[] {
  return PROVIDER_ORDER.map((provider) => buildProvider(provider, inputs)).filter(
    (entry): entry is RosterProvider => entry !== null,
  );
}
