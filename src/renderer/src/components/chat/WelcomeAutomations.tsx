import React from "react";
import { requestAutomationFocus } from "../automations/focus-request";
import { AutomationsGlyph, useAutomationsStatus } from "../automations/useAutomationsStatus";

// The new-chat welcome's door to Automations: one quiet row under the starter
// cards. Idle it names the surface and how many automations are armed; while
// an automation is RUNNING it becomes the glanceable live cue the user asked
// for (comet arc + ""Nightly digest" is running · Watch"), so the landing
// surface doubles as status. Deliberately NOT a fifth starter card.
//
// The running/blocked/armed derivation is shared with the inner tab strip's
// affordance (AutomationsStripButton) via useAutomationsStatus, so both doors
// always tell the same story.
//
// Opening routes through the spark:open-automations-tab broadcast (App owns
// the tab store), matching the house cross-module event pattern.

export default function WelcomeAutomations({
  workspaceId,
}: {
  workspaceId: string;
}): React.ReactElement {
  const { running, blocked, live, armed } = useAutomationsStatus(workspaceId);

  const open = (): void => {
    // Land the Automations page on the live automation when there is one.
    if (live) requestAutomationFocus(live.id);
    window.dispatchEvent(new CustomEvent("spark:open-automations-tab"));
  };

  return (
    <button
      type="button"
      className={`cora-welcome__automations${live ? " is-live" : ""}`}
      onClick={open}
      title="Open the Automations tab"
    >
      <span className="cora-welcome__automations-glyph" aria-hidden>
        {running && !blocked ? (
          <span
            className="spark-activity-spin"
            style={{
              width: 12,
              height: 12,
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
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: "var(--danger)",
              boxShadow: "0 0 7px color-mix(in oklch, var(--danger) 55%, transparent)",
            }}
          />
        ) : (
          <AutomationsGlyph />
        )}
      </span>
      <span className="cora-welcome__automations-text">
        {blocked ? (
          <>
            <strong>{blocked.name}</strong> needs you
          </>
        ) : running ? (
          <>
            <strong>{running.name}</strong> is running
          </>
        ) : (
          <>
            Automations
            {armed > 0 ? (
              <span className="cora-welcome__automations-sub">
                {armed} armed and waiting for {armed === 1 ? "its trigger" : "their triggers"}
              </span>
            ) : (
              <span className="cora-welcome__automations-sub">
                Cora can run recurring work on a schedule
              </span>
            )}
          </>
        )}
      </span>
      <span className="cora-welcome__automations-action">{live ? "Watch" : "Open"}</span>
      <span className="cora-welcome__automations-arrow" aria-hidden>
        →
      </span>
    </button>
  );
}
