#!/usr/bin/env node
// spark-orchestrator MCP server (stdio, zero deps)
// ---------------------------------------------------------------
// This script is spawned by Claude Code / Codex CLIs running in
// Spark's Execute mode as a child MCP process. It speaks MCP's
// stdio transport (newline-delimited JSON-RPC 2.0) and proxies
// orchestrator tool calls to the running Spark App via its agent
// socket (loopback HTTP + bearer token). The CLI plays the role
// of Spark's manager; these tools let it spawn Spark workers,
// ask the user clarifying questions, and mark the run complete.
//
// Design rules (mirrored from spark-preview-mcp/server.js):
//   - Zero npm deps. Pure Node stdlib. Bundled with Spark App's
//     extraResources. Runs under any modern Node (>= 18).
//   - Late-binding: Spark may not be running yet when this script
//     is spawned. Read the handshake file on EVERY call and surface
//     "Spark is not running" cleanly.
//   - Read the handshake file every call so a Spark restart with a
//     new token doesn't permanently break the MCP server child.
//   - Auto-inject runId from process.env.SPARK_RUN_ID so the
//     orchestrator prompt doesn't have to know its own run id.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const HANDSHAKE_FILE = "agent-socket.json";
const DEFAULT_SPARK_HOME = path.join(os.homedir(), ".SparkAgent");

