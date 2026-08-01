// Subscription-quota headroom for Cora's worker routing.
//
// Cora runs workers on two metered subscriptions (Claude Pro/Max on the claude
// runtime, ChatGPT Plus/Pro on the codex runtime). This module turns the raw
// per-window usage that pi-subscription-usage.ts reads into three things:
//
//   1. summarizeProviderHeadroom: a conservative provider-general headroom
//      number. Model and code-review buckets need a selected workload and are
//      evaluated at the actual manager/worker launch boundary instead.
//   2. describeHeadroomForPrompt: a short dynamic-tail section for the manager
//      prompt so the manager can lean toward the provider with more room.
//   3. preferredRuntimeForHeadroom: the enforcement signal used at spawn time.
//      Deliberately blunt: it names a runtime only when the gap is decisive,
//      and stays null otherwise so routing keeps following task affinity.
//
// Everything except readSubscriptionHeadroomSummary is pure and unit-tested in
// scripts/test-subscription-headroom.cjs; the reader is the only function that
// touches the Electron-side usage cache, via a lazy import so this module stays
// bundleable standalone.

import type {
  PiSubscriptionProvider,
  PiUsageOverview,
  PiUsageProfile,
  PiUsageProvider,
} from "@shared/types";

import { rosterModelFor } from "./worker-model-hint";

export type HeadroomRuntime = "claude" | "codex";

// ── Decision thresholds ─────────────────────────────────────────────────────
//
// A reroute only fires when one provider is nearly exhausted AND the other has
// real room. Both bounds exist to keep the thumb off the scale in the common
// case:
//
//   TIGHT (< 10% left, or limitReached): below this a worker sent to the
//   provider is likely to hit the wall mid-task, so headroom outweighs task
//   affinity.
//   COMFORTABLE (>= 35% left): the destination must absorb the rerouted work
//   without becoming the next bottleneck; rerouting into a 15%-left provider
//   just moves the failure.
//
// Between the two (both providers mid-range, or the roomy one below 35%), the
// answer is null: no reroute, the manager's own choice stands.
export const TIGHT_HEADROOM_PERCENT = 10;
export const COMFORTABLE_HEADROOM_PERCENT = 35;

const RUNTIME_FOR_PROVIDER: Record<PiSubscriptionProvider, HeadroomRuntime> = {
  anthropic: "claude",
  "openai-codex": "codex",
};

const PROVIDER_FOR_RUNTIME: Record<HeadroomRuntime, PiSubscriptionProvider> = {
  claude: "anthropic",
  codex: "openai-codex",
};

/** Short prompt-facing names, matching how the manager prompts talk about the
 * two provider families. */
const PROMPT_LABEL: Record<HeadroomRuntime, string> = {
  claude: "Claude",
  codex: "Codex",
};

export interface ProviderHeadroom {
  provider: PiSubscriptionProvider;
  runtime: HeadroomRuntime;
  /** Prompt-facing provider name ("Claude" / "Codex"). */
  label: string;
  /**
   * Conservative general-agent headroom: the minimum remainingPercent across
   * provider-general windows. Null when the provider gave no usable data (not
   * connected, expired, errored, or no windows), which downstream reads as
   * "no signal", never as 0 or 100.
   */
  headroomPercent: number | null;
  limitReached: boolean;
  /** Label of the window with the least room ("5-hour", "7-day", ...). */
  tightestWindowLabel: string | null;
  /** Pre-formatted countdown to that window's reset ("2h 10m"), if known. */
  tightestWindowResetsIn: string | null;
}

export type SubscriptionHeadroomSummary = Record<HeadroomRuntime, ProviderHeadroom>;

export interface ProfileHeadroom extends ProviderHeadroom {
  /** Opaque local UUID; no vendor identity is exposed. */
  profileId: string;
  /** User-assigned local label. */
  label: string;
  isDefault: boolean;
}

