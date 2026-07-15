#!/usr/bin/env node
// codara-studio MCP server (stdio, zero deps)
// ---------------------------------------------------------------
// The single built-in MCP server Codara Studio ships. It is spawned by
// Claude Code / Codex / any MCP-aware runtime as a child process, speaks
// MCP's stdio transport (newline-delimited JSON-RPC 2.0), and proxies tool
// calls to the running Codara app via its agent socket (loopback HTTP +
// bearer token). Codara's renderer/main make the calls real.
//
// One server, three rosters, selected ONCE at startup by SPARK_MCP_MODE:
//   - unset / "studio" (the GLOBAL user-scope entry): the preview tool set
//     (drive the live <preview> tab) + the terminal tool set (open and drive
//     agent-owned terminal tabs). This is what any claude/codex sub-agent,
//     worker, or verifier sees.
//   - "execute": the studio roster + the Execute worker-orchestration tools
//     (spawn/steer Cora workers, ask the user, complete the run). Written by
//     the Claude/Codex backends into a per-run config for the manager CLI.
//   - "automation": the studio roster + the automation-architect tools
//     (list/create/run/test looms) + codara_ask_user.
//
// Design rules:
//   - Zero npm deps. Pure Node stdlib. Bundled with Codara's extraResources.
//     Runs under any modern Node (>= 18).
//   - Late-binding: Codara may not be running yet when this script is spawned.
//     Read the handshake file on EVERY call and surface "Codara is not
//     running" cleanly.
//   - Read the handshake file every call so a Codara restart with a new token
//     doesn't permanently break the MCP server child.
//   - Auto-inject runId from process.env.SPARK_RUN_ID (and nodeId from
//     SPARK_NODE_ID) for orchestration tools so the manager prompt doesn't
//     have to know its own run id.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const HANDSHAKE_FILE = "agent-socket.json";
const DEFAULT_SPARK_HOME = path.join(os.homedir(), ".Codara");

// Roster gating. Chosen once, at startup. Anything other than "execute" /
// "automation" (unset, "studio", empty) means the global studio roster —
// preview + terminal only.
const SPARK_MCP_MODE = (process.env.SPARK_MCP_MODE || "").trim().toLowerCase();
const IS_EXECUTE_MODE = SPARK_MCP_MODE === "execute";
const IS_AUTOMATION_MODE = SPARK_MCP_MODE === "automation";

// Orchestration RPCs can block up to ~15 min (codara_ask_user waits on a human;
// codara_wait_for_workers / codara_wait_for_automation long-poll), so they get a
// 20-minute HTTP timeout. Preview + terminal ops are quick and get 60s.
const PREVIEW_TERMINAL_TIMEOUT_MS = 60_000;
const ORCHESTRATION_TIMEOUT_MS = 20 * 60_000;

