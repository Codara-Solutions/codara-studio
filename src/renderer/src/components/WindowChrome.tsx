import React, { useState } from "react";

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

interface Props {
  platform?: string;
  leftOn: boolean;
  rightOn: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenSettings?: () => void;
  onOpenPreferences?: () => void;
}

function SlidersIcon({ size = 12 }: { size?: number }) {
  // Three-row mixer slider — visually distinct from the cog so the new
  // preferences window has its own affordance.
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
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="2.2" fill="currentColor" />
      <circle cx="15" cy="12" r="2.2" fill="currentColor" />
      <circle cx="8" cy="18" r="2.2" fill="currentColor" />
    </svg>
  );
}

export default function WindowChrome({
  platform,
  leftOn,
  rightOn,
  onToggleLeft,
  onToggleRight,
  onOpenSettings,
  onOpenPreferences,
}: Props) {
  const [gearHover, setGearHover] = useState(false);
  const [prefsHover, setPrefsHover] = useState(false);
  const nativeControlsWidth = platform === "win32" ? 138 : 0;

  const handleToggleMaximize = () => {
    void window.spark.windowControls.toggleMaximize().catch(() => undefined);
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
          background: "color-mix(in oklch, var(--panel) 70%, var(--bg))",
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
            color: "var(--ink-dim)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0",
            lineHeight: 1,
          }}
        >
          Spark App
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <div
        style={{
          position: "absolute",
          right: nativeControlsWidth,
          top: 0,
          bottom: 0,
          display: "flex",
          alignItems: "stretch",
        }}
      >
        <PanelToggle on={rightOn} side="right" onClick={onToggleRight} title="Toggle right sidebar" edge="right" />
        {onOpenPreferences && (
          <button
            type="button"
            data-window-control
            title="Preferences"
            onClick={() => onOpenPreferences()}
            onMouseEnter={() => setPrefsHover(true)}
            onMouseLeave={() => setPrefsHover(false)}
            style={
              {
                appearance: "none",
                width: 30,
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: prefsHover ? "var(--hover)" : "transparent",
                border: "none",
                borderLeft: "1px solid var(--rule-soft)",
                color: prefsHover ? "var(--ink)" : "var(--ink-dim)",
                cursor: "default",
                padding: 0,
                WebkitAppRegion: "no-drag",
                transition:
                  "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
              } as AppRegionStyle
            }
          >
            <SlidersIcon size={12} />
          </button>
        )}
        <button
          type="button"
          data-window-control
          title="Connections & shells"
          onClick={() => onOpenSettings?.()}
          onMouseEnter={() => setGearHover(true)}
          onMouseLeave={() => setGearHover(false)}
          style={
            {
              appearance: "none",
              width: 30,
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: gearHover ? "var(--hover)" : "transparent",
              border: "none",
              borderLeft: "1px solid var(--rule-soft)",
              color: gearHover ? "var(--ink)" : "var(--ink-dim)",
              cursor: "default",
              padding: 0,
              WebkitAppRegion: "no-drag",
              transition:
                "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
            } as AppRegionStyle
          }
        >
          <GearIcon size={12} />
        </button>
      </div>
    </div>
  );
}
