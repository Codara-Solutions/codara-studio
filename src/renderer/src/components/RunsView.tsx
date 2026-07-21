import { useMemo, type ReactNode } from "react";
import type { RunState, Workspace } from "@shared/types";
import { isRunningStatus, runStatusColor } from "../lib/run-status";
import { sortSteps } from "./runs/run-format";
import { StatusDot } from "./runs/GraphNodes";
import { ElapsedTime } from "./runs/elapsed";
import RunCanvas from "./runs/RunCanvas";

// RunsView is the entry for the runs workbench tab: a glance header over the
// run canvas (the node graph + docked inspector). The graph, nodes, wires and
// inspector all live under ./runs/.

interface Props {
  workspace: Workspace | null;
  // Lifted state from App — the runs list and selection are owned upstream so
  // this canvas and the Cora chat tab always agree.
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onOpenWorkerTerminal?: (workerTaskId: string) => void;
}

export default function RunsView({
  workspace,
  runs,
  activeRunId,
  onOpenWorkerTerminal,
}: Props) {
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
        text="Start a chat in the Cora tab, or right-click a plan file in the explorer."
      />
    );
  }
  if (!activeRun) {
    return <EmptyState heading="No run selected" text="Pick a chat from the Cora tab." />;
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
      <RunCanvas run={activeRun} onOpenWorkerTerminal={onOpenWorkerTerminal} />
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
      : "Waiting for Cora to plan the first step";

  const completedSteps = orderedSteps.filter((step) =>
    ["complete", "completed_unverified", "skipped"].includes(step.status),
  ).length;
  const progress = orderedSteps.length > 0 ? completedSteps / orderedSteps.length : 0;
  const progressPercent = Math.round(progress * 100);
  const liveAttemptStatuses = new Set([
    "preparing",
    "prompt_ready",
    "launching",
    "running",
    "finishing",
  ]);
  const liveAttempts = run.workerAttempts.filter((attempt) => liveAttemptStatuses.has(attempt.status));
  const latestAttempt = [...run.workerAttempts]
    .reverse()
    .find((attempt) => liveAttemptStatuses.has(attempt.status)) ?? run.workerAttempts.at(-1);
  const latestTask = latestAttempt
    ? run.workerTasks.find((task) => task.id === latestAttempt.workerTaskId)
    : undefined;
  const engine = latestAttempt?.runtime ?? run.chatBackend ?? "cora";
  const model = latestTask?.modelHint ?? run.chatModel;
  const manifest = run.resultManifest;
  const passedChecks = manifest?.checks.filter((check) => check.result === "passed").length ?? 0;
  const evidenceDetail = manifest
    ? manifest.checks.length > 0
      ? `${passedChecks}/${manifest.checks.length} checks passed`
      : "manifest recorded"
    : "awaiting manifest";
  const terminal = ["complete", "failed", "cancelled"].includes(run.status);

  return (
    <header
      className="runs-mission-header"
      style={{
        flex: "0 0 auto",
        position: "relative",
        overflow: "hidden",
        background:
          "linear-gradient(115deg, color-mix(in oklab, var(--panel-2) 88%, var(--accent) 4%), var(--panel) 56%, color-mix(in oklab, var(--panel) 94%, var(--bg)))",
        borderBottom: "1px solid var(--rule)",
        boxShadow: "var(--lift-hi)",
        padding: "14px 20px 15px",
        display: "grid",
        gridTemplateColumns: "minmax(235px, 1fr) minmax(0, 1fr)",
        gap: 28,
        alignItems: "center",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: "0 auto 0 0",
          width: 2,
          background: `linear-gradient(180deg, transparent, ${runStatusColor(run.status)}, transparent)`,
          boxShadow: `0 0 14px ${runStatusColor(run.status)}`,
        }}
      />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--muted-2)",
            fontFamily: "var(--font-mono)",
            fontSize: 8.5,
            fontWeight: 700,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
          }}
        >
          <span>Run telemetry</span>
          <span style={{ width: 20, height: 1, background: "var(--rule-strong)" }} />
          <span style={{ color: "var(--muted)", letterSpacing: "0.08em" }}>
            {run.id.length > 18 ? `${run.id.slice(0, 10)}…${run.id.slice(-5)}` : run.id}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
          <StatusDot status={run.status} size={8} />
          <span
            title={isTerminalSpawnRun(run) ? "Cora terminals" : run.title}
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
            {isTerminalSpawnRun(run) ? "Cora terminals" : run.title}
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
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 1 }}>
          <span
            aria-label={`${progressPercent}% complete`}
            style={{
              position: "relative",
              flex: 1,
              minWidth: 80,
              maxWidth: 400,
              height: 3,
              overflow: "hidden",
              borderRadius: 999,
              background: "color-mix(in oklab, var(--ink) 9%, transparent)",
            }}
          >
            <span
              style={{
                display: "block",
                width: `${progressPercent}%`,
                height: "100%",
                borderRadius: "inherit",
                background:
                  run.status === "failed" || run.status === "blocked"
                    ? "var(--danger)"
                    : terminal
                      ? "var(--ok)"
                      : "linear-gradient(90deg, var(--accent), color-mix(in oklch, var(--accent) 62%, white))",
                boxShadow: terminal ? "none" : "0 0 9px var(--accent-glow)",
                transition: "width var(--motion) var(--ease-out)",
              }}
            />
          </span>
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {completedSteps}/{orderedSteps.length || "—"} · {progressPercent}%
          </span>
        </div>
      </div>

      <div
        className="runs-telemetry-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          alignItems: "stretch",
          minWidth: 0,
        }}
      >
        <TelemetryMetric
          label="Progress"
          value={`${completedSteps}/${orderedSteps.length || "—"}`}
          detail={`${progressPercent}% landed`}
          tone={terminal ? "var(--ok)" : "var(--accent)"}
        />
        <TelemetryMetric
          label="Live"
          value={liveAttempts.length}
          detail={liveAttempts.length === 1 ? "worker active" : liveAttempts.length > 1 ? "workers active" : "all settled"}
          tone={liveAttempts.length > 0 ? "var(--accent)" : "var(--ink)"}
          live={liveAttempts.length > 0}
        />
        <TelemetryMetric
          label="Engine"
          value={engine}
          detail={model ?? "default model"}
          text
        />
        <TelemetryMetric
          label="Elapsed"
          value={<ElapsedTime startedAt={run.createdAt} finishedAt={run.completedAt} />}
          detail={terminal ? "total runtime" : "wall clock"}
          text
        />
        <TelemetryMetric
          label="Evidence"
          value={manifest ? manifest.workspaceDelta.length : "—"}
          detail={evidenceDetail}
          tone={manifest && manifest.checks.some((check) => check.result === "failed") ? "var(--danger)" : undefined}
        />
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
          "radial-gradient(circle, color-mix(in oklab, var(--ink) 10%, transparent) 1px, transparent 1px)",
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

