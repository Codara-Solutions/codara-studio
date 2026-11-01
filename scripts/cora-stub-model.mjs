// Scripted model server for scripts/test-cora-harness.mjs. It speaks enough of
// the Anthropic Messages stream and the Codex Responses stream to carry a read,
// a write and a finish call. No model, no network, no credentials.
//
// The script comes from the request itself, so the server keeps no state per
// conversation: it counts the tool results since the last user text.
//   0 results  read input.txt
//   1 result   write output.txt with the text upper-cased
//   2 results  submit_result when offered (status from SUBMIT_<STATUS>), else text
//   after it   the closing message, as plain text
//
// A prompt that contains PLAIN_TEXT gets a text reply straight away, one with
// NO_SUBMIT finishes in text, one with EMPTY_TEXT gets an empty message, one with
// FAILED_CHECK submits a failed check alongside its status, one with
// TEXT_BESIDE_SUBMIT writes a line in the same message as the call, one with
// EMPTY_CLOSING has nothing to say after the call, and one with LONG_CLOSING
// closes with a long fenced diff full of characters JSON would have to escape.
//
// Faults: stub.control({ mode, count, after }) applies a fault to the next
// `count` model requests, once `after` requests have passed. Modes: http429
// http500 http401 cut hang empty, and chatgpt429, which answers with `body` as
// the error and `headers` as its headers. stub.requests holds every request seen.
//
// A summary request gets a narrative. stub.summaries([...]) queues how the next
// ones behave: ok, bad (no sections), invented, huge, http500 or hang. Each ok
// also ends stub.reportContext(n), which sets the input tokens every reply
// claims, so a test can reach a threshold without sending that much text.
//
// A prompt with FAIL_COMMAND runs a failing command first, and one with
// LARGE_OUTPUT prints five megabytes first, one with BIG_RESULT prints a fact
// followed by 40,000 characters.
//
// Model lists: stub.offer({ anthropic, codex }) sets what GET /v1/models and GET
// /codex/models answer, in each provider's own shape. Without an offer both 404.
// stub.listRequests holds every list request seen.

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";

const control = { mode: "ok", count: null, after: 0, body: null, headers: null };
const requests = [];
const listRequests = [];
const summaryQueue = [];
let reportedContext = 120;
export const LONG_CLOSING = `Proposed fix:

\`\`\`diff
--- a/lib/match.mjs
+++ b/lib/match.mjs
@@ -1,3 +1,3 @@
-const re = /^(\\d{1,2})[ -]([a-z]{3})\\.?$/i;
+const re = /^(\\d{1,2})[ -]([a-z]{3,4})\\.?$/i;
 const path = "C:\\\\temp\\\\new";
${" context line\n".repeat(2000)}\`\`\`
`;
const NARRATIVE = `## Goal
Copy input.txt in upper case.

## Progress
### Done
- [x] Read \`input.txt\`.

## Proven and Claimed
Proven: input.txt was read.
Claimed: nothing.

## Next Steps
1. Finish the copy.
`;
const offers = { anthropic: null, codex: null };
const id = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      resolve((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString("utf8"));
    });
  });
}

function textOf(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "";
}

function anthropicView(body) {
  const events = [];
  for (const message of body.messages ?? []) {
    const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    for (const part of parts) {
      if (part.type === "tool_result") events.push({ kind: "result", text: textOf(part.content) });
      else if (part.type === "tool_use") events.push({ kind: "call", name: part.name });
      else if (message.role === "user" && part.type === "text") events.push({ kind: "user", text: part.text });
    }
  }
  const system = Array.isArray(body.system) ? body.system.map((block) => block.text ?? "").join("\n") : String(body.system ?? "");
  return { model: body.model, tools: (body.tools ?? []).map((tool) => tool.name), system, events };
}

function responsesView(body) {
  const events = [];
  for (const item of body.input ?? []) {
    if (item.type === "function_call_output") events.push({ kind: "result", text: textOf(item.output) });
    else if (item.type === "function_call") events.push({ kind: "call", name: item.name });
    else if (item.role === "user") events.push({ kind: "user", text: textOf(item.content) });
  }
  return { model: body.model, tools: (body.tools ?? []).map((tool) => tool.name), system: String(body.instructions ?? ""), events };
}

const findTool = (tools, name) => tools.find((tool) => tool.toLowerCase() === name) ?? null;

function planSummary() {
  const mode = summaryQueue.shift() ?? "ok";
  if (mode === "bad") return { mode, text: "I could not do that." };
  if (mode === "invented") return { mode, text: NARRATIVE.replace("`input.txt`", "`src/never-touched.ts`") };
  if (mode === "huge") return { mode, text: `${NARRATIVE}${"padding ".repeat(50_000)}` };
  if (mode === "ok") reportedContext = 120;
  return { mode, text: NARRATIVE };
}

