// Cora's manager protocol — the provider-agnostic contract between the
// orchestrator and whichever manager backend is driving a run.
//
// Two halves live here:
//   - Request side: `buildManagerRequest` assembles a hosted-API style
//     system+user message pair and the strict `spark_manager_decision` JSON
//     schema. NOTE: no live backend calls it. Every shipping backend drives a
//     CLI session whose system prompt is a resource file under
//     resources/orchestration (claude-backend `buildClaudeAgentSdkOptions`,
//     codex-backend `codexManagerInstructions`) and whose per-turn user text is
//     spark-agent-backend's `buildManagerTurnPrompt`. Keep that split in mind
//     before reasoning about "how the manager prompt is assembled" from here:
//     the cacheable-prefix contract lives in spark-agent-backend, not this file.
//   - Response side: `parseManagerDecisionJson` + `normalizeManagerDecision`
//     turn a model's raw structured output into a validated
//     SparkManagerDecision, applying the invariants the prompt asks for
//     (brake-after-skeleton, hard stop at the first brake, verifier-class
//     inference, mode-specific fallbacks).
//
// There is deliberately NO transport in this file. Backends own their own
// wire protocol (Claude Code / Codex / Pi each drive a CLI session) and
// register themselves in backend-registry.ts.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentRuntimeDiagnostic,
  HumanRunMessage,
  PlannedStepAgent,
  RunState,
  RunMessageAttachment,
  RunQuestionCategory,
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
import { formatPriorRunsSection } from "./run-memory";
import { formatWorkspaceLessonsSection } from "./workspace-lessons";

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
  status: "run_workers" | "ask_user" | "complete" | "spawn_terminals";
  summary: string;
  question?: string;
  questionOptions?: SparkManagerQuestionOption[];
  questionCategory?: RunQuestionCategory;
  questionReason?: string;
  recommendedOptionId?: string;
  steps: SparkManagerStepDecision[];
  tasks: SparkManagerTaskDecision[];
  /**
   * Set by plan_analysis on the first manager call. Drives downstream
   * verifier depth (trivial=1, standard=1, complex=2) and the step cap.
   * Optional on later modes — those propagate the persisted RunState value.
   */
  taskComplexity?: TaskComplexity;
  /**
   * Natural-language reply addressed to the user. Populated only when the most
   * recent humanMessage is a fresh user note that asked Cora to do something
   * (or asked a question). Empty string otherwise. Surfaced as a Cora chat
   * bubble in the run chat — keep it 1-3 sentences, plain English, no JSON.
   */
  chatReply?: string;
  /**
   * Standing interactive terminals to open for the user, who prompts and
   * drives them personally. Populated only when status is spawn_terminals;
   * these are not Cora workers.
   */
  terminals?: SparkManagerTerminalRequest[];
}

