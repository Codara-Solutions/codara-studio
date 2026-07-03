#!/usr/bin/env node
// spark-orchestrator MCP server (stdio, zero deps)
// ---------------------------------------------------------------
// This script is spawned by Claude Code / Codex CLIs running in
// Codara's Execute mode as a child MCP process. It speaks MCP's
// stdio transport (newline-delimited JSON-RPC 2.0) and proxies
// orchestrator tool calls to the running Codara via its agent
// socket (loopback HTTP + bearer token). The CLI plays the role
// of Codara's manager; these tools let it spawn Cora workers,
// ask the user clarifying questions, and mark the run complete.
//
// Design rules (mirrored from cora-preview-mcp/server.js):
//   - Zero npm deps. Pure Node stdlib. Bundled with Codara's
//     extraResources. Runs under any modern Node (>= 18).
//   - Late-binding: Codara may not be running yet when this script
//     is spawned. Read the handshake file on EVERY call and surface
//     "Codara is not running" cleanly.
//   - Read the handshake file every call so a Codara restart with a
//     new token doesn't permanently break the MCP server child.
//   - Auto-inject runId from process.env.SPARK_RUN_ID so the
//     orchestrator prompt doesn't have to know its own run id.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const HANDSHAKE_FILE = "agent-socket.json";
const DEFAULT_SPARK_HOME = path.join(os.homedir(), ".Codara");

// Mode gating. When SPARK_MCP_MODE === "automation" (set by the per-run
// MCP config the Claude backend writes for Automation-mode chats) the server
// exposes ONLY the automation architect tool set + spark_ask_user. Anything
// else (unset / "execute" / the globally-installed user-scope entry that has
// no env at all) keeps the original 6-tool Execute roster, byte-for-byte
// backwards-compatible so automation-loop workers calling
// spark_request_next_iteration are unaffected.
const SPARK_MCP_MODE = (process.env.SPARK_MCP_MODE || "").trim().toLowerCase();
const IS_AUTOMATION_MODE = SPARK_MCP_MODE === "automation";

// ---------------------------------------------------------------------------
// Shared JSON-schema fragments for the automation tool set. Kept verbose and
// LLM-friendly: every enum + token is spelled out so the architect model can
// author triggers / loops / workers / graphs without guessing the shape.
// ---------------------------------------------------------------------------
const TRIGGER_SCHEMA = {
  type: "object",
  description:
    "How the automation fires. Exactly one kind, each with its OWN required fields: " +
    "cron REQUIRES a valid `expr` (validated server-side). " +
    "interval REQUIRES a finite numeric `everyMs` >= 1000. " +
    "folder REQUIRES a `path` to watch. " +
    "onFinishOf REQUIRES an `automationId` that references an EXISTING automation (call spark_list_automations first). " +
    "manual only fires via spark_run_automation or the Hub. " +
    "continuous re-fires immediately after each run finishes.",
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: ["cron", "interval", "folder", "manual", "continuous", "onFinishOf"],
    },
    expr: { type: "string", description: "cron (REQUIRED): valid 5/6-field cron expression, e.g. '0 9 * * 1-5'." },
    tz: { type: "string", description: "cron only: optional IANA timezone, e.g. 'America/New_York'." },
    everyMs: { type: "number", description: "interval (REQUIRED): gap between fires in ms; must be finite and >= 1000." },
    path: { type: "string", description: "folder (REQUIRED): absolute folder path to watch." },
    events: {
      type: "array",
      description: "folder only: which fs events fire the trigger.",
      items: { type: "string", enum: ["add", "change", "unlink"] },
    },
    glob: { type: "string", description: "folder only: optional basename glob, e.g. '*.md'. Omit to match every file." },
    debounceMs: { type: "number", description: "folder only: coalesce a burst of events into one fire (default 400)." },
    automationId: { type: "string", description: "onFinishOf (REQUIRED): id of an EXISTING automation to chain after." },
  },
  additionalProperties: false,
};

