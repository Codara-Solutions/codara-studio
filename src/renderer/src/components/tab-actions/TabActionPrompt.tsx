import React, { useEffect, useState } from "react";
import type { TabActionAnswer, TabActionApprovalRequest, TabActionApprovalTab } from "@shared/tab-actions";

import "../chrome/chrome-link.css";
import "./tab-action-prompt.css";

// An expired card stays this long, so it never just vanishes.
const EXPIRED_CARD_MS = 8_000;

interface QueuedRequest extends TabActionApprovalRequest {
  expired?: boolean;
}

const KIND_LABELS: Record<string, string> = {
  terminal: "Terminal",
  preview: "Browser",
  editor: "Editor",
  diff: "Diff",
  chat: "Chat",
  whiteboard: "Whiteboard",
  automations: "Automations",
  usage: "Usage",
};

function quoted(text: string): string {
  return `“${text}”`;
}

// "Claude Code wants to close 3 tabs in group “login-flow”".
export function tabActionTitle(request: TabActionApprovalRequest): string {
  const count = request.tabs.length;
  const what =
    count === 1 && !request.groupName ? quoted(request.tabs[0].title) : `${count} tab${count === 1 ? "" : "s"}`;
  const where = request.groupName ? ` in group ${quoted(request.groupName)}` : "";
  if (request.action === "split") return `${request.agent} wants to split ${what} beside the tab on screen`;
  if (request.action === "unsplit") return `${request.agent} wants to unsplit ${what}`;
  return `${request.agent} wants to close ${what}${where}`;
}

// "Always allow “web” to close tabs here".
export function tabActionAlwaysLabel(request: TabActionApprovalRequest): string {
  const verb = request.action === "close" ? "close" : "move";
  return `Always allow ${quoted(request.callerName)} to ${verb} tabs here`;
}

function warningLabel(tab: TabActionApprovalTab): string | null {
  if (tab.warning === "agent") return "agent running";
  if (tab.warning === "unsaved") return "unsaved changes";
  return null;
}

/**
 * An agent asked to close, split or unsplit tabs it did not open
 * (codara_tab). Same floating card as the cross-workspace prompt; one
 * request at a time, oldest first, counting down to main's timeout. It names
 * every tab that would change and marks the ones where something is lost.
 * "Always allow" stores a grant for the agent's workspace, listed in
 * Settings; it never covers a close that loses an agent or unsaved edits.
 */
export default function TabActionPrompt(): React.ReactElement | null {
  const [queue, setQueue] = useState<QueuedRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const api = window.spark.tabActions;
    const add = (request: TabActionApprovalRequest) =>
      setQueue((current) => (current.some((entry) => entry.id === request.id) ? current : [...current, request]));
    const offApproval = api.onApproval(add);
    const offClosed = api.onApprovalClosed(({ id }) =>
      setQueue((current) =>
        current[0]?.id === id
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

  const decide = async (answer: TabActionAnswer) => {
    setBusy(true);
    let answered = false;
    try {
      answered = await window.spark.tabActions.answer(request.id, answer);
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
        aria-label="Tab request expired"
        data-tab-action-approval={request.id}
        data-expired="true"
        className="spark-glass--strong spark-overlay-surface chrome-pairing"
      >
        <div className="chrome-pairing__title">Request expired</div>
        <p className="chrome-pairing__body">
          {request.agent} stopped waiting. Nothing changed; it can ask again.
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
  const losesWork = request.action === "close" && request.tabs.some((tab) => tab.warning);
  return (
    <section
      role="dialog"
      aria-label={tabActionTitle(request)}
      data-tab-action-approval={request.id}
      className="spark-glass--strong spark-overlay-surface chrome-pairing"
    >
      <div className="chrome-pairing__title">{tabActionTitle(request)}</div>
      <p className="chrome-pairing__body">
        {request.action === "close"
          ? `These tabs in ${request.workspaceName} will close:`
          : `In ${request.workspaceName}:`}
      </p>
      <ul className="tab-action-prompt__list">
        {request.tabs.map((tab, index) => {
          const warning = warningLabel(tab);
          return (
            <li key={index} className="tab-action-prompt__row">
              <span className="tab-action-prompt__kind">{KIND_LABELS[tab.kind] ?? tab.kind}</span>
              <span className="tab-action-prompt__name" title={tab.title}>
                {tab.title}
              </span>
              {warning && request.action === "close" && (
                <span className="tab-action-prompt__warning">{warning}</span>
              )}
            </li>
          );
        })}
      </ul>
      {losesWork && (
        <p className="chrome-pairing__body tab-action-prompt__note" role="note">
          Closing stops the agents and drops the unsaved changes marked above. Codara asks about these every time.
        </p>
      )}
      <div className="chrome-pairing__actions">
        <span className="chrome-pairing__countdown" aria-live="off">
          {secondsLeft} s
        </span>
        <button type="button" className="spark-btn" disabled={busy} onClick={() => void decide("deny")}>
          Deny
        </button>
        <button type="button" className="spark-btn is-primary" disabled={busy} onClick={() => void decide("once")}>
          Allow once
        </button>
      </div>
      <button
        type="button"
        className="spark-btn tab-action-prompt__always"
        disabled={busy}
        title="Revoke it in Settings, Workspaces"
        onClick={() => void decide("always")}
      >
        {tabActionAlwaysLabel(request)}
      </button>
    </section>
  );
}
