/**
 * Cross-workspace runs feed for the walk-away cockpit.
 *
 * App.tsx's lifted `runs` state is scoped to the active workspace
 * (refreshRunsFor → listRuns(workspaceId)), so it can't back surfaces that
 * must see EVERY run regardless of which project is on screen: the global
 * RunSwitcher (Cmd/Ctrl-K), the WorkspaceRail tone dots, and the
 * "While you were away" digest.
 *
 * listRuns() with NO workspaceId returns every run across all workspaces
 * (run-store.ts:354 short-circuits the workspace filter). This hook owns that
 * separate feed: an initial load once booted, then a trailing-debounced
 * re-list on any orchestration event — mirroring App's RUN_REFRESH_DEBOUNCE_MS
 * burst-coalescing so a single run's event storm collapses into one IPC pass.
 *
 * The list is mirrored into a ref (same pattern as App.tsx's runsRef) so
 * consumers that fire outside React's render flow — chiefly the window-focus
 * digest — can read the latest runs without taking `runs` as a dependency.
 */
import React, { useEffect, useRef, useState } from "react";
import type { RunState } from "@shared/types";

export function useGlobalRuns(booted: boolean): {
  runs: RunState[];
  runsRef: React.MutableRefObject<RunState[]>;
  refresh: () => Promise<void>;
} {
  const [runs, setRuns] = useState<RunState[]>([]);

  // Mirror the runs list through a ref so the window-focus digest can read the
  // latest runs without re-subscribing whenever the list changes.
  const runsRef = useRef(runs);
  runsRef.current = runs;

  // Best-effort global re-list. No workspaceId → every run, every workspace.
  // Errors are swallowed (copying App's refreshRunsFor): this is opportunistic
  // and surfaced elsewhere if it matters.
  const refresh = async (): Promise<void> => {
    try {
      const next = await window.spark.orchestration.listRuns();
      setRuns(next);
    } catch {
      /* Surface details elsewhere; this is opportunistic. */
    }
  };

  // Initial load once booted, then trailing-debounce a global refresh on any
  // orchestration event. Unlike App's per-workspace flush there's no workspace
  // filtering here — any event simply re-lists the whole fleet.
  useEffect(() => {
    if (!booted) return undefined;

    void refresh();

    // Trailing-debounce window. A burst of orchestration events (a run going
    // planning → running → N worker events → complete) collapses into a single
    // refresh once events stop arriving for this long.
    const RUN_REFRESH_DEBOUNCE_MS = 250;
    let refreshTimer: number | null = null;

    const off = window.spark.orchestration.onEvent(() => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, RUN_REFRESH_DEBOUNCE_MS);
    });

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      off();
    };
    // booted is the only gate; refresh closes over stable setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted]);

  return { runs, runsRef, refresh };
}
