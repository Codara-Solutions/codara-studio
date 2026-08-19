import type {
  PiSubscriptionProvider,
  PiUsageProfile,
} from "@shared/types";
import {
  inspectPiAccountProfileAuthStore,
  type PiAccountAuthInspection,
} from "./pi-account-auth-store";
import {
  rankPiAccountCandidates,
  type PiAccountSanitizedHeadroom,
} from "./pi-account-profiles";
import { inspectCachedPiSubscriptionUsageProfiles } from "./pi-subscription-usage";
import { evaluateUsageForWorkload } from "./pi-usage-applicability";

export interface PiAccountRouteCandidate {
  accountProfileId: string;
  headroomPercent: number | null;
  /** The only connected choices were known limited. The exact fallback is
   * still returned so launch identity is frozen before the provider reports
   * its authoritative rate-limit result and parks the turn. */
  knownLimitReached?: true;
}

/** Token-free conversion from local auth/quota projections to routing input. */
export function sanitizedPiAccountHeadroom(
  inspection: PiAccountAuthInspection,
  usageProfiles: readonly PiUsageProfile[],
  modelId = "",
): PiAccountSanitizedHeadroom[] {
  const uniqueRows = <T extends { profileId: string }>(
    rows: readonly T[],
  ): Map<string, T> => {
    const result = new Map<string, T>();
    const duplicates = new Set<string>();
    for (const row of rows) {
      if (result.has(row.profileId)) {
        duplicates.add(row.profileId);
        result.delete(row.profileId);
      } else if (!duplicates.has(row.profileId)) {
        result.set(row.profileId, row);
      }
    }
    return result;
  };
  const authByProfile = uniqueRows(inspection.statuses);
  const usageByProfile = uniqueRows(usageProfiles);
  return inspection.snapshot.profiles.map((profile) => {
    const projectedAuth = authByProfile.get(profile.id);
    const projectedUsage = usageByProfile.get(profile.id);
    // Profile UUIDs are opaque join keys, but provider remains part of the
    // authority boundary. A corrupt cross-provider projection must degrade to
    // unavailable/unknown instead of influencing another provider's route.
    const auth =
      projectedAuth?.provider === profile.provider ? projectedAuth : undefined;
    const usage =
      projectedUsage?.provider === profile.provider ? projectedUsage : undefined;
    const evaluated = evaluateUsageForWorkload(usage, {
      kind: "agent",
      modelId,
    });
    // The auth store is authoritative about whether a credential can still be
    // revived; the usage probe is a best-effort HTTP check that reports
    // "expired" for a refresh it could not complete itself. Letting that probe
    // veto a refreshable credential is a deadlock: the account is dropped from
    // routing, so no session ever launches, so Pi never performs the refresh
    // that would clear the very state keeping it out. A credential that cannot
    // refresh still needs a real reconnect, so the probe keeps its veto there.
    const revivable = Boolean(auth?.connected && (!auth.expired || auth.canRefresh));
    const usageVetoes =
      usage?.status === "not_connected" || (usage?.status === "expired" && !auth?.canRefresh);
    const available = revivable && !usageVetoes;
    return {
      profileId: profile.id,
      available,
      limitReached: evaluated.limitReached,
      headroomPercent:
        evaluated.coverage === "complete"
          ? evaluated.headroomPercent
          : null,
    };
  });
}

/**
 * Rank implicit choices without vendor I/O. The provider's active account —
 * the one Settings marks Active — is supplied as the preferred pin, so it
 * outranks a rival with more cached headroom: Claude and Codex allow only one
 * live login at a time, and the account the user selected is the one that must
 * run. Accounts that are disconnected or already limit-reached are filtered
 * out before ranking, so cached quota still decides the fallback order once
 * the active account cannot serve the turn.
 */
export async function rankImplicitPiAccounts(
  provider: PiSubscriptionProvider,
  modelId = "",
): Promise<PiAccountRouteCandidate[]> {
  const inspection = await inspectPiAccountProfileAuthStore();
  const headroom = sanitizedPiAccountHeadroom(
    inspection,
    inspectCachedPiSubscriptionUsageProfiles(),
    modelId,
  );
  return rankPiAccountCandidates(inspection.snapshot, provider, headroom, {
    preferredProfileId: inspection.snapshot.defaults[provider] ?? null,
  }).map((candidate) => ({
    accountProfileId: candidate.profile.id,
    headroomPercent: candidate.headroomPercent,
  }));
}

export async function selectImplicitPiAccount(
  provider: PiSubscriptionProvider,
  modelId = "",
): Promise<PiAccountRouteCandidate | null> {
  const inspection = await inspectPiAccountProfileAuthStore();
  const headroom = sanitizedPiAccountHeadroom(
    inspection,
    inspectCachedPiSubscriptionUsageProfiles(),
    modelId,
  );
  const preferredProfileId = inspection.snapshot.defaults[provider] ?? null;
  const selected = rankPiAccountCandidates(inspection.snapshot, provider, headroom, {
    preferredProfileId,
  })[0];
  if (selected) {
    return {
      accountProfileId: selected.profile.id,
      headroomPercent: selected.headroomPercent,
    };
  }

  // If every otherwise usable account has a cached limited signal, never fall
  // through to the resolver's mutable default while leaving the run unpinned.
  // Freeze one deterministic exact identity — the active account when it is
  // among them — and the provider's live response then enters the existing
  // rate-limit park flow without credential drift.
  const limitedFallback = rankPiAccountCandidates(
    inspection.snapshot,
    provider,
    headroom.map((signal) => ({ ...signal, limitReached: false })),
    { preferredProfileId },
  )[0];
  return limitedFallback
    ? {
        accountProfileId: limitedFallback.profile.id,
        headroomPercent: limitedFallback.headroomPercent,
        knownLimitReached: true,
      }
    : null;
}
