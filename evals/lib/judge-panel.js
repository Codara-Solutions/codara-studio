// JudgePanel — runs N OpenRouter judges over a (possibly blinded) diff and
// returns aggregated dimension scores.
//
// Constraints (from the eval design doc):
//   * Blinded: the diff handed to judges is sanitized to remove obvious
//     adapter labels ("spark", "claude", "codex") so the judge can't infer
//     which agent produced it.
//   * Position-randomized when comparing two diffs: each judge sees A/B in a
//     randomized order, indpendent across judges. (Single-diff scoring
//     trivially skips this.)
//   * Independent calls: judges do not see each other's verdicts.
//   * Structured output: each judge returns JSON. Parse failures retried once.
//   * Rubric-driven: the rubric is the prompt scaffold. Dimensions, weights,
//     and anchors all come from `evals/rubrics/professional-grade-code.json`.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { chatCompletion, parseJsonResponse } = require("./openrouter");

/**
 * @typedef {Object} JudgeConfig
 * @property {string} model        OpenRouter model id, e.g. "anthropic/claude-opus-4-7"
 * @property {string} family       Display family for telemetry, e.g. "anthropic"
 */

/**
 * @typedef {Object} JudgeVerdict
 * @property {string} judgeId
 * @property {string} model
 * @property {string} family
 * @property {Object<string, number>} scores         // per-dimension 0-5
 * @property {Object<string, string>} justifications  // per-dimension explanation
 * @property {Array<{dimension: string, severity: string, message: string}>} issues
 * @property {number} overallScore                    // weighted total
 * @property {string} verdict                         // "pass" | "borderline" | "fail"
 * @property {string} [parseError]
 * @property {Object} rawResponse
 */

/**
 * @typedef {Object} JudgePanelResult
 * @property {Array<JudgeVerdict>} verdicts
 * @property {Object<string, { mean: number, min: number, max: number, scores: number[] }>} aggregated
 * @property {number} weightedTotal
 * @property {string[]} flaggedDisagreements
 * @property {Array<{dimension: string, severity: string, message: string, judgeId: string}>} mergedIssues
 */

/**
 * Strip variant labels from a diff so judges cannot infer the producing
 * adapter. We replace common identifiers and keep the diff structurally
 * intact (line numbers, hunks).
 *
 * The list of substitutions is deliberately minimal — over-aggressive
 * scrubbing destroys the diff's semantic content and degrades judge quality.
 * We mostly target the obvious "this came from Spark / Claude" leaks: the
 * adapter id, the runner label, and run-id prefixes.
 */
function blindDiff(diff, blindList) {
  if (!diff) return diff;
  let out = diff;
  for (const term of blindList) {
    if (!term) continue;
    // Word-boundary replace so we don't mangle file paths that legitimately
    // contain the term.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    out = out.replace(re, "VARIANT");
  }
  return out;
}

function loadRubric(rubricPath) {
  const raw = fs.readFileSync(rubricPath, "utf8");
  const rubric = JSON.parse(raw);
  if (!Array.isArray(rubric.dimensions) || rubric.dimensions.length === 0) {
    throw new Error(`Rubric at ${rubricPath} has no dimensions.`);
  }
  return rubric;
}

function buildJudgeSystemPrompt(rubric) {
  const lines = [];
  lines.push(
    "You are an experienced staff software engineer reviewing a single proposed code change for its professional quality.",
    "You will score the diff on each dimension of the rubric below using whole or half-integer numbers in the range 0 to 5.",
    "You are blinded — you do not know which AI agent produced this diff. Score on the merits of the code itself.",
    "",
    "RUBRIC",
    `Id: ${rubric.id} (version ${rubric.version})`,
    "",
  );
  for (const dim of rubric.dimensions) {
    lines.push(`# ${dim.label} (id=${dim.id}, weight=${dim.weight})`);
    lines.push(dim.description);
    lines.push("Anchors:");
    for (const [score, anchor] of Object.entries(dim.anchors)) {
      lines.push(`  ${score}: ${anchor}`);
    }
    lines.push("");
  }
  lines.push(
    "OUTPUT REQUIREMENTS",
    "Respond with a single JSON object — no prose, no markdown fences. Schema:",
    "",
    "{",
    "  \"scores\": { <dimensionId>: <number 0..5>, ... },",
    "  \"justifications\": { <dimensionId>: <string, 1-2 sentences citing concrete evidence from the diff>, ... },",
    "  \"issues\": [ { \"dimension\": <id>, \"severity\": \"low|medium|high\", \"message\": <string> }, ... ],",
    "  \"verdict\": \"pass\" | \"borderline\" | \"fail\"",
    "}",
    "",
    "All dimension ids in `scores` and `justifications` must match the rubric exactly.",
    "Be specific in justifications — quote line snippets or file names.",
    "If the diff is empty or trivially does not address the task, score most dimensions 0 and explain in justifications.",
  );
  return lines.join("\n");
}

