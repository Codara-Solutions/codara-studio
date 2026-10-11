import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  NotificationCenterEntry,
  NotificationMute,
  NavigationTarget,
  ResolvedRunQuestion,
} from "@shared/types";
import { mutedBy, sourceMuteKey, targetWorkspaceId, workspaceMuteKey } from "@shared/notify-center";
import { NotifyGlyphSvg } from "../components/Toast";
import { accentVar, kindMeta } from "./kinds";
import { GONE_LABEL, type NavigateTo, type NotifyTargetStatus } from "./routing";
import {
  buildSections,
  displayText,
  entryCount,
  filterCounts,
  fullTime,
  isWaiting,
  remainingLabel,
  rowTime,
  sourceLabel,
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
// Rows still waiting on the user are pinned under "Needs you"; the rest
// group by day or by workspace, with similar rows stacked. Opening a row
// routes its target and marks it read; it stays in the history until
// dismissed. A row whose pane, run or workspace is gone says so, and opening
// it lands on the workspace when that still exists. A blocked run says only
// that an answer is wanted; the options stay in the run with their context.

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
  mute: (key: string, label: string, durationMs: number) => void;
  unmute: (key: string) => void;
}

interface RowProps {
  entry: NotificationCenterEntry;
  view: RowView;
  // The section header already names the workspace.
  hideWorkspace: boolean;
  menuOpen: boolean;
  actions: RowActions;
}

interface RowView {
  status: NotifyTargetStatus;
  muted: NotificationMute | null;
  time: string;
  workspace: { id: string | null; name: string | null; color?: string };
  question: boolean;
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
  // the terminal or editor underneath never receives the same keypress.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (menuForRef.current) setMenuFor(null);
      else close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);
  const menuForRef = useRef(menuFor);
  menuForRef.current = menuFor;

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
  const counts = useMemo(() => filterCounts(center.entries, isGone), [center.entries, isGone]);
  const nowMinute = Math.floor(now / 60_000);
  const sections = useMemo(
    () => buildSections(center.entries, { filter, grouping, now, workspaces: workspaceMap, isGone }),
    // nowMinute, not now: sections only move across day boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [center.entries, filter, grouping, nowMinute, workspaceMap, isGone],
  );

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
      mute: (key, label, durationMs) => {
        centerRef.current.mute(key, label, durationMs);
        setMenuFor(null);
      },
      unmute: (key) => {
        centerRef.current.unmute(key);
        setMenuFor(null);
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

  const viewOf = (entry: NotificationCenterEntry, withDay: boolean): RowView => {
    const runId =
      entry.target.type === "run"
        ? entry.target.runId
        : entry.target.type === "automation"
          ? entry.target.runId
          : undefined;
    return {
      status: statusOf(entry),
      muted: mutedBy(entry, center.mutes, now),
      time: rowTime(entry.createdAt, now, withDay),
      workspace: workspaceOf(entry, workspaceMap),
      question: Boolean(isWaiting(entry) && runId && resolveQuestion?.(runId)),
    };
  };

  // Keyboard: arrows (or j/k) move between rows and the list's controls,
  // Enter opens, R toggles read, Delete or Backspace dismisses, M opens the
  // mute menu.
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
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

  const renderRow = (entry: NotificationCenterEntry, withDay: boolean) => (
    <CenterRow
      key={entry.id}
      entry={entry}
      view={viewOf(entry, withDay)}
      hideWorkspace={grouping === "workspace"}
      menuOpen={menuFor === entry.id}
      actions={actions}
    />
  );

  const renderItem = (item: CenterItem, withDay: boolean) => {
    if (item.type === "row") return renderRow(item.entry, withDay);
    const expanded = toggled.has(`stack:${item.key}`);
    const [head, ...rest] = item.entries;
    const more = rest.reduce((n, e) => n + entryCount(e), 0);
    const unread = rest.filter((e) => !e.read).length;
    const ws = workspaceOf(head, workspaceMap);
    return (
      <div key={`stack:${item.key}`} className="nc-stack">
        {renderRow(head, withDay)}
        {expanded && <div className="nc-stack-children">{rest.map((e) => renderRow(e, withDay))}</div>}
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
            : `${more} more like this${ws.name && grouping !== "workspace" ? ` in ${ws.name}` : ""}${unread > 0 ? ` · ${unread} unread` : ""}`}
        </button>
      </div>
    );
  };

  const renderSection = (section: CenterSection) => {
    const foldable = Boolean(section.collapsed) || section.key === "older";
    const collapsed = Boolean(section.collapsed) !== toggled.has(`section:${section.key}`);
    const showAll = toggled.has(`all:${section.key}`);
    const limit = section.limit && !showAll ? section.limit : section.items.length;
    const withDay = grouping === "workspace" || section.key === "older" || section.tone === "needs-you";
    const isWorkspace = section.key.startsWith("ws:");
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
        {!collapsed && section.items.slice(0, limit).map((item) => renderItem(item, withDay))}
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

  const needsYou = center.needsYou;
  const unread = center.unread;
  const bellLabel =
    needsYou > 0
      ? `Notifications: ${needsYou} need${needsYou === 1 ? "s" : ""} you, ${unread} unread`
      : unread > 0
        ? `Notifications (${unread} unread)`
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
          <span className="nc-bell-badge" aria-hidden>
            {needsYou > 9 ? "9+" : needsYou}
          </span>
        ) : unread > 0 ? (
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
                <>
                  <button
                    type="button"
                    className="nc-btn"
                    disabled={unread === 0}
                    onClick={center.markAllRead}
                    title="Mark every notification read"
                  >
                    <CheckAllIcon />
                    Mark all read
                  </button>
                  <button
                    type="button"
                    className="nc-btn"
                    onClick={center.clearAll}
                    title="Remove every notification (you can undo)"
                  >
                    Clear all
                  </button>
                </>
              )}
            </div>
            <div className="nc-filters" hidden={center.loaded && center.entries.length === 0}>
              <div role="tablist" aria-label="Filter notifications" style={{ display: "flex", gap: 2 }}>
                {FILTERS.map((f) => (
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
                    <span className="nc-filter-count">{counts[f.id] > 0 ? counts[f.id] : ""}</span>
                  </button>
                ))}
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

