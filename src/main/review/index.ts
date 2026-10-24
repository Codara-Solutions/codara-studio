// The review tab's channels: the combined diff, the per-workspace notes and
// the hand-off file for a newly launched agent. Registered by ipc.ts through
// its sender-gated `handle`.

import type { ReviewDiff, ReviewDiffRequest, ReviewNote } from "@shared/review-notes";
import type { IpcHandle } from "../ipc";
import { createReviewNotesStore } from "./notes-store";
import { getReviewDiff, type ReviewDiffDeps } from "./review-diff";

const store = createReviewNotesStore();

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

const liveDeps: ReviewDiffDeps = {
  // A copy-branch workspace forked from a branch remembers it; that is the
  // base its changes are reviewed against.
  async workspaceBase(cwd) {
    const { cachedState, loadState } = await import("../storage");
    const state = cachedState() ?? (await loadState());
    const workspace = state.workspaces.find((candidate) => samePath(candidate.cwd, cwd));
    const copy = workspace?.copyBranch;
    if (!copy || copy.mode === "checkout") return null;
    const base = copy.baseBranch?.trim();
    return base && base !== "HEAD" ? base : null;
  },
  async defaultBase(cwd) {
    const { resolveDefaultBranch } = await import("../git-worktrees");
    return resolveDefaultBranch(cwd);
  },
};

function diffRequest(raw: unknown): ReviewDiffRequest {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    mode: value.mode === "base" ? "base" : "uncommitted",
    base: typeof value.base === "string" ? value.base.slice(0, 250) : null,
    ...(Array.isArray(value.paths) ? { paths: value.paths.filter((path): path is string => typeof path === "string").map((path) => path.slice(0, 4096)) } : {}),
    listBases: value.listBases === true,
    force: value.force === true,
  };
}

export function registerReviewIpc(handle: IpcHandle): void {
  handle("review:diff", async (_event, raw: unknown): Promise<ReviewDiff> => getReviewDiff(diffRequest(raw), liveDeps));
  handle("review:notes:list", async (_event, workspaceId: unknown): Promise<ReviewNote[]> => store.list(String(workspaceId ?? "")));
  handle("review:notes:save", async (_event, raw: { workspaceId?: unknown; notes?: unknown }): Promise<ReviewNote[]> =>
    store.save(String(raw?.workspaceId ?? ""), raw?.notes),
  );
  handle("review:handoff", async (_event, raw: { workspaceId?: unknown; text?: unknown }): Promise<string> =>
    store.handoff(String(raw?.workspaceId ?? ""), typeof raw?.text === "string" ? raw.text : ""),
  );
}
