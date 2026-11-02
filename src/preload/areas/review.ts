// window.spark.review: the renderer side of src/main/review/ (the combined
// diff of the review tab, the per-workspace review notes, and the file a
// newly launched agent reads its notes from).

import { ipcRenderer } from "electron";
import { AGENT_REVIEW_CHANGED_CHANNEL, type AgentReviewState } from "@shared/agent-review";
import type { ReviewDiff, ReviewDiffRequest, ReviewNote } from "@shared/review-notes";

export interface AgentReviewRequest {
  workspaceId: string;
  cwd: string;
  branch: string | null;
  base: string | null;
  reviewer: string;
  runtime?: "claude" | "codex";
}

export interface NewAgentRequest {
  brief: string;
  runtime: "claude" | "codex";
  workspace: string;
  worktree?: { base?: string; purpose?: string };
}

export const reviewApi = {
  diff: (request: ReviewDiffRequest): Promise<ReviewDiff> => ipcRenderer.invoke("review:diff", request),
  listNotes: (workspaceId: string): Promise<ReviewNote[]> => ipcRenderer.invoke("review:notes:list", workspaceId),
  /** Replaces the workspace's notes; returns them as stored. */
  saveNotes: (workspaceId: string, notes: ReviewNote[]): Promise<ReviewNote[]> =>
    ipcRenderer.invoke("review:notes:save", { workspaceId, notes }),
  /** Saves the text under the workspace's data folder and returns the file's path. */
  handoff: (workspaceId: string, text: string): Promise<string> =>
    ipcRenderer.invoke("review:handoff", { workspaceId, text }),
  /** Reviews by an agent: running, finished with notes not yet added, or failed. */
  agentReviews: (): Promise<AgentReviewState[]> => ipcRenderer.invoke("agentReview:list"),
  /** Opens a review and returns its prompt, for a running agent or Cora to receive. */
  prepareAgentReview: (request: AgentReviewRequest): Promise<{ state: AgentReviewState; brief: string }> =>
    ipcRenderer.invoke("agentReview:prepare", request),
  /** Starts a new Claude Code or Codex session as the reviewer. */
  startAgentReview: (request: AgentReviewRequest): Promise<AgentReviewState> =>
    ipcRenderer.invoke("agentReview:start", request),
  acknowledgeAgentReview: (id: string): Promise<void> => ipcRenderer.invoke("agentReview:acknowledge", id),
  dismissAgentReview: (id: string): Promise<void> => ipcRenderer.invoke("agentReview:dismiss", id),
  onAgentReviewChanged: (listener: (state: AgentReviewState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: AgentReviewState): void => listener(state);
    ipcRenderer.on(AGENT_REVIEW_CHANGED_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(AGENT_REVIEW_CHANGED_CHANNEL, wrapped);
  },
  /** Starts an agent on the user's task, through the same path agents use. */
  startAgent: (request: NewAgentRequest): Promise<{ id: string; title: string; branch: string | null; workspace: string }> =>
    ipcRenderer.invoke("sourceAgents:start", request),
};
