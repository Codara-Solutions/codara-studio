import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  PromptLabSaveDraftInput,
  PromptLabSimulateStageInput,
  PromptLabSimulateStageResult,
  PromptLabState,
  PromptLabStepResult,
  RunState,
  SparkManagerMode,
  SparkPromptLabWorkerPromptPreview,
  StepState,
  WorkerTask,
} from "@shared/types";
import { loadSettings } from "../storage";
import { detectAgentRuntimes } from "../agent-runtimes";
import {
  buildOpenRouterManagerRequest,
  readOpenRouterConfig,
  requestOpenRouterManagerDecision,
  type SparkManagerDecision,
} from "./openrouter-manager";
import {
  finishLangSmithManagerTrace,
  readLangSmithConfig,
  startLangSmithManagerTrace,
  type LangSmithTrace,
} from "./langsmith-tracer";
import {
  DEFAULT_MANAGER_PROMPT_PROFILE,
  buildDefaultManagerSystemPrompt,
  normalizeManagerPromptProfile,
  resetManagerPromptProfileCache,
  type ManagerPromptProfile,
} from "./prompt-profile";

const ORCHESTRATION_DIR = join(process.cwd(), "resources", "orchestration");
const LIVE_PROFILE_PATH = join(ORCHESTRATION_DIR, "manager-profile.json");
const DRAFT_PROFILE_PATH = join(ORCHESTRATION_DIR, "manager-profile.draft.json");
const FIXTURE_PATH = join(ORCHESTRATION_DIR, "lab-fixtures", "calculator-run.json");

export async function getPromptLabState(): Promise<PromptLabState> {
  await ensurePromptLabFiles();
  const [draftProfileText, liveProfileText, fixtureText] = await Promise.all([
    fs.readFile(DRAFT_PROFILE_PATH, "utf8"),
    fs.readFile(LIVE_PROFILE_PATH, "utf8"),
    fs.readFile(FIXTURE_PATH, "utf8"),
  ]);
  const profile = normalizeManagerPromptProfile(JSON.parse(draftProfileText) as unknown);
  const settings = await loadSettings();
  const openRouter = readOpenRouterConfig(settings);
  const langSmith = readLangSmithConfig(settings);

  return {
    draftProfilePath: DRAFT_PROFILE_PATH,
    liveProfilePath: LIVE_PROFILE_PATH,
    fixturePath: FIXTURE_PATH,
    draftProfileText,
    liveProfileText,
    fixtureText,
    defaultFlow: profile.lab.defaultFlow,
    defaultModel: settings.openRouterModel || "google/gemini-flash-latest",
    langSmithProject: langSmith?.project,
    langSmithEndpoint: langSmith?.endpoint,
    openRouterConfigured: Boolean(openRouter),
    langSmithConfigured: Boolean(langSmith),
    defaultSystemPrompt: buildDefaultManagerSystemPrompt(profile),
    modeSystemPromptOverrides: profile.manager.systemPromptOverrides ?? {},
  };
}

export async function savePromptLabDraft(input: PromptLabSaveDraftInput): Promise<PromptLabState> {
  const parsed = JSON.parse(input.profileText) as unknown;
  const normalized = normalizeManagerPromptProfile(parsed);
  await writeJson(DRAFT_PROFILE_PATH, normalized);
  return getPromptLabState();
}

export async function resetPromptLabDraftFromLive(): Promise<PromptLabState> {
  await ensurePromptLabFiles();
  await fs.copyFile(LIVE_PROFILE_PATH, DRAFT_PROFILE_PATH);
  return getPromptLabState();
}

export async function applyPromptLabDraftToApp(input: PromptLabSaveDraftInput): Promise<PromptLabState> {
  const parsed = JSON.parse(input.profileText) as unknown;
  const normalized = normalizeManagerPromptProfile(parsed);
  await writeJson(DRAFT_PROFILE_PATH, normalized);
  await writeJson(LIVE_PROFILE_PATH, normalized);
  resetManagerPromptProfileCache();
  return getPromptLabState();
}

export async function buildPromptLabStage(
  input: PromptLabSimulateStageInput,
): Promise<PromptLabSimulateStageResult> {
  return evaluatePromptLabStage(input, false);
}

export async function simulatePromptLabStage(
  input: PromptLabSimulateStageInput,
): Promise<PromptLabSimulateStageResult> {
  return evaluatePromptLabStage(input, true);
}

