// Scripted model server for scripts/test-cora-harness.mjs. It speaks enough of
// the Anthropic Messages stream and the Codex Responses stream to carry a read,
// a write and a finish call. No model, no network, no credentials.
//
// The script comes from the request itself, so the server keeps no state per
// conversation: it counts the tool results since the last user text.
//   0 results  read input.txt
//   1 result   write output.txt with the text upper-cased
//   2 results  submit_result when offered (status from SUBMIT_<STATUS>), else text
//
// A prompt that contains PLAIN_TEXT gets a text reply straight away, one with
// NO_SUBMIT finishes in text, one with EMPTY_TEXT gets an empty message, and one
// with FAILED_CHECK submits a failed check alongside its status.
//
// Faults: stub.control({ mode, count, after }) applies a fault to the next
// `count` model requests, once `after` requests have passed. Modes: http429
// http500 http401 cut hang empty. stub.requests holds every request seen.

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";

const control = { mode: "ok", count: null, after: 0 };
const requests = [];
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

function plan(view) {
  const lastUser = view.events.findLastIndex((event) => event.kind === "user");
  const prompt = lastUser >= 0 ? view.events[lastUser].text : "";
  const results = view.events.slice(lastUser + 1).filter((event) => event.kind === "result");
  const [read, write, finish] = ["read", "write", "submit_result"].map((name) => findTool(view.tools, name));
  if (prompt.includes("EMPTY_TEXT")) return { text: "" };
  if (prompt.includes("PLAIN_TEXT") || !read || !write) return { text: "STUB-FINAL: plain reply." };
  if (results.length === 0) return { tool: read, input: { path: "input.txt" } };
  if (results.length === 1) {
    return { tool: write, input: { path: "output.txt", content: `${results[0].text.trim().toUpperCase()}\n` } };
  }
  if (finish && !prompt.includes("NO_SUBMIT")) {
    const status = /SUBMIT_(\w+)/.exec(prompt)?.[1]?.toLowerCase() ?? "complete";
    const checks = prompt.includes("FAILED_CHECK") ? [{ command: "npm test", result: "failed" }] : undefined;
    return { tool: finish, input: { status, summary: "STUB-FINAL: copied input.txt to output.txt.", ...(checks ? { checks } : {}) } };
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
  const usage = { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  sse(res, "message_start", {
    type: "message_start",
    message: { id: id("msg"), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
}

function streamAnthropic(res, step, model) {
  startSse(res);
  anthropicStart(res, model);
  const block = step.tool
    ? { type: "tool_use", id: id("toolu"), name: step.tool, input: {} }
    : { type: "text", text: "" };
  const delta = step.tool
    ? { type: "input_json_delta", partial_json: JSON.stringify(step.input) }
    : { type: "text_delta", text: step.text };
  sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: block });
  sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta });
  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
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
        input_tokens: 120,
        output_tokens: 30,
        total_tokens: 150,
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
    events: view.events.map(({ kind, name, text }) => ({ kind, name, chars: text?.length ?? 0, text: text?.slice(0, 200) })),
    reply: step,
  });
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
        control: (update) => Object.assign(control, { count: null, after: 0 }, update),
        reset: () => {
          requests.length = 0;
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
