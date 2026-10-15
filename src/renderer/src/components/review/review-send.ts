// Where a batch of review notes can go, and how a new agent is started on
// them. Pure functions of the routing menu, kept out of the components so
// scripts/test-review-notes.cjs pins them.

import type { AgentDeliveryTarget } from "@shared/agent-delivery";
import type { RoutingDestination } from "../../routing/SelectionRoutingContext";
import { CLAUDE_LAUNCH_COMMAND, CODEX_LAUNCH_COMMAND } from "../../workers/launch-commands";

export type NewAgentRuntime = "claude" | "codex";

export interface ReviewDestination {
  /** "pane:<id>", "chat:<runId>", "chat-new", "agent-new:<runtime>" or "inbox". */
  id: string;
  kind: "pane" | "chat" | "chat-new" | "agent-new" | "inbox";
  label: string;
  sublabel?: string;
  group: "agents" | "chat" | "new" | "inbox";
  disabled?: boolean;
  disabledReason?: string;
  runtime?: NewAgentRuntime;
  /**
   * Press Enter after pasting. Only into a pane an agent runs in: a plain
   * shell would run each line of the notes as a command.
   */
  submit?: boolean;
}

export const REVIEW_GROUP_TITLES: Record<ReviewDestination["group"], string> = {
  agents: "Terminals in this workspace",
  chat: "Cora",
  new: "New agent",
  inbox: "Inbox",
};

const NEW_AGENTS: Array<{ runtime: NewAgentRuntime; label: string }> = [
  { runtime: "claude", label: "New Claude Code agent" },
  { runtime: "codex", label: "New Codex agent" },
];

/**
 * The send menu: every terminal pane of the workspace, its Cora chats, new
 * agents (a Cora chat or an agent CLI in a new terminal tab), and the inbox.
 */
export function reviewDestinations(routing: readonly RoutingDestination[], hasWorkspace: boolean): ReviewDestination[] {
  const out: ReviewDestination[] = [];
  for (const destination of routing) {
    if (destination.kind === "pane" || destination.kind === "chat" || destination.kind === "inbox") {
      const agent = destination.kind === "pane" ? (destination as RoutingDestination & { agent?: boolean }).agent === true : true;
      out.push({
        id: destination.id,
        kind: destination.kind,
        label: destination.label,
        ...(destination.kind === "pane" && !agent
          ? { sublabel: "no agent, pasted without Enter" }
          : destination.sublabel
            ? { sublabel: destination.sublabel }
            : {}),
        group: destination.kind === "pane" ? "agents" : destination.kind === "chat" ? "chat" : "inbox",
        ...(destination.kind === "pane" ? { submit: agent } : {}),
        ...(destination.disabled ? { disabled: true, disabledReason: destination.disabledReason } : {}),
      });
    } else if (destination.kind === "chat-new") {
      out.push({
        id: destination.id,
        kind: "chat-new",
        label: destination.label,
        group: "new",
        ...(destination.disabled ? { disabled: true, disabledReason: destination.disabledReason } : {}),
      });
    }
  }
  for (const agent of NEW_AGENTS) {
    out.push({
      id: `agent-new:${agent.runtime}`,
      kind: "agent-new",
      label: agent.label,
      sublabel: "new terminal tab",
      group: "new",
      runtime: agent.runtime,
      ...(hasWorkspace ? {} : { disabled: true, disabledReason: "Open a workspace first." }),
    });
  }
  const order: ReviewDestination["group"][] = ["agents", "chat", "new", "inbox"];
  return order.flatMap((group) => out.filter((destination) => destination.group === group));
}

/** The delivery target of a menu row that main's delivery service handles. */
export function reviewDeliveryTarget(destination: Pick<ReviewDestination, "id" | "kind">): AgentDeliveryTarget | null {
  if (destination.kind === "inbox") return { kind: "inbox", paneId: null };
  if (destination.kind === "pane" && destination.id.startsWith("pane:")) return { kind: "pane", paneId: destination.id.slice("pane:".length) };
  if (destination.kind === "chat" && destination.id.startsWith("chat:")) return { kind: "chat", runId: destination.id.slice("chat:".length) };
  return null;
}

// What a path inside double quotes may hold so that bash, zsh, fish, cmd and
// PowerShell all pass it through unchanged: no $, backtick, ", %, !, ^ or
// control characters.
const SHELL_SAFE_PATH = /^[A-Za-z0-9 _.,:+@~/\\()[\]{}=-]+$/;

/**
 * The command that starts an agent CLI on the notes saved at `path`. The
 * prompt only names the file, so it is the same short, quote-free line on
 * every shell; null when the path holds a character a shell would change.
 */
export function newAgentCommand(runtime: NewAgentRuntime, path: string): string | null {
  if (!path || !SHELL_SAFE_PATH.test(path)) return null;
  const launch = runtime === "claude" ? CLAUDE_LAUNCH_COMMAND : CODEX_LAUNCH_COMMAND;
  return `${launch} "Read the review notes in ${path} and address each one."`;
}

/** The menu row a send goes to unless the user picks another: an agent pane, then the open chat, then a new Cora chat. */
export function defaultReviewDestination(destinations: readonly ReviewDestination[], routingDefault: string): string | null {
  const enabled = destinations.filter((destination) => !destination.disabled);
  const preferred = enabled.find(
    (destination) =>
      destination.id === routingDefault && destination.kind !== "inbox" && !(destination.kind === "pane" && !destination.submit),
  );
  if (preferred) return preferred.id;
  return (
    enabled.find((destination) => destination.kind === "pane" && destination.submit) ??
    enabled.find((destination) => destination.kind === "chat") ??
    enabled.find((destination) => destination.kind === "chat-new") ??
    enabled[0]
  )?.id ?? null;
}
