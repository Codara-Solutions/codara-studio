import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type {
  PlanFile,
  PromptLabSimulateStageResult,
  PromptLabState,
  PromptLabStepResult,
  RunState,
  SparkManagerMode,
  SparkPromptLabWorkerPromptPreview,
  Workspace,
} from "@shared/types";

const STAGES: SparkManagerMode[] = ["plan_analysis", "step_planning"];
const STAGE_LABELS: Record<SparkManagerMode, string> = {
  plan_analysis: "STAGE 1 — Plan analysis",
  step_planning: "STAGE 2 — Step planning",
  worker_result_review: "STAGE — Worker result review",
};
const STAGE_DESCRIPTIONS: Record<SparkManagerMode, string> = {
  plan_analysis:
    "Spark sends this to break the plan into a step-by-step division. Accept the result to lock in the steps for stage 2.",
  step_planning:
    "Given the accepted step division, Spark plans the worker tasks for the first queued step. The user message includes stage 1's decision when it has been accepted.",
  worker_result_review: "Review of worker reports.",
};

type StageStatus = "locked" | "idle" | "running" | "ready" | "accepted" | "error";
type StageView = "system" | "user" | "decision";
type Status =
  | { kind: "idle" }
  | { kind: "loading"; label: string }
  | { kind: "ok"; label: string }
  | { kind: "error"; message: string };

interface StageState {
  status: StageStatus;
  step: PromptLabStepResult | null;
  view: StageView;
}

const INITIAL_STAGES: Record<SparkManagerMode, StageState> = {
  plan_analysis: { status: "idle", step: null, view: "system" },
  step_planning: { status: "locked", step: null, view: "system" },
  worker_result_review: { status: "locked", step: null, view: "system" },
};

