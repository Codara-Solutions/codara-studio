import type { SessionSearchAgent } from "@shared/session-search";
import { CodaraMark, RuntimeMark } from "../BrandMarks";

/** The agent's mark in its brand color; Cora uses the ink color so it does not shift with the workspace. */
export default function SessionAgentMark({ agent, size = 13 }: { agent: SessionSearchAgent; size?: number }) {
  return (
    <span
      aria-hidden
      className="ss-mark-icon"
      style={{ color: agent === "cora" ? "var(--ink)" : `var(--agent-${agent})` }}
    >
      {agent === "cora" ? <CodaraMark size={size} /> : <RuntimeMark runtime={agent} size={size} />}
    </span>
  );
}
