import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { sessionSearchProgressLine } from "@shared/session-search";
import { publishSessionSearchStatus, useSessionSearchStatus } from "./useSessionSearchStatus";
import "./session-search.css";

// The one-time "Indexing your agent sessions" dialog. Opening it starts the
// first build at full pace; closing it lets the build go on in the
// background and marks the dialog seen for good.

export default function SessionSearchIntro({ onClosed }: { onClosed: () => void }) {
  const { status } = useSessionSearchStatus();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const closing = useRef(false);

  useEffect(() => {
    void window.spark.sessionSearch.refresh(true).then(publishSessionSearchStatus, () => undefined);
    const id = window.requestAnimationFrame(() => buttonRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, []);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    void window.spark.sessionSearch
      .dismissIntro()
      .then(publishSessionSearchStatus, () => undefined)
      .finally(onClosed);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  const working = status.phase === "indexing" || status.phase === "paused";
  const share = status.filesTotal > 0 ? Math.min(1, status.filesDone / status.filesTotal) : working ? 0 : 1;

  return createPortal(
    <div className="ss-dialog-layer" role="presentation">
      <div className="spark-scrim spark-scrim--clear" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ss-intro-title"
        data-testid="session-search-intro"
        className="ss-dialog ss-dialog--intro spark-glass--strong spark-overlay-surface"
      >
        <h2 id="ss-intro-title" className="ss-intro__title">
          Indexing your agent sessions
        </h2>
        <p className="ss-intro__body">
          Codara is reading your past Claude, Codex, Grok, Pi and Cora sessions so you can search everything you and
          your agents said, from the Sessions view in the rail. Only the messages are kept, never tool output, and the
          index stays on this computer.
        </p>
        <div className="ss-intro__progress">
          <div
            className="ss-intro__bar"
            role="progressbar"
            aria-label="Indexing progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
          >
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
          <div className="ss-intro__line" role="status" aria-live="polite">
            {status.phase === "error" && status.error ? status.error : sessionSearchProgressLine(status)}
          </div>
        </div>
        <p className="ss-intro__hint">Change or turn it off anytime in Settings → Agent session search.</p>
        <div className="ss-intro__actions">
          <button ref={buttonRef} type="button" className="spark-btn is-primary" onClick={close}>
            {working ? "Continue in background" : "Done"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