export default function PromptLabView({ workspace }: { workspace: Workspace | null }) {
  const [labState, setLabState] = useState<PromptLabState | null>(null);
  const [planFiles, setPlanFiles] = useState<PlanFile[]>([]);
  const [selectedPlanPath, setSelectedPlanPath] = useState("");
  const [planText, setPlanText] = useState("");
  const [stages, setStages] = useState<Record<SparkManagerMode, StageState>>(INITIAL_STAGES);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [selectedWorker, setSelectedWorker] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const previewKeyRef = useRef("");

  // The Lab is a read-only inspector — prompts live in
  // resources/orchestration/manager-profile.json and the user edits that file
  // directly. We render whatever the live profile defines as the system
  // prompt for each stage (per-mode override if present, otherwise the
  // default identity+core+rules concatenation).
  const displayPrompts = useMemo<Record<SparkManagerMode, string>>(
    () => ({
      plan_analysis:
        labState?.modeSystemPromptOverrides.plan_analysis ?? labState?.defaultSystemPrompt ?? "",
      step_planning:
        labState?.modeSystemPromptOverrides.step_planning ?? labState?.defaultSystemPrompt ?? "",
      worker_result_review:
        labState?.modeSystemPromptOverrides.worker_result_review ?? labState?.defaultSystemPrompt ?? "",
    }),
    [labState],
  );

  const refreshLabState = useCallback(async () => {
    const next = await window.spark.promptLab.getState();
    setLabState(next);
    return next;
  }, []);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading", label: "Loading lab" });
    refreshLabState()
      .then(() => {
        if (!cancelled) setStatus({ kind: "idle" });
      })
      .catch((err) => {
        if (!cancelled) setStatus({ kind: "error", message: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshLabState]);

  // Markdown plan list & selection per workspace
  useEffect(() => {
    let cancelled = false;
    if (!workspace) {
      setPlanFiles([]);
      setSelectedPlanPath("");
      setPlanText("");
      resetSession();
      return;
    }
    window.spark.fs.listMarkdownFiles(workspace.cwd)
      .then(async (files) => {
        if (cancelled) return;
        setPlanFiles(files);
        const preferred = files.find((f) => f.name.toLowerCase() === "plan.md") ?? files[0];
        if (!preferred) {
          setSelectedPlanPath("");
          setPlanText("");
          return;
        }
        setSelectedPlanPath(preferred.path);
        const content = await window.spark.fs.readText(preferred.path);
        if (cancelled) return;
        setPlanText(content.content);
        resetSession();
      })
      .catch((err) => {
        if (!cancelled) setStatus({ kind: "error", message: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
    // resetSession is stable — not in deps to avoid re-running on every keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  // Auto-build the stage previews whenever inputs change so the User Message
  // pane is populated even without calling the model. The Lab is read-only
  // and always sends the LIVE profile (manager-profile.json) to the backend.
  useEffect(() => {
    if (!labState || !workspace || !planText.trim()) return;
    const profileText = labState.liveProfileText;
    const key = JSON.stringify({
      cwd: workspace.cwd,
      planPath: selectedPlanPath,
      planText,
      profileText,
      runStateUpdatedAt: runState?.updatedAt ?? null,
    });
    if (previewKeyRef.current === key) return;
    previewKeyRef.current = key;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const fixtureText = makeFixtureText({
        planText,
        planPath: selectedPlanPath,
        planFiles,
        cwd: workspace.cwd,
      });
      const stage1Promise = window.spark.promptLab.buildStage({
        profileText,
        fixtureText,
        cwd: workspace.cwd,
        mode: "plan_analysis",
        model: labState.defaultModel,
        temperature: 0.2,
      });
      const stage2Promise = window.spark.promptLab.buildStage({
        profileText,
        fixtureText,
        cwd: workspace.cwd,
        mode: "step_planning",
        model: labState.defaultModel,
        temperature: 0.2,
        runStateOverride: runState ?? undefined,
      });
      Promise.all([stage1Promise, stage2Promise])
        .then(([s1, s2]) => {
          if (cancelled) return;
          setStages((prev) => ({
            ...prev,
            plan_analysis: mergePreview(prev.plan_analysis, s1.step),
            step_planning: mergePreview(prev.step_planning, s2.step),
          }));
        })
        .catch((err) => {
          if (!cancelled) setStatus({ kind: "error", message: (err as Error).message });
        });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [labState, workspace, planText, selectedPlanPath, planFiles, runState]);

  function resetSession() {
    setRunState(null);
    setStages({
      plan_analysis: { status: "idle", step: null, view: "system" },
      step_planning: { status: "locked", step: null, view: "system" },
      worker_result_review: { status: "locked", step: null, view: "system" },
    });
    setSelectedWorker(0);
    previewKeyRef.current = "";
  }

  const loadPlan = async (path: string) => {
    setSelectedPlanPath(path);
    setStatus({ kind: "loading", label: "Loading plan" });
    try {
      const content = await window.spark.fs.readText(path);
      setPlanText(content.content);
      resetSession();
      setStatus({ kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  };

  const reloadFromDisk = async () => {
    setStatus({ kind: "loading", label: "Reloading" });
    try {
      await refreshLabState();
      if (selectedPlanPath) {
        const content = await window.spark.fs.readText(selectedPlanPath);
        setPlanText(content.content);
      }
      resetSession();
      setStatus({ kind: "ok", label: "Reloaded from disk" });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  };

  const restartSession = () => {
    resetSession();
    setStatus({ kind: "ok", label: "Session restarted" });
  };

  // Each simulate call applies the decision to the run state server-side and
  // returns updatedRun. We cache that per mode so ACCEPT can synchronously
  // promote it to the persistent runState without another IPC round-trip.
  const simulationRunsRef = useRef<Record<SparkManagerMode, RunState | null>>({
    plan_analysis: null,
    step_planning: null,
    worker_result_review: null,
  });

  const simulateStage = useCallback(
    async (mode: SparkManagerMode) => {
      if (!labState || !workspace || !planText.trim()) return;
      setStages((prev) => ({ ...prev, [mode]: { ...prev[mode], status: "running" } }));
      setStatus({ kind: "loading", label: `Simulating ${shortMode(mode)}` });
      try {
        const result: PromptLabSimulateStageResult = await window.spark.promptLab.simulateStage({
          profileText: labState.liveProfileText,
          fixtureText: makeFixtureText({ planText, planPath: selectedPlanPath, planFiles, cwd: workspace.cwd }),
          cwd: workspace.cwd,
          mode,
          model: labState.defaultModel,
          temperature: 0.2,
          runStateOverride: mode === "plan_analysis" ? undefined : runState ?? undefined,
        });
        simulationRunsRef.current[mode] = result.updatedRun;
        setStages((prev) => ({
          ...prev,
          [mode]: {
            ...prev[mode],
            step: result.step,
            status: result.step.error ? "error" : "ready",
            view: "decision",
          },
        }));
        if (mode === "step_planning") setSelectedWorker(0);
        if (result.step.error) {
          setStatus({ kind: "error", message: `${mode}: ${result.step.error}` });
        } else {
          setStatus({
            kind: "ok",
            label: `${shortMode(mode)} simulated • ${formatDuration(result.step.durationMs ?? 0)}`,
          });
        }
      } catch (err) {
        setStages((prev) => ({ ...prev, [mode]: { ...prev[mode], status: "error" } }));
        setStatus({ kind: "error", message: (err as Error).message });
      }
    },
    [labState, workspace, planText, selectedPlanPath, planFiles, runState],
  );

  const acceptStage = (mode: SparkManagerMode) => {
    const current = stages[mode];
    if (!current.step || current.step.error) return;
    const updatedRun = simulationRunsRef.current[mode];
    if (!updatedRun) return;
    setRunState(updatedRun);
    setStages((prev) => {
      const next: Record<SparkManagerMode, StageState> = { ...prev };
      next[mode] = { ...prev[mode], status: "accepted" };
      if (mode === "plan_analysis" && prev.step_planning.status === "locked") {
        next.step_planning = { ...prev.step_planning, status: "idle" };
      }
      return next;
    });
    setStatus({ kind: "ok", label: `${shortMode(mode)} accepted` });
  };

  const setStageView = (mode: SparkManagerMode, view: StageView) => {
    setStages((prev) => ({ ...prev, [mode]: { ...prev[mode], view } }));
  };

  const stagePlanning = stages.step_planning;
  const workerPreviews = stagePlanning.step?.workerPromptPreviews ?? [];
  const activeWorker = workerPreviews[selectedWorker] ?? null;

  return (
    <section style={rootStyle}>
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, minWidth: 0, flex: 1 }}>
          <div style={titleStyle}>PROMPT LAB</div>
          <div style={subtitleStyle}>
            Read-only inspector. Edit prompts in resources/orchestration/manager-profile.json and hit RELOAD.
          </div>
        </div>
        <StatusPill status={status} />
      </header>

      <div style={controlBarStyle}>
        <Field label="PLAN">
          <select
            value={selectedPlanPath}
            onChange={(event) => void loadPlan(event.target.value)}
            disabled={!workspace || planFiles.length === 0 || status.kind === "loading"}
            style={selectStyle}
          >
            {planFiles.length === 0 ? (
              <option value="">No markdown files in workspace</option>
            ) : (
              planFiles.map((file) => (
                <option key={file.path} value={file.path}>
                  {file.relativePath}
                </option>
              ))
            )}
          </select>
        </Field>
        <Chip label="MODEL" value={labState?.defaultModel ?? "—"} />
        <Chip label="TEMP" value="0.2" />
        <Chip
          label="LANGSMITH"
          value={labState?.langSmithConfigured ? labState.langSmithProject ?? "configured" : "off"}
          tone={labState?.langSmithConfigured ? "ok" : "muted"}
        />
        <Chip
          label="OPENROUTER"
          value={labState?.openRouterConfigured ? "ready" : "not configured"}
          tone={labState?.openRouterConfigured ? "ok" : "warn"}
        />
        <div style={{ flex: 1 }} />
        <ActionButton onClick={() => void reloadFromDisk()} disabled={status.kind === "loading"}>
          RELOAD
        </ActionButton>
        <ActionButton onClick={restartSession} disabled={status.kind === "loading"}>
          RESTART SESSION
        </ActionButton>
      </div>

      {!labState?.openRouterConfigured && (
        <Banner tone="warn">
          OpenRouter API key is not set. Add it in Settings to enable SIMULATE — previews still work.
        </Banner>
      )}

      <main style={mainStyle}>
        <section style={leftColStyle}>
          <PaneTitle
            title="PLAN.MD"
            right={planText ? `${planText.length.toLocaleString()} chars` : ""}
            copyValue={planText}
          />
          {planText ? (
            <pre style={planPreStyle}>{planText}</pre>
          ) : (
            <EmptyState>
              {workspace ? "Pick a markdown plan above to inspect." : "Open a workspace to use the Prompt Lab."}
            </EmptyState>
          )}
        </section>

        <section style={rightColStyle}>
          {STAGES.map((mode) => (
            <StageCard
              key={mode}
              mode={mode}
              state={stages[mode]}
              systemPrompt={displayPrompts[mode]}
              canSimulate={Boolean(
                labState?.openRouterConfigured &&
                  workspace &&
                  planText.trim() &&
                  stages[mode].status !== "locked" &&
                  stages[mode].status !== "running",
              )}
              onView={(view) => setStageView(mode, view)}
              onSimulate={() => void simulateStage(mode)}
              onAccept={() => acceptStage(mode)}
            />
          ))}

          <WorkerPromptsCard
            previews={workerPreviews}
            active={activeWorker}
            activeIndex={selectedWorker}
            onSelect={setSelectedWorker}
            simulated={stagePlanning.status === "ready" || stagePlanning.status === "accepted"}
          />
        </section>
      </main>
    </section>
  );
}

function StageCard({
  mode,
  state,
  systemPrompt,
  canSimulate,
  onView,
  onSimulate,
  onAccept,
}: {
  mode: SparkManagerMode;
  state: StageState;
  systemPrompt: string;
  canSimulate: boolean;
  onView: (view: StageView) => void;
  onSimulate: () => void;
  onAccept: () => void;
}) {
  const step = state.step;
  const userMessage = step?.request.messages.find((m) => m.role === "user")?.content ?? "";
  const decisionText = step?.error
    ? step.error
    : step?.decision
      ? JSON.stringify(step.decision, null, 2)
      : state.status === "locked"
        ? "Locked. Accept the previous stage first."
        : "Click SIMULATE to call the model and see the decision.";

  const showSystem = state.view === "system";
  const showUser = state.view === "user";
  const visibleText = showSystem
    ? systemPrompt || "(no system prompt set in manager-profile.json)"
    : showUser
      ? userMessage || "Building preview…"
      : decisionText;

  return (
    <article style={cardStyle(state.status)}>
      <header style={cardHeaderStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={cardTitleRowStyle}>
            <div style={cardTitleStyle}>{STAGE_LABELS[mode]}</div>
            <StageBadge status={state.status} />
          </div>
          <div style={cardSubtitleStyle}>{STAGE_DESCRIPTIONS[mode]}</div>
        </div>
        <StageMetrics step={step} />
      </header>

      <div style={tabBarStyle}>
        <Tab active={state.view === "system"} onClick={() => onView("system")}>
          System Prompt
        </Tab>
        <Tab active={state.view === "user"} onClick={() => onView("user")}>
          User Message
        </Tab>
        <Tab
          active={state.view === "decision"}
          onClick={() => onView("decision")}
          tone={step?.error ? "danger" : undefined}
        >
          Decision
        </Tab>
        <div style={{ flex: 1 }} />
        <CopyButton value={visibleText} />
      </div>

      <pre style={cardPreStyle(Boolean(step?.error) && state.view === "decision")}>
        {visibleText}
      </pre>

      <footer style={cardFooterStyle}>
        <span style={cardFooterHintStyle}>{stageHint(state.status)}</span>
        <div style={{ flex: 1 }} />
        <ActionButton
          onClick={onSimulate}
          disabled={!canSimulate}
          accent
        >
          {state.status === "running" ? "SIMULATING…" : `SIMULATE ${shortMode(mode).toUpperCase()}`}
        </ActionButton>
        <ActionButton
          onClick={onAccept}
          disabled={state.status !== "ready"}
        >
          {state.status === "accepted" ? "ACCEPTED" : "ACCEPT"}
        </ActionButton>
      </footer>
    </article>
  );
}

function StageBadge({ status }: { status: StageStatus }) {
  const tone =
    status === "accepted"
      ? "ok"
      : status === "ready"
        ? "warn"
        : status === "error"
          ? "danger"
          : status === "locked"
            ? "muted"
            : "muted";
  const label =
    status === "locked"
      ? "locked"
      : status === "running"
        ? "running"
        : status === "ready"
          ? "ready · accept to lock in"
          : status === "accepted"
            ? "accepted"
            : status === "error"
              ? "error"
              : "idle";
  return (
    <span style={stageBadgeStyle(tone)}>
      <span style={statusDotStyle(tone)} />
      {label}
    </span>
  );
}

function StageMetrics({ step }: { step: PromptLabStepResult | null }) {
  if (!step) return <span style={metricsHintStyle}>not yet simulated</span>;
  const items: Array<{ label: string; value: string }> = [];
  if (step.durationMs != null) items.push({ label: "took", value: formatDuration(step.durationMs) });
  if (step.promptTokens != null) items.push({ label: "in", value: `${step.promptTokens.toLocaleString()} tok` });
  if (step.completionTokens != null) items.push({ label: "out", value: `${step.completionTokens.toLocaleString()} tok` });
  if (step.langSmithTraceId) items.push({ label: "trace", value: step.langSmithTraceId.slice(0, 8) });
  if (items.length === 0) return <span style={metricsHintStyle}>preview only</span>;
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {items.map((item) => (
        <span key={item.label} style={metricStyle}>
          <span style={metricLabelStyle}>{item.label}</span>
          <span style={metricValueStyle}>{item.value}</span>
        </span>
      ))}
    </div>
  );
}

function WorkerPromptsCard({
  previews,
  active,
  activeIndex,
  onSelect,
  simulated,
}: {
  previews: SparkPromptLabWorkerPromptPreview[];
  active: SparkPromptLabWorkerPromptPreview | null;
  activeIndex: number;
  onSelect: (index: number) => void;
  simulated: boolean;
}) {
  return (
    <article style={cardStyle("idle")}>
      <header style={cardHeaderStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={cardTitleStyle}>WORKER PROMPTS{previews.length ? ` (${previews.length})` : ""}</div>
          <div style={cardSubtitleStyle}>
            The exact prompts that would be sent to Claude Code / Codex CLI workers if you ran this plan now.
          </div>
        </div>
        {active ? <CopyButton value={active.prompt} /> : null}
      </header>

      {previews.length === 0 ? (
        <pre style={cardPreStyle(false)}>
          {simulated
            ? "The manager produced no worker tasks. The model may have returned ask_user or an empty list."
            : "Simulate stage 2 to see the worker prompts the manager would produce."}
        </pre>
      ) : (
        <div style={workerLayoutStyle}>
          <div style={workerListStyle}>
            {previews.map((preview, index) => (
              <button
                key={`${preview.title}-${index}`}
                type="button"
                onClick={() => onSelect(index)}
                style={workerItemStyle(index === activeIndex)}
              >
                <div style={workerItemTitleStyle}>{preview.title}</div>
                <div style={workerItemMetaStyle}>
                  {preview.runtimePreference}
                  {preview.modelHint ? ` • ${preview.modelHint}` : ""}
                  {preview.effortHint ? ` • ${preview.effortHint}` : ""}
                </div>
              </button>
            ))}
          </div>
          <pre style={workerPreStyle}>{active?.prompt ?? "Pick a worker on the left."}</pre>
        </div>
      )}
    </article>
  );
}

function StatusPill({ status }: { status: Status }) {
  const tone =
    status.kind === "error"
      ? "danger"
      : status.kind === "ok"
        ? "ok"
        : status.kind === "loading"
          ? "warn"
          : "muted";
  const text =
    status.kind === "error"
      ? truncate(status.message, 80)
      : status.kind === "ok"
        ? status.label
        : status.kind === "loading"
          ? `${status.label}…`
          : "idle";
  return (
    <div style={statusPillStyle(tone)} title={status.kind === "error" ? status.message : undefined}>
      <span style={statusDotStyle(tone)} />
      <span>{text}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200 }}>
      <span style={fieldLabelStyle}>{label}</span>
      {children}
    </label>
  );
}

function Chip({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "muted" | "ok" | "warn";
}) {
  return (
    <div style={chipStyle(tone)}>
      <span style={chipLabelStyle}>{label}</span>
      <span style={chipValueStyle}>{value}</span>
    </div>
  );
}

function ActionButton({
  disabled,
  onClick,
  accent,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={actionButtonStyle(Boolean(disabled), Boolean(accent))}
    >
      {children}
    </button>
  );
}

function Tab({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: "danger";
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} style={tabStyle(active, tone)}>
      {children}
    </button>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).catch(() => undefined);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      style={copyButtonStyle}
    >
      {copied ? "COPIED" : "COPY"}
    </button>
  );
}

function PaneTitle({ title, right, copyValue }: { title: string; right?: string; copyValue?: string }) {
  return (
    <div style={paneTitleStyle}>
      <span style={paneTitleLabelStyle}>{title}</span>
      {right ? <span style={paneTitleRightStyle}>{right}</span> : null}
      <div style={{ flex: 1 }} />
      {copyValue ? <CopyButton value={copyValue} /> : null}
    </div>
  );
}

function Banner({ tone, children }: { tone: "warn"; children: React.ReactNode }) {
  return <div style={bannerStyle(tone)}>{children}</div>;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div style={emptyStateStyle}>{children}</div>;
}

function mergePreview(prev: StageState, builtStep: PromptLabStepResult): StageState {
  // Preview only sets the request — never overwrite an in-flight or accepted
  // step with model-call data, just keep the latest preview's request.
  if (prev.status === "running") return prev;
  if (prev.status === "ready" || prev.status === "accepted" || prev.status === "error") {
    if (prev.step) {
      return {
        ...prev,
        step: { ...prev.step, request: builtStep.request },
      };
    }
  }
  return { ...prev, step: { ...builtStep } };
}

function makeFixtureText({
  planText,
  planPath,
  planFiles,
  cwd,
}: {
  planText: string;
  planPath: string;
  planFiles: PlanFile[];
  cwd: string;
}): string {
  const now = new Date().toISOString();
  const planLabel = planFiles.find((file) => file.path === planPath)?.relativePath ?? "PLAN.md";
  return JSON.stringify(
    {
      id: "prompt-lab-run",
      workspaceId: "prompt-lab-workspace",
      planId: "prompt-lab-plan",
      title: planLabel,
      status: "running",
      pipelinePreset: "prompt-lab",
      artifactDir: cwd,
      createdAt: now,
      updatedAt: now,
      plans: [
        {
          id: "prompt-lab-plan",
          workspaceId: "prompt-lab-workspace",
          title: planLabel,
          sourceFile: planPath || undefined,
          rawContent: planText,
          requirements: [],
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
      steps: [],
      workerTasks: [],
      workerAttempts: [],
      sparkCalls: [],
      humanMessages: [],
      autopilot: {
        status: "running",
        lastAction: "prompt_lab",
        updatedAt: now,
      },
    },
    null,
    2,
  );
}

function shortMode(mode: SparkManagerMode): string {
  if (mode === "plan_analysis") return "stage 1";
  if (mode === "step_planning") return "stage 2";
  return "review";
}

function stageHint(status: StageStatus): string {
  if (status === "locked") return "Accept stage 1 first to unlock this stage.";
  if (status === "ready") return "Decision is ready. Click ACCEPT to lock it in for the next stage.";
  if (status === "accepted") return "Accepted. Re-simulate to get a new decision and accept again.";
  if (status === "running") return "Calling the manager model…";
  if (status === "error") return "Last simulate failed. See Decision tab.";
  return "Idle. Click SIMULATE to call the manager.";
}

function formatDuration(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const rootStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--bg)",
  color: "var(--ink)",
};

const headerStyle: React.CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "14px 18px",
  borderBottom: "1px solid var(--rule-soft)",
  background: "var(--panel)",
};

const titleStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.18em",
  color: "var(--ink)",
};

const subtitleStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--muted)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const controlBarStyle: React.CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "flex-end",
  gap: 12,
  padding: "12px 18px",
  borderBottom: "1px solid var(--rule-soft)",
  background: "var(--panel-2)",
  flexWrap: "wrap",
};

const fieldLabelStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.14em",
  color: "var(--muted)",
  textTransform: "uppercase",
};

const selectStyle: React.CSSProperties = {
  height: 30,
  border: "1px solid var(--rule-soft)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--ink)",
  padding: "4px 8px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  outline: "none",
  minWidth: 220,
};

function chipStyle(tone: "muted" | "ok" | "warn"): React.CSSProperties {
  const border =
    tone === "ok"
      ? "var(--accent-edge)"
      : tone === "warn"
        ? "color-mix(in oklch, var(--danger) 55%, var(--rule-soft))"
        : "var(--rule-soft)";
  const bg = tone === "ok" ? "var(--accent-soft)" : "var(--bg)";
  return {
    height: 30,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 10px",
    border: `1px solid ${border}`,
    borderRadius: 5,
    background: bg,
  };
}

const chipLabelStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.14em",
  color: "var(--muted)",
  textTransform: "uppercase",
};

const chipValueStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--ink-dim)",
  whiteSpace: "nowrap",
};

function actionButtonStyle(disabled: boolean, accent: boolean): React.CSSProperties {
  return {
    height: 30,
    minWidth: 110,
    padding: "0 14px",
    border: `1px solid ${accent ? "var(--accent-edge)" : "var(--rule-soft)"}`,
    borderRadius: 5,
    background: disabled ? "transparent" : accent ? "var(--accent-soft)" : "var(--bg)",
    color: disabled ? "var(--muted)" : "var(--ink)",
    fontFamily: "var(--font-sans)",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.1em",
    cursor: disabled ? "not-allowed" : "default",
  };
}

function statusPillStyle(tone: "muted" | "ok" | "warn" | "danger"): React.CSSProperties {
  const color =
    tone === "ok"
      ? "var(--accent-edge)"
      : tone === "warn"
        ? "color-mix(in oklch, var(--accent-edge) 70%, transparent)"
        : tone === "danger"
          ? "var(--danger)"
          : "var(--rule-soft)";
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    height: 26,
    padding: "0 10px",
    border: `1px solid ${color}`,
    borderRadius: 999,
    background: "var(--bg)",
    color: tone === "danger" ? "var(--danger)" : "var(--ink-dim)",
    fontFamily: "var(--font-sans)",
    fontSize: 11,
    maxWidth: 360,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  };
}

