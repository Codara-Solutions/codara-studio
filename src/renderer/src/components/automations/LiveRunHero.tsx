import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AutomationWorkerInfo, RunState, ScheduledJob } from "@shared/types";
import { resolveOpenRunQuestion, runQuestionDraftScopeKey } from "@shared/run-questions";
import { capLabel, fmtClock, fmtElapsed, fmtUsd } from "./presentation";
import { workerModelLabel } from "./worker-models";
import { describeWorkerLogFailure } from "./worker-log-tail";
import RunIdChip from "../RunIdChip";

// LiveRunHero — the automation page's signature moment: while an automation is
// RUNNING, the detail leads with the machine actually working. The panel is
// composed as an instrument: the power wire across the top carries the house
// travelling dash, the comet arc spins beside a ticking pass/elapsed/cost
// readout, and the live worker's activity streams underneath. A blocked pass
// swaps the electricity for the red "needs you" treatment with the answer box
// inline, so acting on a stuck automation happens right where you watch it.

const LIVE_ATTEMPT = new Set(["preparing", "prompt_ready", "launching", "running", "finishing"]);

export interface LiveRunHeroProps {
  job: ScheduledJob;
  liveRun: RunState | null;
  // This automation's workers (live + lingering).
  workers: AutomationWorkerInfo[];
  // On screen right now — gates the 1s clock and the activity poll.
  shown: boolean;
  onOpenLiveBoard: () => void;
  onAnswer: (runId: string, questionMessageId: string, answer: string) => void;
}

export default function LiveRunHero({
  job,
  liveRun,
  workers,
  shown,
  onOpenLiveBoard,
  onAnswer,
}: LiveRunHeroProps): React.ReactElement {
  const blocked = job.state.status === "blocked";
  const liveWorkers = useMemo(() => workers.filter((w) => LIVE_ATTEMPT.has(w.status)), [workers]);

  // Focused feed: the user's pick while it is still live, else the blocked
  // worker (it needs the eyes), else the first live one. Between waves (the
  // pass is running but the next attempt hasn't spawned yet) fall back to the
  // NEWEST attempt so the feed keeps continuity instead of blanking.
  const [pickedAttemptId, setPickedAttemptId] = useState<string | null>(null);
  const feedWorker =
    liveWorkers.find((w) => w.attemptId === pickedAttemptId) ??
    liveWorkers.find((w) => w.blocked) ??
    liveWorkers[0] ??
    workers[workers.length - 1] ??
    null;
  const feedLive = feedWorker ? LIVE_ATTEMPT.has(feedWorker.status) : false;

  // 1s clock for the elapsed readout, ticking only while on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [shown]);

  const budget = job.loop?.stop?.budgetUsd;
  const tone = blocked ? "var(--danger)" : "var(--accent)";
  // The pass in flight. currentRunId covers the window before the run state
  // has been fetched into liveRun.
  const liveRunId = liveRun?.id ?? job.state.currentRunId;

  // The blocked pass's exact unresolved question (id travels with the answer).
  const pendingQuestion = liveRun ? resolveOpenRunQuestion(liveRun) : null;
  const [answerDraft, setAnswerDraft] = useState("");
  const answerDraftScope = runQuestionDraftScopeKey(liveRun?.id, pendingQuestion?.id);
  useEffect(() => {
    setAnswerDraft("");
  }, [answerDraftScope]);

  return (
    <div className={`loom-hero${blocked ? " is-blocked" : ""}`}>
      {/* The machine's power wire. */}
      <svg className="loom-hero__wire" aria-hidden height="2" width="100%" preserveAspectRatio="none">
        <line x1="0" y1="1" x2="100%" y2="1" stroke="color-mix(in oklch, var(--accent) 22%, var(--rule))" strokeWidth="2" />
        {!blocked && (
          <line
            className="spark-wire-flow"
            x1="0"
            y1="1"
            x2="100%"
            y2="1"
            stroke={tone}
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}
      </svg>

      {/* Readout row */}
      <div className="loom-hero__readout">
        <span className="loom-hero__glyph" aria-hidden>
          {blocked ? (
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 999,
                background: "var(--danger)",
                boxShadow: "0 0 8px color-mix(in oklch, var(--danger) 55%, transparent)",
              }}
            />
          ) : (
            <span
              className="spark-activity-spin"
              style={{
                width: 13,
                height: 13,
                borderRadius: 999,
                background: `conic-gradient(from 0deg, transparent 0deg 90deg, ${tone} 360deg)`,
                WebkitMask:
                  "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
                mask: "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
              }}
            />
          )}
        </span>
        <span className="loom-hero__pass">
          {blocked ? "Pass held: a worker needs you" : `Pass ${Math.max(1, job.state.iteration)} in flight`}
        </span>
        <span className="loom-hero__meta spark-mono spark-num">
          {job.state.iteration}/{capLabel(job)} iters
        </span>
        {feedLive && feedWorker?.startedAt && (
          <span
            className="loom-hero__meta spark-mono spark-num"
            title={`started ${fmtClock(feedWorker.startedAt)}`}
          >
            {fmtElapsed(feedWorker.startedAt, now)}
          </span>
        )}
        <span className="loom-hero__meta spark-mono spark-num">
          est. {fmtUsd(job.state.spentUsd)}
          {typeof budget === "number" ? ` / ${fmtUsd(budget)}` : ""}
        </span>
        <span style={{ flex: 1 }} />
        {liveRunId && <RunIdChip runId={liveRunId} maxChars={24} />}
        <button
          type="button"
          className="spark-btn"
          style={{ height: 24, padding: "0 10px", fontSize: 11 }}
          onClick={onOpenLiveBoard}
          title="Watch this run on the whiteboard: live graph and worker activity"
        >
          Open board
        </button>
      </div>

      {/* Worker chips when several run in the same wave. */}
      {liveWorkers.length > 1 && (
        <div className="loom-hero__chips">
          {liveWorkers.map((w) => {
            const current = w.attemptId === feedWorker?.attemptId;
            return (
              <button
                key={w.attemptId}
                type="button"
                className={`loom-hero__chip${current ? " is-current" : ""}`}
                onClick={() => setPickedAttemptId(w.attemptId)}
                title={`${w.nodeLabel ?? workerModelLabel(w.model)} · pass ${w.iteration + 1}`}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: w.blocked ? "var(--danger)" : "var(--accent)",
                  }}
                />
                {w.nodeLabel ?? workerModelLabel(w.model)}
              </button>
            );
          })}
        </div>
      )}

      {/* Live activity feed */}
      <LiveActivityFeed worker={feedWorker} shown={shown} emptyLabel={stepsOnlyLabel(job)} />

      {/* Blocked question, answerable in place. */}
      {pendingQuestion && liveRun && (
        <div className="loom-hero__question">
          <span style={{ fontSize: 11.5, color: "var(--ink)", whiteSpace: "pre-wrap" }}>
            {pendingQuestion.message}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="spark-input"
              value={answerDraft}
              onChange={(e) => setAnswerDraft(e.target.value)}
              placeholder="Answer the worker…"
              style={{ flex: 1, height: 26 }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && answerDraft.trim()) {
                  onAnswer(liveRun.id, pendingQuestion.id, answerDraft.trim());
                  setAnswerDraft("");
                }
              }}
            />
            <button
              type="button"
              className="spark-btn is-primary"
              style={{ height: 26, fontSize: 11 }}
              disabled={!answerDraft.trim()}
              onClick={() => {
                onAnswer(liveRun.id, pendingQuestion.id, answerDraft.trim());
                setAnswerDraft("");
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// The focused worker's ordered activity stream, tailed live. Sticks to the
// bottom while new output arrives unless the user scrolled up to read.
// When a pass's entry nodes are STEPS there is no worker to feed from — the
// hero says which step is executing instead of a misleading "Worker
// launching…" that nothing will ever fulfil.
function stepsOnlyLabel(job: ScheduledJob): string | null {
  const graph = job.graph;
  if (!graph) return null;
  const entrySteps = (graph.entryNodeIds ?? [])
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n): n is NonNullable<typeof n> => Boolean(n && n.kind !== "worker"));
  if (entrySteps.length === 0) return null;
  const label = (entrySteps[0] as { label?: string }).label ?? "steps";
  return `Running step: ${label}…`;
}

