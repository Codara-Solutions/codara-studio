import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { RunState } from "@shared/types";
import { useWorkerActivity } from "../../lib/useWorkerActivity";
import { ActivityIcon, ChevronGlyph, type ActivityIconState } from "./ChatConversation";
import { railGroups, railMarks, railSummary, railWorkerLine, railWorkers, type RailWorker } from "./agents-rail";
import { listChatWorkers } from "./timeline";
import type { WorkerViewState } from "./worker-view";
import "./agents-rail.css";

// The chat's agents rail (option 2, chosen 2026-11-17): a 32 px strip on the
// chat's left edge with Cora on top and one mark per worker, whose shape says
// its state. Hover or focus a mark for its name, model, state, time and step;
// click it to go inside. The strip or its chevron opens the full list over
// the chat, grouped by step. One tab stop: up and down move between marks,
// Enter goes inside, right opens the list, Esc folds it.

const ICON: Record<WorkerViewState, ActivityIconState> = {
  queued: "hollow",
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "dot",
};

const MAIN = "main";
const MORE = "more";
const EXPAND = "expand";

interface Props {
  run: RunState;
  /** The worker the chat is inside; null is Main. */
  insideId: string | null;
  mainGlyph: ReactNode;
  onOpenWorker: (workerId: string) => void;
  onOpenMain: () => void;
}

