import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentRuntimeDiagnostic,
  AppSettings,
  PlannedStepAgent,
  RunState,
  StepKind,
  TaskComplexity,
  WorkerRuntime,
  WorkerTask,
} from "@shared/types";
import {
  buildManagerSystemPrompt,
  formatManagerModeRules,
  loadManagerPromptProfile,
  type ManagerPromptProfile,
} from "./prompt-profile";

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  structuredOutputFallbackModel: string;
}

export interface SparkManagerStepDecision {
  kind: StepKind;
  title: string;
  goal: string;
  plannedAgents: PlannedStepAgent[];
  acceptanceCriteria: string[];
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
  taskClass?: PlannedStepAgent["taskClass"];
}

export interface SparkManagerDecision {
  status: "run_workers" | "ask_user" | "complete";
  summary: string;
  question?: string;
  steps: SparkManagerStepDecision[];
  tasks: SparkManagerTaskDecision[];
  /**
   * Set by plan_analysis on the first manager call. Drives downstream
   * verifier depth (trivial=0, standard=1, complex=2) and the step cap.
   * Optional on later modes — those propagate the persisted RunState value.
   */
  taskComplexity?: TaskComplexity;
  /**
   * Natural-language reply addressed to the user. Populated only when the most
   * recent humanMessage is a fresh user note that asked Spark to do something
   * (or asked a question). Empty string otherwise. Surfaced as a Spark chat
   * bubble in the run chat — keep it 1-3 sentences, plain English, no JSON.
   */
  chatReply?: string;
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
  /**
   * Set when the worker that produced this report is a verifier-class
   * follow-up. The 5-confidence-ladder verdict the manager uses to decide
   * accept / retry-with-corrective_prompt / escalate.
   */
  verifier?: {
    status: "verified" | "failed" | "unsure";
    confidence: "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED";
    atomicClaims: Array<{ claim: string; verdict: string; evidence: string }>;
    correctivePrompt?: string;
    missingOracle?: string;
  };
  taskClass?: "skeleton" | "feature" | "leaf" | "verifier";
}

export interface OpenRouterMessage {
  role: "system" | "user";
  content: string;
}

export type OpenRouterManagerMode = "plan_analysis" | "step_planning" | "worker_result_review";

