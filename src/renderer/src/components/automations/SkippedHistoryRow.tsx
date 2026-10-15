import React, { useState } from "react";
import type { AutomationRunRecord, AutomationSkipRecord } from "@shared/types";
import { fmtTime } from "./presentation";

// A history-timeline row for a pass that did not start: its precheck said no,
// or its scheduled time was missed and not caught up. No run exists, so the
// row has no run chip and no peek; it expands to the reason and the check's
// output.

export type TimelineRow = AutomationRunRecord | { skip: AutomationSkipRecord };

/** Passes and skips in one list, newest first. */
export function mergeTimeline(
  history: AutomationRunRecord[],
  skips: AutomationSkipRecord[] | undefined,
): TimelineRow[] {
  const rows: { row: TimelineRow; t: number; i: number }[] = history.map((rec, i) => ({
    row: rec,
    t: Date.parse(rec.startedAt) || 0,
    i,
  }));
  (skips ?? []).forEach((skip, j) => rows.push({ row: { skip }, t: Date.parse(skip.at) || 0, i: history.length + j }));
  rows.sort((a, b) => b.t - a.t || b.i - a.i);
  return rows.map((r) => r.row);
}

export default function SkippedHistoryRow({
  jobId,
  skip,
}: {
  jobId: string;
  skip: AutomationSkipRecord;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const label = skip.reason === "precheck" ? "precheck said no" : "missed";
  const output = skip.precheck?.outputTail ?? "";
  const repeats = skip.repeats && skip.repeats > 1 ? skip.repeats : 0;
  return (
    <div data-testid="history-skip-row" data-skip-reason={skip.reason}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          paddingRight: 4,
          borderBottom: expanded ? "none" : "1px solid var(--rule-soft)",
          background: expanded ? "var(--hover)" : "transparent",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            appearance: "none",
            textAlign: "left",
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "7px 4px",
            border: "none",
            background: "transparent",
            cursor: "default",
          }}
        >
          <span
            aria-hidden
            style={{
              flex: "0 0 7px",
              width: 7,
              height: 7,
              borderRadius: 999,
              border: "1.5px solid var(--muted)",
              boxSizing: "border-box",
            }}
          />
          <span className="spark-badge" style={{ flex: "0 0 auto" }} data-testid="history-skip-badge">
            {repeats ? `skipped ${repeats} times` : "skipped"}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11,
              color: "var(--muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={skip.detail}
          >
            {skip.detail}
          </span>
          <span className="spark-mono" style={{ flex: "0 0 auto", fontSize: 9.5, color: "var(--muted-2)" }}>
            {label}
          </span>
          <span className="spark-mono" style={{ flex: "0 0 auto", fontSize: 9.5, color: "var(--muted-2)" }}>
            {fmtTime(skip.at)}
          </span>
        </button>
      </div>
      {expanded && (
        <div
          style={{
            padding: "4px 4px 10px 21px",
            borderBottom: "1px solid var(--rule-soft)",
            background: "var(--hover)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ fontSize: 11, color: "var(--ink-dim)", lineHeight: 1.5 }}>{skip.detail}</div>
          {repeats ? (
            <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
              The same skip {repeats} times in a row, from {fmtTime(skip.firstAt ?? skip.at)} to{" "}
              {fmtTime(skip.at)}.{output ? " The output below is from the latest one." : ""}
            </div>
          ) : null}
          {skip.precheck && (
            <div className="spark-mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
              $ {skip.precheck.command}
            </div>
          )}
          {output && (
            <pre
              className="spark-mono"
              data-testid="history-skip-output"
              style={{
                margin: 0,
                fontSize: 10.5,
                color: "var(--ink-dim)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 140,
                overflow: "auto",
                lineHeight: 1.5,
              }}
            >
              {output}
            </pre>
          )}
          {skip.missed && (
            <div className="spark-mono" style={{ fontSize: 10, color: "var(--muted)" }}>
              latest missed time {fmtTime(skip.missed.scheduledFor)}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="spark-btn"
              style={{ height: 22, padding: "0 9px", fontSize: 10.5, color: "var(--danger)" }}
              title="Remove this row from the history"
              onClick={() => {
                setExpanded(false);
                void window.spark.scheduler.deleteHistoryEntry(jobId, skip.id, skip.at);
              }}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