async function evaluatePromptLabStage(
  input: PromptLabSimulateStageInput,
  callModel: boolean,
): Promise<PromptLabSimulateStageResult> {
  const profile = normalizeManagerPromptProfile(JSON.parse(input.profileText) as unknown);
  const run = input.runStateOverride
    ? cloneRunState(input.runStateOverride)
    : normalizeLabRun(JSON.parse(input.fixtureText) as Partial<RunState>, input.cwd);

  const settings = await loadSettings();
  const config = callModel ? readOpenRouterConfig(settings) : null;
  if (callModel && !config) {
    throw new Error("OpenRouter is not configured. Add the API key in Settings before simulating.");
  }
  const langSmithConfig = callModel ? readLangSmithConfig(settings) : null;
  const availableRuntimes = await detectAgentRuntimes().catch(() => []);
  const requestModel = (input.model ?? "").trim() || settings.openRouterModel || "google/gemini-flash-latest";
  const request = buildOpenRouterManagerRequest({
    run,
    cwd: input.cwd,
    model: requestModel,
    mode: input.mode,
    workerReports: [],
    availableRuntimes,
    promptProfile: profile,
  });
  if (Number.isFinite(input.temperature)) {
    request.temperature = input.temperature as number;
  }

  if (!callModel) {
    return {
      step: {
        mode: input.mode,
        request,
        workerPromptPreviews: [],
      },
      updatedRun: run,
    };
  }

  const started = Date.now();
  const sessionId = `prompt-lab-${randomUUID()}`;
  let trace: LangSmithTrace | null = null;
  try {
    trace = await safeStartLabTrace({
      config: langSmithConfig,
      sessionId,
      mode: input.mode,
      request,
    });
    const result = await requestOpenRouterManagerDecision(config!, request, input.mode);
    await safeFinishLabTrace({
      config: langSmithConfig,
      trace,
      output: {
        decision: result.decision,
        durationMs: result.durationMs,
        model: result.model,
        fallbackFrom: result.fallbackFrom,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      },
    });
    const workerPromptPreviews = buildWorkerPromptPreviews({
      run,
      cwd: input.cwd,
      decision: result.decision,
      profile,
    });
    applyDecisionToRun(run, result.decision);
    return {
      step: {
        mode: input.mode,
        request,
        durationMs: result.durationMs || Date.now() - started,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        decision: result.decision as unknown as Record<string, unknown>,
        rawResponse: result.rawResponse,
        workerPromptPreviews,
        langSmithTraceId: trace?.id,
        langSmithProject: langSmithConfig?.project,
        langSmithEndpoint: langSmithConfig?.endpoint,
      },
      updatedRun: run,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await safeFinishLabTrace({
      config: langSmithConfig,
      trace,
      error: errorMessage,
    });
    return {
      step: {
        mode: input.mode,
        request,
        durationMs: Date.now() - started,
        workerPromptPreviews: [],
        error: errorMessage,
        langSmithTraceId: trace?.id,
        langSmithProject: langSmithConfig?.project,
        langSmithEndpoint: langSmithConfig?.endpoint,
      },
      updatedRun: run,
    };
  }
}

function cloneRunState(run: RunState): RunState {
  return JSON.parse(JSON.stringify(run)) as RunState;
}

async function safeStartLabTrace(input: {
  config: ReturnType<typeof readLangSmithConfig>;
  sessionId: string;
  mode: SparkManagerMode;
  request: ReturnType<typeof buildOpenRouterManagerRequest>;
}): Promise<LangSmithTrace | null> {
  if (!input.config) return null;
  try {
    return await startLangSmithManagerTrace({
      config: input.config,
      runId: input.sessionId,
      workspaceId: "prompt-lab",
      sparkCallId: `${input.sessionId}-${input.mode}`,
      mode: input.mode,
      requestBody: input.request,
    });
  } catch (err) {
    console.warn("[prompt-lab] failed to start LangSmith trace:", err);
    return null;
  }
}

async function safeFinishLabTrace(input: {
  config: ReturnType<typeof readLangSmithConfig>;
  trace: LangSmithTrace | null;
  output?: unknown;
  error?: string;
}): Promise<void> {
  if (!input.config || !input.trace) return;
  try {
    await finishLangSmithManagerTrace({
      config: input.config,
      trace: input.trace,
      output: input.output,
      error: input.error,
    });
  } catch (err) {
    console.warn("[prompt-lab] failed to finish LangSmith trace:", err);
  }
}

async function ensurePromptLabFiles(): Promise<void> {
  await fs.mkdir(ORCHESTRATION_DIR, { recursive: true });
  await fs.mkdir(dirname(FIXTURE_PATH), { recursive: true });
  await ensureJsonFile(LIVE_PROFILE_PATH, DEFAULT_MANAGER_PROMPT_PROFILE);
  await ensureJsonFile(DRAFT_PROFILE_PATH, await readJsonOrDefault(LIVE_PROFILE_PATH, DEFAULT_MANAGER_PROMPT_PROFILE));
  await ensureJsonFile(FIXTURE_PATH, defaultFixtureRun());
}

async function ensureJsonFile(path: string, value: unknown): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    await writeJson(path, value);
  }
}

