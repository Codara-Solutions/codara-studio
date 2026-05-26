#!/usr/bin/env node
// spark-preview MCP server (stdio, zero deps)
// ---------------------------------------------------------------
// This script is spawned by Claude Code / Codex / any MCP-aware
// runtime as a child process. It speaks MCP's stdio transport
// (newline-delimited JSON-RPC 2.0) and proxies tool calls to the
// running Spark App via its agent socket (loopback HTTP + bearer
// token). Spark's renderer drives an open <preview> tab to make
// the tool calls real.
//
// Design rules:
//   - Zero npm deps. Pure Node stdlib. Bundled with Spark App's
//     extraResources. Runs under any modern Node (>= 18).
//   - Late-binding: Spark may not be running yet when this script
//     is spawned. Read the handshake file on EVERY call and surface
//     "Spark is not running" cleanly.
//   - Read the handshake file every call so a Spark restart with a
//     new token doesn't permanently break the MCP server child.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const HANDSHAKE_FILE = "agent-socket.json";
const DEFAULT_SPARK_HOME = path.join(os.homedir(), ".SparkAgent");

const TOOLS = [
  {
    name: "spark_preview_list",
    description:
      "List the preview tabs currently open in Spark App. Returns each tab's id, url, and whether it is the active one. Use this first to confirm a preview tab exists.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "spark_preview_url",
    description:
      "Return the current URL and title of a Spark preview tab. Defaults to the active preview tab when tabId is omitted.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string", description: "Optional tab id from spark_preview_list." } },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_navigate",
    description:
      "Navigate the target Spark preview tab to a URL (http://, https://, or file://). Waits briefly for dom-ready before returning.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        tabId: { type: "string" },
        url: { type: "string", description: "Absolute URL to load." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_snapshot",
    description:
      "Return a compact outline of the current preview DOM (tag, id, class, role, accessible name). Use to find selectors and inspect structure without burning the full HTML into your context.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        mode: { type: "string", enum: ["outline"], description: "Reserved; currently only 'outline' is supported." },
        maxBytes: { type: "number", description: "Maximum bytes to return (default 12000)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_click",
    description:
      "Click an element by CSS selector inside the target preview tab. Fires pointer/mouse events plus element.click() so React/Vue handlers fire.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        tabId: { type: "string" },
        selector: { type: "string", description: "CSS selector. The first match is used." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_type",
    description:
      "Type text into an input/textarea/contentEditable inside the target preview tab. Optionally clears the existing value first.",
    inputSchema: {
      type: "object",
      required: ["selector", "text"],
      properties: {
        tabId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        clearFirst: { type: "boolean", description: "Clear current value before typing (default false)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_press_key",
    description:
      "Dispatch a keyboard event on the focused element (or a selector if provided). Use named keys like Enter, Escape, Tab, ArrowUp, Backspace, or a single character like 'a'.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        tabId: { type: "string" },
        key: { type: "string" },
        selector: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_evaluate",
    description:
      "Run a JavaScript snippet inside the preview tab. Last expression's value is returned (JSON-serialized). Set awaitPromise=true to await an async expression.",
    inputSchema: {
      type: "object",
      required: ["code"],
      properties: {
        tabId: { type: "string" },
        code: { type: "string" },
        awaitPromise: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_wait_for",
    description:
      "Wait for a CSS selector to be attached / visible / hidden, up to timeoutMs. Returns when the condition is met or times out.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        tabId: { type: "string" },
        selector: { type: "string" },
        state: { type: "string", enum: ["attached", "visible", "hidden"], description: "Default 'visible'." },
        timeoutMs: { type: "number", description: "Default 5000." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_screenshot",
    description:
      "Capture the current preview tab as a PNG (returned base64-encoded in a data: URL). The pixels are exactly what the user sees in Spark.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" } },
      additionalProperties: false,
    },
  },
];

const TOOL_TO_RPC = {
  spark_preview_list: "preview.list",
  spark_preview_url: "preview.url",
  spark_preview_navigate: "preview.navigate",
  spark_preview_snapshot: "preview.snapshot",
  spark_preview_click: "preview.click",
  spark_preview_type: "preview.type",
  spark_preview_press_key: "preview.press_key",
  spark_preview_evaluate: "preview.evaluate",
  spark_preview_wait_for: "preview.wait_for",
  spark_preview_screenshot: "preview.screenshot",
};

function resolveSparkHome() {
  const override = process.env.SPARK_HOME_DIR || process.env.SPARK_USER_DATA_DIR;
  if (override && override.trim()) return override;
  return DEFAULT_SPARK_HOME;
}

function readHandshake() {
  const file = path.join(resolveSparkHome(), HANDSHAKE_FILE);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.url !== "string" || typeof parsed.token !== "string") {
      throw new Error("handshake file is malformed");
    }
    return { url: parsed.url, token: parsed.token };
  } catch (err) {
    const e = new Error(
      `Spark App appears to be offline (could not read ${file}). Open Spark App and try again. Cause: ${err.message}`,
    );
    e.code = "SPARK_OFFLINE";
    throw e;
  }
}

function postJsonRpc(method, params) {
  return new Promise((resolve, reject) => {
    let handshake;
    try {
      handshake = readHandshake();
    } catch (err) {
      reject(err);
      return;
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || {} });
    let target;
    try {
      target = new URL(handshake.url + "/rpc");
    } catch (err) {
      reject(new Error(`bad handshake url '${handshake.url}': ${err.message}`));
      return;
    }
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body, "utf8"),
          Authorization: `Bearer ${handshake.token}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`Spark agent socket returned ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.error) {
              const errMsg = parsed.error.message || "preview op failed";
              reject(new Error(errMsg));
              return;
            }
            resolve(parsed && Object.prototype.hasOwnProperty.call(parsed, "result") ? parsed.result : null);
          } catch (err) {
            reject(new Error(`Spark agent socket returned non-JSON: ${err.message}`));
          }
        });
      },
    );
    req.on("error", (err) => reject(new Error(`Spark agent socket unreachable: ${err.message}`)));
    req.setTimeout(60_000, () => {
      req.destroy(new Error("Spark agent socket timeout"));
    });
    req.write(body);
    req.end();
  });
}

