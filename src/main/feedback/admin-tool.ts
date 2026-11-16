// The feedback admin tools in the running app: the token from
// admin-token.ts, who is asking (agent-tool.ts), the delete question card and
// the items this session listed. The rules are in admin-agent.ts.

import type { FeedbackItem } from "@shared/feedback";
import type { PreviewToolHost } from "../preview-tools/types";
import { FEEDBACK_ASK_TIMEOUT_MS } from "./agent";
import { feedbackCaller } from "./agent-tool";
import { adminDeleteFeedback, adminListFeedback, adminUpdateFeedback, type AdminAgentDeps } from "./admin-agent";
import { feedbackAdminToken } from "./admin-token";
import { feedbackAsks } from "./asks";

const seen = new Map<string, FeedbackItem>();

function deps(params: Record<string, unknown>, host: PreviewToolHost, tool: string): AdminAgentDeps {
  return {
    token: feedbackAdminToken,
    caller: () => feedbackCaller(params, host, tool),
    ask: (request, signal) => feedbackAsks().ask(request, { timeoutMs: FEEDBACK_ASK_TIMEOUT_MS, signal }),
    seen,
    signal: host.signal,
  };
}

export async function feedbackAdminConfigured(): Promise<{ configured: boolean }> {
  return { configured: (await feedbackAdminToken()) !== null };
}

export const runFeedbackList = (params: Record<string, unknown>, host: PreviewToolHost) => adminListFeedback(params, deps(params, host, "codara_feedback_list"));
export const runFeedbackUpdate = (params: Record<string, unknown>, host: PreviewToolHost) => adminUpdateFeedback(params, deps(params, host, "codara_feedback_update"));
export const runFeedbackDelete = (params: Record<string, unknown>, host: PreviewToolHost) => adminDeleteFeedback(params, deps(params, host, "codara_feedback_delete"));
