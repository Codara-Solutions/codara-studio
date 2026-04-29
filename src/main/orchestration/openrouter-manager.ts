import type { AppSettings, RunState, WorkerRuntime, WorkerTask } from "@shared/types";

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface SparkManagerStepDecision {
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  verificationCommands: string[];
  riskLevel?: "low" | "medium" | "high";
}

export interface SparkManagerTaskDecision {
  stepIndex?: number;
  title: string;
  description: string;
  runtimePreference: WorkerRuntime;
  modelHint?: string;
  effortHint?: WorkerTask["effortHint"];
  allowedPaths: string[];
  forbiddenPaths: string[];
  expectedOutputs: string[];
  verificationCommands: string[];
  canRunParallel: boolean;
  conflictsWith: string[];
}

export interface SparkManagerDecision {
  status: "run_workers" | "ask_user" | "complete";
  summary: string;
  question?: string;
  steps: SparkManagerStepDecision[];
  tasks: SparkManagerTaskDecision[];
}

export interface SparkManagerWorkerReportContext {
  taskTitle: string;
  runtime: WorkerRuntime;
  taskStatus: WorkerTask["status"];
  attemptStatus: string;
  reportStatus?: string;
  summary?: string;
  proof: string[];
  risks: string[];
  followups: string[];
}

interface OpenRouterMessage {
  role: "system" | "user";
  content: string;
}

type OpenRouterManagerMode = "plan_analysis" | "step_planning" | "worker_result_review";

