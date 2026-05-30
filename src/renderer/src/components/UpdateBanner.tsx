import React, { useEffect, useState } from "react";

// Mirrors the contract emitted from src/main/auto-updater.ts and re-exported
// by the preload. Kept inline here so the renderer's compilation unit does
// not need to import from src/preload (which isn't in tsconfig.web.json's
// include set).
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

// Banner states roughly mirror the lifecycle order. `idle` is the resting
// state — banner doesn't render at all. `not-available` is also rendered
// as `idle` so the user doesn't see a banner just to be told there are no
// updates.
type BannerState =
  | { kind: "idle" }
  | { kind: "available"; version: string }
  | { kind: "progress"; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

interface UpdateAvailablePayload {
  version?: unknown;
}
interface DownloadProgressPayload {
  percent?: unknown;
}
interface UpdateDownloadedPayload {
  version?: unknown;
}
interface ErrorPayload {
  message?: unknown;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function reduceEvent(state: BannerState, event: UpdaterEvent): BannerState {
  switch (event.kind) {
    case "update-available": {
      const payload = event.payload as UpdateAvailablePayload | undefined;
      return { kind: "available", version: asString(payload?.version, "(unknown)") };
    }
    case "download-progress": {
      const payload = event.payload as DownloadProgressPayload | undefined;
      const percent = Math.max(0, Math.min(100, asNumber(payload?.percent, 0)));
      return { kind: "progress", percent };
    }
    case "update-downloaded": {
      const payload = event.payload as UpdateDownloadedPayload | undefined;
      return { kind: "ready", version: asString(payload?.version, "(unknown)") };
    }
    case "error": {
      const payload = event.payload as ErrorPayload | undefined;
      const message = asString(payload?.message, "Unknown error");
      return { kind: "error", message };
    }
    case "checking-for-update":
    case "update-not-available":
      // Keep the existing state — a "no update" result while a banner is
      // showing shouldn't blow it away. The renderer only ever escalates
      // to a banner via the events above.
      return state;
  }
}

// Sits as a sticky bar at the top of the app shell. Stays out of the way
// when there's nothing to report. Width spans the viewport so it's visible
// regardless of which workspace panel is open.
export default function UpdateBanner() {
  const [state, setState] = useState<BannerState>({ kind: "idle" });

  useEffect(() => {
    if (!window.spark?.updater) return undefined;
    const off = window.spark.updater.onEvent((event) => {
      setState((current) => reduceEvent(current, event));
    });
    return off;
  }, []);

  if (state.kind === "idle") return null;

  const handleDismiss = () => setState({ kind: "idle" });
  const handleInstall = () => {
    void window.spark.updater.quitAndInstall().catch(() => {
      /* main-side error already surfaces as an error event; nothing to do */
    });
  };

  let content: React.ReactNode = null;
  if (state.kind === "available") {
    content = (
      <span>
        Update v{state.version} available — downloading…
      </span>
    );
  } else if (state.kind === "progress") {
    content = (
      <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
        <span style={{ whiteSpace: "nowrap" }}>
          Downloading update… {state.percent.toFixed(0)}%
        </span>
        <div
          style={{
            flex: 1,
            height: 4,
            background: "var(--rule-soft)",
            boxShadow: "var(--well)",
            borderRadius: 999,
            overflow: "hidden",
            maxWidth: 220,
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
      </div>
    );
  } else if (state.kind === "ready") {
    content = (
      <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
        <span>Update v{state.version} ready.</span>
        <button
          type="button"
          onClick={handleInstall}
          style={{
            appearance: "none",
            background: "var(--accent)",
            color: "var(--accent-ink)",
            border: "none",
            boxShadow: "var(--lift-hi)",
            padding: "4px 12px",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.02em",
            borderRadius: 5,
            cursor: "default",
            transition: "background var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "color-mix(in oklch, var(--accent) 88%, var(--ink))";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--accent)";
          }}
        >
          Restart and install
        </button>
      </div>
    );
  } else if (state.kind === "error") {
    content = <span>Updater error: {state.message}</span>;
  }

  // The dismiss button is rendered for every state except `progress` (mid-
  // download), since dismissing a progress banner doesn't actually cancel
  // the download. For `ready` the user dismissing means "I'll restart
  // myself later" — the autoInstallOnAppQuit setting handles that path.
  const showDismiss = state.kind !== "progress";

  // Stays in the renderer's normal flow above WindowChrome's z-stack but
  // below modals/dialogs. Position fixed keeps it visible no matter how the
  // app scrolls; full width keeps it noticeable.
  return (
    <div
      className="spark-fade-in"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        background: state.kind === "error" ? "var(--danger-soft)" : "var(--accent-soft)",
        color: "var(--ink)",
        borderBottom: "1px solid var(--rule-strong)",
        boxShadow: "var(--lift-hi)",
        padding: "6px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12 }}>
        {content}
      </div>
      {showDismiss && (
        <button
          type="button"
          onClick={handleDismiss}
          style={{
            appearance: "none",
            background: "transparent",
            color: "var(--ink-dim)",
            border: "1px solid var(--rule-strong)",
            padding: "3px 10px",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            letterSpacing: "0.02em",
            borderRadius: 5,
            cursor: "default",
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--hover)";
            e.currentTarget.style.color = "var(--ink)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--ink-dim)";
          }}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
