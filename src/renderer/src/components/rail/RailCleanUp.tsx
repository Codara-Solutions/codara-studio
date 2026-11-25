import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  leftoverText,
  type WorktreeLeftoverProcess,
  type WorktreeRailCleanupRequest,
  type WorktreeRailCleanupResult,
} from "@shared/worktree-cleanup";

// Clean up from the rail, on a merged row or its project's fold, always ends
// in something the user can see next to the button: the rows go, one confirm
// names what would go with them (ignored files) or be stopped first
// (programs left running inside), or a short line says what holds a worktree
// back and what to do about it. A toast alone sat in the far corner for a
// few seconds, and the button looked like it did nothing.

/** What the user answered, sent back with the next try: the fingerprints of what they saw. */
export type RailCleanUpAnswer = Pick<WorktreeRailCleanupRequest, "confirmIgnored" | "confirmStop" | "preview">;

export interface RailCleanUpEntry {
  id: string;
  name: string;
  /** Resolves with what main did; null when there was nothing to report. */
  cleanUp: (answer?: RailCleanUpAnswer) => Promise<WorktreeRailCleanupResult | null>;
}

export interface RailCleanUpNotice {
  id: string;
  name: string;
  text: string;
  tone: "warning" | "danger";
}

export interface Holding {
  entry: RailCleanUpEntry;
  holds: string[];
  fingerprint?: string;
  processes: WorktreeLeftoverProcess[];
  stopFingerprint?: string;
  /** It was confirmed, then changed before the removal: say so, not just ask again. */
  changed: boolean;
}

export type RailCleanUpProgress = { phase: "checking" } | { phase: "cleaning"; done: number; total: number };

/** The button's words while it works. */
export function progressLabel(progress: RailCleanUpProgress | null): string | null {
  if (!progress) return null;
  if (progress.phase === "checking") return "Checking…";
  return progress.total > 1 ? `Cleaning ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : "Cleaning…";
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
  const [progress, setProgress] = useState<RailCleanUpProgress | null>(null);
  const [notices, setNotices] = useState<RailCleanUpNotice[]>([]);
  const [holding, setHolding] = useState<Holding[]>([]);
  const busy = useRef(false);

  // preview: ask main what each would need first, remove nothing, and put
  // every answer in one question. Otherwise each goes with its answer, and
  // what asks again (it changed) comes back as the question.
  const run = useCallback(
    async (entries: readonly RailCleanUpEntry[], answers: ReadonlyMap<string, RailCleanUpAnswer>, preview: boolean) => {
      if (busy.current) return;
      busy.current = true;
      setProgress(preview ? { phase: "checking" } : { phase: "cleaning", done: 0, total: entries.length });
      // Only the worktrees this run is about lose their line: confirming one
      // must not hide why another stayed.
      const ids = new Set(entries.map((entry) => entry.id));
      const others = (current: RailCleanUpNotice[]) => current.filter((notice) => !ids.has(notice.id));
      setNotices(others);
      const asks: Holding[] = [];
      const told: RailCleanUpNotice[] = [];
      try {
        for (const [index, entry] of entries.entries()) {
          if (!preview) setProgress({ phase: "cleaning", done: index, total: entries.length });
          const result = await entry
            .cleanUp(preview ? { preview: true } : answers.get(entry.id))
            .catch((cause: unknown) => ({
              status: "failed" as const,
              message: cause instanceof Error ? cause.message : String(cause),
              branchDeleted: false,
            }));
          if (result?.status === "confirm") {
            asks.push({
              entry,
              holds: result.holds ?? [],
              ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
              processes: result.processes ?? [],
              ...(result.stopFingerprint ? { stopFingerprint: result.stopFingerprint } : {}),
              changed: !preview && answers.has(entry.id),
            });
          }
          const notice = noticeFor(entry, result);
          if (notice) told.push(notice);
          // Each line shows as soon as its worktree is done.
          if (notice) setNotices((current) => [...others(current).filter((item) => item.id !== notice.id), ...told]);
        }
      } finally {
        busy.current = false;
        setProgress(null);
        setNotices((current) => [...others(current), ...told]);
        setHolding(asks);
      }
    },
    [],
  );

  // Several at once are checked first and asked about once, in one dialog;
  // one goes at once and asks only when something would be lost or stopped.
  const start = useCallback((entries: readonly RailCleanUpEntry[]) => void run(entries, new Map(), entries.length > 1), [run]);
  const confirmHolding = useCallback(() => {
    const answers = new Map(
      holding.map((item): [string, RailCleanUpAnswer] => [
        item.entry.id,
        {
          ...(item.fingerprint ? { confirmIgnored: item.fingerprint } : {}),
          ...(item.stopFingerprint ? { confirmStop: item.stopFingerprint } : {}),
        },
      ]),
    );
    const entries = holding.map((item) => item.entry);
    setHolding([]);
    void run(entries, answers, false);
  }, [holding, run]);
  const cancelHolding = useCallback(() => setHolding([]), []);
  const dismiss = useCallback((id: string) => setNotices((current) => current.filter((notice) => notice.id !== id)), []);

  // A worktree that left the rail some other way has nothing left to say,
  // and a question about one that left is no longer the one answered: it
  // closes, and a later merge does not bring it back.
  const live = new Set(liveIds);
  const stale = holding.some((item) => !live.has(item.entry.id));
  useEffect(() => {
    if (stale) setHolding([]);
  }, [stale]);
  return {
    cleaning: progress !== null,
    label: progressLabel(progress),
    notices: notices.filter((notice) => live.has(notice.id)),
    holding: stale ? [] : holding,
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

/**
 * The one question before a Clean up: for each worktree, the programs left
 * running in it that are stopped first and the ignored files that go with it.
 */
export function CleanUpConfirm({
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
  const stops = holding.some((item) => item.processes.length > 0);
  const keeps = holding.some((item) => item.holds.length > 0);
  const title = one
    ? one.processes.length
      ? `${one.entry.name} still runs ${one.processes.length === 1 ? one.processes[0].program : `${one.processes.length} programs`}`
      : one.holds.length
        ? `${one.entry.name} holds ${filesText(one.holds)}`
        : `Clean up ${one.entry.name}?`
    : `Clean up ${holding.length} merged worktrees?`;
  const changed = holding.filter((item) => item.changed).map((item) => item.entry.name);
  const note = !changed.length
    ? undefined
    : one
      ? "It changed since you were asked. Check the list again."
      : `${changed.join(", ")} changed since you were asked. Check the list again.`;
  const text = [
    stops
      ? one
        ? "Only these still use it. They are stopped first, and only while they still run inside it; then the worktree goes."
        : "Programs left running are stopped first, and only while they still run inside; then the worktrees go."
      : "",
    keeps ? "Git ignores the files named, so a fresh checkout won't bring them back and the recovery copy doesn't keep them." : "",
    !stops && !keeps ? "Their folders, branches and rows are removed:" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const lineOf = (item: Holding) => {
    const parts = [
      ...(item.processes.length ? [`stops ${item.processes.map(leftoverText).join("; ")}`] : []),
      ...(item.holds.length ? [`deletes ${item.holds.join(", ")}`] : []),
    ];
    return parts.length ? `${item.entry.name}: ${parts.join("; ")}` : item.entry.name;
  };
  return (
    <RailConfirm
      title={title}
      note={note}
      text={text}
      items={one ? [...one.processes.map(leftoverText), ...one.holds] : holding.map(lineOf)}
      okLabel={stops ? "Stop and clean up" : one && keeps ? "Remove anyway" : "Clean up"}
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