function statusDotStyle(tone: "muted" | "ok" | "warn" | "danger"): React.CSSProperties {
  const color =
    tone === "ok"
      ? "var(--accent-edge)"
      : tone === "warn"
        ? "var(--accent-edge)"
        : tone === "danger"
          ? "var(--danger)"
          : "var(--muted)";
  return { width: 7, height: 7, borderRadius: 999, background: color };
}

function stageBadgeStyle(tone: "muted" | "ok" | "warn" | "danger"): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 8px",
    border: `1px solid ${
      tone === "ok"
        ? "var(--accent-edge)"
        : tone === "warn"
          ? "var(--accent-edge)"
          : tone === "danger"
            ? "var(--danger)"
            : "var(--rule-soft)"
    }`,
    borderRadius: 999,
    fontFamily: "var(--font-sans)",
    fontSize: 10,
    fontWeight: 600,
    color: tone === "danger" ? "var(--danger)" : "var(--ink-dim)",
    background: "var(--bg)",
  };
}

const mainStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "minmax(280px, 30%) minmax(0, 1fr)",
};

const leftColStyle: React.CSSProperties = {
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid var(--rule-soft)",
};

const rightColStyle: React.CSSProperties = {
  minHeight: 0,
  overflow: "auto",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const paneTitleStyle: React.CSSProperties = {
  flex: "0 0 auto",
  height: 34,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0 14px",
  borderBottom: "1px solid var(--rule-soft)",
  background: "var(--panel)",
};

const paneTitleLabelStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.16em",
  color: "var(--ink-dim)",
  textTransform: "uppercase",
};

const paneTitleRightStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--muted)",
};

const planPreStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  margin: 0,
  padding: 16,
  overflow: "auto",
  background: "var(--bg)",
  color: "var(--ink-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

function cardStyle(status: StageStatus): React.CSSProperties {
  const dimmed = status === "locked";
  return {
    border: "1px solid var(--rule-soft)",
    borderRadius: 8,
    background: "var(--panel)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    opacity: dimmed ? 0.7 : 1,
  };
}

const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
  padding: "12px 14px",
  borderBottom: "1px solid var(--rule-soft)",
};

const cardTitleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};

const cardTitleStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.14em",
  color: "var(--ink)",
  textTransform: "uppercase",
};

const cardSubtitleStyle: React.CSSProperties = {
  marginTop: 4,
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--muted)",
  lineHeight: 1.45,
  maxWidth: 620,
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "0 8px",
  borderBottom: "1px solid var(--rule-soft)",
  background: "var(--panel-2)",
};

function tabStyle(active: boolean, tone?: "danger"): React.CSSProperties {
  return {
    height: 30,
    padding: "0 10px",
    border: "none",
    background: "transparent",
    color: active ? (tone === "danger" ? "var(--danger)" : "var(--ink)") : "var(--ink-dim)",
    fontFamily: "var(--font-sans)",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    borderBottom: active
      ? `2px solid ${tone === "danger" ? "var(--danger)" : "var(--accent-edge)"}`
      : "2px solid transparent",
    cursor: "default",
  };
}