export interface SparkManagerTerminalRequest {
  runtime: "claude" | "codex";
  count: number;
  model?: string;
  effort?: string;
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

export type ManagerContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ManagerMessage {
  role: "system" | "user";
  content: string | ManagerContentPart[];
}

export interface SparkManagerQuestionOption {
  id: string;
  label: string;
  description: string;
  answer: string;
  recommended?: boolean;
}

export type ManagerMode = "plan_analysis" | "chat" | "step_planning" | "worker_result_review";

export interface ManagerRequest {
  model: string;
  temperature: number;
  response_format: {
    type: "json_schema";
    json_schema: {
      name: "spark_manager_decision";
      strict: true;
      schema: Record<string, unknown>;
    };
  };
  messages: ManagerMessage[];
}

export interface ManagerResult {
  decision: SparkManagerDecision;
  /**
   * Whatever the backend received for this turn, persisted verbatim as the
   * call's response artifact. Backend-shaped, so this is only ever
   * serialized — never inspected.
   */
  rawResponse: unknown;
  durationMs: number;
  model: string;
  fallbackFrom?: string;
  promptTokens?: number;
  completionTokens?: number;
  /**
   * USD cost for the turn, priced by the backend against the model price
   * table. Zero (with token counts still populated) when the model isn't in
   * the table or the response carried no usage block. Persisted onto the
   * matching SparkCall record by the run-store completion handler.
   */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

const SPARK_MANAGER_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "question",
    "questionOptions",
    "questionCategory",
    "questionReason",
    "recommendedOptionId",
    "chatReply",
    "steps",
    "tasks",
    "taskComplexity",
    "terminals",
  ],
  properties: {
    status: {
      type: "string",
      enum: ["run_workers", "ask_user", "complete", "spawn_terminals"],
      description:
        "The next manager action. spawn_terminals: open standing interactive terminals the user will drive themselves (fill the terminals array); use only when the user explicitly asks to open terminals/agents for their own use.",
    },
    summary: {
      type: "string",
      description: "Short explanation of the manager decision.",
    },
    question: {
      type: "string",
      description: "Concise question for the human. Empty unless status is ask_user.",
    },
    questionOptions: {
      type: "array",
      description:
        "Exactly three answer choices when status=ask_user and choices are bounded, otherwise []. Mark exactly one recommended=true whenever options are present. The UI adds a custom text answer.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "description", "answer", "recommended"],
        properties: {
          id: {
            type: "string",
            description: "Stable short id such as option_a, option_b, option_c.",
          },
          label: {
            type: "string",
            description: "Short option label, 1-5 words.",
          },
          description: {
            type: "string",
            description: "One sentence explaining the impact/tradeoff.",
          },
          answer: {
            type: "string",
            description: "Full answer text Cora should treat as the user's response if selected.",
          },
          recommended: {
            type: "boolean",
            description: "true for exactly one option, preferably the safest practical default.",
          },
        },
      },
    },
    questionCategory: {
      type: "string",
      enum: [
        "",
        "credentials_access",
        "destructive_irreversible",
        "safety_policy",
        "irreducible_product_scope",
        "plan_approval",
      ],
      description:
        "Required hard-blocker category when status=ask_user; empty otherwise. Reversible technical preferences are not blockers and must not use ask_user.",
    },
    questionReason: {
      type: "string",
      description:
        "Why no safe default exists and human judgment is required. Non-empty only for status=ask_user.",
    },
    recommendedOptionId: {
      type: "string",
      description:
        "Id of the single recommended option when questionOptions is non-empty; empty otherwise.",
    },
    chatReply: {
      type: "string",
      description:
        "Natural-language reply to the user, surfaced in the run chat as a Cora bubble. Populate ONLY when the most recent human message is a fresh user note/answer that asks for action or for a status update. 1-3 plain sentences, no JSON, no markdown headings. Empty string when there is no fresh user message to respond to.",
    },
    taskComplexity: {
      type: "string",
      enum: ["trivial", "standard", "complex", ""],
      description:
        "Required during plan_analysis: classify the WHOLE RUN's complexity, honestly. It drives verifier depth (trivial=1, standard=1, complex=2 peer verifiers), the step cap, AND the run's execution tier: the user has no depth control, so this field alone decides how much scrutiny Codara buys (complex derives the deep tier with a wider verifier-round budget and more than one corrective rework; trivial and standard derive the fast tier). It measures the work, it is not a budget request: inflating it spends wall-clock and money on ceremony the task does not need, deflating it strands subtle work with one verification round. trivial: single-module fix, ≤3 atomic acceptance criteria, no public API touch (max 2 worker_batch steps, no recon, no skeleton). standard: multi-file change OR public API touch with clear scope (max 3-4 steps). complex: subtle/byte-level work where atomic claims compound, OR cross-module refactor with ≥3 files changing semantics (no step cap). Every tier gets at least one verifier follow-up; trivial vs standard differ only in scope and step cap, not in whether work is verified. Bias toward standard on uncertainty, false-complex burns 9 workers. Empty string \"\" allowed only on step_planning / worker_result_review modes (those propagate the persisted classification).",
    },
    terminals: {
      type: "array",
      description:
        "Standing interactive terminals to open for the user, who prompts and orchestrates them personally. Non-empty ONLY when status is spawn_terminals; [] otherwise. One entry per distinct runtime+model+effort combination.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["runtime", "count", "model", "effort"],
        properties: {
          runtime: {
            type: "string",
            enum: ["claude", "codex"],
            description: "Which agent CLI runs in the terminal.",
          },
          count: {
            type: "integer",
            description: "How many terminals of this exact configuration to open (1 or more).",
          },
          model: {
            type: "string",
            description:
              "Model id the user named (e.g. 'opus', 'fable', 'gpt-5.6-sol'); empty string when unspecified. This is a standing terminal the human drives, so any model they ask for by name is honoured, the three-model worker roster does not apply here.",
          },
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh", "max", ""],
            description:
              "Thinking/effort level the user named; empty string when unspecified. Applied to claude terminals only.",
          },
        },
      },
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
              "worker_batch: 1+ parallel workers with non-overlapping write scopes. brake: no workers; plannedAgents=[]; checkpoint where Cora replans downstream steps using prior worker reports. HARD STOP: when you emit a brake, the steps array MUST end at that brake. Do not emit any step after a brake; Cora will re-invoke plan_analysis once the brake resolves and you will plan the next slice then.",
          },
          title: { type: "string" },
          goal: { type: "string" },
          plannedAgents: {
            type: "array",
            description: "Agents Cora plans to run in this step, as a compact durable overview. Empty array for kind=brake.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "summary", "runtimePreference", "modelHint", "effortHint", "taskClass"],
              properties: {
                label: { type: "string" },
                summary: { type: "string" },
                runtimePreference: { type: "string", enum: ["claude", "codex", "manual", "shell"] },
                modelHint: { type: "string" },
                effortHint: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
                taskClass: {
                  type: "string",
                  enum: ["skeleton", "feature", "leaf", "verifier"],
                  description:
                    "skeleton: architectural decisions later workers inherit (file layout, base components, state shape, design tokens): strongest available model + highest effort. feature: standard implementation against an established skeleton, mid model + medium effort. leaf: mechanical, well-defined work (rename, plumb a known transformation, write tests against an existing API): cheapest available model + low effort. verifier: read-only follow-up class spawned ONLY by worker_result_review after an implementation worker completes; never appears in a plan_analysis plannedAgents list, peer-strength model + high effort, allowedPaths=[], re-derives ground truth from filesystem.",
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
          effortHint: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
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

export function buildManagerRequest(input: {
  run: RunState;
  cwd: string;
  model: string;
  mode?: ManagerMode;
  workerReports?: SparkManagerWorkerReportContext[];
  availableRuntimes?: AgentRuntimeDiagnostic[];
  agentSyncContext?: string;
  promptProfile?: ReturnType<typeof loadManagerPromptProfile>;
}): ManagerRequest {
  const mode = input.mode ?? "step_planning";
  const activePlan = input.run.planId
    ? input.run.plans.find((plan) => plan.id === input.run.planId)
    : input.run.plans.at(-1);
  const recentMessages = input.run.humanMessages.slice(-6).map((message) => ({
    author: message.author,
    kind: message.kind,
    message: truncate(message.message, 1600),
    attachments: formatMessageAttachments(message),
  }));
  const promptProfile = input.promptProfile ?? loadManagerPromptProfile();
  const userText = buildManagerUserMessage({
    mode,
    cwd: input.cwd,
    run: input.run,
    recentMessages,
    workerReports: input.workerReports,
    availableRuntimes: input.availableRuntimes,
    agentSyncContext: input.agentSyncContext,
    promptProfile,
    activePlanText: activePlan?.rawContent || activePlan?.summary || "No plan content was provided.",
  });

  return {
    model: input.model,
    temperature: 0.2,
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
        content: buildManagerUserContent({
          run: input.run,
          mode,
          text: userText,
        }),
      },
    ],
  };
}

interface ManagerUserMessageInput {
  mode: ManagerMode;
  cwd: string;
  run: RunState;
  recentMessages: Array<{ author: string; kind: string; message: string; attachments: string[] }>;
  workerReports: SparkManagerWorkerReportContext[] | undefined;
  availableRuntimes: AgentRuntimeDiagnostic[] | undefined;
  agentSyncContext?: string;
  promptProfile: ManagerPromptProfile;
  activePlanText: string;
}

function buildManagerUserMessage(input: ManagerUserMessageInput): string {
  const { mode, cwd, run, recentMessages, workerReports, availableRuntimes, agentSyncContext, promptProfile, activePlanText } = input;
  const isPlanAnalysis = mode === "plan_analysis";
  const isChat = mode === "chat";

  const lines: string[] = [
    "Decide the next manager action for this Cora run.",
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
    const priorRuns = formatPriorRunsSection(run);
    if (priorRuns) {
      lines.push(priorRuns, "");
    }
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
    "SYNCED MCP / SKILL CAPABILITIES",
    agentSyncContext || "No synced MCP servers or skills discovered.",
    "",
    "RUN STATE",
    JSON.stringify(formatCompactRunState(run, recentMessages), null, 2),
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
    const recentAmendments = userAmendments.slice(-6);
    const olderCount = Math.max(0, userAmendments.length - recentAmendments.length);
    const formattedAmendments = recentAmendments
      .map((m, idx) => {
        const isAfterPlanning =
          lastPlanAnalysisAt && m.createdAt && m.createdAt > lastPlanAnalysisAt;
        const marker = isAfterPlanning ? " (post-plan amendment)" : "";
        const attachments = formatMessageAttachments(m);
        const attachmentLine = attachments.length > 0 ? `\n   Attachments: ${attachments.join("; ")}` : "";
        return `${idx + 1}.${marker} ${truncate(m.message, 1200)}${attachmentLine}`;
      })
      .join("\n");
    if (isChat) {
      lines.push(
        "CONVERSATION",
        "Treat these as chat turns. The latest user turn may be a direct question, a request to use tools/workers, or a project amendment. Decide which based on the content and available context.",
        "",
        olderCount > 0 ? `Older user turns already reflected in the saved run: ${olderCount}` : "",
        formattedAmendments,
        "",
      );
    } else {
      lines.push(
        "USER NOTES (binding additions to the project plan)",
        "Treat each note below as part of the project plan. When designing new worker tasks, integrate these as if they had been in the original plan from the start, write the worker description at full design depth (objective, acceptance criteria, UI polish, behaviors), not as a thin patch on top of existing files. Existing artifacts may inform style/structure but must not constrain the new design's quality bar.",
        "",
        olderCount > 0 ? `Older user notes already reflected in the saved steps/reviews: ${olderCount}` : "",
        formattedAmendments,
        "",
      );
    }
  }

  lines.push(
    "RUN ARTIFACT STAGING",
    join(run.artifactDir, "staging"),
    "Use this directory for temporary multi-agent staging artifacts. Do not create .spark-parts or other staging folders inside the user workspace.",
    "",
  );

  const unresolvedFreshNote = isChat ? null : findUnresolvedFreshUserNote(run);
  if (unresolvedFreshNote) {
    lines.push(
      "FRESH USER NOTE GUARD",
      "The latest user note below is newer than every worker report/attempt currently in RUN STATE and appears to request a change or report a defect. Do not return status=complete until you have planned worker work for this note, asked a genuine blocking question, or the RUN STATE contains worker evidence produced after this note.",
      "",
      `${unresolvedFreshNote.createdAt}: ${truncate(unresolvedFreshNote.message, 1200)}`,
      "",
    );
  }

  // Cross-step plan hint left by the previous worker_result_review pass. When
  // review proposed follow-up tasks that pointed past the end of the existing
  // plan (e.g. "exploration done, now edit calculator.html" with stepIndex=2
  // when only step 1 existed), we captured them rather than silently drop.
  // Surface the proposed work to plan_analysis as a strong hint so it emits
  // the missing steps. Without this section the run parked in reviewing/blocked.
  if (isPlanAnalysis && run.autopilot?.pendingPlanHint) {
    const hint = run.autopilot.pendingPlanHint;
    lines.push(
      "PLAN HINT (from latest worker_result_review)",
      "The previous review pass proposed the follow-up tasks below but their stepIndex pointed past the end of the existing plan. Treat them as a strong hint about the work the next slice should cover. Use them as the basis for the next worker_batch step(s); refine titles/scope/runtime/effort as needed. Do not parrot them verbatim if a better decomposition is obvious.",
      "",
      `Review summary: ${truncate(hint.summary, 800)}`,
      "",
      ...hint.droppedTasks.map((t, i) =>
        [
          `${i + 1}. ${t.title}`,
          `   description: ${truncate(t.description, 1200)}`,
          t.allowedPaths && t.allowedPaths.length > 0
            ? `   allowedPaths: ${t.allowedPaths.join(", ")}`
            : "",
          t.runtimePreference ? `   runtimePreference: ${t.runtimePreference}` : "",
          t.taskClass ? `   taskClass: ${t.taskClass}` : "",
          typeof t.requestedStepIndex === "number"
            ? `   requestedStepIndex: ${t.requestedStepIndex}`
            : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      ),
      "",
    );
  }

  const attachmentSummary = formatRunAttachmentSummary(run);
  if (attachmentSummary.length > 0) {
    lines.push(
      "ATTACHMENTS",
      "Images are stored as run artifacts. File references point at the user's workspace paths and may include compact text previews below. Pixel data is supplied only for the most recent user image turn during planning/task-writing calls. If a worker needs an attachment, include the artifact or file path in its task.",
      "",
      ...attachmentSummary,
      "",
    );
  }

  // Per-workspace lessons learned from earlier completed runs (search rate
  // limits, runtime fallbacks). Placed here, in the per-turn user message: this
  // is the dynamic tail, so lessons never invalidate the cacheable system-prompt
  // prefix. Costs nothing when the workspace has no lessons yet.
  //
  // This is the hosted-API mirror, which nothing dispatches today. The LIVE
  // replay for every shipping CLI backend is run-store's prepareManagerTurn,
  // which passes the same rendered section into buildManagerTurnPrompt. Keep the
  // two in step if the request side is ever wired up.
  const workspaceLessons = formatWorkspaceLessonsSection(run.workspaceId);
  if (workspaceLessons) {
    lines.push(workspaceLessons, "");
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

function formatCompactRunState(
  run: RunState,
  recentMessages: ManagerUserMessageInput["recentMessages"],
): Record<string, unknown> {
  const taskCap = 16;
  const attemptCap = 12;
  const visibleTasks = run.workerTasks.slice(-taskCap);
  const visibleAttempts = run.workerAttempts.slice(-attemptCap);

  // Long-run context control. Every step keeps a cheap skeleton (id / index /
  // title / status) so the manager always sees full plan progress, but the
  // heavy 500-char reviewSummary is carried only for the most recent steps PLUS
  // any non-terminal step — the active frontier must never lose detail. Without
  // this, existingSteps grew linearly with run length and was re-sent in full on
  // every manager turn, degrading signal-to-noise and inflating token cost
  // exactly when a run was longest. Mirrors the recentTasks / recentAttempts
  // caps above. Older review summaries remain durable in the saved run artifact;
  // the omitted count tells the manager that detail exists if it must recover it.
  const STEP_REVIEW_DETAIL_CAP = 12;
  const reviewDetailStart = Math.max(0, run.steps.length - STEP_REVIEW_DETAIL_CAP);
  const isTerminalStepStatus = (status: string): boolean =>
    status === "complete" || status === "failed" || status === "skipped";
  let omittedOlderStepSummaries = 0;
  const existingSteps = run.steps.map((step, index) => {
    const keepReviewDetail =
      index >= reviewDetailStart || !isTerminalStepStatus(step.status);
    if (!keepReviewDetail && step.reviewSummary) omittedOlderStepSummaries += 1;
    return {
      id: step.id,
      index: step.index,
      title: truncate(step.title, keepReviewDetail ? 180 : 120),
      kind: step.kind ?? "worker_batch",
      status: step.status,
      reviewSummary:
        keepReviewDetail && step.reviewSummary ? truncate(step.reviewSummary, 500) : undefined,
    };
  });

  return {
    id: run.id,
    title: run.title,
    status: run.status,
    artifactDir: run.artifactDir,
    stagingDir: join(run.artifactDir, "staging"),
    taskComplexity: run.taskComplexity,
    counts: {
      steps: run.steps.length,
      tasks: run.workerTasks.length,
      attempts: run.workerAttempts.length,
      managerCalls: run.sparkCalls.length,
      omittedOlderTasks: Math.max(0, run.workerTasks.length - visibleTasks.length),
      omittedOlderAttempts: Math.max(0, run.workerAttempts.length - visibleAttempts.length),
      omittedOlderStepSummaries,
    },
    existingSteps,
    recentTasks: visibleTasks.map((task) => ({
      id: task.id,
      stepId: task.stepId,
      title: truncate(task.title, 220),
      runtimePreference: task.runtimePreference,
      modelHint: task.modelHint,
      effortHint: task.effortHint,
      status: task.status,
      taskClass: task.taskClass,
      expectedOutputs: task.expectedOutputs.slice(0, 6),
    })),
    recentAttempts: visibleAttempts.map((attempt) => ({
      workerTaskId: attempt.workerTaskId,
      runtime: attempt.runtime,
      status: attempt.status,
      exitCode: attempt.exitCode,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      hasFinalReport: Boolean(attempt.finalReportPath),
    })),
    assumptions: (run.assumptions ?? []).slice(-8).map((assumption) => ({
      question: truncate(assumption.question, 500),
      selectedAnswer: truncate(assumption.selectedAnswer, 800),
      source: assumption.source,
      managerMode: assumption.managerMode,
      signature: assumption.signature,
    })),
    recentMessages,
  };
}

function buildManagerUserContent(input: {
  run: RunState;
  mode: ManagerMode;
  text: string;
}): string | ManagerContentPart[] {
  const imageParts = selectImageAttachmentsForManager(input.run, input.mode)
    .map((attachment) => attachmentToImagePart(attachment))
    .filter((part): part is ManagerContentPart => Boolean(part));
  if (imageParts.length === 0) return input.text;
  return [{ type: "text", text: input.text }, ...imageParts];
}

const MAX_IMAGE_PARTS_PER_MANAGER_CALL = 4;
const MAX_MANAGER_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_FILE_REFERENCE_PREVIEW_BYTES = 96 * 1024;
const MAX_FILE_REFERENCE_PREVIEW_CHARS = 6000;

function selectImageAttachmentsForManager(
  run: RunState,
  mode: ManagerMode,
): RunMessageAttachment[] {
  if (mode === "worker_result_review") return [];
  for (let index = run.humanMessages.length - 1; index >= 0; index -= 1) {
    const message = run.humanMessages[index];
    if (message.author !== "user") continue;
    const images = (message.attachments ?? []).filter((attachment) => attachment.kind === "image");
    if (images.length > 0) return images.slice(0, MAX_IMAGE_PARTS_PER_MANAGER_CALL);
  }
  return [];
}

function attachmentToImagePart(attachment: RunMessageAttachment): ManagerContentPart | null {
  try {
    const stat = statSync(attachment.path);
    if (!stat.isFile() || stat.size > MAX_MANAGER_IMAGE_BYTES) return null;
    const base64 = readFileSync(attachment.path).toString("base64");
    return {
      type: "image_url",
      image_url: {
        url: `data:${attachment.mimeType};base64,${base64}`,
        detail: "auto",
      },
    };
  } catch {
    return null;
  }
}

function formatMessageAttachments(message: HumanRunMessage): string[] {
  return (message.attachments ?? []).map(
    (attachment) => `${attachment.kind}:${attachment.name} (${attachment.path})`,
  );
}

function formatRunAttachmentSummary(run: RunState): string[] {
  const blocks: string[][] = [];
  for (const message of run.humanMessages) {
    const attachments = formatMessageAttachments(message);
    if (attachments.length === 0) continue;
    const block = [`${message.createdAt} ${message.author}/${message.kind}: ${attachments.join("; ")}`];
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind !== "file") continue;
      const preview = formatFileReferencePreview(attachment);
      if (preview) block.push(preview);
    }
    blocks.push(block);
  }
  const visible = blocks.slice(-8);
  const omitted = blocks.length - visible.length;
  const lines = visible.flat();
  if (omitted <= 0) return lines;
  return [`... ${omitted} older attachment turn(s) omitted`, ...lines];
}

function formatFileReferencePreview(attachment: RunMessageAttachment): string | null {
  try {
    const stat = statSync(attachment.path);
    if (!stat.isFile()) return `   ${attachment.name}: file is no longer readable at ${attachment.path}`;
    if (stat.size > MAX_FILE_REFERENCE_PREVIEW_BYTES) {
      return `   ${attachment.name}: ${stat.size} bytes, preview omitted because the file is large.`;
    }
    const buffer = readFileSync(attachment.path);
    if (buffer.includes(0)) {
      return `   ${attachment.name}: binary file, preview omitted.`;
    }
    return [
      `   ${attachment.name} preview (${attachment.path}):`,
      indentCodeBlock(truncate(buffer.toString("utf8"), MAX_FILE_REFERENCE_PREVIEW_CHARS)),
    ].join("\n");
  } catch {
    return `   ${attachment.name}: file is no longer readable at ${attachment.path}`;
  }
}

function indentCodeBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `   | ${line}`)
    .join("\n");
}

