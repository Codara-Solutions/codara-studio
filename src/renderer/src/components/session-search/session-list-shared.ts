import {
  sessionSearchProgressLine,
  type SessionSearchScope,
  type SessionSearchStatus,
} from "@shared/session-search";

// What the rail's Sessions view and the session picker have in common: where
// to look, remembered between them, and how they word the index's state.

export const SESSION_SCOPE_KEY = "codara.sessions.scope";

export const SESSION_SCOPES: { id: SessionSearchScope; label: string; hint: string }[] = [
  { id: "workspace", label: "Workspace", hint: "Sessions in this workspace's folder" },
  { id: "project", label: "Project", hint: "Sessions in every worktree of this repository" },
  { id: "all", label: "All", hint: "Every session on this computer" },
];

export function readSessionScope(): SessionSearchScope {
  try {
    const value = window.localStorage.getItem(SESSION_SCOPE_KEY);
    return value === "workspace" || value === "all" ? value : "project";
  } catch {
    return "project";
  }
}

export function rememberSessionChoice(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* remembering the choice is best-effort */
  }
}

export function folderName(cwd: string | null): string {
  if (!cwd) return "";
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

export function sessionStatusLine(status: SessionSearchStatus): string {
  if (status.phase === "paused") {
    return status.pausedReason === "battery"
      ? "Indexing waits while this computer is on battery"
      : "Indexing waits while this computer is busy";
  }
  if (status.phase === "error") return status.error ?? "The session index stopped";
  return sessionSearchProgressLine(status);
}
