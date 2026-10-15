import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isWorktreeSetupFinished, isWorktreeSetupStartError, type WorktreeSetupStatus } from "@shared/worktree-setup";
import { commandStateLabel, plural, setupName, setupStateLabel } from "./labels";
import { useModalDialog } from "./useModalDialog";
import "./worktree-setup.css";

// The log of one worktree setup: what was copied and linked, each command
// with its state, and the output as it arrives. Stop, Run again and Copy log
// act on it; Escape or Close closes it.

const POLL_MS = 600;
const KEEP_CHARS = 2_000_000;

export default function WorktreeSetupLogDialog({
  setupId,
  onClose,
}: {
  setupId: string;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const [id, setId] = useState(setupId);
  const [status, setStatus] = useState<WorktreeSetupStatus | null>(null);
  const [text, setText] = useState("");
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const offset = useRef(0);
  const startedAt = useRef<string | null>(null);
  const stickToBottom = useRef(true);

  useModalDialog(ref, onClose, { initialFocus: "button.is-primary" });

  useEffect(() => {
    let cancelled = false;
    offset.current = 0;
    setText("");
    void window.spark.worktreeSetup.get(id).then((next) => {
      if (cancelled) return;
      if (next) {
        startedAt.current ??= next.startedAt;
        setStatus(next);
      } else setMissing(true);
    });
    const off = window.spark.worktreeSetup.onChanged((next) => {
      if (next.id !== id) return;
      // Run again rewrites the log from the start.
      if (startedAt.current && startedAt.current !== next.startedAt) {
        offset.current = 0;
        setText("");
      }
      startedAt.current = next.startedAt;
      setStatus(next);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [id]);

  const finished = status ? isWorktreeSetupFinished(status.state) : false;

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const pull = async (): Promise<void> => {
      const chunk = await window.spark.worktreeSetup.readLog(id, offset.current).catch(() => null);
      if (cancelled || !chunk) return;
      if (chunk.text) {
        offset.current = chunk.next;
        setText((current) => {
          const joined = current + chunk.text;
          return joined.length > KEEP_CHARS ? joined.slice(joined.length - KEEP_CHARS) : joined;
        });
      }
      // Read on while there is more, or while setup still writes.
      if (chunk.truncated) timer = window.setTimeout(() => void pull(), 0);
      else if (!finished) timer = window.setTimeout(() => void pull(), POLL_MS);
    };
    void pull();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [id, finished]);

  useEffect(() => {
    const log = logRef.current;
    if (log && stickToBottom.current) log.scrollTop = log.scrollHeight;
  }, [text]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      const next = await window.spark.worktreeSetup.stop(id);
      if (next) setStatus(next);
    } finally {
      setBusy(false);
    }
  }, [id]);

  const rerun = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const reply = await window.spark.worktreeSetup.rerun(id);
      if (!reply) setNote("This repository has no worktree setup any more.");
      else if (isWorktreeSetupStartError(reply)) setNote(reply.error);
      else {
        startedAt.current = reply.startedAt;
        setStatus(reply);
        setText("");
        offset.current = 0;
        setId(reply.id);
      }
    } finally {
      setBusy(false);
    }
  }, [id]);

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setNote("Log copied."))
      .catch(() => setNote("Could not copy the log."));
  }, [text]);

  const name = status ? setupName(status) : "worktree";

  return createPortal(
    <div
      className="spark-scrim wts-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={`Worktree setup log for ${name}`}
        tabIndex={-1}
        className="spark-glass--strong spark-overlay-surface wts-dialog"
        data-testid="worktree-setup-log"
      >
        <div className="wts-dialog__head">
          <div className="wts-dialog__title">
            {status ? <span className="wts-mark" data-state={status.state} aria-hidden /> : null}
            <span style={{ flex: 1, minWidth: 0 }}>Worktree setup for {name}</span>
          </div>
          <div className="wts-dialog__sub" aria-live="polite">
            {missing ? "Codara has no setup record for this worktree." : status ? setupStateLabel(status) : "Loading…"}
          </div>
        </div>
        <div className="wts-dialog__body">
          {status ? (
            <ul className="wts-steps" aria-label="Steps">
              <li>
                <span className="wts-mark" data-state={status.state === "preparing" ? "running" : "succeeded"} aria-hidden />
                <span>
                  {status.state === "preparing"
                    ? "Copying files and linking folders"
                    : `${plural(status.copiedCount, "file", "files")} copied${
                        status.linked.length ? `, linked ${status.linked.join(", ")}` : ""
                      }`}
                </span>
                <span className="wts-steps__state">
                  {status.skipped.length ? `${status.skipped.length} skipped` : ""}
                </span>
              </li>
              {status.commands.map((command, index) => (
                <li key={`${command.kind}-${index}`} data-state={command.state}>
                  <span
                    className="wts-mark"
                    data-state={
                      command.state === "running"
                        ? "running"
                        : command.state === "succeeded"
                          ? "succeeded"
                          : command.state === "failed"
                            ? "failed"
                            : "stopped"
                    }
                    aria-hidden
                  />
                  <span style={{ minWidth: 0 }}>
                    <span>{command.kind === "repo" ? "Repository setup command" : "Your setup command"}</span>
                    <code title={command.command}>{command.command.split("\n").join(" && ")}</code>
                  </span>
                  <span className="wts-steps__state">{commandStateLabel(command, status)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {status?.commandsSkipped ? (
            <div className="wts-hint">Setup commands were turned off for this worktree.</div>
          ) : null}
          {status && (status.warnings.length > 0 || status.skipped.length > 0) ? (
            <details className="wts-details">
              <summary>
                {plural(status.warnings.length + status.skipped.length, "note", "notes")}
              </summary>
              <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
                {status.warnings.map((warning, index) => (
                  <div key={`w${index}`} className="wts-warning">
                    {warning}
                  </div>
                ))}
                {status.skipped.map((skip, index) => (
                  <div key={`s${index}`} className="wts-hint">
                    Skipped <code>{skip.path}</code>: {skip.reason}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          <pre
            ref={logRef}
            className="wts-log"
            tabIndex={0}
            aria-label="Setup output"
            data-testid="worktree-setup-log-text"
            onScroll={(event) => {
              const el = event.currentTarget;
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {text || (finished ? "No output." : "Waiting for output…")}
          </pre>
          {status ? (
            <div className="wts-hint" style={{ overflowWrap: "anywhere" }}>
              Log file: <code>{status.logPath}</code>
            </div>
          ) : null}
        </div>
        <div className="wts-dialog__foot">
          <span className="wts-dialog__foot-note" aria-live="polite">
            {note}
          </span>
          {status && !finished ? (
            <button type="button" className="spark-btn is-danger" disabled={busy} onClick={() => void stop()}>
              {status.state === "awaiting-approval" ? "Don't run" : "Stop"}
            </button>
          ) : null}
          {status && finished ? (
            <button type="button" className="spark-btn" disabled={busy} onClick={() => void rerun()}>
              Run again
            </button>
          ) : null}
          <button type="button" className="spark-btn" disabled={!text} onClick={copy}>
            Copy log
          </button>
          <button type="button" className="spark-btn is-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
