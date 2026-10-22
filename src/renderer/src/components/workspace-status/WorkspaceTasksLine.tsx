import { useTaskSummary } from "./cosTasksStore";

const lineStyle = {
  minWidth: 0,
  fontSize: 10.5,
  lineHeight: "13px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

// The workspace's task list under its name in the rail: the count line
// computed from the tasks ("3 running · 1 needs you · 5 done today"), and
// when something waits on the user, the one sentence that says why.
export function WorkspaceTasksLine({ workspaceId, active = false }: { workspaceId: string; active?: boolean }) {
  const summary = useTaskSummary(workspaceId);
  if (!summary) return null;
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
    </span>
  );
}
