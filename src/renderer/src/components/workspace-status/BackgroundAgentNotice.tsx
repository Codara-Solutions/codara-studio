import { getAgentBoardSources } from "../agent-board/agentBoardSources";
import { useWorkspaceAgentLines } from "./agentLinesStore";

// A background agent working in this worktree runs inside the session that
// started it, so nothing in this workspace shows it: a tab here is empty or
// someone else's. One line says where the work really is.
export function BackgroundAgentNotice({ workspaceId }: { workspaceId: string }) {
  const lines = useWorkspaceAgentLines(workspaceId);
  const origin = lines.find((line) => line.origin)?.origin ?? null;
  if (!origin) return null;
  const target = origin.target;
  return (
    <div
      data-testid="background-agent-notice"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 12px",
        borderBottom: "1px solid var(--rule)",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        minWidth: 0,
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        A background agent works in this folder, from the session {origin.name ? `in ${origin.name}` : "that started it"}.
      </span>
      {target && (
        <button
          type="button"
          className="spark-btn"
          data-testid="background-agent-open-origin"
          onClick={() => void getAgentBoardSources().navigate?.(target)}
        >
          Open that session
        </button>
      )}
    </div>
  );
}
