import React, { useEffect, useState } from "react";
import { FEEDBACK_KIND_LABELS, type FeedbackAnswer, type FeedbackAsk } from "@shared/feedback";

import "../chrome/chrome-link.css";
import "./feedback.css";

// An agent asked to send feedback to Codara (codara_feedback_send). The same
// floating card as the tab approval: who asks, the exact text as plain text
// on an opaque panel, a countdown to the agent's timeout, Don't send and
// Send. FeedbackHost queues the questions and shows the oldest.

// An expired card stays this long, so it never just vanishes.
const EXPIRED_CARD_MS = 8_000;

export interface QueuedFeedbackAsk extends FeedbackAsk {
  expired?: boolean;
}

export default function FeedbackAskCard({
  request,
  onAnswered,
  onDismiss,
}: {
  request: QueuedFeedbackAsk;
  onAnswered: (answered: boolean) => void;
  onDismiss: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expired = Boolean(request.expired || request.expiresAt <= now);

  useEffect(() => {
    if (expired) {
      const timer = setTimeout(onDismiss, EXPIRED_CARD_MS);
      return () => clearTimeout(timer);
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [expired, onDismiss]);

  const who = request.workspaceName ? `${request.agent} in ${request.workspaceName}` : request.agent;
  const title = `${who} wants to send feedback to Codara`;

  if (expired) {
    return (
      <section role="status" aria-label="Feedback request expired" data-feedback-ask={request.id} data-expired="true" className="spark-glass--strong spark-overlay-surface chrome-pairing">
        <div className="chrome-pairing__title">Request expired</div>
        <p className="chrome-pairing__body">{`${request.agent} stopped waiting. Nothing was sent.`}</p>
        <div className="chrome-pairing__actions">
          <button type="button" className="spark-btn" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }

  const decide = async (answer: FeedbackAnswer): Promise<void> => {
    setBusy(true);
    let answered = false;
    try {
      answered = await window.spark.feedback.answer(request.id, answer);
    } finally {
      setBusy(false);
      onAnswered(answered);
    }
  };

  return (
    <section role="dialog" aria-label={title} data-feedback-ask={request.id} className="spark-glass--strong spark-overlay-surface chrome-pairing">
      <div className="chrome-pairing__title">{title}</div>
      <p className="chrome-pairing__body">{`${FEEDBACK_KIND_LABELS[request.kind]}, exactly as it would be sent:`}</p>
      <p className="fb-quote" data-testid="feedback-ask-text">
        {request.message}
      </p>
      <p className="chrome-pairing__body">
        With the app version, your operating system and the anonymous install id. Settings, About can stop this question.
      </p>
      <div className="chrome-pairing__actions">
        <span className="chrome-pairing__countdown" aria-live="off">
          {Math.max(0, Math.ceil((request.expiresAt - now) / 1000))} s
        </span>
        <button type="button" className="spark-btn" disabled={busy} onClick={() => void decide("no")}>
          Don't send
        </button>
        <button type="button" className="spark-btn is-primary" disabled={busy} onClick={() => void decide("yes")}>
          Send
        </button>
      </div>
    </section>
  );
}
