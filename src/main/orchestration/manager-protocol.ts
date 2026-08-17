// Cora's manager decision types: the provider-agnostic shapes a manager turn
// settles into (SparkManagerDecision and friends). The live pipeline builds
// these in execute-decision.ts from the tool calls a Pi turn actually made,
// and run-store applies them (spawn workers, ask user, complete).
//
// The manager's prompts live elsewhere: the system prompt in
// resources/pi-cora/prompt.ts, the per-turn user text in agent-backend's
// buildManagerTurnPrompt, and the worker briefs in worker-prompt.ts.

import type {
  PlannedStepAgent,
  RunQuestionCategory,
  StepKind,
  TaskComplexity,
  WorkerRuntime,
  WorkerTask,
} from "@shared/types";

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

export interface SparkManagerQuestionOption {
  id: string;
  label: string;
  description: string;
  answer: string;
  recommended?: boolean;
}

export type ManagerMode = "plan_analysis" | "chat" | "step_planning" | "worker_result_review";
