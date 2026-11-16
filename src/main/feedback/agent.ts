// codara_feedback_send (socket feedback.send): an agent sends feedback about
// Studio as source "agent". By default Studio first shows the person the
// exact text and who is sending it, and sends only on their yes; the
// preference askBeforeAgentFeedback turns that question off. Pure apart from
// the injected deps, so scripts/test-feedback-agent.cjs runs every branch.

import {
  feedbackMessageProblem,
  isFeedbackKind,
  type FeedbackAnswer,
  type FeedbackKind,
  type FeedbackSendAsk,
  type FeedbackSendResult,
} from "../../shared/feedback";

// The person may be away from the screen; the MCP server waits a little
// longer than this (FEEDBACK_SEND_TIMEOUT_MS in server.js).
export const FEEDBACK_ASK_TIMEOUT_MS = 120_000;

export interface AgentFeedbackDeps {
  /** Who is asking, as the question names them. */
  caller(): Promise<{ agent: string; workspaceName: string | null }>;
  askFirst(): Promise<boolean>;
  ask(request: Omit<FeedbackSendAsk, "id" | "expiresAt">, signal?: AbortSignal): Promise<FeedbackAnswer | null>;
  send(draft: { kind: FeedbackKind; message: string }): Promise<FeedbackSendResult>;
  signal?: AbortSignal;
}

export class AgentFeedbackParamsError extends Error {}

export async function agentSendFeedback(params: Record<string, unknown>, deps: AgentFeedbackDeps): Promise<Record<string, unknown>> {
  const kind = params.kind === undefined ? "other" : params.kind;
  if (!isFeedbackKind(kind)) throw new AgentFeedbackParamsError("kind must be bug, idea or other.");
  if (typeof params.message !== "string") throw new AgentFeedbackParamsError("message must be plain text.");
  const message = params.message.trim();
  const problem = feedbackMessageProblem(message);
  if (problem) throw new AgentFeedbackParamsError(problem);

  if (await deps.askFirst()) {
    const { agent, workspaceName } = await deps.caller();
    const answer = await deps.ask({ action: "send", agent, workspaceName, kind, message }, deps.signal);
    if (answer === "no") {
      return { sent: false, reason: "declined", note: "The user chose not to send it. Do not send it again unless they ask." };
    }
    if (answer !== "yes") {
      return { sent: false, reason: "no_answer", note: "The user did not answer in Codara, so nothing was sent." };
    }
  }
  const result = await deps.send({ kind, message });
  return result.ok
    ? { sent: true, id: result.id }
    : { sent: false, reason: result.error, note: result.message };
}
