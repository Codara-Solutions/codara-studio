// codara_feedback_send (socket feedback.send). The handler loads with the
// first call; the rules are in ../feedback/agent.ts. Refused for an imported
// pull-request run: what such an agent reads must not speak for the user.

import { PreviewToolParamsError, type PreviewToolTable } from "./types";

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
};
