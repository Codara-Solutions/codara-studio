// OpenRouter backend — adapter from the existing openrouter-manager helpers
// to the SparkAgentBackend interface. No behaviour change: this is the path
// every chat hit before the backend-abstraction split, and remains the
// default for chats whose `chatBackend` is undefined.
//
// Talk mode is handled by passing managerMode="chat" through to the existing
// pipeline — that mode already returns a chatReply in the SparkManagerDecision
// and the run-store consumer treats it as a no-work answer.

import type {
  ManagerCallResult,
  ManagerRequestInput,
  SparkAgentBackend,
} from "./spark-agent-backend";
import {
  buildOpenRouterManagerRequest,
  isStructuredOutputUnsupportedError,
  readOpenRouterConfig,
  requestOpenRouterManagerDecision,
  type OpenRouterManagerRequest,
} from "./openrouter-manager";
import { loadManagerPromptProfile } from "./prompt-profile";

const MANAGER_REQUEST_MAX_ATTEMPTS = 3;
const MANAGER_REQUEST_BACKOFF_BASE_MS = 600;

export const openRouterBackend: SparkAgentBackend = {
  kind: "openrouter",
  displayName: "OpenRouter",

  async requestManagerDecision(input: ManagerRequestInput): Promise<ManagerCallResult> {
    const config = readOpenRouterConfig(input.settings);
    if (!config) {
      throw new Error("OpenRouter API key is not configured. Set it in Settings > OpenRouter.");
    }
    const promptProfile = loadManagerPromptProfile();
    // Per-chat model override beats the global setting. This is what makes the
    // composer chip useful for OpenRouter chats — switching models mid-chat
    // picks up the new model on the next call.
    const effectiveModel = input.chat.model || config.model;
    const requestBody = buildOpenRouterManagerRequest({
      run: input.run,
      cwd: input.cwd,
      model: effectiveModel,
      mode: input.mode,
      workerReports: input.workerReports,
      availableRuntimes: input.availableRuntimes,
      agentSyncContext: input.agentSyncContext,
      promptProfile,
    });
    const result = await callWithRetry(config, requestBody, input.mode);
    return {
      decision: result.decision,
      durationMs: result.durationMs,
      model: result.model,
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    };
  },
};

async function callWithRetry(
  config: Parameters<typeof requestOpenRouterManagerDecision>[0],
  requestBody: OpenRouterManagerRequest,
  mode: Parameters<typeof requestOpenRouterManagerDecision>[2],
) {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MANAGER_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await requestOpenRouterManagerDecision(config, requestBody, mode);
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (isTerminalManagerError(message)) throw err;
      if (attempt >= MANAGER_REQUEST_MAX_ATTEMPTS) throw err;
      const backoffMs = MANAGER_REQUEST_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
}

function isTerminalManagerError(message: string): boolean {
  if (isStructuredOutputUnsupportedError(message)) return true;
  const lower = message.toLowerCase();
  if (lower.includes("invalid api key")) return true;
  if (lower.includes("insufficient")) return true;
  if (lower.includes("400 ")) return true;
  if (lower.includes("401 ")) return true;
  if (lower.includes("403 ")) return true;
  return false;
}