function TelemetryMetric({
  label,
  value,
  detail,
  tone,
  live,
  text,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  tone?: string;
  live?: boolean;
  text?: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        justifyContent: "center",
        minWidth: 0,
        minHeight: 54,
        padding: "7px 11px 8px",
        borderLeft: "1px solid var(--rule-soft)",
        background:
          "linear-gradient(180deg, color-mix(in oklab, var(--ink) 2.5%, transparent), transparent)",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {live && (
          <span
            aria-hidden
            style={{
              width: 4,
              height: 4,
              borderRadius: 999,
              background: "var(--accent)",
              boxShadow: "0 0 7px var(--accent)",
              animation: "spark-pulse 1.4s ease-in-out infinite",
            }}
          />
        )}
        <span
          style={{
            color: "var(--muted-2)",
            fontFamily: "var(--font-sans)",
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
      </span>
      <span
        style={{
          color: tone ?? "var(--ink)",
          fontFamily: "var(--font-mono)",
          fontSize: text ? 11.5 : 18,
          lineHeight: 1,
          fontWeight: text ? 650 : 720,
          fontVariantNumeric: "tabular-nums",
          textTransform: typeof value === "string" && label === "Engine" ? "uppercase" : undefined,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
      <span
        title={detail}
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 8.5,
          lineHeight: 1.1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {detail}
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
        background: `linear-gradient(180deg, color-mix(in oklch, ${color} 15%, transparent), color-mix(in oklch, ${color} 7%, transparent))`,
        boxShadow: isRunningStatus(status) ? `inset 0 0 12px color-mix(in oklch, ${color} 10%, transparent), 0 0 12px color-mix(in oklch, ${color} 12%, transparent)` : "inset 0 1px 0 color-mix(in oklch, white 8%, transparent)",
        padding: "4px 10px",
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
