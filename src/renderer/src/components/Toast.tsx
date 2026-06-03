import { useEffect, useRef, useState } from "react";
import type { InAppNotificationPayload, RunQuestionOption } from "@shared/types";
import { makeId } from "@shared/ids";

// In-app toast manager + renderer for the four-channel notification
// system. Listens for "notification:in-app" payloads (sent by the main
// process whenever the 3-rule policy fires) and surfaces them as a
// stacked top-right column of cards.
//
// Each toast auto-dismisses after AUTO_DISMISS_MS, the user can also
// click the close button to drop it early. Click anywhere else on the
// card selects the corresponding run if the parent provided an
// onSelectRun handler — this lets a "needs you" alert deep-link the
// user straight to the chat that needs them.

const AUTO_DISMISS_MS = 6_000;
// Cap simultaneous toasts so a misbehaving run that fires many alerts
// in a row can't cover the whole screen. The oldest ones drop off the
// stack while keeping the most recent visible.
const MAX_VISIBLE = 5;

type Toast = InAppNotificationPayload;

export interface ToastHostProps {
  onSelectRun?: (runId: string, workspaceId?: string) => void;
  // Resolve the manager's open-question options for a run so a "blocked"
  // toast can offer one-click answers. The InAppNotificationPayload from
  // main only carries runId — the options live in the run state, so the
  // App resolves them in the renderer (global runs feed + findOpenQuestion).
  resolveQuestion?: (runId: string) => RunQuestionOption[];
}

export default function ToastHost({ onSelectRun, resolveQuestion }: ToastHostProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const off = window.spark.notifications.onInAppNotification((payload) => {
      setToasts((current) => {
        // Drop any toast with the same id (re-entrancy guard if the
        // main process resends a payload while one is still on screen)
        // before appending. We keep MAX_VISIBLE; older ones fall off
        // the top so the newest is always at the bottom-most position
        // of the stack (closest to the user's eye when reading).
        const filtered = current.filter((t) => t.id !== payload.id);
        const next = [...filtered, payload];
        if (next.length > MAX_VISIBLE) {
          return next.slice(next.length - MAX_VISIBLE);
        }
        return next;
      });
    });
    return () => off();
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return undefined;
    // One timer per toast so each gets its own AUTO_DISMISS_MS window.
    // Using setTimeout per toast (instead of a single rolling timer)
    // keeps the dismissal independent of when other toasts arrive.
    const timers = toasts.map((toast) =>
      window.setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== toast.id));
      }, AUTO_DISMISS_MS),
    );
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 48,
        right: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 1000,
        pointerEvents: "none",
        // Constrain so a long body wraps instead of clipping the
        // window. Each card has pointerEvents: auto so click + close
        // still work despite the parent's "none".
        maxWidth: "min(380px, calc(100vw - 32px))",
      }}
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          onClose={() =>
            setToasts((current) => current.filter((t) => t.id !== toast.id))
          }
          onSelectRun={onSelectRun}
          resolveQuestion={resolveQuestion}
        />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onClose,
  onSelectRun,
  resolveQuestion,
}: {
  toast: Toast;
  onClose: () => void;
  onSelectRun?: (runId: string, workspaceId?: string) => void;
  resolveQuestion?: (runId: string) => RunQuestionOption[];
}) {
  // In-flight guard so a fast double-click on an answer button (or two
  // different options) only fires one addRunMessage+resumeRun sequence.
  const answering = useRef(false);

  // Resolve the manager's open-question options for a "blocked" toast.
  // Only "blocked" toasts carry a pending question, and we need a runId
  // to look it up; everything else renders no answer buttons.
  const answerOptions: RunQuestionOption[] =
    toast.kind === "blocked" && toast.runId && resolveQuestion
      ? resolveQuestion(toast.runId).slice(0, 3)
      : [];

  const answerWith = async (option: RunQuestionOption) => {
    if (!toast.runId || answering.current) return;
    answering.current = true;
    try {
      await window.spark.orchestration.addRunMessage({
        runId: toast.runId,
        clientMessageId: makeId("client-msg"),
        author: "user",
        kind: "answer",
        message: option.answer,
      });
      await window.spark.orchestration.resumeRun({ runId: toast.runId });
      onClose();
    } catch {
      // Answering failed (run gone, IPC error) — release the guard so the
      // user can retry or fall through to deep-linking into the chat.
      answering.current = false;
    }
  };
  // Two visual treatments: blocked (danger red), complete (info teal).
  // Mirror the herdr "static red for blocked, never pulse" rule — the
  // background is solid, not animated, so the urgency reads as gravitas.
  const palette = toast.kind === "blocked"
    ? {
        // Danger / "needs you". Deep red border with a faint red fill so
        // the card draws the eye without screaming.
        border: "1px solid color-mix(in oklch, var(--danger) 60%, var(--rule-strong))",
        background:
          "color-mix(in oklch, var(--danger) 14%, var(--panel))",
        accentDot: "var(--danger)",
        title: toast.title || "Spark — needs you",
      }
    : {
        // Complete / "done". Subtle success colouring.
        border: "1px solid color-mix(in oklch, var(--accent) 48%, var(--rule-strong))",
        background:
          "color-mix(in oklch, var(--accent) 14%, var(--panel))",
        accentDot: "var(--accent)",
        title: toast.title || "Spark — done",
      };

  const clickable = Boolean(toast.runId && onSelectRun);

  return (
    <div
      className="spark-fade-in"
      role={toast.kind === "blocked" ? "alert" : "status"}
      onClick={() => {
        if (clickable && toast.runId) {
          onSelectRun?.(toast.runId, toast.workspaceId);
          onClose();
        }
      }}
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 8,
        border: palette.border,
        background: palette.background,
        boxShadow: "var(--shadow-2)",
        fontFamily: "var(--font-sans)",
        cursor: clickable ? "pointer" : "default",
        transition:
          "transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (clickable) e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        if (clickable) e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: palette.accentDot,
          marginTop: 6,
          flex: "0 0 8px",
          // Static, not pulsing — herdr's UX rule for "blocked" reads
          // as urgent when the dot stays steady; pulsing it would make
          // it feel like a generic spinner.
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: "var(--ink)",
            letterSpacing: "0.02em",
            marginBottom: 2,
          }}
        >
          {palette.title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-dim, var(--muted))",
            lineHeight: 1.4,
            overflowWrap: "anywhere",
          }}
        >
          {toast.body}
        </div>
        {answerOptions.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 8,
            }}
          >
            {answerOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={(event) => {
                  // Stop the card's onClick deep-link from firing too —
                  // answering should resolve the question in place, not
                  // also navigate the user into the chat.
                  event.stopPropagation();
                  void answerWith(option);
                }}
                style={{
                  appearance: "none",
                  cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--ink)",
                  background: "var(--hover)",
                  border:
                    "1px solid color-mix(in oklch, var(--accent) 40%, var(--rule-strong))",
                  borderRadius: 6,
                  padding: "3px 8px",
                  maxWidth: "100%",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  transition:
                    "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background =
                    "color-mix(in oklch, var(--accent) 24%, var(--hover))";
                  e.currentTarget.style.borderColor = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--hover)";
                  e.currentTarget.style.borderColor =
                    "color-mix(in oklch, var(--accent) 40%, var(--rule-strong))";
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          color: "var(--muted)",
          cursor: "default",
          fontSize: 16,
          lineHeight: 1,
          padding: 4,
          marginTop: -2,
          marginRight: -4,
          borderRadius: 5,
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--hover)";
          e.currentTarget.style.color = "var(--ink)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--muted)";
        }}
      >
        ×
      </button>
    </div>
  );
}
