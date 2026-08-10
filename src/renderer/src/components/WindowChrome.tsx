import React, { useEffect, useState } from "react";
import type { ResolvedRunQuestion } from "@shared/types";
import NotificationCenter from "../notifications/NotificationCenter";
import UsageMeters from "./UsageMeters";
import type { NavigateTo } from "../notifications/routing";

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: "drag" | "no-drag";
};

function GearIcon({ size = 14 }: { size?: number }) {
  // Classic 8-tooth cog with a center hub. Strokes only — matches the chrome's
  // monoline aesthetic. Generated, not lifted, so it stays visually consistent
  // with the other window-chrome glyphs.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// Window control glyphs match the Windows 11 convention — single-stroke,
// 10px, centered in a 30×30 button. The maximize/restore glyph swaps
// between a single rounded rect and two overlapping rects when the window
// is maximized so the affordance reads as "restore" at a glance.
function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <line x1="0.5" y1="5" x2="9.5" y2="5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <rect x="0.5" y="2.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1" />
      <path d="M2.5 2.5V0.5H9.5V7.5H7.5" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
      <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

interface PanelToggleProps {
  on: boolean;
  side: "left" | "right";
  onClick: () => void;
  title: string;
  edge?: "left" | "right";
}

function PanelToggle({ on, side, onClick, title, edge }: PanelToggleProps) {
  const fillColor = on ? "var(--accent)" : "currentColor";
  const fillOpacity = on ? 1 : 0.55;
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-window-control
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={
        {
          appearance: "none",
          width: 30,
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: hover ? "var(--hover)" : "transparent",
          border: "none",
          borderLeft: edge === "right" ? "1px solid var(--rule-soft)" : "none",
          borderRight: edge === "left" ? "1px solid var(--rule-soft)" : "none",
          color: on ? "var(--ink)" : "var(--ink-dim)",
          cursor: "default",
          padding: 0,
          WebkitAppRegion: "no-drag",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        } as AppRegionStyle
      }
    >
      <svg width="15" height="12" viewBox="0 0 18 14" fill="none">
        <rect x="1.5" y="1.5" width="15" height="11" rx="2" stroke="currentColor" strokeWidth="1" />
        {side === "left" ? (
          <rect x="2.75" y="2.75" width="3.2" height="8.5" rx="0.8" fill={fillColor} fillOpacity={fillOpacity} />
        ) : (
          <rect
            x="12.05"
            y="2.75"
            width="3.2"
            height="8.5"
            rx="0.8"
            fill={fillColor}
            fillOpacity={fillOpacity}
          />
        )}
      </svg>
    </button>
  );
}

// Generic chrome button used by the gear and the three window controls.
// `danger` reddens the hover background (used for Close to match the
// Windows 11 affordance).
function ChromeButton({
  title,
  onClick,
  danger,
  children,
  borderLeft,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
  borderLeft?: boolean;
}) {
  const [hover, setHover] = useState(false);
  // Close uses the Windows 11 red affordance; express it via the --danger
  // token (color-mixed darker for a solid hover plate) and place the ink on
  // it as a token mix so the glyph stays legible across the light themes too.
  const hoverBg = danger ? "color-mix(in oklch, var(--danger) 78%, var(--bg))" : "var(--hover)";
  const hoverFg = danger ? "color-mix(in oklab, var(--bg) 92%, var(--danger))" : "var(--ink)";
  return (
    <button
      type="button"
      data-window-control
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={
        {
          appearance: "none",
          width: 30,
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: hover ? hoverBg : "transparent",
          border: "none",
          borderLeft: borderLeft ? "1px solid var(--rule-soft)" : "none",
          color: hover ? hoverFg : "var(--ink-dim)",
          cursor: "default",
          padding: 0,
          WebkitAppRegion: "no-drag",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        } as AppRegionStyle
      }
    >
      {children}
    </button>
  );
}