const TOOLS = [
  {
    name: "spark_spawn_workers",
    description:
      "Delegate one or more focused tasks to Spark workers (claude/codex subagents). Each worker entry needs a title and description; runtime/model/effort hints and path scoping are optional. Returns worker_task_ids that can be queried via spark_get_worker_status. Call this whenever you want to fan work out instead of doing it yourself in the orchestrator turn.",
    inputSchema: {
      type: "object",
      required: ["workers"],
      properties: {
        runId: {
          type: "string",
          description:
            "Spark run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        workers: {
          type: "array",
          minItems: 1,
          description: "Worker tasks to queue. Each becomes its own Spark workerTask + initial attempt.",
          items: {
            type: "object",
            required: ["title", "description"],
            properties: {
              title: { type: "string", description: "Short worker title (shown in the Spark run UI)." },
              description: {
                type: "string",
                description: "Full task brief for the worker, including success criteria.",
              },
              runtimePreference: {
                type: "string",
                enum: ["claude", "codex", "shell", "manual"],
                description: "Runtime hint. Defaults to 'claude' when omitted.",
              },
              modelHint: { type: "string", description: "Optional model id hint for the worker." },
              effortHint: {
                type: "string",
                enum: ["minimal", "low", "medium", "high", "xhigh"],
                description: "Optional effort tier hint.",
              },
              allowedPaths: {
                type: "array",
                items: { type: "string" },
                description: "Optional repo-relative paths the worker is allowed to touch.",
              },
              forbiddenPaths: {
                type: "array",
                items: { type: "string" },
                description: "Optional repo-relative paths the worker must NOT touch.",
              },
              expectedOutputs: {
                type: "array",
                items: { type: "string" },
                description: "Optional list of files/artifacts the worker is expected to produce.",
              },
              verificationCommands: {
                type: "array",
                items: { type: "string" },
                description: "Optional shell commands the verifier should run to confirm success.",
              },
              taskClass: {
                type: "string",
                enum: ["skeleton", "feature", "leaf", "verifier"],
                description: "Optional task class to drive tier/pricing selection.",
              },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_ask_user",
    description:
      "Ask the human user a clarifying question and block until they answer (up to 15 minutes). Use sparingly — only when you genuinely cannot proceed without a decision. Provide up to 4 option objects with stable ids so the user can tap one rather than typing a free-form reply.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        runId: {
          type: "string",
          description:
            "Spark run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        question: {
          type: "string",
          description: "The question to surface in the Spark chat panel.",
        },
        options: {
          type: "array",
          maxItems: 4,
          description: "Up to 4 quick-pick options. Each item should have a label and optional description.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable option id (defaults to option_1..option_4)." },
              label: { type: "string", description: "Short label rendered on the option chip." },
              description: { type: "string", description: "Longer hover/explanation text." },
              answer: {
                type: "string",
                description: "Text recorded as the user's reply when they pick this option. Defaults to label.",
              },
              recommended: {
                type: "boolean",
                description: "Mark a single option as recommended.",
              },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_complete",
    description:
      "Mark the Spark run as complete. Optionally include a short summary of what was accomplished — it is posted as a system note in the chat. Call this exactly once at the very end of the orchestrator turn after all work has settled.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description:
            "Spark run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        summary: {
          type: "string",
          description: "Optional human-readable summary to attach as a system note.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_request_next_iteration",
    description:
      "For Spark AUTOMATION LOOPS only: decide whether this loop should run another iteration after the current one finishes. Call this exactly once near the end of an automation turn. Set done=true to STOP the loop, or done=false (with an optional `prompt` for the next pass) to CONTINUE. You may optionally steer the NEXT pass's worker via nextEngine/nextModel/nextEffort — honored only when the automation's engine is set to Auto, and only for installed engines (invalid values are dropped with a warning, never an error). The user-defined safety caps (max iterations, budget) always still apply. If you never call this, the loop stops by default. (No effect on a normal, non-automation run.)",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description:
            "Spark run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        done: {
          type: "boolean",
          description: "true = stop the loop now; false = run another iteration. Defaults to false (continue).",
        },
        prompt: {
          type: "string",
          description:
            "Optional instruction for the NEXT iteration. When omitted, the automation's prompt template is used for the next pass.",
        },
        nextEngine: {
          type: "string",
          enum: ["claude", "codex"],
          description:
            "Optional: which CLI agent runs the NEXT iteration. Honored only for Auto-engine automations; ignored (with a warning) when the engine is pinned or not installed.",
        },
        nextModel: {
          type: "string",
          description:
            "Optional engine-native model id for the NEXT iteration (e.g. claude-opus-4-8, gpt-5.5). Requires nextEngine; unknown ids fall back to the CLI default.",
        },
        nextEffort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh", "max"],
          description: "Optional reasoning-effort level for the NEXT iteration.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_get_worker_status",
    description:
      "One-shot snapshot of a worker task's current status — use sparingly for ad-hoc spot checks. For waiting on completion, prefer spark_wait_for_workers, which long-polls and returns when workers reach a terminal state. Returns worker_task_id, task_status, the latest attempt's status / runtime / timestamps, and the final_report_path if the worker has finished.",
    inputSchema: {
      type: "object",
      required: ["worker_task_id"],
      properties: {
        runId: {
          type: "string",
          description:
            "Spark run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        worker_task_id: {
          type: "string",
          description: "Worker task id returned from spark_spawn_workers.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_wait_for_workers",
    description:
      "Block until the listed worker tasks reach a terminal state (accepted / failed / cancelled) or timeout_ms elapses. This is the canonical way to wait on workers — call it once after spark_spawn_workers and react to the results. Returns each worker's final task_status, attempt_status, finished_at, and final_report_path so you can read each report and decide whether to spark_complete (default) or spark_spawn_workers (only for genuine regressions/corrective fixes).",
    inputSchema: {
      type: "object",
      required: ["worker_task_ids"],
      properties: {
        runId: {
          type: "string",
          description:
            "Spark run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        worker_task_ids: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Worker task ids returned from spark_spawn_workers.",
        },
        mode: {
          type: "string",
          enum: ["all", "any"],
          description: "Return when ALL listed workers terminate (default) or as soon as ANY one terminates.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Max wait in milliseconds. Defaults to 600000 (10 min). Capped at 1200000 (20 min). On timeout, returns whichever workers DID terminate plus reason='timeout'.",
        },
      },
      additionalProperties: false,
    },
  },
];

const TOOL_TO_RPC = {
  spark_spawn_workers: "orchestrator.spawn_workers",
  spark_ask_user: "orchestrator.ask_user",
  spark_complete: "orchestrator.complete",
  spark_request_next_iteration: "orchestrator.request_next_iteration",
  spark_get_worker_status: "orchestrator.get_worker_status",
  spark_wait_for_workers: "orchestrator.wait_for_workers",
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
              const errMsg = parsed.error.message || "orchestrator op failed";
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
    // ask_user can block up to 15 min waiting on a human, so allow plenty of headroom.
    req.setTimeout(20 * 60_000, () => {
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
        serverInfo: { name: "spark-orchestrator", version: "0.1.0" },
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
  const args = params.arguments && typeof params.arguments === "object" ? { ...params.arguments } : {};
  // Auto-inject runId from the env var injected by pty-manager when the CLI
  // was spawned for this run, so the orchestrator prompt doesn't have to know
  // its own run id. Caller-supplied runId always wins.
  if (typeof args.runId !== "string" || args.runId.trim().length === 0) {
    const envRunId = process.env.SPARK_RUN_ID;
    if (envRunId && envRunId.trim().length > 0) {
      args.runId = envRunId.trim();
    }
  }
  // Slice 7: stamp the calling worker's loom node id (SPARK_NODE_ID, exported
  // by direct-worker's headless spawn) onto the continuation signal so the
  // pass-level "agent" loop can read ONLY the SINK node's decision in a
  // multi-node wave. Auto-injected for request_next_iteration only; harmless
  // (ignored) for single-node looms where the env var is absent. Caller-
  // supplied nodeId always wins.
  if (
    name === "spark_request_next_iteration" &&
    (typeof args.nodeId !== "string" || args.nodeId.trim().length === 0)
  ) {
    const envNodeId = process.env.SPARK_NODE_ID;
    if (envNodeId && envNodeId.trim().length > 0) {
      args.nodeId = envNodeId.trim();
    }
  }
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
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function mkErr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