const CenterRow = memo(function CenterRow({
  entry,
  view,
  hideWorkspace,
  menuOpen,
  actions,
}: RowProps) {
  const meta = kindMeta(entry.kind);
  const tone = accentVar(entry.kind, entry.tone ?? meta.tone);
  const { title, context } = displayText(entry);
  const count = entryCount(entry);
  const waiting = isWaiting(entry);
  const gone = view.status.state === "gone" ? view.status.reason : null;
  const canFallback = gone === "pane" || gone === "run";
  const open = waiting && !gone;
  const workspaceId = targetWorkspaceId(entry.target);

  // Only a question that can still be answered gets a button; any other row
  // opens with a click on the row itself.
  let primary: string | null = null;
  if (open) {
    if (entry.target.type === "terminal") primary = "Reply in terminal";
    else primary = view.question ? "Answer" : entry.kind === "automation.blocked" ? "Open automation" : "Open run";
  }

  const openable = !gone || canFallback;
  const sourceKey = sourceMuteKey(entry.sourceKey);
  const wsKey = workspaceId ? workspaceMuteKey(workspaceId) : null;

  return (
    <div
      className="nc-row"
      data-nc-nav
      data-entry-id={entry.id}
      data-unread={!entry.read}
      data-waiting={open}
      data-gone={Boolean(gone)}
      data-menu={menuOpen}
      role="button"
      tabIndex={-1}
      aria-label={`${title}${view.workspace.name ? `, ${view.workspace.name}` : ""}${entry.read ? "" : ", unread"}`}
      aria-disabled={!openable}
      title={gone ? (canFallback ? `${GONE_LABEL[gone]}. Opens its workspace.` : `${GONE_LABEL[gone]}.`) : undefined}
      style={{ ["--nc-tone" as string]: tone }}
      onClick={() => {
        if (openable) actions.open(entry);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (openable) actions.open(entry);
        }
      }}
    >
      <span className="nc-icon" aria-hidden>
        <NotifyGlyphSvg glyph={meta.glyph} size={13} />
      </span>
      <div className="nc-main">
        <div className="nc-line1">
          <span className="nc-title" title={entry.title || title}>
            {title}
          </span>
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
        {((view.workspace.name && !hideWorkspace) || context || gone || entry.settled || view.muted) && (
          <div className="nc-meta">
            {view.workspace.name && !hideWorkspace && (
              <span className="nc-meta-ws">
                <span
                  className="nc-ws-dot"
                  style={{ ["--nc-ws" as string]: view.workspace.color ?? "var(--muted)" }}
                />
                {view.workspace.name}
              </span>
            )}
            {view.workspace.name && !hideWorkspace && context && <span className="nc-meta-sep">·</span>}
            {context && <span>{context}</span>}
            {gone && (
              <span className="nc-tag" data-kind="gone">
                {GONE_LABEL[gone]}
              </span>
            )}
            {entry.settled && !gone && <span className="nc-tag">Resolved</span>}
            {view.muted && (
              <span className="nc-tag" title={`Muted: ${view.muted.label}`}>
                <BellOffIcon size={10} /> Muted
              </span>
            )}
          </div>
        )}
        {entry.body && <div className="nc-body">{entry.body}</div>}
        {primary && (
          <div className="nc-primary-row">
            <button
              type="button"
              className="nc-primary"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                actions.open(entry);
              }}
            >
              {primary}
            </button>
          </div>
        )}
      </div>
      <div className="nc-actions" onClick={(e) => e.stopPropagation()}>
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
        <div className="nc-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          {view.muted ? (
            <button type="button" role="menuitem" onClick={() => actions.unmute(view.muted!.key)}>
              Unmute {view.muted.label}
            </button>
          ) : (
            <>
              <div className="nc-menu-label">Mute for 1 hour</div>
              <button
                type="button"
                role="menuitem"
                onClick={() => actions.mute(sourceKey, sourceLabel(entry), HOUR_MS)}
              >
                {sourceLabel(entry)}
              </button>
              {wsKey && view.workspace.name && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => actions.mute(wsKey, view.workspace.name!, HOUR_MS)}
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
                    onClick={() =>
                      actions.mute(wsKey, view.workspace.name!, untilTomorrowMs(Date.now()))
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

function sameRow(a: RowProps, b: RowProps): boolean {
  return (
    a.entry === b.entry &&
    a.hideWorkspace === b.hideWorkspace &&
    a.menuOpen === b.menuOpen &&
    a.actions === b.actions &&
    a.view.time === b.view.time &&
    a.view.question === b.view.question &&
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