export interface OpenRouterManagerRequest {
  model: string;
  temperature: number;
  provider: {
    require_parameters: true;
  };
  response_format: {
    type: "json_schema";
    json_schema: {
      name: "spark_manager_decision";
      strict: true;
      schema: Record<string, unknown>;
    };
  };
  messages: OpenRouterMessage[];
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

export interface OpenRouterManagerResult {
  decision: SparkManagerDecision;
  rawResponse: OpenRouterResponse;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-flash-latest";
const SPARK_MANAGER_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "question", "steps", "tasks"],
  properties: {
    status: {
      type: "string",
      enum: ["run_workers", "ask_user", "complete"],
      description: "The next manager action.",
    },
    summary: {
      type: "string",
      description: "Short explanation of the manager decision.",
    },
    question: {
      type: "string",
      description: "Concise question for the human. Empty unless status is ask_user.",
    },
    steps: {
      type: "array",
      description: "Durable step-by-step division. Empty unless mode asks for steps.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "goal", "acceptanceCriteria", "verificationCommands", "riskLevel"],
        properties: {
          title: { type: "string" },
          goal: { type: "string" },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          verificationCommands: { type: "array", items: { type: "string" } },
          riskLevel: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    tasks: {
      type: "array",
      description: "Worker tasks for only the next active/queued step. Empty in plan_analysis or complete.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "stepIndex",
          "title",
          "description",
          "runtimePreference",
          "modelHint",
          "effortHint",
          "allowedPaths",
          "forbiddenPaths",
          "expectedOutputs",
          "verificationCommands",
          "canRunParallel",
          "conflictsWith",
        ],
        properties: {
          stepIndex: { type: "integer", minimum: 0 },
          title: { type: "string" },
          description: { type: "string" },
          runtimePreference: { type: "string", enum: ["claude", "codex", "manual", "shell"] },
          modelHint: { type: "string" },
          effortHint: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
          allowedPaths: { type: "array", items: { type: "string" } },
          forbiddenPaths: { type: "array", items: { type: "string" } },
          expectedOutputs: { type: "array", items: { type: "string" } },
          verificationCommands: { type: "array", items: { type: "string" } },
          canRunParallel: { type: "boolean" },
          conflictsWith: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export function readOpenRouterConfig(settings?: AppSettings): OpenRouterConfig | null {
  const apiKey = (
    settings?.openRouterApiKey ||
    process.env.SPARK_OPENROUTER_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    ""
  ).trim();
  if (!apiKey) return null;

  return {
    apiKey,
    baseUrl: (process.env.SPARK_OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, ""),
    model: (settings?.openRouterModel || process.env.SPARK_OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL).trim(),
  };
}

export function buildOpenRouterManagerRequest(input: {
  run: RunState;
  cwd: string;
  model: string;
  mode?: OpenRouterManagerMode;
  workerReports?: SparkManagerWorkerReportContext[];
}): OpenRouterManagerRequest {
  const mode = input.mode ?? "step_planning";
  const activePlan = input.run.planId
    ? input.run.plans.find((plan) => plan.id === input.run.planId)
    : input.run.plans.at(-1);
  const recentMessages = input.run.humanMessages.slice(-8).map((message) => ({
    author: message.author,
    kind: message.kind,
    message: message.message,
  }));

  return {
    model: input.model,
    temperature: 0.2,
    provider: {
      require_parameters: true,
    },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "spark_manager_decision",
        strict: true,
        schema: SPARK_MANAGER_DECISION_SCHEMA,
      },
    },
    messages: [
      {
        role: "system",
        content: [
          "You are Spark Agent, the local-first orchestrator for an autonomous coding workbench.",
          "Your context is treated as gold. Keep it compact, durable, and intentional.",
          "You do not edit project files yourself. You create plans, worker assignments, worker prompts, and review decisions for local Claude Code, Codex CLI, shell, or manual workers.",
          "The human should only select a workspace, select a Markdown plan, click run, pause, answer a necessary question, or correct direction.",
          "You own decomposition, worker count, worker runtime choice, model/effort hints, prompt quality, collision avoidance, and review.",
          "Ask the human one concise question only when a required product, scope, credential, destructive action, or safety decision is missing.",
          "Return JSON matching the provided schema only. Do not include markdown, prose outside JSON, or hidden reasoning.",
          "",
          "Core operating model:",
          "- First create a durable step-by-step division of the project plan. Each step is a batch: all workers in one step may run at the same time.",
          "- After the step division exists, assume your previous planning context is wiped. Future decisions must work from only the project plan, saved step division, current step, worker reports, and human messages.",
          "- For the current step, create the least amount of work per worker. Scale with more independent workers when it is useful, but never split tasks that can collide or need sequential state.",
          "- When a worker finishes, review only its assignment, final report, relevant evidence, the plan, and the step division. Accept, ask, or create the smallest follow-up task.",
          "- The app persists state; do not rely on memory. Put concrete goals, acceptance criteria, verification commands, expected artifacts, and final-report requirements into structured fields.",
          "",
          "Worker prompt engineering rules:",
          "- Every worker prompt must be specific enough that the worker can act without asking what to do.",
          "- Include objective, workspace context, assigned step, exact task, allowed/forbidden paths when known, constraints, verification, and expected final report.",
          "- Tell workers what evidence to produce: changed files, commands/tests run, proof, risks, and follow-ups.",
          "- Keep implementation prompts free of big code dumps unless the plan explicitly requires exact code.",
          "- Prefer Claude for broad exploration, architecture-sensitive implementation, ambiguous UI/product work, and repo-level reasoning.",
          "- Prefer Codex for precise code edits, refactors, tests, validation, and bug fixes.",
          "- Prefer shell only for deterministic command-only tasks. Prefer manual only when execution cannot be automated safely.",
          "- Use modelHint and effortHint as hints for the local worker CLI when helpful; the human does not configure workers per task.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "Decide the next manager action for this Spark Agent run.",
          "",
          "PRODUCT INTENT",
          "- Spark Agent is the manager/orchestrator. It should make the app feel simple: plan selected, run clicked, workers appear and execute.",
          "- The manager model runs through OpenRouter and should stay cheap-ish by using compact context packets.",
          "- Claude Code and Codex are local subscription-backed workers and should do implementation work.",
          "- Spark decides worker runtime, model hints, effort hints, parallelism, and prompts. The human does not configure Claude/Codex per task.",
          "- A step is a parallel batch. Everything inside one step may run at the same time, so avoid overlapping write scopes.",
          "- Use one worker when the task is naturally sequential or small. Use more workers only for truly independent workstreams.",
          "- If the selected plan is too ambiguous, ask one concise human question instead of guessing.",
          "- Obey the mode-specific output rules below exactly.",
          "- During worker-result review, return complete when the plan is satisfied; otherwise create only the next necessary follow-up tasks.",
          "",
          "MANAGER MODE",
          mode,
          "",
          "WORKSPACE",
          input.cwd,
          "",
          "RUN STATE",
          JSON.stringify(
            {
              id: input.run.id,
              title: input.run.title,
              status: input.run.status,
              existingSteps: input.run.steps.map((step) => ({
                id: step.id,
                title: step.title,
                status: step.status,
                reviewSummary: step.reviewSummary,
              })),
              existingTasks: input.run.workerTasks.map((task) => ({
                id: task.id,
                title: task.title,
                runtimePreference: task.runtimePreference,
                status: task.status,
                expectedOutputs: task.expectedOutputs,
              })),
              workerAttempts: input.run.workerAttempts.map((attempt) => ({
                workerTaskId: attempt.workerTaskId,
                runtime: attempt.runtime,
                status: attempt.status,
                exitCode: attempt.exitCode,
                finalReportPath: attempt.finalReportPath,
              })),
              recentMessages,
            },
            null,
            2,
          ),
          "",
          "STEP-BY-STEP DIVISION",
          formatStepDivision(input.run),
          "",
          "WORKER REPORTS",
          JSON.stringify(input.workerReports ?? [], null, 2),
          "",
          "PROJECT PLAN",
          truncate(activePlan?.rawContent || activePlan?.summary || "No plan content was provided.", 24000),
          "",
          "MODE-SPECIFIC OUTPUT RULES",
          formatModeRules(mode),
          "",
          "Return JSON with this shape:",
          JSON.stringify(
            {
              status: "run_workers | ask_user | complete",
              summary: "short manager summary",
              question: "only when status is ask_user, otherwise empty string",
              steps: [
                {
                  title: "Step title",
                  goal: "Step goal",
                  acceptanceCriteria: ["clear acceptance criteria"],
                  verificationCommands: ["npm run typecheck"],
                  riskLevel: "low | medium | high",
                },
              ],
              tasks: [
                {
                  stepIndex: 0,
                  title: "Worker task title",
                  description: "full high-quality worker prompt for the assigned task",
                  runtimePreference: "claude | codex | manual | shell",
                  modelHint: "optional, empty string if not needed",
                  effortHint: "low | medium | high | xhigh",
                  allowedPaths: ["optional paths"],
                  forbiddenPaths: ["optional paths"],
                  expectedOutputs: ["expected artifact or result"],
                  verificationCommands: ["npm run typecheck"],
                  canRunParallel: true,
                  conflictsWith: [],
                },
              ],
            },
            null,
            2,
          ),
        ].join("\n"),
      },
    ],
  };
}

export async function requestOpenRouterManagerDecision(
  config: OpenRouterConfig,
  requestBody: OpenRouterManagerRequest,
  mode: OpenRouterManagerMode,
): Promise<OpenRouterManagerResult> {
  const started = Date.now();
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://spark-agent.local",
      "X-Title": "Spark Agent",
    },
    body: JSON.stringify(requestBody),
  });

