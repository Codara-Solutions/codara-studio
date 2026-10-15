import type { GitFixAgentRuntime, GitFixAgentsAvailable } from "@shared/git-fix";
import { GIT_FIX_AGENT_RUNTIMES } from "@shared/git-fix";
import type { RoutingDestination } from "../../../routing/SelectionRoutingContext";

// Where "Fix with agent" can send a problem: an agent already running in a
// terminal of this workspace, the open Cora chat, a new Cora chat, a new agent
// CLI in a new terminal, or the workspace inbox. Built from the same
// destination list browser sends use (agent-destinations.ts), with plain
// shells left out: a fix prompt pasted into a shell would run as commands.
// Pure, so scripts/test-git-fix-targets.cjs covers it without React.

export type FixTargetKind = "pane" | "chat" | "chat-new" | "agent-new" | "inbox";

export interface FixTarget {
  /** "pane:<id>", "chat:<runId>", "chat-new", "agent-new:<runtime>" or "inbox". */
  id: string;
  kind: FixTargetKind;
  label: string;
  sublabel?: string;
  group: "agents" | "chat" | "new" | "inbox";
  paneId?: string;
  runId?: string;
  runtime?: GitFixAgentRuntime;
  disabled?: boolean;
}

export const FIX_TARGET_GROUP_TITLES: Record<FixTarget["group"], string> = {
  agents: "Agents in this workspace",
  chat: "Cora",
  new: "Start a new agent",
  inbox: "Inbox",
};

const RUNTIME_NAMES: Record<GitFixAgentRuntime, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
};

export function fixAgentName(runtime: GitFixAgentRuntime): string {
  return RUNTIME_NAMES[runtime];
}

/** Where the last fix went, by kind, so the next one starts there. */
export type RememberedFixTarget = "pane" | "chat" | "chat-new" | "inbox" | `agent-new:${GitFixAgentRuntime}`;

export const FIX_TARGET_STORAGE_KEY = "codara.gitFix.lastTarget";

export function rememberedFixTarget(target: FixTarget): RememberedFixTarget {
  if (target.kind === "agent-new" && target.runtime) return `agent-new:${target.runtime}`;
  if (target.kind === "agent-new") return "chat-new";
  return target.kind;
}

export function parseRememberedFixTarget(raw: unknown): RememberedFixTarget | null {
  if (raw === "pane" || raw === "chat" || raw === "chat-new" || raw === "inbox") return raw;
  if (typeof raw === "string" && raw.startsWith("agent-new:")) {
    const runtime = raw.slice("agent-new:".length) as GitFixAgentRuntime;
    if (GIT_FIX_AGENT_RUNTIMES.includes(runtime)) return `agent-new:${runtime}`;
  }
  return null;
}

/**
 * The fix targets for a workspace. Destinations come from the routing API
 * (destinationsFor); agents says which CLIs can start, or null while that is
 * still being checked.
 */
export function fixTargets(
  destinations: readonly RoutingDestination[],
  agents: GitFixAgentsAvailable | null,
): FixTarget[] {
  const out: FixTarget[] = [];
  for (const destination of destinations) {
    if (destination.kind === "pane") {
      // Only panes with an agent: a plain shell would run the prompt's lines.
      if (!(destination as RoutingDestination & { agent?: boolean }).agent || !destination.paneId) continue;
      out.push({
        id: destination.id,
        kind: "pane",
        label: destination.label,
        ...(destination.sublabel ? { sublabel: destination.sublabel } : {}),
        group: "agents",
        paneId: destination.paneId,
      });
    } else if (destination.kind === "chat" && destination.runId) {
      out.push({
        id: destination.id,
        kind: "chat",
        label: destination.label,
        ...(destination.sublabel ? { sublabel: destination.sublabel } : {}),
        group: "chat",
        runId: destination.runId,
      });
    } else if (destination.kind === "chat-new") {
      out.push({
        id: "chat-new",
        kind: "chat-new",
        label: "New Cora chat",
        group: "chat",
        ...(destination.disabled ? { disabled: true } : {}),
      });
    }
  }
  for (const runtime of GIT_FIX_AGENT_RUNTIMES) {
    if (!agents?.[runtime]) continue;
    out.push({
      id: `agent-new:${runtime}`,
      kind: "agent-new",
      label: `New ${fixAgentName(runtime)}`,
      sublabel: "opens in a new terminal tab",
      group: "new",
      runtime,
    });
  }
  out.push({ id: "inbox", kind: "inbox", label: "Agent inbox", sublabel: "any agent in this workspace pulls it", group: "inbox" });
  return out;
}

/**
 * The target picked when the dialog opens: the kind used last time when it
 * is still there, then the agent pane browser sends default to, then any
 * agent pane, the open Cora chat, a new Claude Code (or other CLI), a new
 * Cora chat, and last the inbox.
 */
export function defaultFixTarget(
  targets: readonly FixTarget[],
  remembered: RememberedFixTarget | null,
  routingDefaultId: string | null,
): string {
  const usable = targets.filter((target) => !target.disabled);
  const has = (id: string | null | undefined) => Boolean(id && usable.some((target) => target.id === id));
  const firstOf = (kind: FixTargetKind) => usable.find((target) => target.kind === kind)?.id ?? null;
  const pane = has(routingDefaultId) && routingDefaultId?.startsWith("pane:") ? routingDefaultId : firstOf("pane");
  if (remembered) {
    if (remembered === "pane" && pane) return pane;
    if (remembered === "chat") {
      const chat = has(routingDefaultId) && routingDefaultId?.startsWith("chat:") ? routingDefaultId : firstOf("chat");
      if (chat) return chat;
    }
    if ((remembered === "chat-new" || remembered === "inbox" || remembered.startsWith("agent-new:")) && has(remembered)) {
      return remembered;
    }
  }
  if (pane) return pane;
  const chat = firstOf("chat");
  if (chat) return chat;
  const newAgent = firstOf("agent-new");
  if (newAgent) return newAgent;
  if (has("chat-new")) return "chat-new";
  return "inbox";
}

/** The text an agent receives: the user's own note first, when there is one. */
export function fixPromptWithNote(prompt: string, note: string): string {
  const trimmed = note.trim();
  if (!trimmed) return prompt;
  return `Note from me before you start: ${trimmed}\n\n${prompt}`;
}