function findUnresolvedFreshUserNote(run: RunState): HumanRunMessage | null {
  const latest = [...run.humanMessages]
    .reverse()
    .find((message) => message.author === "user" && (message.kind === "note" || message.kind === "answer"));
  if (!latest || !looksLikeWorkRequest(latest.message)) return null;
  const latestEvidenceAt = Math.max(
    0,
    ...run.workerAttempts
      .map((attempt) => Date.parse(attempt.finishedAt ?? attempt.startedAt ?? ""))
      .filter(Number.isFinite),
    ...run.steps
      .map((step) => Date.parse(step.updatedAt ?? step.createdAt ?? ""))
      .filter(Number.isFinite),
  );
  const noteAt = Date.parse(latest.createdAt);
  if (!Number.isFinite(noteAt)) return null;
  return noteAt > latestEvidenceAt ? latest : null;
}

function looksLikeWorkRequest(message: string): boolean {
  return /\b(still|bad|broken|wrong|fix|change|make|add|remove|improve|look|looks|grow|grows|overflow|issue|problem|error|fail|failed|doesn'?t|not)\b/i.test(message);
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

/**
 * Response side, step 1: take the raw text a manager backend produced for a
 * `spark_manager_decision` structured-output call and get a JSON object out of
 * it. Tolerates a ```json fence, because models add one even under a strict
 * schema. Throws when the payload isn't a JSON object — the caller treats that
 * as a failed turn rather than inventing a decision.
 */
export function parseManagerDecisionJson(content: string): Record<string, unknown> {
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

/**
 * Response side, step 2: validate a parsed decision object against the
 * protocol and fill in the mode-specific fallbacks. This is where the
 * invariants the system prompt merely *asks* for get enforced — models that
 * ignore them (a skeleton step with no brake behind it, steps speculating past
 * a brake, a verifier follow-up with no taskClass) are corrected here.
 */
export function normalizeManagerDecision(
  raw: Record<string, unknown>,
  mode: ManagerMode,
): SparkManagerDecision {
  const status = normalizeStatus(raw.status);
  const steps = normalizeSteps(raw.steps);
  const tasks = normalizeTasks(raw.tasks);
  const question = typeof raw.question === "string" ? raw.question.trim() : undefined;
  const questionOptions = normalizeQuestionOptions(raw.questionOptions);
  const questionCategory = normalizeQuestionCategory(raw.questionCategory);
  const questionReason =
    typeof raw.questionReason === "string" ? raw.questionReason.trim() : undefined;
  const recommendedOptionId =
    typeof raw.recommendedOptionId === "string"
      ? raw.recommendedOptionId.trim() || undefined
      : undefined;
  const chatReply = typeof raw.chatReply === "string" ? raw.chatReply.trim() : undefined;
  const taskComplexity = normalizeTaskComplexity(raw.taskComplexity);

  if (status === "ask_user") {
    return {
      status,
      summary: normalizeText(raw.summary, "Cora needs user input before creating worker tasks."),
      question: question || "Please clarify the next decision Cora should make.",
      questionOptions,
      questionCategory,
      questionReason,
      recommendedOptionId,
      chatReply,
      steps: [],
      tasks: [],
      taskComplexity,
    };
  }

  if (status === "spawn_terminals") {
    const terminals = normalizeTerminals(raw.terminals);
    // Only commit to the terminal-spawn path when at least one valid terminal
    // was parsed. Otherwise fall through so the request is still handled as
    // ordinary orchestrator work rather than silently dropped.
    if (terminals.length > 0) {
      return {
        status: "spawn_terminals",
        summary: normalizeText(raw.summary, "Cora is opening terminals."),
        chatReply,
        terminals,
        steps: [],
        tasks: [],
        taskComplexity,
      };
    }
  }

  if (status === "complete") {
    return {
      status,
      summary: normalizeText(raw.summary, "Cora thinks the run is complete."),
      chatReply,
      steps: [],
      tasks: [],
      taskComplexity,
    };
  }

  if (mode === "plan_analysis" || mode === "chat") {
    if (steps.length === 0) {
      if (mode === "chat") {
        return {
          status: "complete",
          summary: normalizeText(raw.summary, "Cora answered the chat turn."),
          chatReply: chatReply || normalizeText(raw.summary, "Done."),
          steps: [],
          tasks: [],
          taskComplexity,
        };
      }
      return {
        status: "ask_user",
        summary: "Cora could not create a step-by-step division from the plan.",
        question: question || "Please clarify the concrete outcome this project plan should produce.",
        questionOptions,
        chatReply,
        steps: [],
        tasks: [],
        taskComplexity,
      };
    }

    return {
      status: "run_workers",
      summary: normalizeText(
        raw.summary,
        mode === "chat" ? "Cora decided this chat needs worker help." : "Cora analyzed the plan into concrete steps.",
      ),
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
        summary: normalizeText(raw.summary, "Cora accepted the worker; advancing to the next step."),
        chatReply,
        steps,
        tasks: [],
        taskComplexity,
      };
    }
    return {
      status: "ask_user",
      summary: "Cora could not produce a worker task from the plan.",
      question: question || "Please clarify the first concrete task to run.",
      questionOptions,
      questionCategory,
      questionReason,
      recommendedOptionId,
      chatReply,
      steps: [],
      tasks: [],
      taskComplexity,
    };
  }

  return {
    status: "run_workers",
    summary: normalizeText(raw.summary, "Cora planned the next worker task."),
    chatReply,
    steps,
    tasks,
    taskComplexity,
  };
}

function normalizeQuestionCategory(value: unknown): RunQuestionCategory | undefined {
  if (
    value === "credentials_access" ||
    value === "destructive_irreversible" ||
    value === "safety_policy" ||
    value === "irreducible_product_scope" ||
    value === "plan_approval"
  ) {
    return value;
  }
  return undefined;
}

function normalizeTaskComplexity(value: unknown): TaskComplexity | undefined {
  if (value === "trivial" || value === "standard" || value === "complex") return value;
  return undefined;
}

function normalizeStatus(value: unknown): SparkManagerDecision["status"] {
  if (
    value === "run_workers" ||
    value === "ask_user" ||
    value === "complete" ||
    value === "spawn_terminals"
  ) {
    return value;
  }
  return "run_workers";
}

function normalizeTerminals(value: unknown): SparkManagerTerminalRequest[] {
  if (!Array.isArray(value)) return [];
  const out: SparkManagerTerminalRequest[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const runtime =
      rec.runtime === "codex"
        ? "codex"
        : rec.runtime === "claude"
          ? "claude"
          : null;
    if (!runtime) continue;
    const rawCount = typeof rec.count === "number" ? Math.floor(rec.count) : 1;
    const count = Math.min(Math.max(rawCount, 1), 8);
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    const effort = typeof rec.effort === "string" ? rec.effort.trim() : "";
    out.push({ runtime, count, model: model || undefined, effort: effort || undefined });
  }
  return out;
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
        title: stripStepPrefix(normalizeText(item.title, `Cora planned step ${index + 1}`)),
        goal: normalizeText(item.goal, "Complete the next concrete part of the selected plan."),
        plannedAgents,
        acceptanceCriteria: normalizeStringList(item.acceptanceCriteria),
        riskLevel: normalizeRisk(item.riskLevel),
      };
    });
  // Skeleton-then-brake enforcement: any worker_batch step containing a
  // skeleton-class plannedAgent must be followed by a brake so Cora can
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
    // Inject the brake UNLESS the next step is already a brake. The common
    // "model forgot the brake" case is a skeleton emitted as the LAST step
    // (next is undefined) — that is exactly when we must inject, so the run
    // re-plans the dependent layers instead of completing after the skeleton.
    // (Previously `!next` short-circuited here and skipped the injection, so a
    // trailing skeleton step ran alone and the run wrongly completed — observed
    // on the deep-chain interpreter eval: only the 4 foundation modules built.)
    if (next && next.kind === "brake") continue;
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
  // before the brake's evidence exists. Cora re-invokes plan_analysis once
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
      const title = normalizeText(item.title, `Cora worker task ${index + 1}`);
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
  if (
    value === "claude" ||
    value === "codex" ||
    value === "manual" ||
    value === "shell"
  )
    return value;
  return "manual";
}

