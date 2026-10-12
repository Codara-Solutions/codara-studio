import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  NotificationCenterEntry,
  NotificationMute,
  NavigationTarget,
  ResolvedRunQuestion,
} from "@shared/types";
import {
  countCenter,
  countsAsNeedsYou,
  mutedBy,
  sourceMuteKey,
  targetWorkspaceId,
  workspaceMuteKey,
} from "@shared/notify-center";
import { NotifyGlyphSvg } from "../components/Toast";
import { accentVar, kindMeta } from "./kinds";
import { GONE_LABEL, type NavigateTo, type NotifyTargetStatus } from "./routing";
import {
  buildSections,
  clearableIds,
  displayBody,
  displayText,
  entryCount,
  filterCounts,
  foldSummary,
  fullTime,
  isWaiting,
  remainingLabel,
  rowTime,
  sourceLabel,
  stackTitle,
  untilTomorrowMs,
  workspaceOf,
  type CenterFilter,
  type CenterGrouping,
  type CenterItem,
  type CenterSection,
  type NotifyWorkspaceMeta,
} from "./center-view";
import { useNotificationCenter } from "./useNotificationCenter";

// Notification center: a bell in the window chrome and the panel it opens
// over the persisted history (main-side, see src/main/notify/center-store).
// Questions the user has not seen are pinned under "Needs you", and that one
// set is what the badge, the tab and the pinned header count. A question
// already read or muted stays open in its day with a Waiting tag. The rest
// group by day or by workspace, with similar rows stacked. Opening a row
// routes its target and marks it read; it stays in the history until
// dismissed. A row whose pane, run or workspace is gone says so, and opening
// it lands on the workspace when that still exists. A blocked Cora run or
// automation can be answered in place.

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: "drag" | "no-drag";
};

const LIVE: NotifyTargetStatus = { state: "live" };
const HOUR_MS = 60 * 60_000;
const FILTER_KEY = "spark.notify.filter";
const GROUPING_KEY = "spark.notify.grouping";

const FILTERS: Array<{ id: CenterFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs-you", label: "Needs you" },
  { id: "unread", label: "Unread" },
];

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* a remembered filter is a convenience */
  }
}

function questionRunId(entry: NotificationCenterEntry): string | null {
  if (entry.kind === "run.blocked" && entry.target.type === "run") return entry.target.runId;
  if (entry.kind === "automation.blocked" && entry.target.type === "automation") {
    return entry.target.runId ?? null;
  }
  return null;
}

