#!/usr/bin/env node
// spark-preview MCP server (stdio, zero deps)
// ---------------------------------------------------------------
// This script is spawned by Claude Code / Codex / any MCP-aware
// runtime as a child process. It speaks MCP's stdio transport
// (newline-delimited JSON-RPC 2.0) and proxies tool calls to the
// running Codara via its agent socket (loopback HTTP + bearer
// token). Codara's renderer drives an open <preview> tab to make
// the tool calls real.
//
// Design rules:
//   - Zero npm deps. Pure Node stdlib. Bundled with Codara's
//     extraResources. Runs under any modern Node (>= 18).
//   - Late-binding: Codara may not be running yet when this script
//     is spawned. Read the handshake file on EVERY call and surface
//     "Codara is not running" cleanly.
//   - Read the handshake file every call so a Codara restart with a
//     new token doesn't permanently break the MCP server child.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const HANDSHAKE_FILE = "agent-socket.json";
const DEFAULT_SPARK_HOME = path.join(os.homedir(), ".Codara");

const TOOLS = [
  {
    name: "spark_preview_list",
    description:
      "List the preview tabs currently open in Codara. Returns each tab's id, url, and whether it is the active one. Use this first to confirm a preview tab exists.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "spark_preview_url",
    description:
      "Return the current URL and title of a Codara preview tab. Defaults to the active preview tab when tabId is omitted.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string", description: "Optional tab id from spark_preview_list." } },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_navigate",
    description:
      "Navigate the target Codara preview tab to a URL (http://, https://, or file://). Waits briefly for dom-ready before returning.",
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
      "Capture the current preview tab as a PNG (returned base64-encoded in a data: URL). The pixels are exactly what the user sees in Codara.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_mouse",
    description:
      "Trusted mouse input at a CSS selector's center or explicit coordinates — indistinguishable from a real user's click (event.isTrusted=true), unlike spark_preview_click's synthetic DOM events. Actions: click, dblclick, rightclick, down, up. Coordinates are CSS pixels relative to the page viewport (top-left origin); if you measured a point on a spark_preview_screenshot, divide by the screenshot's scale (screenshot width ÷ viewport width) first.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        action: { type: "string", enum: ["click", "dblclick", "rightclick", "down", "up"], description: "Default 'click'." },
        selector: { type: "string", description: "Click the element's center (scrolled into view first)." },
        x: { type: "number", description: "CSS-pixel viewport X (alternative to selector)." },
        y: { type: "number", description: "CSS-pixel viewport Y (alternative to selector)." },
        modifiers: { type: "array", items: { type: "string" }, description: "e.g. ['shift','meta','control','alt']" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_scroll",
    description:
      "Scroll the page with a trusted mouse-wheel event at a selector's center or explicit CSS-pixel coordinates. Positive deltaY scrolls down, negative up.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_hover",
    description:
      "Move the mouse over a selector's center or explicit CSS-pixel coordinates with a trusted mouseMove — triggers real :hover styles, tooltips, and mouseenter handlers.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_drag",
    description:
      "Trusted drag: mouseDown at 'from', interpolated mouseMove steps, mouseUp at 'to'. Each endpoint is { selector } or { x, y } in CSS pixels.",
    inputSchema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        tabId: { type: "string" },
        from: {
          type: "object",
          properties: { selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
          additionalProperties: false,
        },
        to: {
          type: "object",
          properties: { selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
          additionalProperties: false,
        },
        steps: { type: "number", description: "Interpolated move events between endpoints (default 12, max 100)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_key",
    description:
      "Trusted keyboard input to the focused element: named keys (Enter, Escape, Tab, Backspace, ArrowDown, …) or a single character, with optional modifiers. For typing whole strings into a field prefer spark_preview_type.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        tabId: { type: "string" },
        key: { type: "string" },
        text: { type: "string", description: "Printable text for the char event when it differs from 'key'." },
        modifiers: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_upload",
    description:
      "Set the files of an <input type=file> via the DevTools protocol (the only reliable way to script a file upload). 'paths' are absolute paths on this machine.",
    inputSchema: {
      type: "object",
      required: ["selector", "paths"],
      properties: {
        tabId: { type: "string" },
        selector: { type: "string" },
        paths: { type: "array", minItems: 1, items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_console",
    description:
      "Read the preview tab's captured console messages (ring buffer, newest last, cap 500). Filter with level=debug|info|warning|error, trim with limit, or clear=true to reset. Capture starts when the tab loads, so messages from before this build opened the tab may be missing.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        limit: { type: "number", description: "Default 100, max 500." },
        level: { type: "string", enum: ["debug", "info", "warning", "error"] },
        clear: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_network",
    description:
      "Read the preview tab's captured network requests (url, method, status, mimeType, failures; ring buffer cap 500). Capture attaches on first call — issue one spark_preview_network before the interaction you want to observe, then again after. filter substring-matches the URL; clear=true resets.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        limit: { type: "number", description: "Default 100, max 500." },
        filter: { type: "string" },
        clear: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_resize",
    description:
      "Resize the preview viewport to explicit CSS-pixel dimensions (e.g. 375×667 to test a mobile layout). Returns the applied size.",
    inputSchema: {
      type: "object",
      required: ["width", "height"],
      properties: {
        tabId: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_preview_run",
    description:
      "Run an ordered BATCH of preview steps in ONE call (one MCP round-trip) instead of dozens of single click/press_key calls. Each step dispatches the exact same real input event as its individual tool, so fidelity is identical — you just stop paying a separate round-trip (and a separate agent turn) per keystroke. STRONGLY PREFER this for any multi-step verification flow: e.g. drive `7 / 2 =` and read the display as a single spark_preview_run, not seven calls. Stops at the first failing step unless continueOnError=true. Returns a per-step result array; any screenshot steps are also surfaced as image blocks.",
    inputSchema: {
      type: "object",
      required: ["steps"],
      properties: {
        tabId: { type: "string", description: "Default tab for steps that omit their own tabId." },
        continueOnError: {
          type: "boolean",
          description: "Keep running after a failing step (default false).",
        },
        steps: {
          type: "array",
          minItems: 1,
          description:
            "Ordered steps. Each is { action, ...args } where action is one of navigate|click|type|press_key|evaluate|wait_for|snapshot|screenshot and the remaining fields mirror the matching spark_preview_* tool — e.g. {action:'press_key', key:'7'}, {action:'click', selector:'#equals'}, {action:'evaluate', code:\"document.querySelector('#lcd').textContent\"}.",
          items: {
            type: "object",
            required: ["action"],
            properties: {
              action: {
                type: "string",
                enum: [
                  "navigate",
                  "click",
                  "type",
                  "press_key",
                  "evaluate",
                  "wait_for",
                  "snapshot",
                  "screenshot",
                  "scroll",
                  "hover",
                  "key",
                  "resize",
                ],
              },
              label: { type: "string", description: "Optional note echoed back in the step result." },
              tabId: { type: "string" },
              url: { type: "string" },
              selector: { type: "string" },
              text: { type: "string" },
              clearFirst: { type: "boolean" },
              key: { type: "string" },
              code: { type: "string" },
              awaitPromise: { type: "boolean" },
              state: { type: "string" },
              timeoutMs: { type: "number" },
              x: { type: "number" },
              y: { type: "number" },
              deltaX: { type: "number" },
              deltaY: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
              modifiers: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
      },
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
  spark_preview_mouse: "preview.mouse",
  spark_preview_scroll: "preview.scroll",
  spark_preview_hover: "preview.hover",
  spark_preview_drag: "preview.drag",
  spark_preview_key: "preview.key",
  spark_preview_upload: "preview.upload",
  spark_preview_console: "preview.console",
  spark_preview_network: "preview.network",
  spark_preview_resize: "preview.resize",
};

// Step action -> RPC for the batched spark_preview_run tool. Mirrors the
// single-shot tools so a batched step fires the identical real event.
const STEP_ACTION_TO_RPC = {
  navigate: "preview.navigate",
  click: "preview.click",
  type: "preview.type",
  press_key: "preview.press_key",
  evaluate: "preview.evaluate",
  wait_for: "preview.wait_for",
  snapshot: "preview.snapshot",
  screenshot: "preview.screenshot",
  // Trusted-input steps (drag/upload/console/network stay single-shot tools:
  // drag's nested from/to and the read-tools' outputs don't batch cleanly).
  scroll: "preview.scroll",
  hover: "preview.hover",
  key: "preview.key",
  resize: "preview.resize",
};

function resolveSparkHome() {
  const override = process.env.CODARA_HOME_DIR || process.env.SPARK_HOME_DIR || process.env.SPARK_USER_DATA_DIR;
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
      `Codara appears to be offline (could not read ${file}). Open Codara and try again. Cause: ${err.message}`,
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
            reject(new Error(`Codara agent socket returned ${res.statusCode}: ${text.slice(0, 200)}`));
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
            reject(new Error(`Codara agent socket returned non-JSON: ${err.message}`));
          }
        });
      },
    );
    req.on("error", (err) => reject(new Error(`Codara agent socket unreachable: ${err.message}`)));
    req.setTimeout(60_000, () => {
      req.destroy(new Error("Codara agent socket timeout"));
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
        serverInfo: { name: "cora-preview", version: "0.1.0" },
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
  const args = params && params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  if (name === "spark_preview_run") return await callRunBatch(args);
  if (!name || !TOOL_TO_RPC[name]) throw mkErr(-32602, `unknown tool: ${name}`);
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

// Execute an ordered batch of preview steps in a single MCP round-trip. Each
// step is the same RPC the single-shot tool would issue, run sequentially so
// later steps observe the DOM the earlier ones produced. Screenshot steps are
// surfaced as image content blocks (and their base64 stripped from the JSON
// echo so the per-step array stays readable).
async function callRunBatch(args) {
  const steps = args && Array.isArray(args.steps) ? args.steps : null;
  if (!steps || steps.length === 0) {
    return { isError: true, content: [{ type: "text", text: "spark_preview_run requires a non-empty 'steps' array." }] };
  }
  const continueOnError = args.continueOnError === true;
  const defaultTabId = typeof args.tabId === "string" ? args.tabId : undefined;
  const results = [];
  const images = [];
  let sawError = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] && typeof steps[i] === "object" ? steps[i] : {};
    const action = step.action;
    const rpc = STEP_ACTION_TO_RPC[action];
    if (!rpc) {
      results.push({ index: i, action: action ?? null, ok: false, error: `unknown action '${action}'` });
      sawError = true;
      if (!continueOnError) break;
      continue;
    }
    const { action: _omitAction, label, ...rest } = step;
    const rpcArgs = { ...rest };
    if (defaultTabId && rpcArgs.tabId === undefined) rpcArgs.tabId = defaultTabId;
    const entry = { index: i, action };
    if (label) entry.label = label;
    try {
      const result = await postJsonRpc(rpc, rpcArgs);
      entry.ok = true;
      if (action === "screenshot" && result && typeof result.dataUrl === "string") {
        const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(result.dataUrl);
        if (m) images.push({ type: "image", mimeType: m[1], data: m[2] });
        entry.result = { url: result.url ?? null, captured: Boolean(m) };
      } else {
        entry.result = result;
      }
      results.push(entry);
    } catch (err) {
      entry.ok = false;
      entry.error = err.message;
      results.push(entry);
      sawError = true;
      if (!continueOnError) break;
    }
  }
  const payload = { ok: !sawError, ran: results.length, total: steps.length, steps: results };
  return {
    isError: sawError,
    content: [...images, { type: "text", text: JSON.stringify(payload, null, 2) }],
  };
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
