// The agent side of src/main/agent-delivery.ts: an agent pulls what the user
// queued for its pane or its workspace.

import { agentDelivery } from "../agent-delivery";
import { PreviewToolParamsError, type PreviewToolTable } from "./types";

export const inboxPreviewTools: PreviewToolTable = {
  "preview.inbox": async (params) => {
    const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : "";
    if (!workspaceId) throw new PreviewToolParamsError("No workspace is open for this session.");
    const paneId = typeof params.callerPaneId === "string" ? params.callerPaneId : null;
    const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.min(100, Math.max(1, Math.round(params.limit))) : 20;
    const delivery = agentDelivery();
    const items = delivery.pull({ workspaceId, paneId, peek: params.peek === true, limit });
    return { items, remaining: delivery.pending(workspaceId, paneId) };
  },
};
