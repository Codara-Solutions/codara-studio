import { useEffect, useState } from "react";
import type { Workspace } from "@shared/types";
import { WorkspaceIconGlyph } from "./workspace-icons";

// The one-second "you just switched to …" pill that drops in under the title
// bar on every workspace change. It exists so a glance confirms where the next
// message or command is going, then gets out of the way: no persistent chrome,
// no click target. `signal` bumps on every activation so switching straight
// back to a workspace replays the pill instead of being swallowed as "same
// value". Pointer events are off so it never intercepts the click that caused
// the switch.
const EXIT_MS = 260;

export default function WorkspaceSwitchHud({
  workspace,
  branch,
  signal,
  holdMs,
}: {
  workspace: Workspace | null;
  branch: string | null;
  signal: number;
  /** On-screen time before the exit animation; 0 disables the badge. */
  holdMs: number;
}) {
  const [phase, setPhase] = useState<"hidden" | "in" | "out">("hidden");
  const [shown, setShown] = useState<{ workspace: Workspace; branch: string | null } | null>(null);

  useEffect(() => {
    if (signal === 0 || !workspace || holdMs <= 0) return;
    setShown({ workspace, branch });
    setPhase("in");
    const exit = window.setTimeout(() => setPhase("out"), holdMs);
    const hide = window.setTimeout(() => setPhase("hidden"), holdMs + EXIT_MS);
    return () => {
      window.clearTimeout(exit);
      window.clearTimeout(hide);
    };
    // Only a fresh activation replays the pill; a rename or branch change
    // mid-hold keeps the snapshot it opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);

  if (phase === "hidden" || !shown) return null;
  const accent = shown.workspace.color || "var(--accent)";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="workspace-switch-hud"
      data-phase={phase}
      className={`spark-workspace-switch-hud${phase === "out" ? " is-leaving" : ""}`}
      style={{ ["--hud-accent" as string]: accent }}
    >
      <span className="spark-workspace-switch-hud__tile">
        <WorkspaceIconGlyph icon={shown.workspace.icon} size={16} />
      </span>
      <span className="spark-workspace-switch-hud__text">
        <span className="spark-workspace-switch-hud__name">{shown.workspace.name}</span>
        {shown.branch && (
          <span className="spark-workspace-switch-hud__branch">{shown.branch}</span>
        )}
      </span>
    </div>
  );
}
