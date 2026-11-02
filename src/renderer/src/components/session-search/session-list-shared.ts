import {
  sessionSearchProgressLine,
  type SessionSearchAgent,
  type SessionSearchScope,
  type SessionSearchStatus,
} from "@shared/session-search";

// The session picker's choices, remembered between openings, and how it words
// the index's state.

export const SESSION_SCOPE_KEY = "codara.sessions.scope";
export const SESSION_AGENTS_KEY = "codara.sessions.agents";

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

export function readSessionAgents(): SessionSearchAgent[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(SESSION_AGENTS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is SessionSearchAgent => typeof item === "string") : [];
  } catch {
    return [];
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
