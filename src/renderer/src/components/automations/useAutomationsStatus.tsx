// Shared live-status read for the Automations entry points: the new-chat
// welcome row (WelcomeAutomations) and the inner tab strip's affordance
// (AutomationsStripButton). One workspace-scoped subscription shape — the
// scheduler list filtered to this workspace, refreshed on automation events —
// so every door to the Automations tab derives "running / blocked / armed"
// from exactly the same logic the page itself uses.

import { useEffect, useState } from "react";
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