function focusRow(list: HTMLElement | null, entryId: string): void {
  const row = list?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`);
  row?.focus({ preventScroll: true });
}

export interface NotificationCenterProps {
  navigateTo?: NavigateTo;
  resolveQuestion?: (runId: string) => ResolvedRunQuestion | null;
  describeTarget?: (target: NavigationTarget) => NotifyTargetStatus;
  workspaces?: readonly NotifyWorkspaceMeta[];
}

// Everything a row can do, held in one stable object so memoized rows do not
// re-render when the panel's handlers are recreated.
interface RowActions {
  open: (entry: NotificationCenterEntry) => void;
  setRead: (entry: NotificationCenterEntry, read: boolean) => void;
  dismiss: (entry: NotificationCenterEntry) => void;
  toggleMenu: (entryId: string | null) => void;
  mute: (entryId: string, key: string, label: string, durationMs: number) => void;
  unmute: (entryId: string, key: string) => void;
  answer: (entry: NotificationCenterEntry, runId: string, questionMessageId: string, message: string) => Promise<void>;
}

interface RowView {
  status: NotifyTargetStatus;
  muted: NotificationMute | null;
  time: string;
  workspace: { id: string | null; name: string | null; color?: string };
  // "pinned": an open question the user has not seen; "seen": still open,
  // but read or muted, so it sits quietly in its day.
  waiting: "pinned" | "seen" | null;
  question: ResolvedRunQuestion | null;
  // The head of a collapsed stack speaks for the whole stack.
  stackTitle: string | null;
}

interface RowProps {
  entry: NotificationCenterEntry;
  view: RowView;
  // The section header already names the workspace.
  hideWorkspace: boolean;
  menuOpen: boolean;
  actions: RowActions;
}

export default function NotificationCenter({
  navigateTo,
  resolveQuestion,
  describeTarget,
  workspaces,
}: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bellRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const center = useNotificationCenter(open);
  const [dnd, setDnd] = useState(false);
  const [filter, setFilterState] = useState<CenterFilter>(() =>
    readStored(FILTER_KEY, ["all", "needs-you", "unread"], "all"),
  );
  const [grouping, setGroupingState] = useState<CenterGrouping>(() =>
    readStored(GROUPING_KEY, ["time", "workspace"], "time"),
  );
  // Section keys whose default fold the user flipped, and stack keys opened.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuForRef = useRef(menuFor);
  menuForRef.current = menuFor;
  const [now, setNow] = useState(() => Date.now());

  const setFilter = (next: CenterFilter) => {
    setFilterState(next);
    writeStored(FILTER_KEY, next);
  };
  const setGrouping = (next: CenterGrouping) => {
    setGroupingState(next);
    writeStored(GROUPING_KEY, next);
  };

  // DND preference: seeded from disk, tracked through the preferences push
  // so a toggle from anywhere stays in sync.
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

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setMenuFor(null);
    if (restoreFocus) bellRef.current?.focus();
  }, []);

  // Relative times tick while the panel is open.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  // Click-away closes. Escape is taken in the capture phase and stopped, so
  // the terminal or editor underneath never receives the same keypress. It
  // peels one layer at a time: the mute menu, then a reply being typed, then
  // the panel, with focus going back to the row or the bell.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (rootRef.current && !rootRef.current.contains(target)) {
        close(false);
        return;
      }
      if (menuForRef.current && !target?.closest(".nc-menu, [data-menu-trigger]")) setMenuFor(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      const menuEntry = menuForRef.current;
      if (menuEntry) {
        setMenuFor(null);
        focusRow(listRef.current, menuEntry);
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      if (active?.matches("input") && listRef.current?.contains(active)) {
        const row = active.closest<HTMLElement>("[data-entry-id]");
        if (row) row.focus({ preventScroll: true });
        else active.blur();
        return;
      }
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  // Focus moves into the list on open so the arrow keys work at once.
  useEffect(() => {
    if (open) listRef.current?.focus({ preventScroll: true });
  }, [open]);

  const workspaceMap = useMemo(
    () => new Map((workspaces ?? []).map((w) => [w.id, w] as const)),
    [workspaces],
  );
  const statusOf = useCallback(
    (entry: NotificationCenterEntry): NotifyTargetStatus =>
      describeTarget ? describeTarget(entry.target) : LIVE,
    [describeTarget],
  );
  const isGone = useCallback(
    (entry: NotificationCenterEntry) => statusOf(entry).state === "gone",
    [statusOf],
  );

  // One count for the badge, the Needs you tab and the pinned header, from
  // one rule (countsAsNeedsYou). `now` matters only for mutes, which tick
  // the hook's muteClock when they lapse.
  const counts = useMemo(() => {
    const at = Date.now();
    if (!center.loaded) return { ...center.summary, "needs-you": center.summary.needsYou };
    const total = countCenter(center.entries, center.mutes, at, isGone);
    return { ...total, ...filterCounts(center.entries, { now: at, mutes: center.mutes, isGone }) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.loaded, center.summary, center.entries, center.mutes, center.muteClock, isGone, now]);

  const nowMinute = Math.floor(now / 60_000);
  const sections = useMemo(
    () =>
      open
        ? buildSections(center.entries, {
            filter,
            grouping,
            now: Date.now(),
            mutes: center.mutes,
            workspaces: workspaceMap,
            isGone,
          })
        : [],
    // nowMinute, not now: sections only move across day boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, center.entries, center.mutes, center.muteClock, filter, grouping, nowMinute, workspaceMap, isGone],
  );

  const clearable = useMemo(() => clearableIds(center.entries, isGone), [center.entries, isGone]);
  const keeps = center.entries.length - clearable.length;

  const centerRef = useRef(center);
  centerRef.current = center;
  const navigateRef = useRef(navigateTo);
  navigateRef.current = navigateTo;

  const actions = useMemo<RowActions>(
    () => ({
      open: (entry) => {
        const navigate = navigateRef.current;
        if (!navigate) return;
        const outcome = navigate(entry.target);
        if (outcome === "gone") return;
        if (!entry.read) centerRef.current.setRead([entry.id], true);
        close(false);
      },
      setRead: (entry, read) => centerRef.current.setRead([entry.id], read),
      dismiss: (entry) => centerRef.current.dismiss([entry.id]),
      toggleMenu: (entryId) => setMenuFor((current) => (current === entryId ? null : entryId)),
      mute: (entryId, key, label, durationMs) => {
        centerRef.current.mute(key, label, durationMs);
        setMenuFor(null);
        window.requestAnimationFrame(() => focusRow(listRef.current, entryId));
      },
      unmute: (entryId, key) => {
        centerRef.current.unmute(key);
        setMenuFor(null);
        window.requestAnimationFrame(() => focusRow(listRef.current, entryId));
      },
      answer: async (entry, runId, questionMessageId, message) => {
        await window.spark.orchestration.answerRunQuestion({ runId, questionMessageId, message });
        // Answering is reading. The row stays until the run resumes and
        // settles it, so a failed resume is still visible here.
        if (!entry.read) centerRef.current.setRead([entry.id], true);
      },
    }),
    [close],
  );

  const toggleKey = (key: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const viewOf = (entry: NotificationCenterEntry, withDay: boolean, stack: string | null): RowView => {
    const status = statusOf(entry);
    const open = isWaiting(entry) && status.state !== "gone";
    const runId = open ? questionRunId(entry) : null;
    return {
      status,
      muted: mutedBy(entry, center.mutes, now),
      time: rowTime(entry.createdAt, now, withDay),
      workspace: workspaceOf(entry, workspaceMap),
      waiting: !open ? null : countsAsNeedsYou(entry, center.mutes, now) ? "pinned" : "seen",
      question: runId && resolveQuestion ? resolveQuestion(runId) : null,
      stackTitle: stack,
    };
  };

  // Keyboard: arrows (or j/k) move between rows and the list's controls,
  // Enter opens, R toggles read, Delete or Backspace dismisses, M opens the
  // mute menu. Keys typed into a reply field are the reply's.
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("input, textarea, .nc-menu")) return;
    const list = listRef.current;
    if (!list) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>("[data-nc-nav]"));
    const active = document.activeElement as HTMLElement | null;
    const current = active ? items.findIndex((el) => el === active) : -1;
    const focusAt = (index: number) => {
      const el = items[Math.max(0, Math.min(items.length - 1, index))];
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    };
    const key = e.key;
    if (key === "ArrowDown" || key === "j") {
      e.preventDefault();
      focusAt(current + 1);
      return;
    }
    if (key === "ArrowUp" || key === "k") {
      e.preventDefault();
      focusAt(current <= 0 ? 0 : current - 1);
      return;
    }
    if (key === "Home" || key === "End") {
      e.preventDefault();
      focusAt(key === "Home" ? 0 : items.length - 1);
      return;
    }
    const entryId = active?.dataset.entryId;
    if (!entryId) return;
    const entry = center.entries.find((x) => x.id === entryId);
    if (!entry) return;
    if (key === "r" || key === "R") {
      e.preventDefault();
      actions.setRead(entry, !entry.read);
    } else if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      actions.dismiss(entry);
      window.requestAnimationFrame(() => {
        const after = Array.from(list.querySelectorAll<HTMLElement>("[data-nc-nav]"));
        after[Math.min(current, after.length - 1)]?.focus();
      });
    } else if (key === "m" || key === "M") {
      e.preventDefault();
      actions.toggleMenu(entry.id);
    }
  };

  const renderRow = (
    entry: NotificationCenterEntry,
    withDay: boolean,
    hideWorkspace: boolean,
    stack: string | null = null,
  ) => (
    <CenterRow
      key={entry.id}
      entry={entry}
      view={viewOf(entry, withDay, stack)}
      hideWorkspace={hideWorkspace || stack !== null}
      menuOpen={menuFor === entry.id}
      actions={actions}
    />
  );

  const renderItem = (item: CenterItem, withDay: boolean, inWorkspace: boolean) => {
    if (item.type === "row") return renderRow(item.entry, withDay, inWorkspace);
    const expanded = toggled.has(`stack:${item.key}`);
    const [head, ...rest] = item.entries;
    const unread = item.entries.filter((e) => !e.read).length;
    const ws = workspaceOf(head, workspaceMap);
    const title = expanded ? null : stackTitle(item.entries, inWorkspace ? null : ws.name);
    return (
      <div key={`stack:${item.key}`} className="nc-stack" data-expanded={expanded}>
        {renderRow(head, withDay, inWorkspace, title)}
        {expanded && (
          <div className="nc-stack-children">{rest.map((e) => renderRow(e, withDay, inWorkspace))}</div>
        )}
        <button
          type="button"
          className="nc-stack-more"
          data-nc-nav
          aria-expanded={expanded}
          onClick={() => toggleKey(`stack:${item.key}`)}
        >
          <span className="nc-stack-layers" aria-hidden />
          {expanded
            ? "Show less"
            : `${item.entries.length === 2 ? "Show both" : `Show all ${item.entries.length}`}${unread > 0 ? ` · ${unread} unread` : ""}`}
        </button>
      </div>
    );
  };

  const renderSection = (section: CenterSection) => {
    const foldable = Boolean(section.collapsed) || section.key === "older";
    const collapsed = Boolean(section.collapsed) !== toggled.has(`section:${section.key}`);
    const showAll = toggled.has(`all:${section.key}`);
    const limit = section.limit && !showAll ? section.limit : section.items.length;
    const isWorkspace = section.key.startsWith("ws:");
    const withDay = grouping === "workspace" || section.key === "older" || section.tone === "needs-you" || section.key === "seen";
    return (
      <section key={section.key} className="nc-section" data-tone={section.tone} aria-label={section.label}>
        <div className="nc-section-head" data-workspace={isWorkspace}>
          {isWorkspace && (
            <span
              className="nc-ws-dot"
              style={{ ["--nc-ws" as string]: section.color ?? "var(--muted)" }}
            />
          )}
          <span>{section.label}</span>
          {section.showCount && <span className="nc-section-count">{section.rows}</span>}
          {section.note && <span className="nc-section-note">{section.note}</span>}
          {foldable && (
            <button
              type="button"
              className="nc-section-toggle"
              data-nc-nav
              aria-expanded={!collapsed}
              onClick={() => toggleKey(`section:${section.key}`)}
            >
              {collapsed ? "Show" : "Hide"}
              <Chevron down={collapsed} />
            </button>
          )}
        </div>
        {!collapsed && section.items.slice(0, limit).map((item) => renderItem(item, withDay, isWorkspace))}
        {!collapsed && limit < section.items.length && (
          <button
            type="button"
            className="nc-more"
            data-nc-nav
            onClick={() => toggleKey(`all:${section.key}`)}
          >
            {section.tone === "needs-you"
              ? `Show ${section.items.length - limit} more waiting on you`
              : `Show ${section.items.length - limit} more from ${section.label}`}
          </button>
        )}
      </section>
    );
  };

  const needsYou = counts.needsYou;
  const bellLabel =
    needsYou > 0
      ? `Notifications: ${needsYou} need${needsYou === 1 ? "s" : ""} you`
      : counts.notable > 0
        ? `Notifications (${counts.notable} new)`
        : "Notifications";

  return (
    <div ref={rootRef} style={{ display: "flex", alignItems: "stretch" }}>
      <button
        ref={bellRef}
        type="button"
        data-window-control
        className="nc-bell"
        title="Notifications"
        aria-label={bellLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close(false) : setOpen(true))}
        style={
          {
            appearance: "none",
            position: "relative",
            width: 32,
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: open ? "var(--hover)" : undefined,
            border: "none",
            borderLeft: "1px solid var(--rule-soft)",
            color: open || needsYou > 0 ? "var(--ink)" : "var(--ink-dim)",
            cursor: "default",
            padding: 0,
            WebkitAppRegion: "no-drag",
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
          } as AppRegionStyle
        }
      >
        <NotifyGlyphSvg glyph="bell" size={14} />
        {needsYou > 0 ? (
          <span className="nc-bell-badge" data-testid="nc-badge" aria-hidden>
            {needsYou > 9 ? "9+" : needsYou}
          </span>
        ) : counts.notable > 0 ? (
          <span className="nc-bell-dot" aria-hidden />
        ) : null}
      </button>

      {open && (
        <div className="nc-panel" role="dialog" aria-label="Notifications">
          <div className="nc-head">
            <div className="nc-head-row">
              <span className="nc-heading">Notifications</span>
              <span className="nc-spacer" />
              {center.entries.length > 0 && (
                <button
                  type="button"
                  className="nc-btn"
                  disabled={counts.unread === 0}
                  onClick={center.markAllRead}
                  title="Mark every notification read"
                >
                  <CheckAllIcon />
                  Mark all read
                </button>
              )}
              {clearable.length > 0 && (
                <button
                  type="button"
                  className="nc-btn"
                  onClick={() => center.clear(clearable)}
                  title={
                    keeps > 0
                      ? `Remove everything except the ${keeps} question${keeps === 1 ? "" : "s"} still waiting on an answer (you can undo)`
                      : "Remove every notification (you can undo)"
                  }
                >
                  Clear all
                  {keeps > 0 && <span className="nc-btn-note">keeps {keeps} waiting</span>}
                </button>
              )}
            </div>
            <div className="nc-filters" hidden={center.loaded && center.entries.length === 0}>
              <div role="tablist" aria-label="Filter notifications" style={{ display: "flex", gap: 2 }}>
                {FILTERS.map((f) => {
                  const n = f.id === "all" ? 0 : counts[f.id];
                  return (
                    <button
                      key={f.id}
                      type="button"
                      role="tab"
                      className="nc-filter"
                      data-tone={f.id}
                      aria-selected={filter === f.id}
                      onClick={() => setFilter(f.id)}
                    >
                      {f.label}
                      <span className="nc-filter-count">{n > 0 ? n : ""}</span>
                    </button>
                  );
                })}
              </div>
              <span className="nc-spacer" />
              <div className="nc-seg" role="group" aria-label="Group notifications">
                <button
                  type="button"
                  aria-pressed={grouping === "time"}
                  title="Group by day"
                  aria-label="Group by day"
                  onClick={() => setGrouping("time")}
                >
                  <ClockIcon />
                </button>
                <button
                  type="button"
                  aria-pressed={grouping === "workspace"}
                  title="Group by workspace"
                  aria-label="Group by workspace"
                  onClick={() => setGrouping("workspace")}
                >
                  <FolderIcon />
                </button>
              </div>
            </div>
          </div>

          <div
            ref={listRef}
            className="nc-list"
            tabIndex={0}
            aria-label="Notification history"
            onKeyDown={onListKeyDown}
          >
            {center.loaded && sections.length === 0 && (
              <EmptyState filter={filter} hasAny={center.entries.length > 0} dnd={dnd} />
            )}
            {sections.map(renderSection)}
          </div>

          {center.undo && (
            <div className="nc-undo" role="status">
              <span>{center.undo.label}</span>
              <button type="button" onClick={center.runUndo}>
                Undo
              </button>
            </div>
          )}

          <div className="nc-foot">
            {center.mutes.map((m) => (
              <div key={m.key} className="nc-mute">
                <BellOffIcon />
                <span className="nc-mute-label">Muted: {m.label}</span>
                <span className="nc-mute-left">{remainingLabel(m.until, now)}</span>
                <span className="nc-spacer" />
                <button type="button" className="nc-btn" onClick={() => center.unmute(m.key)}>
                  Unmute
                </button>
              </div>
            ))}
            <div className="nc-foot-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="nc-foot-title">Do Not Disturb</div>
                <div className="nc-foot-sub">
                  {dnd
                    ? "Banners and sounds are off. Alerts still collect here."
                    : "Silence banners and sounds. Alerts still collect here."}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                className="nc-switch"
                aria-checked={dnd}
                aria-label="Do Not Disturb"
                onClick={toggleDnd}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type AnswerState = { phase: "idle" } | { phase: "sending" } | { phase: "sent" } | { phase: "error"; message: string };

const CenterRow = memo(function CenterRow({
  entry,
  view,
  hideWorkspace,
  menuOpen,
  actions,
}: RowProps) {
  const meta = kindMeta(entry.kind);
  const tone = accentVar(entry.kind, entry.tone ?? meta.tone);
  const text = displayText(entry);
  const title = view.stackTitle ?? text.title;
  const context = view.stackTitle && text.context ? `Latest in ${text.context}` : text.context;
  const body = displayBody(entry);
  const fold = foldSummary(entry);
  const count = view.stackTitle || fold ? 1 : entryCount(entry);
  const gone = view.status.state === "gone" ? view.status.reason : null;
  const canFallback = gone === "pane" || gone === "run";
  const workspaceId = targetWorkspaceId(entry.target);
  const openable = !gone || canFallback;
  const sourceKey = sourceMuteKey(entry.sourceKey);
  const wsKey = workspaceId ? workspaceMuteKey(workspaceId) : null;
  const showWorkspace = Boolean(view.workspace.name) && !hideWorkspace;
  const earlier = useMemo(() => earlierBodies(entry), [entry]);

  const [answerOpen, setAnswerOpen] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [draft, setDraft] = useState("");
  const [answerState, setAnswerState] = useState<AnswerState>({ phase: "idle" });
  const menuRef = useRef<HTMLDivElement | null>(null);

  const question = view.question;
  const runId = question ? questionRunId(entry) : null;
  const answerable = Boolean(question && runId && view.waiting);
  const showAnswer = answerable && (view.waiting === "pinned" || answerOpen || answerState.phase !== "idle");

  // Only a question that can still be answered gets a button; any other row
  // opens with a click on the row itself.
  let primary: { label: string; run: () => void } | null = null;
  if (view.waiting) {
    if (entry.target.type === "terminal") {
      primary = { label: "Reply in terminal", run: () => actions.open(entry) };
    } else if (answerable && !showAnswer) {
      primary = { label: "Answer", run: () => setAnswerOpen(true) };
    } else {
      primary = {
        label: entry.kind === "automation.blocked" ? "Open automation" : "Open run",
        run: () => actions.open(entry),
      };
    }
  }
  // An inline answer is the main action, so the way out to the run is quiet.
  const primaryQuiet = view.waiting === "seen" || showAnswer;

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuOpen]);

  const send = (message: string) => {
    const text = message.trim();
    if (!text || !runId || !question || answerState.phase === "sending") return;
    setAnswerState({ phase: "sending" });
    actions.answer(entry, runId, question.questionMessageId, text).then(
      () => {
        setDraft("");
        setAnswerState({ phase: "sent" });
      },
      (err: unknown) => {
        const reason = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "";
        setAnswerState({ phase: "error", message: reason || "The answer did not reach the run." });
      },
    );
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = at <= 0 ? items.length - 1 : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Tab") {
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    items[next]?.focus();
  };

  const showMeta =
    showWorkspace || Boolean(context) || Boolean(fold) || Boolean(gone) || entry.settled || Boolean(view.muted) || Boolean(view.waiting) || Boolean(primary);

  return (
    <div
      className="nc-row"
      role="article"
      data-nc-nav
      data-entry-id={entry.id}
      data-unread={!entry.read}
      data-waiting={view.waiting ?? undefined}
      data-gone={Boolean(gone)}
      data-menu={menuOpen}
      tabIndex={-1}
      aria-label={`${title}${view.workspace.name ? `, ${view.workspace.name}` : ""}${view.waiting ? ", waiting on you" : ""}${entry.read ? "" : ", unread"}${gone ? `, ${GONE_LABEL[gone].toLowerCase()}` : ""}`}
      style={{ ["--nc-tone" as string]: tone }}
      onClick={(e) => {
        if (!openable || (e.target as Element).closest("button, input, .nc-answer, .nc-menu, .nc-earlier-list")) return;
        actions.open(entry);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (openable) actions.open(entry);
        } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && earlier.length > 0) {
          e.preventDefault();
          setShowEarlier(e.key === "ArrowRight");
        }
      }}
    >
      <span className="nc-icon" aria-hidden>
        <NotifyGlyphSvg glyph={meta.glyph} size={13} />
      </span>
      <div className="nc-main">
        <div className="nc-line1">
          <button
            type="button"
            className="nc-open"
            tabIndex={-1}
            disabled={!openable}
            title={gone ? (canFallback ? `${GONE_LABEL[gone]}. Opens its workspace.` : `${GONE_LABEL[gone]}.`) : entry.title || title}
            onClick={() => actions.open(entry)}
          >
            <span className="nc-title">{title}</span>
          </button>
          {count > 1 && (
            <span
              className="nc-count"
              title={`${count} times${entry.firstAt ? ` since ${fullTime(entry.firstAt)}` : ""}`}
            >
              {count}×
            </span>
          )}
          <span className="nc-time" title={fullTime(entry.createdAt)}>
            {view.time}
          </span>
          {!entry.read && <span className="nc-unread-dot" aria-hidden />}
        </div>
        {showMeta && (
          <div className="nc-meta">
            {showWorkspace && (
              <span className="nc-meta-ws">
                <span
                  className="nc-ws-dot"
                  style={{ ["--nc-ws" as string]: view.workspace.color ?? "var(--muted)" }}
                />
                {view.workspace.name}
              </span>
            )}
            {showWorkspace && (context || fold) && <span className="nc-meta-sep">·</span>}
            {context && <span className="nc-meta-text">{context}</span>}
            {!context && fold && <span className="nc-meta-text">{fold}</span>}
            {view.waiting === "seen" && (
              <span
                className="nc-tag"
                data-kind="waiting"
                title={view.muted ? `Still waiting on you. Muted: ${view.muted.label}` : "Still waiting on you"}
              >
                {view.muted && <BellOffIcon size={10} />} Waiting
              </span>
            )}
            {gone && (
              <span className="nc-tag" data-kind="gone">
                {GONE_LABEL[gone]}
              </span>
            )}
            {entry.settled && !gone && <span className="nc-tag">Resolved</span>}
            {view.muted && view.waiting !== "seen" && (
              <span className="nc-tag" title={`Muted: ${view.muted.label}`}>
                <BellOffIcon size={10} /> Muted
              </span>
            )}
            {primary && (
              <button
                type="button"
                className="nc-primary"
                data-quiet={primaryQuiet}
                onClick={primary.run}
              >
                {primary.label}
              </button>
            )}
          </div>
        )}
        {body && <div className="nc-body">{body}</div>}
        {earlier.length > 0 && (
          <div className="nc-earlier">
            <button
              type="button"
              className="nc-earlier-toggle"
              tabIndex={-1}
              aria-expanded={showEarlier}
              onClick={() => setShowEarlier((v) => !v)}
            >
              <Chevron down={!showEarlier} />
              {showEarlier ? "Hide earlier" : `${earlier.length} earlier`}
            </button>
            {showEarlier && (
              <ul className="nc-earlier-list">
                {earlier.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {showAnswer && question && (
          <div className="nc-answer">
            {answerState.phase === "sent" ? (
              <div className="nc-answer-note" role="status">
                <CheckIcon /> Answer sent. Cora picks it up from here.
              </div>
            ) : (
              <>
                {question.options.length > 0 && (
                  <div className="nc-options" role="group" aria-label="Answers">
                    {question.options.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className="nc-option"
                        data-recommended={option.recommended === true}
                        title={option.description || option.answer}
                        disabled={answerState.phase === "sending"}
                        onClick={() => send(option.answer || option.label)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
                <form
                  className="nc-reply"
                  onSubmit={(e) => {
                    e.preventDefault();
                    send(draft);
                  }}
                >
                  <input
                    type="text"
                    value={draft}
                    placeholder={question.options.length > 0 ? "Or reply in your own words..." : "Reply..."}
                    aria-label="Reply to Cora"
                    disabled={answerState.phase === "sending"}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="nc-reply-send"
                    aria-label="Send reply"
                    title="Send (Enter)"
                    disabled={!draft.trim() || answerState.phase === "sending"}
                  >
                    <SendIcon />
                  </button>
                </form>
                {answerState.phase === "error" && (
                  <div className="nc-answer-error" role="alert">
                    {answerState.message}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className="nc-actions">
        <button
          type="button"
          className="nc-action"
          tabIndex={-1}
          title={entry.read ? "Mark unread (R)" : "Mark read (R)"}
          aria-label={entry.read ? "Mark unread" : "Mark read"}
          onClick={() => actions.setRead(entry, !entry.read)}
        >
          {entry.read ? <DotIcon /> : <CheckIcon />}
        </button>
        <button
          type="button"
          className="nc-action"
          tabIndex={-1}
          data-menu-trigger
          title="Mute (M)"
          aria-label="Mute"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => actions.toggleMenu(entry.id)}
        >
          <BellOffIcon />
        </button>
        <button
          type="button"
          className="nc-action"
          data-danger="true"
          tabIndex={-1}
          title="Dismiss (Delete)"
          aria-label="Dismiss"
          onClick={() => actions.dismiss(entry)}
        >
          <CrossIcon />
        </button>
      </div>
      {menuOpen && (
        <div ref={menuRef} className="nc-menu" role="menu" aria-label="Mute" onKeyDown={onMenuKeyDown}>
          {view.muted ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => actions.unmute(entry.id, view.muted!.key)}
            >
              Unmute {view.muted.label}
            </button>
          ) : (
            <>
              <div className="nc-menu-label">Mute for 1 hour</div>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => actions.mute(entry.id, sourceKey, sourceLabel(entry), HOUR_MS)}
              >
                {sourceLabel(entry)}
              </button>
              {wsKey && view.workspace.name && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => actions.mute(entry.id, wsKey, view.workspace.name!, HOUR_MS)}
                >
                  Everything in {view.workspace.name}
                </button>
              )}
              {wsKey && view.workspace.name && (
                <>
                  <div className="nc-menu-label">Until tomorrow morning</div>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() =>
                      actions.mute(entry.id, wsKey, view.workspace.name!, untilTomorrowMs(Date.now()))
                    }
                  >
                    Everything in {view.workspace.name}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
},
sameRow);

// Earlier bodies worth showing: an agent's earlier messages, a bot's earlier
// pushes. Bare durations ("took 3m") are dropped; they say nothing new.
function earlierBodies(entry: NotificationCenterEntry): string[] {
  if (!entry.earlier || entry.earlier.length === 0) return [];
  const out: string[] = [];
  for (const raw of entry.earlier) {
    const text = displayBody({ ...entry, body: raw });
    if (text && !/^took \S+$/i.test(text)) out.push(text);
  }
  return out;
}

function sameRow(a: RowProps, b: RowProps): boolean {
  return (
    a.entry === b.entry &&
    a.hideWorkspace === b.hideWorkspace &&
    a.menuOpen === b.menuOpen &&
    a.actions === b.actions &&
    a.view.time === b.view.time &&
    a.view.waiting === b.view.waiting &&
    a.view.stackTitle === b.view.stackTitle &&
    a.view.question?.questionMessageId === b.view.question?.questionMessageId &&
    a.view.question?.options.length === b.view.question?.options.length &&
    a.view.muted?.key === b.view.muted?.key &&
    a.view.status.state === b.view.status.state &&
    (a.view.status.state === "live" ||
      (b.view.status.state === "gone" && a.view.status.reason === b.view.status.reason)) &&
    a.view.workspace.name === b.view.workspace.name &&
    a.view.workspace.color === b.view.workspace.color
  );
}

function EmptyState({ filter, hasAny, dnd }: { filter: CenterFilter; hasAny: boolean; dnd: boolean }) {
  const title =
    filter === "needs-you" ? "Nothing needs you" : filter === "unread" ? "All read" : "You're all caught up";
  const body = hasAny
    ? filter === "needs-you"
      ? "When an agent asks a question or Cora is blocked on you, it waits here."
      : "Older notifications are under All."
    : dnd
      ? "Do Not Disturb is on. New alerts will still collect here quietly."
      : "Finished turns, questions from agents and Cora runs, failures and teammate pushes will collect here.";
  return (
    <div className="nc-empty">
      <span className="nc-empty-art" aria-hidden>
        <NotifyGlyphSvg glyph={filter === "needs-you" ? "check" : "bell"} size={22} />
      </span>
      <div className="nc-empty-title">{title}</div>
      <div className="nc-empty-body">{body}</div>
    </div>
  );
}

function SendIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 11.5 V2.8 M3.2 6.4 L7 2.6 L10.8 6.4" />
    </svg>
  );
}

function Chevron({ down }: { down: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={down ? "M2.5 4 L5 6.5 L7.5 4" : "M2.5 6 L5 3.5 L7.5 6"} />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7.5 L6 10.5 L11 4" />
    </svg>
  );
}

function CheckAllIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1.5 7.5 L4.5 10.5 L9.5 4" />
      <path d="M7.5 10 L8 10.5 L13 4" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="3.2" fill="currentColor" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M3 3 L9 9 M9 3 L3 9" />
    </svg>
  );
}

function BellOffIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.2 3.4 A3.4 3.4 0 0 1 10.4 5.4 c0 2.6 1 3.4 1 3.4 H5.6" />
      <path d="M3.6 5.6 c-0.1 2.4 -1 3.2 -1 3.2 h1.6" />
      <path d="M5.9 11.2 a1.2 1.2 0 0 0 2.2 0" />
      <path d="M2 2 L12 12" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <circle cx="7" cy="7" r="5.2" />
      <path d="M7 4.2 V7 L8.9 8.3" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
      <path d="M1.8 3.6 a1 1 0 0 1 1 -1 H5.6 l1.3 1.4 H11.2 a1 1 0 0 1 1 1 V10.4 a1 1 0 0 1 -1 1 H2.8 a1 1 0 0 1 -1 -1 Z" />
    </svg>
  );
}