// MCP stdio framing: each message is a JSON-RPC object on its own line.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    handleLine(line).catch((err) => {
      const message = err && err.message ? err.message : String(err);
      writeLine({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message },
      });
    });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

function writeLine(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function handleLine(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    writeLine({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${err.message}` } });
    return;
  }
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    writeLine({ jsonrpc: "2.0", id: req && "id" in req ? req.id : null, error: { code: -32600, message: "invalid envelope" } });
    return;
  }
  const id = "id" in req ? req.id : null;
  try {
    const result = await dispatch(req.method, req.params || {});
    // Notifications (no id) get no response.
    if (id !== undefined && id !== null) {
      writeLine({ jsonrpc: "2.0", id, result });
    }
  } catch (err) {
    if (id !== undefined && id !== null) {
      writeLine({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
    }
  }
}

async function dispatch(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "spark-preview", version: "0.1.0" },
      };
    case "notifications/initialized":
    case "initialized":
      return null;
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return await callTool(params);
    case "ping":
      return {};
    default:
      throw mkErr(-32601, `unknown method: ${method}`);
  }
}

async function callTool(params) {
  const name = params && typeof params.name === "string" ? params.name : null;
  if (!name || !TOOL_TO_RPC[name]) throw mkErr(-32602, `unknown tool: ${name}`);
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  try {
    const result = await postJsonRpc(TOOL_TO_RPC[name], args);
    return toToolResult(result);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: err.message }],
    };
  }
}

function toToolResult(value) {
  // MCP tool result format: { content: [{type:'text', text}] } + optional isError.
  // Screenshot result includes a data URL we surface as an image content block.
  if (value && typeof value === "object" && typeof value.dataUrl === "string" && value.dataUrl.startsWith("data:image/")) {
    const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(value.dataUrl);
    if (m) {
      return {
        content: [
          { type: "image", mimeType: m[1], data: m[2] },
          { type: "text", text: JSON.stringify({ url: value.url ?? null }) },
        ],
      };
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function mkErr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
