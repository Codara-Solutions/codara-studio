import React, { useEffect, useRef, useState } from "react";
import type { NotificationCenterEntry, ResolvedRunQuestion } from "@shared/types";
import { NotifyGlyphSvg } from "../components/Toast";
import { accentVar, kindMeta } from "./kinds";
import type { NavigateTo } from "./routing";
import { useNotificationCenter } from "./useNotificationCenter";

// Notification center: a bell in the window chrome with an unread badge and
// a .spark-menu popover over the persisted history (main-side ring buffer).
// Entries group by day. Clicking one routes its NavigationTarget, marks it
// read, and removes it for every notification kind. A blocked run says only
// that an answer is wanted; the options stay in the run with their context.

async function markReadThenRemove(id: string, remove: () => void): Promise<void> {
  try {
    await window.spark.notifications.markRead(id);
  } catch {
    // Removal is still worth attempting if the read update raced or failed.
  }
  remove();
}

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: "drag" | "no-drag";
};

export interface NotificationCenterProps {
  navigateTo?: NavigateTo;
  resolveQuestion?: (runId: string) => ResolvedRunQuestion | null;
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
              top: 4,
              right: 3,
              minWidth: 12,
              height: 12,
              padding: "0 2px",
              borderRadius: 6,
              background: "var(--accent)",
              color: "color-mix(in oklab, var(--bg) 92%, var(--accent))",
              fontSize: center.unread > 99 ? 7 : 8,
              fontWeight: 700,
              lineHeight: "12px",
              textAlign: "center",
              fontFamily: "var(--font-sans)",
            }}
          >
            {center.unread > 99 ? "99+" : center.unread}
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
            <span style={{ display: "flex", alignItems: "baseline", gap: 6, flex: 1 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>
                Notifications
              </span>
              <span style={{ fontSize: 10, color: "var(--muted)" }}>
                {center.unread > 0
                  ? `${center.unread} unread`
                  : center.entries.length > 0
                    ? `${center.entries.length} saved`
                    : "All caught up"}
              </span>
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
                      // Opening an entry acts on every notification kind. Guard
                      // on navigation so an entry is never removed without a visit.
                      if (!navigateTo) return;
                      navigateTo(entry.target);
                      void markReadThenRemove(entry.id, () => center.remove(entry.id));
                      setOpen(false);
                    }}
                    resolveQuestion={resolveQuestion}
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
            ? "color-mix(in oklab, var(--bg) 92%, var(--accent))"
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
  resolveQuestion,
}: {
  entry: NotificationCenterEntry;
  onOpen: () => void;
  resolveQuestion?: (runId: string) => ResolvedRunQuestion | null;
}) {
  const [hover, setHover] = useState(false);
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
  // Resolving still matters — it distinguishes a question that is genuinely
  // still open from an entry left behind by one already answered or expired —
  // but the options themselves are deliberately not surfaced here.
  const waitingOnAnswer = resolvedQuestion !== null;

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
          {entry.workspaceName && (
            <span
              title={entry.workspaceName}
              style={{
                flex: "0 1 auto",
                minWidth: 0,
                maxWidth: "45%",
                fontSize: 10,
                fontWeight: 600,
                color: "var(--muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {entry.workspaceName}
            </span>
          )}
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
        {/* A pending question announces ITSELF here and nothing more. The
            options used to render as one-click answer buttons, which turned a
            notification into a decision surface: the choices were shown
            stripped of the reasoning that makes them meaningful, truncated to
            three of four, and answerable without ever reading the question in
            context. Deciding belongs in the run, so this only says an answer is
            wanted and takes you there. */}
        {waitingOnAnswer && (
          <div
            style={{
              marginTop: 5,
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 10,
            }}
          >
            Open the run to answer
          </div>
        )}
      </div>
    </div>
  );
}
