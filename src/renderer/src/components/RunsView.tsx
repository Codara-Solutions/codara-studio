import { useMemo, type ReactNode } from "react";
import type { RunState, Workspace } from "@shared/types";
import { isRunningStatus, runStatusColor } from "../lib/run-status";
import { logicalWorkers } from "../lib/worker-identity";
import { sortSteps, workerModelLabel } from "./runs/run-format";
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
  // Returns whether a terminal pane was actually focused (see App.tsx).
  onOpenWorkerTerminal?: (workerTaskId: string) => boolean;
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
  if (isConversationRun(activeRun)) {
    // A pure conversation is not orchestration — no canvas, no inspector,
    // no phantom pipeline. The graph appears the moment Cora delegates
    // real work.
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
        <ConversationRestState run={activeRun} />
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

// A run whose only activity is conversational manager turns — Cora talking,
// not delegating. The Runs tab stays quiet for these; a plan-first run (any
// non-chat manager call) still gets the forming-pipeline canvas.
function isConversationRun(run: RunState): boolean {
  if (run.steps.length > 0 || run.workerTasks.length > 0) return false;
  return run.sparkCalls.every((call) => call.mode === "chat");
}

// ── Header ───────────────────────────────────────────────────────────────────

function RunHeader({ run }: { run: RunState }) {
  const orderedSteps = useMemo(() => sortSteps(run.steps), [run.steps]);
  const activeStep =
    orderedSteps.find((step) => step.id === run.currentStepId) ??
    orderedSteps.find((step) => step.status === "running" || step.status === "reviewing") ??
    orderedSteps.find((step) => step.status !== "complete" && step.status !== "skipped");
  const activeStepNumber = activeStep ? orderedSteps.indexOf(activeStep) + 1 : 0;

  // A stepless run with conversational manager turns is a session, not a
  // pipeline that failed to start — the glance header talks about turns, not
  // phantom steps.
  const turnCalls = useMemo(
    () =>
      run.sparkCalls
        .filter((call) => call.mode === "chat")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [run.sparkCalls],
  );
  const conversational =
    orderedSteps.length === 0 &&
    run.workerTasks.length === 0 &&
    run.sparkCalls.every((call) => call.mode === "chat");
  const liveTurn = turnCalls.find((call) => call.status === "started") ?? null;
  const tokensIn = turnCalls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0);
  const tokensOut = turnCalls.reduce((sum, call) => sum + (call.completionTokens ?? 0), 0);

  // The user stopped the run from the composer. Cora is not on a step, it is
  // holding, so the glance line says so instead of naming work in flight.
  const paused = run.status === "paused";
  const pausedText = activeStep
    ? `Paused at step ${activeStepNumber}: ${activeStep.title}`
    : "Paused. Resume from the chat composer.";

  const nowText = paused
    ? pausedText
    : conversational
      ? liveTurn
        ? `Turn ${turnCalls.indexOf(liveTurn) + 1}, Cora is answering in chat`
        : run.status === "complete"
          ? "Conversation finished"
          : "Waiting for your next message"
      : activeStep
        ? `Step ${activeStepNumber}: ${activeStep.title}`
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
  // "Live" counts logical workers (tasks collapsed over supersedes chains)
  // with an attempt in flight — never raw attempts, so a retry can't read as
  // an extra worker. The retry itself is named in the detail line instead.
  const workers = useMemo(() => logicalWorkers(run), [run]);
  const liveWorkers = workers.filter(
    (worker) => worker.latestAttempt && liveAttemptStatuses.has(worker.latestAttempt.status),
  );
  const liveRetryOrdinal = liveWorkers.reduce(
    (max, worker) => Math.max(max, worker.attempts.length),
    0,
  );
  const latestAttempt = [...run.workerAttempts]
    .reverse()
    .find((attempt) => liveAttemptStatuses.has(attempt.status)) ?? run.workerAttempts.at(-1);
  const latestTask = latestAttempt
    ? run.workerTasks.find((task) => task.id === latestAttempt.workerTaskId)
    : undefined;
  // Lead with the model and keep the provider as the supporting detail: under
  // Pi the provider only names the subscription, so it is the less informative
  // of the two. "default model" is gone, the attempt now persists what it
  // actually launched on, and where nothing has launched yet we say so.
  const engineRuntime = latestAttempt?.runtime ?? run.chatBackend ?? "cora";
  const engineModel = latestAttempt?.model ?? latestTask?.modelHint ?? run.chatModel;
  const engine = engineModel
    ? workerModelLabel(engineModel, latestAttempt?.runtime ?? "claude")
    : engineRuntime;
  const model = engineModel ? engineRuntime : "no worker yet";
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
      className="runs-header"
      style={{
        flex: "0 0 auto",
        position: "relative",
        overflow: "hidden",
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule)",
        boxShadow: "var(--lift-hi)",
        padding: "14px 20px 15px",
        display: "grid",
        gridTemplateColumns: "minmax(235px, 1fr) minmax(0, 1fr)",
        gap: 28,
        alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
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
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.06em",
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
        {!conversational && (
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
                        : paused
                          ? "var(--info)"
                          : "var(--accent)",
                  transition: "width var(--motion) var(--ease-out)",
                }}
              />
            </span>
            <span
              style={{
                color: "var(--muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {completedSteps}/{orderedSteps.length || "—"} · {progressPercent}%
            </span>
          </div>
        )}
      </div>

      <div
        className="runs-stats"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          alignItems: "stretch",
          minWidth: 0,
        }}
      >
        {conversational ? (
          <StatMetric
            label="Turns"
            value={turnCalls.length}
            detail={paused ? "paused" : liveTurn ? "Cora is answering" : "conversation"}
            tone={
              paused
                ? "var(--info)"
                : liveTurn
                  ? "var(--accent)"
                  : terminal
                    ? "var(--ok)"
                    : "var(--ink)"
            }
            live={Boolean(liveTurn) && !paused}
          />
        ) : (
          <StatMetric
            label="Progress"
            value={`${completedSteps}/${orderedSteps.length || "—"}`}
            detail={`${progressPercent}% complete`}
            tone={terminal ? "var(--ok)" : "var(--accent)"}
          />
        )}
        {conversational ? (
          <StatMetric
            label="Tokens"
            value={tokensIn + tokensOut > 0 ? formatTokenCount(tokensIn + tokensOut) : "—"}
            detail={tokensIn + tokensOut > 0 ? `${formatTokenCount(tokensIn)} in / ${formatTokenCount(tokensOut)} out` : "no usage yet"}
          />
        ) : (
          <StatMetric
            label="Live"
            // While paused the count is whatever the stop left behind, so it is
            // still shown, but nothing here may claim the work is running: no
            // pulse, no accent, and the detail names the hold.
            value={paused ? 0 : liveWorkers.length}
            detail={
              paused
                ? liveWorkers.length > 0
                  ? `${liveWorkers.length} held by the pause`
                  : "paused"
                : liveWorkers.length === 0
                  ? "none active"
                  : `${liveWorkers.length === 1 ? "worker" : "workers"} active${
                      liveRetryOrdinal > 1 ? ` · attempt ${liveRetryOrdinal} running` : ""
                    }`
            }
            tone={paused ? "var(--info)" : liveWorkers.length > 0 ? "var(--accent)" : "var(--ink)"}
            live={liveWorkers.length > 0 && !paused}
          />
        )}
        <StatMetric label="Model" value={engine} detail={model} text />
        <StatMetric
          label="Elapsed"
          value={<ElapsedTime startedAt={run.createdAt} finishedAt={run.completedAt} />}
          detail={terminal ? "total runtime" : "wall clock"}
          text
        />
        {conversational ? (
          <StatMetric
            label="Context"
            value={latestContextPercent(turnCalls) ?? "—"}
            detail="of model window"
          />
        ) : (
          <StatMetric
            label="Evidence"
            value={manifest ? manifest.workspaceDelta.length : "—"}
            detail={evidenceDetail}
            tone={manifest && manifest.checks.some((check) => check.result === "failed") ? "var(--danger)" : undefined}
          />
        )}
      </div>
    </header>
  );
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}