function normalizeEffort(value: unknown): WorkerTask["effortHint"] {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
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
      lines.push(`- ${r.kind} (${r.label}): NOT INSTALLED: do not assign work to this runtime.`);
      continue;
    }
    const versionPart = r.version ? ` v${r.version.split(/\s+/)[0]}` : "";
    const modelList = r.models.map((m) => {
      const efforts = m.effortLevels.join("/");
      const tier = m.tier ? ` tier=${m.tier}` : "";
      const def = m.isDefault ? " default" : "";
      return `${m.id} [${efforts}${tier}${def}]`;
    }).join(", ");
    // The sign-in probe is advisory: it cannot see shell-exported credentials
    // from a Finder-launched app, so "no credential detected" must not forbid
    // assigning work — only bias the choice when an equivalent peer exists.
    const authCaveat =
      r.authenticated === false
        ? " (WARNING: no credential detected on this machine, it may not be signed in; prefer an equivalent runtime without this warning, but assigning work here is allowed)"
        : "";
    lines.push(`- ${r.kind} (${r.label})${versionPart} INSTALLED${authCaveat}. Models: ${modelList}`);
  }
  lines.push("- shell: always available (deterministic command-only tasks).");
  lines.push("- manual: always available (human executes; only when automation is unsafe).");
  lines.push(
    "Worker model roster, three models, and only these three. Any other id you name is coerced onto this roster at spawn time:",
    "- claude-opus-5, STANDARD tier, the default workhorse.",
    "- gpt-5.6-sol, STANDARD tier on the other provider. Reach for it when an independent model family genuinely helps, above all for cross-provider verification.",
    "- claude-fable-5, PREMIUM tier, strongest and materially the most expensive. Reserve it for subtle invariants, tricky concurrency, large refactors, algorithmic depth, or a bug that already defeated a standard-tier worker.",
    "- There is no mid or cheap tier. Effort is the dial for easy work: skeleton → claude-fable-5 at the highest available effort; feature → standard tier at medium/high; leaf → standard tier at low/minimal.",
    "- Never pick the premium tier or high/xhigh/max effort for a mechanical leaf (e.g. running a single shell command and reporting its output): that wastes context and money for no gain.",
  );
  return lines.join("\n");
}

