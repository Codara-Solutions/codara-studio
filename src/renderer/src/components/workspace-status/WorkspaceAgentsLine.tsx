import { useEffect, useState, useSyncExternalStore } from "react";
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
// its agents and its task list ("2 working · 1 needs you · 3 done today").
// Clicking it lists the agents under the row (WorkspaceAgentList), one entry
// each; clicking an agent opens its tab. Which rows are open is a per-window
// convenience kept in localStorage. A workspace from before Codara recorded
// origins also gets the button that confirms the origin URL its gate found:
// the user's click, which no agent tool can make.

const OPEN_KEY = "codara.rail.agentLinesOpen";

function readOpen(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

let openRows: Set<string> | null = null;
const openListeners = new Set<() => void>();

function isOpen(workspaceId: string): boolean {
  openRows ??= readOpen();
  return openRows.has(workspaceId);
}

function setOpen(workspaceId: string, open: boolean): void {
  const next = new Set(openRows ?? readOpen());
  if (open) next.add(workspaceId);
  else next.delete(workspaceId);
  openRows = next;
  for (const listener of openListeners) listener();
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
  } catch {
    // Storage may be unavailable; the row just forgets on reload.
  }
}

function subscribeOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

function useRowOpen(workspaceId: string): boolean {
  return useSyncExternalStore(subscribeOpen, () => isOpen(workspaceId));
}

// One minute is the finest age shown.
function useMinuteClock(enabled: boolean): number {
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

// Stops the row under it from switching workspace or starting a drag.
function keepToSelf(event: MouseEvent | KeyboardEvent): void {
  event.stopPropagation();
}

function StateMark({ state }: { state: AgentLine["state"] }) {
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

function AgentLineItem({ line, now, active }: { line: AgentLine; now: number; active: boolean }) {
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
        onKeyDown={keepToSelf}
        onPointerDown={keepToSelf}
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

/** The workspace's agents, listed under its row while its status line is open. */
export function WorkspaceAgentList({ workspaceId, active = false }: { workspaceId: string; active?: boolean }) {
  const lines = useWorkspaceAgentLines(workspaceId);
  const open = useRowOpen(workspaceId);
  const now = useMinuteClock(open && lines.length > 0);
  if (!open || lines.length === 0) return null;
  return (
    <ul
      data-testid="workspace-agent-lines"
      aria-label="Agents in this workspace"
      style={{ margin: "3px 0 0", padding: "0 0 0 24px", minWidth: 0, width: "100%", boxSizing: "border-box" }}
    >
      {lines.map((line) => (
        <AgentLineItem key={line.key} line={line} now={now} active={active} />
      ))}
    </ul>
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

export function WorkspaceAgentsLine({ workspaceId, active = false }: { workspaceId: string; active?: boolean }) {
  const lines = useWorkspaceAgentLines(workspaceId);
  const tasks = useTaskSummary(workspaceId);
  const open = useRowOpen(workspaceId);
  const summary = summarizeWorkspace(lines, tasks);
  if (!summary) return null;
  const expandable = lines.length > 0;
  const expanded = open && expandable;
  const toggle = () => {
    if (expandable) setOpen(workspaceId, !open);
  };
  const muted = active ? "var(--ink-dim)" : "var(--muted)";
  return (
    <span data-testid="workspace-agents" style={{ display: "flex", flexDirection: "column", minWidth: 0, marginTop: 2 }}>
      <span
        role={expandable ? "button" : "note"}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? expanded : undefined}
        aria-label={`${summary.line}. ${summary.description}`}
        title={summary.description}
        data-testid="workspace-agents-summary"
        data-needs-you={summary.needsYou > 0 ? "true" : "false"}
        onClick={(event) => {
          if (!expandable) return;
          keepToSelf(event);
          toggle();
        }}
        onPointerDown={expandable ? keepToSelf : undefined}
        onKeyDown={(event) => {
          if (!expandable || (event.key !== "Enter" && event.key !== " ")) return;
          keepToSelf(event);
          event.preventDefault();
          toggle();
        }}
        style={{
          ...lineText,
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          overflow: "hidden",
          overflowWrap: "anywhere",
          color: muted,
          cursor: expandable ? "pointer" : undefined,
        }}
      >
        {expandable && (
          <span aria-hidden="true" style={{ display: "inline-block", width: 9, color: "var(--muted-2)" }}>
            {expanded ? "▾" : "▸"}
          </span>
        )}
        {summary.parts.length > 0
          ? summary.parts.map((part, index) => (
              <span key={part.kind}>
                {index > 0 && " · "}
                <span
                  data-part={part.kind}
                  style={part.kind === "needs-you" ? { color: "var(--danger)", fontWeight: 600 } : undefined}
                >
                  {part.text}
                </span>
              </span>
            ))
          : summary.line}
      </span>
      {tasks?.originToConfirm && <ConfirmOriginButton workspaceId={workspaceId} origin={tasks.originToConfirm} />}
    </span>
  );
}