function buildJudgeUserPrompt({ rubric, plan, blindedDiff, hiddenGateSummary, publicGateSummary }) {
  const lines = [
    "TASK SPECIFICATION (the user's plan):",
    "----- BEGIN PLAN -----",
    plan.trim(),
    "----- END PLAN -----",
    "",
  ];
  if (publicGateSummary) {
    lines.push("PUBLIC GATES (visible to the agent):", publicGateSummary, "");
  }
  if (hiddenGateSummary) {
    // We tell the judge the *result* of the hidden gates (without leaking
    // their content) so it can factor robustness into the score, but the
    // hidden gate inputs themselves stayed inside the harness.
    lines.push("HIDDEN GATE RESULTS (kept secret from the agent):", hiddenGateSummary, "");
  }
  lines.push(
    "DIFF UNDER REVIEW (variant labels replaced with VARIANT to keep judging blinded):",
    "----- BEGIN DIFF -----",
    blindedDiff || "(empty diff — the agent produced no changes)",
    "----- END DIFF -----",
    "",
    `Score against the rubric (id=${rubric.id}). Return only the JSON object.`,
  );
  return lines.join("\n");
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, n));
}

function normalizeVerdict(rubric, parsed) {
  const scores = {};
  const justifications = {};
  for (const dim of rubric.dimensions) {
    scores[dim.id] = clampScore(parsed.scores ? parsed.scores[dim.id] : 0);
    const j = parsed.justifications ? parsed.justifications[dim.id] : "";
    justifications[dim.id] = typeof j === "string" ? j : "";
  }
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues
        .filter((iss) => iss && typeof iss === "object")
        .map((iss) => ({
          dimension: typeof iss.dimension === "string" ? iss.dimension : "general",
          severity: ["low", "medium", "high"].includes(iss.severity) ? iss.severity : "medium",
          message: typeof iss.message === "string" ? iss.message : "",
        }))
    : [];
  const verdict = ["pass", "borderline", "fail"].includes(parsed.verdict) ? parsed.verdict : "borderline";
  let overallScore = 0;
  for (const dim of rubric.dimensions) {
    overallScore += scores[dim.id] * dim.weight;
  }
  return { scores, justifications, issues, verdict, overallScore };
}

