import React from "react";

export default function SparkAgentPanel() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "1 1 0",
        minHeight: 0,
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--rule)",
          background: "var(--panel)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flex: "0 0 auto",
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            background: "var(--accent)",
            display: "inline-block",
            flex: "0 0 auto",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span style={{ fontWeight: 800, letterSpacing: "0.04em" }}>SPARK&nbsp;AGENT</span>
          <span style={{ fontSize: 10, color: "var(--muted)" }}>not connected</span>
        </div>
      </div>
      <div style={{ flex: 1, background: "var(--bg)" }} />
    </div>
  );
}
