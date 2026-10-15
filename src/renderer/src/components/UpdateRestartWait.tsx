import React from "react";

// Body of the update popover while "Restart and install" waits for agents
// to finish their turn (src/main/quit-guard.ts, createUpdateRestartGate).
// Main restarts by itself once nothing is working; Restart now skips the
// wait, and Don't restart yet stops waiting without dropping the download.

export interface UpdateRestartWaitProps {
  items: readonly string[];
  onRestartNow: () => void;
  onCancel: () => void;
}

export function UpdateRestartWait({ items, onRestartNow, onCancel }: UpdateRestartWaitProps): React.ReactElement {
  return (
    <div data-testid="update-restart-wait" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span role="status" style={{ fontSize: 10.5, color: "var(--muted)" }}>
        Restarts by itself when {items.length === 1 ? "this finishes" : "these finish"}:
      </span>
      <ul
        aria-label="Still working"
        style={{
          margin: 0,
          paddingLeft: 16,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          fontSize: 11,
          color: "var(--ink)",
        }}
      >
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          className="spark-btn is-primary"
          style={{ height: 24, fontSize: 11 }}
          onClick={onRestartNow}
        >
          Restart now
        </button>
        <button
          type="button"
          className="spark-btn"
          style={{ height: 24, fontSize: 11 }}
          onClick={onCancel}
        >
          Don't restart yet
        </button>
      </div>
      <span style={{ fontSize: 10, color: "var(--muted-2)" }}>
        Restart now stops them in the middle of their work.
      </span>
    </div>
  );
}
