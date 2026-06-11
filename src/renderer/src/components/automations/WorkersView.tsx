import React, { useEffect, useState } from "react";
import type { AutomationWorkerInfo, ScheduledJob, ShellInfo } from "@shared/types";
import { TerminalPane } from "../Terminal/TerminalPane";
import { fmtClock, fmtElapsed } from "./presentation";

// The Workers sub-tab: every live automation worker as a full terminal pane,
// attached to the headless pty main spawned for it (sessionId === attemptId).
// The worker runs regardless of whether this view is mounted — pty-manager
// replays the tail buffer on late attach, so switching here mid-pass shows
// the CLI's banner + recent output instead of a black pane.

// The pty already exists (direct-worker.ts spawned it). TerminalPane's shell
// prop is required but ignored on attach; the noop exe means an id mismatch
// could never accidentally spawn a real shell. Mirrors ChatPanel's
// BACKEND_TERMINAL_SHELL.
const ATTACHED_SHELL: ShellInfo = {
  id: "spark-loom-worker-attached",
  label: "Loom worker PTY",
  exe: "noop",
  args: [],
  family: "other",
};

const LIVE_ATTEMPT = new Set(["preparing", "prompt_ready", "launching", "running", "finishing"]);

export interface WorkersViewProps {
  workers: AutomationWorkerInfo[];
  jobs: ScheduledJob[];
  scrollbackLineLimit: number;
  visible: boolean;
  onStopLoom: (automationId: string) => void;
  onSelectLoom: (automationId: string) => void;
  onNewLoom: () => void;
}

export default function WorkersView({
  workers,
  jobs,
  scrollbackLineLimit,
  visible,
  onStopLoom,
  onSelectLoom,
  onNewLoom,
}: WorkersViewProps): React.ReactElement {
  if (workers.length === 0) {
    return (
      <EmptyWorkers jobs={jobs} onSelectLoom={onSelectLoom} onNewLoom={onNewLoom} />
    );
  }
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: 12,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(520px, 100%), 1fr))",
        gap: 8,
        alignContent: "start",
      }}
    >
      {workers.map((worker) => (
        <WorkerPane
          key={worker.attemptId}
          worker={worker}
          scrollbackLineLimit={scrollbackLineLimit}
          visible={visible}
          onStopLoom={onStopLoom}
          onSelectLoom={onSelectLoom}
        />
      ))}
    </div>
  );
}

