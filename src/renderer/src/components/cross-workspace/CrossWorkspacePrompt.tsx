import React, { useEffect, useState } from "react";
import type { CrossWorkspaceAnswer, CrossWorkspaceApprovalRequest } from "@shared/cross-workspace";

import "../chrome/chrome-link.css";

// An expired card stays this long, so it never just vanishes.
const EXPIRED_CARD_MS = 8_000;

interface QueuedRequest extends CrossWorkspaceApprovalRequest {
  expired?: boolean;
}

/**
 * An agent asked to open a terminal in another workspace for the first time
 * (codara_terminal_create with `workspace`). Same floating card as the
 * browser pairing prompt; one request at a time, oldest first. It counts down
 * to main's timeout and says so when the request expired.
 */
export default function CrossWorkspacePrompt(): React.ReactElement | null {
  const [queue, setQueue] = useState<QueuedRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const api = window.spark.crossWorkspace;
    const add = (request: CrossWorkspaceApprovalRequest) =>
      setQueue((current) => (current.some((entry) => entry.id === request.id) ? current : [...current, request]));
    const offApproval = api.onApproval(add);
    // The card on screen says it expired; one still queued behind it was
    // never seen and simply goes.
    const offClosed = api.onApprovalClosed(({ id, reason }) =>
      setQueue((current) =>
        current[0]?.id === id && reason === "expired"
          ? [{ ...current[0], expired: true }, ...current.slice(1)]
          : current.filter((entry) => entry.id !== id),
      ),
    );
    void api.pending().then((requests) => requests.forEach(add), () => undefined);
    return () => {
      offApproval();
      offClosed();
    };
  }, []);

  const request = queue[0];
  const expired = Boolean(request && (request.expired || request.expiresAt <= now));
  const dismiss = (id: string) => setQueue((current) => current.filter((entry) => entry.id !== id));

  useEffect(() => {
    if (!request) return;
    if (expired) {
      const timer = setTimeout(() => dismiss(request.id), EXPIRED_CARD_MS);
      return () => clearTimeout(timer);
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [request?.id, expired]);

  if (!request) return null;

  const decide = async (answer: CrossWorkspaceAnswer) => {
    setBusy(true);
    let answered = false;
    try {
      answered = await window.spark.crossWorkspace.answer(request.id, answer);
    } finally {
      setQueue((current) =>
        answered
          ? current.filter((entry) => entry.id !== request.id)
          : current.map((entry) => (entry.id === request.id ? { ...entry, expired: true } : entry)),
      );
      setBusy(false);
    }
  };

  if (expired) {
    return (
      <section
        role="status"
        aria-label="Terminal request expired"
        data-cross-workspace-approval={request.id}
        data-expired="true"
        className="spark-glass--strong spark-overlay-surface chrome-pairing"
      >
        <div className="chrome-pairing__title">Request expired</div>
        <p className="chrome-pairing__body">
          {request.agent ?? "An agent"} in {request.callerName} stopped waiting to open a terminal in{" "}
          {request.targetName}. Nothing was opened; it can ask again.
        </p>
        <div className="chrome-pairing__actions">
          <button type="button" className="spark-btn" onClick={() => dismiss(request.id)}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }

  const secondsLeft = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  return (
    <section
      role="dialog"
      aria-label="Allow terminals in another workspace"
      data-cross-workspace-approval={request.id}
      className="spark-glass--strong spark-overlay-surface chrome-pairing"
    >
      <div className="chrome-pairing__title">
        Allow {request.callerName} to open terminals in {request.targetName}?
      </div>
      <p className="chrome-pairing__body">
        {request.agent ?? "An agent"} in {request.callerName} wants to open a terminal under {request.targetName}{" "}
        and type into it. Allow once covers this one terminal.
      </p>
      <p className="chrome-pairing__body">
        Always lets every agent in {request.callerName} do this without asking, from now on: other sessions, Cora
        runs, and agents started in the terminals it opens. Revoke it in Settings, Agents.
      </p>
      <div className="chrome-pairing__actions">
        <span className="chrome-pairing__countdown" aria-live="off">
          {secondsLeft} s
        </span>
        <button type="button" className="spark-btn" disabled={busy} onClick={() => void decide("deny")}>
          Deny
        </button>
        <button type="button" className="spark-btn" disabled={busy} onClick={() => void decide("once")}>
          Allow once
        </button>
        <button type="button" className="spark-btn is-primary" disabled={busy} onClick={() => void decide("always")}>
          Always
        </button>
      </div>
    </section>
  );
}
