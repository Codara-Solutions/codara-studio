// Plan-mode Best-of-N council — the synthesis judge.
//
// run-store spawns N candidate planner agents (a mix of Claude Code + Codex) that
// each write a PLAN.md + PRD.md. This module is the judge: given every candidate's
// drafts, it asks a top-tier model (via the in-product OpenRouter config) to
// SYNTHESIZE the single best merged PLAN.md + PRD.md — taking the strongest ideas
// from across all candidates, not just picking one. If OpenRouter isn't configured
// (or the call fails) it degrades gracefully to the most complete single candidate.

import type { AppSettings, WorkerRuntime } from "@shared/types";
import { readOpenRouterConfig } from "./openrouter-manager";

export interface CouncilCandidateDoc {
  index: number;
  runtime?: WorkerRuntime;
  plan: string;
  prd: string;
}

export interface SynthesizedPlan {
  plan: string;
  prd: string;
  rationale: string;
  // 'synthesis' = an LLM merged the candidates; 'fallback' = no OpenRouter / call
  // failed, so the most complete single candidate was selected verbatim.
  via: "synthesis" | "fallback";
}

// Preferred judge model when the user's configured OpenRouter model is unset.
const TOP_TIER_JUDGE_MODEL = "anthropic/claude-opus-4-8";
const SYNTHESIS_TIMEOUT_MS = 180_000;
const PER_DOC_CHAR_CAP = 14_000;

const SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    plan: {
      type: "string",
      description: "The merged, best-of-all implementation PLAN.md as full markdown.",
    },
    prd: {
      type: "string",
      description: "The merged, best-of-all PRD.md as full markdown.",
    },
    rationale: {
      type: "string",
      description: "1-3 sentences on what was taken from which candidate and why.",
    },
  },
  required: ["plan", "prd", "rationale"],
} as const;

export async function synthesizeCouncilPlan(input: {
  task: string;
  candidates: CouncilCandidateDoc[];
  settings?: AppSettings;
}): Promise<SynthesizedPlan> {
  const usable = input.candidates.filter(
    (candidate) => candidate.plan.trim().length > 0 || candidate.prd.trim().length > 0,
  );
  if (usable.length === 0) {
    return {
      plan: "",
      prd: "",
      rationale: "No candidate produced any plan content.",
      via: "fallback",
    };
  }

  const config = readOpenRouterConfig(input.settings);
  // Graceful fallback when OpenRouter isn't configured: pick the most complete
  // candidate rather than failing the whole run.
  if (!config) {
    const best = pickMostComplete(usable);
    return {
      plan: best.plan,
      prd: best.prd,
      rationale: `OpenRouter not configured — selected candidate #${best.index} (most complete) without LLM synthesis.`,
      via: "fallback",
    };
  }

  const judgeModel = config.model && config.model.length > 0 ? config.model : TOP_TIER_JUDGE_MODEL;
  const system =
    "You are a principal engineer acting as the judge of a Best-of-N planning council. " +
    "Several independent agents each drafted an implementation PLAN and a PRD for the SAME task. " +
    "Synthesize the SINGLE BEST merged PLAN.md and PRD.md by taking the strongest, most correct, and " +
    "most complete ideas from across ALL candidates — resolve contradictions in favor of the most " +
    "rigorous option, drop weak or duplicated material, and keep everything concrete and actionable. " +
    "Return strict JSON matching the schema; `plan` and `prd` are each a full GitHub-flavored markdown document.";

  const candidateBlocks = usable
    .map(
      (candidate) =>
        `### Candidate #${candidate.index}${candidate.runtime ? ` (${candidate.runtime})` : ""}\n\n` +
        `--- PLAN.md ---\n${truncate(candidate.plan, PER_DOC_CHAR_CAP)}\n\n` +
        `--- PRD.md ---\n${truncate(candidate.prd, PER_DOC_CHAR_CAP)}`,
    )
    .join("\n\n========================================\n\n");

  const user =
    `# Planning task\n\n${input.task || "(no task text was recorded)"}\n\n` +
    `# Candidate drafts (${usable.length})\n\n${candidateBlocks}\n\n` +
    "Now produce the merged best-of-all PLAN.md and PRD.md.";

  try {
    const parsed = await callOpenRouterJson(config, judgeModel, system, user);
    return {
      plan: typeof parsed.plan === "string" ? parsed.plan : "",
      prd: typeof parsed.prd === "string" ? parsed.prd : "",
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
      via: "synthesis",
    };
  } catch (err) {
    const best = pickMostComplete(usable);
    return {
      plan: best.plan,
      prd: best.prd,
      rationale: `Synthesis call failed (${err instanceof Error ? err.message : String(err)}); fell back to candidate #${best.index}.`,
      via: "fallback",
    };
  }
}

function pickMostComplete(candidates: CouncilCandidateDoc[]): CouncilCandidateDoc {
  return candidates.reduce((best, candidate) =>
    candidate.plan.length + candidate.prd.length > best.plan.length + best.prd.length ? candidate : best,
  );
}

function truncate(text: string, max: number): string {
  const value = text ?? "";
  return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated]`;
}

async function callOpenRouterJson(
  config: { apiKey: string; baseUrl: string },
  model: string,
  system: string,
  user: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNTHESIS_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "HTTP-Referer": "https://spark-agent.local",
        "X-Title": "Spark Agent",
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: {
          type: "json_schema",
          json_schema: { name: "plan_synthesis", strict: true, schema: SYNTHESIS_SCHEMA },
        },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseJsonObject(json.choices?.[0]?.message?.content ?? "");
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  return JSON.parse(trimmed) as Record<string, unknown>;
}
