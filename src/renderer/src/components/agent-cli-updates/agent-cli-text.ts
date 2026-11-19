// What the worker picker and Settings say about each agent CLI. Pure, so
// scripts/test-agent-cli-text.cjs checks every state without a window.

import type { AgentCliToolId, AgentCliToolStatus, AgentCliUpdatesSnapshot } from "@shared/agent-cli-updates";

export const UPDATE_IN_PROGRESS: ReadonlySet<AgentCliToolStatus["phase"]> = new Set(["updating", "verifying", "rolling-back"]);

export interface AgentCliMark {
  label: string;
  tone: "accent" | "muted" | "warn" | "danger";
  title: string;
  action: "update" | "settings" | null;
}

/** The mark a worker row carries, or null when there is nothing to say. */
export function agentCliMark(tool: AgentCliToolStatus | null, requestError: string | null = null, pending = false): AgentCliMark | null {
  if (!tool || !tool.installed) return null;
  if (tool.id === "pi") {
    if (!tool.version) return null;
    const pinned = tool.pinnedVersion ?? tool.version;
    return tool.version === pinned
      ? { label: `Pinned ${pinned}`, tone: "muted", title: `Pi ${pinned}, the version Codara is tested with. Codara never updates it.`, action: null }
      : {
          label: `Pi ${tool.version}`,
          tone: "warn",
          title: `Pi ${tool.version} is installed; Codara is tested with ${pinned}.`,
          action: "settings",
        };
  }
  if (requestError) return { label: "Update failed", tone: "danger", title: requestError, action: "settings" };
  // Asked for, and main has not started it yet (another tool is updating first).
  if (pending && !UPDATE_IN_PROGRESS.has(tool.phase)) {
    return { label: "Queued", tone: "muted", title: `${tool.label} updates as soon as it is its turn.`, action: null };
  }
  if (UPDATE_IN_PROGRESS.has(tool.phase)) {
    return { label: tool.phase === "rolling-back" ? "Restoring" : "Updating", tone: "muted", title: tool.message ?? "Updating…", action: null };
  }
  if (tool.phase === "waiting") return { label: "Waiting", tone: "muted", title: tool.message ?? "Waiting for sessions to end.", action: "settings" };
  if (tool.phase === "rolled-back") return { label: "Rolled back", tone: "warn", title: tool.message ?? "", action: "settings" };
  if (tool.phase === "failed") return { label: "Update failed", tone: "danger", title: tool.message ?? "", action: "settings" };
  if (!tool.updateAvailable) return null;
  const title = `${tool.label} ${tool.latestVersion} is out (you have ${tool.version}).`;
  return tool.canUpdate
    ? { label: "Update", tone: "accent", title: `${title} Update now.`, action: "update" }
    : { label: "Update", tone: "accent", title: `${title} Run: ${tool.manualCommand}`, action: "settings" };
}

/** Tools whose phase or version changed: a refusal shown for them is out of date. */
export function changedAgentCliTools(previous: AgentCliUpdatesSnapshot | null, next: AgentCliUpdatesSnapshot): AgentCliToolId[] {
  return next.tools
    .filter((tool) => {
      const before = previous?.tools.find((entry) => entry.id === tool.id);
      return !before || before.phase !== tool.phase || before.version !== tool.version;
    })
    .map((tool) => tool.id);
}

/** The row's version line; before the first check nothing is known yet. */
export function agentCliVersionLine(tool: AgentCliToolStatus, snapshot: Pick<AgentCliUpdatesSnapshot, "lastCheckedAt" | "checking">): string {
  if (!tool.installed) {
    if (snapshot.lastCheckedAt === null) return snapshot.checking ? "Checking…" : "Not checked yet.";
    return "Not installed.";
  }
  const parts = [tool.version ? `v${tool.version}` : "Version unknown"];
  if (tool.id === "pi") parts.push(`pinned to ${tool.pinnedVersion}`);
  if (tool.installSource) parts.push(tool.installSource);
  return parts.join(" · ");
}
