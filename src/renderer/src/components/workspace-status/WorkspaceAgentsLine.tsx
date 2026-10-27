import { useEffect, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import {
  AGENT_LINE_STATE_LABELS,
  AGENT_LINE_STATE_TONES,
  agentLineAge,
  summarizeWorkspace,
  type AgentLine,
} from "@shared/agent-status";
import { getAgentBoardSources } from "../agent-board/agentBoardSources";
import { useWorkspaceAgentLines } from "./agentLinesStore";
import { useTaskSummary } from "./cosTasksStore";
import "./workspace-agents.css";

// The workspace's one status line under its name in the rail, computed from
// its agents and its task list ("1 needs you · 3 done today"). The number at
// the row's right edge counts the agents, so the line speaks only when
// something needs the user or finished, and an idle workspace has none
// (DESIGN.md, "One home for agent counts"). It is plain text: a click on it
// opens the row like any other click there.
// The agents themselves are listed under the row by rail/WorkspaceChildren,
// which AgentLineItem serves; clicking one opens its tab. A workspace from
// before Codara recorded origins also gets the button that confirms the
// origin URL its gate found: the user's click, which no agent tool can make.

// One minute is the finest age shown.
export function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

const lineText = {
  fontSize: 10.5,
  lineHeight: "13px",
  minWidth: 0,
} as const;

// Stops the row under it from switching workspace. A press inside an element
// marked data-workspace-agents-area never starts the row's drag either
// (WorkspaceRail checks the mark, since dragstart fires on the row itself).
function keepToSelf(event: MouseEvent | KeyboardEvent): void {
  event.stopPropagation();
}

export function StateMark({ state }: { state: AgentLine["state"] }) {
  const tone = AGENT_LINE_STATE_TONES[state];
  if (state === "done") {
    return (
      <span aria-hidden="true" style={{ flex: "0 0 8px", color: tone, fontSize: 9, fontWeight: 700, lineHeight: "13px" }}>
        ✓
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        flex: "0 0 8px",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: tone }} />
    </span>
  );
}

export function AgentLineItem({ line, now, active }: { line: AgentLine; now: number; active: boolean }) {
  const age = agentLineAge(line, now);
  const state = AGENT_LINE_STATE_LABELS[line.state];
  const description = [`${line.name}: ${state}.`, line.text ?? "", age ? `${age}.` : ""].filter(Boolean).join(" ");
  const needsYou = line.state === "needs-you";
  const open = () => {
    if (line.target) void getAgentBoardSources().navigate?.(line.target);
  };
  return (
    <li style={{ listStyle: "none", minWidth: 0 }}>
      <button
        type="button"
        data-testid="workspace-agent-line"
        data-state={line.state}
        title={description}
        aria-label={description}
        disabled={!line.target}
        onClick={(event) => {
          keepToSelf(event);
          open();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") keepToSelf(event);
        }}
        className="workspace-agent-line"
        style={{
          display: "grid",
          gridTemplateColumns: "8px minmax(0, 1fr) auto",
          columnGap: 5,
          alignItems: "center",
          width: "100%",
          minWidth: 0,
          padding: "2px 4px",
          margin: 0,
          border: 0,
          borderRadius: 5,
          background: "transparent",
          color: "inherit",
          font: "inherit",
          textAlign: "left",
          cursor: line.target ? "pointer" : "default",
        }}
      >
        <StateMark state={line.state} />
        <span
          style={{
            ...lineText,
            fontWeight: 600,
            color: needsYou ? "var(--danger)" : active ? "var(--ink-dim)" : "var(--muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {line.name}
        </span>
        <span
          style={{
            ...lineText,
            color: needsYou ? "var(--danger)" : "var(--muted-2)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {age ? `${state.toLowerCase()} · ${age}` : state.toLowerCase()}
        </span>
        {line.text && (
          <span
            data-testid="workspace-agent-line-text"
            style={{
              ...lineText,
              gridColumn: "2 / 4",
              color: needsYou ? "var(--danger)" : "var(--muted)",
              fontStyle: line.fromNote ? undefined : "italic",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {line.text}
          </span>
        )}
      </button>
    </li>
  );
}

function ConfirmOriginButton({ workspaceId, origin }: { workspaceId: string; origin: string }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <button
      type="button"
      data-testid="workspace-tasks-confirm-origin"
      title={`Confirm ${origin} as this workspace's origin`}
      disabled={confirming}
      data-workspace-agents-area=""
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
        ...lineText,
        alignSelf: "flex-start",
        marginTop: 2,
        padding: 0,
        border: 0,
        background: "transparent",
        font: "inherit",
        fontSize: 10.5,
        color: "var(--ink)",
        textDecoration: "underline",
        cursor: confirming ? "default" : "pointer",
      }}
    >
      Confirm origin
    </button>
  );
}

/**
 * The roll-up under a row's name. A project passes `lines` for every agent of
 * its family (its own and its worktrees'), so a folded project still says
 * what waits inside it.
 */
export function WorkspaceAgentsLine({
  workspaceId,
  active = false,
  lines: familyLines,
}: {
  workspaceId: string;
  active?: boolean;
  lines?: readonly AgentLine[];
}) {
  const ownLines = useWorkspaceAgentLines(workspaceId);
  const tasks = useTaskSummary(workspaceId);
  const summary = summarizeWorkspace(familyLines ?? ownLines, tasks, { variant: "rail" });
  if (!summary && !tasks?.originToConfirm) return null;
  return (
    <span data-testid="workspace-agents" style={{ display: "flex", flexDirection: "column", minWidth: 0, marginTop: 2 }}>
      {summary && (
        <span
          role="note"
          aria-label={`${summary.line}. ${summary.description}`}
          title={summary.description}
          data-testid="workspace-agents-summary"
          data-needs-you={summary.needsYou > 0 ? "true" : "false"}
          style={{
            ...lineText,
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 2,
            overflow: "hidden",
            overflowWrap: "anywhere",
            color: active ? "var(--ink-dim)" : "var(--muted)",
          }}
        >
          {summary.parts.map((part, index) => (
            <span key={part.kind}>
              {index > 0 && " · "}
              <span
                data-part={part.kind}
                style={part.kind === "needs-you" ? { color: "var(--danger)", fontWeight: 600 } : undefined}
              >
                {part.text}
              </span>
            </span>
          ))}
        </span>
      )}
      {tasks?.originToConfirm && <ConfirmOriginButton workspaceId={workspaceId} origin={tasks.originToConfirm} />}
    </span>
  );
}
