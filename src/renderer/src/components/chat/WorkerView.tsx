import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunState } from "@shared/types";
import AnchoredMenu from "./composer/AnchoredMenu";
import { ActivityIcon, type ActivityIconState } from "./ChatConversation";
import { listChatWorkers, runtimeLabel, type ChatWorker } from "./timeline";
import WorkerChat from "./WorkerChat";
import {
  canMessageWorker,
  neighbourWorker,
  openableWorkers,
  workerAttempt,
  workerElapsed,
  workerViewState,
  type WorkerViewState,
} from "./worker-view";
import { useNowTick, workerModelLabel } from "../runs/run-format";
import "./worker-view.css";

// Going inside a Cora worker (DESIGN.md, "Cora worker view"): the worker's own
// chat replaces Main's, drawn with Main's own rows. A slim bar says where you
// are; Back or Esc returns to Main, which stayed mounted and kept its scroll.

const ICON_FOR_STATE: Record<WorkerViewState, ActivityIconState> = {
  queued: "hollow",
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "dot",
};

// A half-typed message survives stepping to another worker and back.
const drafts = new Map<string, string>();

export default function WorkerView({
  run,
  workerId,
  onBack,
  onSelectWorker,
  onOpenTerminal,
  onAskCora,
}: {
  run: RunState;
  workerId: string;
  onBack: () => void;
  onSelectWorker: (workerId: string) => void;
  /** Focuses the worker's terminal pane; false when it has none. */
  onOpenTerminal?: (workerTaskId: string) => boolean;
  /** Back to Main with the composer holding this text. */
  onAskCora: (text: string) => void;
}) {
  const workers = useMemo(() => openableWorkers(listChatWorkers(run)), [run]);
  const worker = workers.find((candidate) => candidate.id === workerId) ?? null;
  const attempt = worker ? workerAttempt(run, worker) : null;
  const state = workerViewState(attempt);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const ping = useFinishPing(run, workers, workerId);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    setShowLog(false);
    setMenuOpen(false);
  }, [workerId]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // A menu or popover inside the view closes on its own Escape first.
    if (event.key !== "Escape" || event.defaultPrevented || menuOpen) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[role="menu"], [role="dialog"], [role="listbox"]')) return;
    event.preventDefault();
    onBack();
  };
  // Focus can drop to the page itself (an arrow that just went disabled, a
  // click on plain text outside the view's focusable root): Esc still leaves.
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  useEffect(() => {
    const onDocumentKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || menuOpenRef.current) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      // Only the view on screen: a hidden workspace keeps its Cora mounted.
      const root = rootRef.current;
      if (!root?.isConnected || !root.checkVisibility({ visibilityProperty: true })) return;
      event.preventDefault();
      backRef.current();
    };
    document.addEventListener("keydown", onDocumentKey);
    return () => document.removeEventListener("keydown", onDocumentKey);
  }, []);

  if (!worker || !attempt) {
    return (
      <div ref={rootRef} tabIndex={-1} className="cora-worker-view" onKeyDown={onKeyDown}>
        <WorkerBar
          run={run}
          worker={worker}
          workers={workers}
          state="queued"
          elapsed={null}
          ping={ping}
          onBack={onBack}
          onSelectWorker={onSelectWorker}
          menu={null}
        />
        <div className="cora-worker-view__empty">This worker is no longer in the chat.</div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="cora-worker-view"
      data-worker-view={worker.id}
      data-worker-state={state}
      onKeyDown={onKeyDown}
    >
      <WorkerBarLive
        run={run}
        worker={worker}
        workers={workers}
        state={state}
        ping={ping}
        onBack={onBack}
        onSelectWorker={onSelectWorker}
        menu={
          <WorkerMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            runId={run.id}
            attemptId={attempt.id}
            onShowLog={() => {
              if (!worker.taskId || !onOpenTerminal?.(worker.taskId)) setShowLog(true);
            }}
          />
        }
      />
      <WorkerChat
        key={attempt.id}
        run={run}
        worker={worker}
        attemptId={attempt.id}
        state={state}
        showLog={showLog}
        onCloseLog={() => setShowLog(false)}
      />
      {state === "running" || state === "queued" ? (
        <WorkerComposer
          key={`composer:${attempt.id}`}
          runId={run.id}
          attemptId={attempt.id}
          title={worker.title}
          canMessage={canMessageWorker(attempt)}
        />
      ) : (
        <div className="cora-worker-followup">
          <span>
            {state === "done" ? "This worker finished." : state === "stopped" ? "This worker was stopped." : "This worker failed."}{" "}
            Workers take no messages once they end; Cora can follow up.
          </span>
          <button
            type="button"
            className="cora-worker-followup__ask"
            onClick={() => onAskCora(`Follow up on "${worker.title}": `)}
          >
            Ask Cora for a follow-up
          </button>
        </div>
      )}
    </div>
  );
}