function formatTaskComplexity(complexity: TaskComplexity): string {
  switch (complexity) {
    case "trivial":
      return [
        "trivial, single-module fix, ≤3 atomic acceptance criteria, no public API touch.",
        "Execution tier: fast (this classification set it, the user has no depth control).",
        "Verifier policy: ONE verifier follow-up after the implementation worker on a behavioral step. runtimePreference = OPPOSITE of the implementation worker (Claude impl → Codex verifier; Codex impl → Claude verifier). modelHint = claude-opus-5 OR gpt-5.6-sol; effortHint = high; allowedPaths = []; taskClass = verifier. A confident self-report is not proof, the verifier re-derives correct behavior and runs adversarial input/output probes.",
        "Trivial keeps a tight step cap (max 2 worker_batch steps, no recon, no skeleton); it differs from standard only in scope, not in whether work gets verified.",
      ].join("\n");
    case "standard":
      return [
        "standard, multi-file change OR public API touch, with clear scope.",
        "Execution tier: fast (this classification set it, the user has no depth control).",
        "Verifier policy: ONE verifier follow-up after each implementation worker. runtimePreference = OPPOSITE of the implementation worker (Claude impl → Codex verifier; Codex impl → Claude verifier). modelHint = claude-opus-5 OR gpt-5.6-sol; effortHint = high; allowedPaths = []; taskClass = verifier.",
      ].join("\n");
    case "complex":
      return [
        "complex, subtle/byte-level work where atomic claims compound, OR cross-module refactor with ≥3 files changing semantics.",
        "Execution tier: deep (this classification set it): a wider verifier-round budget and more than one corrective rework per worker.",
        "Verifier policy: TWO peer verifiers IN PARALLEL after each implementation worker, one Claude (claude-opus-5@high) and one Codex (gpt-5.6-sol@high). Both with taskClass=verifier, allowedPaths=[], canRunParallel=true. Two model families = two blind spots; peer disagreement IS the signal.",
      ].join("\n");
  }
}

