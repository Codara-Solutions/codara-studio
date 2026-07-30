import React, { useEffect, useState } from "react";
import type { RunState } from "@shared/types";
import { runStatusColor } from "../../lib/run-status";
import { fmtTime, fmtUsd } from "./presentation";

// Inline run drawer for the history timeline's "Peek run" — shows a past
// iteration's transcript without ever leaving the Automations tab (loom runs
// deliberately have no chat tab to jump to).

export default function RunPeek({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}): React.ReactElement {
  const [run, setRun] = useState<RunState | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const next = await window.spark.orchestration.getRun(runId);
        if (disposed) return;
        if (next) setRun(next);
        else setMissing(true);
      } catch {
        if (!disposed) setMissing(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [runId]);

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
          <span className="spark-mono spark-num" style={{ fontSize: 10, color: "var(--muted)" }}>
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
                  color: m.author === "user" ? "var(--muted)" : "var(--accent)",
                }}
              >
                {m.author === "user" ? "you" : "spark"}
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