// ===========================================================================
// Preview tool set (drive the live <preview> tab). Byte-for-byte the roster
// the old cora-preview server exposed.
// ===========================================================================
const PREVIEW_TOOLS = [
  {
    name: "codara_preview_list",
    description:
      "List the preview tabs currently open in Codara. Returns each tab's id, url, and whether it is the active one. Use this first to confirm a preview tab exists.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "codara_preview_url",
    description:
      "Return the current URL and title of a Codara preview tab. Defaults to the active preview tab when tabId is omitted.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string", description: "Optional tab id from codara_preview_list." } },
      additionalProperties: false,
    },
  },
  {
    name: "codara_preview_navigate",
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
    name: "codara_preview_snapshot",
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
    name: "codara_preview_click",
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
    name: "codara_preview_type",
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
    name: "codara_preview_press_key",
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
    name: "codara_preview_evaluate",
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
    name: "codara_preview_wait_for",
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
    name: "codara_preview_screenshot",
    description:
      "Capture the current preview tab as a PNG (returned base64-encoded in a data: URL). The pixels are exactly what the user sees in Codara.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "codara_preview_mouse",
    description:
      "Trusted mouse input at a CSS selector's center or explicit coordinates — indistinguishable from a real user's click (event.isTrusted=true), unlike codara_preview_click's synthetic DOM events. Actions: click, dblclick, rightclick, down, up. Coordinates are CSS pixels relative to the page viewport (top-left origin); if you measured a point on a codara_preview_screenshot, divide by the screenshot's scale (screenshot width ÷ viewport width) first.",
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
    name: "codara_preview_scroll",
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
    name: "codara_preview_hover",
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
    name: "codara_preview_drag",
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
    name: "codara_preview_key",
    description:
      "Trusted keyboard input to the focused element: named keys (Enter, Escape, Tab, Backspace, ArrowDown, …) or a single character, with optional modifiers. For typing whole strings into a field prefer codara_preview_type.",
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
    name: "codara_preview_upload",
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
    name: "codara_preview_console",
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
    name: "codara_preview_network",
    description:
      "Read the preview tab's captured network requests (url, method, status, mimeType, failures; ring buffer cap 500). Capture attaches on first call — issue one codara_preview_network before the interaction you want to observe, then again after. filter substring-matches the URL; clear=true resets.",
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
    name: "codara_preview_resize",
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
    name: "codara_preview_run",
    description:
      "Run an ordered BATCH of preview steps in ONE call (one MCP round-trip) instead of dozens of single click/press_key calls. Each step dispatches the exact same real input event as its individual tool, so fidelity is identical — you just stop paying a separate round-trip (and a separate agent turn) per keystroke. STRONGLY PREFER this for any multi-step verification flow: e.g. drive `7 / 2 =` and read the display as a single codara_preview_run, not seven calls. Stops at the first failing step unless continueOnError=true. Returns a per-step result array; any screenshot steps are also surfaced as image blocks.",
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
            "Ordered steps. Each is { action, ...args } where action is one of navigate|click|type|press_key|evaluate|wait_for|snapshot|screenshot and the remaining fields mirror the matching codara_preview_* tool — e.g. {action:'press_key', key:'7'}, {action:'click', selector:'#equals'}, {action:'evaluate', code:\"document.querySelector('#lcd').textContent\"}.",
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

const PREVIEW_TOOL_TO_RPC = {
  codara_preview_list: "preview.list",
  codara_preview_url: "preview.url",
  codara_preview_navigate: "preview.navigate",
  codara_preview_snapshot: "preview.snapshot",
  codara_preview_click: "preview.click",
  codara_preview_type: "preview.type",
  codara_preview_press_key: "preview.press_key",
  codara_preview_evaluate: "preview.evaluate",
  codara_preview_wait_for: "preview.wait_for",
  codara_preview_screenshot: "preview.screenshot",
  codara_preview_mouse: "preview.mouse",
  codara_preview_scroll: "preview.scroll",
  codara_preview_hover: "preview.hover",
  codara_preview_drag: "preview.drag",
  codara_preview_key: "preview.key",
  codara_preview_upload: "preview.upload",
  codara_preview_console: "preview.console",
  codara_preview_network: "preview.network",
  codara_preview_resize: "preview.resize",
};

// Step action -> RPC for the batched codara_preview_run tool. Mirrors the
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

// ===========================================================================
// Terminal tool set (open and drive agent-owned terminal tabs). New with the
// codara-studio merge; the socket RPCs live in agent-socket.ts.
// ===========================================================================
const TERMINAL_TOOLS = [
  {
    name: "codara_terminal_create",
    description:
      "Open a NEW agent-owned terminal tab in Codara Studio. The tab is visually tinted so the user can see an agent is driving it. Optionally pass a shell `command` to run immediately on open and a `title` for the tab. PASS AN EXPLICIT, VALID `cwd` whenever you have one: when omitted it defaults to the active workspace root, and if that path does not exist the terminal fails to spawn and later codara_terminal_write/read calls report an unknown pane. Returns { tabId, paneId, cwd } — the returned `cwd` is the directory actually used; keep the paneId to drive the terminal with codara_terminal_write and read its output with codara_terminal_read.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Working directory for the new terminal. Pass an absolute path that exists. Defaults to the active workspace root when omitted." },
        command: { type: "string", description: "Optional shell command to run immediately after the terminal opens." },
        title: { type: "string", description: "Optional tab title." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codara_terminal_write",
    description:
      "Write text to an agent-owned terminal pane (identified by the paneId returned from codara_terminal_create). By default the text is submitted as if the user pressed Enter; set submit=false to type without submitting (e.g. to build up a line or send a raw control sequence). Read the resulting output with codara_terminal_read. Ownership is enforced: you can only write to a paneId your OWN codara_terminal_create returned in this session — a paneId you discovered another way (e.g. a sibling worker's pane sampled via codara_terminal_read) is rejected, so call codara_terminal_create to get a pane you own rather than writing to someone else's.",
    inputSchema: {
      type: "object",
      required: ["paneId", "text"],
      properties: {
        paneId: { type: "string", description: "Pane id returned from codara_terminal_create." },
        text: { type: "string", description: "Text to write into the terminal." },
        submit: { type: "boolean", description: "Press Enter after writing (default true)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codara_terminal_read",
    description:
      "Read the recent visible output of a terminal pane (identified by paneId). Returns the tail of the pane's buffer with ANSI/VT control sequences stripped, so you can inspect command output. Use after codara_terminal_write to see what a command produced.",
    inputSchema: {
      type: "object",
      required: ["paneId"],
      properties: {
        paneId: { type: "string", description: "Pane id returned from codara_terminal_create." },
        lines: { type: "number", description: "How many trailing lines to return (default 100)." },
      },
      additionalProperties: false,
    },
  },
];

const TERMINAL_TOOL_TO_RPC = {
  codara_terminal_create: "terminal.create",
  codara_terminal_write: "terminal.write",
  codara_terminal_read: "terminal.read",
};

// ===========================================================================
// Automation-architect tool set (SPARK_MCP_MODE=automation only). Shared
// JSON-schema fragments kept verbose + LLM-friendly so the architect model can
// author triggers / loops / workers / graphs without guessing the shape.
// ===========================================================================
const TRIGGER_SCHEMA = {
  type: "object",
  description:
    "How the automation fires. Exactly one kind, each with its OWN required fields: " +
    "cron REQUIRES a valid `expr` (validated server-side). " +
    "interval REQUIRES a finite numeric `everyMs` >= 1000. " +
    "folder REQUIRES a `path` to watch. " +
    "onFinishOf REQUIRES an `automationId` that references an EXISTING automation (call codara_list_automations first). " +
    "manual only fires via codara_run_automation or the Hub. " +
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
    "How many times / how long the automation iterates per fire. once: a single pass. count: a fixed number (use stop.maxIterations). cadence: re-run every everyMs until a stop condition. until: loop until a stop condition holds. agent: the worker itself decides each pass via codara_request_next_iteration. continuous: loop with no natural end (rely on stop caps).",
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
    "Per-iteration worker (CLI agent) config. You MUST always set engine, model, AND effort explicitly — there is no 'auto' engine and no CLI-default model/effort; a worker missing any of the three is rejected.",
  required: ["engine", "model", "effort"],
  properties: {
    engine: { type: "string", enum: ["claude", "codex"], description: "Which CLI runs this worker — pick 'claude' or 'codex'." },
    model: {
      type: "string",
      description:
        "Engine-native model id (REQUIRED): 'claude-opus-4-8' or 'claude-sonnet-5' for claude; 'gpt-5.6-sol', 'gpt-5.6-terra', or 'gpt-5.6-luna' for codex. Use Sol for flagship/complex work, Terra for balanced everyday work, and Luna for fast repeatable work. NOTE: 'claude-fable-5' (Fable 5, premium top-tier) IS permitted as a worker model ONLY when the user's own message explicitly asked for Fable for this work; Codara honors an explicitly-requested fable hint. Otherwise it is downgraded to claude-opus-4-8.",
    },
    effort: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh", "max"], description: "Reasoning effort (REQUIRED)." },
    timeoutMinutes: { type: "number", description: "Hard per-iteration wall-clock ceiling in minutes." },
  },
  additionalProperties: false,
};

const GUARD_PREDICATE_SCHEMA = {
  type: "object",
  description:
    "A guard's pass/fail test. phrase: substring in the upstream worker's output (optional source). tests: testCommand exits 0. gitClean: working tree clean. command: arbitrary shell exits 0. agentSignal: the upstream worker's codara_request_next_iteration signal matched `want`.",
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
          access: { type: "string", enum: ["full", "edits", "readonly"], description: "worker only, optional (default full): tool-access preset. full = all tools; edits = file edits but no shell/web (codex: workspace-write sandbox). readonly = no edits to existing files, no shell/web (Claude can still create files via Write for its report). readonly is CLAUDE ONLY — rejected on codex workers, whose read-only sandbox cannot write the worker's final report; use edits for a fenced codex worker." },
          blockedTools: { type: "array", items: { type: "string" }, description: "worker only, CLAUDE ONLY: extra BARE tool names hard-denied on top of the access preset (e.g. [\"WebSearch\",\"Bash\"]). Parenthesized/scoped forms like \"Bash(rm *)\" are rejected — the claude CLI silently ignores them. Rejected entirely on codex workers (no per-tool deny)." },
          collab: { type: "object", additionalProperties: false, properties: { awareness: { type: "boolean" }, chat: { type: "boolean" } }, description: "worker only, optional: parallel-wave collaboration. awareness = list this node's same-wave peers in its prompt; chat = give peers a shared markdown board in the run folder. Only matter when 2+ workers run in one wave." },
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

const AUTOMATION_TOOLS = [
  {
    name: "codara_list_automations",
    description:
      "List all Cora automations (\"looms\"): id, name, enabled, a trigger/loop summary, worker config, node/edge counts, current state.status, lastRunAt, and the last 3 history records (status/stopReason/costUsd). Call this FIRST when the user asks about automations so you can reference what already exists.",
    inputSchema: { type: "object", properties: { ...runIdProp }, additionalProperties: false },
  },
  {
    name: "codara_get_automation",
    description:
      "Fetch one automation's full definition (trigger, loop, prompt, worker, graph, state, recent history) by id. Use before updating so you can patch only what changes.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string", description: "The automation id from codara_list_automations." } },
      additionalProperties: false,
    },
  },
  {
    name: "codara_create_automation",
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
    name: "codara_update_automation",
    description:
      "Update an existing automation. Only the fields you pass are changed; omit the rest. Same field shapes as codara_create_automation. " +
      "The user will be asked to APPROVE the edit in the chat before it is applied (enforced server-side) — so narrate the change you intend to make in prose, then call this tool ONCE; do NOT ask the user to confirm separately in text. " +
      "The result includes an `approved` flag: when `approved:false` the user declined and the automation was left UNCHANGED — do not retry, ask the user what they'd like instead.",
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
    name: "codara_run_automation",
    description:
      "Run an automation immediately (a manual fire), independent of its trigger. Returns the created run id. Pair with codara_wait_for_automation to observe the result.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "codara_wait_for_automation",
    description:
      "Long-poll until an automation's current run/iteration reaches a terminal state (idle/stopped/blocked) or timeout_ms elapses. Returns final status, stopReason, iteration count, costUsd, and a snippet of the last iteration's summary. Use after codara_run_automation to report results to the user.",
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
    name: "codara_set_automation_enabled",
    description:
      "Enable or disable an automation's trigger without deleting it. The user is asked to approve the toggle in the chat before it applies (same consent flow as update/delete) — call once and read the `approved` flag in the result.",
    inputSchema: {
      type: "object",
      required: ["automation_id", "enabled"],
      properties: { ...runIdProp, automation_id: { type: "string" }, enabled: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "codara_pause_automation",
    description: "Pause a running automation loop (it can be resumed later). The trigger may still be armed.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "codara_resume_automation",
    description: "Resume a paused automation loop.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "codara_stop_automation",
    description: "Stop an automation's current loop now (finalizes the live iteration). The automation remains and can be run again.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "codara_delete_automation",
    description:
      "Permanently delete an automation. DESTRUCTIVE. The user will be asked to APPROVE the deletion in the chat before it happens (enforced server-side) — so narrate which automation you're about to delete in prose, then call this tool ONCE; do NOT ask the user to confirm separately in text. " +
      "The result includes an `approved` flag: when `approved:false` the user declined and NOTHING was deleted — do not retry.",
    inputSchema: {
      type: "object",
      required: ["automation_id"],
      properties: { ...runIdProp, automation_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "codara_name_chat",
    description:
      "Give THIS architect chat a short, human-readable title describing what it is about (3-6 words, e.g. \"Nightly test-fix loom\" or \"Docs folder watcher\"). Call this EARLY — right after you understand what the user wants automated — and again if the topic shifts substantially. The title shows in the chat header and the session-history list so the user can tell their architect chats apart. Does not create or change any automation.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        ...runIdProp,
        title: {
          type: "string",
          description: "Short chat title (3-6 words). Must be non-empty; capped at ~60 characters server-side.",
        },
      },
      additionalProperties: false,
    },
  },
];

// ===========================================================================
// Execute worker-orchestration tool set (SPARK_MCP_MODE=execute). codara_ask_user
// lives here and is shared with the automation roster.
// ===========================================================================
const EXECUTE_TOOLS = [
  {
    name: "codara_spawn_terminals",
    description:
      "Open ONE persistent terminal tab for the user, split into one interactive pane per requested Claude Code or Codex session. Use this when the user explicitly asks to open/spawn terminals, sessions, or agents that THEY will drive. This is NOT worker orchestration: do not call codara_spawn_workers, codara_wait_for_workers, or codara_complete for the same request. Codara launches Claude with --dangerously-skip-permissions and Codex with --yolo. After this tool succeeds, end the turn; Codara applies the terminal decision and posts the confirmation.",
    inputSchema: {
      type: "object",
      required: ["terminals"],
      properties: {
        runId: {
          type: "string",
          description:
            "Codara run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        terminals: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          description:
            "Terminal groups. Example: [{runtime:'claude',count:2}] opens one tab with two Claude panes; [{runtime:'claude',count:1},{runtime:'codex',count:1}] opens one tab with one of each.",
          items: {
            type: "object",
            required: ["runtime", "count"],
            properties: {
              runtime: {
                type: "string",
                enum: ["claude", "codex"],
                description: "Agent CLI to launch in each pane.",
              },
              count: {
                type: "integer",
                minimum: 1,
                maximum: 8,
                description: "Number of panes with this exact configuration.",
              },
              model: {
                type: "string",
                description: "Optional engine-native model id. Omit to use the CLI default.",
              },
              effort: {
                type: "string",
                enum: ["low", "medium", "high", "xhigh", "max"],
                description: "Optional reasoning effort. Omit to use the CLI default.",
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
    name: "codara_spawn_workers",
    description:
      "Delegate one or more focused tasks to Cora workers (claude/codex subagents). Each worker entry needs a title and description; runtime/model/effort hints and path scoping are optional. Returns worker_task_ids that can be queried via codara_get_worker_status. Call this whenever you want to fan work out instead of doing it yourself in the orchestrator turn.",
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
    name: "codara_ask_user",
    description:
      "Ask the human user only for credentials/access, destructive or irreversible work, safety/policy, or irreducible product scope with no safe default. Reversible engineering choices must be decided autonomously. Include a concrete category and reason; provide up to 4 option objects with stable ids and one recommendation when choices are bounded.",
    inputSchema: {
      type: "object",
      required: ["question", "category", "reason"],
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
        category: {
          type: "string",
          enum: [
            "credentials_access",
            "destructive_irreversible",
            "safety_policy",
            "irreducible_product_scope",
          ],
          description:
            "Why this truly requires human judgment. Reversible engineering choices must not call this tool.",
        },
        reason: {
          type: "string",
          description:
            "Concrete rationale explaining why repository conventions and a reversible default are insufficient.",
        },
        recommendedOptionId: {
          type: "string",
          description:
            "Stable id of the safest recommended option when options are provided.",
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
    name: "codara_complete",
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
    name: "codara_name_chat",
    description:
      "Give THIS chat a short, human-readable title describing what it is about (3-6 words, e.g. \"Fix login redirect bug\" or \"Add CSV export\"). Call this EARLY — once the goal for the session is clear — and again if the topic shifts substantially. The title shows in the chat history so the user can tell their chats apart. Does not spawn workers or change any files.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        runId: {
          type: "string",
          description:
            "Codara run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        title: {
          type: "string",
          description: "Short chat title (3-6 words). Must be non-empty; capped at ~60 characters server-side.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codara_request_next_iteration",
    description:
      "For Codara AUTOMATION LOOPS only: decide whether this loop should run another iteration after the current one finishes. Call this exactly once near the end of an automation turn. Set done=true to STOP the loop, or done=false (with an optional `prompt` for the next pass) to CONTINUE. You may optionally steer the NEXT pass's worker via nextEngine/nextModel/nextEffort — honored for the next pass regardless of the loom's pinned engine, and only for installed engines (invalid values are dropped with a warning, never an error). The user-defined safety caps (max iterations, budget) always still apply. If you never call this, the loop stops by default. (No effect on a normal, non-automation run.)",
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
            "Optional: which CLI agent runs the NEXT iteration. Honored for the next pass regardless of the loom's pinned engine; ignored (with a warning) when the requested engine is not installed.",
        },
        nextModel: {
          type: "string",
          description:
            "Optional engine-native model id for the NEXT iteration (e.g. claude-opus-4-8, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna). Requires nextEngine; unknown ids fall back to the CLI default.",
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
    name: "codara_get_worker_status",
    description:
      "One-shot snapshot of a worker task's current status — use sparingly for ad-hoc spot checks. For waiting on completion, prefer codara_wait_for_workers, which long-polls and returns when workers reach a terminal state. Returns worker_task_id, task_status, the latest attempt's status / runtime / timestamps, and the final_report_path if the worker has finished.",
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
          description: "Worker task id returned from codara_spawn_workers.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codara_message_workers",
    description:
      "Send a message from you (the manager) into the running batch's shared mailbox — the same mailbox the workers use to coordinate with each other. Use it to steer a drifting worker mid-flight (before it finishes wrong), answer a question a worker sent you, or broadcast a contract clarification to the whole batch. Address one worker by its worker_task_id or use \"all\" to reach every worker in the batch. Workers see it the next time they check their inbox. The response carries a warning when the recipient likely will not read it (already terminal, or spawned solo without mailbox briefing) — do not assume such steering landed. This is worker coordination, NOT the human channel — use codara_ask_user to reach the user.",
    inputSchema: {
      type: "object",
      required: ["to", "body"],
      properties: {
        runId: {
          type: "string",
          description:
            "Codara run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
        to: {
          type: "string",
          description:
            "Recipient: a worker_task_id returned from codara_spawn_workers, or \"all\" to broadcast to every worker in the batch.",
        },
        subject: {
          type: "string",
          description: "Optional short subject/topic line.",
        },
        body: {
          type: "string",
          description: "Message body. Keep it tight and actionable — exact files, the correction, or the answer.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codara_check_messages",
    description:
      "Read messages workers have sent you (the manager) that you have not seen yet — questions when they are blocked, and milestone/progress notes — plus any batch-wide `all` broadcasts. Use it to poll for worker questions mid-flight without blocking; codara_wait_for_workers also returns these (as manager_messages) at each return. Returns { messages: [...] } and marks each returned message read so it is not surfaced again — this is the acknowledging read (codara_wait_for_workers only peeks).",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description:
            "Codara run id. Defaults to process.env.SPARK_RUN_ID (the run this orchestrator was spawned for) when omitted.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codara_wait_for_workers",
    description:
      "Block until the listed worker tasks reach a terminal state (accepted / failed / cancelled) or timeout_ms elapses. This is the canonical way to wait on workers — call it once after codara_spawn_workers and react to the results. Returns each worker's final task_status, attempt_status, finished_at, and final_report_path so you can read each report and decide whether to codara_complete (default) or codara_spawn_workers (only for genuine regressions/corrective fixes). Also returns manager_messages: unread questions/progress workers sent you, surfaced NON-destructively (they stay unread and re-appear on later waits until you acknowledge them with codara_check_messages) — answer or steer with codara_message_workers.",
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
          description: "Worker task ids returned from codara_spawn_workers.",
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

// codara_ask_user is shared by the Execute and Automation rosters. Pull its
// canonical definition out of EXECUTE_TOOLS so the automation roster can reuse
// the exact same schema.
const ASK_USER_TOOL = EXECUTE_TOOLS.find((t) => t.name === "codara_ask_user");

const EXECUTE_TOOL_TO_RPC = {
  codara_spawn_terminals: "orchestrator.spawn_terminals",
  codara_spawn_workers: "orchestrator.spawn_workers",
  codara_ask_user: "orchestrator.ask_user",
  codara_complete: "orchestrator.complete",
  codara_name_chat: "orchestrator.name_chat",
  codara_request_next_iteration: "orchestrator.request_next_iteration",
  codara_get_worker_status: "orchestrator.get_worker_status",
  codara_wait_for_workers: "orchestrator.wait_for_workers",
  codara_message_workers: "orchestrator.message_workers",
  codara_check_messages: "orchestrator.check_messages",
};

const AUTOMATION_TOOL_TO_RPC = {
  codara_list_automations: "automation.list",
  codara_get_automation: "automation.get",
  codara_create_automation: "automation.create",
  codara_update_automation: "automation.update",
  codara_run_automation: "automation.run_now",
  codara_wait_for_automation: "automation.wait",
  codara_set_automation_enabled: "automation.set_enabled",
  codara_pause_automation: "automation.pause",
  codara_resume_automation: "automation.resume",
  codara_stop_automation: "automation.stop",
  codara_delete_automation: "automation.delete",
  codara_name_chat: "automation.name_chat",
  codara_ask_user: "orchestrator.ask_user",
};

// ===========================================================================
// Roster + RPC-map selection. Done ONCE at startup by SPARK_MCP_MODE. The
// studio (preview + terminal) tools are always present; the mode only adds the
// orchestration layer on top.
// ===========================================================================
const STUDIO_TOOLS = [...PREVIEW_TOOLS, ...TERMINAL_TOOLS];
const STUDIO_TOOL_TO_RPC = { ...PREVIEW_TOOL_TO_RPC, ...TERMINAL_TOOL_TO_RPC };

let TOOLS;
let TOOL_TO_RPC;
if (IS_AUTOMATION_MODE) {
  TOOLS = [...STUDIO_TOOLS, ...AUTOMATION_TOOLS, ...(ASK_USER_TOOL ? [ASK_USER_TOOL] : [])];
  TOOL_TO_RPC = { ...STUDIO_TOOL_TO_RPC, ...AUTOMATION_TOOL_TO_RPC };
} else if (IS_EXECUTE_MODE) {
  // EXECUTE_TOOLS already contains codara_ask_user.
  TOOLS = [...STUDIO_TOOLS, ...EXECUTE_TOOLS];
  TOOL_TO_RPC = { ...STUDIO_TOOL_TO_RPC, ...EXECUTE_TOOL_TO_RPC };
} else {
  TOOLS = STUDIO_TOOLS;
  TOOL_TO_RPC = STUDIO_TOOL_TO_RPC;
}

// Orchestration RPCs (orchestrator.* / automation.*) get the long HTTP timeout
// and runId auto-injection; preview + terminal RPCs get the short timeout and
// no injection.
function isOrchestrationRpc(rpc) {
  return typeof rpc === "string" && (rpc.startsWith("orchestrator.") || rpc.startsWith("automation."));
}

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

function postJsonRpc(method, params, timeoutMs) {
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
              const errMsg = parsed.error.message || "agent socket op failed";
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
    req.setTimeout(timeoutMs || PREVIEW_TERMINAL_TIMEOUT_MS, () => {
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
        serverInfo: { name: "codara-studio", version: "0.1.0" },
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
  // The batched preview runner is handled locally (it fans out to many RPCs).
  if (name === "codara_preview_run") {
    const args = params && params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    return await callRunBatch(args);
  }
  const rpc = name ? TOOL_TO_RPC[name] : null;
  if (!rpc) throw mkErr(-32602, `unknown tool: ${name}`);
  const args = params && params.arguments && typeof params.arguments === "object" ? { ...params.arguments } : {};

  if (isOrchestrationRpc(rpc)) {
    // Auto-inject runId from the env var pty-manager injected when the CLI was
    // spawned for this run, so the orchestrator prompt doesn't have to know its
    // own run id. Caller-supplied runId always wins.
    if (typeof args.runId !== "string" || args.runId.trim().length === 0) {
      const envRunId = process.env.SPARK_RUN_ID;
      if (envRunId && envRunId.trim().length > 0) {
        args.runId = envRunId.trim();
      }
    }
    // Stamp the calling worker's loom node id (SPARK_NODE_ID, exported by
    // direct-worker's headless spawn) onto the continuation signal so the
    // pass-level "agent" loop can read ONLY the SINK node's decision in a
    // multi-node wave. Auto-injected for request_next_iteration only; harmless
    // (ignored) for single-node looms where the env var is absent. Caller-
    // supplied nodeId always wins.
    if (
      name === "codara_request_next_iteration" &&
      (typeof args.nodeId !== "string" || args.nodeId.trim().length === 0)
    ) {
      const envNodeId = process.env.SPARK_NODE_ID;
      if (envNodeId && envNodeId.trim().length > 0) {
        args.nodeId = envNodeId.trim();
      }
    }
  }

  const timeoutMs = isOrchestrationRpc(rpc) ? ORCHESTRATION_TIMEOUT_MS : PREVIEW_TERMINAL_TIMEOUT_MS;
  try {
    const result = await postJsonRpc(rpc, args, timeoutMs);
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
    return { isError: true, content: [{ type: "text", text: "codara_preview_run requires a non-empty 'steps' array." }] };
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
      const result = await postJsonRpc(rpc, rpcArgs, PREVIEW_TERMINAL_TIMEOUT_MS);
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
  // A screenshot result includes a data URL we surface as an image content block.
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
