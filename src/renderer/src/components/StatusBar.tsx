import React from "react";
import type { ShellInfo, Workspace } from "@shared/types";

interface Props {
  workspace: Workspace | null;
  defaultShell: ShellInfo | null;
  platform: string;
  workerCount: number;
}

// Memoized: App passes a memoized `workspace`, the `defaultShell`/`platform`
// state values, and a memoized `workerCount`. So the status bar only
// re-renders when one of those genuinely changes — not on every App re-render
// driven by unrelated state (run polls, color drags, orchestration events).
function StatusBar({ workspace, defaultShell, platform, workerCount }: Props) {
  const items = [
    { l: "WORKSPACE", v: workspace?.name ?? "—", mono: false },
    { l: "PATH", v: workspace?.cwd ?? "—", mono: true },
    { l: "SHELL", v: defaultShell?.label ?? "—", mono: true },
    { l: "OS", v: platform || "—", mono: true },
  ];
  const right = [
    { l: "WORKERS", v: String(workerCount).padStart(2, "0") },
  ];
  return (
    <div
      style={{
        flex: "0 0 auto",
        height: 24,
        background: "var(--chrome-status)",
        borderTop: "1px solid var(--rule)",
        boxShadow: "var(--lift-hi)",
        display: "flex",
        alignItems: "stretch",
        color: "var(--ink-dim)",
      }}
    >
      <div
        style={{
          width: 6,
          background: workspace?.color || "var(--accent)",
          // Soft inner highlight so the workspace-color chip reads as a
          // deliberate state marker, not a raw stripe. Token-mix keeps the
          // sheen legible on light themes.
          boxShadow: "inset 0 1px 0 color-mix(in oklch, var(--bg) 35%, transparent)",
          flex: "0 0 6px",
        }}
        title={workspace?.name ? `Workspace: ${workspace.name}` : "No workspace"}
      />
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            padding: "0 14px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderRight: "1px solid var(--rule-soft)",
            minWidth: 0,
          }}
        >
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontWeight: 600,
              fontSize: 9,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            {it.l}
          </span>
          <span
            style={{
              color: "var(--ink-dim)",
              fontSize: 10,
              fontFamily: it.mono ? "var(--font-mono)" : "inherit",
              fontWeight: it.mono ? 400 : 500,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 360,
            }}
            title={String(it.v)}
          >
            {it.v}
          </span>
        </div>
      ))}
      <div style={{ flex: 1 }} />
      {right.map((it, i) => (
        <div
          key={i}
          style={{
            padding: "0 14px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderLeft: "1px solid var(--rule-soft)",
          }}
        >
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontWeight: 600,
              fontSize: 9,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            {it.l}
          </span>
          <span
            style={{
              color: "var(--ink-dim)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {it.v}
          </span>
        </div>
      ))}
    </div>
  );
}

export default React.memo(StatusBar);