function formatStepDivision(run: RunState): string {
  if (run.steps.length === 0) return "No step-by-step division exists yet.";
  const maxSteps = 10;
  const omitted = Math.max(0, run.steps.length - maxSteps);
  const visibleSteps = omitted > 0 ? run.steps.slice(-maxSteps) : run.steps;
  const prefix = omitted > 0
    ? [`${omitted} older completed step(s) omitted; RUN STATE carries review summaries for the most recent steps. The PROJECT PLAN and the workspace hold the durable record of earlier work.`]
    : [];
  return [
    ...prefix,
    ...visibleSteps
    .map((step) => {
      const kind = step.kind ?? "worker_batch";
      const head = kind === "brake" ? `${step.index}. [BRAKE] ${step.title}` : `${step.index}. ${step.title}`;
      const lines = [truncate(head, 240), `Goal: ${truncate(step.goal, 500)}`];
      if (kind !== "brake") {
        lines.push(`Agents: ${formatPlannedAgents(step.plannedAgents)}`);
      }
      lines.push(`Status: ${step.status}`);
      lines.push(`Acceptance: ${step.acceptanceCriteria.length ? truncate(step.acceptanceCriteria.join("; "), 800) : "not specified"}`);
      return lines.join("\n");
    }),
  ].join("\n\n");
}

