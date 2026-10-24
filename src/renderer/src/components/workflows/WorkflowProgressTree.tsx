import React, { useMemo, useState } from "react";
import type { WorkflowRunStatus, WorkflowTreeCall, WorkflowTreePhase } from "@shared/workflow";

// The progress tree of one workflow run: phases in declared order, one row per
// agent() call with its status, model, badges and the reason a call resolved
// null, plus the narrator log and, once complete, the script's return value.
// Pure presentation: the parent polls the status and owns the actions.

const PHASE_COLLAPSE_AT = 50;

export interface WorkflowProgressTreeProps {
  status: WorkflowRunStatus;
  onSkip?: (seq: number) => void;
}

function compactTokens(n: number | undefined): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function elapsed(call: WorkflowTreeCall): string | null {
  if (!call.startedAt) return null;
  const end = call.finishedAt ? Date.parse(call.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(call.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

const STATUS_TONE: Record<WorkflowTreeCall["status"], string> = {
  queued: "var(--muted-2)",
  running: "var(--accent)",
  done: "var(--ok, var(--ink))",
  null: "var(--warn, var(--muted))",
  skipped: "var(--muted)",
  error: "var(--danger)",
};

const WAIT_TEXT: Record<NonNullable<WorkflowTreeCall["waiting"]>, string> = {
  slot: "waiting: slot",
  machine: "waiting: machine",
  memory: "waiting: memory",
  heavy: "waiting: heavy",
  budget: "waiting: budget",
};

function phaseCounts(phase: WorkflowTreePhase): { done: number; live: number; queued: number; nulls: number; cached: number } {
  let done = 0;
  let live = 0;
  let queued = 0;
  let nulls = 0;
  let cached = 0;
  for (const call of phase.calls) {
    if (call.status === "done") done += 1;
    else if (call.status === "running") live += 1;
    else if (call.status === "queued") queued += 1;
    else nulls += 1;
    if (call.cached) cached += 1;
  }
  return { done, live, queued, nulls, cached };
}

function CallRow({
  call,
  canSkip,
  onSkip,
}: {
  call: WorkflowTreeCall;
  canSkip: boolean;
  onSkip?: (seq: number) => void;
}): React.ReactElement {
  const time = elapsed(call);
  return (
    <div
      data-testid="workflow-call"
      data-status={call.status}
      data-cached={call.cached ? "true" : "false"}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 8,
        padding: "5px 8px 5px 22px",
        borderTop: "1px solid var(--rule)",
        fontSize: 11.5,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span
            aria-hidden
            style={{
              flex: "0 0 auto",
              width: 7,
              height: 7,
              borderRadius: 999,
              background: STATUS_TONE[call.status],
              animation: call.status === "running" ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
            }}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink)" }}>
            {call.label}
          </span>
          {call.cached && <span className="spark-badge">cached</span>}
          {call.isolated && <span className="spark-badge">isolated</span>}
          {call.heavy && <span className="spark-badge">heavy</span>}
          {call.waiting && <span className="spark-badge is-warn">{WAIT_TEXT[call.waiting]}</span>}
        </div>
        <div className="spark-mono" style={{ marginTop: 2, fontSize: 10, color: "var(--muted-2)" }}>
          {[call.model, call.effort, call.access && call.access !== "full" ? call.access : null, call.branch]
            .filter(Boolean)
            .join("  ")}
        </div>
        {call.note && (
          <div style={{ marginTop: 2, fontSize: 10.5, color: call.status === "done" ? "var(--muted)" : "var(--danger)" }}>
            {call.note}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted)" }}>
          {call.status}
          {time ? `  ${time}` : ""}
          {call.tokens ? `  ${compactTokens(call.tokens)}` : ""}
        </span>
        {canSkip && onSkip && (call.status === "queued" || call.status === "running") && !call.cached && (
          <button
            type="button"
            className="spark-btn"
            style={{ height: 20, padding: "0 7px", fontSize: 10.5 }}
            onClick={() => onSkip(call.seq)}
            title="Resolve this agent with null and let the script go on"
          >
            Skip
          </button>
        )}
      </div>
    </div>
  );
}

export default function WorkflowProgressTree({ status, onSkip }: WorkflowProgressTreeProps): React.ReactElement {
  const info = status.workflow;
  const phases = info.tree?.phases ?? [];
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expandedBig, setExpandedBig] = useState<Set<string>>(() => new Set());
  const logs = info.tree?.logs ?? [];
  const resultText = useMemo(() => {
    if (status.result === undefined) return null;
    try {
      return JSON.stringify(status.result, null, 2);
    } catch {
      return String(status.result);
    }
  }, [status.result]);
  const tokens = info.spent.inputTokens + info.spent.outputTokens;
  const canSkip = status.live && info.state === "running";

  return (
    <div data-testid="workflow-tree" data-state={info.state} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 11.5 }}>
        <span
          data-testid="workflow-state"
          className={`spark-badge ${
            info.state === "complete"
              ? "is-ok"
              : info.state === "failed"
                ? "is-danger"
                : info.state === "running"
                  ? "is-accent"
                  : "is-warn"
          }`}
        >
          {info.state}
        </span>
        <span className="spark-mono spark-num" style={{ color: "var(--muted)" }}>
          {info.counts.done}/{info.counts.issued} agents
          {info.counts.cached > 0 ? `  ${info.counts.cached} cached` : ""}
          {info.counts.nulls > 0 ? `  ${info.counts.nulls} null` : ""}
        </span>
        <span className="spark-mono spark-num" style={{ color: "var(--muted)" }}>
          {compactTokens(tokens)} tokens
          {info.caps.tokenCeiling ? ` / ${compactTokens(info.caps.tokenCeiling)}` : ""}
        </span>
        {info.counts.live > 0 && (
          <span className="spark-mono spark-num" style={{ color: "var(--muted)" }}>
            {info.counts.live} live
          </span>
        )}
      </div>
      {info.error && (
        <div
          role="alert"
          style={{
            padding: "7px 10px",
            borderRadius: "var(--radius-control)",
            background: info.state === "paused" ? "var(--hover)" : "var(--danger-soft)",
            fontSize: 11.5,
          }}
        >
          {info.error}
        </div>
      )}
      {info.tree?.memoryWait && (
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          New agents wait for memory: {(info.tree.memoryWait.freeBytes / 1024 ** 3).toFixed(1)} GB free, keeping{" "}
          {(info.tree.memoryWait.reserveBytes / 1024 ** 3).toFixed(1)} GB in reserve.
        </div>
      )}
      {logs.length > 0 && (
        <div className="spark-mono" style={{ fontSize: 10.5, color: "var(--muted)", whiteSpace: "pre-wrap" }}>
          {logs.slice(-3).join("\n")}
        </div>
      )}
      <div style={{ border: "1px solid var(--rule)", borderRadius: "var(--radius-control)", overflow: "hidden" }}>
        {phases.length === 0 && (
          <div style={{ padding: "10px 12px", fontSize: 11.5, color: "var(--muted)" }}>No agents yet.</div>
        )}
        {phases.map((phase, index) => {
          const counts = phaseCounts(phase);
          const isCollapsed = collapsed.has(phase.title);
          const big = phase.calls.length > PHASE_COLLAPSE_AT && !expandedBig.has(phase.title);
          const visible = big ? phase.calls.filter((call) => call.status === "running" || call.status === "queued").slice(0, PHASE_COLLAPSE_AT) : phase.calls;
          return (
            <div key={phase.title} data-testid="workflow-phase" data-title={phase.title} style={{ borderTop: index === 0 ? "none" : "1px solid var(--rule)" }}>
              <button
                type="button"
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(phase.title)) next.delete(phase.title);
                    else next.add(phase.title);
                    return next;
                  })
                }
                style={{
                  appearance: "none",
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 8px",
                  border: "none",
                  background: "var(--panel)",
                  color: "var(--ink)",
                  textAlign: "left",
                  fontSize: 12,
                  cursor: "default",
                }}
              >
                <span aria-hidden className="spark-mono" style={{ width: 10, color: "var(--muted-2)" }}>
                  {isCollapsed ? "›" : "⌄"}
                </span>
                <span style={{ fontWeight: 650 }}>{phase.title}</span>
                {phase.detail && <span style={{ color: "var(--muted)", fontSize: 11 }}>{phase.detail}</span>}
                <span style={{ flex: 1 }} />
                <span className="spark-mono spark-num" style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  {counts.done}/{phase.calls.length} done
                  {counts.live ? `  ${counts.live} live` : ""}
                  {counts.queued ? `  ${counts.queued} queued` : ""}
                  {counts.nulls ? `  ${counts.nulls} null` : ""}
                  {counts.cached ? `  ${counts.cached} cached` : ""}
                </span>
              </button>
              {!isCollapsed && (
                <div>
                  {visible.map((call) => (
                    <CallRow key={call.seq} call={call} canSkip={canSkip} onSkip={onSkip} />
                  ))}
                  {big && (
                    <button
                      type="button"
                      className="spark-btn"
                      style={{ margin: "6px 22px", height: 22, fontSize: 10.5 }}
                      onClick={() => setExpandedBig((current) => new Set(current).add(phase.title))}
                    >
                      Show all {phase.calls.length} agents
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {resultText !== null && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 650 }}>Result</span>
            <button
              type="button"
              className="spark-btn"
              style={{ height: 20, padding: "0 7px", fontSize: 10.5 }}
              onClick={() => void navigator.clipboard?.writeText(resultText).catch(() => undefined)}
            >
              Copy
            </button>
          </div>
          <pre
            data-testid="workflow-result"
            className="spark-mono"
            style={{
              margin: 0,
              maxHeight: 320,
              overflow: "auto",
              padding: "8px 10px",
              borderRadius: "var(--radius-control)",
              background: "var(--panel)",
              border: "1px solid var(--rule)",
              fontSize: 10.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {resultText}
          </pre>
        </div>
      )}
    </div>
  );
}
