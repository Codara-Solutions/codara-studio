/*
 * The Agents tab, as an inbox.
 *
 * Design source: T3 Code's thread sidebar (github.com/pingdotgg/t3code, MIT,
 * by Theo / Ping Labs): three-line rows with no box, a status word top right,
 * Working, Snoozed and Settled shelves at the bottom, Snooze and Settle on
 * hover, a merged pull request that settles itself, and undo as one quiet
 * line in the footer. The look and the behaviour follow T3 Code; this code is
 * Codara's own. Merge PR in the menu is our addition. See DESIGN.md, "Agents
 * tab".
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  agentSnoozeWakeLabel,
  renameAgent,
  setAgentPinned,
  setAgentUnread,
  settleAgent,
  snoozeAgent,
  unsettleAgent,
  wakeAgent,
  type AgentInboxRow as Row,
  type AgentInboxView,
} from "@shared/agent-inbox";
import type { GitHubMergeResult } from "@shared/github";
import AgentInboxRow, { type AgentInboxShelf } from "./AgentInboxRow";
import AgentInboxMenu, { type AgentInboxMenuActions, type AgentInboxMenuView } from "./AgentInboxMenu";
import {
  copyPullRequestLink,
  deleteFromInbox,
  mergeFromInbox,
  settleMerged,
  type MergeConfirmRequest,
} from "./agentInboxActions";
import {
  getAgentInboxPrefs,
  undoAgentInbox,
  updateAgentInbox,
  useAgentInboxNotice,
  useAgentInboxPrefs,
} from "./agentInboxStore";
import { ChevronRightIcon } from "./agentInboxIcons";
import type { AgentBoardState } from "./useAgentBoard";
import { RAIL_VIEW_PANEL_ID } from "./railView";
import "./agent-inbox.css";

const MergePullRequestDialog = lazy(() =>
  import("../git/GitHubSection").then((module) => ({ default: module.MergePullRequestDialog })),
);

type ShelfId = "working" | "snoozed" | "settled";
const SHELVES: { id: ShelfId; label: string }[] = [
  { id: "working", label: "Working" },
  { id: "snoozed", label: "Snoozed" },
  { id: "settled", label: "Settled" },
];
const SHELVES_KEY = "codara.rail.agents.shelves";
// Working is open until the user folds it; the other two start folded.
const DEFAULT_OPEN: Record<ShelfId, boolean> = { working: true, snoozed: false, settled: false };

function readShelves(): Record<ShelfId, boolean> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SHELVES_KEY) ?? "{}");
    const out = { ...DEFAULT_OPEN };
    for (const id of Object.keys(DEFAULT_OPEN) as ShelfId[]) if (typeof raw?.[id] === "boolean") out[id] = raw[id];
    return out;
  } catch {
    return { ...DEFAULT_OPEN };
  }
}

const UNDO_KEYS = /mac/i.test(navigator.platform) ? "⌘Z" : "Ctrl+Z";

interface Props extends AgentBoardState {
  view: AgentInboxView;
}

interface MenuState {
  key: string;
  view: AgentInboxMenuView;
  openedAt: number;
}

export default function AgentInboxList({ view, activeKey, navigate, now }: Props) {
  const [shelves, setShelves] = useState(readShelves);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [merging, setMerging] = useState<ReadonlySet<string>>(() => new Set());
  const [confirm, setConfirm] = useState<MergeConfirmRequest | null>(null);
  const [confirmResult, setConfirmResult] = useState<GitHubMergeResult | null>(null);
  const notice = useAgentInboxNotice();
  const prefs = useAgentInboxPrefs();
  const listRef = useRef<HTMLDivElement | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const pointAnchor = useRef<HTMLSpanElement | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);

  const sections = useMemo(() => {
    const out: { shelf: AgentInboxShelf; rows: Row[] }[] = [{ shelf: "inbox", rows: view.inbox }];
    for (const shelf of SHELVES) out.push({ shelf: shelf.id, rows: view[shelf.id] });
    return out;
  }, [view]);
  const byKey = useMemo(() => {
    const map = new Map<string, { row: Row; shelf: AgentInboxShelf }>();
    for (const section of sections) for (const row of section.rows) map.set(row.key, { row, shelf: section.shelf });
    return map;
  }, [sections]);
  // Merges finish after an await: they read the row as it is by then.
  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;
  const latestRow = useCallback((key: string) => byKeyRef.current.get(key)?.row ?? null, []);
  const visible = useMemo(() => {
    const out: Row[] = [];
    for (const section of sections) if (section.shelf === "inbox" || shelves[section.shelf]) out.push(...section.rows);
    return out;
  }, [sections, shelves]);
  const tabStop =
    (focusKey && visible.some((row) => row.key === focusKey) && focusKey) ||
    (activeKey && visible.some((row) => row.key === activeKey) && activeKey) ||
    visible[0]?.key ||
    null;

  const toggleShelf = (id: ShelfId) => {
    setShelves((current) => {
      const next = { ...current, [id]: !current[id] };
      try {
        window.localStorage.setItem(SHELVES_KEY, JSON.stringify(next));
      } catch {
        /* best-effort */
      }
      return next;
    });
  };

  const onOpen = useCallback(
    (row: Row) => {
      updateAgentInbox((current) => setAgentUnread(current, row.key, false, Date.now()));
      navigate?.(row.card.target);
    },
    [navigate],
  );
  const onSettle = useCallback((row: Row) => {
    updateAgentInbox((current) => settleAgent(current, row.key, Date.now()), { keys: [row.key], text: "Settled" });
  }, []);
  const onRestore = useCallback((row: Row) => {
    const latest = getAgentInboxPrefs();
    if (latest.settled[row.key]) {
      updateAgentInbox((current) => unsettleAgent(current, row.key), { keys: [row.key], text: "Un-settled" });
    } else if (latest.snoozed[row.key]) {
      updateAgentInbox((current) => wakeAgent(current, row.key), { keys: [row.key], text: "Woken" });
    }
  }, []);
  const openMenu = useCallback((row: Row, at: { x: number; y: number } | null, view: AgentInboxMenuView = "main") => {
    if (at) {
      setPoint(at);
      menuAnchor.current = pointAnchor.current;
    } else {
      setPoint(null);
      menuAnchor.current =
        listRef.current?.querySelector<HTMLElement>(`[data-agent-card="${CSS.escape(row.key)}"]`) ?? null;
    }
    setMenu({ key: row.key, view, openedAt: Date.now() });
  }, []);
  const onMenu = useCallback((row: Row, at: { x: number; y: number } | null) => openMenu(row, at), [openMenu]);
  const onSnooze = useCallback((row: Row, anchor: HTMLElement) => {
    setPoint(null);
    menuAnchor.current = anchor;
    setMenu({ key: row.key, view: "snooze", openedAt: Date.now() });
  }, []);
  const onRename = useCallback((row: Row, name: string | null) => {
    setRenaming(null);
    if (name !== null) updateAgentInbox((current) => renameAgent(current, row.key, name));
    window.setTimeout(() => focusRow(row.key), 0);
  }, []);

  const startMerge = useCallback((row: Row) => {
    setMerging((current) => new Set(current).add(row.key));
    void mergeFromInbox(
      row,
      (request) => {
        setConfirmResult(null);
        setConfirm(request);
      },
      latestRow,
    ).finally(() =>
      setMerging((current) => {
        const next = new Set(current);
        next.delete(row.key);
        return next;
      }),
    );
  }, []);

  const actions = useMemo<AgentInboxMenuActions>(
    () => ({
      open: onOpen,
      merge: startMerge,
      settle: onSettle,
      restore: onRestore,
      snooze: (row, until) =>
        updateAgentInbox((current) => snoozeAgent(current, row.key, until, Date.now()), {
          keys: [row.key],
          text: `Snoozed until ${agentSnoozeWakeLabel(until, Date.now())}`,
        }),
      pin: (row, pinned) => updateAgentInbox((current) => setAgentPinned(current, row.key, pinned, Date.now())),
      rename: (row) => setRenaming(row.key),
      unread: (row, unread) => updateAgentInbox((current) => setAgentUnread(current, row.key, unread, Date.now())),
      copyLink: (row) => {
        if (row.pullRequest) copyPullRequestLink(row.pullRequest);
      },
      remove: (row) => void deleteFromInbox(row),
    }),
    [onOpen, startMerge, onSettle, onRestore],
  );

  function focusRow(key: string | undefined): void {
    if (!key) return;
    listRef.current?.querySelector<HTMLButtonElement>(`[data-agent-card-open="${CSS.escape(key)}"]`)?.focus();
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
      if (event.target instanceof HTMLInputElement) return;
      if (undoAgentInbox()) event.preventDefault();
      return;
    }
    const key = (event.target as HTMLElement).getAttribute?.("data-agent-card-open");
    if (!key) return;
    const index = visible.findIndex((row) => row.key === key);
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(visible.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visible.length - 1;
    if (next === null) return;
    event.preventDefault();
    focusRow(visible[next]?.key);
  };

  // A focused row that moves to another shelf is a new node, and one that
  // leaves the list (closed, folded away) is gone: either way focus would
  // drop to the top of the window. It goes back to the row, or to its
  // neighbour, so a keyboard user keeps their place.
  const focusWithin = useRef(false);
  const lastVisible = useRef<Row[]>(visible);
  useEffect(() => {
    const previous = lastVisible.current;
    lastVisible.current = visible;
    if (!focusWithin.current || !focusKey || !listRef.current) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    if (visible.some((row) => row.key === focusKey)) {
      focusRow(focusKey);
      return;
    }
    const index = previous.findIndex((row) => row.key === focusKey);
    const neighbour = visible[Math.min(Math.max(index, 0), visible.length - 1)];
    if (neighbour) focusRow(neighbour.key);
  }, [visible, focusKey]);

  const menuEntry = menu ? byKey.get(menu.key) ?? null : null;

  const renderRows = (shelf: AgentInboxShelf, rows: Row[]) => (
    <ul className={`agent-inbox__rows is-${shelf}`}>
      {rows.map((row) => (
        <AgentInboxRow
          key={row.key}
          row={row}
          shelf={shelf}
          now={now}
          active={row.key === activeKey}
          focusable={row.key === tabStop}
          merging={merging.has(row.key)}
          renaming={renaming === row.key}
          onOpen={onOpen}
          onMenu={onMenu}
          onSnooze={onSnooze}
          onSettle={onSettle}
          onRestore={onRestore}
          onRename={onRename}
          onFocusRow={setFocusKey}
        />
      ))}
    </ul>
  );

  return (
    <div
      ref={listRef}
      id={RAIL_VIEW_PANEL_ID}
      role="tabpanel"
      aria-labelledby="rail-view-tab-agents"
      className="agent-inbox"
      onKeyDown={onKeyDown}
      onFocus={() => {
        focusWithin.current = true;
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next) {
          focusWithin.current = event.currentTarget.contains(next);
          return;
        }
        // No new target: the node was removed (focus is still ours to
        // place) or the user clicked away or left the window (it is not).
        const left = event.target as Node;
        window.setTimeout(() => {
          if (left.isConnected) focusWithin.current = false;
        }, 0);
      }}
    >
      <div className="agent-inbox__scroll">
        {view.total === 0 ? (
          <p className="agent-inbox__empty">
            No agents right now. Start Claude Code, Codex, Grok or Pi in a terminal, or chat with Cora, and they show up
            here.
          </p>
        ) : (
          <>
            <section className="agent-inbox__section is-inbox" aria-label={`Inbox, ${view.inbox.length}`}>
              {view.inbox.length === 0 ? (
                <p className="agent-inbox__clear">Nothing needs you.</p>
              ) : (
                renderRows("inbox", view.inbox)
              )}
            </section>
            <div className="agent-inbox__spacer" />
            {SHELVES.map((shelf) => {
              const rows = view[shelf.id];
              const open = shelves[shelf.id];
              const headingId = `agent-inbox-shelf-${shelf.id}`;
              return (
                <section key={shelf.id} className={`agent-inbox__shelf is-${shelf.id}`} aria-labelledby={headingId}>
                  <h3 className="agent-inbox__shelf-heading">
                    <button
                      type="button"
                      id={headingId}
                      className="agent-inbox__shelf-btn"
                      aria-label={`${shelf.label}, ${rows.length}`}
                      aria-expanded={open}
                      onClick={() => toggleShelf(shelf.id)}
                    >
                      <span className="agent-inbox__shelf-label">{shelf.label}</span>
                      <span className="agent-inbox__shelf-count">{rows.length}</span>
                      <span className="agent-inbox__shelf-chevron" aria-hidden>
                        <ChevronRightIcon size={11} />
                      </span>
                    </button>
                  </h3>
                  {open && rows.length > 0 && renderRows(shelf.id, rows)}
                </section>
              );
            })}
          </>
        )}
      </div>
      <div className={`agent-inbox__foot${notice ? " is-shown" : ""}`} aria-live="polite">
        {notice ? (
          <span className="agent-inbox__notice" key={notice.id}>
            {notice.text},{" "}
            <button type="button" className="agent-inbox__undo" onClick={() => undoAgentInbox()}>
              {UNDO_KEYS} to undo
            </button>
          </span>
        ) : null}
      </div>
      <span
        ref={pointAnchor}
        className="agent-inbox__point"
        aria-hidden
        style={point ? { left: point.x, top: point.y } : undefined}
      />
      <AgentInboxMenu
        row={menuEntry?.row ?? null}
        anchorRef={menuAnchor}
        view={menu?.view ?? "main"}
        onView={(next) => setMenu((current) => (current ? { ...current, view: next } : current))}
        settled={menuEntry?.shelf === "settled"}
        snoozed={menuEntry?.shelf === "snoozed"}
        unread={Boolean(menu && prefs.unread[menu.key] !== undefined)}
        openedAt={menu?.openedAt ?? 0}
        onClose={() => setMenu(null)}
        actions={actions}
      />
      {confirm && (
        <Suspense fallback={null}>
          <MergePullRequestDialog
            cwd={confirm.cwd}
            repository={confirm.repository}
            pullRequest={confirm.pullRequest}
            previousResult={confirmResult}
            onResult={setConfirmResult}
            onClose={() => {
              setConfirm(null);
              setConfirmResult(null);
            }}
            onMerged={() => {
              settleMerged(confirm.key, confirm.repository, confirm.pullRequest.number, latestRow);
              setConfirm(null);
              setConfirmResult(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