interface Props {
  platform?: string;
  leftOn: boolean;
  rightOn: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenSettings?: () => void;
  // Opens the Usage tab from the meter cluster. Optional so the chrome renders
  // unchanged anywhere the tab surface is not wired up.
  onOpenUsage?: () => void;
  // Notification-center wiring (bell + popover in the right-side controls).
  notifyNavigateTo?: NavigateTo;
  notifyResolveQuestion?: (runId: string) => ResolvedRunQuestion | null;
}

// Memoized: App passes the `platform` state value, the two visibility
// booleans, and hoisted stable callbacks. So the title-bar chrome only
// re-renders when a panel is toggled — not on every unrelated App re-render.
function WindowChrome({
  platform,
  leftOn,
  rightOn,
  onToggleLeft,
  onToggleRight,
  onOpenSettings,
  onOpenUsage,
  notifyNavigateTo,
  notifyResolveQuestion,
}: Props) {
  const isWin = platform === "win32";
  const [maximized, setMaximized] = useState(false);

  // Custom min/max/close are only rendered on Windows; macOS still uses
  // native traffic lights at the top-left. Track maximized state so the
  // middle button can swap between maximize / restore glyphs.
  useEffect(() => {
    if (!isWin) return;
    let alive = true;
    void window.spark.windowControls
      .isMaximized()
      .then((v) => {
        if (alive) setMaximized(v);
      })
      .catch(() => undefined);
    const off = window.spark.windowControls.onStateChanged((state) => {
      setMaximized(state.maximized);
    });
    return () => {
      alive = false;
      off();
    };
  }, [isWin]);

  const handleMinimize = () => {
    void window.spark.windowControls.minimize().catch(() => undefined);
  };

  const handleToggleMaximize = () => {
    void window.spark.windowControls.toggleMaximize().catch(() => undefined);
  };

  const handleClose = () => {
    void window.spark.windowControls.close().catch(() => undefined);
  };

  const handleChromeDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-window-control]")) return;
    handleToggleMaximize();
  };

  return (
    <div
      onDoubleClick={handleChromeDoubleClick}
      style={
        {
          height: 30,
          display: "flex",
          alignItems: "stretch",
          borderBottom: "1px solid var(--rule)",
          background: "color-mix(in oklab, var(--panel) 70%, var(--bg))",
          boxShadow: "var(--lift-hi)",
          flex: "0 0 auto",
          userSelect: "none",
          position: "relative",
          WebkitAppRegion: "drag",
        } as AppRegionStyle
      }
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          display: "flex",
          alignItems: "stretch",
        }}
      >
        <PanelToggle on={leftOn} side="left" onClick={onToggleLeft} title="Toggle workspaces" edge="left" />
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            color: "var(--muted)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            lineHeight: 1,
          }}
        >
          Codara Studio
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          display: "flex",
          alignItems: "stretch",
        }}
      >
        <UsageMeters onOpenUsage={onOpenUsage} />
        <PanelToggle on={rightOn} side="right" onClick={onToggleRight} title="Toggle right sidebar" edge="right" />
        <NotificationCenter
          navigateTo={notifyNavigateTo}
          resolveQuestion={notifyResolveQuestion}
        />
        <ChromeButton title="Settings" onClick={() => onOpenSettings?.()} borderLeft>
          <GearIcon size={12} />
        </ChromeButton>
        {isWin && (
          <>
            <ChromeButton title="Minimize" onClick={handleMinimize} borderLeft>
              <MinimizeIcon />
            </ChromeButton>
            <ChromeButton
              title={maximized ? "Restore" : "Maximize"}
              onClick={handleToggleMaximize}
            >
              {maximized ? <RestoreIcon /> : <MaximizeIcon />}
            </ChromeButton>
            <ChromeButton title="Close" onClick={handleClose} danger>
              <CloseIcon />
            </ChromeButton>
          </>
        )}
      </div>
    </div>
  );
}

export default React.memo(WindowChrome);
