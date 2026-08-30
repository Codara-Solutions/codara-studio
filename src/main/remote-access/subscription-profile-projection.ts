import type { PiSubscriptionProvider, PiUsageProfile } from "@shared/types";

import { evaluateUsageForWorkload } from "../orchestration/pi-usage-applicability";
import { truncateUtf8 } from "./local-policy";
import type { RemoteSubscriptionProfile, RemoteSubscriptionUsage } from "./rpc";

export const MAX_REMOTE_SUBSCRIPTION_PROFILES = 32;

/**
 * Deliberately narrower than the stored profile: the registry also holds an
 * account fingerprint and the account's email address, and neither is declared
 * here, so neither can be copied onto a phone.
 */
interface SubscriptionProfileMetadata {
  id: string;
  provider: PiSubscriptionProvider;
  label: string;
  /** The paired Claude Code profile of an Anthropic row; an opaque id. */
  cliProfileId?: string;
}

interface SubscriptionTerminalStatus {
  connected: boolean;
  expired: boolean;
}

interface SubscriptionProfileAuthStatus {
  profileId: string;
  connected: boolean;
  expired: boolean;
  canRefresh?: boolean;
}

export interface RemoteSubscriptionProfileProjectionInput {
  snapshot: {
    profiles: readonly SubscriptionProfileMetadata[];
    defaults: Partial<Record<PiSubscriptionProvider, string>>;
  };
  statuses: readonly SubscriptionProfileAuthStatus[];
  /** Token-blind status of each Claude Code profile, keyed by its id. */
  terminals?: ReadonlyMap<string, SubscriptionTerminalStatus>;
}

function projectCachedUsage(
  profile: SubscriptionProfileMetadata,
  configured: boolean,
  cachedByProfileId: ReadonlyMap<string, PiUsageProfile>,
): RemoteSubscriptionUsage | undefined {
  if (!configured) return undefined;
  const cached = cachedByProfileId.get(profile.id);
  if (
    !cached ||
    cached.provider !== profile.provider ||
    cached.status !== "ok"
  ) {
    return undefined;
  }

  // This generic directory has no selected model, so expose normal agent
  // headroom from general windows only. Dedicated code-review and unmapped
  // model buckets stay in Settings; they must not make a healthy chat account
  // look exhausted on the phone.
  const evaluated = evaluateUsageForWorkload(cached, {
    kind: "agent",
    modelId: "",
  });

  return {
    remainingPercent: evaluated.headroomPercent,
    limitReached: evaluated.limitReached,
  };
}

/**
 * Project local profile metadata, coarse auth state and a fresh in-memory
 * usage cache into the deliberately small mobile DTO. Only allowlisted fields
 * are copied; credential paths, provider identities and raw errors cannot
 * cross this boundary even if a caller's objects contain them.
 */
export function projectRemoteSubscriptionProfiles(
  inspection: RemoteSubscriptionProfileProjectionInput,
  cachedUsage: readonly PiUsageProfile[],
  maxProfiles = MAX_REMOTE_SUBSCRIPTION_PROFILES,
): RemoteSubscriptionProfile[] {
  const connected = new Set(
    inspection.statuses
      .filter(
        (status) =>
          status.connected &&
          (!status.expired || status.canRefresh === true),
      )
      .map((status) => status.profileId),
  );
  const cachedByProfileId = new Map(
    cachedUsage.map((usage) => [usage.profileId, usage] as const),
  );
  const limit = Math.max(
    0,
    Math.min(MAX_REMOTE_SUBSCRIPTION_PROFILES, Math.floor(maxProfiles)),
  );

  return inspection.snapshot.profiles
    .map((profile): RemoteSubscriptionProfile => {
      const configured = connected.has(profile.id);
      const usage = projectCachedUsage(profile, configured, cachedByProfileId);
      const cliProfileId =
        profile.provider === "anthropic" && typeof profile.cliProfileId === "string"
          ? profile.cliProfileId
          : undefined;
      const terminal = cliProfileId ? inspection.terminals?.get(cliProfileId) : undefined;
      return {
        id: profile.id,
        provider: profile.provider,
        label: truncateUtf8(profile.label, 160),
        status: configured ? "configured" : "unavailable",
        isDefault: inspection.snapshot.defaults[profile.provider] === profile.id,
        ...(usage ? { usage } : {}),
        ...(cliProfileId ? { cliProfileId } : {}),
        ...(cliProfileId === "personal" ? { builtIn: true as const } : {}),
        ...(terminal
          ? { terminal: { connected: terminal.connected, expired: terminal.expired } }
          : {}),
      };
    })
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        Number(right.isDefault) - Number(left.isDefault) ||
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}