export interface OpenRouterManagerRequest {
  model: string;
  temperature: number;
  provider: {
    require_parameters: true;
    only?: string[];
    order?: string[];
    allow_fallbacks?: boolean;
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
  model: string;
  fallbackFrom?: string;
  promptTokens?: number;
  completionTokens?: number;
}

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-flash-latest";
const DEFAULT_STRUCTURED_OUTPUT_FALLBACK_MODEL = "openai/gpt-4o-mini";
const SPARK_MANAGER_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "question", "chatReply", "steps", "tasks", "taskComplexity"],
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
    chatReply: {
      type: "string",
      description:
        "Natural-language reply to the user, surfaced in the run chat as a Spark bubble. Populate ONLY when the most recent human message is a fresh user note/answer that asks for action or for a status update. 1-3 plain sentences, no JSON, no markdown headings. Empty string when there is no fresh user message to respond to.",
    },
    taskComplexity: {
      type: "string",
      enum: ["trivial", "standard", "complex", ""],
      description:
        "Required during plan_analysis: classify the WHOLE RUN's complexity. Drives verifier depth (trivial=0, standard=1, complex=2 peer verifiers) and the step cap. trivial: single-module fix, ≤3 atomic acceptance criteria, no public API touch (max 2 worker_batch steps, no recon, no skeleton). standard: multi-file change OR public API touch with clear scope (max 3-4 steps). complex: subtle/byte-level work where atomic claims compound, OR cross-module refactor with ≥3 files changing semantics (no step cap). Bias toward standard on uncertainty — false-trivial costs one redo via cascade, false-complex burns 9 workers. Empty string \"\" allowed only on step_planning / worker_result_review modes (those propagate the persisted classification).",
    },
    steps: {
      type: "array",
      description: "Durable step-by-step division. Empty unless mode asks for steps.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "goal", "plannedAgents", "acceptanceCriteria", "riskLevel"],
        properties: {
          kind: {
            type: "string",
            enum: ["worker_batch", "brake"],
            description:
              "worker_batch: 1+ parallel workers with non-overlapping write scopes. brake: no workers; plannedAgents=[]; checkpoint where Spark replans downstream steps using prior worker reports. HARD STOP: when you emit a brake, the steps array MUST end at that brake. Do not emit any step after a brake; Spark will re-invoke plan_analysis once the brake resolves and you will plan the next slice then.",
          },
          title: { type: "string" },
          goal: { type: "string" },
          plannedAgents: {
            type: "array",
            description: "Agents Spark plans to run in this step, as a compact durable overview. Empty array for kind=brake.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "summary", "runtimePreference", "modelHint", "effortHint", "taskClass"],
              properties: {
                label: { type: "string" },
                summary: { type: "string" },
                runtimePreference: { type: "string", enum: ["claude", "codex", "manual", "shell"] },
                modelHint: { type: "string" },
                effortHint: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh"] },
                taskClass: {
                  type: "string",
                  enum: ["skeleton", "feature", "leaf", "verifier"],
                  description:
                    "skeleton: architectural decisions later workers inherit (file layout, base components, state shape, design tokens) — strongest available model + highest effort. feature: standard implementation against an established skeleton — mid model + medium effort. leaf: mechanical, well-defined work (rename, plumb a known transformation, write tests against an existing API) — cheapest available model + low effort. verifier: read-only follow-up class spawned ONLY by worker_result_review after an implementation worker completes; never appears in a plan_analysis plannedAgents list — peer-strength model + high effort, allowedPaths=[], re-derives ground truth from filesystem.",
                },
              },
            },
          },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
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
          "taskClass",
        ],
        properties: {
          stepIndex: { type: "integer", minimum: 0 },
          title: { type: "string" },
          description: { type: "string" },
          runtimePreference: { type: "string", enum: ["claude", "codex", "manual", "shell"] },
          modelHint: { type: "string" },
          effortHint: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh"] },
          allowedPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Concrete write ownership for this worker. Implementation workers that can run in parallel MUST list non-overlapping files/directories here. Verifier tasks are read-only and should use [].",
          },
          forbiddenPaths: { type: "array", items: { type: "string" } },
          expectedOutputs: { type: "array", items: { type: "string" } },
          verificationCommands: { type: "array", items: { type: "string" } },
          canRunParallel: {
            type: "boolean",
            description:
              "true only when this task is safe to launch alongside another queued task. Implementation tasks require concrete non-overlapping allowedPaths. Use true for read-only verifier peers.",
          },
          conflictsWith: {
            type: "array",
            items: { type: "string" },
            description:
              "Task ids or labels this task must not overlap with. Add conflicts whenever same-file writes, shared migrations, or order-sensitive edits could collide.",
          },
          taskClass: {
            type: "string",
            enum: ["skeleton", "feature", "leaf", "verifier"],
            description:
              "Optional. Mirror the parent plannedAgent's taskClass. Use 'verifier' only when this task is a follow-up read-only re-execution check spawned by worker_result_review (never in plan_analysis). Defaults to 'feature' when omitted.",
          },
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
    structuredOutputFallbackModel: (
      process.env.SPARK_OPENROUTER_STRUCTURED_FALLBACK_MODEL ||
      DEFAULT_STRUCTURED_OUTPUT_FALLBACK_MODEL
    ).trim(),
  };
}

export function buildOpenRouterManagerRequest(input: {
  run: RunState;
  cwd: string;
  model: string;
  mode?: OpenRouterManagerMode;
  workerReports?: SparkManagerWorkerReportContext[];
  availableRuntimes?: AgentRuntimeDiagnostic[];
  promptProfile?: ReturnType<typeof loadManagerPromptProfile>;
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
  const promptProfile = input.promptProfile ?? loadManagerPromptProfile();

  return {
    model: input.model,
    temperature: 0.2,
    provider: buildProviderPreference(),
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
        content: buildManagerSystemPrompt(promptProfile, mode),
      },
      {
        role: "user",
        content: buildManagerUserMessage({
          mode,
          cwd: input.cwd,
          run: input.run,
          recentMessages,
          workerReports: input.workerReports,
          availableRuntimes: input.availableRuntimes,
          promptProfile,
          activePlanText: activePlan?.rawContent || activePlan?.summary || "No plan content was provided.",
        }),
      },
    ],
  };
}

