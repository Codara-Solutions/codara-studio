// The inner tab strip's door to the Automations tab. Since the Cora menu was
// removed, an ACTIVE chat had no visible path to Automations (only the
// new-chat welcome row and the global chord) — this affordance sits at the
// right end of the strip so the tab stays one click away from any chat.
//
// Quiet when idle: a small muted lightning bolt (the automations identity —
// distinct from the chat-history clock), sized like the strip's other
// icon-only affordance (NewWhiteboardButton). While an automation is RUNNING
// or BLOCKED it becomes the glanceable live cue — spinner arc (or danger dot)
// plus the automation's name — reusing the exact status logic of the welcome
// row via the shared useAutomationsStatus hook.
//
// Opening routes through the spark:open-automations-tab broadcast (App owns
// the tab store), matching the house cross-module event pattern.

import React from "react";
import { requestAutomationFocus } from "./focus-request";
import { AutomationsGlyph } from "./AutomationsGlyph";
import { useAutomationsStatus } from "./useAutomationsStatus";

export default function AutomationsStripButton({
  workspaceId,
}: {
  workspaceId: string;
}): React.ReactElement {
  const { running, blocked, live } = useAutomationsStatus(workspaceId);

  const open = (): void => {
    // Land the Automations page on the live automation when there is one.
    if (live) requestAutomationFocus(live.id);
    window.dispatchEvent(new CustomEvent("spark:open-automations-tab"));
  };

  const label = blocked
    ? `"${blocked.name}" needs you. Open the Automations tab`
    : running
      ? `"${running.name}" is running. Open the Automations tab`
      : "Open the Automations tab";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={open}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        height: 22,
        minWidth: 22,
        padding: live ? "0 8px" : 0,
        border: "1px solid transparent",
        borderRadius: "var(--radius-control, 7px)",
        background: live ? "var(--accent-soft)" : "transparent",
        color: blocked ? "var(--danger)" : live ? "var(--accent)" : "var(--muted-2)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 550,
        cursor: "default",
        whiteSpace: "nowrap",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (!live) {
          e.currentTarget.style.background = "var(--hover)";
          e.currentTarget.style.color = "var(--ink-dim)";
        }
      }}
      onMouseLeave={(e) => {
        if (!live) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--muted-2)";
        }
      }}
    >
      {running && !blocked ? (
        <span
          className="spark-activity-spin"
          aria-hidden
          style={{
            width: 10,
            height: 10,
            flex: "0 0 auto",
            borderRadius: 999,
            background:
              "conic-gradient(from 0deg, transparent 0deg 90deg, var(--accent) 360deg)",
            WebkitMask:
              "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
            mask: "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
          }}
        />
      ) : blocked ? (
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            flex: "0 0 auto",
            borderRadius: 999,
            background: "var(--danger)",
            boxShadow: "0 0 6px color-mix(in oklch, var(--danger) 55%, transparent)",
          }}
        />
      ) : (
        <AutomationsGlyph size={12} />
      )}
      {live && (
        <span
          style={{
            maxWidth: 140,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {live.name}
        </span>
      )}
    </button>
  );
}
