import { LOOM_HOLDS_RUN, RUN_IS_WORKING, loomHoldsRun, runHasLiveWork } from "@shared/run-delete-guard";
import type { RunState, ScheduledJob } from "@shared/types";
import type { Tab } from "../../tabs/types";

// What a Cora row in the session picker is, where opening it lands, and
// whether it may be deleted from there. The index only knows a run's words;
// these facts come from the run itself, read when the row is selected.

export type CoraRunKind = "chat" | "loom-pass" | "automation-run" | "workflow-run";

export const CORA_RUN_KIND_LABEL: Record<CoraRunKind, string> = {
  chat: "Cora chat",
  "loom-pass": "Loom pass",
  "automation-run": "Automation run",
  "workflow-run": "Workflow run",
};

const OWNER_NOUN: Record<Exclude<CoraRunKind, "chat">, string> = {
  "loom-pass": "Loom",
  "automation-run": "automation",
  "workflow-run": "workflow",
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
  /** A Loom still holds it as its current run: a later pass would be added to it. */
  heldByLoom: boolean;
  /** Its Loom's list could not be read, so whether a Loom holds it is unknown. */
  loomsUnknown: boolean;
  /** How many passes of its Loom's history ran in this one run (a Loom reuses its run across a cycle). */
  passCount: number;
}

export type CoraPrimary =
  | { action: "open-chat"; label: string }
  | { action: "open-hub"; label: string }
  | { action: "view"; label: string; notice: string };

type RunShape = Pick<RunState, "automationId" | "workflow" | "executionMode">;

export function coraRunKind(run: RunShape): CoraRunKind {
  if (run.workflow) return "workflow-run";
  if (run.automationId) return run.executionMode === "direct" ? "loom-pass" : "automation-run";
  return "chat";
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

/** `jobs` is null when the Looms could not be listed. */
export function coraRunFacts(
  run: RunState | null,
  jobs: readonly Pick<ScheduledJob, "id" | "history" | "state">[] | null,
  openInTab: boolean,
): CoraRunFacts {
  const none = { heldByLoom: false, loomsUnknown: false, passCount: 0 };
  if (!run) return { kind: "chat", exists: false, live: false, openInTab, shownInHub: false, ownerExists: false, ...none };
  const kind = coraRunKind(run);
  const owner = jobs?.find((job) => job.id === run.automationId);
  const passCount = owner?.history.filter((record) => record.runId === run.id).length ?? 0;
  // The Workflows view lists every workflow run; a Loom shows only the passes its history keeps.
  const shownInHub = kind === "workflow-run" || (kind !== "chat" && passCount > 0);
  return {
    kind,
    exists: true,
    live: runHasLiveWork(run),
    openInTab,
    shownInHub,
    ownerExists: kind === "workflow-run" || !!owner,
    heldByLoom: !!jobs && loomHoldsRun(jobs, run.id),
    loomsUnknown: !!run.automationId && kind !== "workflow-run" && jobs === null,
    passCount,
  };
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
  const owner = OWNER_NOUN[facts.kind];
  return {
    action: "view",
    label: "View",
    notice: facts.loomsUnknown
      ? "Its Loom could not be read, so it is shown here, read only."
      : facts.ownerExists
        ? `Its ${owner} no longer lists it in its history, so it is shown here, read only.`
        : `Its ${owner} was deleted, so it is shown here, read only.`,
  };
}

/** Why the picker does not offer Delete for this run, or null when it does. */
export function coraDeleteBlock(facts: CoraRunFacts): string | null {
  if (!facts.exists) return "Already gone from this computer.";
  if (facts.live) return RUN_IS_WORKING;
  if (facts.heldByLoom) return LOOM_HOLDS_RUN;
  if (facts.loomsUnknown) return "Could not read its Loom, so it is not deleted from here.";
  if (facts.openInTab) return "Open in a tab now, so it can't be deleted here. Close that tab first.";
  return null;
}

/** What the confirm says goes, and what stays. */
export function coraDeleteConfirm(facts: CoraRunFacts): string {
  const learned = "with what Cora learned from";
  if (facts.kind === "chat") return `Deletes this chat and its saved output from this computer, ${learned} it.`;
  const owner = OWNER_NOUN[facts.kind];
  if (facts.passCount > 1) {
    return `Deletes these ${facts.passCount} passes, which ran in this one run, and their saved output from this computer, ${learned} them. Its ${owner} stays.`;
  }
  const others = facts.kind === "workflow-run" ? "other runs" : "other passes";
  const stays = facts.ownerExists ? `Its ${owner} and its ${others} stay.` : `Its ${others} stay.`;
  return `Deletes this run and its saved output from this computer, ${learned} it. ${stays}`;
}
