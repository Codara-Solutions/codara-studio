import { useCallback, useEffect, useRef, useState } from "react";

import type { CaptureRecordFormat, CaptureRecordingResult } from "@shared/capture";
import AnchoredMenu from "../../chat/composer/AnchoredMenu";
import { holdPreviewCapturePaint } from "../capturePaint";
import { CloseIcon } from "../../icons";
import { setTabRecording } from "../tabs-memory/browserTabs";
import { RecordIcon } from "./icons";
import { BROWSER_MENU_Z } from "../fullScreen";

// The browser pane's Record tool. Record opens a small choice of Video or GIF
// (the last one picked is preselected) and starts on Start, so a click never
// records in a format the user did not see. While recording, the button shows
// the time and stops. A recording started by an agent on this tab shows here
// too (the same tab session). The pane also keeps its guest painting while
// main captures it in the background (src/main/browser/capture/paint.ts).

interface Props {
  url: string;
  visible: boolean;
  tabId?: string;
  workspaceId?: string | null;
  getWebview: () => (HTMLElement & { getWebContentsId?: () => number }) | null;
}

type PickedFormat = Extract<CaptureRecordFormat, "mp4" | "gif">;

const FORMAT_KEY = "codara.preview.recordFormat";

const FORMATS: ReadonlyArray<{ format: PickedFormat; label: string; hint: string }> = [
  { format: "mp4", label: "Video", hint: "MP4: sharp and smooth, small file. Best for sharing a walkthrough." },
  { format: "gif", label: "GIF", hint: "Plays inline in GitHub, pull requests and chats. Larger and fewer colors." },
];

