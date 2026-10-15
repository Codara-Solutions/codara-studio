import { useEffect, useRef, useState } from "react";
import type { AgentBoardCard } from "@shared/agent-board";
import { isQuestionInactiveError } from "@shared/run-questions";
import { unwrapIpcError } from "../../lib/ipc-error";
import { getAgentBoardSources } from "./agentBoardSources";

// The reply box on a Needs you card. A terminal agent stopped by an error is
// back at its prompt and gets the text pasted there and submitted, as if
// typed; a Cora question gets an answer (its options as buttons), and a
// paused or waiting chat a message. A terminal agent waiting in a menu has no
// box (AgentBoardCard opens its pane instead).

type Phase = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

const SENT_MS = 2_500;

function clientMessageId(): string {
  return `agents-view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function sendReply(card: AgentBoardCard, text: string): Promise<void> {
  const reply = card.reply;
  // A pane waiting in a menu is answered in the pane, never pasted into.
  if (!reply || reply.kind === "pane-dialog") return;
  if (reply.kind === "pane") {
    const result = await window.spark.agentDelivery.deliver({
      workspaceId: card.workspaceId,
      target: { kind: "pane", paneId: reply.paneId },
      text,
      submit: true,
      source: "agents-view",
    });
    if (result.outcome !== "pasted") throw new Error("The terminal is no longer open.");
    return;
  }
  const id = clientMessageId();
  if (reply.kind === "question") {
    try {
      await window.spark.orchestration.answerRunQuestion({
        runId: reply.runId,
        questionMessageId: reply.questionMessageId,
        clientMessageId: id,
        message: text,
      });
      return;
    } catch (err) {
      // The question closed after the board last saw it (a Stop, a park):
      // the reply is still the user's next message, as in the composer. A
      // chat that finished meanwhile is left alone, since a message there
      // would start it again.
      if (!isQuestionInactiveError((err as Error)?.message)) throw err;
      const status = getAgentBoardSources().runs.find((run) => run.id === reply.runId)?.status;
      if (status === "complete" || status === "failed" || status === "cancelled") throw err;
    }
  }
  await window.spark.orchestration.addRunMessage({
    runId: reply.runId,
    clientMessageId: id,
    author: "user",
    kind: "note",
    message: text,
  });
}

export default function AgentReplyBox({ card }: { card: AgentBoardCard }) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (phase.kind !== "sent") return undefined;
    const timer = window.setTimeout(() => {
      if (alive.current) setPhase({ kind: "idle" });
    }, SENT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const reply = card.reply;
  if (!reply) return null;
  const sending = phase.kind === "sending";
  const target = card.source === "cora" ? "Cora" : card.agentLabel;
  const label = `Reply to ${target} in ${card.workspaceName}`;

  const submit = (value: string) => {
    const message = value.trim();
    if (!message || sending) return;
    setPhase({ kind: "sending" });
    sendReply(card, message).then(
      () => {
        if (!alive.current) return;
        setText((current) => (current.trim() === message ? "" : current));
        setPhase({ kind: "sent" });
      },
      (err: unknown) => {
        if (!alive.current) return;
        setPhase({ kind: "error", message: unwrapIpcError(err) || "The reply did not get through." });
      },
    );
  };

  const options = reply.kind === "question" ? reply.options.slice(0, 4) : [];
  return (
    <div className="agent-card__reply">
      {options.length > 0 && (
        <div className="agent-card__options" role="group" aria-label="Answers">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`agent-card__option${option.recommended ? " is-recommended" : ""}`}
              title={option.description || option.answer}
              disabled={sending}
              onClick={() => submit(option.answer || option.label)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      <form
        className="agent-card__form"
        onSubmit={(event) => {
          event.preventDefault();
          submit(text);
        }}
      >
        <input
          className="agent-card__input"
          type="text"
          value={text}
          aria-label={label}
          placeholder={reply.kind === "pane" ? `Reply to ${target}` : "Reply to Cora"}
          disabled={sending}
          spellCheck
          onChange={(event) => {
            setText(event.target.value);
            if (phase.kind === "error") setPhase({ kind: "idle" });
          }}
          onKeyDown={(event) => {
            // Escape leaves the box for its card, where the arrows move on.
            if (event.key !== "Escape") return;
            event.currentTarget
              .closest("[data-agent-card]")
              ?.querySelector<HTMLButtonElement>("[data-agent-card-open]")
              ?.focus();
          }}
        />
        <button type="submit" className="agent-card__send" disabled={sending || !text.trim()}>
          {sending ? "Sending" : "Send"}
        </button>
      </form>
      <div className="agent-card__reply-status" role="status" aria-live="polite">
        {phase.kind === "sent" ? "Sent" : phase.kind === "error" ? phase.message : ""}
      </div>
    </div>
  );
}
