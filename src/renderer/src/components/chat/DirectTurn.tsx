import React, { useMemo } from "react";
import { foldWorkerFeed } from "@shared/worker-feed";
import { useWorkerFeed } from "../../lib/useWorkerFeed";
import { useNowTick, workerModelLabel } from "../runs/run-format";
import {
  ActivityIcon,
  ChevronGlyph,
  liveTurnSegments,
  SparkTurn,
  StepWorkerRowsContext,
  TurnSegments,
  USER_BUBBLE_STYLE,
  useRememberedOpen,
  WorkerOpenContext,
  type StepItem,
} from "./ChatConversation";
import Markdown from "./Markdown";
import { directTurnState } from "./direct-turn-state";
import { isToolRowTicking, runtimeLabel, toolDurationLabel } from "./timeline";
import { workerRows, type WorkerRow } from "./worker-view";

// A direct chat's turn (DESIGN.md, "Direct chats"): its one Pi worker's steps
// drawn as Cora's own work for the message, as a managed turn's are. No step
// header, generated title, goal or nested worker row; the facts worth keeping
// (model, time, changed files) sit on one quiet line, and Details goes inside
// the worker for its brief, report and raw output. The reply is the message
// the pass leaves below.
export default function DirectTurnWork({ item, runId }: { item: StepItem; runId: string }) {
  const worker = item.workers[0] ?? null;
  const row = React.useContext(StepWorkerRowsContext).get(worker?.id ?? "");
  useNowTick(1000, row ? isToolRowTicking(row) : false);
  const openWorker = React.useContext(WorkerOpenContext);
  const feed = useWorkerFeed(runId, worker?.attemptId ?? null);
  const rows = useMemo(() => workerRows(foldWorkerFeed(feed)), [feed]);
  const [opened, setOpened] = useRememberedOpen(`direct:${item.id}`);
  if (!worker) {
    return (
      <SparkTurn>
        <div className="cora-direct-turn" data-direct-turn={item.id} data-direct-state="starting">
          <div className="cora-turn-head cora-turn-head--live">
            <ActivityIcon state="dot" color="var(--accent)" />
            <span>Starting</span>
          </div>
        </div>
      </SparkTurn>
    );
  }
  const state = directTurnState(worker, row?.tone);
  const elapsed = row ? toolDurationLabel(row) : null;
  // Only a turn that finished well folds; a stopped or failed one stays open.
  const foldable = state === "done" && rows.length > 0;
  const showRows = state === "done" ? opened : true;
  const lastTurn = [...rows].reverse().find((candidate) => candidate.kind === "turn");
  const failure = state === "failed" && row?.detail ? row.detail : null;
  const diff = worker.diff;
  const meta = workerModelLabel(worker.model, runtimeLabel(worker.runtime));
  return (
    <SparkTurn>
      <div
        className="cora-direct-turn"
        data-direct-turn={item.id}
        data-direct-state={state}
        style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}
      >
        {state === "running" || state === "starting" ? (
          <div className="cora-turn-head cora-turn-head--live">
            <ActivityIcon state="dot" color="var(--accent)" />
            <span>{state === "starting" ? "Starting" : `Working${elapsed ? ` for ${elapsed}` : ""}`}</span>
          </div>
        ) : foldable ? (
          <button
            type="button"
            className="cora-turn-head cora-turn-head--fold"
            aria-expanded={opened}
            // Ten turns must not share one button name.
            aria-label={`${elapsed ? `Worked for ${elapsed}` : "Worked"}: ${item.title}`}
            onClick={() => setOpened(!opened)}
          >
            {elapsed ? `Worked for ${elapsed}` : "Worked"}
            <ChevronGlyph open={opened} />
          </button>
        ) : (
          <div className="cora-turn-head" style={state === "failed" ? { color: "var(--danger)" } : undefined}>
            {state === "blocked"
              ? "Waiting for your answer"
              : state === "stopped"
              ? `Stopped${elapsed ? ` after ${elapsed}` : ""}`
              : state === "failed"
                ? `Failed${elapsed ? ` after ${elapsed}` : ""}`
                : elapsed
                  ? `Worked for ${elapsed}`
                  : "Worked"}
          </div>
        )}
        {showRows &&
          rows.map((entry) => (
            <DirectWorkRow key={entry.id} row={entry} live={state === "running" && entry === lastTurn} />
          ))}
        {failure && <div className="cora-step-worker__failure">{failure}</div>}
        <div className="cora-direct-turn__meta" style={DIRECT_META_STYLE}>
          <span>{meta}</span>
          {diff?.files.map((file) => (
            <button
              type="button"
              key={file.path}
              className="cora-direct-turn__file"
              title={`Open the current working-tree diff of ${file.path}`}
              aria-label={`Open changes for ${file.path}`}
              onClick={() => window.dispatchEvent(new CustomEvent("spark:open-diff", { detail: { path: file.path } }))}
            >
              <span>{file.path}</span>
              <span style={{ color: "var(--ok)" }}>+{file.additions}</span>
              <span style={{ color: "var(--danger)" }}>−{file.deletions}</span>
            </button>
          ))}
          {diff && diff.fileCount > diff.files.length ? (
            <span>+{diff.fileCount - diff.files.length} more</span>
          ) : null}
          {openWorker && worker.attemptId ? (
            <button
              type="button"
              className="cora-direct-turn__details"
              // Back from the worker view returns focus here.
              data-worker-row={worker.id}
              aria-label={`Details of ${item.title}: brief, report and raw output`}
              onClick={() => openWorker(worker.id)}
            >
              Details
            </button>
          ) : null}
        </div>
      </div>
    </SparkTurn>
  );
}

function DirectWorkRow({ row, live }: { row: WorkerRow; live: boolean }) {
  if (row.kind === "turn") return <TurnSegments segments={liveTurnSegments(row.blocks)} live={live} />;
  if (row.kind === "message") {
    // Studio's own word to the worker (a report it asked again for) is a
    // quiet note, labelled as the worker view labels it; only the user's
    // messages are bubbles.
    if (row.from === "cora") {
      return (
        <div className="cora-direct-turn__note" data-worker-message="cora" style={{ fontSize: 12, color: "var(--muted)" }}>
          <span style={{ fontWeight: 600 }}>Codara: </span>
          {row.text}
        </div>
      );
    }
    return (
      <div style={{ alignSelf: "flex-end", maxWidth: "80%", ...USER_BUBBLE_STYLE }}>
        <Markdown text={row.text} />
      </div>
    );
  }
  const text = row.kind === "note" ? row.text : `${row.count.toLocaleString()} earlier steps were not kept.`;
  return <div style={{ fontSize: 12, color: "var(--muted)" }}>{text}</div>;
}

const DIRECT_META_STYLE: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  columnGap: 10,
  rowGap: 2,
  fontSize: 11.5,
  color: "var(--muted)",
  minWidth: 0,
};
