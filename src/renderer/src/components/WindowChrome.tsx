import React from "react";

function GearIcon({ size = 15 }: { size?: number }) {
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
}

function PanelToggle({ on, side, onClick, title }: PanelToggleProps) {
  const fillColor = on ? "var(--accent)" : "currentColor";
  const fillOpacity = on ? 1 : 0.55;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        appearance: "none",
        width: 38,
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        borderRight: "1px solid var(--rule)",
        color: on ? "var(--ink)" : "var(--ink-dim)",
        cursor: "default",
        padding: 0,
      }}
    >
      <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
        <rect x="1.25" y="1.25" width="15.5" height="11.5" rx="2" stroke="currentColor" strokeWidth="1.1" />
        {side === "left" ? (
          <rect x="2.25" y="2.25" width="3.5" height="9.5" rx="1" fill={fillColor} fillOpacity={fillOpacity} />
        ) : (
          <rect
            x="12.25"
            y="2.25"
            width="3.5"
            height="9.5"
            rx="1"
            fill={fillColor}
            fillOpacity={fillOpacity}
          />
        )}
      </svg>
    </button>
  );
}

interface Props {
  leftOn: boolean;
  rightOn: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenSettings?: () => void;
}

export default function WindowChrome({
  leftOn,
  rightOn,
  onToggleLeft,
  onToggleRight,
  onOpenSettings,
}: Props) {
  return (
    <div
      style={{
        height: 36,
        display: "flex",
        alignItems: "stretch",
        borderBottom: "1px solid var(--rule)",
        background: "var(--bg)",
        flex: "0 0 auto",
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          borderRight: "1px solid var(--rule)",
          fontWeight: 800,
          letterSpacing: "0.04em",
        }}
      >
        <span style={{ display: "inline-block", width: 10, height: 10, background: "var(--accent)" }} />
        <span>SPARK&nbsp;APP</span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "stretch", borderLeft: "1px solid var(--rule)" }}>
        <PanelToggle on={leftOn} side="left" onClick={onToggleLeft} title="Toggle workspaces" />
        <PanelToggle on={rightOn} side="right" onClick={onToggleRight} title="Toggle right sidebar" />
        <button
          type="button"
          title="Settings"
          onClick={() => onOpenSettings?.()}
          style={{
            appearance: "none",
            width: 38,
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            borderLeft: "1px solid var(--rule)",
            color: "var(--ink-dim)",
            cursor: "default",
            padding: 0,
          }}
        >
          <GearIcon />
        </button>
      </div>
    </div>
  );
}
