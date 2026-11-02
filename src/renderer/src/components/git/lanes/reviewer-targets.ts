// Who can review a lane's work: a new Claude Code or Codex session, a new Cora
// chat, or an agent already running. Pure, so scripts/test-agent-review.cjs pins
// the default: what the user picked last, unless that is a new agent of the
// family that wrote the work, because a second opinion comes from the other one.

import { agentFamilyOf, type AgentFamily } from "@shared/agent-review";
import type { RoutingDestination } from "../../../routing/SelectionRoutingContext";

export interface ReviewerTarget {
  /** "agent-new:<runtime>", "chat-new", "pane:<id>" or "chat:<runId>". */
  id: string;
  kind: "agent-new" | "chat-new" | "pane" | "chat";
  label: string;
  sublabel?: string;
  /** How the findings name it. */
  name: string;
  runtime?: AgentFamily;
  group: "new" | "running";
  disabled?: boolean;
  disabledReason?: string;
}

const RUNTIME_NAMES: Record<AgentFamily, string> = { claude: "Claude Code", codex: "Codex" };

export function reviewerTargets(routing: readonly RoutingDestination[]): ReviewerTarget[] {
  const out: ReviewerTarget[] = (["codex", "claude"] as const).map((runtime) => ({
    id: `agent-new:${runtime}`,
    kind: "agent-new",
    label: `New ${RUNTIME_NAMES[runtime]} reviewer`,
    sublabel: "spends usage",
    name: RUNTIME_NAMES[runtime],
    runtime,
    group: "new",
  }));
  for (const destination of routing) {
    if (destination.kind === "chat-new") {
      out.push({
        id: destination.id,
        kind: "chat-new",
        label: "New Cora chat",
        sublabel: "spends usage",
        name: "Cora",
        group: "new",
        ...(destination.disabled ? { disabled: true, disabledReason: destination.disabledReason } : {}),
      });
    } else if (destination.kind === "chat") {
      out.push({
        id: destination.id,
        kind: "chat",
        label: destination.label,
        name: "Cora",
        group: "running",
        ...(destination.disabled ? { disabled: true, disabledReason: destination.disabledReason } : {}),
      });
    } else if (destination.kind === "pane" && (destination as RoutingDestination & { agent?: boolean }).agent === true) {
      out.push({
        id: destination.id,
        kind: "pane",
        label: destination.label,
        ...(destination.sublabel ? { sublabel: destination.sublabel } : {}),
        name: destination.label.split("·")[0].trim() || "Agent",
        group: "running",
        ...(destination.disabled ? { disabled: true, disabledReason: destination.disabledReason } : {}),
      });
    }
  }
  return out;
}

export function defaultReviewer(
  targets: readonly ReviewerTarget[],
  writer: string | null | undefined,
  remembered: string | null,
): string | null {
  const family = agentFamilyOf(writer);
  const usable = targets.filter((target) => !target.disabled);
  const kept = usable.find((target) => target.id === remembered);
  if (kept && !(kept.kind === "agent-new" && kept.runtime === family)) return kept.id;
  const other: AgentFamily = family === "codex" ? "claude" : "codex";
  return (usable.find((target) => target.id === `agent-new:${other}`) ?? usable[0])?.id ?? null;
}

export const REVIEWER_STORAGE_KEY = "codara.sourceControl.lastReviewer";