function plan(view) {
  if (view.system.includes("context summarization assistant")) return planSummary();
  const lastUser = view.events.findLastIndex((event) => event.kind === "user");
  const prompt = lastUser >= 0 ? view.events[lastUser].text : "";
  const allResults = view.events.slice(lastUser + 1).filter((event) => event.kind === "result");
  const [read, write, finish, bash] = ["read", "write", "submit_result", "bash"].map((name) => findTool(view.tools, name));
  const setup = prompt.includes("FAIL_COMMAND")
    ? "echo SEEDED-ERROR-771 >&2; exit 7"
    : prompt.includes("LARGE_OUTPUT")
      ? "head -c 5000000 /dev/zero | tr '\\0' x"
      : prompt.includes("BIG_RESULT")
        ? "echo UNIQUE-RESULT-FACT-613; head -c 40000 /dev/zero | tr '\\0' x"
        : null;
  const compacted = prompt.includes("# Session facts");
  if (setup && !compacted && allResults.length === 0) return { tool: bash, input: { command: setup } };
  // The setup command's result is not part of the copy.
  const results = setup && !compacted ? allResults.slice(1) : allResults;
  const copied = compacted && /## Files changed with write or edit\n\n- output\.txt/.test(prompt);
  if (prompt.includes("EMPTY_TEXT")) return { text: "" };
  if (prompt.includes("PLAIN_TEXT") || !read || !write) return { text: "STUB-FINAL: plain reply." };
  if (results.length === 0 && !copied) return { tool: read, input: { path: "input.txt" } };
  if (results.length === 1 && !copied) {
    return { tool: write, input: { path: "output.txt", content: `${results[0].text.trim().toUpperCase()}\n` } };
  }
  const reported = view.events.slice(lastUser + 1).some((event) => event.name?.toLowerCase() === "submit_result");
  if (reported) {
    if (prompt.includes("EMPTY_CLOSING")) return { text: "" };
    return { text: prompt.includes("LONG_CLOSING") ? LONG_CLOSING : "STUB-FINAL: copied input.txt to output.txt." };
  }
  if (finish && !prompt.includes("NO_SUBMIT")) {
    const status = /SUBMIT_(\w+)/.exec(prompt)?.[1]?.toLowerCase() ?? "complete";
    const checks = prompt.includes("FAILED_CHECK") ? [{ command: "npm test", result: "failed" }] : undefined;
    const beside = prompt.includes("TEXT_BESIDE_SUBMIT") ? { text: "STATUS: DONE" } : {};
    return { ...beside, tool: finish, input: { status, ...(checks ? { checks } : {}) } };
  }
  return { text: "STUB-FINAL: copied input.txt to output.txt." };
}

