import React, { useEffect, useId, useRef, useState } from "react";
import {
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_MESSAGE_MAX,
  codePointLength,
  feedbackContactProblem,
  feedbackMessageProblem,
  type FeedbackInfo,
  type FeedbackKind,
} from "@shared/feedback";
import "./feedback.css";

// Send feedback: what the person types goes to Codara through main, with the
// app version, the operating system and an anonymous install id, and the
// email only when they give one. The line above the buttons says exactly
// that. Lazy loaded by FeedbackHost, so it costs nothing until opened.

type Phase = { name: "editing"; error: string | null } | { name: "sending" } | { name: "sent" };

export default function FeedbackDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const ids = useId();
  const sectionRef = useRef<HTMLElement | null>(null);
  const messageRef = useRef<HTMLTextAreaElement | null>(null);
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [info, setInfo] = useState<FeedbackInfo | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "editing", error: null });
  const [previous] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    let alive = true;
    messageRef.current?.focus();
    void window.spark.feedback.info().then(
      (value) => alive && setInfo(value),
      () => undefined,
    );
    return () => {
      alive = false;
      if (previous?.isConnected) window.requestAnimationFrame(() => previous.focus());
    };
  }, [previous]);

  const length = codePointLength(message.trim());
  const tooLong = length > FEEDBACK_MESSAGE_MAX;
  const sending = phase.name === "sending";

  const send = async (): Promise<void> => {
    if (sending) return;
    const problem = feedbackMessageProblem(message) ?? feedbackContactProblem(contact);
    if (problem) {
      setPhase({ name: "editing", error: problem });
      return;
    }
    setPhase({ name: "sending" });
    try {
      const result = await window.spark.feedback.send({ kind, message, contact: contact.trim() || null });
      setPhase(result.ok ? { name: "sent" } : { name: "editing", error: result.message });
      if (!result.ok) window.requestAnimationFrame(() => messageRef.current?.focus());
    } catch {
      setPhase({ name: "editing", error: "Studio could not send it. Try again in a moment." });
    }
  };

  // On the document: Send loses focus while it is disabled, and Escape must
  // still close.
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || sending) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [onClose, sending]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && phase.name === "editing") {
      event.preventDefault();
      void send();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(sectionRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input, textarea") ?? []),
    ];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const version = info ? `Studio ${info.appVersion}` : "the Studio version";
  const system = info ? info.platform : "your operating system";

  // A stray click on the scrim never drops what was typed: only Escape,
  // Cancel and Done close it.
  return (
    <div className="spark-fade-in fb-layer">
      <div className="spark-scrim spark-scrim--clear spark-scrim--palette" />
      <section
        ref={sectionRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        className="spark-glass--strong spark-overlay-surface fb-dialog"
        data-testid="feedback-dialog"
        onKeyDown={onKeyDown}
      >
        {phase.name === "sent" ? (
          <>
            <h2 id={`${ids}-title`} className="fb-title">
              Feedback sent
            </h2>
            <p className="fb-note" role="status">
              Thank you, your report reached Codara.{contact.trim() ? " Any answer goes to the email you gave." : ""}
            </p>
            <div className="fb-actions">
              <button type="button" className="spark-btn is-primary" onClick={onClose} autoFocus>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id={`${ids}-title`} className="fb-title">
              Send feedback to Codara
            </h2>
            <div role="group" aria-label="Kind" className="spark-segmented fb-kinds">
              {FEEDBACK_KINDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={value === kind}
                  className={`spark-segmented-item${value === kind ? " is-selected" : ""}`}
                  onClick={() => setKind(value)}
                  disabled={sending}
                >
                  {FEEDBACK_KIND_LABELS[value]}
                </button>
              ))}
            </div>
            <div className="fb-field">
              <label className="fb-label" htmlFor={`${ids}-message`}>
                Message
              </label>
              <textarea
                id={`${ids}-message`}
                ref={messageRef}
                className="spark-input fb-message"
                value={message}
                placeholder={kind === "bug" ? "What happened, and what did you expect?" : "What would make Studio better for you?"}
                onChange={(event) => setMessage(event.target.value)}
                readOnly={sending}
                aria-describedby={`${ids}-count`}
                aria-invalid={tooLong || undefined}
              />
              <span id={`${ids}-count`} className={`fb-count${tooLong ? " is-over" : ""}`}>
                {`${length.toLocaleString("en-US")} / ${FEEDBACK_MESSAGE_MAX.toLocaleString("en-US")}`}
              </span>
            </div>
            <div className="fb-field">
              <label className="fb-label" htmlFor={`${ids}-contact`}>
                Email (optional)
              </label>
              <input
                id={`${ids}-contact`}
                className="spark-input"
                type="email"
                value={contact}
                placeholder="Only if you want an answer"
                onChange={(event) => setContact(event.target.value)}
                readOnly={sending}
                autoComplete="email"
              />
            </div>
            <p className="fb-note" data-testid="feedback-what-is-sent">
              {`Sends your message, ${version}, ${system}, an anonymous install id, and your email only if you add one. Nothing else.`}
            </p>
            {phase.name === "editing" && phase.error ? (
              <p className="fb-error" role="alert">
                {phase.error}
              </p>
            ) : null}
            <div className="fb-actions">
              <button type="button" className="spark-btn" onClick={onClose} disabled={sending}>
                Cancel
              </button>
              <button
                type="button"
                className="spark-btn is-primary"
                onClick={() => void send()}
                disabled={sending || length === 0 || tooLong}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
