// Tiny OpenRouter chat-completions client used by the judge panel.
//
// Mirrors the auth + base-URL conventions in src/main/orchestration/openrouter-manager.ts
// so this code can run from a standalone Node script (the eval harness) or
// later be folded back into the main process if useful.
//
// Resolution order for the API key (highest precedence first):
//   1. process.env.SPARK_OPENROUTER_API_KEY
//   2. process.env.OPENROUTER_API_KEY
//   3. ~/.SparkAgent/spark-settings.json -> openRouterApiKey
//   (we read the same file Spark writes so a user who configured the desktop
//    app once doesn't have to re-enter the key for the eval harness.)
//
// We never bake a key into source. If none of the above resolve, the harness
// fails with a clear error so the user knows what to set.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function sparkHomeDir() {
  const override = process.env.SPARK_HOME_DIR || process.env.SPARK_USER_DATA_DIR;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".SparkAgent");
}

function readSparkSettingsKey() {
  try {
    const raw = fs.readFileSync(
      path.join(sparkHomeDir(), "spark-settings.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    if (typeof parsed.openRouterApiKey === "string") {
      const k = parsed.openRouterApiKey.trim();
      if (k) return k;
    }
  } catch {
    /* missing file is fine */
  }
  return null;
}

function resolveOpenRouterConfig() {
  const apiKey = (
    process.env.SPARK_OPENROUTER_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    readSparkSettingsKey() ||
    ""
  ).trim();
  if (!apiKey) {
    return null;
  }
  return {
    apiKey,
    baseUrl: (process.env.SPARK_OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    ),
  };
}

/**
 * Send a chat completion request to OpenRouter. Returns the parsed response.
 * Throws on HTTP error or invalid JSON.
 *
 * @param {Object} cfg     { apiKey, baseUrl }
 * @param {Object} body    OpenRouter chat completion request body
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs] hard timeout per request
 * @param {AbortSignal} [opts.signal]
 */
async function chatCompletion(cfg, body, opts = {}) {
  if (!cfg || !cfg.apiKey) {
    throw new Error(
      "OpenRouter API key is missing. Set SPARK_OPENROUTER_API_KEY or OPENROUTER_API_KEY, or configure it in Spark settings.",
    );
  }
  if (typeof fetch !== "function") {
    throw new Error(
      "Global fetch() is unavailable. Use Node 18+ to run the eval harness.",
    );
  }
  const controller = new AbortController();
  const timer = opts.timeoutMs
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : null;
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let response;
  try {
    response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        // Same titles Spark sends so usage shows up under the same OpenRouter
        // app entry the user already configured.
        "HTTP-Referer": "https://spark-agent.local",
        "X-Title": "Spark Agent - Eval Harness",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = json && json.error && json.error.message
      ? json.error.message
      : `OpenRouter request failed with HTTP ${response.status}`;
    const err = new Error(msg);
    err.status = response.status;
    err.response = json;
    throw err;
  }
  return json;
}

/**
 * Convenience: extract the first message content as a string, including the
 * stripping of fenced code blocks that some models wrap their JSON in.
 */
function extractContent(response) {
  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Convenience: pull a JSON object out of a response that may be wrapped in
 * a ```json fence. Throws on parse failure.
 */
function parseJsonResponse(response) {
  const raw = extractContent(response).trim();
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(stripped);
}

module.exports = {
  resolveOpenRouterConfig,
  chatCompletion,
  extractContent,
  parseJsonResponse,
};
