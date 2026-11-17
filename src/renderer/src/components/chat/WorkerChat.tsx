import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RunState, WorkerReport } from "@shared/types";
import { foldWorkerFeed } from "@shared/worker-feed";
import {
  ChevronGlyph,
  CollapsibleUserText,
  CONVERSATION_COLUMN_STYLE,
  formatMessageTime,
  liveTurnSegments,
  TurnSegments,
  USER_BUBBLE_STYLE,
} from "./ChatConversation";
import Markdown from "./Markdown";
import type { ChatWorker } from "./timeline";
import {
  foldFinishedWorker,
  workerElapsed,
  workerRows,
  workerStepCount,
  workerTaskBrief,
  type WorkerRow,
  type WorkerViewState,
} from "./worker-view";
import { useWorkerFeed } from "../../lib/useWorkerFeed";
import { useRunReports } from "../runs/run-format";
import "./worker-chat.css";

// A worker's own chat, inside the worker view (WorkerView.tsx): the brief it
// was given, its steps drawn with the main chat's own rows (tool calls fold
// the same way), the messages it was sent, and its final report. A worker
// that kept no feed shows its brief and report, and points at the raw output.

export default function WorkerChat({
  run,
  worker,
  attemptId,
  state,
  showLog,
  onCloseLog,
}: {
  run: RunState;
  worker: ChatWorker;
  attemptId: string;
  state: WorkerViewState;
  showLog: boolean;
  onCloseLog: () => void;
}) {
  const feed = useWorkerFeed(run.id, attemptId);
  const rows = useMemo(() => workerRows(foldWorkerFeed(feed)), [feed]);
  const running = state === "running" || state === "queued";
  // Only a worker that finished well folds, as a Cora turn does: a failed or
  // stopped one stays open, since that is when its steps matter.
  const fold = useMemo(() => (state === "done" ? foldFinishedWorker(rows) : null), [state, rows]);
  const [foldOpen, setFoldOpen] = useState(false);
  const report = useRunReports(run).get(attemptId) ?? null;
  const attempt = run.workerAttempts.find((candidate) => candidate.id === attemptId) ?? null;
  const brief = useBrief(run.id, attemptId);
  const taskBrief = workerTaskBrief(run, attempt);
  const [showPrompt, setShowPrompt] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(running);

  // A running worker follows its newest step while you are at the bottom.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && pinned.current) scroller.scrollTop = scroller.scrollHeight;
  }, [rows, feed.partial, brief, report]);

  const shown: WorkerRow[] = fold && !foldOpen && fold.hidden > 0 ? fold.kept : rows;
  const lastTurn = [...shown].reverse().find((row) => row.kind === "turn");
  const steps = workerStepCount(rows);
  const unrecorded = feed.loaded && !feed.available && !feed.live && rows.length === 0;

  return (
    <div
      ref={scrollRef}
      className="cora-worker-view__scroll cora-conversation"
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div style={CONVERSATION_COLUMN_STYLE} className="cora-worker-view__column">
        <div className="cora-worker-brief" data-worker-brief>
          <div className="cora-worker-brief__head">
            <span className="cora-worker-brief__dot" aria-hidden />
            Brief from Cora
            {attempt?.startedAt ? <time dateTime={attempt.startedAt}>· {formatMessageTime(attempt.startedAt)}</time> : null}
          </div>
          <div className="cora-message cora-message--user" style={USER_BUBBLE_STYLE}>
            {taskBrief ? (
              // What Cora wrote for this worker first; the whole prompt it
              // received, standing rules included, one click away.
              <>
                <div className="cora-worker-brief__task" data-worker-brief-task>
                  <CollapsibleUserText id={`worker-brief:${attemptId}`} text={taskBrief.text} findCurrent={false} />
                </div>
                <button
                  type="button"
                  className="cora-user-more"
                  aria-expanded={showPrompt}
                  onClick={() => setShowPrompt(!showPrompt)}
                >
                  {showPrompt ? "Hide the full prompt" : "Show the full prompt, with the standing rules"}
                </button>
                {showPrompt && (
                  <div className="cora-worker-brief__prompt" data-worker-brief-prompt>
                    {brief.text !== null ? (
                      <Markdown text={brief.text} />
                    ) : (
                      <span className="cora-worker-view__muted">
                        {brief.error ? "The prompt could not be read." : "Reading the prompt…"}
                      </span>
                    )}
                  </div>
                )}
              </>
            ) : brief.text !== null ? (
              <CollapsibleUserText id={`worker-brief:${attemptId}`} text={brief.text} findCurrent={false} />
            ) : (
              <span className="cora-worker-view__muted">{brief.error ? "The brief could not be read." : "Reading the brief…"}</span>
            )}
          </div>
        </div>

        {fold && fold.hidden > 0 && (
          <button
            type="button"
            className="cora-turn-head cora-turn-head--fold"
            aria-expanded={foldOpen}
            onClick={() => setFoldOpen(!foldOpen)}
          >
            <ChevronGlyph open={foldOpen} />
            Worked for {workerElapsed(attempt, Date.now()) ?? "a while"}
            {steps > 0 ? ` · ${steps} ${steps === 1 ? "step" : "steps"}` : ""}
          </button>
        )}

        {shown.map((row) => (
          <WorkerRowView key={row.id} row={row} live={running && row === lastTurn} />
        ))}

        {unrecorded && (
          <p className="cora-worker-view__note">
            This worker's steps were not recorded. Its brief and report are here; everything it printed is under
            Raw terminal output in the ⋯ menu.
          </p>
        )}
        {feed.error && <p className="cora-worker-view__note">The steps could not be read: {feed.error}</p>}
        {state === "failed" && attempt?.error && (
          <div role="alert" className="cora-worker-chat__error">
            {attempt.error}
          </div>
        )}

        {report && <WorkerReportView report={report} />}

        {showLog && <RawLog runId={run.id} attemptId={attemptId} onClose={onCloseLog} title={worker.title} />}
      </div>
    </div>
  );
}

