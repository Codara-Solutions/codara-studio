// OpenRouter inline-completion request — mirrors how Spark's manager calls
// OpenRouter (see src/main/orchestration/openrouter-manager.ts) so we reuse
// the existing key, base URL, HTTP-Referer and X-Title headers. No new
// settings field for the API key — the renderer reads it from
// window.spark.settings.load() (AppSettings.openRouterApiKey) on startup.

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const MAX_PREFIX = 4000;
const MAX_SUFFIX = 2000;
const MAX_OUTPUT_TOKENS = 256;

// System prompt instructs the model to act as a fill-in-middle (FIM)
// completer. Behaviour mirrors terax-scout's prompt.ts but is delivered
// via a chat-completion (system + user) since OpenRouter doesn't expose a
// dedicated FIM endpoint.
const COMPLETION_SYSTEM_PROMPT = `You perform fill-in-the-middle code completion.

You receive PREFIX (code before the cursor) and SUFFIX (code after the cursor). Your output is inserted EXACTLY at the cursor position. PREFIX + your_output + SUFFIX must form valid, syntactically-correct code.

Output the next chunk of code you can predict with high confidence. Stop when the next decision becomes genuinely ambiguous. A good chunk is usually:
- The remaining characters of a partially-typed token, OR
- A full line (statement, signature, expression), OR
- A short block (2-6 lines) when its closing delimiter is already in SUFFIX.

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

PREFIX: "function fetchUser(id: string) {\\n  "
SUFFIX: "\\n}"
OUTPUT: "return fetch(\`/api/users/\${id}\`).then(r => r.json());"`;

export interface CompletionRequest {
  prefix: string;
  suffix: string;
  filename: string | null;
  language: string | null;
}

export interface OpenRouterCompletionDeps {
  apiKey: string;
  modelId: string;
}

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
  };
}

function trimContext(prefix: string, suffix: string): { prefix: string; suffix: string } {
  const p = prefix.length > MAX_PREFIX ? prefix.slice(prefix.length - MAX_PREFIX) : prefix;
  const s = suffix.length > MAX_SUFFIX ? suffix.slice(0, MAX_SUFFIX) : suffix;
  return { prefix: p, suffix: s };
}

function buildUserPrompt(req: CompletionRequest): string {
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

// Single OpenRouter chat-completion call. The caller's AbortSignal aborts
// the in-flight request when the user keeps typing. Returns the raw model
// output; ghost-text trim/post-processing is handled by the caller.
export async function requestOpenRouterCompletion(
  req: CompletionRequest,
  deps: OpenRouterCompletionDeps,
  signal: AbortSignal,
): Promise<string> {
  if (!deps.apiKey || !deps.modelId) return "";

  const body = {
    model: deps.modelId,
    temperature: 0.2,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      { role: "system" as const, content: COMPLETION_SYSTEM_PROMPT },
      { role: "user" as const, content: buildUserPrompt(req) },
    ],
  };

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.apiKey}`,
      "Content-Type": "application/json",
      // Reuse the same Referer + Title pair Spark's manager sends so the
      // OpenRouter dashboard groups inline-AI traffic with the rest of the
      // app's usage.
      "HTTP-Referer": "https://spark-agent.local",
      "X-Title": "Spark Agent",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let message = `OpenRouter request failed with ${response.status}`;
    try {
      const json = (await response.json()) as OpenRouterChatResponse;
      if (json.error?.message) message = json.error.message;
    } catch {
      // ignore parse errors — we'll throw with the status-line message
    }
    throw new Error(message);
  }

  const json = (await response.json()) as OpenRouterChatResponse;
  return extractContent(json).trim();
}
