import { useEffect, useRef, useState } from "react";
import type { Workspace } from "@shared/types";

// Current branch per workspace for the rail's row subtitle. The shared git
// status only covers the active workspace, so this keeps a light cache for
// every row: one `rev-parse` per workspace on a slow poll, refreshed early
// when the window regains focus (the moment a branch is most likely to have
// changed under us), and whenever the caller's `refreshKey` moves (App feeds
// it the active workspace's shared-status branch, so a checkout in the
// Source Control panel re-reads every row right away).
const POLL_MS = 45_000;

export function useWorkspaceBranches(
  workspaces: Workspace[],
  /** Any change here forces an immediate re-read (e.g. the active branch moved). */
  refreshKey = "",
): Record<string, string | null> {
  const [branches, setBranches] = useState<Record<string, string | null>>({});
  const targetsRef = useRef<{ id: string; cwd: string }[]>([]);
  targetsRef.current = workspaces.map((ws) => ({ id: ws.id, cwd: ws.cwd }));
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const targets = targetsRef.current;
        const results = await Promise.all(
          targets.map(async ({ id, cwd }) => {
            try {
              return [id, await window.spark.git.currentBranch(cwd)] as const;
            } catch {
              return [id, null] as const;
            }
          }),
        );
        if (cancelled) return;
        setBranches((prev) => {
          let changed = false;
          const next: Record<string, string | null> = {};
          for (const [id, branch] of results) {
            next[id] = branch;
            if (prev[id] !== branch) changed = true;
          }
          if (!changed && Object.keys(prev).length === results.length) return prev;
          return next;
        });
      } finally {
        inFlight.current = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    // Re-run when the set of workspace cwds changes, not on every rename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces.map((ws) => `${ws.id}:${ws.cwd}`).join("|"), refreshKey]);

  return branches;
}