function normalizeQuestionOptions(value: unknown): SparkManagerQuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options = value
    .filter((item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .slice(0, 3)
    .map((item, index) => {
      const label = normalizeText(item.label, `Option ${index + 1}`).slice(0, 80);
      const answer = normalizeText(item.answer, label).slice(0, 1200);
      return {
        id: normalizeText(item.id, `option_${index + 1}`).replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || `option_${index + 1}`,
        label,
        description: normalizeText(item.description, answer).slice(0, 220),
        answer,
        recommended: item.recommended === true,
      };
    })
    .filter((item) => item.label && item.answer);
  if (options.length === 0) return [];
  if (!options.some((item) => item.recommended)) options[0].recommended = true;
  let seenRecommended = false;
  for (const option of options) {
    if (!option.recommended) continue;
    if (!seenRecommended) {
      seenRecommended = true;
      continue;
    }
    option.recommended = false;
  }
  return options;
}

function formatPlannedAgents(agents: PlannedStepAgent[] | undefined): string {
  if (!agents?.length) return "not specified";
  return agents
    .map((agent, index) => {
      const model = agent.modelHint?.trim() || agent.runtimePreference;
      const effort = agent.effortHint ? `thinking level ${agent.effortHint}` : "thinking level not specified";
      return `${agent.label || `agent ${index + 1}`} -> ${truncate(agent.summary, 300)} -> ${model} (${effort})`;
    })
    .join("; ");
}