function WorkerRowView({ row, live }: { row: WorkerRow; live: boolean }) {
  if (row.kind === "turn") {
    return (
      <div className="cora-worker-turn">
        <TurnSegments segments={liveTurnSegments(row.blocks)} live={live} />
      </div>
    );
  }
  if (row.kind === "message") {
    return (
      <div className="cora-worker-message" data-worker-message={row.from}>
        <div className="cora-worker-brief__head">
          {row.from === "user" ? "You" : "Codara"}
          <time dateTime={row.at}>· {formatMessageTime(row.at)}</time>
        </div>
        <div className="cora-message cora-message--user" style={USER_BUBBLE_STYLE}>
          <Markdown text={row.text} />
        </div>
      </div>
    );
  }
  if (row.kind === "note") return <p className="cora-worker-view__note">{row.text}</p>;
  return (
    <p className="cora-worker-view__note">
      {row.count.toLocaleString()} earlier {row.count === 1 ? "step was" : "steps were"} not kept.
    </p>
  );
}

function WorkerReportView({ report }: { report: WorkerReport }) {
  return (
    <section className="cora-worker-report" aria-label="Final report">
      <div className="cora-worker-report__head">
        Final report <span data-status={report.status}>· {report.status}</span>
      </div>
      {report.summary && <Markdown text={report.summary} />}
      {report.filesChanged.length > 0 && (
        <>
          <div className="cora-worker-report__label">Changed files</div>
          <ul className="cora-worker-report__list">
            {report.filesChanged.map((file, index) => (
              <li key={`${file.path}:${index}`}>
                <code>{file.path}</code>
                {file.reason ? <span> · {file.reason}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {report.tests.length > 0 && (
        <>
          <div className="cora-worker-report__label">Checks</div>
          <ul className="cora-worker-report__list">
            {report.tests.map((check, index) => (
              <li key={`${check.command}:${index}`}>
                <span className="cora-worker-report__check" data-result={check.result}>
                  {check.result === "passed" ? "passed" : check.result === "failed" ? "failed" : "not run"}
                </span>{" "}
                <code>{check.command}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RawLog({
  runId,
  attemptId,
  title,
  onClose,
}: {
  runId: string;
  attemptId: string;
  title: string;
  onClose: () => void;
}) {
  const [log, setLog] = useState<{ text: string; truncated: boolean } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    window.spark.orchestration
      .readWorkerLog(runId, attemptId)
      .then((value) => live && setLog(value))
      .catch(() => live && setLog(null));
    return () => {
      live = false;
    };
  }, [runId, attemptId]);
  return (
    <section className="cora-worker-log" aria-label={`Raw terminal output of ${title}`}>
      <div className="cora-worker-report__head">
        Raw terminal output
        <button type="button" className="cora-worker-log__hide" onClick={onClose}>
          Hide
        </button>
      </div>
      <pre>
        {log === undefined
          ? "Reading…"
          : log === null || !log.text
            ? "This worker printed nothing."
            : `${log.truncated ? "… earlier output not shown …\n" : ""}${log.text}`}
      </pre>
    </section>
  );
}

function useBrief(runId: string, attemptId: string): { text: string | null; error: boolean } {
  const [brief, setBrief] = useState<{ text: string | null; error: boolean }>({ text: null, error: false });
  useEffect(() => {
    let live = true;
    window.spark.orchestration
      .readWorkerPrompt(runId, attemptId)
      .then((text) => live && setBrief({ text, error: false }))
      .catch(() => live && setBrief({ text: null, error: true }));
    return () => {
      live = false;
    };
  }, [runId, attemptId]);
  return brief;
}