// Build the OpenRouter `provider` preference block from env. `only` pins
// fulfillment to a specific upstream provider (e.g. "sambanova") for routes
// where we want guaranteed throughput / TPS. `allow_fallbacks=false` makes the
// request fail loudly instead of silently rerouting to a slow provider.
function buildProviderPreference(): OpenRouterManagerRequest["provider"] {
  const pref: OpenRouterManagerRequest["provider"] = { require_parameters: true };
  const onlyRaw = (process.env.SPARK_OPENROUTER_PROVIDER_ONLY ?? "").trim();
  if (onlyRaw) {
    const only = onlyRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (only.length > 0) {
      pref.only = only;
      pref.allow_fallbacks = false;
    }
  }
  return pref;
}

interface ManagerUserMessageInput {
  mode: OpenRouterManagerMode;
  cwd: string;
  run: RunState;
  recentMessages: Array<{ author: string; kind: string; message: string }>;
  workerReports: SparkManagerWorkerReportContext[] | undefined;
  availableRuntimes: AgentRuntimeDiagnostic[] | undefined;
  promptProfile: ManagerPromptProfile;
  activePlanText: string;
}

function buildManagerUserMessage(input: ManagerUserMessageInput): string {
  const { mode, cwd, run, recentMessages, workerReports, availableRuntimes, promptProfile, activePlanText } = input;
  const isPlanAnalysis = mode === "plan_analysis";

  const lines: string[] = [
    "Decide the next manager action for this Spark Agent run.",
    "",
    "PRODUCT INTENT",
    ...promptProfile.productIntent,
    "",
    "MANAGER MODE",
    mode,
    "",
  ];

  if (isPlanAnalysis) {
    // plan_analysis only needs to know what's already in the workspace so it
    // can decide whether a recon step is warranted. The absolute path and host
    // platform are needed for worker prompt construction in step_planning, not
    // for breaking the plan into steps.
    lines.push("WORKSPACE CONTENTS", listWorkspaceContents(cwd), "");
  } else {
    lines.push("WORKSPACE", cwd, "");
    // Re-inject the run-level complexity classification so worker_result_review
    // and step_planning can apply the depth-adaptive verifier rule. plan_analysis
    // sets this once; downstream modes propagate it via the persisted RunState.
    if (run.taskComplexity) {
      lines.push(
        "TASK COMPLEXITY",
        formatTaskComplexity(run.taskComplexity),
        "",
      );
    }
  }

  lines.push(
    "AVAILABLE RUNTIMES",
    formatAvailableRuntimes(availableRuntimes),
    "",
    "RUN STATE",
    JSON.stringify(
      {
        id: run.id,
        title: run.title,
        status: run.status,
        existingSteps: run.steps.map((step) => ({
          id: step.id,
          index: step.index,
          title: step.title,
          kind: step.kind ?? "worker_batch",
          status: step.status,
          reviewSummary: step.reviewSummary,
        })),
        existingTasks: run.workerTasks.map((task) => ({
          id: task.id,
          title: task.title,
          runtimePreference: task.runtimePreference,
          status: task.status,
          expectedOutputs: task.expectedOutputs,
        })),
        workerAttempts: run.workerAttempts.map((attempt) => ({
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
    formatStepDivision(run),
    "",
    "WORKER REPORTS",
    JSON.stringify(workerReports ?? [], null, 2),
    "",
    "PROJECT PLAN",
    truncate(activePlanText, 24000),
    "",
  );

  // Surface user-authored notes/answers as a dedicated, hard-to-miss section
  // labelled as binding additions to the plan. Without this, the manager
  // tends to treat a follow-up like "make it scientific" as a small patch
  // on already-completed work — emitting a thin corrective step and a
  // weakly-framed worker prompt — instead of redesigning the next slice as
  // if the amendment had been in the plan from the start. recentMessages
  // is still embedded in RUN STATE for full context; this section gives
  // emphasis and explicit framing.
  const userAmendments = run.humanMessages.filter(
    (m) => m.author === "user" && (m.kind === "note" || m.kind === "answer"),
  );
  if (userAmendments.length > 0) {
    const lastPlanAnalysisAt = run.steps.length > 0 ? run.steps[0]?.createdAt : undefined;
    const formattedAmendments = userAmendments
      .map((m, idx) => {
        const isAfterPlanning =
          lastPlanAnalysisAt && m.createdAt && m.createdAt > lastPlanAnalysisAt;
        const marker = isAfterPlanning ? " (post-plan amendment)" : "";
        return `${idx + 1}.${marker} ${truncate(m.message, 2000)}`;
      })
      .join("\n");
    lines.push(
      "USER NOTES (binding additions to the project plan)",
      "Treat each note below as part of the project plan. When designing new worker tasks, integrate these as if they had been in the original plan from the start — write the worker description at full design depth (objective, acceptance criteria, UI polish, behaviors), not as a thin patch on top of existing files. Existing artifacts may inform style/structure but must not constrain the new design's quality bar.",
      "",
      formattedAmendments,
      "",
    );
  }

  // When a per-mode system prompt override is set we treat that as the
  // canonical instruction for the stage and skip the generic MODE-SPECIFIC
  // OUTPUT RULES block in the user message. The override is expected to
  // already capture every constraint the model needs.
  const hasModeOverride = Boolean(
    promptProfile.manager.systemPromptOverrides?.[mode]?.trim(),
  );
  if (!hasModeOverride) {
    lines.push(
      "MODE-SPECIFIC OUTPUT RULES",
      formatManagerModeRules(promptProfile, mode),
      "",
    );
  }
  lines.push(
    "Use the structured output schema supplied in the API request. Do not restate or explain the schema in your answer.",
  );
  return lines.join("\n");
}

// Top-level workspace listing fed to plan_analysis so the model doesn't invent
// setup/cleanup steps and can decide whether a recon worker_batch is needed.
// Capped at 60 entries; deeper exploration is the recon worker's job.
function listWorkspaceContents(cwd: string): string {
  if (!cwd) return "(workspace path was not provided)";
  try {
    const stat = statSync(cwd);
    if (!stat.isDirectory()) return `(workspace is not a directory: ${cwd})`;
  } catch (err) {
    return `(failed to stat workspace ${cwd}: ${(err as Error).message})`;
  }
  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    if (entries.length === 0) return "(empty)";
    const lines: string[] = [];
    let count = 0;
    for (const entry of entries) {
      if (count >= 60) {
        lines.push("... (truncated)");
        break;
      }
      if (entry.isDirectory()) {
        lines.push(`${entry.name}/`);
      } else {
        let size = 0;
        try {
          size = statSync(join(cwd, entry.name)).size;
        } catch {
          // ignore — show name only
        }
        lines.push(size > 0 ? `${entry.name} (${size} bytes)` : entry.name);
      }
      count += 1;
    }
    return lines.join("\n");
  } catch (err) {
    return `(failed to list workspace ${cwd}: ${(err as Error).message})`;
  }
}

export async function requestOpenRouterManagerDecision(
  config: OpenRouterConfig,
  requestBody: OpenRouterManagerRequest,
  mode: OpenRouterManagerMode,
): Promise<OpenRouterManagerResult> {
  const started = Date.now();
  try {
    return await performOpenRouterManagerRequest({
      config,
      requestBody,
      mode,
      started,
      model: requestBody.model,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const fallbackModel = config.structuredOutputFallbackModel.trim();
    if (
      !isStructuredOutputUnsupportedError(error) ||
      !fallbackModel ||
      fallbackModel === requestBody.model
    ) {
      throw err;
    }

    return performOpenRouterManagerRequest({
      config,
      requestBody: { ...requestBody, model: fallbackModel },
      mode,
      started,
      model: fallbackModel,
      fallbackFrom: requestBody.model,
    });
  }
}

export function isStructuredOutputUnsupportedError(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes("no endpoints found") && normalized.includes("requested parameters")
  ) || (
    normalized.includes("response_format") && normalized.includes("not support")
  ) || (
    normalized.includes("json_schema") && normalized.includes("not support")
  );
}

async function performOpenRouterManagerRequest({
  config,
  requestBody,
  mode,
  started,
  model,
  fallbackFrom,
}: {
  config: OpenRouterConfig;
  requestBody: OpenRouterManagerRequest;
  mode: OpenRouterManagerMode;
  started: number;
  model: string;
  fallbackFrom?: string;
}): Promise<OpenRouterManagerResult> {
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
    model,
    fallbackFrom,
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
  const chatReply = typeof raw.chatReply === "string" ? raw.chatReply.trim() : undefined;
  const taskComplexity = normalizeTaskComplexity(raw.taskComplexity);

  if (status === "ask_user") {
    return {
      status,
      summary: normalizeText(raw.summary, "Spark needs user input before creating worker tasks."),
      question: question || "Please clarify the next decision Spark should make.",
      chatReply,
      steps: [],
      tasks: [],
      taskComplexity,
    };
  }

  if (status === "complete") {
    return {
      status,
      summary: normalizeText(raw.summary, "Spark thinks the run is complete."),
      chatReply,
      steps: [],
      tasks: [],
      taskComplexity,
    };
  }

  if (mode === "plan_analysis") {
    if (steps.length === 0) {
      return {
        status: "ask_user",
        summary: "Spark could not create a step-by-step division from the plan.",
        question: question || "Please clarify the concrete outcome this project plan should produce.",
        chatReply,
        steps: [],
        tasks: [],
        taskComplexity,
      };
    }

    return {
      status: "run_workers",
      summary: normalizeText(raw.summary, "Spark analyzed the plan into concrete steps."),
      chatReply,
      steps,
      tasks: [],
      taskComplexity,
    };
  }

  if (tasks.length === 0) {
    // worker_result_review may legitimately return run_workers with no tasks:
    // "this worker is fine, advance to the next step". Step planning for the
    // new active step happens in the autopilot review loop. For step_planning
    // mode, however, no tasks means the manager failed to produce a prompt and
    // we genuinely need a clarification.
    if (mode === "worker_result_review") {
      return {
        status: "run_workers",
        summary: normalizeText(raw.summary, "Spark accepted the worker; advancing to the next step."),
        chatReply,
        steps,
        tasks: [],
        taskComplexity,
      };
    }
    return {
      status: "ask_user",
      summary: "Spark could not produce a worker task from the plan.",
      question: question || "Please clarify the first concrete task to run.",
      chatReply,
      steps: [],
      tasks: [],
      taskComplexity,
    };
  }

  return {
    status: "run_workers",
    summary: normalizeText(raw.summary, "Spark planned the next worker task."),
    chatReply,
    steps,
    tasks,
    taskComplexity,
  };
}

function normalizeTaskComplexity(value: unknown): TaskComplexity | undefined {
  if (value === "trivial" || value === "standard" || value === "complex") return value;
  return undefined;
}

function normalizeStatus(value: unknown): SparkManagerDecision["status"] {
  if (value === "run_workers" || value === "ask_user" || value === "complete") return value;
  return "run_workers";
}

function normalizeSteps(value: unknown): SparkManagerStepDecision[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .slice(0, 12)
    .map((item, index) => {
      const kind = normalizeStepKind(item.kind);
      // brake steps must not carry plannedAgents; force-clear them so a model
      // that ignores the rule can't sneak workers past us.
      const plannedAgents = kind === "brake" ? [] : normalizePlannedAgents(item.plannedAgents);
      return {
        kind,
        title: stripStepPrefix(normalizeText(item.title, `Spark planned step ${index + 1}`)),
        goal: normalizeText(item.goal, "Complete the next concrete part of the selected plan."),
        plannedAgents,
        acceptanceCriteria: normalizeStringList(item.acceptanceCriteria),
        riskLevel: normalizeRisk(item.riskLevel),
      };
    });
  // Skeleton-then-brake enforcement: any worker_batch step containing a
  // skeleton-class plannedAgent must be followed by a brake so Spark can
  // inspect the foundation before committing more workers to it. The system
  // prompt requires this; we inject a synthetic brake when the model forgets.
  const enforced: SparkManagerStepDecision[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const step = normalized[i];
    enforced.push(step);
    const hasSkeleton =
      step.kind === "worker_batch" && step.plannedAgents.some((agent) => agent.taskClass === "skeleton");
    if (!hasSkeleton) continue;
    const next = normalized[i + 1];
    if (!next || next.kind === "brake") continue;
    enforced.push({
      kind: "brake",
      title: "Verify foundation",
      goal: "Inspect the architectural skeleton laid by the prior step before committing further workers to it.",
      plannedAgents: [],
      acceptanceCriteria: [],
      riskLevel: undefined,
    });
  }
  // Hard-stop at the first brake: anything past a brake is speculation made
  // before the brake's evidence exists. Spark re-invokes plan_analysis once
  // the brake resolves and the manager emits the next slice with prior worker
  // reports in context. The system prompt forbids speculating past a brake;
  // this is the enforcement layer for models that ignore the rule.
  const firstBrake = enforced.findIndex((step) => step.kind === "brake");
  return firstBrake === -1 ? enforced : enforced.slice(0, firstBrake + 1);
}

function normalizeStepKind(value: unknown): StepKind {
  if (value === "brake") return "brake";
  return "worker_batch";
}

function normalizePlannedAgents(value: unknown): PlannedStepAgent[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => ({
      label: normalizeText(item.label, `agent ${index + 1}`),
      summary: normalizeText(item.summary, "Complete a focused part of this step."),
      runtimePreference: normalizeRuntime(item.runtimePreference),
      modelHint: typeof item.modelHint === "string" ? item.modelHint.trim() : undefined,
      effortHint: normalizeEffort(item.effortHint),
      taskClass: normalizeTaskClass(item.taskClass),
    }));
}

function normalizeTaskClass(value: unknown): PlannedStepAgent["taskClass"] {
  if (
    value === "skeleton" ||
    value === "feature" ||
    value === "leaf" ||
    value === "verifier"
  ) {
    return value;
  }
  // Default to "feature" when the model omits the class. Skeleton must be an
  // explicit choice so we never force a synthetic brake on an unintentional
  // step. Verifier must also be explicit — it's always a follow-up class
  // chosen by worker_result_review, never a plan_analysis default.
  return "feature";
}

function normalizeTasks(value: unknown): SparkManagerTaskDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => {
      const title = normalizeText(item.title, `Spark worker task ${index + 1}`);
      const description = normalizeText(
        item.description,
        "Work on the next focused implementation task.",
      );
      const expectedOutputs = normalizeStringList(item.expectedOutputs);
      const explicitClass =
        item.taskClass === undefined ? undefined : normalizeTaskClass(item.taskClass);
      // Defensive fallback: even when the model omits taskClass on a follow-up
      // task spawned by worker_result_review, detect the verifier intent from
      // the title/description/expectedOutputs and tag it. Otherwise the worker
      // would render with the implementation prompt and the verifier loop
      // collapses to a regular retry.
      const taskClass = explicitClass ?? inferVerifierClassFromShape({
        title,
        description,
        expectedOutputs,
      });
      return {
        stepIndex: typeof item.stepIndex === "number" ? item.stepIndex : 0,
        title,
        description,
        runtimePreference: normalizeRuntime(item.runtimePreference),
        modelHint: typeof item.modelHint === "string" ? item.modelHint : undefined,
        effortHint: normalizeEffort(item.effortHint),
        allowedPaths: normalizeStringList(item.allowedPaths),
        forbiddenPaths: normalizeStringList(item.forbiddenPaths),
        expectedOutputs,
        verificationCommands: normalizeStringList(item.verificationCommands),
        canRunParallel: item.canRunParallel === true,
        conflictsWith: normalizeStringList(item.conflictsWith),
        taskClass,
      };
    });
}

function inferVerifierClassFromShape(shape: {
  title: string;
  description: string;
  expectedOutputs: string[];
}): PlannedStepAgent["taskClass"] | undefined {
  const titleLower = shape.title.toLowerCase();
  if (/^verify\b/.test(titleLower)) return "verifier";
  if (/^verifier:/.test(titleLower)) return "verifier";
  const descLower = shape.description.toLowerCase();
  if (
    descLower.includes("you are a spark verifier") ||
    descLower.includes("you are a verifier") ||
    descLower.includes("do not trust the prior worker") ||
    descLower.includes("re-derive ground truth")
  ) {
    return "verifier";
  }
  for (const out of shape.expectedOutputs) {
    const o = out.toLowerCase();
    if (o.includes("verification report") || o.includes("atomic_claims") || o.includes("corrective_prompt")) {
      return "verifier";
    }
  }
  return undefined;
}

function normalizeRuntime(value: unknown): WorkerRuntime {
  if (value === "claude" || value === "codex" || value === "manual" || value === "shell") return value;
  return "manual";
}

function normalizeEffort(value: unknown): WorkerTask["effortHint"] {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  )
    return value;
  return undefined;
}

function normalizeRisk(value: unknown): SparkManagerStepDecision["riskLevel"] {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// Manager LLMs sometimes echo `Step N:` back into the title itself. The renderer
// already prepends the index, so leaving the prefix in place produces
// "Step 2: Step 2: Implement HTML Structure" in worker prompts and the sidebar.
function stripStepPrefix(value: string): string {
  return value.replace(/^\s*step\s*\d+\s*[:.\-)]?\s*/i, "").trim() || value;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated]`;
}

function formatAvailableRuntimes(runtimes: AgentRuntimeDiagnostic[] | undefined): string {
  if (!runtimes || runtimes.length === 0) {
    return "Runtime detection has not been performed. Assume only `shell` and `manual` are reliably available.";
  }
  const lines: string[] = [];
  for (const r of runtimes) {
    if (!r.installed) {
      lines.push(`- ${r.kind} (${r.label}): NOT INSTALLED — do not assign work to this runtime.`);
      continue;
    }
    const versionPart = r.version ? ` v${r.version.split(/\s+/)[0]}` : "";
    const modelList = r.models.map((m) => {
      const efforts = m.effortLevels.join("/");
      return `${m.id} [${efforts}]`;
    }).join(", ");
    lines.push(`- ${r.kind} (${r.label})${versionPart} INSTALLED. Models: ${modelList}`);
  }
  lines.push("- shell: always available (deterministic command-only tasks).");
  lines.push("- manual: always available (human executes; only when automation is unsafe).");
  return lines.join("\n");
}

function formatTaskComplexity(complexity: TaskComplexity): string {
  switch (complexity) {
    case "trivial":
      return [
        "trivial — single-module fix, ≤3 atomic acceptance criteria, no public API touch.",
        "Verifier policy: ZERO verifier follow-ups. After an implementation worker reports complete, return tasks=[] and let the step advance — the worker's SELF-CHECK is enough.",
        "Cascade rule: if the implementation worker reports partial/failed/blocked OR public gates fail, treat the next corrective round AS-IF standard (queue ONE cross-provider verifier on the corrective implementation). Cap promotions at 1 to prevent runaway.",
      ].join("\n");
    case "standard":
      return [
        "standard — multi-file change OR public API touch, with clear scope.",
        "Verifier policy: ONE verifier follow-up after each implementation worker. runtimePreference = OPPOSITE of the implementation worker (Claude impl → Codex verifier; Codex impl → Claude verifier). modelHint = claude-opus-4-7 OR gpt-5.5; effortHint = high; allowedPaths = []; taskClass = verifier.",
      ].join("\n");
    case "complex":
      return [
        "complex — subtle/byte-level work where atomic claims compound, OR cross-module refactor with ≥3 files changing semantics.",
        "Verifier policy: TWO peer verifiers IN PARALLEL after each implementation worker — one Claude (claude-opus-4-7@high) and one Codex (gpt-5.5@high). Both with taskClass=verifier, allowedPaths=[], canRunParallel=true. Two model families = two blind spots; peer disagreement IS the signal.",
      ].join("\n");
  }
}

function formatStepDivision(run: RunState): string {
  if (run.steps.length === 0) return "No step-by-step division exists yet.";
  return run.steps
    .map((step) => {
      const kind = step.kind ?? "worker_batch";
      const head = kind === "brake" ? `${step.index}. [BRAKE] ${step.title}` : `${step.index}. ${step.title}`;
      const lines = [head, `Goal: ${step.goal}`];
      if (kind !== "brake") {
        lines.push(`Agents: ${formatPlannedAgents(step.plannedAgents)}`);
      }
      lines.push(`Status: ${step.status}`);
      lines.push(`Acceptance: ${step.acceptanceCriteria.length ? step.acceptanceCriteria.join("; ") : "not specified"}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatPlannedAgents(agents: PlannedStepAgent[] | undefined): string {
  if (!agents?.length) return "not specified";
  return agents
    .map((agent, index) => {
      const model = agent.modelHint?.trim() || agent.runtimePreference;
      const effort = agent.effortHint ? `thinking level ${agent.effortHint}` : "thinking level not specified";
      return `${agent.label || `agent ${index + 1}`} -> ${agent.summary} -> ${model} (${effort})`;
    })
    .join("; ");
}