function emptyHeadroom(runtime: HeadroomRuntime, limitReached: boolean): ProviderHeadroom {
  return {
    provider: PROVIDER_FOR_RUNTIME[runtime],
    runtime,
    label: PROMPT_LABEL[runtime],
    headroomPercent: null,
    limitReached,
    tightestWindowLabel: null,
    tightestWindowResetsIn: null,
  };
}

function providerHeadroom(
  runtime: HeadroomRuntime,
  entry: PiUsageProvider | PiUsageProfile | undefined,
): ProviderHeadroom {
  const limitReached =
    entry?.generalLimitReached ??
    (entry?.windows.every(
      (window) => !window.scope || window.scope.kind === "general",
    )
      ? entry?.limitReached === true
      : false);
  if (!entry || entry.status !== "ok") return emptyHeadroom(runtime, limitReached);
  const windows = (entry.windows ?? []).filter(
    (window) =>
      (!window.scope || window.scope.kind === "general") &&
      Number.isFinite(window.remainingPercent),
  );
  if (windows.length === 0) return emptyHeadroom(runtime, limitReached);
  let tightest = windows[0];
  for (const window of windows) {
    if (window.remainingPercent < tightest.remainingPercent) tightest = window;
  }
  return {
    provider: PROVIDER_FOR_RUNTIME[runtime],
    runtime,
    label: PROMPT_LABEL[runtime],
    headroomPercent: tightest.remainingPercent,
    limitReached,
    tightestWindowLabel: tightest.label,
    tightestWindowResetsIn: tightest.resetsIn ?? null,
  };
}

function usageProfileHeadroom(entry: PiUsageProfile): ProfileHeadroom {
  const base = providerHeadroom(RUNTIME_FOR_PROVIDER[entry.provider], entry);
  return {
    ...base,
    profileId: entry.profileId,
    label: entry.label,
    isDefault: entry.isDefault,
  };
}

/** Account-level quota signals in deterministic provider/default/label order.
 * This is deliberately separate from provider rerouting: selecting an account
 * is only safe at the run/attempt boundary where explicit pins are known. */
export function summarizeProfileHeadroom(
  overview: PiUsageOverview | null | undefined,
  provider?: PiSubscriptionProvider,
): ProfileHeadroom[] {
  return (overview?.profiles ?? [])
    .filter((entry) => !provider || entry.provider === provider)
    .map(usageProfileHeadroom)
    .sort((left, right) =>
      left.provider.localeCompare(right.provider) ||
      Number(right.isDefault) - Number(left.isDefault) ||
      left.label.localeCompare(right.label) ||
      left.profileId.localeCompare(right.profileId),
    );
}

/**
 * Rank account candidates by conservative remaining quota.
 *
 * An explicit profile id is an immutable pin: when it exists for this provider
 * this function returns that row alone, even if it is exhausted or errored.
 * Callers must surface the failure and let the user choose another account;
 * silently spending a different subscription would violate the pin.
 */
export function rankProfilesForHeadroom(
  overview: PiUsageOverview | null | undefined,
  provider: PiSubscriptionProvider,
  explicitProfileId?: string | null,
): ProfileHeadroom[] {
  const candidates = summarizeProfileHeadroom(overview, provider);
  if (explicitProfileId) {
    const pinned = candidates.find((entry) => entry.profileId === explicitProfileId);
    return pinned ? [pinned] : [];
  }
  return candidates.sort((left, right) => {
    const leftUsable = left.headroomPercent !== null && !left.limitReached;
    const rightUsable = right.headroomPercent !== null && !right.limitReached;
    if (leftUsable !== rightUsable) return rightUsable ? 1 : -1;
    // Percentages are clamped to 0..100, so -1 is a stable "no data" sentinel
    // and avoids -Infinity - -Infinity producing NaN (which would skip the
    // deterministic default/label tie-break below).
    const remaining = (right.headroomPercent ?? -1) - (left.headroomPercent ?? -1);
    if (remaining !== 0) return remaining;
    return Number(right.isDefault) - Number(left.isDefault) ||
      left.label.localeCompare(right.label) ||
      left.profileId.localeCompare(right.profileId);
  });
}

