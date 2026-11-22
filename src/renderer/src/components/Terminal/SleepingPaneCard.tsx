// The card a sleeping agent pane shows (agent hibernation). Its own module so
// the renderer loads it only once a pane actually sleeps, not at startup.

import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { TerminalLeafHibernation } from "../../tabs/types";
import { MoonIcon } from "./AgentSleepControls";
const RUNTIME_NAME: Record<TerminalLeafHibernation["runtime"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
};

function sleptAgo(sleptAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - sleptAt) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * The card a sleeping pane shows at its bottom edge: which agent sleeps,
 * since when, and Resume. Docked rather than covering the pane, so the
 * agent's last output stays readable and scrollable above it. Solid like the
 * rest of the pane's chrome.
 */
export default function SleepingPaneCard({
  hibernation,
  onResume,
  onResumeKeepRunning,
}: {
  hibernation: TerminalLeafHibernation;
  onResume: () => void;
  onResumeKeepRunning: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A narrow split keeps the title and Resume only.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setCompact((entry?.contentRect.width ?? 0) < 420));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const waking = hibernation.resumeRequested === true;
  const name = RUNTIME_NAME[hibernation.runtime] ?? "Agent";
  const title = `${name} session`;
  const meta = `Fell asleep ${sleptAgo(hibernation.sleptAt, Date.now())}`;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div
      ref={ref}
      className="spark-fade-in"
      role="group"
      aria-label={`${name} asleep: ${title}`}
      data-testid="pane-sleeping-card"
      data-waking={waking ? "true" : "false"}
      onMouseDown={stop}
      onPointerDown={stop}
      style={{
        position: "absolute",
        left: 10,
        right: 10,
        bottom: 10,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: compact ? "8px 10px" : "10px 12px",
        borderRadius: 10,
        background: "var(--panel-2)",
        border: "1px solid var(--rule)",
        boxShadow: "var(--lift-hi), 0 0 0 1px var(--rule-soft)",
        color: "var(--ink)",
        zIndex: 6,
        animationDuration: "var(--motion-fast)",
      }}
    >
      {!compact ? (
        <span style={{ display: "inline-flex", color: "var(--muted)", flex: "none" }}>
          <MoonIcon size={16} />
        </span>
      ) : null}
      <div style={{ minWidth: 0, flex: 1, display: "grid", gap: 2 }}>
        <div
          data-testid="pane-sleeping-title"
          title={title}
          style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.04em",
            color: hibernation.wakeError ? "var(--danger)" : "var(--muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={hibernation.wakeError ?? undefined}
        >
          {hibernation.wakeError ? `Could not resume: ${hibernation.wakeError}` : waking ? "Resuming…" : `${meta} · Enter resumes`}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flex: "none" }}>
        {!compact ? (
          <button
            type="button"
            className="spark-btn"
            data-testid="pane-resume-keep-running"
            disabled={waking}
            title="Resume and never let this agent sleep again"
            onClick={(event) => {
              event.stopPropagation();
              onResumeKeepRunning();
            }}
          >
            Resume and keep running
          </button>
        ) : null}
        <button
          type="button"
          className="spark-btn is-primary"
          data-testid="pane-resume"
          disabled={waking}
          onClick={(event) => {
            event.stopPropagation();
            onResume();
          }}
        >
          {waking ? "Resuming…" : hibernation.wakeError ? "Try again" : "Resume"}
        </button>
      </div>
    </div>
  );
}