const LOOP_SCHEMA = {
  type: "object",
  description:
    "How many times / how long the automation iterates per fire. once: a single pass. count: a fixed number (use stop.maxIterations). cadence: re-run every everyMs until a stop condition. until: loop until a stop condition holds. agent: the worker itself decides each pass via spark_request_next_iteration. continuous: loop with no natural end (rely on stop caps).",
  required: ["kind", "stop"],
  properties: {
    kind: { type: "string", enum: ["once", "count", "cadence", "until", "continuous", "agent"] },
    everyMs: { type: "number", description: "cadence (REQUIRED for kind 'cadence'): gap BETWEEN iteration starts in ms; must be finite and >= 1000." },
    isolate: {
      type: "boolean",
      description:
        "false (default) = iterations chain in the SAME run carrying context. true = a fresh run per iteration (isolation).",
    },
    stop: {
      type: "object",
      description: "Safety caps. ALWAYS provide maxIterations for non-once loops.",
      properties: {
        maxIterations: { type: "number", description: "Hard iteration cap (default 20 for agent/continuous loops)." },
        budgetUsd: { type: "number", description: "Approx. USD spend cap across iterations." },
        untilTestsPass: { type: "boolean", description: "Stop once testCommand exits 0." },
        untilGitClean: { type: "boolean", description: "Stop once `git status --porcelain` is empty in the run cwd." },
        untilPhrase: { type: "string", description: "Stop when this case-insensitive substring appears in an iteration summary." },
        untilCommand: { type: "string", description: "Arbitrary shell; stop when it exits 0." },
        testCommand: { type: "string", description: "Command for untilTestsPass (default 'npm test')." },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const WORKER_SCHEMA = {
  type: "object",
  description:
    "Per-iteration worker (CLI agent) config. engine 'auto' lets the finishing agent pick the next engine/model via spark_request_next_iteration; 'claude'/'codex' pin it.",
  required: ["engine"],
  properties: {
    engine: { type: "string", enum: ["auto", "claude", "codex"] },
    model: {
      type: "string",
      description:
        "Engine-native model id (e.g. claude-opus-4-8, gpt-5.5). Omit for the CLI default. NOTE: 'claude-fable-5' (Fable 5, top-tier) is permitted ONLY when the user explicitly asked for it AND the Fable setting is enabled in Codara Studio settings; otherwise it is downgraded to claude-opus-4-8.",
    },
    effort: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
    timeoutMinutes: { type: "number", description: "Hard per-iteration wall-clock ceiling in minutes." },
  },
  additionalProperties: false,
};

const GUARD_PREDICATE_SCHEMA = {
  type: "object",
  description:
    "A guard's pass/fail test. phrase: substring in the upstream worker's output (optional source). tests: testCommand exits 0. gitClean: working tree clean. command: arbitrary shell exits 0. agentSignal: the upstream worker's spark_request_next_iteration signal matched `want`.",
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["phrase", "tests", "gitClean", "command", "agentSignal"] },
    phrase: { type: "string", description: "phrase only: substring to look for." },
    source: { type: "string", description: "phrase only: optional output source hint." },
    command: { type: "string", description: "tests/command: shell command (tests defaults to 'npm test')." },
    want: { type: "string", enum: ["continue", "done"], description: "agentSignal only: which signal counts as pass." },
  },
  additionalProperties: false,
};

const GRAPH_SCHEMA = {
  type: "object",
  description:
    "Optional node graph for multi-step looms. Omit for a simple single-worker loom (one node is synthesized from prompt_template + worker). Nodes: 'worker' runs a CLI agent on a prompt; 'guard' evaluates a predicate and routes pass/fail; 'merge' joins parallel branches. Edges connect nodes; branch 'pass'/'fail' selects a guard's outgoing path; backEdge:true + visitCap:N forms a bounded retry loop. Prompt template tokens: {{var}} (a named variable), {{node:id}} (a named node's last output), {{incoming}} (the merged output of all inbound edges).",
  required: ["version", "nodes", "edges", "entryNodeIds"],
  properties: {
    version: { type: "number", enum: [1] },
    nodes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "kind"],
        properties: {
          id: { type: "string", description: "Unique node id within the graph." },
          kind: { type: "string", enum: ["worker", "guard", "merge"] },
          label: { type: "string" },
          worker: WORKER_SCHEMA,
          prompt: { type: "string", description: "worker only: the prompt template for this node (supports {{var}}/{{node:id}}/{{incoming}})." },
          isolate: { type: "boolean", description: "worker only: run this node in a fresh run lineage." },
          predicate: GUARD_PREDICATE_SCHEMA,
          joinMode: { type: "string", enum: ["all", "any"], description: "merge only: wait for ALL inbound branches or ANY." },
        },
        additionalProperties: false,
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "from", "to"],
        properties: {
          id: { type: "string", description: "Unique edge id." },
          from: { type: "string", description: "Source node id (must exist in nodes)." },
          to: { type: "string", description: "Target node id (must exist in nodes)." },
          branch: { type: "string", enum: ["pass", "fail"], description: "For edges leaving a guard: which outcome this edge follows." },
          backEdge: { type: "boolean", description: "true = a retry/loop-back edge (must be paired with visitCap)." },
          visitCap: { type: "number", description: "Max times the backEdge may be traversed before giving up." },
        },
        additionalProperties: false,
      },
    },
    entryNodeIds: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description: "Node ids that start execution (must reference existing nodes).",
    },
  },
  additionalProperties: false,
};

