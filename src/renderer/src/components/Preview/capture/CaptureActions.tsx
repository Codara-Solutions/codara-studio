import { useCallback, useEffect, useRef, useState } from "react";

import type { CaptureRecordingResult } from "@shared/capture";
import { holdPreviewCapturePaint } from "../capturePaint";
import { CloseIcon } from "../../icons";
import { DevicesIcon, RecordIcon } from "./icons";

// The browser pane's capture controls, shown in the address bar's tools
// cluster: the responsive view toggle and the record button. A recording
// started by an agent on this tab shows here too (the same tab session).
// The pane also keeps its guest painting while main captures it in the
// background (src/main/browser/capture/paint.ts).

interface Props {
  url: string;
  visible: boolean;
  tabId?: string;
  workspaceId?: string | null;
  responsive: boolean;
  onToggleResponsive: () => void;
  getWebview: () => (HTMLElement & { getWebContentsId?: () => number }) | null;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function CaptureActions({ url, visible, tabId, workspaceId, responsive, onToggleResponsive, getWebview }: Props) {
  const keyRef = useRef<string | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CaptureRecordingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const recording = since !== null;

  const webContentsId = useCallback((): number | null => {
    try {
      const id = getWebview()?.getWebContentsId?.();
      return typeof id === "number" ? id : null;
    } catch {
      return null;
    }
  }, [getWebview]);

  useEffect(() => {
    const capture = window.spark.capture;
    if (!capture) return;
    return capture.onRecordingChanged((change) => {
      if (!keyRef.current || change.key !== keyRef.current) return;
      if (change.recording) {
        setSince((current) => current ?? Date.now());
        return;
      }
      setSince(null);
      setBusy(false);
      if (change.result) {
        setResult(change.result);
        setError(null);
      } else if (change.error) {
        setError(change.error);
      }
    });
  }, []);

  // Learn this tab's session key (and any recording an agent started)
  // once the guest exists, and again after it is re-created.
  useEffect(() => {
    const id = webContentsId();
    if (id === null || !url) return;
    let cancelled = false;
    void window.spark.capture
      ?.record({ webContentsId: id, tabId, workspaceId, action: "status" })
      .then((response) => {
        if (cancelled) return;
        keyRef.current = response.key;
        setSince(response.status ? Date.now() - response.status.elapsedMs : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url, visible, tabId, workspaceId, webContentsId]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [recording]);

  // Main asks the pane owning a guest to keep it painting while a protocol
  // capture (full page, sizes, a recording) runs behind another tab.
  useEffect(() => {
    const capture = window.spark.capture;
    if (!capture?.onGuestPaint) return;
    const leases = new Map<string, () => void>();
    const off = capture.onGuestPaint((request) => {
      if (!request.hold) {
        leases.get(request.reqId)?.();
        leases.delete(request.reqId);
        return;
      }
      const element = getWebview();
      if (!element || request.webContentsId !== webContentsId()) return;
      leases.set(request.reqId, holdPreviewCapturePaint(element).release);
      element.getBoundingClientRect();
      setTimeout(() => capture.ackGuestPaint({ reqId: request.reqId, held: true }), 120);
    });
    return () => {
      off();
      for (const release of leases.values()) release();
      leases.clear();
    };
  }, [getWebview, webContentsId]);

  const toggleRecording = async (format: "gif" | "webm") => {
    const id = webContentsId();
    if (id === null || busy) return;
    setError(null);
    setCopied(false);
    try {
      if (recording) {
        setBusy(true);
        const response = await window.spark.capture.record({ webContentsId: id, tabId, workspaceId, action: "stop" });
        keyRef.current = response.key;
        setSince(null);
        if (response.result) setResult(response.result);
      } else {
        setResult(null);
        const response = await window.spark.capture.record({ webContentsId: id, tabId, workspaceId, action: "start", format });
        keyRef.current = response.key;
        setSince(Date.now() - (response.status?.elapsedMs ?? 0));
        setNow(Date.now());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      setBusy(false);
    }
  };

  const fileName = result ? result.path.split(/[\\/]/).pop() : "";
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 2 }}>
      <button
        type="button"
        className={`spark-icon-btn${responsive ? " is-active" : ""}`}
        title={responsive ? "Close the responsive view" : "Responsive view: phone, tablet and desktop side by side"}
        aria-label={responsive ? "Close the responsive view" : "Responsive view"}
        aria-pressed={responsive}
        disabled={!url}
        onClick={onToggleResponsive}
        style={{ ["--spark-icon-btn-size" as string]: "22px" }}
      >
        <DevicesIcon size={13} />
      </button>
      <button
        type="button"
        className="spark-icon-btn"
        data-testid="preview-record"
        title={recording ? "Stop recording and save the file" : "Record this tab as a GIF (Shift-click for a WebM video)"}
        aria-label={recording ? "Stop recording" : "Record"}
        aria-pressed={recording}
        disabled={!url || busy}
        onClick={(event) => void toggleRecording(event.shiftKey ? "webm" : "gif")}
        style={{
          ["--spark-icon-btn-size" as string]: "22px",
          width: recording || busy ? "auto" : undefined,
          padding: recording || busy ? "0 6px 0 4px" : undefined,
          gap: 4,
          color: recording ? "var(--danger)" : undefined,
        }}
      >
        <RecordIcon size={13} active={recording} />
        {recording ? (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
            {formatElapsed(now - (since ?? now))}
          </span>
        ) : busy ? (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)" }}>saving</span>
        ) : null}
      </button>
      {result || error ? (
        <div
          className="spark-menu spark-fade-in"
          role="status"
          data-testid="preview-record-result"
          style={{ position: "absolute", top: 30, right: -4, zIndex: 50, width: 300, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="spark-eyebrow" style={{ flex: 1, color: error ? "var(--danger)" : undefined }}>
              {error ? "Recording failed" : "Recording saved"}
            </span>
            <button
              type="button"
              className="spark-icon-btn"
              title="Dismiss"
              aria-label="Dismiss"
              onClick={() => {
                setResult(null);
                setError(null);
              }}
              style={{ ["--spark-icon-btn-size" as string]: "18px" }}
            >
              <CloseIcon size={11} />
            </button>
          </div>
          {error ? (
            <div style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.4 }}>{error}</div>
          ) : result ? (
            <>
              <div
                title={result.path}
                data-testid="preview-record-path"
                style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {fileName}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                {result.format.toUpperCase()} · {formatBytes(result.bytes)} · {(result.durationMs / 1000).toFixed(1)} s · {result.size.width}x{result.size.height}
              </div>
              {result.note ? <div style={{ fontSize: 11, color: "var(--ink-dim)", lineHeight: 1.4 }}>{result.note}</div> : null}
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="spark-btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(result.path).then(() => setCopied(true), () => {});
                  }}
                >
                  {copied ? "Copied" : "Copy path"}
                </button>
                <button type="button" className="spark-btn" onClick={() => void window.spark.fs.revealInOS(result.path)}>
                  Show in folder
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
