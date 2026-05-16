import React, { useCallback, useState } from "react";
import type {
  HumanRunMessageKind,
  PlanFile,
  RunState,
  SparkEvent,
  Workspace,
} from "@shared/types";
import { isRunningStatus, runStatusColor } from "../lib/run-status";
import RunChatView from "./RunChatView";
import SectionHeader from "../panels/SectionHeader";

export type PlanMode = "file" | "typed";

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRun: RunState | null;
  events: SparkEvent[];
  planFiles: PlanFile[];
  selectedPlanPath: string;
  planMode: PlanMode;
  typedPlanText: string;
  humanInput: string;
  busy: boolean;
  error: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onStartAutopilot: () => void;
  onPauseRun: (reason: string) => void;
  onPauseAfterWorkers: () => void | Promise<void>;
  onForcePauseRun: () => void | Promise<void>;
  onResumeRun: () => void;
  onAddUserMessage: (message: string, kind?: HumanRunMessageKind) => void;
  onAnswerQuestion: (message: string) => void | Promise<void>;
  onSelectRun: (id: string | null) => void;
  onDeleteRun: (id: string) => void;
  onSelectPlan: (path: string) => void;
  onPlanModeChange: (mode: PlanMode) => void;
  onTypedPlanTextChange: (text: string) => void;
  onHumanInputChange: (value: string) => void;
}

export default function SparkAgentPanel({
  workspace,
  runs,
  activeRun,
  events,
  planFiles,
  selectedPlanPath,
  planMode,
  typedPlanText,
  humanInput,
  busy,
  error,
  collapsed,
  onToggleCollapse,
  onStartAutopilot,
  onPauseRun,
  onPauseAfterWorkers,
  onForcePauseRun,
  onResumeRun,
  onAddUserMessage: _onAddUserMessage,
  onAnswerQuestion: _onAnswerQuestion,
  onSelectRun,
  onDeleteRun,
  onSelectPlan,
  onPlanModeChange,
  onTypedPlanTextChange,
  onHumanInputChange,
}: Props) {
  const runStatus = activeRun ? activeRun.status : "idle";
  const runIsActive = Boolean(
    activeRun && (activeRun.status === "running" || activeRun.status === "planning"),
  );
  const runEnabled =
    Boolean(workspace) &&
    !busy &&
    !activeRun &&
    (planMode === "file"
      ? Boolean(selectedPlanPath)
      : typedPlanText.trim().length > 0);

  // Stable per-run delete request handler. RunsList passes this straight to
  // each memoized RunRow, so it must not be re-created every render or the
  // React.memo on RunRow would never hit. Keyed by id; resolves the run for
  // the confirm() title at click time.
  const requestDeleteRun = useCallback(
    (runId: string) => {
      const run = runs.find((r) => r.id === runId);
      const title = run?.title ?? runId;
      // Single-click delete with a clear native prompt. The backend
      // hard-kills any active workers and removes the artifact dir
      // directly (no recycle bin, so the OS doesn't prompt). This is
      // permanent — for a stuck/long-running run, click "Force pause"
      // first so file handles are released cleanly.
      const ok = window.confirm(
        `Delete run "${title}"?\n\nThis is permanent. Active workers will be killed and the artifact directory will be removed.`,
      );
      if (ok) onDeleteRun(runId);
    },
    [runs, onDeleteRun],
  );
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: "var(--panel)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <SectionHeader
        label="Spark"
        glyph={<SparkGlyph />}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        meta={
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--muted)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
            }}
          >
            <PulseDot live={runIsActive} />
            {runStatus}
          </span>
        }
      />

      {!collapsed && (
        <>
      {/* Runs list — always visible, with an internal cap so it never crowds
          out the chat / plan UI below. */}
      <div
        style={{
          flex: "0 0 auto",
          maxHeight: activeRun ? 168 : 240,
          overflow: "auto",
        }}
      >
        <RunsList
          runs={runs}
          activeRun={activeRun}
          activeRunId={activeRun?.id ?? null}
          busy={busy}
          onSelect={onSelectRun}
          onNewRun={() => onSelectRun(null)}
          onPause={() => onPauseRun("Paused by user")}
          onPauseAfterWorkers={onPauseAfterWorkers}
          onForcePause={onForcePauseRun}
          onResume={onResumeRun}
          onRequestDelete={requestDeleteRun}
        />
      </div>

      {activeRun ? (
        // Cursor-style chat for the selected run. Owns its own scroll, takes
        // the remaining vertical space.
        <RunChatView run={activeRun} events={events} />
      ) : (
        <PlanComposer
          workspace={workspace}
          planFiles={planFiles}
          selectedPlanPath={selectedPlanPath}
          planMode={planMode}
          typedPlanText={typedPlanText}
          humanInput={humanInput}
          busy={busy}
          runEnabled={runEnabled}
          error={error}
          onStartAutopilot={onStartAutopilot}
          onSelectPlan={onSelectPlan}
          onPlanModeChange={onPlanModeChange}
          onTypedPlanTextChange={onTypedPlanTextChange}
          onHumanInputChange={onHumanInputChange}
        />
      )}
        </>
      )}
    </section>
  );
}

