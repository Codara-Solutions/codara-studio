import { useEffect, useState } from "react";
import { SHARE_UNAVAILABLE_MESSAGE, type ShareStatus } from "@shared/share";

// Whether this build has a share service (src/main/share/availability.ts).
// Main decides once per launch, so the answer is asked for once and shared by
// every editor toolbar.

let cached: ShareStatus | null = null;
let pending: Promise<ShareStatus> | null = null;

export function loadShareStatus(): Promise<ShareStatus> {
  if (cached) return Promise.resolve(cached);
  pending ??= window.spark.share.status().then(
    (status) => (cached = status),
    () => (cached = { available: false, message: SHARE_UNAVAILABLE_MESSAGE }),
  );
  return pending;
}

/** The share status, or null until main answered. */
export function useShareStatus(): ShareStatus | null {
  const [status, setStatus] = useState<ShareStatus | null>(cached);
  useEffect(() => {
    if (status) return;
    let live = true;
    void loadShareStatus().then((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
    };
  }, [status]);
  return status;
}
