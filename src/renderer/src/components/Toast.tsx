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
      {toasts.map((toast, index) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          // Recede older cards into a tidy deck so a burst reads as a
          // stack, not a wall of identical slabs. The newest card (last
          // in the array, closest to the eye) sits fully forward; each
          // older card above it steps slightly back via scale + opacity.
          depth={toasts.length - 1 - index}
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
  depth,
  onClose,
  onSelectRun,
  resolveQuestion,
}: {
  toast: Toast;
  depth: number;
  onClose: () => void;
  onSelectRun?: (runId: string, workspaceId?: string) => void;
  resolveQuestion?: (runId: string) => RunQuestionOption[];
}) {
  // In-flight guard so a fast double-click on an answer button (or two
  // different options) only fires one addRunMessage+resumeRun sequence.
  const answering = useRef(false);
  const [hover, setHover] = useState(false);
  const [closeHover, setCloseHover] = useState(false);
  const [closeFocus, setCloseFocus] = useState(false);
  const [cardFocus, setCardFocus] = useState(false);
  // .spark-fade-in owns opacity + transform with fill:both, so its final
  // keyframe (opacity 1) overrides any inline opacity while it plays. We gate
  // the deck-recede dim behind animation completion so the entrance never
  // fights it; until then the entering card is fully forward.
  const [entered, setEntered] = useState(false);

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

  // Two semantic treatments. A "done"/complete toast is SUCCESS (--ok),
  // a "blocked"/needs-you toast is DANGER (--danger) — neither glows with
  // the workspace accent, so the brand stays rationed. The neutral
  // --notify-surface body carries the card; status lives only in a 3px
  // left status rule (--status-edge) plus a ~14%-tinted rounded icon chip.
  // Mirror the herdr "static, never pulse" rule — the surface is solid so
  // urgency reads as gravitas, not a generic spinner.
  const palette =
    toast.kind === "blocked"
      ? {
          status: "var(--danger)",
          chipFill: "color-mix(in oklch, var(--danger) 14%, var(--panel))",
          chipBorder: "color-mix(in oklch, var(--danger) 32%, transparent)",
          title: toast.title || "Spark — needs you",
        }
      : {
          status: "var(--ok)",
          chipFill: "color-mix(in oklch, var(--ok) 14%, var(--panel))",
          chipBorder: "color-mix(in oklch, var(--ok) 32%, transparent)",
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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onAnimationEnd={() => setEntered(true)}
      onFocus={() => setCardFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setCardFocus(false);
        }
      }}
      style={{
        pointerEvents: "auto",
        position: "relative",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "11px 12px 11px 13px",
        borderRadius: "var(--radius-surface, 7px)",
        border: "1px solid var(--rule)",
        // Calm neutral popover surface so "done" toasts stop glowing; the
        // 3px inset left rule (--status-edge) is the only colored signal.
        background: "var(--notify-surface, var(--panel-2))",
        // .spark-fade-in owns transform (the entrance translate), so the
        // hover lift must be expressed via box-shadow only — otherwise an
        // inline transform would fight the running entrance animation. Older
        // cards recede slightly (deck depth) using box-shadow / opacity, not
        // a transform, for the same reason.
        boxShadow: `${
          toast.kind === "blocked"
            ? "inset 3px 0 0 var(--danger)"
            : "inset 3px 0 0 var(--ok)"
        }, ${hover && clickable ? "var(--shadow-2)" : "var(--shadow-1)"}`,
        // Deck recede only after the entrance finishes (see `entered`), so the
        // fade-in's final opacity:1 keyframe never overrides it.
        opacity: !entered || depth === 0 ? 1 : depth === 1 ? 0.92 : 0.82,
        fontFamily: "var(--font-sans)",
        cursor: clickable ? "pointer" : "default",
        outline: cardFocus ? "none" : undefined,
        transition:
          "box-shadow var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      {/* Keyboard focus ring — composed as a box-shadow layer so it renders
          over the inline shadow stack (an inline box-shadow would otherwise
          clobber the global :focus-visible rule). */}
      {cardFocus && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "var(--radius-surface, 7px)",
            boxShadow:
              "var(--focus-ring, 0 0 0 2px var(--accent-edge))",
            pointerEvents: "none",
          }}
        />
      )}
      <ToastIcon kind={toast.kind} color={palette.status} fill={palette.chipFill} border={palette.chipBorder} />
      <div style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ink)",
            letterSpacing: "0.01em",
            marginBottom: 3,
          }}
        >
          {palette.title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-dim, var(--muted))",
            lineHeight: 1.45,
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
                  borderRadius: "var(--radius-control, 7px)",
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
        className="spark-icon-btn"
        aria-label="Dismiss notification"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onMouseEnter={() => setCloseHover(true)}
        onMouseLeave={() => setCloseHover(false)}
        onFocus={() => setCloseFocus(true)}
        onBlur={() => setCloseFocus(false)}
        style={{
          // Pre-sized small control aligned to the title's optical center.
          // Background/color track hover; the focus ring is composed inline
          // so keyboard parity matches the global :focus-visible behaviour.
          ["--spark-icon-btn-size" as string]: "20px",
          marginTop: -1,
          marginRight: -3,
          flex: "0 0 20px",
          color: closeHover ? "var(--ink)" : "var(--muted)",
          background: closeHover ? "var(--hover)" : "transparent",
          borderRadius: "var(--radius-control, 5px)",
          boxShadow: closeFocus
            ? "var(--focus-ring, 0 0 0 2px var(--accent-edge))"
            : "none",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M3 3 L9 9 M9 3 L3 9" />
        </svg>
      </button>
    </div>
  );
}

// The status icon chip: a ~20px rounded square tinted ~14% over the panel,
// holding a 1.5px-stroke glyph derived from the toast kind — a check for
// "done"/complete (success), an alert triangle for "blocked"/needs-you.
function ToastIcon({
  kind,
  color,
  fill,
  border,
}: {
  kind: Toast["kind"];
  color: string;
  fill: string;
  border: string;
}) {
  return (
    <span
      aria-hidden
      style={{
        // Fixed-height chip aligned to the title's optical center — no magic
        // marginTop; the chip and the title row share a flex baseline so the
        // glyph never reflows when the body wraps to multiple lines.
        flex: "0 0 20px",
        width: 20,
        height: 20,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--radius-control, 5px)",
        background: fill,
        border: `1px solid ${border}`,
        color,
      }}
    >
      {kind === "blocked" ? (
        <svg
          width="13"
          height="13"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 2.5 L12.5 12 H1.5 Z" />
          <path d="M7 6 V8.5" />
          <path d="M7 10.5 V10.6" />
        </svg>
      ) : (
        <svg
          width="13"
          height="13"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 7.5 L6 10.5 L11 4" />
        </svg>
      )}
    </span>
  );
}