function PlanComposer({
  workspace,
  planFiles,
  selectedPlanPath,
  planMode,
  typedPlanText,
  humanInput,
  busy,
  runEnabled,
  error,
  onStartAutopilot,
  onSelectPlan,
  onPlanModeChange,
  onTypedPlanTextChange,
  onHumanInputChange,
}: {
  workspace: Workspace | null;
  planFiles: PlanFile[];
  selectedPlanPath: string;
  planMode: PlanMode;
  typedPlanText: string;
  humanInput: string;
  busy: boolean;
  runEnabled: boolean;
  error: string | null;
  onStartAutopilot: () => void;
  onSelectPlan: (path: string) => void;
  onPlanModeChange: (mode: PlanMode) => void;
  onTypedPlanTextChange: (text: string) => void;
  onHumanInputChange: (value: string) => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--rule-soft)" }}>
        <PlanModeTabs mode={planMode} disabled={busy} onChange={onPlanModeChange} />
        <div
          style={{
            border: "1px solid var(--rule-soft)",
            borderRadius: 8,
            background: "color-mix(in oklch, var(--ink) 3%, transparent)",
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.035)",
            overflow: "hidden",
            marginTop: 8,
            transition:
              "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
          }}
        >
          {planMode === "file" ? (
            <>
              <select
                value={selectedPlanPath}
                onChange={(event) => onSelectPlan(event.target.value)}
                disabled={!workspace || busy || planFiles.length === 0}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  background: "transparent",
                  color: "var(--ink)",
                  border: "none",
                  borderBottom: "1px solid var(--rule-soft)",
                  height: 32,
                  padding: "6px 10px",
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                  outline: "none",
                }}
              >
                {planFiles.length === 0 ? (
                  <option value="">No markdown plans found</option>
                ) : (
                  planFiles.map((file) => (
                    <option key={file.path} value={file.path}>
                      {file.relativePath}
                    </option>
                  ))
                )}
              </select>
              <textarea
                value={humanInput}
                onChange={(event) => onHumanInputChange(event.target.value)}
                placeholder="Optional: pre-run note or correction"
                rows={3}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  resize: "vertical",
                  minHeight: 56,
                  maxHeight: 120,
                  background: "transparent",
                  color: "var(--ink)",
                  border: "none",
                  padding: "8px 10px",
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  outline: "none",
                  display: "block",
                }}
              />
            </>
          ) : (
            <textarea
              value={typedPlanText}
              onChange={(event) => onTypedPlanTextChange(event.target.value)}
              placeholder={
                "# Plan title\n\nDescribe the goal, invariants, deliverables, and constraints..."
              }
              rows={10}
              disabled={!workspace || busy}
              style={{
                width: "100%",
                boxSizing: "border-box",
                resize: "vertical",
                minHeight: 180,
                maxHeight: 360,
                background: "transparent",
                color: "var(--ink)",
                border: "none",
                padding: "10px 10px",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.5,
                outline: "none",
                display: "block",
              }}
            />
          )}
        </div>
      </div>

      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--rule-soft)",
          display: "flex",
        }}
      >
        <PanelButton
          disabled={!runEnabled}
          onClick={onStartAutopilot}
          styleOverride={
            runEnabled
              ? {
                  flex: 1,
                  background: "color-mix(in oklch, var(--ink) 3%, transparent)",
                  borderColor: "var(--accent-edge)",
                  color: "var(--ink)",
                }
              : { flex: 1 }
          }
          hoverOverride={
            runEnabled
              ? {
                  background: "var(--hover)",
                  borderColor: "var(--accent-edge)",
                }
              : undefined
          }
        >
          RUN
        </PanelButton>
      </div>

      {error && (
        <div
          style={{
            padding: "10px 16px",
            background: "var(--danger-soft)",
            borderTop:
              "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
            color: "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function PlanModeTabs({
  mode,
  disabled,
  onChange,
}: {
  mode: PlanMode;
  disabled: boolean;
  onChange: (mode: PlanMode) => void;
}) {
  const options: Array<{ value: PlanMode; label: string }> = [
    { value: "file", label: "Plan file" },
    { value: "typed", label: "Typed plan" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Plan input mode"
      style={{
        display: "inline-flex",
        gap: 0,
        padding: 2,
        borderRadius: 7,
        background: "color-mix(in oklch, var(--ink) 4%, transparent)",
        border: "1px solid var(--rule-soft)",
      }}
    >
      {options.map((option) => {
        const active = option.value === mode;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => !disabled && onChange(option.value)}
            disabled={disabled}
            style={{
              appearance: "none",
              border: "1px solid transparent",
              borderColor: active ? "var(--accent-edge)" : "transparent",
              background: active
                ? "color-mix(in oklch, var(--ink) 6%, var(--panel))"
                : "transparent",
              color: active ? "var(--ink)" : "var(--muted)",
              padding: "5px 12px",
              borderRadius: 5,
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              fontWeight: active ? 700 : 500,
              letterSpacing: "0.04em",
              cursor: disabled ? "not-allowed" : "default",
              transition:
                "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function RunsList({
  runs,
  activeRun,
  activeRunId,
  busy,
  onSelect,
  onNewRun,
  onPause,
  onPauseAfterWorkers,
  onForcePause,
  onResume,
  onRequestDelete,
}: {
  runs: RunState[];
  activeRun: RunState | null;
  activeRunId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onNewRun: () => void;
  onPause: () => void;
  onPauseAfterWorkers: () => void | Promise<void>;
  onForcePause: () => void | Promise<void>;
  onResume: () => void;
  onRequestDelete: (id: string) => void;
}) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--rule-soft)",
      }}
    >
      <div
        style={{
          padding: "10px 16px 4px",
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontFamily: "var(--font-sans)",
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--muted)",
        }}
      >
        <span>Runs</span>
        <span style={{ flex: 1, height: 1, background: "var(--rule-soft)" }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
            color: "var(--muted)",
          }}
        >
          {String(runs.length).padStart(2, "0")}
        </span>
        <RunControlsMenu
          activeRun={activeRun}
          busy={busy}
          onNewRun={onNewRun}
          onPause={onPause}
          onPauseAfterWorkers={onPauseAfterWorkers}
          onForcePause={onForcePause}
          onResume={onResume}
        />
      </div>
      {runs.length === 0 ? (
        <div
          style={{
            padding: "8px 16px 14px",
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          No runs yet. Pick a plan below and press RUN.
        </div>
      ) : (
        <div style={{ padding: "4px 8px 8px" }}>
          {runs.map((run, index) => (
            <RunRow
              key={run.id}
              run={run}
              // listRuns returns newest-first; we want the chronological label
              // (1 = first run started) so the oldest reads as 01 and the
              // newest reads as the highest number.
              index={runs.length - index}
              active={run.id === activeRunId}
              busy={busy}
              // Pass the id-keyed callbacks straight through (no inline
              // closure) so RunRow's React.memo can actually short-circuit:
              // onSelect/onRequestDelete are stable across renders.
              onSelect={onSelect}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunControlsMenu({
  activeRun,
  busy,
  onNewRun,
  onPause,
  onPauseAfterWorkers,
  onForcePause,
  onResume,
}: {
  activeRun: RunState | null;
  busy: boolean;
  onNewRun: () => void;
  onPause: () => void;
  onPauseAfterWorkers: () => void | Promise<void>;
  onForcePause: () => void | Promise<void>;
  onResume: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  if (!activeRun) return null;

  const isLive = activeRun.status === "running" || activeRun.status === "planning";
  const canResume = activeRun.status === "paused" || activeRun.status === "blocked";
  const canForce =
    activeRun.status !== "complete" &&
    activeRun.status !== "failed" &&
    activeRun.status !== "cancelled";

  const runAction = (action: () => void | Promise<void>) => {
    setOpen(false);
    void action();
  };

  return (
    <div style={{ position: "relative", flex: "0 0 auto" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        disabled={busy}
        title="Run controls"
        style={{
          appearance: "none",
          border: "1px solid var(--rule-soft)",
          borderRadius: 6,
          background: hover || open ? "var(--hover)" : "transparent",
          color: busy ? "var(--muted)" : "var(--ink-dim)",
          minHeight: 23,
          padding: "3px 8px",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "none",
          cursor: busy ? "not-allowed" : "default",
          whiteSpace: "nowrap",
        }}
      >
        Controls
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: 28,
            right: 0,
            zIndex: 20,
            minWidth: 178,
            padding: 5,
            border: "1px solid var(--rule-strong)",
            borderRadius: 7,
            background: "var(--panel-2)",
            boxShadow: "var(--shadow-2)",
          }}
        >
          {isLive && (
            <>
              <RunActionButton
                onClick={() => runAction(onPauseAfterWorkers)}
                title="Stop Spark from launching more work after the currently running workers finish."
              >
                Stop after workers
              </RunActionButton>
              <RunActionButton
                onClick={() => runAction(onPause)}
                title="Pause now and send a pause signal to active workers."
              >
                Pause now
              </RunActionButton>
            </>
          )}
          {canResume && (
            <RunActionButton onClick={() => runAction(onResume)} accent title="Resume this run.">
              Resume
            </RunActionButton>
          )}
          {canForce && (
            <RunActionButton
              onClick={() => runAction(onForcePause)}
              danger
              title="Hard-kill active worker processes and stop the autopilot loop."
            >
              Force pause
            </RunActionButton>
          )}
          <RunActionButton onClick={() => runAction(onNewRun)} title="Open the plan picker for a new run.">
            New run
          </RunActionButton>
        </div>
      )}
    </div>
  );
}

function RunActionButton({
  children,
  onClick,
  title,
  accent,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  accent?: boolean;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: "100%",
        minHeight: 28,
        border: "1px solid transparent",
        borderRadius: 5,
        background: hover ? "var(--hover)" : "transparent",
        color: danger ? "var(--danger)" : accent ? "var(--ink)" : "var(--ink-dim)",
        padding: "6px 8px",
        textAlign: "left",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        cursor: "default",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

// Memoized: the runs list re-renders on every orchestration event, but a
// given row's appearance only depends on its run object, index, active and
// busy flags. The onSelect/onRequestDelete callbacks are id-keyed and stable
// (see RunsList), so React.memo's shallow prop compare skips untouched rows.
const RunRow = React.memo(function RunRow({
  run,
  index,
  active,
  busy,
  onSelect,
  onRequestDelete,
}: {
  run: RunState;
  index: number;
  active: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onRequestDelete: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const [trashHover, setTrashHover] = useState(false);

  const background = active
    ? "color-mix(in oklch, var(--ink) 4%, var(--panel))"
    : hover
      ? "color-mix(in oklch, var(--ink) 5%, transparent)"
      : "color-mix(in oklch, var(--ink) 2%, transparent)";
  const titleColor = active ? "var(--ink)" : "var(--ink-dim)";
  const indexColor = active ? "var(--ink)" : "var(--muted)";
  const dotColor = active ? "var(--accent)" : runStatusColor(run.status);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "12px 26px minmax(0, 1fr) 24px",
        alignItems: "center",
        gap: 10,
        padding: "0 8px 0 9px",
        height: 31,
        background,
        position: "relative",
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 48%, var(--rule-strong))"
          : "1px solid transparent",
        borderRadius: 7,
        marginBottom: 5,
        boxShadow: active
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 16%, transparent), 0 8px 18px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.035)"
          : hover
            ? "inset 0 1px 0 rgba(255, 255, 255, 0.03)"
            : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        title={run.status}
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: dotColor,
          flex: "0 0 7px",
          animation: isRunningStatus(run.status) ? "spark-pulse 1.2s ease-in-out infinite" : undefined,
        }}
      />
      <button
        type="button"
        onClick={() => onSelect(run.id)}
        title={`${run.title} · ${run.status}`}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          padding: 0,
          textAlign: "left",
          cursor: "default",
          minWidth: 0,
          height: "100%",
          display: "inline-flex",
          alignItems: "center",
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          fontSize: 11,
          fontWeight: active ? 700 : 500,
          color: indexColor,
          letterSpacing: 0,
        }}
      >
        {String(index).padStart(2, "0")}
      </button>
      <button
        type="button"
        onClick={() => onSelect(run.id)}
        title={`${run.title} · ${run.status}`}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          padding: 0,
          textAlign: "left",
          cursor: "default",
          minWidth: 0,
          height: "100%",
          display: "inline-flex",
          alignItems: "center",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: active ? 600 : 500,
          color: titleColor,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            display: "inline-block",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            width: "100%",
          }}
        >
          {run.title}
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRequestDelete(run.id);
        }}
        onMouseEnter={() => setTrashHover(true)}
        onMouseLeave={() => setTrashHover(false)}
        disabled={busy}
        title="Delete run"
        style={{
          appearance: "none",
          background: trashHover ? "var(--danger-soft)" : "transparent",
          border: `1px solid ${trashHover ? "var(--danger)" : "transparent"}`,
          borderRadius: 999,
          color: trashHover ? "var(--danger)" : "var(--muted)",
          width: 20,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
        }}
      >
        <TrashGlyph />
      </button>
    </div>
  );
});

function TrashGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4h8" />
      <path d="M5.5 4V2.75h3V4" />
      <path d="M4 4l0.5 7.25a1 1 0 0 0 1 0.95h3a1 1 0 0 0 1-0.95L10 4" />
      <path d="M6 6.25v3.5" />
      <path d="M8 6.25v3.5" />
    </svg>
  );
}

function PanelButton({
  disabled,
  onClick,
  danger,
  children,
  styleOverride,
  hoverOverride,
  sentenceCase,
}: {
  disabled: boolean;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
  styleOverride?: React.CSSProperties;
  hoverOverride?: React.CSSProperties;
  sentenceCase?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const baseColor = disabled
    ? "var(--muted)"
    : danger
      ? "var(--danger)"
      : "var(--ink-dim)";

  const baseStyle: React.CSSProperties = {
    appearance: "none",
    background: "transparent",
    border: "1px solid var(--rule-soft)",
    borderRadius: 999,
    color: baseColor,
    minHeight: 28,
    padding: "6px 10px",
    fontFamily: "var(--font-sans)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: sentenceCase ? "0.01em" : "0.04em",
    textTransform: sentenceCase ? "none" : undefined,
    cursor: "default",
    transition:
      "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
  };

  const merged: React.CSSProperties = { ...baseStyle, ...(styleOverride ?? {}) };

  if (hover && !disabled) {
    if (hoverOverride) {
      Object.assign(merged, hoverOverride);
    } else {
      merged.background = "var(--hover-strong)";
      merged.color = danger ? "var(--danger)" : "var(--ink)";
    }
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={merged}
    >
      {children}
    </button>
  );
}

function SparkGlyph() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 13,
        height: 13,
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--accent)",
      }}
    >
      <svg
        width={13}
        height={13}
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M8 1.25L9.35 6.05L14.15 7.4L9.35 8.75L8 13.55L6.65 8.75L1.85 7.4L6.65 6.05L8 1.25Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

function PulseDot({ live }: { live: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: "var(--accent)",
        boxShadow: "0 0 6px var(--accent-glow)",
        opacity: live ? 1 : 0.45,
        animation: live ? "spark-pulse 1.2s ease-in-out infinite" : undefined,
        flex: "0 0 auto",
      }}
    />
  );
}