const runIdProp = {
  runId: {
    type: "string",
    description: "Codara run id. Defaults to process.env.SPARK_RUN_ID (the chat this architect was spawned for) when omitted.",
  },
};

// Automation architect tool roster (Automation chat mode only).
const AUTOMATION_TOOLS = [
  {
    name: "spark_list_automations",
    description:
      "List all Cora automations (\"looms\"): id, name, enabled, a trigger/loop summary, worker config, node/edge counts, current state.status, lastRunAt, and the last 3 history records (status/stopReason/costUsd). Call this FIRST when the user asks about automations so you can reference what already exists.",
    inputSchema: { type: "object", properties: { ...runIdProp }, additionalProperties: false },
  },
  {
    name: "spark_get_automation",
    description:
      "Fetch one automation's full definition (trigger, loop, prompt, worker, graph, state, recent history) by id. Use before updating so you can patch only what changes.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string", description: "The automation id from spark_list_automations." } },
      additionalProperties: false,
    },
  },
  {
    name: "spark_create_automation",
    description:
      "Create a new automation bound to THIS chat's workspace (Codara resolves the workspace/cwd from the run — never supply paths). Provide name, trigger, loop, prompt_template, worker, and optionally a node graph. Returns the created automation id + summary. Recommended workflow: list existing automations, summarize your plan to the user in prose, THEN create.",
    inputSchema: {
      type: "object",
      required: ["name", "trigger", "loop", "prompt_template", "worker"],
      properties: {
        ...runIdProp,
        name: { type: "string", description: "Human-readable automation name." },
        trigger: TRIGGER_SCHEMA,
        loop: LOOP_SCHEMA,
        prompt_template: {
          type: "string",
          description: "The instruction each iteration's worker runs. Supports {{var}}/{{node:id}}/{{incoming}} tokens.",
        },
        worker: WORKER_SCHEMA,
        graph: GRAPH_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_update_automation",
    description:
      "Update an existing automation. Only the fields you pass are changed; omit the rest. Same field shapes as spark_create_automation.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: {
        ...runIdProp,
        automation_id: { type: "string" },
        name: { type: "string" },
        trigger: TRIGGER_SCHEMA,
        loop: LOOP_SCHEMA,
        prompt_template: { type: "string" },
        worker: WORKER_SCHEMA,
        graph: GRAPH_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_run_automation",
    description:
      "Run an automation immediately (a manual fire), independent of its trigger. Returns the created run id. Pair with spark_wait_for_automation to observe the result.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "spark_wait_for_automation",
    description:
      "Long-poll until an automation's current run/iteration reaches a terminal state (idle/stopped/blocked) or timeout_ms elapses. Returns final status, stopReason, iteration count, costUsd, and a snippet of the last iteration's summary. Use after spark_run_automation to report results to the user.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: {
        ...runIdProp,
        automation_id: { type: "string" },
        timeout_ms: {
          type: "number",
          description: "Max wait in ms. Default 600000 (10 min). Capped at 1140000 (19 min). On timeout returns the latest state with reason='timeout'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spark_set_automation_enabled",
    description: "Enable or disable an automation's trigger without deleting it.",
    inputSchema: {
      type: "object",
      required: ["automation_id", "enabled"],
      properties: { ...runIdProp, automation_id: { type: "string" }, enabled: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "spark_pause_automation",
    description: "Pause a running automation loop (it can be resumed later). The trigger may still be armed.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "spark_resume_automation",
    description: "Resume a paused automation loop.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "spark_stop_automation",
    description: "Stop an automation's current loop now (finalizes the live iteration). The automation remains and can be run again.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "spark_delete_automation",
    description:
      "Permanently delete an automation. DESTRUCTIVE: you MUST confirm with the user in conversation before calling this — never delete an automation the user did not explicitly ask to remove.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string" } },
      additionalProperties: false,
    },
  },
];

// spark_ask_user is shared between rosters (its definition lives in
// EXECUTE_TOOLS below); the automation roster appends it after that array is
// defined. See `const TOOLS = ...` near the dispatch table.
const EXECUTE_TOOLS = [
  {
    name: "spark_spawn_workers",
    description:
      "Delegate one or more focused tasks to Cora workers (claude/codex subagents). Each worker entry needs a title and description; runtime/model/effort hints and path scoping are optional. Returns worker_task_ids that can be queried via spark_get_worker_status. Call this whenever you want to fan work out instead of doing it yourself in the orchestrator turn.",
    inputSchema: {
      type: "object",
      required: ["workers"],
      properties: {
        runId: {
          type: "string",
          description:
            "Codara run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        workers: {
          type: "array",
          minItems: 1,
          description: "Worker tasks to queue. Each becomes its own Codara workerTask + initial attempt.",
          items: {
            type: "object",
            required: ["title", "description"],
            properties: {
              title: { type: "string", description: "Short worker title (shown in the Codara run UI)." },
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
            "Codara run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        question: {
          type: "string",
          description: "The question to surface in the Codara chat panel.",
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
      "Mark the Codara run as complete. Optionally include a short summary of what was accomplished — it is posted as a system note in the chat. Call this exactly once at the very end of the orchestrator turn after all work has settled.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description:
            "Codara run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
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
      "For Codara AUTOMATION LOOPS only: decide whether this loop should run another iteration after the current one finishes. Call this exactly once near the end of an automation turn. Set done=true to STOP the loop, or done=false (with an optional `prompt` for the next pass) to CONTINUE. You may optionally steer the NEXT pass's worker via nextEngine/nextModel/nextEffort — honored only when the automation's engine is set to Auto, and only for installed engines (invalid values are dropped with a warning, never an error). The user-defined safety caps (max iterations, budget) always still apply. If you never call this, the loop stops by default. (No effect on a normal, non-automation run.)",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description:
            "Codara run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
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
            "Codara run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
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
            "Codara run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
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

// spark_ask_user is shared by both rosters. Pull its canonical definition out
// of EXECUTE_TOOLS so the automation roster can reuse the exact same schema.
const ASK_USER_TOOL = EXECUTE_TOOLS.find((t) => t.name === "spark_ask_user");

// The live roster + RPC map are selected once, at startup, by SPARK_MCP_MODE.
const TOOLS = IS_AUTOMATION_MODE
  ? [...AUTOMATION_TOOLS, ...(ASK_USER_TOOL ? [ASK_USER_TOOL] : [])]
  : EXECUTE_TOOLS;

const AUTOMATION_TOOL_TO_RPC = {
  spark_list_automations: "automation.list",
  spark_get_automation: "automation.get",
  spark_create_automation: "automation.create",
  spark_update_automation: "automation.update",
  spark_run_automation: "automation.run_now",
  spark_wait_for_automation: "automation.wait",
  spark_set_automation_enabled: "automation.set_enabled",
  spark_pause_automation: "automation.pause",
  spark_resume_automation: "automation.resume",
  spark_stop_automation: "automation.stop",
  spark_delete_automation: "automation.delete",
  spark_ask_user: "orchestrator.ask_user",
};

const EXECUTE_TOOL_TO_RPC = {
  spark_spawn_workers: "orchestrator.spawn_workers",
  spark_ask_user: "orchestrator.ask_user",
  spark_complete: "orchestrator.complete",
  spark_request_next_iteration: "orchestrator.request_next_iteration",
  spark_get_worker_status: "orchestrator.get_worker_status",
  spark_wait_for_workers: "orchestrator.wait_for_workers",
};

const TOOL_TO_RPC = IS_AUTOMATION_MODE ? AUTOMATION_TOOL_TO_RPC : EXECUTE_TOOL_TO_RPC;

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
              const errMsg = parsed.error.message || "orchestrator op failed";
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
    // ask_user can block up to 15 min waiting on a human, so allow plenty of headroom.
    req.setTimeout(20 * 60_000, () => {
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
        serverInfo: { name: "cora-orchestrator", version: "0.1.0" },
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
