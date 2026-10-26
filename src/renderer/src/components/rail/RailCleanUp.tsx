import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorktreeRailCleanupResult } from "@shared/worktree-cleanup";

// Clean up from the rail, on a merged row or its project's fold, always ends
// in something the user can see next to the button: the rows go, a confirm
// names the ignored files that would go with them, or a short line says what
// holds a worktree back and what to do about it. A toast alone sat in the far
// corner for a few seconds, and the button looked like it did nothing.

export interface RailCleanUpEntry {
  id: string;
  name: string;
  /** Resolves with what main did; null when there was nothing to report. */
  cleanUp: (confirmIgnored?: string) => Promise<WorktreeRailCleanupResult | null>;
}

export interface RailCleanUpNotice {
  id: string;
  name: string;
  text: string;
  tone: "warning" | "danger";
}

interface Holding {
  entry: RailCleanUpEntry;
  holds: string[];
  fingerprint: string;
  /** It was confirmed, then changed before the removal: say so, not just ask again. */
  changed: boolean;
}

function noticeFor(entry: RailCleanUpEntry, result: WorktreeRailCleanupResult | null): RailCleanUpNotice | null {
  if (!result || result.status === "removed" || result.status === "confirm") return null;
  return {
    id: entry.id,
    name: entry.name,
    text: result.message || "It was not removed.",
    tone: result.status === "failed" ? "danger" : "warning",
  };
}

export function useRailCleanUp(liveIds: readonly string[]) {
  const [cleaning, setCleaning] = useState(false);
  const [notices, setNotices] = useState<RailCleanUpNotice[]>([]);
  const [holding, setHolding] = useState<Holding[]>([]);
  const busy = useRef(false);

  const run = useCallback(async (entries: readonly RailCleanUpEntry[], confirmed: ReadonlyMap<string, string>) => {
    if (busy.current) return;
    busy.current = true;
    setCleaning(true);
    // Only the worktrees this run is about lose their line: confirming one
    // must not hide why another stayed.
    const ids = new Set(entries.map((entry) => entry.id));
    const others = (current: RailCleanUpNotice[]) => current.filter((notice) => !ids.has(notice.id));
    setNotices(others);
    const asks: Holding[] = [];
    const told: RailCleanUpNotice[] = [];
    try {
      for (const entry of entries) {
        const result = await entry
          .cleanUp(confirmed.get(entry.id))
          .catch((cause: unknown) => ({
            status: "failed" as const,
            message: cause instanceof Error ? cause.message : String(cause),
            branchDeleted: false,
          }));
        if (result?.status === "confirm" && result.fingerprint) {
          asks.push({
            entry,
            holds: result.holds ?? [],
            fingerprint: result.fingerprint,
            changed: confirmed.has(entry.id),
          });
        }
        const notice = noticeFor(entry, result);
        if (notice) told.push(notice);
      }
    } finally {
      busy.current = false;
      setCleaning(false);
      setNotices((current) => [...others(current), ...told]);
      setHolding(asks);
    }
  }, []);

  const start = useCallback((entries: readonly RailCleanUpEntry[]) => void run(entries, new Map()), [run]);
  const confirmHolding = useCallback(() => {
    const confirmed = new Map(holding.map((item) => [item.entry.id, item.fingerprint]));
    const entries = holding.map((item) => item.entry);
    setHolding([]);
    void run(entries, confirmed);
  }, [holding, run]);
  const cancelHolding = useCallback(() => setHolding([]), []);
  const dismiss = useCallback((id: string) => setNotices((current) => current.filter((notice) => notice.id !== id)), []);

  // A worktree that left the rail some other way has nothing left to say.
  const live = new Set(liveIds);
  return {
    cleaning,
    notices: notices.filter((notice) => live.has(notice.id)),
    holding: holding.filter((item) => live.has(item.entry.id)),
    start,
    confirmHolding,
    cancelHolding,
    dismiss,
  };
}

/** The short lines under a fold or a row. `named` prefixes each with its worktree. */
export function RailCleanUpNotices({
  notices,
  named,
  testId,
  onDismiss,
}: {
  notices: readonly RailCleanUpNotice[];
  named: boolean;
  testId: string;
  onDismiss: (id: string) => void;
}) {
  if (!notices.length) return null;
  return (
    <ul className="rail-clean-up-notices" data-testid={testId} role="status" aria-live="polite">
      {notices.map((notice) => {
        const text = named ? `${notice.name}: ${notice.text}` : notice.text;
        return (
          <li key={notice.id} className="rail-clean-up-notice" data-tone={notice.tone} title={text}>
            <span aria-hidden="true" className="rail-child-dot rail-clean-up-notice-dot" />
            <span className="rail-clean-up-notice-text">{text}</span>
            <button
              type="button"
              className="rail-clean-up-notice-close"
              title="Dismiss"
              aria-label={`Dismiss: ${text}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onDismiss(notice.id);
              }}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** "Holds .env. Remove anyway?" for every worktree only ignored files held back. */
export function CleanUpHoldsConfirm({
  holding,
  testId,
  onCancel,
  onConfirm,
}: {
  holding: readonly Holding[];
  testId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const one = holding.length === 1 ? holding[0] : null;
  const title = one ? `${one.entry.name} holds ${filesText(one.holds)}` : `${holding.length} worktrees hold files git ignores`;
  const changed = holding.filter((item) => item.changed).map((item) => item.entry.name);
  const note = !changed.length
    ? undefined
    : one
      ? "It changed since you were asked. Check the list again."
      : `${changed.join(", ")} changed since you were asked. Check the list again.`;
  return (
    <RailConfirm
      title={title}
      note={note}
      text="Git ignores these, so a fresh checkout won't bring them back and the recovery copy doesn't keep them. Remove anyway?"
      items={one ? one.holds : holding.map((item) => `${item.entry.name}: ${item.holds.join(", ")}`)}
      okLabel="Remove anyway"
      testId={testId}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

function filesText(holds: readonly string[]): string {
  if (holds.length === 1) return holds[0];
  if (holds.length === 2) return `${holds[0]} and ${holds[1]}`;
  return `${holds[0]} and ${holds.length - 1} more`;
}

// The rail slides its rows with transforms, so the dialog renders into the
// body to stay fixed to the window. React still bubbles its events to the
// row it was opened from, so none may leave the scrim.
export function RailConfirm({
  title,
  note,
  text,
  items,
  okLabel,
  testId,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** Said first, above the question: what changed since it was last asked. */
  note?: string;
  text: string;
  items: readonly string[];
  okLabel: string;
  testId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Capture, so Escape closes only this and no handler behind it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return createPortal(
    <div
      className="rail-confirm-scrim"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        data-testid={testId}
        className="rail-confirm spark-glass--strong spark-overlay-surface"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="rail-confirm-title">{title}</span>
        {note && (
          <span className="rail-confirm-note" data-testid={`${testId}-note`} role="status">
            {note}
          </span>
        )}
        <span className="rail-confirm-text">{text}</span>
        <ul className="rail-confirm-list">
          {items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
        <div className="rail-confirm-buttons">
          <button type="button" autoFocus className="rail-confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="rail-confirm-ok" onClick={onConfirm}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
