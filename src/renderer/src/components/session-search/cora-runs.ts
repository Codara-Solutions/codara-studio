import type { RunState, ScheduledJob, WorkerAttemptStatus } from "@shared/types";
import type { Tab } from "../../tabs/types";

// What a Cora row in the session picker is, where opening it lands, and
// whether it may be deleted from there. The index only knows a run's words;
// these facts come from the run itself, read when the row is selected.

export type CoraRunKind = "chat" | "loom-pass" | "automation-run";

export const CORA_RUN_KIND_LABEL: Record<CoraRunKind, string> = {
  chat: "Cora chat",
  "loom-pass": "Loom pass",
  "automation-run": "Automation run",
};

export interface CoraRunFacts {
  kind: CoraRunKind;
  /** False when the run's folder is gone and the index has not caught up. */
  exists: boolean;
  /** Working now, or stopped with a worker still going. */
  live: boolean;
  /** A tab shows this run now: its chat, its Runs tab or its workers. */
  openInTab: boolean;
  /** The automations hub lists this pass: its Loom still exists and keeps it in its history. */
  shownInHub: boolean;
  /** The Loom or automation that ran it still exists. */
  ownerExists: boolean;
}

export type CoraPrimary =
  | { action: "open-chat"; label: string }
  | { action: "open-hub"; label: string }
  | { action: "view"; label: string; notice: string };

const ACTIVE_ATTEMPTS = new Set<WorkerAttemptStatus>(["preparing", "prompt_ready", "launching", "running", "finishing"]);
const WORKING = new Set<RunState["status"]>(["planning", "running", "reviewing"]);

type RunShape = Pick<RunState, "automationId" | "workflow" | "executionMode">;

export function coraRunKind(run: RunShape): CoraRunKind {
  if (run.workflow) return "automation-run";
  if (run.automationId) return run.executionMode === "direct" ? "loom-pass" : "automation-run";
  return "chat";
}

export function runHasLiveWork(run: Pick<RunState, "status" | "workerAttempts">): boolean {
  if (WORKING.has(run.status)) return true;
  return (run.workerAttempts ?? []).some((attempt) => ACTIVE_ATTEMPTS.has(attempt.status));
}

/** A tab in any workspace's saved layout that shows this run. */
export function runShownInTab(layouts: readonly { tabs: readonly Tab[] }[], runId: string): boolean {
  return layouts.some((layout) =>
    layout.tabs.some(
      (tab) =>
        (tab.kind === "chat" && tab.id === runId) ||
        (tab.kind === "runs" && tab.runId === runId) ||
        (tab.kind === "terminal" && tab.scope?.kind === "workers" && tab.scope.runId === runId),
    ),
  );
}

export function coraRunFacts(
  run: RunState | null,
  jobs: readonly Pick<ScheduledJob, "id" | "history">[] | null,
  openInTab: boolean,
): CoraRunFacts {
  if (!run) return { kind: "chat", exists: false, live: false, openInTab, shownInHub: false, ownerExists: false };
  const kind = coraRunKind(run);
  const owner = jobs?.find((job) => job.id === run.automationId);
  // The Workflows view lists every workflow run; a Loom shows only the passes its history keeps.
  const shownInHub = kind !== "chat" && (!!run.workflow || !!owner?.history.some((record) => record.runId === run.id));
  return { kind, exists: true, live: runHasLiveWork(run), openInTab, shownInHub, ownerExists: !!run.workflow || !!owner };
}

export function coraPrimary(facts: CoraRunFacts): CoraPrimary {
  if (!facts.exists) {
    return {
      action: "view",
      label: "View",
      notice: "This run is no longer on this computer. What the index kept of it is below, read only.",
    };
  }
  if (facts.kind === "chat") return { action: "open-chat", label: facts.openInTab ? "Go to its tab" : "Open chat" };
  if (facts.shownInHub) {
    return { action: "open-hub", label: facts.kind === "loom-pass" ? "Open pass in Automations" : "Open run in Automations" };
  }
  const owner = facts.kind === "loom-pass" ? "Loom" : "automation";
  return {
    action: "view",
    label: "View",
    notice: facts.ownerExists
      ? `Its ${owner} no longer lists it in its history, so it is shown here, read only.`
      : `Its ${owner} was deleted, so it is shown here, read only.`,
  };
}

/** Why the picker does not offer Delete for this run, or null when it does. */
export function coraDeleteBlock(facts: CoraRunFacts): string | null {
  if (!facts.exists) return "Already gone from this computer.";
  if (facts.live) return "Working now, so it can't be deleted. Stop it first.";
  if (facts.openInTab) return "Open in a tab now, so it can't be deleted here. Close that tab first.";
  return null;
}
