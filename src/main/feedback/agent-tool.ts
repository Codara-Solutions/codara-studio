// codara_feedback_send in the running app: who is asking (the caller's agent
// and workspace, never tool JSON), the person's ask-first preference, the
// question card and the send. The rules are in agent.ts.

import { workspaceStatusAgentLabel } from "@shared/workspace-status";
import { loadPreferences } from "../preferences-store";
import { loadState } from "../storage";
import { callerWorkspace } from "../preview-tools/workspace-status";
import type { PreviewToolHost } from "../preview-tools/types";
import { agentSendFeedback, FEEDBACK_ASK_TIMEOUT_MS } from "./agent";
import { feedbackAsks } from "./asks";
import { sendStudioFeedback } from "./service";

/** Who is asking, as a question card names them: never from tool JSON. */
export async function feedbackCaller(
  params: Record<string, unknown>,
  host: PreviewToolHost,
  tool: string,
): Promise<{ agent: string; workspaceName: string | null }> {
  const client = typeof params.callerClient === "string" ? params.callerClient : "";
  const located = await callerWorkspace(params, host, tool);
  // An agent started outside Codara still asks; it has no workspace to name.
  if ("refusal" in located) return { agent: workspaceStatusAgentLabel(client), workspaceName: null };
  const workspace = (await loadState()).workspaces.find((entry) => entry.id === located.workspaceId);
  return { agent: located.by.label, workspaceName: workspace?.name ?? null };
}

export function runAgentFeedbackSend(params: Record<string, unknown>, host: PreviewToolHost): Promise<Record<string, unknown>> {
  return agentSendFeedback(params, {
    caller: () => feedbackCaller(params, host, "codara_feedback_send"),
    askFirst: async () => (await loadPreferences()).askBeforeAgentFeedback !== false,
    ask: (request, signal) => feedbackAsks().ask(request, { timeoutMs: FEEDBACK_ASK_TIMEOUT_MS, signal }),
    send: (draft) => sendStudioFeedback({ ...draft, contact: null }, "agent"),
    signal: host.signal,
  });
}
