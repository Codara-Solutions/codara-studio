// The Ports list of a remote (SSH) workspace: a chip in the status bar and
// the popover it opens, plus the small notice that offers to open a port
// Codara forwarded on its own. Main owns the forwards
// (src/main/remote/port-forwarding.ts); this only reads window.spark.ports.
// Forwards belong to the workspace's host, so two workspaces on one machine
// show the same list. The chip and the popover share the status chip's look
// (status.css); only the popover and the notice, floating layers, are glass.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ForwardedPort, PortForwardNotice, PortsSnapshot } from "@shared/port-forwarding";
import { isRemotePath, parseRemotePath } from "@shared/remote";
import type { Workspace } from "@shared/types";

import "../status/status.css";
import "./ports.css";

const NOTICE_MS = 10_000;
const MAX_NOTICES = 3;

const SOURCE_TEXT: Record<ForwardedPort["source"], string> = {
  terminal: "found in terminal output",
  listening: "started listening",
  agent: "opened by an agent",
  manual: "added by you",
};

function openUrl(url: string): void {
  window.dispatchEvent(new CustomEvent("spark:open-browser-url", { detail: { url } }));
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

function forwardTone(forward: ForwardedPort): "ok" | "warn" | "danger" {
  if (forward.state === "active") return "ok";
  return forward.state === "failed" ? "danger" : "warn";
}

function ForwardRow({
  forward,
  busy,
  onStop,
}: {
  forward: ForwardedPort;
  busy: boolean;
  onStop: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = forward.localUrl;
  const detail = [forward.command ?? forward.process, SOURCE_TEXT[forward.source]].filter(Boolean).join(" · ");
  return (
    <li className="status-pop__item">
      <div className="status-pop__line">
        <span className={`status-pop__dot is-${forwardTone(forward)}`} aria-hidden />
        <span className="status-pop__name status-pop__mono">{forward.remotePort}</span>
        <span className="status-pop__meta status-pop__mono">
          {forward.state === "active" && forward.localPort
            ? `localhost:${forward.localPort}`
            : forward.state === "waiting"
              ? "waiting for the connection"
              : "not forwarded"}
        </span>
      </div>
      <div className="status-pop__sub" title={forward.command ?? forward.process ?? undefined}>
        {detail}
      </div>
      {forward.error ? <div className="status-pop__note is-danger">{forward.error}</div> : null}
      <div className="status-pop__row-actions">
        <button
          type="button"
          className="status-pop__action is-primary"
          disabled={!url}
          onClick={() => url && openUrl(url)}
        >
          Open
        </button>
        <button
          type="button"
          className="status-pop__action"
          disabled={!url}
          title={url ?? undefined}
          onClick={() => {
            if (!url) return;
            void copyText(url).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_200);
            });
          }}
        >
          {copied ? "Copied" : "Copy URL"}
        </button>
        <button type="button" className="status-pop__action" disabled={busy} onClick={onStop}>
          Stop forwarding
        </button>
      </div>
    </li>
  );
}

