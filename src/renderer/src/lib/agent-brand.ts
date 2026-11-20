// First-party agent brand colors and labels.
//
// These tokens never follow the workspace `--accent`. Claude stays orange,
// Codex stays teal, Grok stays lime, in every picker, chip, and tab.

import { AGENT_FAMILIES, isAgentRuntimeKind, type AgentFamilyId } from "@shared/agent-families";

export type AgentBrandRuntime = AgentFamilyId;

// Pi and Antigravity are the user's own CLIs, not account families, but they
// get a fixed brand color the same way.
export type AgentTerminalBrand = AgentBrandRuntime | "pi" | "antigravity";

export function agentBrandColor(runtime: AgentTerminalBrand): string {
  return `var(--agent-${runtime})`;
}

export function agentBrandTone(runtime: AgentTerminalBrand | "shell"): {
  color: string;
  background: string;
  border: string;
} {
  if (runtime === "shell") {
    return {
      color: "var(--ink-dim)",
      background: "color-mix(in oklab, var(--ink) 7%, transparent)",
      border: "color-mix(in oklab, var(--rule-soft) 90%, transparent)",
    };
  }
  const color = agentBrandColor(runtime);
  return {
    color,
    background: `color-mix(in oklch, ${color} 16%, transparent)`,
    border: `color-mix(in oklch, ${color} 34%, transparent)`,
  };
}

export function agentBrandLabel(runtime: AgentBrandRuntime): string {
  return AGENT_FAMILIES[runtime].displayName;
}

export function agentBrandRuntime(value: string | null | undefined): AgentBrandRuntime | null {
  return isAgentRuntimeKind(value) ? value : null;
}
