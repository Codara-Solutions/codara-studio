// Pane chrome for agent hibernation (lib/agentHibernation.ts): the calm
// "Sleeping" chip and the card with Resume a pane shows while Codara has its
// idle agent stopped, and the "Keep running" pin in the pane toolbar. All are
// part of the pane, not floating layers, so they stay solid (no glass).

import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { TerminalLeafHibernation } from "../../tabs/types";

const RUNTIME_LABEL: Record<TerminalLeafHibernation["runtime"], string> = {
  claude: "CLAUDE",
  codex: "CODEX",
  grok: "GROK",
  pi: "PI",
};

export function MoonIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11.5 8.6 A5 5 0 1 1 5.4 2.5 A4 4 0 0 0 11.5 8.6 Z" />
    </svg>
  );
}

function SunIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="7" cy="7" r="2.4" />
      <path d="M7 1.4 V2.6 M7 11.4 V12.6 M1.4 7 H2.6 M11.4 7 H12.6 M3 3 L3.8 3.8 M10.2 10.2 L11 11 M11 3 L10.2 3.8 M3.8 10.2 L3 11" />
    </svg>
  );
}

/**
 * Top-left status chip of a sleeping pane, in the WorkerChip's place. Calm
 * on purpose: nothing is wrong, the agent's session comes back on its own.
 */
export function SleepingPaneChip({
  hibernation,
  waking,
}: {
  hibernation: TerminalLeafHibernation;
  waking: boolean;
}) {
  const label = RUNTIME_LABEL[hibernation.runtime] ?? "AGENT";
  const status = waking ? "waking up" : "sleeping";
  return (
    <div
      className="spark-fade-in"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`${label} ${status}`}
      data-testid="pane-sleeping-chip"
      data-waking={waking ? "true" : "false"}
      style={{
        position: "absolute",
        top: 6,
        left: 8,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 999,
        maxWidth: "max(80px, calc(100% - 180px))",
        minWidth: 0,
        whiteSpace: "nowrap",
        background: "color-mix(in oklab, var(--panel-2) 82%, transparent)",
        border: "1px solid var(--rule)",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        boxShadow: "var(--lift-hi), 0 0 0 1px var(--rule-soft)",
        pointerEvents: "none",
        zIndex: 5,
        animationDuration: "var(--motion-fast)",
      }}
    >
      <span style={{ display: "inline-flex", color: "var(--muted)" }}>
        <MoonIcon size={10} />
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{label}</span>
      <span
        style={{
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: "0.14em",
          color: "var(--muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        {status}
      </span>
    </div>
  );
}

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
export function SleepingPaneCard({
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

/**
 * The pane toolbar's "Keep running" pin. Pressed, the pane's agent is never
 * stopped by hibernation, however long it sits in a background workspace.
 */
export function KeepAwakeButton({
  pinned,
  onToggle,
}: {
  pinned: boolean;
  onToggle: () => void;
}) {
  const title = pinned ? "Keep running is on: this agent never sleeps" : "Keep running";
  return (
    <button
      type="button"
      className={`spark-icon-btn${pinned ? " is-active" : ""}`}
      title={title}
      aria-label="Keep running"
      aria-pressed={pinned}
      data-testid="pane-keep-awake"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      style={{
        ["--spark-icon-btn-size" as string]: "20px",
        borderRadius: "var(--terminal-control-radius, 6px)",
        cursor: "default",
      }}
    >
      <SunIcon size={12} />
    </button>
  );
}
