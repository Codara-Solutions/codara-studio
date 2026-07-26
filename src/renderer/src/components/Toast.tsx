import { useEffect, useRef, useState } from "react";
import type { NotifyEvent, ResolvedRunQuestion } from "@shared/types";
import { accentVar, isCompletionKind, kindMeta, type NotifyGlyph } from "../notifications/kinds";
import type { NavigateTo } from "../notifications/routing";

// In-app toast manager + renderer for the unified notifications pipeline.
// Listens for "notification:in-app" NotifyEvents (sent by the main process
// whenever the notify policy fires) and surfaces them as a stacked
// top-right column of cards.
//
// Each toast auto-dismisses after AUTO_DISMISS_MS on a fixed wall-clock
// window measured from ITS OWN arrival — independent of focus and of when
// other toasts arrive (a burst never resets the countdown of toasts already
// on screen). A missed toast (window elapsed, never clicked) is not lost: its
// center entry stays unread in the bell, so there's no reason to freeze the
// timer while unfocused. The user can also click the close button to drop one
// early. Click anywhere else on the card routes the event's NavigationTarget
// through navigateTo — this lets a "needs you" alert deep-link the user
// straight to the chat, terminal pane, or loom that needs them. Acting on the
// card then MARKS READ a completion record (automation/run finished/failed) so
// it stays in the center as history, or REMOVES an actionable prompt
// (question/blocked/needs-input) so handled items don't pile up.

const AUTO_DISMISS_MS = 15_000;
// Cap simultaneous toasts so a misbehaving run that fires many alerts
// in a row can't cover the whole screen. The oldest ones drop off the
// stack while keeping the most recent visible.
const MAX_VISIBLE = 5;

type Toast = NotifyEvent;

export interface ToastHostProps {
  // Routes a clicked card to its target (run chat / terminal pane / loom).
  navigateTo?: NavigateTo;
  // Resolve the manager's open-question options for a run so a "run.blocked"
  // toast can offer one-click answers. The NotifyEvent from main only
  // carries the runId — the options live in the run state, so the App
  // resolves them in the renderer (global runs feed + findOpenQuestion).
  resolveQuestion?: (runId: string) => ResolvedRunQuestion | null;
}