function WorkerPane({
  worker,
  scrollbackLineLimit,
  visible,
  onStopLoom,
  onSelectLoom,
}: {
  worker: AutomationWorkerInfo;
  scrollbackLineLimit: number;
  visible: boolean;
  onStopLoom: (automationId: string) => void;
  onSelectLoom: (automationId: string) => void;
}): React.ReactElement {
  const [confirmStop, setConfirmStop] = useState(false);
  const [ptyExists, setPtyExists] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const live = LIVE_ATTEMPT.has(worker.status);
  const blocked = worker.blocked;
  const dot = blocked ? "var(--danger)" : live ? "var(--accent)" : "var(--muted)";

  // Same guard ChatPanel's backend terminal uses: mounting TerminalPane before
  // the pty exists would trigger a renderer-side spawn of the noop shell.
  useEffect(() => {
    let disposed = false;
    const check = async (): Promise<void> => {
      try {
        const exists = await window.spark.pty.exists(worker.attemptId);
        if (!disposed) setPtyExists(exists);
      } catch {
        if (!disposed) setPtyExists(false);
      }
    };
    void check();
    const interval = window.setInterval(check, 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [worker.attemptId]);

  // Elapsed ticker — only while live and on screen.
  useEffect(() => {
    if (!live || !visible) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live, visible]);

  // Auto-clear the two-step stop confirmation.
  useEffect(() => {
    if (!confirmStop) return;
    const t = window.setTimeout(() => setConfirmStop(false), 2500);
    return () => window.clearTimeout(t);
  }, [confirmStop]);

  return (
    <div
      className="spark-fade-in"
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        height: 420,
        borderRadius: "var(--radius-surface)",
        border: "1px solid var(--rule-soft)",
        background: "var(--panel)",
        overflow: "hidden",
        boxShadow: blocked
          ? "0 0 0 2px color-mix(in oklch, var(--danger) 35%, transparent)"
          : "var(--shadow-1)",
      }}
    >
      {/* Header */}
      <div
        style={{
          flex: "0 0 34px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          borderBottom: "1px solid var(--rule-soft)",
          background: "var(--panel-2)",
        }}
      >
        <span
          aria-hidden
          style={{
            flex: "0 0 8px",
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dot,
            boxShadow: `0 0 0 3px color-mix(in oklch, ${dot} 18%, transparent)`,
            animation: live && !blocked ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
        <button
          type="button"
          onClick={() => onSelectLoom(worker.automationId)}
          title="Open this loom's detail"
          style={{
            appearance: "none",
            border: "none",
            background: "transparent",
            padding: 0,
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--ink)",
            cursor: "default",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 220,
          }}
        >
          {worker.automationName}
        </button>
        <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted)" }}>
          pass {worker.iteration + 1}
        </span>
        <span
          className={`spark-badge ${worker.engine === "claude" ? "is-accent" : "is-info"}`}
          title={worker.model ?? "CLI default model"}
        >
          {worker.engine.toUpperCase()}
          {worker.model ? ` · ${worker.model}` : ""}
        </span>
        <span style={{ flex: 1 }} />
        <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted-2)" }} title={`started ${fmtClock(worker.startedAt)}`}>
          {live ? fmtElapsed(worker.startedAt, now) : "finished"}
        </span>
        <button
          type="button"
          className="spark-btn is-danger"
          style={{ height: 22, padding: "0 8px", fontSize: 10.5 }}
          disabled={!live}
          onClick={() => {
            if (confirmStop) {
              setConfirmStop(false);
              onStopLoom(worker.automationId);
            } else {
              setConfirmStop(true);
            }
          }}
          onMouseLeave={() => setConfirmStop(false)}
          title="Stop this loom (kills the worker)"
        >
          {confirmStop ? "stop?" : "Stop"}
        </button>
      </div>

      {blocked && (
        <div
          style={{
            flex: "0 0 auto",
            padding: "6px 10px",
            fontSize: 11,
            color: "var(--ink)",
            background: "var(--danger-soft)",
            borderBottom: "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
          }}
        >
          Waiting for you — answer in the terminal below, or use the question card in the loom's detail.
        </div>
      )}

      {/* Body: the live CLI terminal */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--bg)", padding: 4 }}>
        {ptyExists ? (
          <TerminalPane
            key={`loom-worker:${worker.attemptId}`}
            sessionId={worker.attemptId}
            shell={ATTACHED_SHELL}
            visible={visible}
            scrollbackLineLimit={scrollbackLineLimit}
            initialCwd={worker.cwd}
          />
        ) : (
          <div
            className="spark-mono"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: "var(--muted-2)",
            }}
          >
            {live ? "Worker starting…" : "Worker exited — terminal released."}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyWorkers({
  jobs,
  onSelectLoom,
  onNewLoom,
}: {
  jobs: ScheduledJob[];
  onSelectLoom: (automationId: string) => void;
  onNewLoom: () => void;
}): React.ReactElement {
  const armed = jobs.filter((j) => j.enabled && j.state.status !== "stopped");
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div className="spark-empty" style={{ padding: "42px 16px 18px", gap: 8 }}>
        <div className="spark-eyebrow">No workers running</div>
        <div className="spark-empty__body">When a loom fires, its worker runs here — live.</div>
        {jobs.length === 0 && (
          <button type="button" className="spark-btn is-primary" style={{ marginTop: 4 }} onClick={onNewLoom}>
            New loom
          </button>
        )}
      </div>
      {armed.length > 0 && (
        <div style={{ maxWidth: 460, margin: "0 auto", padding: "0 16px 24px" }}>
          <div className="spark-eyebrow" style={{ marginBottom: 8 }}>
            Armed looms
          </div>
          {armed.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => onSelectLoom(job.id)}
              style={{
                appearance: "none",
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 10px",
                marginBottom: 4,
                borderRadius: "var(--radius-control)",
                border: "1px solid var(--rule-soft)",
                background: "var(--panel)",
                cursor: "default",
                textAlign: "left",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "var(--panel)")}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--ink-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {job.name}
              </span>
              <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted-2)" }}>
                {job.state.nextFireAt ? `next ${fmtClock(job.state.nextFireAt)}` : job.state.status}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