/**
 * Fold a raw usage overview into one conservative headroom per runtime. Every
 * degraded state (provider missing from the overview, not_connected, expired,
 * error, zero windows) lands on headroomPercent null, so a broken usage read
 * can never masquerade as either "plenty of room" or "exhausted".
 */
export function summarizeProviderHeadroom(
  overview: PiUsageOverview | null | undefined,
): SubscriptionHeadroomSummary {
  const byProvider = new Map<PiSubscriptionProvider, PiUsageProvider>();
  for (const entry of overview?.providers ?? []) {
    if (entry && entry.provider in RUNTIME_FOR_PROVIDER) byProvider.set(entry.provider, entry);
  }
  const profileForProvider = (
    provider: PiSubscriptionProvider,
  ): PiUsageProfile | undefined => {
    const profiles = (overview?.profiles ?? []).filter(
      (entry) => entry.provider === provider,
    );
    if (profiles.length === 0) return undefined;

    const ranked = profiles
      .map((profile) => ({
        profile,
        headroom: usageProfileHeadroom(profile),
      }))
      .sort((left, right) => {
        const leftUsable =
          left.headroom.headroomPercent !== null &&
          !left.headroom.limitReached;
        const rightUsable =
          right.headroom.headroomPercent !== null &&
          !right.headroom.limitReached;
        if (leftUsable !== rightUsable) return rightUsable ? 1 : -1;
        const remaining =
          (right.headroom.headroomPercent ?? -1) -
          (left.headroom.headroomPercent ?? -1);
        if (remaining !== 0) return remaining;
        return (
          Number(right.profile.isDefault) -
            Number(left.profile.isDefault) ||
          left.profile.label.localeCompare(right.profile.label) ||
          left.profile.profileId.localeCompare(right.profile.profileId)
        );
      });
    const usable = ranked.find(
      ({ headroom }) =>
        headroom.headroomPercent !== null && !headroom.limitReached,
    );
    if (usable) return usable.profile;

    // A provider-level "limited" signal is safe only when every account is
    // known limited. One disconnected/error/unknown account means the
    // provider has no trustworthy aggregate signal, not that it is exhausted.
    if (
      ranked.length > 0 &&
      ranked.every(({ headroom }) => headroom.limitReached)
    ) {
      return ranked[0].profile;
    }
    return undefined;
  };
  const anthropicProfile = profileForProvider("anthropic");
  const codexProfile = profileForProvider("openai-codex");
  return {
    claude: anthropicProfile
      ? providerHeadroom("claude", anthropicProfile)
      : overview?.profiles?.some((entry) => entry.provider === "anthropic")
        ? emptyHeadroom("claude", false)
        : providerHeadroom("claude", byProvider.get("anthropic")),
    codex: codexProfile
      ? providerHeadroom("codex", codexProfile)
      : overview?.profiles?.some(
            (entry) => entry.provider === "openai-codex",
          )
        ? emptyHeadroom("codex", false)
        : providerHeadroom("codex", byProvider.get("openai-codex")),
  };
}

/** A provider contributes to the prompt line only when it reported something
 * actionable: a real headroom number, or an explicit limit-reached flag. */
function hasUsableSignal(entry: ProviderHeadroom): boolean {
  return entry.headroomPercent !== null || entry.limitReached;
}

function isTight(entry: ProviderHeadroom): boolean {
  return (
    entry.limitReached ||
    (entry.headroomPercent !== null && entry.headroomPercent < TIGHT_HEADROOM_PERCENT)
  );
}

function isComfortable(entry: ProviderHeadroom): boolean {
  return (
    !entry.limitReached &&
    entry.headroomPercent !== null &&
    entry.headroomPercent >= COMFORTABLE_HEADROOM_PERCENT
  );
}

function otherRuntime(runtime: HeadroomRuntime): HeadroomRuntime {
  return runtime === "claude" ? "codex" : "claude";
}

