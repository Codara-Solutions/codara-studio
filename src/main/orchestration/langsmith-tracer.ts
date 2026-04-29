import { randomUUID } from "node:crypto";
import type { AppSettings, SparkCall } from "@shared/types";
import type { OpenRouterManagerRequest } from "./openrouter-manager";

interface LangSmithConfig {
  apiKey: string;
  endpoint: string;
  project: string;
  workspaceId?: string;
}

export interface LangSmithTrace {
  id: string;
  startedAt: string;
}

const DEFAULT_LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
const DEFAULT_LANGSMITH_PROJECT = "spark-agent-dev";
const LANGSMITH_TIMEOUT_MS = 4000;

export function readLangSmithConfig(settings?: AppSettings): LangSmithConfig | null {
  if (isExplicitlyDisabled()) return null;

  const apiKey = (
    settings?.langSmithApiKey ||
    process.env.LANGSMITH_API_KEY ||
    process.env.LANGCHAIN_API_KEY ||
    ""
  ).trim();
  if (!apiKey) return null;

  return {
    apiKey,
    endpoint: pickConfiguredValue(
      settings?.langSmithEndpoint,
      DEFAULT_LANGSMITH_ENDPOINT,
      process.env.LANGSMITH_ENDPOINT,
      process.env.LANGCHAIN_ENDPOINT,
    )
      .trim()
      .replace(/\/+$/, ""),
    project: pickConfiguredValue(
      settings?.langSmithProject,
      DEFAULT_LANGSMITH_PROJECT,
      process.env.LANGSMITH_PROJECT,
      process.env.LANGCHAIN_PROJECT,
    ).trim(),
    workspaceId: (process.env.LANGSMITH_WORKSPACE_ID || process.env.LANGCHAIN_WORKSPACE_ID || "").trim() || undefined,
  };
}

export async function startLangSmithManagerTrace(input: {
  config: LangSmithConfig | null;
  runId: string;
  workspaceId: string;
  sparkCallId: string;
  mode: SparkCall["mode"];
  requestBody: OpenRouterManagerRequest;
}): Promise<LangSmithTrace | null> {
  if (!input.config) return null;

  const trace: LangSmithTrace = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
  };

  await sendLangSmithRequest(input.config, "POST", "/runs", {
    id: trace.id,
    name: `Spark manager ${input.mode}`,
    run_type: "llm",
    start_time: trace.startedAt,
    session_name: input.config.project,
    inputs: {
      provider: "openrouter",
      mode: input.mode,
      model: input.requestBody.model,
      messages: input.requestBody.messages,
      response_format: input.requestBody.response_format,
      temperature: input.requestBody.temperature,
    },
    extra: {
      metadata: {
        app: "spark-agent",
        runId: input.runId,
        workspaceId: input.workspaceId,
        sparkCallId: input.sparkCallId,
        provider: "openrouter",
      },
    },
  });

  return trace;
}

export async function finishLangSmithManagerTrace(input: {
  config: LangSmithConfig | null;
  trace: LangSmithTrace | null;
  output?: unknown;
  error?: string;
}): Promise<void> {
  if (!input.config || !input.trace) return;

  await sendLangSmithRequest(input.config, "PATCH", `/runs/${input.trace.id}`, {
    end_time: new Date().toISOString(),
    outputs: input.error ? undefined : input.output,
    error: input.error,
  });
}

async function sendLangSmithRequest(
  config: LangSmithConfig,
  method: "POST" | "PATCH",
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LANGSMITH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    };
    if (config.workspaceId) headers["x-tenant-id"] = config.workspaceId;

    const response = await fetch(`${config.endpoint}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(`LangSmith trace request failed with ${response.status}: ${message.slice(0, 240)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function isExplicitlyDisabled(): boolean {
  return process.env.LANGSMITH_TRACING === "false" || process.env.LANGCHAIN_TRACING_V2 === "false";
}

function pickConfiguredValue(
  settingsValue: string | undefined,
  defaultValue: string,
  primaryEnv: string | undefined,
  aliasEnv: string | undefined,
): string {
  const normalizedSettings = settingsValue?.trim();
  if (normalizedSettings && normalizedSettings !== defaultValue) return normalizedSettings;
  return primaryEnv?.trim() || aliasEnv?.trim() || normalizedSettings || defaultValue;
}
