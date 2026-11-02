// The review tab's channels: the combined diff, the per-workspace notes and
// the hand-off file for a newly launched agent. Registered by ipc.ts through
// its sender-gated `handle`.

import { BrowserWindow } from "electron";
import type { ReviewDiff, ReviewDiffRequest, ReviewNote } from "@shared/review-notes";
import type { IpcHandle } from "../ipc";
import { AGENT_REVIEW_CHANGED_CHANNEL, type AgentReviewState } from "@shared/agent-review";
import { isRemotePath } from "@shared/remote";
import { AgentReviews, type AgentReviewStartRequest } from "./agent-review";
import { createReviewNotesStore } from "./notes-store";
import { getReviewDiff, isSafeRefName, type ReviewDiffDeps } from "./review-diff";

const store = createReviewNotesStore();

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export const reviewBaseDeps: ReviewDiffDeps = {
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

let reviews: AgentReviews | null = null;

export function agentReviews(): AgentReviews {
  if (!reviews) {
    reviews = new AgentReviews({
      startSession: async (input) => (await import("../agent-socket")).startAgentSessionForUser(input),
      viewSession: async (id) => (await import("../agent-socket")).agentSessionViewForUser(id),
      emit: (state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(AGENT_REVIEW_CHANGED_CHANNEL, state);
        }
      },
    });
  }
  return reviews;
}

function reviewRequest(raw: unknown): AgentReviewStartRequest {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const text = (key: string, max: number) => {
    const field = value[key];
    return typeof field === "string" && field.trim() ? field.trim().slice(0, max) : null;
  };
  const workspaceId = text("workspaceId", 200);
  const cwd = text("cwd", 16_384);
  const reviewer = text("reviewer", 80);
  if (!workspaceId || !cwd || !reviewer) throw new Error("A review needs a workspace, a folder and a reviewer.");
  if (isRemotePath(cwd)) throw new Error("A review with an agent runs on local checkouts only.");
  const base = text("base", 250);
  return {
    workspaceId,
    cwd,
    reviewer,
    branch: text("branch", 250),
    // Goes into a command the reviewer runs, so only a plain branch name does.
    base: base && isSafeRefName(base) ? base : null,
    ...(value.runtime === "claude" || value.runtime === "codex" ? { runtime: value.runtime } : {}),
  };
}

export function registerReviewIpc(handle: IpcHandle): void {
  handle("agentReview:list", async (): Promise<AgentReviewState[]> => agentReviews().list());
  handle("agentReview:prepare", async (_event, raw: unknown) => agentReviews().prepare(reviewRequest(raw)));
  handle("agentReview:start", async (_event, raw: unknown): Promise<AgentReviewState> => {
    const request = reviewRequest(raw);
    if (!request.runtime) throw new Error("A new reviewer needs an agent: Claude Code or Codex.");
    return agentReviews().start({ ...request, runtime: request.runtime });
  });
  handle("agentReview:acknowledge", async (_event, id: unknown, saved: unknown) => {
    if (typeof id !== "string" || !Array.isArray(saved)) return;
    agentReviews().acknowledge(id, saved.filter((value): value is string => typeof value === "string"));
  });
  handle("agentReview:dismiss", async (_event, id: unknown) => {
    if (typeof id === "string") agentReviews().dismiss(id);
  });
  handle("sourceAgents:start", async (_event, raw: unknown) => {
    const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const { startAgentSessionForUser } = await import("../agent-socket");
    const worktree = value.worktree && typeof value.worktree === "object" ? (value.worktree as { base?: string; purpose?: string }) : undefined;
    return startAgentSessionForUser({
      brief: typeof value.brief === "string" ? value.brief : "",
      runtime: value.runtime === "codex" ? "codex" : "claude",
      workspace: typeof value.workspace === "string" ? value.workspace : "",
      ...(worktree ? { worktree: { ...(worktree.base ? { base: worktree.base } : {}), ...(worktree.purpose ? { purpose: worktree.purpose } : {}) } } : {}),
    });
  });

  handle("review:diff", async (_event, raw: unknown): Promise<ReviewDiff> => getReviewDiff(diffRequest(raw), reviewBaseDeps));
  handle("review:notes:list", async (_event, workspaceId: unknown): Promise<ReviewNote[]> => store.list(String(workspaceId ?? "")));
  handle("review:notes:save", async (_event, raw: { workspaceId?: unknown; notes?: unknown }): Promise<ReviewNote[]> =>
    store.save(String(raw?.workspaceId ?? ""), raw?.notes),
  );
  handle("review:handoff", async (_event, raw: { workspaceId?: unknown; text?: unknown }): Promise<string> =>
    store.handoff(String(raw?.workspaceId ?? ""), typeof raw?.text === "string" ? raw.text : ""),
  );
}
