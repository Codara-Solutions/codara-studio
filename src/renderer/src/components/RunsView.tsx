import { useMemo } from "react";
import type { RunState, Workspace } from "@shared/types";
import { isRunningStatus, runStatusColor } from "../lib/run-status";
import { sortSteps } from "./runs/run-format";
import { StatusDot } from "./runs/GraphNodes";
import RunCanvas from "./runs/RunCanvas";

// RunsView is the entry for the runs workbench tab: a glance header over the
// run canvas (the node graph + docked inspector). The graph, nodes, wires and
// inspector all live under ./runs/.

interface Props {
  workspace: Workspace | null;
  // Lifted state from App — the runs list and selection are owned upstream so
  // this canvas and the Spark chat tab always agree.
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
}

export default function RunsView({ workspace, runs, activeRunId }: Props) {
  const activeRun = useMemo(
    () => runs.find((run) => run.id === activeRunId) ?? null,
    [runs, activeRunId],
  );

  if (!workspace) {
    return <EmptyState text="No active workspace." />;
  }
  if (runs.length === 0) {
    return (
      <EmptyState
        heading="No runs yet"
        text="Start a chat in the Spark tab, or right-click a plan file in the explorer."
      />
    );
  }
  if (!activeRun) {
    return <EmptyState heading="No run selected" text="Pick a chat from the Spark tab." />;
  }
  if (isTerminalSpawnRun(activeRun)) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          color: "var(--ink)",
        }}
      >
        <RunHeader run={activeRun} />
        <TerminalSpawnState run={activeRun} />
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--ink)",
      }}
    >
      <RunHeader run={activeRun} />
      <RunCanvas run={activeRun} />
    </div>
  );
}

function isTerminalSpawnRun(run: RunState): boolean {
  return (
    run.steps.length === 0 &&
    run.workerTasks.length === 0 &&
    (run.autopilot?.lastAction === "spawned_terminals" ||
      (run.autopilot?.spawnedTerminals ?? 0) > 0)
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function RunHeader({ run }: { run: RunState }) {
  const orderedSteps = useMemo(() => sortSteps(run.steps), [run.steps]);
  const activeStep =
    orderedSteps.find((step) => step.id === run.currentStepId) ??
    orderedSteps.find((step) => step.status === "running" || step.status === "reviewing") ??
    orderedSteps.find((step) => step.status !== "complete" && step.status !== "skipped");
  const activeStepNumber = activeStep ? orderedSteps.indexOf(activeStep) + 1 : 0;

  const nowText = activeStep
    ? `Step ${String(activeStepNumber).padStart(2, "0")} — ${activeStep.title}`
    : run.status === "complete"
      ? "Run complete"
      : "Waiting for Spark to plan the first step";

  return (
    <header
      style={{
        flex: "0 0 auto",
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule)",
        boxShadow: "var(--lift-hi)",
        padding: "13px 20px 12px",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 24,
        alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
          <StatusDot status={run.status} size={8} />
          <span
            title={isTerminalSpawnRun(run) ? "Spark terminals" : run.title}
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: "-0.006em",
            }}
          >
            {isTerminalSpawnRun(run) ? "Spark terminals" : run.title}
          </span>
          <StatusPill status={run.status} />
        </div>
        <div
          title={activeStep?.goal}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--muted-2)",
              flex: "0 0 auto",
            }}
          >
            Now
          </span>
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--ink-dim)",
            }}
          >
            {nowText}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "stretch" }}>
        <Metric label="Steps" value={run.steps.length} />
        <Metric label="Workers" value={run.workerTasks.length} separated />
        <Metric label="Attempts" value={run.workerAttempts.length} separated />
        <Metric label="Autopilot" value={run.autopilot?.status ?? "idle"} separated text />
      </div>
    </header>
  );
}

function TerminalSpawnState({ run }: { run: RunState }) {
  const count = run.autopilot?.spawnedTerminals ?? 0;
  const terminalText =
    count === 1 ? "1 terminal is open" : `${count || "The requested"} terminals are open`;
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        backgroundImage:
          "radial-gradient(circle, color-mix(in oklch, var(--ink) 10%, transparent) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
    >
      <div
        style={{
          width: "min(440px, 100%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          textAlign: "center",
        }}
      >
        <span
          style={{
            width: 38,
            height: 38,
            borderRadius: 9,
            border: "1px solid color-mix(in oklch, var(--ok) 55%, var(--rule))",
            background: "var(--ok-soft)",
            color: "var(--ok)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "var(--lift-hi)",
          }}
        >
          <TerminalGlyph />
        </span>
        <span
          style={{
            color: "var(--muted-2)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
          }}
        >
          Terminals
        </span>
        <div style={{ color: "var(--ink)", fontSize: 15, fontWeight: 700 }}>
          {terminalText}
        </div>
        <div style={{ color: "var(--muted)", fontSize: 12.5, lineHeight: 1.5 }}>
          Use the terminal tab to drive them directly.
        </div>
      </div>
    </div>
  );
}

function TerminalGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="1.6" y="3" width="14.8" height="12" rx="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4.8 7.3 7 9.4 4.8 11.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.8 11.7h4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Metric({
  label,
  value,
  separated,
  text,
}: {
  label: string;
  value: string | number;
  separated?: boolean;
  text?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 5,
        justifyContent: "center",
        minWidth: text ? 80 : 56,
        padding: "0 18px",
        borderLeft: separated ? "1px solid var(--rule-soft)" : "none",
      }}
    >
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: "0.13em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: "var(--ink)",
          fontFamily: "var(--font-mono)",
          fontSize: text ? 13 : 21,
          lineHeight: 1,
          fontWeight: text ? 600 : 700,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: RunState["status"] }) {
  const color = runStatusColor(status);
  return (
    <span
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color,
        border: `1px solid color-mix(in oklch, ${color} 50%, var(--rule))`,
        background: `color-mix(in oklch, ${color} 11%, transparent)`,
        padding: "3px 9px",
        borderRadius: 999,
        fontFamily: "var(--font-sans)",
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
      }}
    >
      {isRunningStatus(status) && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: 999,
            background: color,
            animation: "spark-pulse 1.4s ease-in-out infinite",
          }}
        />
      )}
      {status}
    </span>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ text, heading }: { text: string; heading?: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        gap: 8,
        padding: 32,
        textAlign: "center",
      }}
    >
      <span
        style={{
          color: "var(--muted-2)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
        }}
      >
        Runs
      </span>
      {heading && (
        <span style={{ color: "var(--ink)", fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600 }}>
          {heading}
        </span>
      )}
      <span
        style={{
          color: "var(--ink-dim)",
          fontFamily: "var(--font-sans)",
          fontSize: heading ? 12.5 : 14,
          maxWidth: 360,
          lineHeight: 1.5,
        }}
      >
        {text}
      </span>
    </div>
  );
}
