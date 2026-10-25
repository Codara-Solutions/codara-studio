import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AGENT_LINE_STATE_LABELS,
  AGENT_LINE_STATE_TONES,
  agentLineAge,
  type AgentLine,
} from "@shared/agent-status";
import { AgentLineItem, useMinuteClock } from "../workspace-status/WorkspaceAgentsLine";
import "./workspace-children.css";

// What hangs under a project in the workspace rail (DESIGN.md, "Worktrees in
// the rail"): its own agents, its worktrees on a thin tree line, and its
// merged worktrees folded into one "N merged · Clean up" line. It is a
// sibling of the project's row, not inside it, so the row stays one click
// target; WorkspaceRail counts the block into the row's reorder slot through
// data-rail-children-of and slides it with the row.

export function WorkspaceChildren({
  parentId,
  dragOffset = 0,
  dragging = false,
  ownAgents,
  active,
  merged,
}: {
  parentId: string;
  dragOffset?: number;
  dragging?: boolean;
  ownAgents: readonly AgentLine[];
  /** Worktree rows still in play, already sorted. */
  active: ReactNode[];
  merged: {
    count: number;
    open: boolean;
    onToggle: () => void;
    /** Absent hides Clean up. */
    onCleanUp?: () => void;
    /** The worktrees Clean up removes; more than one asks first. */
    cleanUpNames: readonly string[];
    cleaning: boolean;
    rows: ReactNode[];
  };
}) {
  const now = useMinuteClock(ownAgents.length > 0);
  const [confirming, setConfirming] = useState(false);
  const cleanUp = merged.onCleanUp;
  const asks = Boolean(cleanUp) && merged.cleanUpNames.length > 1;
  // Once there is nothing left to ask about, the question is over: a later
  // merge must not bring it back by itself.
  useEffect(() => {
    if (!asks) setConfirming(false);
  }, [asks]);
  return (
    <div
      data-rail-children-of={parentId}
      data-testid="workspace-children"
      className="rail-children"
      style={{
        opacity: dragging ? 0.4 : 1,
        ...(dragOffset ? { transform: `translate3d(0, ${dragOffset}px, 0)` } : {}),
      }}
    >
      {ownAgents.length > 0 && (
        <ul data-testid="workspace-agent-lines" aria-label="Agents in this workspace" className="rail-children-agents">
          {ownAgents.map((line) => (
            <AgentLineItem key={line.key} line={line} now={now} active={false} />
          ))}
        </ul>
      )}
      {active}
      {merged.count > 0 && (
        <div className="rail-child rail-merged-fold" data-testid="workspace-merged-fold">
          <button
            type="button"
            className="rail-chevron"
            data-testid="workspace-merged-toggle"
            aria-expanded={merged.open}
            title={merged.open ? "Hide merged worktrees" : "Show merged worktrees"}
            onClick={merged.onToggle}
          >
            <Chevron open={merged.open} />
          </button>
          <span style={{ flex: 1, minWidth: 0 }}>{merged.count} merged</span>
          {merged.onCleanUp && (
            <button
              type="button"
              className="rail-merged-clean-up"
              data-testid="workspace-merged-clean-up"
              title="Remove the merged worktrees, their branches and their rows"
              disabled={merged.cleaning}
              onClick={() => (merged.cleanUpNames.length > 1 ? setConfirming(true) : merged.onCleanUp?.())}
            >
              {merged.cleaning ? "Cleaning…" : "Clean up"}
            </button>
          )}
        </div>
      )}
      {confirming && asks && cleanUp && (
        <CleanUpConfirm
          names={merged.cleanUpNames}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            cleanUp();
          }}
        />
      )}
      {merged.open && merged.rows}
    </div>
  );
}

// The rail slides its rows with transforms, so the dialog renders into the
// body to stay fixed to the window.
function CleanUpConfirm({
  names,
  onCancel,
  onConfirm,
}: {
  names: readonly string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Capture, so Escape closes only this and no handler behind it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  const title = `Clean up ${names.length} merged worktrees?`;
  return createPortal(
    <div className="rail-confirm-scrim" onMouseDown={(event) => event.stopPropagation()} onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        data-testid="workspace-merged-clean-up-confirm"
        className="rail-confirm spark-glass--strong spark-overlay-surface"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="rail-confirm-title">{title}</span>
        <span className="rail-confirm-text">Their folders, branches and rows are removed:</span>
        <ul className="rail-confirm-list">
          {names.map((name, index) => (
            <li key={`${index}:${name}`}>{name}</li>
          ))}
        </ul>
        <div className="rail-confirm-buttons">
          <button type="button" autoFocus className="rail-confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="rail-confirm-ok" onClick={onConfirm}>
            Clean up
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" width="8" height="8" viewBox="0 0 10 10" fill="currentColor">
      {open ? <path d="M1 3h8L5 8z" /> : <path d="M3 1v8l5-4z" />}
    </svg>
  );
}

/**
 * A worktree row's second line: its most urgent agent's state, age and note,
 * or what the worktree is when no agent works in it.
 */
export function WorktreeAgentLine({
  agents,
  merged,
  pullRequest,
  baseBranch,
  active,
}: {
  agents: readonly AgentLine[];
  merged: boolean;
  pullRequest: number | null;
  baseBranch?: string;
  active: boolean;
}) {
  const now = useMinuteClock(agents.length > 0);
  const first = agents[0];
  const muted = active ? "var(--ink-dim)" : "var(--muted)";
  if (!first) {
    const text = merged
      ? pullRequest !== null ? `Merged #${pullRequest}` : "Merged"
      : baseBranch ? `No agent · from ${baseBranch}` : "No agent";
    return (
      <span data-testid="worktree-agent-line" data-state="none" className="rail-child-line2" style={{ color: muted }}>
        <span className="rail-child-note" data-testid={merged ? "workspace-merged" : undefined}>{text}</span>
      </span>
    );
  }
  const age = agentLineAge(first, now);
  const word = AGENT_LINE_STATE_LABELS[first.state].toLowerCase();
  const tone = AGENT_LINE_STATE_TONES[first.state];
  const loud = first.state === "needs-you" || first.state === "working";
  const others = agents.length - 1;
  const description = agents
    .map((line) => [`${line.name}: ${AGENT_LINE_STATE_LABELS[line.state]}.`, line.text ?? ""].filter(Boolean).join(" "))
    .join(" ");
  return (
    <span
      data-testid="worktree-agent-line"
      data-state={first.state}
      title={description}
      className="rail-child-line2"
      style={{ color: muted }}
    >
      <span aria-hidden="true" className="rail-child-dot" style={{ background: tone }} />
      <span style={{ color: loud ? tone : muted, fontWeight: first.state === "needs-you" ? 600 : undefined }}>{word}</span>
      {age && <span className="rail-child-age">{age}</span>}
      {others > 0 && <span className="rail-child-age">+{others}</span>}
      {first.text && <span className="rail-child-note">· {first.text}</span>}
    </span>
  );
}
