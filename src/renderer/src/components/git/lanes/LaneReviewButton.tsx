import React, { useMemo, useRef, useState } from "react";
import { isRemotePath } from "@shared/remote";
import type { SourceLane } from "@shared/source-lanes";
import { emitLocalToast } from "../../../notifications/local-toast";
import { useOptionalSelectionRouting } from "../../../routing/SelectionRoutingContext";
import { dismissAgentReview, useAgentReviewOf } from "../../review/agentReviewStore";
import ReviewMenu from "../../review/ReviewMenus";
import { requestReviewAgainstBase } from "../../review/review-view-prefs";
import { defaultReviewer, REVIEWER_STORAGE_KEY, reviewerTargets, type ReviewerTarget } from "./reviewer-targets";

// "Review with agent" on a lane: the user picks who reviews, the other model
// family from the writer preselected. The review's findings come back on their
// own and land on the diff as notes.

function remembered(): string | null {
  try {
    return window.localStorage.getItem(REVIEWER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    window.localStorage.setItem(REVIEWER_STORAGE_KEY, id);
  } catch {
    // Storage can be unavailable; the default pick still works.
  }
}

async function startReview(lane: SourceLane, target: ReviewerTarget, route: ReturnType<typeof useOptionalSelectionRouting>): Promise<void> {
  const request = {
    workspaceId: lane.workspaceId!,
    cwd: lane.path,
    branch: lane.branch,
    base: lane.changes?.base ?? null,
    reviewer: target.name,
  };
  if (target.kind === "agent-new") {
    await window.spark.review.startAgentReview({ ...request, runtime: target.runtime });
    return;
  }
  const { state, brief } = await window.spark.review.prepareAgentReview(request);
  try {
    if (target.kind === "chat-new") {
      if (!route) throw new Error("Cora is not available here.");
      await route.route({ source: "tab", text: brief }, "chat-new", { submit: true });
      return;
    }
    const workspaceId = route?.workspaceId ?? lane.workspaceId!;
    const delivery =
      target.kind === "pane"
        ? ({ kind: "pane", paneId: target.id.slice("pane:".length) } as const)
        : ({ kind: "chat", runId: target.id.slice("chat:".length) } as const);
    await window.spark.agentDelivery.deliver({ workspaceId, target: delivery, text: brief, submit: true, source: "review" });
  } catch (cause) {
    dismissAgentReview(state);
    throw cause;
  }
}

export default function LaneReviewButton({ lane }: { lane: SourceLane }): React.ReactElement | null {
  const routing = useOptionalSelectionRouting();
  const review = useAgentReviewOf(lane.workspaceId);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const targets = useMemo(
    () => (open ? reviewerTargets(routing?.destinationsFor(null).destinations ?? []) : []),
    [open, routing],
  );
  if (!lane.workspaceId || isRemotePath(lane.path)) return null;
  if (review?.status === "running") {
    return (
      <button
        type="button"
        className="lane-action"
        data-testid="source-lane-review-running"
        title={`${review.reviewer} is reviewing this. Click to stop waiting for it; the agent keeps its tab.`}
        onClick={() => dismissAgentReview(review)}
      >
        Reviewing · {review.reviewer}
      </button>
    );
  }
  const reviewerLine = review?.reviewerPaneId ? `pane:${review.reviewerPaneId}` : null;
  const writer = lane.agents.find((line) => line.key !== reviewerLine)?.name ?? lane.creator ?? null;
  return (
    <>
      {review?.status === "done" && (review.count ?? 0) > 0 ? (
        <button
          type="button"
          className="lane-action"
          data-testid="source-lane-findings"
          onClick={() => requestReviewAgainstBase(lane.workspaceId!)}
        >
          {review.count === 1 ? "1 finding" : `${review.count} findings`}
        </button>
      ) : null}
      <button
        type="button"
        ref={buttonRef}
        className="lane-action"
        data-testid="source-lane-review-agent"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="An agent reads this change and leaves its findings on the diff. Spends that agent's usage."
        disabled={starting}
        onClick={() => setOpen((value) => !value)}
      >
        {starting ? "Starting…" : "Review with agent"}
      </button>
      {open ? (
        <ReviewMenu
          anchor={buttonRef.current}
          label="Who reviews this"
          testId="source-lane-reviewer-menu"
          rows={targets.map((target) => ({
            id: target.id,
            label: target.label,
            sublabel: target.sublabel,
            group: target.group,
            disabled: target.disabled,
            disabledReason: target.disabledReason,
          }))}
          groups={[
            { id: "new", title: "New agent" },
            { id: "running", title: "Running agents" },
          ]}
          selectedId={defaultReviewer(targets, writer, remembered())}
          onChoose={(id) => {
            const target = targets.find((candidate) => candidate.id === id);
            setOpen(false);
            if (!target || target.disabled) return;
            remember(target.id);
            setStarting(true);
            void startReview(lane, target, routing)
              .catch((cause: unknown) =>
                emitLocalToast("Could not start the review", cause instanceof Error ? cause.message : String(cause), "danger"),
              )
              .finally(() => setStarting(false));
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
