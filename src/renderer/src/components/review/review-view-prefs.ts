import type { ReviewDiffMode } from "@shared/review-notes";

// Which view the review tab shows for a workspace, and asking it to open on
// a workspace's work since its base. A per-window convenience, so localStorage.

export interface ReviewViewPrefs {
  mode: ReviewDiffMode;
  base: string | null;
}

const PREFS_KEY = "codara.review.view:";

export function readReviewViewPrefs(workspaceId: string | null): ReviewViewPrefs {
  try {
    const raw = workspaceId ? localStorage.getItem(PREFS_KEY + workspaceId) : null;
    const value = raw ? (JSON.parse(raw) as Partial<ReviewViewPrefs>) : null;
    return { mode: value?.mode === "base" ? "base" : "uncommitted", base: typeof value?.base === "string" ? value.base : null };
  } catch {
    return { mode: "uncommitted", base: null };
  }
}

export function writeReviewViewPrefs(workspaceId: string | null, prefs: ReviewViewPrefs): void {
  if (!workspaceId) return;
  try {
    localStorage.setItem(PREFS_KEY + workspaceId, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable; the view just starts on its default.
  }
}

/**
 * Opens the review tab of a workspace, switching to it if needed, on what it
 * changed since its base: a lane's commits are what the user came to read.
 * Its last chosen base stays. App.tsx listens for the event.
 */
export function requestReviewAgainstBase(workspaceId: string): void {
  writeReviewViewPrefs(workspaceId, { mode: "base", base: readReviewViewPrefs(workspaceId).base });
  window.dispatchEvent(new CustomEvent("spark:open-review", { detail: { workspaceId } }));
}