  const rawResponse = (await response.json().catch(() => ({}))) as OpenRouterResponse;
  if (!response.ok) {
    throw new Error(rawResponse.error?.message || `OpenRouter request failed with ${response.status}`);
  }

  const content = extractMessageContent(rawResponse);
  const parsed = parseJsonObject(content);
  return {
    decision: normalizeManagerDecision(parsed, mode),
    rawResponse,
    durationMs: Date.now() - started,
    promptTokens: rawResponse.usage?.prompt_tokens,
    completionTokens: rawResponse.usage?.completion_tokens,
  };
}

function extractMessageContent(response: OpenRouterResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  throw new Error("OpenRouter response did not include message content.");
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = JSON.parse(withoutFence) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Manager decision was not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function normalizeManagerDecision(raw: Record<string, unknown>, mode: OpenRouterManagerMode): SparkManagerDecision {
  const status = normalizeStatus(raw.status);
  const steps = normalizeSteps(raw.steps);
  const tasks = normalizeTasks(raw.tasks);
  const question = typeof raw.question === "string" ? raw.question.trim() : undefined;

  if (status === "ask_user") {
    return {
      status,
      summary: normalizeText(raw.summary, "Spark needs user input before creating worker tasks."),
      question: question || "Please clarify the next decision Spark should make.",
      steps: [],
      tasks: [],
    };
  }

  if (status === "complete") {
    return {
      status,
      summary: normalizeText(raw.summary, "Spark thinks the run is complete."),
      steps: [],
      tasks: [],
    };
  }

  if (mode === "plan_analysis") {
    if (steps.length === 0) {
      return {
        status: "ask_user",
        summary: "Spark could not create a step-by-step division from the plan.",
        question: question || "Please clarify the concrete outcome this project plan should produce.",
        steps: [],
        tasks: [],
      };
    }

    return {
      status: "run_workers",
      summary: normalizeText(raw.summary, "Spark analyzed the plan into concrete steps."),
      steps,
      tasks: [],
    };
  }

  if (tasks.length === 0) {
    return {
      status: "ask_user",
      summary: "Spark could not produce a worker task from the plan.",
      question: question || "Please clarify the first concrete task to run.",
      steps: [],
      tasks: [],
    };
  }

  return {
    status: "run_workers",
    summary: normalizeText(raw.summary, "Spark planned the next worker task."),
    steps,
    tasks: tasks.slice(0, 2),
  };
}

function normalizeStatus(value: unknown): SparkManagerDecision["status"] {
  if (value === "run_workers" || value === "ask_user" || value === "complete") return value;
  return "run_workers";
}

function normalizeSteps(value: unknown): SparkManagerStepDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .slice(0, 12)
    .map((item, index) => ({
      title: normalizeText(item.title, `Spark planned step ${index + 1}`),
      goal: normalizeText(item.goal, "Complete the next concrete part of the selected plan."),
      acceptanceCriteria: normalizeStringList(item.acceptanceCriteria),
      verificationCommands: normalizeStringList(item.verificationCommands),
      riskLevel: normalizeRisk(item.riskLevel),
    }));
}