/**
 * The runtime worker routing should lean toward, or null when there is no
 * decisive gap. Named only when one provider is TIGHT (limitReached or under
 * TIGHT_HEADROOM_PERCENT) while the other is COMFORTABLE (at least
 * COMFORTABLE_HEADROOM_PERCENT and not limit-reached); see the threshold notes
 * above. A provider with no usable data is neither tight nor comfortable, so
 * a failed usage read always yields null.
 */
export function preferredRuntimeForHeadroom(
  summary: SubscriptionHeadroomSummary | null | undefined,
): HeadroomRuntime | null {
  if (!summary) return null;
  if (isTight(summary.claude) && isComfortable(summary.codex)) return "codex";
  if (isTight(summary.codex) && isComfortable(summary.claude)) return "claude";
  return null;
}

/** Convenience lookup used at the spawn chokepoint. */
export function headroomForRuntime(
  summary: SubscriptionHeadroomSummary | null | undefined,
  runtime: HeadroomRuntime,
): ProviderHeadroom | null {
  return summary ? summary[runtime] : null;
}

/** True only on an explicit limit-reached flag; a missing or failed usage read
 * never marks a provider exhausted. */
export function runtimeLimitReached(
  summary: SubscriptionHeadroomSummary | null | undefined,
  runtime: HeadroomRuntime,
): boolean {
  return summary?.[runtime]?.limitReached === true;
}

function describeProvider(entry: ProviderHeadroom): string {
  const windowDetail: string[] = [];
  if (entry.tightestWindowLabel) windowDetail.push(`${entry.tightestWindowLabel} window`);
  if (entry.tightestWindowResetsIn) windowDetail.push(`resets in ${entry.tightestWindowResetsIn}`);
  const detail = windowDetail.length > 0 ? ` (${windowDetail.join(", ")})` : "";
  if (entry.limitReached) return `${entry.label} limit reached${detail}`;
  // Window detail only where it matters: a tight provider's binding window and
  // reset time are actionable, a roomy provider's are noise.
  const showDetail =
    entry.headroomPercent !== null && entry.headroomPercent < COMFORTABLE_HEADROOM_PERCENT;
  return `${entry.label} ${entry.headroomPercent}% left${showDetail ? detail : ""}`;
}

/**
 * The manager-prompt section. Rides the per-turn dynamic tail beside workspace
 * lessons, never the cacheable stable prefix (the numbers change every turn).
 * Returns null when neither provider reported usable data, so the section
 * disappears entirely rather than announcing its own ignorance.
 */
export function describeHeadroomForPrompt(
  summary: SubscriptionHeadroomSummary | null | undefined,
): string | null {
  if (!summary) return null;
  const usable = [summary.claude, summary.codex].filter(hasUsableSignal);
  if (usable.length === 0) return null;
  const lines = [`Subscription headroom: ${usable.map(describeProvider).join(" · ")}.`];
  const preferred = preferredRuntimeForHeadroom(summary);
  if (preferred) {
    const constrained = otherRuntime(preferred);
    lines.push(
      `Prefer ${rosterModelFor(preferred, "standard")} workers on the ${preferred} runtime while ` +
        `${PROMPT_LABEL[constrained]} is tight; a provider with no remaining quota will fail its workers.`,
    );
  }
  return lines.join("\n");
}

/**
 * The one Electron-touching entry point: read the cached subscription usage
 * (60s cache upstream, never forced from here) and fold it into a summary.
 * Any failure, including the usage module failing to load, degrades to null,
 * a usage hiccup must never break a manager turn or a spawn. Imported lazily
 * so the pure functions above stay bundleable without Electron.
 */
export async function readSubscriptionHeadroomSummary(): Promise<SubscriptionHeadroomSummary | null> {
  try {
    const { inspectPiSubscriptionUsage } = await import("./pi-subscription-usage");
    return summarizeProviderHeadroom(await inspectPiSubscriptionUsage());
  } catch {
    return null;
  }
}
