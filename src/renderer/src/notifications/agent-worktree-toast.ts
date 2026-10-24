import type { AgentWorktreeEvent, NavigationTarget } from "@shared/types";

// The toast for a worktree an agent created or removed through the Codara
// Studio MCP. The rail already shows the change; the toast says who made it.

const CLIENT_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude/i, "Claude Code"],
  [/^codex/i, "Codex"],
  [/^grok/i, "Grok"],
  [/^cora$/i, "Cora"],
];

export function agentClientLabel(client: string): string {
  for (const [pattern, label] of CLIENT_LABELS) if (pattern.test(client)) return label;
  return "An agent";
}

export interface AgentWorktreeToast {
  title: string;
  body: string;
  target?: NavigationTarget;
}

export function agentWorktreeToast(event: AgentWorktreeEvent): AgentWorktreeToast {
  const who = agentClientLabel(event.client);
  if (event.kind === "created") {
    return {
      title: `${who} created a worktree`,
      body: event.name === event.branch ? event.branch : `${event.name} (${event.branch})`,
      target: { type: "workspace", workspaceId: event.workspaceId },
    };
  }
  return {
    title: `${who} removed a merged worktree`,
    body: event.pullRequest ? `${event.branch}, merged in PR #${event.pullRequest.number}` : event.branch,
  };
}

// At most one toast per workspace in this window, so an agent retrying a
// create or remove does not stack identical cards.
export const AGENT_WORKTREE_TOAST_GAP_MS = 5_000;
