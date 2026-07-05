import React, { useEffect, useRef, useState } from "react";
import type { NotificationCenterEntry, ResolvedRunQuestion, RunQuestionOption } from "@shared/types";
import { NotifyGlyphSvg } from "../components/Toast";
import { answerRunQuestion } from "./answers";
import { accentVar, kindMeta } from "./kinds";
import type { NavigateTo } from "./routing";
import { useNotificationCenter } from "./useNotificationCenter";

// Notification center: a bell in the window chrome with an unread badge and
// a .spark-menu popover over the persisted history (main-side ring buffer).
// Entries group by day; clicking one routes its NavigationTarget and marks
// it read; run.blocked entries with a still-open question offer the same
// one-click answers as the toast cards.

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: "drag" | "no-drag";
};

export interface NotificationCenterProps {
  navigateTo?: NavigateTo;
  resolveQuestion?: (runId: string) => ResolvedRunQuestion | null;
  shouldResumeOnAnswer?: (runId: string) => boolean;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toneVarOf(entry: NotificationCenterEntry): string {
  // Automation.* entries render in the violet family, everything else in its
  // tone color — shared with the toast card via accentVar so the two surfaces
  // stay identical.
  const tone = entry.tone ?? kindMeta(entry.kind).tone;
  return accentVar(entry.kind, tone);
}

export default function NotificationCenter({
  navigateTo,
  resolveQuestion,
  shouldResumeOnAnswer,
}: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const center = useNotificationCenter(open);
  const [dnd, setDnd] = useState(false);

  // DND preference: seeded from disk, tracked through the preferences push
  // so a toggle from anywhere (future Settings surface) stays in sync.
  useEffect(() => {
    let alive = true;
    void window.spark.preferences
      .load()
      .then((p) => {
        if (alive) setDnd(p.notificationsDnd === true);
      })
      .catch(() => undefined);
    const off = window.spark.preferences.onChanged((change) => {
      if (change.key === "notificationsDnd") setDnd(change.value === true);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const toggleDnd = () => {
    const next = !dnd;
    setDnd(next);
    void window.spark.preferences.set("notificationsDnd", next).catch(() => setDnd(!next));
  };

  // Close on click-away / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Group the newest-first list into day sections, preserving order.
  const sections: Array<{ label: string; entries: NotificationCenterEntry[] }> = [];
  for (const entry of center.entries) {
    const label = dayLabel(entry.createdAt);
    const last = sections[sections.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else sections.push({ label, entries: [entry] });
  }

  return (
    <div ref={rootRef} style={{ display: "flex", alignItems: "stretch" }}>
      <button
        type="button"
        data-window-control
        title="Notifications"
        aria-label={
          center.unread > 0 ? `Notifications (${center.unread} unread)` : "Notifications"
        }
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={
          {
            appearance: "none",
            position: "relative",
            width: 30,
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: hover || open ? "var(--hover)" : "transparent",
            border: "none",
            borderLeft: "1px solid var(--rule-soft)",
            color: hover || open ? "var(--ink)" : "var(--ink-dim)",
            cursor: "default",
            padding: 0,
            WebkitAppRegion: "no-drag",
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
          } as AppRegionStyle
        }
      >
        <NotifyGlyphSvg glyph="bell" size={13} />
        {center.unread > 0 && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 5,
              right: 5,
              minWidth: 12,
              height: 12,
              padding: "0 2px",
              borderRadius: 6,
              background: "var(--accent)",
              color: "color-mix(in oklch, var(--bg) 92%, var(--accent))",
              fontSize: 8,
              fontWeight: 700,
              lineHeight: "12px",
              textAlign: "center",
              fontFamily: "var(--font-sans)",
            }}
          >
            {center.unread > 9 ? "9+" : center.unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="spark-menu spark-fade-in"
          role="dialog"
          aria-label="Notifications"
          style={{
            position: "fixed",
            top: 34,
            right: 8,
            width: 336,
            zIndex: 1300,
            display: "flex",
            flexDirection: "column",
            fontFamily: "var(--font-sans)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 6px 6px",
              borderBottom: "1px solid var(--rule-soft)",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", flex: 1 }}>
              Notifications
            </span>
            <HeaderAction
              label="Mark all read"
              disabled={center.unread === 0}
              onClick={center.markAllRead}
            />
            <HeaderAction
              label="Clear"
              disabled={center.entries.length === 0}
              onClick={center.clear}
            />
          </div>

          <div style={{ maxHeight: 400, overflowY: "auto", padding: "4px 0" }}>
            {sections.length === 0 && (
              <div
                style={{
                  padding: "18px 12px",
                  fontSize: 12,
                  color: "var(--muted)",
                  textAlign: "center",
                }}
              >
                Nothing yet — run and terminal alerts will collect here.
              </div>
            )}
            {sections.map((section) => (
              <div key={section.label}>
                <div
                  style={{
                    padding: "5px 8px 3px",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--muted)",
                  }}
                >
                  {section.label}
                </div>
                {section.entries.map((entry) => (
                  <CenterEntry
                    key={entry.id}
                    entry={entry}
                    onOpen={() => {
                      // Opening an entry is the user ACTING on it: route to the
                      // target, then drop it from the center so handled items
                      // don't pile up (replaces the old mark-read-and-keep).
                      // Guard on navigateTo (as the toast does) so we never
                      // destroy an entry without actually routing anywhere.
                      if (!navigateTo) return;
                      navigateTo(entry.target);
                      center.remove(entry.id);
                      setOpen(false);
                    }}
                    onActed={() => center.remove(entry.id)}
                    resolveQuestion={resolveQuestion}
                    shouldResumeOnAnswer={shouldResumeOnAnswer}
                  />
                ))}
              </div>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px 4px",
              borderTop: "1px solid var(--rule-soft)",
            }}
          >
            <span style={{ fontSize: 11, color: "var(--ink-dim)", flex: 1 }}>
              Do Not Disturb
            </span>
            <DndSwitch on={dnd} onToggle={toggleDnd} />
          </div>
        </div>
      )}
    </div>
  );
}

function HeaderAction({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        border: "none",
        background: hover && !disabled ? "var(--hover)" : "transparent",
        borderRadius: "var(--radius-control, 5px)",
        padding: "2px 6px",
        fontSize: 11,
        fontFamily: "var(--font-sans)",
        color: disabled ? "var(--muted)" : hover ? "var(--ink)" : "var(--ink-dim)",
        opacity: disabled ? 0.5 : 1,
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}

function DndSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Do Not Disturb"
      onClick={onToggle}
      style={{
        appearance: "none",
        width: 28,
        height: 16,
        borderRadius: 8,
        border: "1px solid var(--rule-strong)",
        background: on ? "var(--accent)" : "var(--hover)",
        position: "relative",
        padding: 0,
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 1,
          left: on ? 13 : 1,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: on
            ? "color-mix(in oklch, var(--bg) 92%, var(--accent))"
            : "var(--ink-dim)",
          transition: "left var(--motion-fast) var(--ease-out)",
        }}
      />
    </button>
  );
}

function CenterEntry({
  entry,
  onOpen,
  onActed,
  resolveQuestion,
  shouldResumeOnAnswer,
}: {
  entry: NotificationCenterEntry;
  onOpen: () => void;
  // Fired when the user resolves the entry in place (answers the inline
  // question) — the entry is removed from the center, not merely marked read.
  onActed: () => void;
  resolveQuestion?: (runId: string) => ResolvedRunQuestion | null;
  shouldResumeOnAnswer?: (runId: string) => boolean;
}) {
  const [hover, setHover] = useState(false);
  const answering = useRef(false);
  const meta = kindMeta(entry.kind);
  const toneVar = toneVarOf(entry);

  // Same one-click answer affordance as the toast: only a blocked run with a
  // still-open question resolves any options (answered/expired ones return
  // an empty list, so stale entries render no buttons).
  const questionRunId =
    entry.kind === "run.blocked" && entry.target.type === "run"
      ? entry.target.runId
      : entry.kind === "automation.blocked" && entry.target.type === "automation"
        ? (entry.target.runId ?? null)
        : null;
  const resolvedQuestion =
    questionRunId && resolveQuestion ? resolveQuestion(questionRunId) : null;
  const answerOptions: RunQuestionOption[] = resolvedQuestion
    ? resolvedQuestion.options.slice(0, 3)
    : [];

  const answerWith = async (option: RunQuestionOption) => {
    if (!questionRunId || answering.current) return;
    answering.current = true;
    try {
      await answerRunQuestion(
        questionRunId,
        option,
        shouldResumeOnAnswer?.(questionRunId) ?? true,
        resolvedQuestion?.questionMessageId,
      );
      onActed();
    } catch {
      answering.current = false;
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "6px 8px",
        margin: "0 4px",
        borderRadius: "var(--radius-control, 7px)",
        background: hover ? "var(--hover)" : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 18px",
          width: 18,
          height: 18,
          marginTop: 1,
          display: "grid",
          placeItems: "center",
          borderRadius: "var(--radius-control, 5px)",
          background: `color-mix(in oklch, ${toneVar} 14%, var(--panel))`,
          border: `1px solid color-mix(in oklch, ${toneVar} 32%, transparent)`,
          color: toneVar,
        }}
      >
        <NotifyGlyphSvg glyph={meta.glyph} size={11} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              fontWeight: entry.read ? 500 : 600,
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {entry.title || meta.label}
          </span>
          <span style={{ flex: "0 0 auto", fontSize: 10, color: "var(--muted)" }}>
            {timeLabel(entry.createdAt)}
          </span>
          {!entry.read && (
            <span
              aria-label="Unread"
              style={{
                flex: "0 0 6px",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--accent)",
              }}
            />
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--ink-dim, var(--muted))",
            lineHeight: 1.4,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflowWrap: "anywhere",
          }}
        >
          {entry.body}
        </div>
        {answerOptions.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
            {answerOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void answerWith(option);
                }}
                style={{
                  appearance: "none",
                  cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--ink)",
                  background: "var(--hover)",
                  border:
                    "1px solid color-mix(in oklch, var(--accent) 40%, var(--rule-strong))",
                  borderRadius: "var(--radius-control, 6px)",
                  padding: "2px 7px",
                  maxWidth: "100%",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
