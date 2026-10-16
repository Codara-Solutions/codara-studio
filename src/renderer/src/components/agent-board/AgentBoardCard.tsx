import { memo } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { agentCardTime, type AgentBoardCard as Card, type AgentCardTime } from "@shared/agent-board";
import { CodaraMark, RuntimeMark } from "../BrandMarks";
import { agentBrandColor } from "../../lib/agent-brand";
import { WORKSPACE_STATUS_LABELS } from "@shared/workspace-status";
import { WorkspaceStatusChip } from "../workspace-status/WorkspaceStatusChip";
import { useWorkspaceStatus } from "../workspace-status/workspaceStatusStore";
import { WorkspaceIconGlyph } from "../workspace-icons";
import { normalizeWorkspaceColor, workspaceAccentInk } from "@shared/workspace-colors";
import AgentReplyBox from "./AgentReplyBox";

// One agent on the Agents view. The summary is a button that opens the agent
// (switches workspace, focuses its pane or chat); a Needs you card carries
// its reply box below, outside the button. A terminal agent waiting in a
// menu gets a button to its pane instead: text pasted into a menu could
// pick an answer the user did not choose.

interface Props {
  card: Card;
  /** The status phrase with its time, already formatted, so a tick re-renders only what changed. */
  time: string | null;
  /** The exact moment, for the tooltip. */
  timeTitle: string | null;
  active: boolean;
  /** The card's workspace is the one the user is in. */
  here: boolean;
  focusable: boolean;
  onOpen: (card: Card) => void;
  onFocusCard: (key: string) => void;
}

function AgentBoardCardView({ card, time, timeTitle, active, here, focusable, onOpen, onFocusCard }: Props) {
  // The workspace's status (set by an agent or by hand in the rail), so the
  // card says where the work stands as well as what the agent does.
  const workspaceStatus = useWorkspaceStatus(card.workspaceId)?.status ?? null;
  // The harness is the mark alone; its name stays in the tooltip and in what
  // a screen reader hears. Cora's mark is plain ink, not the accent, which
  // follows the active workspace and would repaint it on every switch.
  const mark = (
    <span
      className="agent-card__mark"
      role="img"
      aria-label={card.agentLabel}
      title={card.agentLabel}
      data-agent-runtime={card.runtime}
      style={{ color: card.runtime === "cora" ? "var(--ink)" : agentBrandColor(card.runtime) }}
    >
      {card.runtime === "cora" ? <CodaraMark size={14} /> : <RuntimeMark runtime={card.runtime} size={14} />}
    </span>
  );
  const meta = [card.account, card.detail].filter(Boolean).join(" · ");
  const spoken = [
    card.title,
    time ?? card.status,
    `${card.agentLabel} in ${card.workspaceName}${here ? ", the workspace you are in" : ""}`,
    workspaceStatus ? `workspace ${WORKSPACE_STATUS_LABELS[workspaceStatus]}` : null,
    card.account ? `account ${card.account}` : null,
    time,
    card.tool ? `running ${card.tool}` : null,
    card.message,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <li
      className={`agent-card is-${card.tone}${active ? " is-active" : ""}${here ? " is-here" : ""}${card.unseen ? " is-unseen" : ""}`}
      data-agent-card={card.key}
      data-agent-bucket={card.bucket}
      data-agent-workspace={card.workspaceId}
      data-agent-sleeping={card.sleeping ? "true" : undefined}
      // The workspace's own colour, fixed per workspace (see
      // agentBoardWorkspaceColor): the edge and the tile say where the agent
      // is, the status label says how it is doing.
      style={{ "--agent-card-ws": card.workspaceColor, "--agent-card-ws-ink": tileInk(card.workspaceColor) } as CSSProperties}
      // Focus anywhere in the card (its reply box too) makes it the card
      // focus returns to if it moves to another group.
      onFocus={() => onFocusCard(card.key)}
    >
      <button
        type="button"
        className="agent-card__open"
        data-agent-card-open={card.key}
        tabIndex={focusable ? 0 : -1}
        aria-label={spoken}
        aria-current={active ? "true" : undefined}
        title={card.message ?? card.title}
        onClick={() => onOpen(card)}
      >
        <span className="agent-card__head">
          {mark}
          <span className="agent-card__title">{card.title}</span>
        </span>
        <span className="agent-card__where">
          <span className="agent-card__ws-tile" aria-hidden title={here ? "You are in this workspace" : undefined}>
            <WorkspaceIconGlyph icon={card.workspaceIcon ?? undefined} size={11} />
          </span>
          <span className="agent-card__ws-name">{card.workspaceName}</span>
          {workspaceStatus && <WorkspaceStatusChip status={workspaceStatus} />}
          {meta && <span className="agent-card__who">{meta}</span>}
          <span className="agent-card__status" title={timeTitle ?? undefined}>
            {time ?? card.status}
          </span>
        </span>
        {card.tool && <span className="agent-card__tool">{card.tool}</span>}
        {card.message && <span className="agent-card__message">{card.message}</span>}
      </button>
      {card.reply?.kind === "pane-dialog" ? (
        <div className="agent-card__reply">
          <button
            type="button"
            className="agent-card__answer"
            aria-label={`Answer ${card.agentLabel} in its terminal in ${card.workspaceName}`}
            title="Its prompt is a menu that takes keys, so you answer it in the terminal"
            onClick={() => onOpen(card)}
            onKeyDown={backToCard}
          >
            Answer in terminal
          </button>
        </div>
      ) : (
        card.reply && <AgentReplyBox key={replyKey(card)} card={card} />
      )}
    </li>
  );
}

// The glyph on the solid "you are here" tile, dark or light by the colour,
// as the rail's active tile picks it.
function tileInk(color: string): string {
  const hex = normalizeWorkspaceColor(color);
  return hex ? workspaceAccentInk(hex) : "#10100E";
}

// Escape leaves the card's controls for the card, where the arrows move on.
function backToCard(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Escape") return;
  event.currentTarget
    .closest("[data-agent-card]")
    ?.querySelector<HTMLButtonElement>("[data-agent-card-open]")
    ?.focus();
}

// A new question is a new box: a draft typed for the last one is dropped.
function replyKey(card: Card): string {
  const reply = card.reply;
  if (!reply) return card.key;
  return reply.kind === "question" ? `${card.key}:${reply.questionMessageId}` : card.key;
}

export function cardTime(card: Card, now: number): AgentCardTime | null {
  return agentCardTime(card, now);
}

export default memo(AgentBoardCardView);
