// codara_feedback_send (socket feedback.send) and a Codara admin's
// codara_feedback_list, _update and _delete (feedback.list, .update, .delete;
// feedback.admin_status tells the MCP server whether to list them). Handlers
// load with the first call; the rules are in ../feedback/agent.ts and
// admin-agent.ts. All refused for an imported pull-request run: what such an
// agent reads must not speak for the user or manage feedback.

import { PreviewToolParamsError, type PreviewToolTable } from "./types";

type AdminRunner = "runFeedbackList" | "runFeedbackUpdate" | "runFeedbackDelete";

function adminTool(runner: AdminRunner): PreviewToolTable[string] {
  return {
    scope: "none",
    trustedRunsOnly: true,
    async run(params, _method, host) {
      const [tools, { AdminFeedbackParamsError }] = await Promise.all([import("../feedback/admin-tool"), import("../feedback/admin-agent")]);
      try {
        return await tools[runner](params, host);
      } catch (error) {
        if (error instanceof AdminFeedbackParamsError) throw new PreviewToolParamsError(error.message);
        throw error;
      }
    },
  };
}

export const feedbackTools: PreviewToolTable = {
  "feedback.send": {
    scope: "none",
    trustedRunsOnly: true,
    async run(params, _method, host) {
      const [{ runAgentFeedbackSend }, { AgentFeedbackParamsError }] = await Promise.all([
        import("../feedback/agent-tool"),
        import("../feedback/agent"),
      ]);
      try {
        return await runAgentFeedbackSend(params, host);
      } catch (error) {
        if (error instanceof AgentFeedbackParamsError) throw new PreviewToolParamsError(error.message);
        throw error;
      }
    },
  },
  "feedback.admin_status": {
    scope: "none",
    trustedRunsOnly: true,
    run: async () => (await import("../feedback/admin-tool")).feedbackAdminConfigured(),
  },
  "feedback.list": adminTool("runFeedbackList"),
  "feedback.update": adminTool("runFeedbackUpdate"),
  "feedback.delete": adminTool("runFeedbackDelete"),
};
