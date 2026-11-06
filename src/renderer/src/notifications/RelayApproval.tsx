import React, { useEffect, useState } from "react";
import type { PendingRelay, RelayDecision, RelayOutcome } from "@shared/session-relay";

// A message a caller outside the session asked to send (session.relay), as
// its notification-center row shows it: who asks, the target, the reason and
// the exact text, with Send and Dismiss. The text is untrusted and only ever
// rendered as a React text node, never as markup or a link.

export interface RelayRowState {
  pending: PendingRelay | null;
  outcome: RelayOutcome | null;
}

export const RELAY_OUTCOME_LABEL: Record<RelayOutcome, string> = {
  sent: "Sent",
  dismissed: "Dismissed",
  expired: "Expired",
  undeliverable: "Not sent",
};

const EMPTY: RelayRowState = { pending: null, outcome: null };

/** Pending relays and recent outcomes, by relay id; refreshed when main says so. */
export function useSessionRelays(): (relayId: string | null) => RelayRowState {
  const [list, setList] = useState<{ pending: Map<string, PendingRelay>; outcomes: Record<string, RelayOutcome> }>(
    () => ({ pending: new Map(), outcomes: {} }),
  );
  useEffect(() => {
    const api = window.spark.sessionRelay;
    let alive = true;
    const load = () =>
      void api.list().then(
        (next) => {
          if (alive) setList({ pending: new Map(next.pending.map((relay) => [relay.id, relay])), outcomes: next.outcomes });
        },
        () => undefined,
      );
    load();
    const off = api.onChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return (relayId) => {
    if (!relayId) return EMPTY;
    const pending = list.pending.get(relayId) ?? null;
    return { pending, outcome: pending ? null : (list.outcomes[relayId] ?? null) };
  };
}

export function RelayApproval({ relay }: { relay: PendingRelay }): React.ReactElement {
  const [busy, setBusy] = useState<RelayDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: RelayDecision) => {
    setBusy(decision);
    setError(null);
    try {
      const reply = await window.spark.sessionRelay.decide(relay.id, decision);
      if (!reply.ok) setError(reply.error);
    } catch {
      setError("Codara could not reach the session. Nothing was sent.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="nc-answer nc-relay" data-relay-id={relay.id}>
      <div className="nc-relay-who">
        From <strong>{relay.sender}</strong> to <strong>“{relay.target.title}”</strong> in {relay.target.workspace}
      </div>
      {relay.reason && <div className="nc-relay-reason">Reason: {relay.reason}</div>}
      <pre className="nc-relay-text" aria-label="Message text" tabIndex={0}>
        {relay.text}
      </pre>
      <div className="nc-relay-note">Nothing has been sent. Send types this into the session as your next prompt.</div>
      <div className="nc-options" role="group" aria-label="Approve this message">
        <button type="button" className="nc-option" disabled={busy !== null} onClick={() => void decide("dismiss")}>
          Dismiss
        </button>
        <button
          type="button"
          className="nc-option"
          data-recommended="true"
          disabled={busy !== null}
          onClick={() => void decide("send")}
        >
          {busy === "send" ? "Sending..." : "Send"}
        </button>
      </div>
      {error && (
        <div className="nc-answer-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
