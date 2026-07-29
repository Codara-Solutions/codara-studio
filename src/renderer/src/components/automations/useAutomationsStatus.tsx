// Shared live-status read for the Automations entry points: the new-chat
// welcome row (WelcomeAutomations) and the inner tab strip's affordance
// (AutomationsStripButton). One workspace-scoped subscription shape — the
// scheduler list filtered to this workspace, refreshed on automation events —
// so every door to the Automations tab derives "running / blocked / armed"
// from exactly the same logic the page itself uses.

import React, { useEffect, useState } from "react";
import type { ScheduledJob } from "@shared/types";
import { loomState } from "./presentation";

export interface AutomationsStatus {
  // null = first read in flight; callers render their idle shape meanwhile.
  jobs: ScheduledJob[] | null;
  running: ScheduledJob | null;
  blocked: ScheduledJob | null;
  // The automation deserving the live cue right now: a blocked one beats a
  // running one (it needs the user), null when neither exists.
  live: ScheduledJob | null;
  // Enabled automations armed and waiting for their trigger.
  armed: number;
}

export function useAutomationsStatus(workspaceId: string): AutomationsStatus {
  const [jobs, setJobs] = useState<ScheduledJob[] | null>(null);
  useEffect(() => {
    let disposed = false;
    setJobs(null);
    const refresh = (): void => {
      window.spark.scheduler
        .list()
        .then((list) => {
          if (!disposed) setJobs(list.filter((job) => job.input.workspaceId === workspaceId));
        })
        .catch(() => {
          if (!disposed) setJobs((curr) => curr ?? []);
        });
    };
    refresh();
    const unsubscribe = window.spark.orchestration.onEvent((event) => {
      if (event.type === "automation.updated" || event.type === "automation.iteration") refresh();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [workspaceId]);

  const running = jobs?.find((j) => j.state.status === "running") ?? null;
  const blocked = jobs?.find((j) => j.state.status === "blocked") ?? null;
  return {
    jobs,
    running,
    blocked,
    live: blocked ?? running,
    armed: jobs?.filter((j) => loomState(j).kind === "armed").length ?? 0,
  };
}

// The automations glyph: a lightning bolt, shared by the welcome row, the
// strip affordance, and the Automations tab icon so every door keeps one
// identity. Deliberately NOT a clock — the chat-history button next door is a
// clock (HistoryIcon), and at 12px two clocks read as the same control.
export function AutomationsGlyph({ size = 13 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7.9 1.4 3.9 7.9h2.7L6.1 12.6l4-6.5H7.4l.5-4.7Z" />
    </svg>
  );
}