/** Ticks once a second while `active`: elapsed times only show in the list and the tooltip. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

export default function AgentsRail({ run, insideId, mainGlyph, onOpenWorker, onOpenMain }: Props): JSX.Element | null {
  const workers = useMemo(() => listChatWorkers(run), [run]);
  const activity = useWorkerActivity(run.id);
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState<{ id: string; top: number } | null>(null);
  const [focusKey, setFocusKey] = useState<string>(insideId ?? MAIN);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const anyRunning = workers.some((worker) => worker.status === "running");
  const now = useNow(anyRunning && (open || tip !== null));
  const items = useMemo(() => railWorkers(run, workers, activity, now), [run, workers, activity, now]);
  const { marks, more } = railMarks(items, insideId);
  const summary = railSummary(items);
  const running = items.filter((item) => item.state === "running").length;
  const byId = useMemo(() => new Map(items.map((item) => [item.worker.id, item])), [items]);
  const openable = (item: RailWorker) => Boolean(item.worker.attemptId);

  // The strip's buttons in tab order; the roving stop falls back to the
  // current one when the worker it pointed at went away.
  const stripKeys = [MAIN, ...marks.map((item) => item.worker.id), ...(more > 0 ? [MORE] : []), EXPAND];
  const current = insideId ?? MAIN;
  const stopKey = stripKeys.includes(focusKey) ? focusKey : stripKeys.includes(current) ? current : MAIN;

  const stripKeysRef = useRef(stripKeys);
  stripKeysRef.current = stripKeys;

  const focusStrip = useCallback((key: string) => {
    setFocusKey(key);
    stripRef.current?.querySelector<HTMLElement>(`[data-rail-key="${CSS.escape(key)}"]`)?.focus();
  }, []);

  const openList = useCallback(() => {
    setTip(null);
    setOpen(true);
  }, []);
  const foldList = useCallback(
    (refocus: boolean) => {
      setOpen(false);
      if (refocus) window.requestAnimationFrame(() => focusStrip(stripKeysRef.current.includes(current) ? current : EXPAND));
    },
    [current, focusStrip],
  );

  // The opened list takes focus on the row you are on; a click outside the
  // rail folds it without moving focus.
  useEffect(() => {
    if (!open) return undefined;
    window.requestAnimationFrame(() => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-rail-row]");
      if (!rows?.length) return;
      const here = [...rows].find((row) => row.dataset.railRow === current);
      (here ?? rows[0]).focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
    // Only when it opens: a run update must not pull focus back to a row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const go = (id: string) => {
    // A worker that never started has nothing to show inside yet.
    const item = byId.get(id);
    if (item && !openable(item)) return;
    setOpen(false);
    setTip(null);
    if (id === MAIN) onOpenMain();
    else onOpenWorker(id);
  };

  const onStripKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const index = stripKeys.indexOf(stopKey);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = stripKeys[Math.min(stripKeys.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) focusStrip(next);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusStrip(event.key === "Home" ? stripKeys[0]! : stripKeys[stripKeys.length - 1]!);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      openList();
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      foldList(true);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      // Esc folds the list and stops here, so a worker's own Esc (back to
      // Main) never fires from the same key press.
      event.preventDefault();
      event.stopPropagation();
      foldList(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-rail-row]") ?? [])];
    const index = rows.findIndex((row) => row === document.activeElement);
    const target =
      event.key === "Home"
        ? rows[0]
        : event.key === "End"
          ? rows[rows.length - 1]
          : rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
    target?.focus();
  };

  const showTip = (id: string, element: HTMLElement, fromFocus = false) => {
    // A click focuses the mark too; only keyboard focus shows the tooltip.
    if (open || (fromFocus && !element.matches(":focus-visible"))) return;
    setTip({ id, top: element.offsetTop });
  };

  const onStripClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // The strip's empty space opens the list too; its buttons handle their own.
    if (event.target === event.currentTarget) openList();
  };

  if (items.length === 0) return null;
  const tipItem = tip && tip.id !== MAIN ? byId.get(tip.id) : null;
  const mainLine = running > 0 ? `waiting on ${running}` : summary;

  return (
    <div ref={rootRef} className="cora-agents-rail" data-agents-rail data-open={open || undefined}>
      <nav aria-label="Agents" className="cora-agents-rail__nav">
        <div
          ref={stripRef}
          role="toolbar"
          aria-orientation="vertical"
          aria-label={`Agents: ${summary}`}
          className="cora-agents-strip"
          onKeyDown={onStripKeyDown}
          onClick={onStripClick}
          onMouseLeave={() => setTip(null)}
        >
          <button
            type="button"
            className="cora-agents-mark"
            data-rail-key={MAIN}
            data-current={current === MAIN || undefined}
            aria-current={current === MAIN ? "true" : undefined}
            aria-label={`Main, Cora, ${mainLine}`}
            tabIndex={stopKey === MAIN ? 0 : -1}
            onFocus={(event) => {
              setFocusKey(MAIN);
              showTip(MAIN, event.currentTarget, true);
            }}
            onBlur={() => setTip(null)}
            onMouseEnter={(event) => showTip(MAIN, event.currentTarget)}
            onClick={() => go(MAIN)}
          >
            {mainGlyph}
          </button>
          <span className="cora-agents-strip__rule" aria-hidden />
          {marks.map((item) => {
            const id = item.worker.id;
            const here = current === id;
            return (
              <button
                key={id}
                type="button"
                className="cora-agents-mark"
                data-rail-key={id}
                data-state={item.state}
                data-current={here || undefined}
                aria-current={here ? "true" : undefined}
                aria-label={`${item.worker.title}: ${railWorkerLine(item)}`}
                aria-disabled={!openable(item) || undefined}
                tabIndex={stopKey === id ? 0 : -1}
                onFocus={(event) => {
                  setFocusKey(id);
                  showTip(id, event.currentTarget, true);
                }}
                onBlur={() => setTip(null)}
                onMouseEnter={(event) => showTip(id, event.currentTarget)}
                onClick={() => go(id)}
              >
                <ActivityIcon state={ICON[item.state]} color={item.state === "done" ? "var(--ok)" : undefined} />
              </button>
            );
          })}
          {more > 0 && (
            <button
              type="button"
              className="cora-agents-mark cora-agents-mark--more"
              data-rail-key={MORE}
              aria-label={`${more} more ${more === 1 ? "worker" : "workers"}, open the list`}
              aria-expanded={open}
              tabIndex={stopKey === MORE ? 0 : -1}
              onFocus={() => setFocusKey(MORE)}
              onClick={() => (open ? foldList(false) : openList())}
            >
              +{more}
            </button>
          )}
          <button
            type="button"
            className="cora-agents-mark cora-agents-strip__expand"
            data-rail-key={EXPAND}
            aria-label={open ? "Fold the agents list" : "Open the agents list"}
            aria-expanded={open}
            tabIndex={stopKey === EXPAND ? 0 : -1}
            onFocus={() => setFocusKey(EXPAND)}
            onClick={() => (open ? foldList(false) : openList())}
          >
            <ChevronGlyph open={false} />
          </button>
        </div>
        {tip && !open && (
          <div className="cora-agents-tip" role="presentation" style={{ top: tip.top }} aria-hidden>
            {tipItem ? (
              <>
                <span className="cora-agents-tip__name">{tipItem.worker.title}</span>
                <WorkerMeta item={tipItem} />
              </>
            ) : (
              <>
                <span className="cora-agents-tip__name">Main · Cora</span>
                <span className="cora-agents-meta">{mainLine}</span>
              </>
            )}
          </div>
        )}
        {open && (
          <div ref={listRef} className="cora-agents-list" role="group" aria-label="Agents list" onKeyDown={onListKeyDown}>
            <div className="cora-agents-list__head">
              <span>Agents · {items.length}</span>
              <span className="cora-agents-list__summary">{summary}</span>
            </div>
            <button
              type="button"
              className="cora-agents-row"
              data-rail-row={MAIN}
              data-current={current === MAIN || undefined}
              aria-current={current === MAIN ? "true" : undefined}
              onClick={() => go(MAIN)}
            >
              <span className="cora-agents-row__icon">{mainGlyph}</span>
              <span className="cora-agents-row__name">Main · Cora</span>
              <span className="cora-agents-meta">{mainLine}</span>
            </button>
            {railGroups(run, items).map((group) => (
              <div key={group.stepId || "workers"} role="group" aria-label={group.label}>
                <div className="cora-agents-list__group" aria-hidden>
                  {group.label}
                </div>
                {group.workers.map((item) => (
                  <button
                    key={item.worker.id}
                    type="button"
                    className="cora-agents-row"
                    data-rail-row={item.worker.id}
                    data-state={item.state}
                    data-current={current === item.worker.id || undefined}
                    aria-current={current === item.worker.id ? "true" : undefined}
                    aria-disabled={!openable(item) || undefined}
                    onClick={() => go(item.worker.id)}
                  >
                    <span className="cora-agents-row__icon">
                      <ActivityIcon state={ICON[item.state]} color={item.state === "done" ? "var(--ok)" : undefined} />
                    </span>
                    <span className="cora-agents-row__name">{item.worker.title}</span>
                    <WorkerMeta item={item} />
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </nav>
    </div>
  );
}

function WorkerMeta({ item }: { item: RailWorker }): JSX.Element {
  const detail = item.state === "failed" ? item.reason : item.activity;
  return (
    <>
      <span className="cora-agents-meta">
        {item.model ? `${item.model} · ` : ""}
        <span className="cora-agents-meta__state" data-state={item.state}>
          {item.state}
        </span>
        {item.elapsed ? ` · ${item.elapsed}` : ""}
      </span>
      {detail ? <span className="cora-agents-meta cora-agents-meta__detail">{detail}</span> : null}
    </>
  );
}