function PortsPopover({
  workspaceId,
  hostId,
  snapshot,
  onClose,
  onSnapshot,
}: {
  workspaceId: string;
  hostId: string;
  snapshot: PortsSnapshot | null;
  onClose: () => void;
  onSnapshot: (next: PortsSnapshot | null) => void;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState<number | "add" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  const run = (key: number | "add" | "connect", action: () => Promise<PortsSnapshot | null | void>) => {
    setBusy(key);
    setError(null);
    void action()
      .then((next) => {
        if (next !== undefined) onSnapshot(next);
      })
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setBusy(null));
  };

  const forward = (value: number) => run(value, () => window.spark.ports.forward(workspaceId, value));

  const forwards = snapshot?.forwards ?? [];
  const available = snapshot?.available ?? [];
  const connected = snapshot?.connected === true;

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={`Ports on ${hostId}`}
      tabIndex={-1}
      className="status-pop ports-pop spark-glass--strong spark-overlay-surface"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="status-pop__head">
        <strong>Ports</strong>
        <span>on {hostId}, opened here on localhost</span>
      </header>
      <div className="status-pop__body">
        {!connected ? (
          <section className="status-pop__section">
            <p className="status-pop__empty">
              Not connected to {hostId}. Forwarded ports come back when it reconnects.
            </p>
            <div className="status-pop__row-actions ports-pop__flush">
              <button
                type="button"
                className="status-pop__action"
                disabled={busy !== null}
                onClick={() =>
                  run("connect", async () => {
                    await window.spark.remote.connect(hostId);
                    return window.spark.ports.snapshot(workspaceId);
                  })
                }
              >
                {busy === "connect" ? "Connecting" : "Reconnect"}
              </button>
            </div>
          </section>
        ) : null}

        <section className="status-pop__section">
          <h3>
            Forwarded <span className="status-pop__count">{forwards.length}</span>
          </h3>
          {forwards.length === 0 ? (
            <p className="status-pop__empty">
              Nothing yet. A dev server started in a terminal of this workspace is forwarded once it prints its
              URL or starts listening.
            </p>
          ) : (
            <ul className="status-pop__list">
              {forwards.map((item) => (
                <ForwardRow
                  key={item.remotePort}
                  forward={item}
                  busy={busy === item.remotePort}
                  onStop={() => run(item.remotePort, () => window.spark.ports.stop(workspaceId, item.remotePort))}
                />
              ))}
            </ul>
          )}
        </section>

        {available.length > 0 ? (
          <section className="status-pop__section">
            <h3>
              Listening on {hostId} <span className="status-pop__count">{available.length}</span>
            </h3>
            <ul className="status-pop__list">
              {available.map((entry) => (
                <li key={entry.port} className="status-pop__item ports-pop__available">
                  <div className="status-pop__line">
                    <span className="status-pop__dot" aria-hidden />
                    <span className="status-pop__name status-pop__mono">{entry.port}</span>
                    <span className="status-pop__meta">
                      {entry.process ? (entry.pid ? `${entry.process} (${entry.pid})` : entry.process) : entry.addresses.join(", ")}
                    </span>
                    <button
                      type="button"
                      className="status-pop__action"
                      disabled={busy !== null}
                      onClick={() => forward(entry.port)}
                    >
                      Forward
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="status-pop__section">
          <h3>Forward a port</h3>
          <form
            className="ports-pop__form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(port.trim());
              if (!Number.isInteger(value) || value < 1 || value > 65_535) {
                setError("Enter a port number from 1 to 65535.");
                return;
              }
              run("add", async () => {
                const next = await window.spark.ports.forward(workspaceId, value);
                setPort("");
                return next;
              });
            }}
          >
            <input
              className="ports-pop__input"
              inputMode="numeric"
              placeholder="Port on the host, such as 8000"
              aria-label="Port on the host"
              value={port}
              onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
            />
            <button type="submit" className="status-pop__action is-primary" disabled={busy !== null || !port}>
              Forward
            </button>
          </form>
          {error ? <p className="status-pop__note is-danger ports-pop__flush">{error}</p> : null}
          {snapshot?.listing === "none" ? (
            <p className="status-pop__note ports-pop__flush">
              This host has no ss, netstat or lsof, so only servers that print their URL in a terminal are found.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function PortNotices({
  notices,
  hostId,
  onDismiss,
  onHold,
}: {
  notices: PortForwardNotice[];
  hostId: string | null;
  onDismiss: (notice: PortForwardNotice) => void;
  onHold: (held: boolean) => void;
}) {
  if (notices.length === 0) return null;
  return createPortal(
    <div
      className="ports-notices"
      aria-live="polite"
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
    >
      {notices.map((notice) => {
        const elsewhere = notice.hostId !== hostId ? ` on ${notice.hostId}` : "";
        const moved = notice.localPort !== notice.remotePort ? ` It opens here on localhost:${notice.localPort}.` : "";
        return (
          <div
            key={`${notice.hostId}:${notice.remotePort}`}
            role="status"
            className="ports-notice spark-fade-in spark-glass--strong spark-overlay-surface"
          >
            <p className="ports-notice__text">
              Port {notice.remotePort}
              {elsewhere} is forwarded.{moved}
            </p>
            <button
              type="button"
              className="status-pop__action is-primary"
              onClick={() => {
                openUrl(notice.url);
                onDismiss(notice);
              }}
            >
              Open in browser
            </button>
            <button
              type="button"
              className="ports-notice__close"
              aria-label={`Dismiss the notice for port ${notice.remotePort}`}
              onClick={() => onDismiss(notice)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

export default function PortsChip({ workspace }: { workspace: Workspace | null }) {
  const remote = isRemotePath(workspace?.cwd);
  const workspaceId = remote && workspace ? workspace.id : null;
  const hostId = remote && workspace ? (parseRemotePath(workspace.cwd)?.hostId ?? null) : null;
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<PortsSnapshot | null>(null);
  const [notices, setNotices] = useState<Array<PortForwardNotice & { at: number }>>([]);
  const [held, setHeld] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    if (!workspaceId) {
      setSnapshot(null);
      return;
    }
    void window.spark.ports
      .snapshot(workspaceId)
      .then((next) => {
        if (!next || next.hostId === hostId) setSnapshot(next);
      })
      .catch(() => undefined);
  }, [workspaceId, hostId]);

  useEffect(() => {
    refresh();
    if (!hostId) return;
    return window.spark.ports.onChanged((payload) => {
      if (payload.hostId === hostId) refresh();
    });
  }, [refresh, hostId]);

  useEffect(
    () =>
      window.spark.ports.onNotice((notice) => {
        setNotices((current) =>
          [
            ...current.filter((item) => item.hostId !== notice.hostId || item.remotePort !== notice.remotePort),
            { ...notice, at: Date.now() },
          ].slice(-MAX_NOTICES),
        );
      }),
    [],
  );

  // Each notice leaves on its own clock; hovering the stack holds them all.
  useEffect(() => {
    if (held || notices.length === 0) return;
    const oldest = Math.min(...notices.map((notice) => notice.at));
    const timer = window.setTimeout(
      () => setNotices((current) => current.filter((notice) => Date.now() - notice.at < NOTICE_MS)),
      Math.max(0, oldest + NOTICE_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [notices, held]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (!remote) setOpen(false);
  }, [remote]);

  const forwards = snapshot?.forwards ?? [];
  const active = forwards.filter((item) => item.state === "active").length;
  const tone = forwards.some((item) => item.state === "failed")
    ? "danger"
    : forwards.some((item) => item.state === "waiting")
      ? "warn"
      : active > 0
        ? "ok"
        : "muted";
  const summary =
    forwards.length === 0
      ? "none"
      : forwards
          .slice(0, 3)
          .map((item) => item.remotePort)
          .join(" ") + (forwards.length > 3 ? ` +${forwards.length - 3}` : "");

  return (
    <>
      {workspaceId && hostId ? (
        <div ref={root} className="status-chip-wrap">
          <button
            type="button"
            className={`status-chip${open ? " is-open" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`Forwarded ports: ${summary}`}
            title={`Ports of ${hostId} forwarded to this computer`}
            onClick={() => {
              setOpen((value) => !value);
              refresh();
            }}
          >
            <span className={`status-pop__dot is-${tone}`} aria-hidden />
            <span className="status-chip__label">PORTS</span>
            <span className="status-chip__value">{summary}</span>
          </button>
          {open ? (
            <PortsPopover
              workspaceId={workspaceId}
              hostId={hostId}
              snapshot={snapshot}
              onClose={() => setOpen(false)}
              onSnapshot={(next) => {
                if (!next || next.hostId === hostId) setSnapshot(next);
              }}
            />
          ) : null}
        </div>
      ) : null}
      <PortNotices
        notices={notices}
        hostId={hostId}
        onHold={(value) => {
          setHeld(value);
          // Leaving the stack gives every notice a fresh window to be read.
          if (!value) setNotices((current) => current.map((notice) => ({ ...notice, at: Date.now() })));
        }}
        onDismiss={(notice) =>
          setNotices((current) =>
            current.filter((item) => item.hostId !== notice.hostId || item.remotePort !== notice.remotePort),
          )
        }
      />
    </>
  );
}
