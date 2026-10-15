// window.spark.review: the renderer side of src/main/review/ (the combined
// diff of the review tab, the per-workspace review notes, and the file a
// newly launched agent reads its notes from).

import { ipcRenderer } from "electron";
import type { ReviewDiff, ReviewDiffRequest, ReviewNote } from "@shared/review-notes";

export const reviewApi = {
  diff: (request: ReviewDiffRequest): Promise<ReviewDiff> => ipcRenderer.invoke("review:diff", request),
  listNotes: (workspaceId: string): Promise<ReviewNote[]> => ipcRenderer.invoke("review:notes:list", workspaceId),
  /** Replaces the workspace's notes; returns them as stored. */
  saveNotes: (workspaceId: string, notes: ReviewNote[]): Promise<ReviewNote[]> =>
    ipcRenderer.invoke("review:notes:save", { workspaceId, notes }),
  /** Saves the text under the workspace's data folder and returns the file's path. */
  handoff: (workspaceId: string, text: string): Promise<string> =>
    ipcRenderer.invoke("review:handoff", { workspaceId, text }),
};
