import React, { Suspense, lazy, useCallback, useEffect, useState } from "react";
import type { FeedbackAsk } from "@shared/feedback";
import type { QueuedFeedbackAsk } from "./FeedbackAskCard";

// Opens Send feedback when anything dispatches "spark:open-feedback" (the
// feedback.open command, Settings > About), and shows the questions agents'
// codara_feedback_send calls wait on, one at a time, oldest first. App loads
// this host after boot; pending() catches a question asked before that.

const FeedbackDialog = lazy(() => import("./FeedbackDialog"));
const FeedbackAskCard = lazy(() => import("./FeedbackAskCard"));

export default function FeedbackHost(): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [asks, setAsks] = useState<QueuedFeedbackAsk[]>([]);

  useEffect(() => {
    const show = (): void => setOpen(true);
    window.addEventListener("spark:open-feedback", show);
    const api = window.spark.feedback;
    const add = (ask: FeedbackAsk): void =>
      setAsks((current) => (current.some((entry) => entry.id === ask.id) ? current : [...current, ask]));
    const offAsk = api.onAsk(add);
    // The card on screen says the agent stopped waiting, so Send is never
    // clicked into nothing; one still queued just goes.
    const offClosed = api.onAskClosed(({ id }) =>
      setAsks((current) =>
        current[0]?.id === id ? [{ ...current[0], expired: true }, ...current.slice(1)] : current.filter((entry) => entry.id !== id),
      ),
    );
    void api.pending().then((pending) => pending.forEach(add), () => undefined);
    return () => {
      window.removeEventListener("spark:open-feedback", show);
      offAsk();
      offClosed();
    };
  }, []);

  const ask = asks[0];
  const drop = useCallback((id: string) => setAsks((current) => current.filter((entry) => entry.id !== id)), []);
  const dismissAsk = useCallback(() => {
    if (ask) drop(ask.id);
  }, [ask, drop]);

  return (
    <Suspense fallback={null}>
      {open ? <FeedbackDialog onClose={() => setOpen(false)} /> : null}
      {ask ? (
        <FeedbackAskCard
          key={ask.id}
          request={ask}
          onAnswered={(answered) =>
            answered ? drop(ask.id) : setAsks((current) => current.map((entry) => (entry.id === ask.id ? { ...entry, expired: true } : entry)))
          }
          onDismiss={dismissAsk}
        />
      ) : null}
    </Suspense>
  );
}
