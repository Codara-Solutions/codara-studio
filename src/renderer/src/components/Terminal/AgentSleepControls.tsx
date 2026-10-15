// Pane chrome for agent hibernation (lib/agentHibernation.ts): the calm
// "Sleeping" chip a pane shows while Codara has its idle agent stopped, and
// the "Keep awake" pin in the pane toolbar. Both are part of the pane, not
// floating layers, so they stay solid (no glass).

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

/**
 * The pane toolbar's "Keep awake" pin. Pressed, the pane's agent is never
 * stopped by hibernation, however long it sits in a background workspace.
 */
export function KeepAwakeButton({
  pinned,
  onToggle,
}: {
  pinned: boolean;
  onToggle: () => void;
}) {
  const title = pinned ? "Keep awake is on: this agent never sleeps" : "Keep awake";
  return (
    <button
      type="button"
      className={`spark-icon-btn${pinned ? " is-active" : ""}`}
      title={title}
      aria-label="Keep awake"
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