export default function ToastHost({
  navigateTo,
  resolveQuestion,
}: ToastHostProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // One pending dismissal timer per on-screen toast, keyed by id. Held in a
  // ref (not state) so re-renders and new arrivals never disturb the timers
  // already ticking.
  const dismissTimers = useRef<Map<string, number>>(new Map());

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
    const timers = dismissTimers.current;
    const liveIds = new Set(toasts.map((t) => t.id));
    // Cancel timers for toasts that are gone — closed early, clicked through,
    // answered, or pushed off the bottom of the MAX_VISIBLE stack.
    for (const [id, timer] of timers) {
      if (!liveIds.has(id)) {
        window.clearTimeout(timer);
        timers.delete(id);
      }
    }
    // Start a fresh AUTO_DISMISS_MS window for any toast that doesn't already
    // have one. Existing timers are left untouched, so a stream of arrivals
    // can't keep older toasts alive forever — each expires on its own clock.
    for (const toast of toasts) {
      if (!timers.has(toast.id)) {
        timers.set(
          toast.id,
          window.setTimeout(() => {
            timers.delete(toast.id);
            setToasts((current) => current.filter((t) => t.id !== toast.id));
          }, AUTO_DISMISS_MS),
        );
      }
    }
  }, [toasts]);

  // Clear every pending timer on unmount so a teardown can't fire setToasts.
  useEffect(() => {
    const timers = dismissTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

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
          navigateTo={navigateTo}
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
  navigateTo,
  resolveQuestion,
}: {
  toast: Toast;
  depth: number;
  onClose: () => void;
  navigateTo?: NavigateTo;
  resolveQuestion?: (runId: string) => ResolvedRunQuestion | null;
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

  const meta = kindMeta(toast.kind);
  // Resolve the manager's open-question options for a blocked-run toast.
  // Only "run.blocked" events carry a pending question, and the runId lives
  // on the navigation target; everything else renders no answer buttons.
  // A blocked run OR a blocked loom iteration both carry an answerable question
  // on their runId. The main-process blocker contract preserves the Loom seam.
  const questionRunId =
    toast.kind === "run.blocked" && toast.target.type === "run"
      ? toast.target.runId
      : toast.kind === "automation.blocked" && toast.target.type === "automation"
        ? (toast.target.runId ?? null)
        : null;
  const resolvedQuestion =
    questionRunId && resolveQuestion ? resolveQuestion(questionRunId) : null;
  // Still resolved, so an already-answered or expired question does not claim
  // to be waiting — but the options themselves stay in the run. A toast is a
  // summons, not a ballot: shown here the choices lose the reasoning that gives
  // them meaning, and the fourth option was being dropped outright.
  const waitingOnAnswer = resolvedQuestion !== null;

  // Three semantic treatments, driven by `tone`: an agent ASKING for input
  // (warning, amber) and a genuine FAILURE (danger, red) must not look
  // alike. Falls back to the kind-derived tone for entries missing one.
  // None of the three glow with the workspace accent, so the brand stays
  // rationed. The neutral --notify-surface body carries the card; status
  // lives only in a 3px left status rule plus a ~14%-tinted rounded icon
  // chip. Mirror the herdr "static, never pulse" rule — the surface is solid
  // so urgency reads as gravitas, not a generic spinner.
  const tone = toast.tone ?? meta.tone;
  // The accent token driving the stripe + icon chip. Tone → --danger/--warn/
  // --ok for run/terminal kinds; the automation family overrides to the violet
  // --automation so it reads as a distinct group (see accentVar). The a11y role
  // below still keys off the raw tone.
  const toneVar = accentVar(toast.kind, tone);
  const palette = {
    status: toneVar,
    chipFill: `color-mix(in oklch, ${toneVar} 14%, var(--panel))`,
    chipBorder: `color-mix(in oklch, ${toneVar} 32%, transparent)`,
    title: toast.title || `Cora — ${meta.label.toLowerCase()}`,
  };

  const clickable = Boolean(navigateTo);

  return (
    <div
      className="spark-fade-in spark-backdrop-glass"
      // Only a genuine failure (danger) is an assertive "alert"; a needs-you /
      // success toast is the calmer "status" live region so a question doesn't
      // shout like an error to assistive tech.
      role={tone === "danger" ? "alert" : "status"}
      onClick={() => {
        if (!clickable) return;
        navigateTo?.(toast.target);
        // Routing to the target is the user ACTING on the notification. For a
        // completion record (automation/run finished/failed) mark it READ so it
        // remains in the center as history; for an actionable prompt remove it so
        // a handled item doesn't linger. (The X button and auto-expiry
        // deliberately do NEITHER: a merely-hidden toast stays as a "missed"
        // unread entry.)
        if (isCompletionKind(toast.kind)) {
          void window.spark.notifications.markRead(toast.id).catch(() => undefined);
        } else {
          void window.spark.notifications.remove(toast.id).catch(() => undefined);
        }
        onClose();
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
        boxShadow: `inset 3px 0 0 ${toneVar}, ${
          hover && clickable ? "var(--shadow-2)" : "var(--shadow-1)"
        }`,
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
      <ToastIcon glyph={meta.glyph} color={palette.status} fill={palette.chipFill} border={palette.chipBorder} />
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
        {waitingOnAnswer && (
          <div
            style={{
              marginTop: 8,
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
            }}
          >
            Open the run to answer
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
// holding a 1.5px-stroke glyph from the kind's metadata — check for
// finishes, alert triangle for needs-input, cross for failures.
function ToastIcon({
  glyph,
  color,
  fill,
  border,
}: {
  glyph: NotifyGlyph;
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
      <NotifyGlyphSvg glyph={glyph} />
    </span>
  );
}

export function NotifyGlyphSvg({ glyph, size = 13 }: { glyph: NotifyGlyph; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {glyph === "alert" ? (
        <>
          <path d="M7 2.5 L12.5 12 H1.5 Z" />
          <path d="M7 6 V8.5" />
          <path d="M7 10.5 V10.6" />
        </>
      ) : glyph === "cross" ? (
        <>
          <path d="M3.5 3.5 L10.5 10.5" />
          <path d="M10.5 3.5 L3.5 10.5" />
        </>
      ) : glyph === "bell" ? (
        <>
          <path d="M7 2 a3.4 3.4 0 0 1 3.4 3.4 c0 2.6 1 3.4 1 3.4 H2.6 s1 -0.8 1 -3.4 A3.4 3.4 0 0 1 7 2 Z" />
          <path d="M5.9 11.2 a1.2 1.2 0 0 0 2.2 0" />
        </>
      ) : glyph === "loop" ? (
        <>
          {/* Circular-arrow "repeats" mark — the automation family glyph, same
              geometry as the app's reload icon (gap + arrowhead reads clockwise). */}
          <path d="M11 7 A4 4 0 1 1 9.6 3.9" />
          <path d="M11.2 1.8 L11.2 4.2 L8.8 4.2" />
        </>
      ) : (
        <path d="M3 7.5 L6 10.5 L11 4" />
      )}
    </svg>
  );
}
