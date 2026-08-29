import React, { useEffect, useRef, useState } from "react";
import type { RunState } from "@shared/types";
import { runStatusColor } from "../../lib/run-status";
import { fmtTime, fmtUsd } from "./presentation";

// Inline run drawer for the history timeline's "Peek run" — shows a past
// iteration's transcript without ever leaving the Automations tab (loom runs
// deliberately have no chat tab to jump to). Steps-only passes additionally
// get a mini terminal: the streamed steps.log, live-tailed while the run is
// still going, with per-step status dots in its title bar.

export default function RunPeek({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}): React.ReactElement {
  const [run, setRun] = useState<RunState | null>(null);
  const [missing, setMissing] = useState(false);

  // Fetch the run; while it is still running, keep refreshing so the peek's
  // status dot, cost, transcript, and step states track the live pass.
  const running = run?.status === "running";
  useEffect(() => {
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.spark.orchestration.getRun(runId);
        if (disposed) return;
        if (next) setRun(next);
        else setMissing(true);
      } catch {
        if (!disposed) setMissing(true);
      }
    };
    void refresh();
    if (!running) {
      return () => {
        disposed = true;
      };
    }
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [runId, running]);

  return (
    <div
      className="spark-fade-in"
      style={{
        margin: "6px 0 10px",
        borderRadius: "var(--radius-surface)",
        border: "1px solid var(--rule)",
        background: "var(--panel)",
        boxShadow: "var(--shadow-1)",
        display: "flex",
        flexDirection: "column",
        maxHeight: 340,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--rule-soft)",
          background: "var(--panel-2)",
        }}
      >
        {run && (
          <span
            aria-hidden
            style={{
              flex: "0 0 7px",
              width: 7,
              height: 7,
              borderRadius: 999,
              background: runStatusColor(run.status),
            }}
          />
        )}
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {run?.title ?? (missing ? "Run no longer on disk" : "Loading…")}
        </span>
        {run && (
          <span
            className="spark-mono spark-num"
            style={{ fontSize: 10, color: "var(--muted)" }}
            title={
              (run.estimatedWorkerCostUsd ?? 0) > 0
                ? "Includes estimated value of subscription usage priced at public list rates; billed spend: " +
                  fmtUsd((run.totalCostUsd ?? 0) + (run.measuredWorkerCostUsd ?? 0))
                : "Billed spend"
            }
          >
            {(run.estimatedWorkerCostUsd ?? 0) > 0 ? "est. " : ""}
            {fmtUsd(
              (run.totalCostUsd ?? 0) +
                (run.measuredWorkerCostUsd ?? 0) +
                (run.estimatedWorkerCostUsd ?? 0),
            )}
          </span>
        )}
        <button
          type="button"
          className="spark-icon-btn"
          aria-label="Close run peek"
          style={{ ["--spark-icon-btn-size"]: "18px" } as React.CSSProperties}
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
        {run?.loomPass?.stepsLogPath && (
          <StepsTerminal
            logPath={run.loomPass.stepsLogPath}
            nodeStates={run.loomPass.nodeStates}
            live={run.status === "running"}
          />
        )}
        {missing ? (
          <span style={{ fontSize: 11, color: "var(--muted-2)" }}>
            This iteration's run was cleaned up by run retention — only the history summary remains.
          </span>
        ) : !run ? (
          <span style={{ fontSize: 11, color: "var(--muted-2)" }}>Loading…</span>
        ) : run.humanMessages.length === 0 ? (
          <span style={{ fontSize: 11, color: "var(--muted-2)" }}>No transcript messages.</span>
        ) : (
          run.humanMessages.map((m) => (
            <div key={m.id} style={{ display: "flex", gap: 8 }}>
              <span
                className="spark-eyebrow"
                style={{
                  flex: "0 0 52px",
                  paddingTop: 2,
                  color: m.author === "user" ? "var(--muted)" : "var(--accent-text)",
                }}
              >
                {/* "spark" is the internal author id (legacy codename) — the
                    user-facing brand for the orchestrator voice is Cora. */}
                {m.author === "user" ? "you" : "cora"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  className="spark-mono"
                  style={{ fontSize: 11, color: "var(--ink-dim)", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5, maxHeight: 120, overflow: "auto" }}
                >
                  {m.message}
                </div>
                <div className="spark-mono" style={{ fontSize: 9, color: "var(--muted-2)", marginTop: 2 }}>
                  {fmtTime(m.createdAt)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// The pass's terminal: the streamed steps.log rendered as a mini console with
// per-step status lights in its title bar. Live runs tail the file every
// second and stick to the newest output unless the user scrolls up to read;
// finished runs show the full retained log once.
function StepsTerminal({
  logPath,
  nodeStates,
  live,
}: {
  logPath: string;
  nodeStates: Record<string, { status: string; layer: number }>;
  live: boolean;
}): React.ReactElement | null {
  const [content, setContent] = useState("");
  const scrollRef = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const file = await window.spark.fs.readTextTail(logPath, 80_000);
        if (!disposed) setContent(file.content);
      } catch {
        /* not created yet, or retention removed it — the block stays quiet */
      }
    };
    void refresh();
    if (!live) {
      return () => {
        disposed = true;
      };
    }
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [logPath, live]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [content]);

  const steps = Object.entries(nodeStates).sort((a, b) => a[1].layer - b[1].layer);
  const dotColor = (status: string): string =>
    status === "succeeded"
      ? "var(--ok)"
      : status === "failed" || status === "blocked"
        ? "var(--danger)"
        : status === "running"
          ? "var(--accent)"
          : "var(--muted-2)";

  return (
    <div
      style={{
        flex: "0 0 auto",
        borderRadius: 8,
        border: "1px solid var(--rule-soft)",
        background: "color-mix(in oklch, black 55%, var(--panel))",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 9px",
          borderBottom: "1px solid var(--rule-soft)",
          background: "color-mix(in oklch, black 30%, var(--panel))",
        }}
      >
        <span aria-hidden style={{ display: "inline-flex", gap: 4 }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span
              key={c}
              style={{ width: 7, height: 7, borderRadius: 999, background: c, opacity: 0.7 }}
            />
          ))}
        </span>
        <span className="spark-eyebrow" style={{ color: "var(--muted)" }}>
          step output
        </span>
        <span style={{ flex: 1 }} />
        {steps.map(([id, s]) => (
          <span
            key={id}
            className="spark-mono"
            title={`${id}: ${s.status}${s.status === "running" ? "…" : ""}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 9.5,
              color: "var(--muted)",
            }}
          >
            <span
              aria-hidden
              className={s.status === "running" ? "spark-activity-spin" : undefined}
              style={
                s.status === "running"
                  ? {
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background:
                        "conic-gradient(from 0deg, transparent 0deg 90deg, var(--accent) 360deg)",
                      WebkitMask:
                        "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))",
                      mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))",
                    }
                  : { width: 6, height: 6, borderRadius: 999, background: dotColor(s.status) }
              }
            />
            {id}
          </span>
        ))}
      </div>
      <pre
        ref={scrollRef}
        className="spark-mono"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        style={{
          margin: 0,
          padding: "7px 10px",
          maxHeight: 150,
          overflow: "auto",
          fontSize: 10.5,
          lineHeight: 1.55,
          color: "var(--ink-dim)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {content.trim() || (live ? "Waiting for output…" : "No output was captured.")}
      </pre>
    </div>
  );
}