// Context pressure of the most recent turn that reported usage, as "42%".
function latestContextPercent(turnCalls: RunState["sparkCalls"]): string | null {
  for (let index = turnCalls.length - 1; index >= 0; index -= 1) {
    const call = turnCalls[index];
    const used = call.promptTokens ?? call.promptTokenEstimate;
    const total = call.contextWindowTokens;
    if (typeof used === "number" && typeof total === "number" && total > 0) {
      return `${Math.max(0, Math.min(100, Math.round((used / total) * 100)))}%`;
    }
  }
  return null;
}

// The quiet state for a chat that has not delegated any work: no canvas, no
// inspector — one calm line, and the promise of what this surface becomes.
function ConversationRestState({ run }: { run: RunState }) {
  const live = run.sparkCalls.some((call) => call.mode === "chat" && call.status === "started");
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
          width: "min(460px, 100%)",
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
            border: "1px solid var(--rule)",
            background: "var(--panel)",
            color: live ? "var(--accent)" : "var(--muted)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "var(--lift-hi)",
          }}
        >
          <FanGlyph />
        </span>
        <span
          style={{
            color: "var(--muted-2)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Orchestration
        </span>
        <div style={{ color: "var(--ink)", fontSize: 15, fontWeight: 700 }}>
          {live ? "Cora is answering in chat" : "Just a conversation so far"}
        </div>
        <div style={{ color: "var(--muted)", fontSize: 12.5, lineHeight: 1.5, maxWidth: 380 }}>
          The moment Cora delegates real work — parallel workers, steps,
          verification — the orchestration graph appears here.
        </div>
      </div>
    </div>
  );
}

// A small fan-out mark: one node branching into three parallel lanes.
function FanGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      <circle cx="4" cy="9" r="2.1" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M6.1 9h2.1M8.2 9c1.7 0 1.7-4 3.4-4M8.2 9c1.7 0 1.7 4 3.4 4M8.2 9h3.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="14" cy="5" r="1.6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="14" cy="9" r="1.6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="14" cy="13" r="1.6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
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
            fontWeight: 600,
            letterSpacing: "0.06em",
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

function StatMetric({
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
            }}
          />
        )}
        <span
          style={{
            color: "var(--muted-2)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.06em",
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
          // The old "Engine" metric was uppercased because a bare runtime name
          // ("claude") reads as a label, not a word. This slot now carries a
          // model name, "Opus 4.8", "Sol", which is a proper noun with a
          // version in it, so uppercasing it would only hurt legibility.
          textTransform: undefined,
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
          fontSize: 10,
          lineHeight: 1.2,
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
  const label = status.replace(/[_-]+/g, " ");
  return (
    <span
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color,
        border: `1px solid color-mix(in oklch, ${color} 50%, var(--rule))`,
        background: `color-mix(in oklch, ${color} 10%, transparent)`,
        padding: "3px 10px",
        borderRadius: 999,
        fontFamily: "var(--font-sans)",
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
    >
      {isRunningStatus(status) && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: 999,
            background: color,
          }}
        />
      )}
      {label.charAt(0).toUpperCase() + label.slice(1)}
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
          fontWeight: 600,
          letterSpacing: "0.06em",
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
