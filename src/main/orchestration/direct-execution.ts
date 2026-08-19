import type { ChatMode, CoraExecutionStrategy } from "@shared/types";

const MANAGED_REQUEST =
  /\b(?:all (?:failures|lint errors|tests|type errors|typecheck errors)|architecture|architectural|audit (?:the )?(?:entire|whole)|background task|deep research|everything|investigate (?:the )?(?:entire|whole)|long[- ]running|migration|multi[- ]agent|parallel(?:ize|ise| work| agents?)|plan mode|refactor (?:the )?(?:app|application|codebase|project|repository)|repository[- ]wide|research the web|search the web|whole (?:app|application|codebase|project|repository)|work across (?:the )?(?:app|codebase|project|repository))\b/i;

export interface DirectExecutionDecisionInput {
  strategy?: CoraExecutionStrategy;
  cwd: string;
  prompt?: string;
  chatMode?: ChatMode;
  hasPlan?: boolean;
  hasAttachments?: boolean;
  hasFanOut?: boolean;
  hasCouncil?: boolean;
}

/**
 * Pick Cora's direct lane before spending a manager turn.
 *
 * Explicit choices always win. Auto stays deliberately conservative: a short
 * bounded request goes straight to one capable tool-using model; broad,
 * parallel, research, and plan-shaped work keeps Cora's orchestrator. Repo
 * size is deliberately irrelevant: scanning a large tree adds latency, and a
 * one-file fix is still bounded when the repository happens to be large.
 */
export async function shouldUseDirectExecution(
  input: DirectExecutionDecisionInput,
): Promise<boolean> {
  if (input.strategy === "managed") return false;
  if (
    !input.prompt?.trim() ||
    input.chatMode === "talk" ||
    input.hasPlan ||
    input.hasAttachments ||
    input.hasFanOut ||
    input.hasCouncil
  ) {
    return false;
  }
  if (input.strategy === "direct") return true;

  const prompt = input.prompt.trim();
  if (prompt.length > 4_000 || MANAGED_REQUEST.test(prompt)) return false;
  return true;
}
