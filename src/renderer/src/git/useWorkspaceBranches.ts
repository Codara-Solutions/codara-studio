import { useEffect, useRef, useState } from "react";
import type { Workspace } from "@shared/types";
import { useGitRefresh } from "./gitRefreshClock";

// Current branch per workspace for the rail's row subtitle. The shared git
// status only covers the active workspace, so this keeps a light cache for
// every row: read once, then again only for the rows whose git state moved
// (the shared clock, gitRefreshClock.ts, while the window is focused), every
// row after SAFETY_MS, and every row whenever the caller's `refreshKey` moves
// (App feeds it the active workspace's shared-status branch, so a checkout in
// the Source Control panel re-reads every row right away). Main reads the
// branch from HEAD's file when it can, without starting git.
const SAFETY_MS = 5 * 60_000;

export function useWorkspaceBranches(
  workspaces: Workspace[],
  /** Any change here forces an immediate re-read (e.g. the active branch moved). */
  refreshKey = "",
): Record<string, string | null> {
  const [branches, setBranches] = useState<Record<string, string | null>>({});
  const targetsRef = useRef<{ id: string; cwd: string }[]>([]);
  targetsRef.current = workspaces.map((ws) => ({ id: ws.id, cwd: ws.cwd }));
  const inFlight = useRef(false);
  // A read asked for while one is in flight runs once it lands, with the
  // latest targets: the first read at boot starts before the workspaces load,
  // and dropping the one their arrival asks for left every row without its
  // branch until the next read.
  const again = useRef<Set<string> | "all" | null>(null);
  const lastFullAt = useRef(0);
  const latestRefresh = useRef<((only?: ReadonlySet<string>) => Promise<void>) | null>(null);

  useEffect(() => {
    let cancelled = false;
    // `only`: the cwds to re-read; every row when absent.
    const refresh = async (only?: ReadonlySet<string>) => {
      if (inFlight.current) {
        if (!only || again.current === "all") again.current = "all";
        else again.current = new Set([...(again.current ?? []), ...only]);
        return;
      }
      inFlight.current = true;
      try {
        const all = targetsRef.current;
        const targets = only ? all.filter((target) => only.has(target.cwd)) : all;
        if (!only) lastFullAt.current = Date.now();
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
          const next: Record<string, string | null> = only ? { ...prev } : {};
          for (const [id, branch] of results) {
            next[id] = branch;
            if (prev[id] !== branch) changed = true;
          }
          if (!changed && Object.keys(prev).length === Object.keys(next).length) return prev;
          return next;
        });
      } finally {
        inFlight.current = false;
        const pending = again.current;
        again.current = null;
        if (pending) void latestRefresh.current?.(pending === "all" ? undefined : pending);
      }
    };

    latestRefresh.current = refresh;
    void refresh();
    return () => {
      cancelled = true;
      if (latestRefresh.current === refresh) latestRefresh.current = null;
    };
    // Re-run when the set of workspace cwds changes, not on every rename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces.map((ws) => `${ws.id}:${ws.cwd}`).join("|"), refreshKey]);

  useGitRefresh(
    workspaces.map((ws) => ws.cwd),
    false,
    (changed, reason) => {
      if (reason === "tick" && Date.now() - lastFullAt.current >= SAFETY_MS) void latestRefresh.current?.();
      else if (changed.length > 0) void latestRefresh.current?.(new Set(changed));
    },
  );

  return branches;
}