function normalizeTasks(value: unknown): SparkManagerTaskDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => ({
      stepIndex: typeof item.stepIndex === "number" ? item.stepIndex : 0,
      title: normalizeText(item.title, `Spark worker task ${index + 1}`),
      description: normalizeText(item.description, "Work on the next focused implementation task."),
      runtimePreference: normalizeRuntime(item.runtimePreference),
      modelHint: typeof item.modelHint === "string" ? item.modelHint : undefined,
      effortHint: normalizeEffort(item.effortHint),
      allowedPaths: normalizeStringList(item.allowedPaths),
      forbiddenPaths: normalizeStringList(item.forbiddenPaths),
      expectedOutputs: normalizeStringList(item.expectedOutputs),
      verificationCommands: normalizeStringList(item.verificationCommands),
      canRunParallel: item.canRunParallel === true,
      conflictsWith: normalizeStringList(item.conflictsWith),
    }));
}

function normalizeRuntime(value: unknown): WorkerRuntime {
  if (value === "claude" || value === "codex" || value === "manual" || value === "shell") return value;
  return "manual";
}

function normalizeEffort(value: unknown): WorkerTask["effortHint"] {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return undefined;
}

function normalizeRisk(value: unknown): SparkManagerStepDecision["riskLevel"] {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated]`;
}

function formatStepDivision(run: RunState): string {
  if (run.steps.length === 0) return "No step-by-step division exists yet.";
  return run.steps
    .map((step) =>
      [
        `${step.index}. ${step.title}`,
        `Goal: ${step.goal}`,
        `Status: ${step.status}`,
        `Acceptance: ${step.acceptanceCriteria.length ? step.acceptanceCriteria.join("; ") : "not specified"}`,
        `Verification: ${step.verificationCommands.length ? step.verificationCommands.join("; ") : "not specified"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function formatModeRules(mode: OpenRouterManagerMode): string {
  if (mode === "plan_analysis") {
    return [
      "- Return status run_workers with the full durable step-by-step division in steps.",
      "- Return tasks as an empty array. Do not generate implementation prompts in this mode.",
      "- Each step is a parallel execution batch and must be independently understandable after manager context is wiped.",
      "- Each step must describe the outcome, boundaries, acceptance criteria, verification commands, and risk level.",
      "- Prefer several small sequential steps over one vague large step.",
      "- Ask the user if the plan lacks a required product decision, scope boundary, or safety approval.",
      "- Set question to an empty string unless status is ask_user.",
    ].join("\n");
  }

  if (mode === "step_planning") {
    return [
      "- Do not rewrite the full step division unless a small correction is necessary.",
      "- Create worker tasks only for the first queued or active step. The task.stepIndex must point at that step.",
      "- The worker task description must be the actual high-quality prompt the worker will receive: objective, context, exact scope, constraints, validation, final-report expectations, and collision warnings.",
      "- Choose runtimePreference, modelHint, and effortHint yourself.",
      "- Keep write scopes independent. If two tasks might edit the same file or need each other's output, use one task.",
      "- Use no more than two tasks for now, and only split when they can run at the same time without shared state.",
      "- Set question to an empty string unless status is ask_user.",
    ].join("\n");
  }

  return [
    "- Review worker reports against the project plan and step acceptance criteria.",
    "- Return complete only when evidence satisfies the plan.",
    "- If work remains, create the smallest necessary follow-up worker tasks.",
    "- If a worker failed because the prompt was insufficient, create a better prompt for a new attempt and include the missing context.",
    "- Ask the user only when a product decision or correction is required.",
    "- Set question to an empty string unless status is ask_user.",
  ].join("\n");
}