function LiveActivityFeed({
  worker,
  shown,
  emptyLabel,
}: {
  worker: AutomationWorkerInfo | null;
  shown: boolean;
  emptyLabel?: string | null;
}): React.ReactElement {
  const [content, setContent] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const scrollRef = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);
  const logPath = worker?.stdoutLogPath;

  useEffect(() => {
    setContent("");
    setFailure(null);
    stickToBottomRef.current = true;
    if (!logPath) return;
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const file = await window.spark.fs.readTextTail(logPath, 80_000);
        if (disposed) return;
        setContent(file.content);
        setFailure(null);
      } catch (err) {
        // Only a not-yet-created log is hidden. Every other failure is shown,
        // so a broken read can never masquerade as a quiet worker.
        const described = describeWorkerLogFailure(err);
        if (!disposed && described) setFailure(described);
      }
    };
    void refresh();
    if (!shown) {
      return () => {
        disposed = true;
      };
    }
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [logPath, shown]);

  // Follow the stream: keep pinned to the newest output unless the user
  // scrolled up; scrolling back to the bottom re-arms the follow.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [content]);

  if (!worker || !content.trim()) {
    return (
      <div
        className="loom-hero__feed loom-hero__feed--empty spark-mono"
        style={failure ? { color: "var(--danger)" } : undefined}
      >
        {failure ?? (worker ? "Worker starting…" : emptyLabel ?? "Worker launching…")}
      </div>
    );
  }
  return (
    <pre
      ref={scrollRef}
      className="loom-hero__feed spark-mono"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {content}
    </pre>
  );
}
