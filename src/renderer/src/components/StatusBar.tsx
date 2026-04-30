import React from "react";
import type { ShellInfo, Workspace } from "@shared/types";

interface Props {
  workspace: Workspace | null;
  defaultShell: ShellInfo | null;
  platform: string;
}

export default function StatusBar({ workspace, defaultShell, platform }: Props) {
  const items = [
    { l: "WORKSPACE", v: workspace?.name ?? "—", mono: false },
    { l: "PATH", v: workspace?.cwd ?? "—", mono: true },
    { l: "SHELL", v: defaultShell?.label ?? "—", mono: true },
    { l: "OS", v: platform || "—", mono: true },
  ];
  const right = [
    { l: "WORKERS", v: String((workspace?.workers.length ?? 0)).padStart(2, "0") },
  ];
  return (
    <div
      style={{
        flex: "0 0 auto",
        height: 24,
        background: "var(--bg)",
        borderTop: "1px solid var(--rule)",
        display: "flex",
        alignItems: "stretch",
        color: "var(--ink-dim)",
      }}
    >
      <div style={{ width: 6, background: workspace?.color || "var(--accent)", flex: "0 0 6px" }} />
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
              fontWeight: 600,
              fontSize: 9,
              letterSpacing: "0.12em",
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
              fontWeight: 600,
              fontSize: 9,
              letterSpacing: "0.12em",
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