function sse(res, event, data) {
  res.write(event ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` : `data: ${JSON.stringify(data)}\n\n`);
}

function startSse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}

function anthropicStart(res, model) {
  const usage = { input_tokens: reportedContext, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  sse(res, "message_start", {
    type: "message_start",
    message: { id: id("msg"), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
}

function streamAnthropic(res, step, model) {
  startSse(res);
  anthropicStart(res, model);
  const index = step.tool && step.text ? 1 : 0;
  if (index === 1) {
    sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  }
  const block = step.tool
    ? { type: "tool_use", id: id("toolu"), name: step.tool, input: {} }
    : { type: "text", text: "" };
  const delta = step.tool
    ? { type: "input_json_delta", partial_json: JSON.stringify(step.input) }
    : { type: "text_delta", text: step.text };
  sse(res, "content_block_start", { type: "content_block_start", index, content_block: block });
  sse(res, "content_block_delta", { type: "content_block_delta", index, delta });
  sse(res, "content_block_stop", { type: "content_block_stop", index });
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: step.tool ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 30 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function streamResponses(res, step, model) {
  const base = { id: id("resp"), object: "response", created_at: Math.floor(Date.now() / 1000), model };
  startSse(res);
  sse(res, null, { type: "response.created", response: { ...base, status: "in_progress", output: [] } });
  let item;
  if (step.tool) {
    const callId = id("call");
    const args = JSON.stringify(step.input);
    item = { type: "function_call", id: `fc_${callId}`, call_id: callId, name: step.tool, arguments: args, status: "completed" };
    sse(res, null, { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
    sse(res, null, { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: args });
    sse(res, null, { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: args });
  } else {
    const itemId = id("msg");
    const part = { type: "output_text", text: step.text, annotations: [] };
    item = { type: "message", id: itemId, role: "assistant", status: "completed", content: [part] };
    sse(res, null, { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } });
    sse(res, null, { type: "response.content_part.added", item_id: itemId, output_index: 0, content_index: 0, part: { ...part, text: "" } });
    sse(res, null, { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: step.text });
    sse(res, null, { type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: step.text });
    sse(res, null, { type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part });
  }
  sse(res, null, { type: "response.output_item.done", output_index: 0, item });
  sse(res, null, {
    type: "response.completed",
    response: {
      ...base,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: reportedContext,
        output_tokens: 30,
        total_tokens: reportedContext + 30,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  res.end();
}

function jsonError(res, status, type, message, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function takeFault() {
  if (control.after > 0) {
    control.after -= 1;
    return "ok";
  }
  const { mode } = control;
  if (mode !== "ok" && control.count !== null) {
    control.count -= 1;
    if (control.count <= 0) Object.assign(control, { mode: "ok", count: null });
  }
  return mode;
}

async function handleModel(req, res, flavour) {
  const body = JSON.parse(await readBody(req));
  const view = flavour === "anthropic" ? anthropicView(body) : responsesView(body);
  const step = plan(view);
  const fault = takeFault();
  requests.push({
    flavour,
    fault,
    path: req.url,
    model: view.model,
    tools: view.tools,
    system: view.system,
    authorization: req.headers.authorization ?? null,
    apiKey: req.headers["x-api-key"] ?? null,
    thinking: body.thinking ?? body.reasoning ?? null,
    outputConfig: body.output_config ?? null,
    events: view.events.map(({ kind, name, text }) => ({ kind, name, chars: text?.length ?? 0, text })),
    reply: step,
    summary: view.system.includes("context summarization assistant"),
  });
  if (step.mode === "http500") return jsonError(res, 500, "api_error", "stub server error");
  if (step.mode === "hang") {
    startSse(res);
    return undefined;
  }
  if (fault === "chatgpt429") {
    res.writeHead(429, { "content-type": "application/json", ...control.headers });
    return res.end(JSON.stringify({ error: control.body }));
  }
  if (fault === "http429") return jsonError(res, 429, "rate_limit_error", "stub rate limit", { "retry-after": "0" });
  if (fault === "http500") return jsonError(res, 500, "api_error", "stub server error");
  if (fault === "http401") return jsonError(res, 401, "authentication_error", "stub invalid token");
  if (fault === "empty") {
    startSse(res);
    return res.end();
  }
  if (fault === "cut" || fault === "hang") {
    startSse(res);
    if (flavour === "anthropic") anthropicStart(res, view.model);
    else sse(res, null, { type: "response.created", response: { id: "resp_fault", status: "in_progress", output: [] } });
    if (fault === "cut") setTimeout(() => res.destroy(), 20);
    return undefined;
  }
  return (flavour === "anthropic" ? streamAnthropic : streamResponses)(res, step, view.model);
}

export function startStubModel() {
  const server = createServer(async (req, res) => {
    const url = req.url.split("?")[0];
    if (req.method === "POST" && url === "/__control") {
      Object.assign(control, { count: null, after: 0 }, JSON.parse((await readBody(req)) || "{}"));
      res.writeHead(200);
      return res.end("{}");
    }
    if (req.method === "GET" && (url === "/v1/models" || url === "/codex/models")) {
      const offer = url === "/v1/models" ? offers.anthropic : offers.codex;
      listRequests.push({ path: url, authorization: req.headers.authorization ?? null });
      res.writeHead(offer ? 200 : 404, { "content-type": "application/json" });
      return res.end(JSON.stringify(offer ?? { error: "no list" }));
    }
    if (req.method === "POST" && url === "/v1/messages") return handleModel(req, res, "anthropic");
    if (req.method === "POST" && url === "/codex/responses") return handleModel(req, res, "responses");
    res.writeHead(404);
    return res.end(`no route for ${req.method} ${url}`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        listRequests,
        offer: (update) => Object.assign(offers, update),
        summaries: (modes) => summaryQueue.push(...modes),
        reportContext: (tokens) => {
          reportedContext = tokens;
        },
        control: (update) => Object.assign(control, { count: null, after: 0 }, update),
        reset: () => {
          requests.length = 0;
          listRequests.length = 0;
          Object.assign(offers, { anthropic: null, codex: null });
          summaryQueue.length = 0;
          reportedContext = 120;
          Object.assign(control, { mode: "ok", count: null, after: 0 });
        },
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startStubModel().then((stub) => console.log(stub.url));
}
