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

export interface OpenRouterManagerRequest {
  model: string;
  temperature: number;
  response_format: { type: "json_object" };
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
  mode?: "step_planning" | "worker_result_review";
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
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are Spark Agent, a local-first coding manager.",
          "You do not edit code yourself. You plan focused worker tasks for local Claude Code and Codex CLI workers.",
          "Keep the human-facing flow simple: ask a question only when the project plan is missing a required decision.",
          "For worker-result review, decide whether accepted worker evidence is enough to continue, complete, retry, or ask the user.",
          "Return strict JSON only. Do not wrap the JSON in markdown.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "Decide the next manager action for this Spark Agent run.",
          "",
          "PRODUCT INTENT",
          "- Spark Agent uses a cheap-ish manager model through OpenRouter.",
          "- Claude Code and Codex are local subscription-backed workers and should do the implementation work.",
          "- For this integration spike, create no more than two worker tasks.",
          "- Prefer one Claude task and one Codex task when the work can be split without conflict.",
          "- If the plan is too ambiguous, ask one concise human question instead of guessing.",
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
          "WORKER REPORTS",
          JSON.stringify(input.workerReports ?? [], null, 2),
          "",
          "PROJECT PLAN",
          truncate(activePlan?.rawContent || activePlan?.summary || "No plan content was provided.", 24000),
          "",
          "Return JSON with this shape:",
          JSON.stringify(
            {
              status: "run_workers | ask_user | complete",
              summary: "short manager summary",
              question: "only when status is ask_user",
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
                  description: "focused task prompt",
                  runtimePreference: "claude | codex | manual | shell",
                  modelHint: "optional",
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
    decision: normalizeManagerDecision(parsed),
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

function normalizeManagerDecision(raw: Record<string, unknown>): SparkManagerDecision {
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
    .slice(0, 2)
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
