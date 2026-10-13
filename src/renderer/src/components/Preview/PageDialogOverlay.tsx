import { useEffect, useRef, useState } from "react";
import { answerPageDialog, usePageDialog, type PageDialogView } from "./pageDialogs";

// A page's alert, confirm or prompt, shown over its own tab the way a
// browser shows a tab-modal dialog. Main holds the page until someone
// answers: the user here, an agent with codara_preview_dialog, or the tab's
// policy when its time runs out (the countdown below).

export default function PageDialogOverlay({ tabId }: { tabId: string | undefined }) {
  const dialog = usePageDialog(tabId);
  if (!dialog) return null;
  return <PageDialogCard key={dialog.id} dialog={dialog} />;
}

function origin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol.replace(/:$/, "");
  } catch {
    return "This page";
  }
}

function useSecondsLeft(autoAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!autoAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [autoAt]);
  if (!autoAt) return null;
  return Math.max(0, Math.ceil((Date.parse(autoAt) - now) / 1000));
}

function PageDialogCard({ dialog }: { dialog: PageDialogView }) {
  const [text, setText] = useState(dialog.defaultPrompt);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const secondsLeft = useSecondsLeft(dialog.autoAt);
  const cancellable = dialog.type !== "alert";
  const leave = dialog.type === "beforeunload";

  useEffect(() => {
    // Take focus only from this tab. An agent's click opens dialogs while the
    // user types somewhere else (a terminal, the chat), where an Enter meant
    // for that field must not answer "Delete project?".
    const active = document.activeElement;
    const pane = rootRef.current?.parentElement;
    if (active && active !== document.body && !pane?.contains(active)) return;
    if (dialog.type === "prompt") inputRef.current?.select();
    else okRef.current?.focus();
  }, [dialog.type]);

  const accept = () => answerPageDialog(dialog.id, { accept: true, ...(dialog.type === "prompt" ? { promptText: text } : {}) });
  const dismiss = () => answerPageDialog(dialog.id, { accept: false });

  return (
    <div
      ref={rootRef}
      className="spark-fade-in"
      data-testid="page-dialog"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 70,
        background: "color-mix(in oklab, var(--bg) 45%, transparent)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "48px 24px 24px",
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${dialog.id}-title`}
        aria-describedby={`${dialog.id}-message`}
        className="spark-glass"
        onKeyDown={(event) => {
          if (event.key === "Escape" && cancellable) {
            event.preventDefault();
            dismiss();
          }
        }}
        style={{
          borderRadius: "var(--radius-popover, 9px)",
          width: "min(440px, 100%)",
          padding: 14,
          fontFamily: "var(--font-sans)",
          color: "var(--ink)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div id={`${dialog.id}-title`} className="spark-eyebrow">
          {leave ? "Leave this page?" : `${origin(dialog.url)} says`}
        </div>
        <div
          id={`${dialog.id}-message`}
          style={{
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            maxHeight: 220,
            overflowY: "auto",
            color: "var(--ink)",
          }}
        >
          {leave ? "Changes you made may not be saved." : dialog.message || " "}
        </div>
        {dialog.type === "prompt" ? (
          <input
            ref={inputRef}
            value={text}
            aria-label="Answer"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                accept();
              }
            }}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "var(--bg)",
              border: "1px solid var(--rule-soft)",
              borderRadius: 6,
              padding: "7px 10px",
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              outline: "none",
              boxShadow: "var(--well)",
            }}
          />
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--muted)" }} aria-live="polite">
            {secondsLeft !== null ? `${cancellable ? "Cancelled" : "Closed"} automatically in ${secondsLeft} s` : ""}
          </span>
          {cancellable ? (
            <button type="button" className="spark-btn" onClick={dismiss}>
              {leave ? "Stay" : "Cancel"}
            </button>
          ) : null}
          <button ref={okRef} type="button" className="spark-btn is-primary" onClick={accept}>
            {leave ? "Leave" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
