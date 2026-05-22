// Main-process OpenRouter proxy for the inline-AI editor autocomplete.
// The renderer can't fetch openrouter.ai directly: in dev the renderer's
// origin is http://localhost:5173 and OpenRouter's CORS policy on
// /chat/completions doesn't whitelist arbitrary localhost origins, so the
// browser blocks the request with a generic "Failed to fetch."
// Running the call from main bypasses CORS entirely (Node's fetch has no
// origin), and it also keeps the API key from the renderer in cases where
// we want to rotate that source later.

import { loadSettings } from "./storage";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const MAX_PREFIX = 4000;
const MAX_SUFFIX = 2000;
const MAX_OUTPUT_TOKENS = 512;

const COMPLETION_SYSTEM_PROMPT = `You perform fill-in-the-middle code completion.

You receive PREFIX (code before the cursor) and SUFFIX (code after the cursor). Your output is inserted EXACTLY at the cursor position. PREFIX + your_output + SUFFIX must form valid, syntactically-correct code.

Output the next useful chunk of code you can predict with high confidence. Prefer enough text to save a meaningful edit, then stop when the next decision becomes genuinely ambiguous. A good chunk is usually:
- The remaining characters of a partially-typed identifier, property, keyword, or string word, OR
- The rest of the current expression or statement, OR
- A short predictable block, up to about 12 lines, when the surrounding code makes the block obvious.

When PREFIX ends inside a word or identifier, finish that word first. If SUFFIX starts with the rest of the same word or identifier, output only the missing bridge text or output empty string. Do not duplicate text that is already present after the cursor.

Hard rules:
1. NEVER repeat any text already present in PREFIX or SUFFIX.
2. NEVER write code that belongs after SUFFIX.
3. Match surrounding indentation, quoting, and naming conventions exactly.
4. Output empty string when no confident completion exists - never guess.
5. Output format: raw insertion text only. No markdown fences. No commentary. No "Here is".

Examples:

PREFIX: "#[te"
SUFFIX: "]"
OUTPUT: "st"

PREFIX: "fn binary_search"
SUFFIX: ""
OUTPUT: "<T: Ord>(arr: &[T], target: &T) -> Option<usize> {"

PREFIX: "for (let i = 0; i < arr.length; i"
SUFFIX: ") {\\n"
OUTPUT: "++"

PREFIX: "const sum = (a, b) => "
SUFFIX: ";"
OUTPUT: "a + b"

PREFIX: "const inlineAutocom"
SUFFIX: ""
OUTPUT: "pleteDelayMs"

PREFIX: "function fetchUser(id: string) {\\n  "
SUFFIX: "\\n}"
OUTPUT: "return fetch(\`/api/users/\${id}\`).then(r => r.json());"`;

export interface InlineAiCompletionRequest {
  prefix: string;
  suffix: string;
  filename: string | null;
  language: string | null;
  modelId: string;
  requestId: string;
}

export interface InlineAiCompletionResponse {
  text: string;
  error: string | null;
}

interface OpenRouterChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_details?: unknown;
    };
  }>;
  error?: { message?: string };
}

interface OpenRouterChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

type OpenRouterReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface InlineAiChatCompletionRequest {
  modelId: string;
  requestId: string;
  messages: OpenRouterChatMessage[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: OpenRouterReasoningEffort;
}

// Track in-flight requests so the renderer can abort them by id when the
// user keeps typing. AbortController is per-request; the map stays small
// because we drop entries on completion.
const inflight = new Map<string, AbortController>();

function trimContext(prefix: string, suffix: string): { prefix: string; suffix: string } {
  const p = prefix.length > MAX_PREFIX ? prefix.slice(prefix.length - MAX_PREFIX) : prefix;
  const s = suffix.length > MAX_SUFFIX ? suffix.slice(0, MAX_SUFFIX) : suffix;
  return { prefix: p, suffix: s };
}

function buildUserPrompt(req: InlineAiCompletionRequest): string {
  const { prefix, suffix } = trimContext(req.prefix, req.suffix);
  const meta: string[] = [];
  if (req.filename) meta.push(`File: ${req.filename}`);
  if (req.language) meta.push(`Language: ${req.language}`);
  const metaBlock = meta.length ? meta.join("\n") + "\n\n" : "";
  return `${metaBlock}PREFIX:
<<<
${prefix}
>>>

SUFFIX:
<<<
${suffix}
>>>

Output the text to insert at the cursor.`;
}

function extractContent(response: OpenRouterChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function supportsOpenRouterReasoningEffort(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return (
    id.startsWith("google/gemini-3") ||
    id.startsWith("google/gemini-2.5") ||
    id.startsWith("openai/gpt-oss") ||
    id.startsWith("openai/o") ||
    id.startsWith("openai/gpt-5") ||
    id.startsWith("x-ai/grok") ||
    id.startsWith("z-ai/glm")
  );
}

function requiresOpenRouterReasoning(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("openai/gpt-oss");
}

function reasoningForRequest(modelId: string, effort?: OpenRouterReasoningEffort) {
  if (!effort || !supportsOpenRouterReasoningEffort(modelId)) return undefined;
  const normalizedEffort =
    effort === "none" && requiresOpenRouterReasoning(modelId) ? "minimal" : effort;
  return { effort: normalizedEffort, exclude: true };
}

export async function runInlineAiCompletion(
  req: InlineAiCompletionRequest,
): Promise<InlineAiCompletionResponse> {
  return runInlineAiChatCompletion({
    modelId: req.modelId,
    requestId: req.requestId,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    reasoningEffort: "none",
    messages: [
      { role: "system", content: COMPLETION_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(req) },
    ],
  });
}

export async function runInlineAiChatCompletion(
  req: InlineAiChatCompletionRequest,
): Promise<InlineAiCompletionResponse> {
  const settings = await loadSettings();
  const apiKey = (settings.openRouterApiKey || "").trim();
  if (!apiKey) {
    return { text: "", error: "OpenRouter API key not set" };
  }
  const modelId = req.modelId.trim();
  if (!modelId) {
    return { text: "", error: "No inline-AI model configured" };
  }

  const controller = new AbortController();
  inflight.set(req.requestId, controller);
  const reasoning = reasoningForRequest(modelId, req.reasoningEffort);

  const body = {
    model: modelId,
    temperature: req.temperature ?? 0.2,
    max_tokens: req.maxTokens ?? MAX_OUTPUT_TOKENS,
    messages: req.messages,
    ...(reasoning ? { reasoning } : {}),
  };

  try {
    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://spark-agent.local",
        "X-Title": "Spark Agent",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`.trim();
      try {
        const json = (await response.json()) as OpenRouterChatResponse;
        if (json.error?.message) message = `${response.status} ${json.error.message}`;
      } catch {
        /* non-JSON body */
      }
      return { text: "", error: message };
    }

    const json = (await response.json()) as OpenRouterChatResponse;
    return { text: extractContent(json), error: null };
  } catch (err) {
    if (controller.signal.aborted) {
      return { text: "", error: "aborted" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { text: "", error: message };
  } finally {
    inflight.delete(req.requestId);
  }
}

export function abortInlineAiCompletion(requestId: string): void {
  const controller = inflight.get(requestId);
  if (controller) {
    controller.abort();
    inflight.delete(requestId);
  }
}
