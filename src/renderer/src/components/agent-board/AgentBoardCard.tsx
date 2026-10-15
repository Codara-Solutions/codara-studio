import { memo } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { formatAgentElapsed, type AgentBoardCard as Card } from "@shared/agent-board";
import { CodaraMark, RuntimeMark } from "../BrandMarks";
import { agentBrandColor } from "../../lib/agent-brand";
import AgentReplyBox from "./AgentReplyBox";

// One agent on the Agents view. The summary is a button that opens the agent
// (switches workspace, focuses its pane or chat); a Needs you card carries
// its reply box below, outside the button. A terminal agent waiting in a
// menu gets a button to its pane instead: text pasted into a menu could
// pick an answer the user did not choose.

interface Props {
  card: Card;
  /** Elapsed time, already formatted, so a tick re-renders only what changed. */
  elapsed: string | null;
  active: boolean;
  focusable: boolean;
  onOpen: (card: Card) => void;
  onFocusCard: (key: string) => void;
}

function AgentBoardCardView({ card, elapsed, active, focusable, onOpen, onFocusCard }: Props) {
  const mark =
    card.runtime === "cora" ? (
      <span className="agent-card__mark" style={{ color: "var(--accent)" }}>
        <CodaraMark size={13} />
      </span>
    ) : (
      <span className="agent-card__mark" style={{ color: agentBrandColor(card.runtime) }}>
        <RuntimeMark runtime={card.runtime} size={13} />
      </span>
    );
  const meta = [card.agentLabel, card.account, card.detail].filter(Boolean).join(" · ");
  const spoken = [
    card.title,
    card.status,
    `${card.agentLabel} in ${card.workspaceName}`,
    card.account ? `account ${card.account}` : null,
    elapsed && elapsed !== "now" ? `for ${elapsed}` : null,
    card.tool ? `running ${card.tool}` : null,
    card.message,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <li
      className={`agent-card is-${card.tone}${active ? " is-active" : ""}${card.unseen ? " is-unseen" : ""}`}
      data-agent-card={card.key}
      data-agent-bucket={card.bucket}
      data-agent-workspace={card.workspaceId}
      style={{ "--agent-card-ws": card.workspaceColor ?? "var(--muted)" } as CSSProperties}
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
          {elapsed && <span className="agent-card__elapsed">{elapsed}</span>}
        </span>
        <span className="agent-card__meta">
          <span className="agent-card__status">{card.status}</span>
          <span className="agent-card__ws">
            <span className="agent-card__ws-dot" aria-hidden />
            <span className="agent-card__ws-name">{card.workspaceName}</span>
          </span>
          {meta && <span className="agent-card__who">{meta}</span>}
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

export function cardElapsed(card: Card, now: number): string | null {
  return card.since > 0 ? formatAgentElapsed(Math.max(0, now - card.since)) : null;
}

export default memo(AgentBoardCardView);