function storedFormat(): PickedFormat {
  try {
    return window.localStorage.getItem(FORMAT_KEY) === "gif" ? "gif" : "mp4";
  } catch {
    return "mp4";
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
}

export default function CaptureActions({ url, visible, tabId, workspaceId, getWebview }: Props) {
  const keyRef = useRef<string | null>(null);
  const recordRef = useRef<HTMLButtonElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<CaptureRecordingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [format, setFormat] = useState<PickedFormat>(storedFormat);
  const [chooserOpen, setChooserOpen] = useState(false);
  const recording = since !== null;
  const saving = busy && !recording;

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
      if (typeof change.progress === "number" && !change.result && !change.error) {
        // Encoding, after a stop from here or from an agent.
        setBusy(true);
        setProgress(change.progress);
        return;
      }
      setBusy(false);
      setProgress(null);
      if (change.result) {
        setResult(change.result);
        setError(null);
        setDone(null);
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

  const toggleRecording = async (picked: PickedFormat) => {
    const id = webContentsId();
    if (id === null || busy) return;
    setError(null);
    setDone(null);
    try {
      if (recording) {
        setBusy(true);
        setProgress(0);
        const response = await window.spark.capture.record({ webContentsId: id, tabId, workspaceId, action: "stop" });
        keyRef.current = response.key;
        setSince(null);
        if (response.result) setResult(response.result);
      } else {
        setResult(null);
        const response = await window.spark.capture.record({ webContentsId: id, tabId, workspaceId, action: "start", format: picked });
        keyRef.current = response.key;
        setSince(Date.now() - (response.status?.elapsedMs ?? 0));
        setNow(Date.now());
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const choose = (picked: PickedFormat) => {
    setFormat(picked);
    try {
      window.localStorage.setItem(FORMAT_KEY, picked);
    } catch {
      /* the choice just is not remembered */
    }
  };

  // Start takes the focus, so Enter records in the preselected format.
  useEffect(() => {
    if (!chooserOpen) return;
    const raf = window.requestAnimationFrame(() => startRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [chooserOpen]);

  useEffect(() => {
    if (tabId) setTabRecording(tabId, recording);
  }, [recording, tabId]);

  const fileAction = async (action: "save" | "copy") => {
    if (!result) return;
    setError(null);
    try {
      const response = await window.spark.capture.recordingFile({ path: result.path, action });
      if (action === "copy") setDone(response.copied === "file" ? "Copied" : "Copied path");
      else if (response.savedTo) setDone(`Saved to ${response.savedTo.split(/[\\/]/).pop()}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const fileName = result ? result.path.split(/[\\/]/).pop() : "";
  const current = FORMATS.find((entry) => entry.format === format) ?? FORMATS[0];
  const recordLabel = recording ? "Stop recording" : "Record this tab";
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        ref={recordRef}
        type="button"
        className={`bp-tool${recording ? " is-recording" : ""}`}
        data-testid="preview-record"
        data-format={format}
        title={recording ? "Stop recording and save the file" : `Record this tab as a video or a GIF (last: ${current.label})`}
        aria-label={recordLabel}
        aria-pressed={recording}
        aria-haspopup={recording || saving ? undefined : "dialog"}
        aria-expanded={recording || saving ? undefined : chooserOpen}
        disabled={!url || saving}
        onClick={() => {
          if (recording) void toggleRecording(format);
          else setChooserOpen((open) => !open);
        }}
      >
        <RecordIcon size={13} active={recording} />
        {recording ? (
          <>
            <span className="bp-tool__time">{formatElapsed(now - (since ?? now))}</span>
            <span className="bp-tool__label">Stop</span>
          </>
        ) : saving ? (
          <span className="bp-tool__time" data-testid="preview-record-progress" style={{ color: "var(--muted)" }}>
            {progress === null ? "saving" : `saving ${Math.round(progress * 100)}%`}
          </span>
        ) : (
          <span className="bp-tool__label">Record</span>
        )}
      </button>
      <AnchoredMenu
        zIndex={BROWSER_MENU_Z}
        anchorRef={recordRef}
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        className="spark-menu bp-menu"
        role="dialog"
        ariaLabel="Record this tab"
        placement="below"
        align="end"
      >
        <div className="bp-record" data-testid="preview-record-menu">
          <div
            className="spark-segmented"
            role="radiogroup"
            aria-label="Recording format"
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const index = FORMATS.findIndex((entry) => entry.format === format);
              const next = FORMATS[(index + (event.key === "ArrowRight" ? 1 : FORMATS.length - 1)) % FORMATS.length];
              choose(next.format);
              (event.currentTarget.querySelector(`[data-format="${next.format}"]`) as HTMLElement | null)?.focus();
            }}
          >
            {FORMATS.map((entry) => (
              <button
                key={entry.format}
                type="button"
                role="radio"
                data-format={entry.format}
                aria-checked={entry.format === format}
                tabIndex={entry.format === format ? 0 : -1}
                className={`spark-segmented-item${entry.format === format ? " is-selected" : ""}`}
                onClick={() => choose(entry.format)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="bp-record__hint">{current.hint}</div>
          <button
            ref={startRef}
            type="button"
            className="bp-record__start"
            data-testid="preview-record-start"
            onClick={() => {
              setChooserOpen(false);
              void toggleRecording(format);
            }}
          >
            <RecordIcon size={12} /> Start recording
          </button>
        </div>
      </AnchoredMenu>
      {result || error ? (
        <div
          className="spark-menu bp-menu spark-fade-in"
          role="status"
          data-testid="preview-record-result"
          style={{ position: "absolute", top: 30, right: -4, zIndex: 50, width: 300, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="spark-eyebrow" style={{ flex: 1, color: error && !result ? "var(--danger)" : undefined }}>
              {error && !result ? "Recording failed" : "Recording saved"}
            </span>
            <button
              type="button"
              className="spark-icon-btn"
              title="Dismiss"
              aria-label="Dismiss"
              onClick={() => {
                setResult(null);
                setError(null);
                setDone(null);
              }}
              style={{ ["--spark-icon-btn-size" as string]: "18px" }}
            >
              <CloseIcon size={11} />
            </button>
          </div>
          {result ? (
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
                <button type="button" className="spark-btn" onClick={() => void fileAction("save")}>
                  Save as
                </button>
                <button type="button" className="spark-btn" onClick={() => void fileAction("copy")}>
                  Copy
                </button>
                <button type="button" className="spark-btn" onClick={() => void window.spark.fs.revealInOS(result.path)}>
                  Show in folder
                </button>
              </div>
            </>
          ) : null}
          {done ? <div data-testid="preview-record-done" style={{ fontSize: 11, color: "var(--ink-dim)" }}>{done}</div> : null}
          {error ? <div style={{ fontSize: 12, color: error && result ? "var(--danger)" : "var(--ink-dim)", lineHeight: 1.4 }}>{error}</div> : null}
        </div>
      ) : null}
    </span>
  );
}
