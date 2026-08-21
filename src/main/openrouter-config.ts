import { createHash } from "node:crypto";

import type {
  AppSettings,
  OpenRouterValidationInput,
  OpenRouterValidationResult,
} from "@shared/types";
import {
  DEFAULT_CORA_WORKER_MODELS,
  isOpenRouterModelId,
} from "@shared/worker-model-roster";

const OPENROUTER_API_ROOT = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;

interface OpenRouterErrorBody {
  error?: { message?: string };
}

interface OpenRouterModelBody extends OpenRouterErrorBody {
  data?: {
    id?: string;
    name?: string;
    supported_parameters?: string[];
  };
}

function normalizedCoraModelIds(modelIds: readonly string[]): string[] {
  return [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))].sort();
}

export function openRouterConfigurationHash(
  apiKey: string,
  modelIds: readonly string[],
): string {
  return createHash("sha256")
    .update(apiKey.trim(), "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(normalizedCoraModelIds(modelIds)), "utf8")
    .digest("hex");
}

export function hasVerifiedOpenRouterKey(settings: AppSettings): boolean {
  const apiKey = typeof settings.openRouterApiKey === "string"
    ? settings.openRouterApiKey.trim()
    : "";
  const modelIds = Array.isArray(settings.openRouterCoraModels)
    ? settings.openRouterCoraModels
    : [];
  return Boolean(
    apiKey &&
    typeof settings.openRouterVerifiedKeyHash === "string" &&
    settings.openRouterVerifiedKeyHash &&
    openRouterConfigurationHash(apiKey, modelIds) === settings.openRouterVerifiedKeyHash,
  );
}

export function configuredOpenRouterCoraModels(settings: AppSettings): string[] {
  if (!hasVerifiedOpenRouterKey(settings)) return [];
  const models = Array.isArray(settings.openRouterCoraModels)
    ? settings.openRouterCoraModels
    : [];
  return [...new Set(models.map((id) => id.trim()).filter(Boolean))];
}

/** Worker models usable right now. Native subscription ids are independent of
 * the OpenRouter key; OpenRouter ids require both a verified key and a model
 * that is present in the dedicated Cora favorites list. */
export function availableCoraWorkerModels(settings: AppSettings): string[] {
  const openRouterModels = new Set(configuredOpenRouterCoraModels(settings));
  const configured = Array.isArray(settings.coraWorkerModels)
    ? settings.coraWorkerModels
    : DEFAULT_CORA_WORKER_MODELS;
  return [...new Set(configured.map((id) => id.trim()).filter(Boolean))]
    .filter((id) => !isOpenRouterModelId(id) || openRouterModels.has(id));
}

function authorizationHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://codara.ai",
    "X-Title": "Codara",
  };
}

async function errorFrom(response: Response): Promise<string> {
  let detail = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as OpenRouterErrorBody;
    if (body.error?.message) detail = `${response.status} ${body.error.message}`;
  } catch {
    // Preserve the status line for non-JSON failures.
  }
  return detail;
}

async function fetchWithTimeout(url: string, apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: authorizationHeaders(apiKey),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function modelLookupUrl(modelId: string): string {
  const encoded = modelId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${OPENROUTER_API_ROOT}/model/${encoded}`;
}

export async function validateOpenRouterConfiguration(
  input: OpenRouterValidationInput,
): Promise<OpenRouterValidationResult> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) return { ok: false, error: "Enter an OpenRouter API key first." };
  const modelIds = normalizedCoraModelIds(input.coraModelIds);
  try {
    const keyResponse = await fetchWithTimeout(`${OPENROUTER_API_ROOT}/key`, apiKey);
    if (!keyResponse.ok) {
      return { ok: false, error: `OpenRouter rejected this key: ${await errorFrom(keyResponse)}` };
    }

    const models = await Promise.all(
      modelIds.map(async (requestedId) => {
        const response = await fetchWithTimeout(modelLookupUrl(requestedId), apiKey);
        if (!response.ok) {
          throw new Error(`${requestedId}: ${await errorFrom(response)}`);
        }
        const body = (await response.json()) as OpenRouterModelBody;
        const supported = Array.isArray(body.data?.supported_parameters)
          ? body.data.supported_parameters
          : [];
        if (!supported.includes("tools")) {
          throw new Error(`${requestedId}: this model does not advertise tool calling, which Cora requires.`);
        }
        return {
          id: requestedId,
          label: body.data?.name?.trim() || requestedId,
        };
      }),
    );
    return {
      ok: true,
      keyHash: openRouterConfigurationHash(apiKey, modelIds),
      models,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: /abort/i.test(message)
        ? "OpenRouter did not respond before the connection check timed out."
        : message,
    };
  }
}