async function readJsonOrDefault(path: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeLabRun(raw: Partial<RunState>, cwd: string): RunState {
  const now = new Date().toISOString();
  const planId = raw.planId || raw.plans?.[0]?.id || "lab-plan";
  return {
    id: raw.id || "lab-run",
    workspaceId: raw.workspaceId || "lab-workspace",
    planId,
    title: raw.title || "Prompt Lab Run",
    status: raw.status || "running",
    currentStepId: raw.currentStepId,
    pipelinePreset: raw.pipelinePreset || "prompt-lab",
    settingsSnapshot: raw.settingsSnapshot,
    artifactDir: raw.artifactDir || cwd,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    plans: raw.plans?.length
      ? raw.plans
      : [
        {
          id: planId,
          workspaceId: raw.workspaceId || "lab-workspace",
          title: "Prompt Lab Plan",
          rawContent: "Build a small one-file HTML calculator.",
          requirements: [],
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
    steps: raw.steps ?? [],
    workerTasks: raw.workerTasks ?? [],
    workerAttempts: raw.workerAttempts ?? [],
    sparkCalls: raw.sparkCalls ?? [],
    humanMessages: raw.humanMessages ?? [],
    autopilot: raw.autopilot ?? {
      status: "running",
      updatedAt: now,
    },
  };
}

function buildWorkerPromptPreviews({
  run,
  cwd,
  decision,
  profile,
}: {
  run: RunState;
  cwd: string;
  decision: SparkManagerDecision;
  profile: ManagerPromptProfile;
}): SparkPromptLabWorkerPromptPreview[] {
  return decision.tasks.slice(0, 12).map((taskDecision, index) => {
    const step = resolveTaskStep(run, taskDecision.stepIndex);
    const task: WorkerTask = {
      id: `lab-task-preview-${index + 1}`,
      runId: run.id,
      stepId: step?.id,
      title: taskDecision.title,
      description: taskDecision.description,
      runtimePreference: taskDecision.runtimePreference,
      modelHint: taskDecision.modelHint,
      effortHint: taskDecision.effortHint,
      status: "created",
      allowedPaths: taskDecision.allowedPaths,
      forbiddenPaths: taskDecision.forbiddenPaths,
      expectedOutputs: taskDecision.expectedOutputs,
      verificationCommands: taskDecision.verificationCommands,
      canRunParallel: taskDecision.canRunParallel,
      conflictsWith: taskDecision.conflictsWith,
      createdBy: "spark",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return {
      title: task.title,
      runtimePreference: task.runtimePreference,
      modelHint: task.modelHint,
      effortHint: task.effortHint,
      prompt: renderLabWorkerPrompt({
        cwd,
        profile,
        step,
        task,
        finalReportPath: `prompt-lab/final-report-preview-${index + 1}.json`,
      }),
    };
  });
}

function renderLabWorkerPrompt({
  cwd,
  profile,
  step,
  task,
  finalReportPath,
}: {
  cwd: string;
  profile: ManagerPromptProfile;
  step?: StepState;
  task: WorkerTask;
  finalReportPath: string;
}): string {
  const lines: string[] = [
    ...profile.workerPrompt.opening,
    "",
    "## TASK",
    task.title,
    "",
    task.description,
  ];

  if (step) {
    lines.push("", "## STEP CONTEXT", `Step ${step.index}: ${step.title}`, `Goal: ${step.goal}`, `Status: ${step.status}`);
  }
  if (step?.acceptanceCriteria.length) {
    lines.push("", "## ACCEPTANCE", ...step.acceptanceCriteria.map((c) => `- ${c}`));
  }
  if (task.allowedPaths.length || task.forbiddenPaths.length || task.conflictsWith.length || task.canRunParallel) {
    lines.push("", "## BOUNDARIES");
    if (task.allowedPaths.length) lines.push("Allowed paths:", ...task.allowedPaths.map((p) => `- ${p}`));
    if (task.forbiddenPaths.length) lines.push("Forbidden paths:", ...task.forbiddenPaths.map((p) => `- ${p}`));
    if (task.canRunParallel) lines.push("- This task may be running alongside other workers. Keep your edits inside the assigned scope.");
    if (task.conflictsWith.length) lines.push("Conflicts with:", ...task.conflictsWith.map((id) => `- ${id}`));
  }
  if (task.expectedOutputs.length) {
    lines.push("", "## EXPECTED OUTPUTS", ...task.expectedOutputs.map((output) => `- ${output}`));
  }
  if (task.verificationCommands.length) {
    lines.push("", "## VERIFICATION", ...task.verificationCommands.map((command) => `- ${command}`));
  }
  lines.push(
    "",
    "## WORKSPACE",
    `Workspace: ${cwd}`,
    "",
    "## FINAL REPORT",
    `When done, write valid JSON to ${finalReportPath}.`,
    ...profile.workerPrompt.finalReportIntro,
    "Use: status, summary, files_changed, commands_run, tests, proof, risks, followups.",
  );
  return lines.join("\n");
}

function applyDecisionToRun(run: RunState, decision: SparkManagerDecision): void {
  if (decision.status !== "run_workers") return;
  const now = new Date().toISOString();
  if (decision.steps.length > 0) {
    run.steps = decision.steps.map((step, index) => ({
      id: `lab-step-${index + 1}`,
      runId: run.id,
      index: index + 1,
      title: step.title,
      goal: step.goal,
      kind: step.kind,
      plannedAgents: step.plannedAgents,
      status: "queued",
      riskLevel: step.riskLevel,
      acceptanceCriteria: step.acceptanceCriteria,
      verificationCommands: [],
      workerTaskIds: [],
      createdAt: now,
      updatedAt: now,
    }));
  }
  if (decision.tasks.length > 0) {
    run.workerTasks = decision.tasks.map((task, index) => {
      const id = `lab-task-${index + 1}`;
      const step = resolveTaskStep(run, task.stepIndex);
      if (step && !step.workerTaskIds.includes(id)) step.workerTaskIds.push(id);
      return {
        id,
        runId: run.id,
        stepId: step?.id,
        title: task.title,
        description: task.description,
        runtimePreference: task.runtimePreference,
        modelHint: task.modelHint,
        effortHint: task.effortHint,
        status: "created",
        allowedPaths: task.allowedPaths,
        forbiddenPaths: task.forbiddenPaths,
        expectedOutputs: task.expectedOutputs,
        verificationCommands: task.verificationCommands,
        canRunParallel: task.canRunParallel,
        conflictsWith: task.conflictsWith,
        createdBy: "spark",
        createdAt: now,
        updatedAt: now,
      };
    });
  }
  run.updatedAt = now;
}

function resolveTaskStep(run: RunState, stepIndex: number | undefined): StepState | undefined {
  if (run.steps.length === 0) return undefined;
  const index = typeof stepIndex === "number" ? stepIndex : 0;
  return run.steps[index] ?? run.steps[0];
}

function defaultFixtureRun(): Partial<RunState> {
  return {
    id: "lab-run-calculator",
    workspaceId: "lab-workspace",
    title: "Prompt Lab - Calculator Demo",
    status: "running",
    planId: "lab-plan-calculator",
    artifactDir: "prompt-lab",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    plans: [
      {
        id: "lab-plan-calculator",
        workspaceId: "lab-workspace",
        title: "One-file calculator",
        rawContent: [
          "# One-file calculator",
          "",
          "Build a polished one-file HTML calculator in `calculator.html`.",
          "",
          "Requirements:",
          "- Basic arithmetic: add, subtract, multiply, divide.",
          "- Keyboard input for numbers, operators, Enter, Backspace, Escape.",
          "- Clear display states for current value and previous operation.",
          "- Responsive layout that works on small screens.",
          "- No build step and no external dependencies.",
        ].join("\n"),
        requirements: [],
        status: "active",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    ],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [],
    humanMessages: [
      {
        id: "lab-message-1",
        runId: "lab-run-calculator",
        author: "user",
        kind: "note",
        message: "Keep the task small and make the worker prompt unambiguous.",
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    ],
    autopilot: {
      status: "running",
      lastAction: "prompt_lab_fixture",
      updatedAt: "2026-05-01T00:00:00.000Z",
    },
  };
}
