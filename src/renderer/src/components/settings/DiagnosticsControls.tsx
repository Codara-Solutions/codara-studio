// The Diagnostics section of Settings > About: what the crash and freeze
// black box has recorded, and the "Export diagnostics" button that saves a
// redacted zip (src/main/diagnostics/). The rows themselves are drawn in
// AboutSettings with literal titles, so Settings search can find them; this
// hook supplies their live parts.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  describeDiagnosticsSummary,
  formatBytes,
  type DiagnosticsExportResult,
  type DiagnosticsSummary,
} from "@shared/diagnostics";
import { InlineMessage } from "./SettingsPrimitives";

type SavedExport = Extract<DiagnosticsExportResult, { status: "saved" }>;

type ExportState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "saved"; result: SavedExport }
  | { kind: "error"; message: string };

const formatTime = (epochMs: number): string =>
  new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

export interface DiagnosticsControls {
  /** The "Freezes and crashes" description. */
  history: string;
  exportButton: ReactNode;
  /** Shown under the export row once an export finished or failed. */
  exportMessage: ReactNode;
}

export function useDiagnostics(): DiagnosticsControls {
  const [summary, setSummary] = useState<DiagnosticsSummary | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [state, setState] = useState<ExportState>({ kind: "idle" });

  useEffect(() => {
    let alive = true;
    window.spark.diagnostics.summary().then(
      (next) => {
        if (alive) setSummary(next);
      },
      () => {
        if (alive) setUnreadable(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const runExport = useCallback(async () => {
    setState({ kind: "working" });
    try {
      const result = await window.spark.diagnostics.exportBundle();
      setState(result.status === "saved" ? { kind: "saved", result } : { kind: "idle" });
    } catch (error) {
      setState({ kind: "error", message: messageOf(error) });
    }
  }, []);

  const history = summary
    ? describeDiagnosticsSummary(summary, formatTime)
    : unreadable
      ? "The records could not be read."
      : "Reading the records…";

  const exportButton = (
    <button
      type="button"
      className="spark-btn"
      aria-label="Export diagnostics"
      onClick={() => void runExport()}
      disabled={state.kind === "working"}
    >
      {state.kind === "working" ? "Exporting…" : "Export…"}
    </button>
  );

  let exportMessage: ReactNode = null;
  if (state.kind === "saved") {
    const { fileName, files, bytes } = state.result;
    exportMessage = (
      <InlineMessage
        tone="ok"
        role="status"
        action={
          <button
            type="button"
            className="st-link-btn"
            onClick={() => void window.spark.diagnostics.revealExport()}
          >
            Show in folder
          </button>
        }
      >
        Saved {fileName} ({files} files, {formatBytes(bytes)}).
      </InlineMessage>
    );
  } else if (state.kind === "error") {
    exportMessage = (
      <InlineMessage tone="danger" role="alert">
        Could not export: {state.message}
      </InlineMessage>
    );
  }

  return { history, exportButton, exportMessage };
}
