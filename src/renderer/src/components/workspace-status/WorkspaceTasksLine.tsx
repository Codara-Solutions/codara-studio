import { useState } from "react";

import { useTaskSummary } from "./cosTasksStore";

// Each line wraps to at most two rows at the rail's default width; the
// full text stays in the tooltip and the aria-label.
const lineStyle = {
  minWidth: 0,
  fontSize: 10.5,
  lineHeight: "13px",
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
  overflowWrap: "anywhere",
} as const;

// The workspace's task list under its name in the rail: the count line
// computed from the tasks ("3 running · 1 needs you · 5 done today"), and
// when something waits on the user, the one sentence that says why. A
// workspace from before Codara recorded origins also gets the button that
// confirms the origin URL its gate found: the user's click, which no agent
// tool can make.
export function WorkspaceTasksLine({ workspaceId, active = false }: { workspaceId: string; active?: boolean }) {
  const summary = useTaskSummary(workspaceId);
  const [confirming, setConfirming] = useState(false);
  if (!summary) return null;
  const origin = summary.originToConfirm;
  const waiting = summary.needsYou;
  const description = waiting
    ? `${summary.line}. ${waiting.taskId} ${waiting.title} needs you: ${waiting.reason}`
    : summary.line;
  return (
    <span
      data-testid="workspace-tasks"
      role="note"
      aria-label={`Tasks: ${description}`}
      title={description}
      style={{ display: "flex", flexDirection: "column", minWidth: 0, marginTop: 2 }}
    >
      <span data-testid="workspace-tasks-line" style={{ ...lineStyle, color: active ? "var(--ink-dim)" : "var(--muted)" }}>
        {summary.line}
      </span>
      {waiting && (
        <span data-testid="workspace-tasks-needs-you" style={{ ...lineStyle, color: "var(--danger)" }}>
          {waiting.reason || `${waiting.taskId} needs you`}
        </span>
      )}
      {origin && (
        <button
          type="button"
          data-testid="workspace-tasks-confirm-origin"
          title={`Confirm ${origin} as this workspace's origin`}
          disabled={confirming}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setConfirming(true);
            void window.spark?.cosTasks
              ?.confirmOrigin(workspaceId, origin)
              .catch(() => false)
              .finally(() => setConfirming(false));
          }}
          style={{
            alignSelf: "flex-start",
            marginTop: 2,
            padding: 0,
            border: 0,
            background: "transparent",
            font: "inherit",
            fontSize: 10.5,
            lineHeight: "13px",
            color: "var(--ink)",
            textDecoration: "underline",
            cursor: confirming ? "default" : "pointer",
          }}
        >
          Confirm origin
        </button>
      )}
    </span>
  );
}
