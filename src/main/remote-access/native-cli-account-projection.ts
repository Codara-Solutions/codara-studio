import type {
  NativeCliAccountsInspection,
  NativeCliAccountRuntime,
} from "../orchestration/native-cli-accounts";

import { truncateUtf8 } from "./local-policy";
import type { RemoteNativeCliAccount } from "./rpc";

export const MAX_REMOTE_NATIVE_CLI_ACCOUNTS = 32;

/**
 * Project the already-sanitized main-process account inspection into an even
 * smaller mobile DTO. The phone can route a future turn, but it never receives
 * config paths, credentials, environment variables, login commands, or raw
 * provider errors — and never the account identity fields the local Settings
 * window is allowed: the fingerprint and the account's email address are both
 * dropped here, by copying an explicit field list rather than spreading.
 */
export function projectRemoteNativeCliAccounts(
  inspection: NativeCliAccountsInspection,
  maxProfiles = MAX_REMOTE_NATIVE_CLI_ACCOUNTS,
): RemoteNativeCliAccount[] {
  const limit = Math.max(
    0,
    Math.min(MAX_REMOTE_NATIVE_CLI_ACCOUNTS, Math.floor(maxProfiles)),
  );

  return inspection.runtimes
    .flatMap((group) =>
      group.profiles.map(
        (profile): RemoteNativeCliAccount => ({
          runtime: profile.runtime as NativeCliAccountRuntime,
          id: profile.id,
          label: truncateUtf8(profile.label, 160),
          status:
            profile.connected && profile.status === "connected"
              ? "connected"
              : profile.status === "sign_in_required"
                ? "sign_in_required"
                : "unavailable",
          isDefault: profile.isDefault,
        }),
      ),
    )
    .sort(
      (left, right) =>
        left.runtime.localeCompare(right.runtime) ||
        Number(right.isDefault) - Number(left.isDefault) ||
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}
