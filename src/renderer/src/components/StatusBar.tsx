import React from "react";
import type { ShellInfo, Workspace } from "@shared/types";

interface Props {
  workspace: Workspace | null;
  defaultShell: ShellInfo | null;
  platform: string;
}

export default function StatusBar({ workspace, defaultShell, platform }: Props) {
  const items = [
    { l: "WORKSPACE", v: workspace?.name ?? "—" },
    { l: "PATH", v: workspace?.cwd ?? "—" },
    { l: "SHELL", v: defaultShell?.label ?? "—" },
    { l: "OS", v: platform || "—" },
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
        fontSize: 10,
        letterSpacing: "0.06em",
        color: "var(--ink-dim)",
      }}
    >
      <div style={{ width: 8, background: workspace?.color || "var(--accent)", flex: "0 0 8px" }} />
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            padding: "0 12px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            borderRight: "1px solid var(--rule)",
            minWidth: 0,
          }}
        >
          <span style={{ color: "var(--muted)", fontWeight: 700 }}>{it.l}</span>
          <span
            style={{
              color: "var(--ink)",
              fontWeight: 700,
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
            padding: "0 12px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            borderLeft: "1px solid var(--rule)",
          }}
        >
          <span style={{ color: "var(--muted)", fontWeight: 700 }}>{it.l}</span>
          <span style={{ color: "var(--ink)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{it.v}</span>
        </div>
      ))}
    </div>
  );
}