async function callJudge({
  cfg,
  judge,
  systemPrompt,
  userPrompt,
  attempt,
  timeoutMs,
}) {
  const requestBody = {
    model: judge.model,
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
  return chatCompletion(cfg, requestBody, { timeoutMs });
}

/**
 * Run the panel against a single diff.
 *
 * @param {Object} args
 * @param {string} args.rubricPath
 * @param {Array<JudgeConfig>} args.judges
 * @param {string} args.diff
 * @param {string} args.plan
 * @param {string[]} [args.blindList]   Strings to scrub from the diff (case-insensitive)
 * @param {string} [args.hiddenGateSummary]
 * @param {string} [args.publicGateSummary]
 * @param {number} [args.timeoutMs]     Per-judge timeout
 * @param {(event: object) => void} [args.onEvent]
 * @returns {Promise<JudgePanelResult>}
 */
async function evaluate(args) {
  const {
    rubricPath,
    judges,
    diff,
    plan,
    blindList = [],
    hiddenGateSummary,
    publicGateSummary,
    timeoutMs = 180_000,
    onEvent = () => undefined,
  } = args;
  const rubric = loadRubric(rubricPath);
  const blindedDiff = blindDiff(diff, blindList);

  const cfg = require("./openrouter").resolveOpenRouterConfig();
  if (!cfg) {
    throw new Error(
      "Cannot run JudgePanel: no OpenRouter API key configured. Set SPARK_OPENROUTER_API_KEY, OPENROUTER_API_KEY, or configure it in Spark settings.",
    );
  }

  const systemPrompt = buildJudgeSystemPrompt(rubric);
  const userPrompt = buildJudgeUserPrompt({
    rubric,
    plan,
    blindedDiff,
    hiddenGateSummary,
    publicGateSummary,
  });

  /** @type {JudgeVerdict[]} */
  const verdicts = [];

  // We run judges sequentially rather than in parallel: parallel execution
  // is cheaper but a flaky judge can drag others into retry storms, and the
  // panel is small (3 judges) so total time is fine.
  for (const judge of judges) {
    const judgeId = judge.model;
    onEvent({ kind: "judge:start", judgeId });
    let parsed = null;
    let raw = null;
    let parseError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        raw = await callJudge({
          cfg,
          judge,
          systemPrompt,
          userPrompt,
          attempt,
          timeoutMs,
        });
        parsed = parseJsonResponse(raw);
        parseError = null;
        break;
      } catch (err) {
        parseError = err && err.message ? err.message : String(err);
        if (attempt === 2) break;
        onEvent({ kind: "judge:retry", judgeId, error: parseError });
      }
    }

    if (!parsed) {
      // Record a zero-score verdict so the panel still aggregates, but flag
      // the parse failure so the harness operator sees it.
      const empty = normalizeVerdict(rubric, {});
      verdicts.push({
        judgeId,
        model: judge.model,
        family: judge.family,
        scores: empty.scores,
        justifications: empty.justifications,
        issues: empty.issues,
        verdict: "fail",
        overallScore: empty.overallScore,
        parseError: parseError || "unknown parse failure",
        rawResponse: raw,
      });
      onEvent({ kind: "judge:parse_failed", judgeId, error: parseError });
      continue;
    }

    const normalized = normalizeVerdict(rubric, parsed);
    verdicts.push({
      judgeId,
      model: judge.model,
      family: judge.family,
      scores: normalized.scores,
      justifications: normalized.justifications,
      issues: normalized.issues,
      verdict: normalized.verdict,
      overallScore: normalized.overallScore,
      rawResponse: raw,
    });
    onEvent({
      kind: "judge:complete",
      judgeId,
      overallScore: normalized.overallScore,
      verdict: normalized.verdict,
    });
  }

  // Aggregate across judges.
  const aggregated = {};
  for (const dim of rubric.dimensions) {
    const scores = verdicts.map((v) => v.scores[dim.id]);
    const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
    aggregated[dim.id] = {
      mean,
      min: Math.min(...scores),
      max: Math.max(...scores),
      scores,
    };
  }
  let weightedTotal = 0;
  for (const dim of rubric.dimensions) {
    weightedTotal += aggregated[dim.id].mean * dim.weight;
  }
  const flaggedDisagreements = [];
  for (const dim of rubric.dimensions) {
    const spread = aggregated[dim.id].max - aggregated[dim.id].min;
    if (spread > 2) flaggedDisagreements.push(dim.id);
  }
  const mergedIssues = [];
  for (const v of verdicts) {
    for (const iss of v.issues) {
      mergedIssues.push({ ...iss, judgeId: v.judgeId });
    }
  }

  return {
    verdicts,
    aggregated,
    weightedTotal,
    flaggedDisagreements,
    mergedIssues,
  };
}

/**
 * Resolve the default judge config (3 judges across families). The actual
 * model ids come from the suite manifest, but we encode sensible defaults
 * here so the harness still has fallbacks.
 */
function defaultJudges() {
  return [
    { model: "anthropic/claude-opus-4-7", family: "anthropic" },
    { model: "openai/gpt-5.5", family: "openai" },
    { model: "google/gemini-2.5-pro", family: "google" },
  ];
}

module.exports = {
  blindDiff,
  loadRubric,
  evaluate,
  defaultJudges,
};