function cardPreStyle(error: boolean): React.CSSProperties {
  return {
    margin: 0,
    padding: 14,
    minHeight: 200,
    maxHeight: 480,
    overflow: "auto",
    background: "var(--bg)",
    color: error ? "var(--danger)" : "var(--ink-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  };
}

const cardFooterStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderTop: "1px solid var(--rule-soft)",
  background: "var(--panel-2)",
};

const cardFooterHintStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  color: "var(--muted)",
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const metricsHintStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  color: "var(--muted)",
};

const metricStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: 6,
};

const metricLabelStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.14em",
  color: "var(--muted)",
  textTransform: "uppercase",
};

const metricValueStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--ink)",
};

const copyButtonStyle: React.CSSProperties = {
  height: 22,
  padding: "0 8px",
  border: "1px solid var(--rule-soft)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--ink-dim)",
  fontFamily: "var(--font-sans)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.12em",
  cursor: "default",
};

const workerLayoutStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(180px, 220px) minmax(0, 1fr)",
  minHeight: 0,
  maxHeight: 460,
};

const workerListStyle: React.CSSProperties = {
  minHeight: 0,
  overflow: "auto",
  borderRight: "1px solid var(--rule-soft)",
  background: "var(--panel-2)",
};

function workerItemStyle(active: boolean): React.CSSProperties {
  return {
    width: "100%",
    border: "none",
    borderBottom: "1px solid var(--rule-soft)",
    background: active ? "var(--hover-strong)" : "transparent",
    color: active ? "var(--ink)" : "var(--ink-dim)",
    textAlign: "left",
    padding: "10px 12px",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    cursor: "default",
  };
}

const workerItemTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: 2,
};

const workerItemMetaStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--muted)",
};

const workerPreStyle: React.CSSProperties = {
  margin: 0,
  padding: 14,
  overflow: "auto",
  background: "var(--bg)",
  color: "var(--ink-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

function bannerStyle(tone: "warn"): React.CSSProperties {
  return {
    flex: "0 0 auto",
    padding: "10px 18px",
    borderBottom: "1px solid var(--rule-soft)",
    background: "var(--panel-2)",
    color: tone === "warn" ? "var(--danger)" : "var(--ink-dim)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
  };
}

const emptyStateStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  color: "var(--muted)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  textAlign: "center",
};