// "Fix the toast finished" in the bar for a few seconds when another worker of
// this chat ends while you are inside this one. A status, not a toast.
function useFinishPing(run: RunState, workers: ChatWorker[], workerId: string): string | null {
  const seen = useRef<Map<string, WorkerViewState> | null>(null);
  const [ping, setPing] = useState<string | null>(null);
  useEffect(() => {
    const now = new Map(workers.map((worker) => [worker.id, workerViewState(workerAttempt(run, worker))]));
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    for (const worker of workers) {
      if (worker.id === workerId) continue;
      const was = before.get(worker.id);
      const is = now.get(worker.id);
      if (was === "running" && is && is !== "running") {
        setPing(`${worker.title} ${is === "done" ? "finished" : is}`);
      }
    }
  }, [run, workers, workerId]);
  useEffect(() => {
    if (!ping) return undefined;
    const timer = window.setTimeout(() => setPing(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [ping]);
  return ping;
}

function WorkerBarLive(props: Omit<React.ComponentProps<typeof WorkerBar>, "elapsed">) {
  const attempt = props.worker ? workerAttempt(props.run, props.worker) : null;
  useNowTick(1_000, props.state === "running");
  return <WorkerBar {...props} elapsed={workerElapsed(attempt, Date.now())} />;
}

function WorkerBar({
  worker,
  workers,
  state,
  elapsed,
  ping,
  onBack,
  onSelectWorker,
  menu,
}: {
  run: RunState;
  worker: ChatWorker | null;
  workers: ChatWorker[];
  state: WorkerViewState;
  elapsed: string | null;
  ping: string | null;
  onBack: () => void;
  onSelectWorker: (workerId: string) => void;
  menu: React.ReactNode;
}) {
  const index = worker ? workers.findIndex((candidate) => candidate.id === worker.id) : -1;
  const previous = worker ? neighbourWorker(workers, worker.id, -1) : null;
  const next = worker ? neighbourWorker(workers, worker.id, 1) : null;
  return (
    <nav className="cora-worker-bar" aria-label="Worker">
      <button type="button" className="cora-worker-bar__back" onClick={onBack} aria-label="Back to Main">
        <BarChevron direction="left" />
        Main
      </button>
      <BarChevron direction="right" muted />
      {worker && <ActivityIcon state={ICON_FOR_STATE[state]} color={state === "done" ? "var(--ok)" : undefined} />}
      <span className="cora-worker-bar__title" aria-current="page">
        {worker?.title ?? "Worker"}
      </span>
      <span className="cora-worker-bar__meta">
        {worker ? <span>· {workerModelLabel(worker.model, runtimeLabel(worker.runtime))}</span> : null}
        <span>
          {"· "}
          <span className="cora-worker-bar__state" data-state={state}>
            {state}
          </span>
        </span>
        {elapsed ? <span>· {elapsed}</span> : null}
      </span>
      <span className="cora-worker-bar__ping" role="status">
        {ping}
      </span>
      <span className="cora-worker-bar__end">
        <span className="spark-kbd" aria-hidden title="Esc returns to Main">
          Esc
        </span>
        <button
          type="button"
          className="cora-worker-bar__icon"
          aria-label={previous ? `Previous worker: ${previous.title}` : "Previous worker"}
          disabled={!previous}
          onClick={() => previous && onSelectWorker(previous.id)}
        >
          <BarChevron direction="left" />
        </button>
        <span className="cora-worker-bar__count">
          {index >= 0 ? `${index + 1} of ${workers.length}` : ""}
        </span>
        <button
          type="button"
          className="cora-worker-bar__icon"
          aria-label={next ? `Next worker: ${next.title}` : "Next worker"}
          disabled={!next}
          onClick={() => next && onSelectWorker(next.id)}
        >
          <BarChevron direction="right" />
        </button>
        {menu}
      </span>
    </nav>
  );
}

function WorkerMenu({
  open,
  onOpenChange,
  runId,
  attemptId,
  onShowLog,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  attemptId: string;
  onShowLog: () => void;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const pick = (action: () => void) => () => {
    close();
    anchorRef.current?.focus();
    action();
  };
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="cora-worker-bar__icon"
        aria-label="More worker actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="3.5" cy="8" r="1.25" />
          <circle cx="8" cy="8" r="1.25" />
          <circle cx="12.5" cy="8" r="1.25" />
        </svg>
      </button>
      <AnchoredMenu
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        className="spark-menu cora-worker-menu"
        role="menu"
        ariaLabel="Worker actions"
        placement="below"
        align="end"
        menuItems
      >
        <button
          type="button"
          role="menuitem"
          className="spark-menu-item"
          onClick={pick(() => {
            void window.spark.orchestration
              .readWorkerPrompt(runId, attemptId)
              .then((text) => window.spark.clipboard.writeText(text))
              .catch(() => undefined);
          })}
        >
          Copy brief
        </button>
        <button
          type="button"
          role="menuitem"
          className="spark-menu-item"
          onClick={pick(() => {
            window.dispatchEvent(new CustomEvent("spark:show-run-in-runs", { detail: { runId } }));
          })}
        >
          Show in Runs
        </button>
        <div className="cora-worker-menu__rule" role="separator" />
        <button type="button" role="menuitem" className="spark-menu-item cora-worker-menu__two" onClick={pick(onShowLog)}>
          <span>Raw terminal output</span>
          <span className="cora-worker-menu__hint">for output the chat can't draw</span>
        </button>
      </AnchoredMenu>
    </>
  );
}

function WorkerComposer({
  runId,
  attemptId,
  title,
  canMessage,
}: {
  runId: string;
  attemptId: string;
  title: string;
  canMessage: boolean;
}) {
  const [text, setText] = useState(() => drafts.get(attemptId) ?? "");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (text) drafts.set(attemptId, text);
    else drafts.delete(attemptId);
  }, [attemptId, text]);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      const { delivered } = await window.spark.workerFeed.message(runId, attemptId, message);
      if (delivered) setText("");
      else setError("This worker can't read messages from the chat. Raw terminal output in the ⋯ menu reaches it.");
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      setSending(false);
    }
  };
  const stop = async () => {
    setStopping(true);
    try {
      await window.spark.orchestration.stopWorkerAttempt(runId, attemptId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStopping(false);
    }
  };

  return (
    <div className="cora-worker-composer">
      {error && (
        <div className="cora-worker-composer__error" role="alert">
          {error}
        </div>
      )}
      <div className="composer-shell cora-worker-composer__shell">
        <textarea
          aria-label={`Message ${title}`}
          placeholder={canMessage ? `Message ${title}. It reads it before its next step.` : `${title} has not started yet.`}
          disabled={!canMessage}
          value={text}
          rows={2}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="cora-worker-composer__bar">
          <span>Steers this worker only</span>
          <span className="cora-worker-composer__hint">Esc back to Main</span>
          {text.trim() && (
            <button
              type="button"
              className="cora-worker-composer__send"
              aria-label="Send to worker"
              disabled={sending}
              onClick={() => void send()}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M8 13V3m0 0L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="cora-worker-composer__stop"
            aria-label="Stop worker"
            title="Stop this worker"
            disabled={stopping}
            onClick={() => void stop()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
              <rect x="1" y="1" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function BarChevron({ direction, muted = false }: { direction: "left" | "right"; muted?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={muted ? "cora-worker-bar__sep" : undefined}
    >
      <path
        d={direction === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "m6 3.5 4.5 4.5L6 12.5"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
