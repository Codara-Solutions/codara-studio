import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Virtuoso } from "react-virtuoso";
import {
  SESSION_SEARCH_AGENT_LABEL,
  sessionQueryTerms,
  type SessionTranscript,
} from "@shared/session-search";
import { CloseIcon } from "../icons";
import SessionAgentMark from "./SessionAgentMark";
import { TermsText } from "./SessionHighlight";
import { copySessionId, revealSessionTranscript } from "./session-actions";

// A session's messages as the index holds them, read only: what was said,
// never the tool output. Opened from a row's menu, or instead of a resume
// when the session's folder is gone.

/** Longer messages show their start until asked for the rest. */
const CLIP_CHARS = 6_000;

export default function SessionTranscriptDialog({
  sessionKey,
  sessionId,
  query,
  notice,
  onClose,
}: {
  sessionKey: string;
  sessionId: string;
  query: string;
  /** Why the transcript opened instead of the session, shown above it. */
  notice?: string | null;
  onClose: () => void;
}) {
  const [transcript, setTranscript] = useState<SessionTranscript | null | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [note, setNote] = useState<string | null>(null);
  const terms = sessionQueryTerms(query);

  useEffect(() => {
    let alive = true;
    void window.spark.sessionSearch
      .transcript(sessionKey)
      .then((value) => {
        if (alive) setTranscript(value);
      })
      .catch(() => {
        if (alive) setTranscript(null);
      });
    return () => {
      alive = false;
    };
  }, [sessionKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const agentLabel = transcript ? SESSION_SEARCH_AGENT_LABEL[transcript.agent] : "";

  return createPortal(
    <div className="ss-dialog-layer" role="presentation" onMouseDown={onClose}>
      <div className="spark-scrim spark-scrim--clear" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Session transcript"
        data-testid="session-transcript"
        className="ss-dialog ss-dialog--transcript spark-glass--strong spark-overlay-surface"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ss-dialog__head">
          {transcript ? <SessionAgentMark agent={transcript.agent} size={15} /> : null}
          <div className="ss-dialog__titles">
            <h2 className="ss-dialog__title">{transcript?.title ?? "Transcript"}</h2>
            {transcript?.cwd ? (
              <div className="ss-dialog__sub" title={transcript.cwd}>
                {transcript.cwd}
              </div>
            ) : null}
          </div>
          <button type="button" className="spark-icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </header>
        {notice ? (
          <div className="ss-dialog__notice" role="status">
            {notice}
          </div>
        ) : null}
        <div className="ss-transcript">
          {transcript === undefined ? (
            <div className="ss-transcript__empty">Loading…</div>
          ) : transcript === null || transcript.messages.length === 0 ? (
            <div className="ss-transcript__empty">This session has no messages in the index.</div>
          ) : (
            <Virtuoso
              data={transcript.messages}
              style={{ height: "100%" }}
              computeItemKey={(index) => index}
              itemContent={(index, message) => {
                const long = message.text.length > CLIP_CHARS && !expanded.has(index);
                const text = long ? `${message.text.slice(0, CLIP_CHARS)}…` : message.text;
                return (
                  <div className={`ss-msg is-${message.role}`}>
                    <div className="ss-msg__who">{message.role === "user" ? "You" : agentLabel}</div>
                    <div className="ss-msg__text">
                      <TermsText text={text} terms={terms} />
                    </div>
                    {long ? (
                      <button
                        type="button"
                        className="ss-link"
                        onClick={() => setExpanded((current) => new Set(current).add(index))}
                      >
                        Show the whole message
                      </button>
                    ) : null}
                  </div>
                );
              }}
            />
          )}
        </div>
        <footer className="ss-dialog__foot">
          <span className="ss-dialog__count">
            {note ??
              (transcript && transcript.total > transcript.messages.length
                ? `The first ${transcript.messages.length} of ${transcript.total} messages`
                : transcript
                  ? `${transcript.total} ${transcript.total === 1 ? "message" : "messages"}`
                  : "")}
          </span>
          <button
            type="button"
            className="spark-btn"
            onClick={() => void copySessionId(sessionId).then(setNote)}
          >
            Copy session id
          </button>
          <button
            type="button"
            className="spark-btn"
            onClick={() => void revealSessionTranscript(sessionKey).then(setNote)}
          >
            Reveal transcript
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
