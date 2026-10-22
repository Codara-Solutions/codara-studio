import React, { useEffect, useState } from "react";
import type { CrossWorkspaceAnswer, CrossWorkspaceApprovalRequest } from "@shared/cross-workspace";

import "../chrome/chrome-link.css";

/**
 * An agent asked to open a terminal in another workspace for the first time
 * (codara_terminal_create with `workspace`). Same floating card as the
 * browser pairing prompt; one request at a time, oldest first.
 */
export default function CrossWorkspacePrompt(): React.ReactElement | null {
  const [queue, setQueue] = useState<CrossWorkspaceApprovalRequest[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = window.spark.crossWorkspace;
    const add = (request: CrossWorkspaceApprovalRequest) =>
      setQueue((current) => (current.some((entry) => entry.id === request.id) ? current : [...current, request]));
    const offApproval = api.onApproval(add);
    const offClosed = api.onApprovalClosed(({ id }) =>
      setQueue((current) => current.filter((entry) => entry.id !== id)),
    );
    void api.pending().then((requests) => requests.forEach(add), () => undefined);
    return () => {
      offApproval();
      offClosed();
    };
  }, []);

  const request = queue[0];
  if (!request) return null;

  const decide = async (answer: CrossWorkspaceAnswer) => {
    setBusy(true);
    try {
      await window.spark.crossWorkspace.answer(request.id, answer);
    } finally {
      setQueue((current) => current.filter((entry) => entry.id !== request.id));
      setBusy(false);
    }
  };

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
        and type into it. Always lets it do so again without asking; revoke it in Settings, Agents.
      </p>
      <div className="chrome-pairing__actions">
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
