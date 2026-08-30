import React, { useEffect, useState } from "react";

// Compact update control for the window chrome: invisible until an update
// exists, then a download glyph that carries the whole story — a progress
// ring while the update downloads in the background, an accent badge once it
// is ready. One click on the ready state restarts the app into the new
// version (install is silent; the app relaunches itself), so keeping Codara
// fresh is a single reflex, not a workflow.
//
// Mirrors the updater contract emitted from src/main/auto-updater.ts. Kept
// inline so the renderer's compilation unit does not import from src/preload
// (not in tsconfig.web.json's include set).

type UpdaterEventKind =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

interface UpdaterEvent {
  kind: UpdaterEventKind;
  payload?: unknown;
}

type ChipState =
  | { kind: "idle" }
  | {
      kind: "downloading";
      percent: number;
      version: string;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function reduceEvent(state: ChipState, event: UpdaterEvent): ChipState {
  switch (event.kind) {
    case "update-available": {
      const p = event.payload as { version?: unknown } | undefined;
      return {
        kind: "downloading",
        percent: 0,
        version: asString(p?.version, "?"),
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
      };
    }
    case "download-progress": {
      const p = event.payload as
        | { percent?: unknown; transferred?: unknown; total?: unknown; bytesPerSecond?: unknown }
        | undefined;
      const version = state.kind === "downloading" ? state.version : "?";
      return {
        kind: "downloading",
        percent: Math.max(0, Math.min(100, asNumber(p?.percent, 0))),
        version,
        transferred: asNumber(p?.transferred, 0),
        total: asNumber(p?.total, 0),
        bytesPerSecond: asNumber(p?.bytesPerSecond, 0),
      };
    }
    case "update-downloaded": {
      const p = event.payload as { version?: unknown } | undefined;
      return { kind: "ready", version: asString(p?.version, "?") };
    }
    case "error": {
      const p = event.payload as { message?: unknown } | undefined;
      return { kind: "error", message: asString(p?.message, "Unknown error") };
    }
    case "checking-for-update":
    case "update-not-available":
      return state;
  }
}

function DownloadGlyph({ color }: { color: string }): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden focusable="false">
      <path
        d="M7 1.5v7M4.2 6l2.8 2.9L9.8 6M2.2 11.5h9.6"
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function fmtMB(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

export default function UpdateChip(): React.ReactElement | null {
  const [state, setState] = useState<ChipState>({ kind: "idle" });
  const [hover, setHover] = useState(false);
  // Details popover, toggled by clicking the chip while the download runs.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const close = (): void => setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (!window.spark?.updater) return undefined;
    const off = window.spark.updater.onEvent((event) => {
      setState((current) => reduceEvent(current, event));
    });
    return off;
  }, []);

  if (state.kind === "idle") return null;

  const ready = state.kind === "ready";
  const error = state.kind === "error";
  const title = ready
    ? `Update v${state.version} ready — click to restart into it`
    : error
      ? `Updater error: ${state.message}`
      : `Downloading update v${state.version}… ${state.percent.toFixed(0)}%`;
  const tone = error ? "var(--danger)" : "var(--accent)";

  const install = (): void => {
    // Silent install + relaunch: the app quits, the update applies, and the
    // new version opens itself. Nothing else for the user to do.
    void window.spark.updater.quitAndInstall().catch(() => {
      /* a main-side failure comes back as an updater error event */
    });
  };
  const handleClick = (): void => {
    if (ready) {
      install();
      return;
    }
    // Mid-download (or error): the click opens the details popover instead.
    setOpen((v) => !v);
  };

  return (
    <>
    <button
      type="button"
      data-window-control
      title={title}
      aria-label={title}
      onClick={handleClick}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={
        {
          appearance: "none",
          position: "relative",
          width: 34,
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: hover && ready ? "var(--hover)" : "transparent",
          border: "none",
          borderLeft: "1px solid var(--rule-soft)",
          padding: 0,
          cursor: "default",
          WebkitAppRegion: "no-drag",
          transition: "background var(--motion-fast) var(--ease-out)",
        } as React.CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" }
      }
    >
      {/* Progress ring while downloading; steady glyph once ready. */}
      <span
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          borderRadius: 999,
          background:
            state.kind === "downloading"
              ? `conic-gradient(${tone} ${state.percent * 3.6}deg, var(--rule-soft) 0deg)`
              : "transparent",
          WebkitMask:
            state.kind === "downloading"
              ? "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))"
              : undefined,
          mask:
            state.kind === "downloading"
              ? "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))"
              : undefined,
        }}
        aria-hidden
      />
      <span
        style={{
          position: "absolute",
          display: "inline-flex",
          filter: ready ? `drop-shadow(0 0 4px color-mix(in oklch, ${tone} 60%, transparent))` : undefined,
        }}
        aria-hidden
      >
        <DownloadGlyph color={state.kind === "downloading" ? "var(--ink-dim)" : tone} />
      </span>
      {/* Notification badge: the "something is waiting for you" dot. */}
      {(ready || error) && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: "50%",
            right: 4,
            marginTop: -11,
            width: 7,
            height: 7,
            borderRadius: 999,
            background: tone,
            boxShadow: `0 0 6px color-mix(in oklch, ${tone} 60%, transparent)`,
          }}
        />
      )}
    </button>
    {/* Details popover: anchored above the status bar's bottom-right corner. */}
    {open && (
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="spark-fade-in"
        style={{
          position: "fixed",
          right: 8,
          bottom: 30,
          zIndex: 900,
          width: 260,
          padding: "10px 12px",
          borderRadius: "var(--radius-surface)",
          border: "1px solid var(--rule)",
          background: "var(--panel)",
          boxShadow: "var(--shadow-1)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          fontFamily: "var(--font-sans)",
          fontSize: 11.5,
          color: "var(--ink)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <DownloadGlyph color={tone} />
          <span style={{ fontWeight: 600 }}>
            {state.kind === "error" ? "Update problem" : `Codara Studio v${state.version}`}
          </span>
        </div>
        {state.kind === "downloading" && (
          <>
            <div
              style={{
                height: 4,
                borderRadius: 999,
                background: "var(--rule-soft)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${state.percent}%`,
                  height: "100%",
                  background: "var(--accent)",
                  borderRadius: 999,
                  transition: "width var(--motion-fast) var(--ease-out)",
                }}
              />
            </div>
            <div
              className="spark-mono spark-num"
              style={{ fontSize: 10, color: "var(--muted)", display: "flex", gap: 10 }}
            >
              <span>{state.percent.toFixed(0)}%</span>
              {state.total > 0 && (
                <span>
                  {fmtMB(state.transferred)} / {fmtMB(state.total)} MB
                </span>
              )}
              {state.bytesPerSecond > 0 && <span>{fmtMB(state.bytesPerSecond)} MB/s</span>}
            </div>
            <span style={{ fontSize: 10.5, color: "var(--muted-2)" }}>
              Downloading in the background. You can keep working; the chip
              lights up when it is ready to install.
            </span>
          </>
        )}
        {ready && (
          <>
            <span style={{ fontSize: 10.5, color: "var(--muted)" }}>
              Downloaded and ready. Installing restarts the app; it reopens by
              itself on the new version.
            </span>
            <button
              type="button"
              className="spark-btn is-primary"
              style={{ height: 24, fontSize: 11, alignSelf: "flex-start" }}
              onClick={install}
            >
              Restart and install
            </button>
          </>
        )}
        {error && (
          <span style={{ fontSize: 10.5, color: "var(--danger)", whiteSpace: "pre-wrap" }}>
            {state.kind === "error" ? state.message : ""}
          </span>
        )}
      </div>
    )}
    </>
  );
}
