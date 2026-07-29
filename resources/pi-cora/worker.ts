import { createRequire } from "node:module";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDeepSearch } from "./deep-search";
import { activeMcpBridgeConfig, registerMcpBridge, type McpBridgeHandle } from "./mcp-bridge";
import { createRepeatedCallGuard } from "./repeat-guard";
import { activePeerCommsContext, registerWorkerPeerComms } from "./worker-peer-comms";
import {
  fenceDecision,
  fencedToolNames,
  isAutomationWorker,
  isWorkerSafeBridgeTool,
} from "./worker-policy";

interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface BridgeToolResult {
  content?: Array<Record<string, unknown>>;
  details?: unknown;
  isError?: boolean;
}

interface CodaraBridge {
  listTools(): BridgeTool[];
  callToolByName(name: string, args: unknown): Promise<BridgeToolResult>;
}

const requireFromExtension = createRequire(import.meta.url);

function loadBridge(): CodaraBridge {
  const bridgePath = process.env.CODARA_PI_BRIDGE_PATH?.trim();
  if (!bridgePath) throw new Error("CODARA_PI_BRIDGE_PATH is required for Cora's Pi runtime");
  const loaded = requireFromExtension(bridgePath) as Partial<CodaraBridge>;
  if (typeof loaded.listTools !== "function" || typeof loaded.callToolByName !== "function") {
    throw new Error(`Codara Pi bridge is incompatible: ${bridgePath}`);
  }
  return loaded as CodaraBridge;
}

// Tool allowlist + automation access fence live in worker-policy.ts (pure,
// import-free) so they stay unit-testable outside Pi's jiti loader. See that
// module for the full rationale.

function bridgeErrorMessage(result: BridgeToolResult, fallback: string): string {
  const texts = (result.content ?? [])
    .map((block) => block.type === "text" && typeof block.text === "string" ? block.text.trim() : "")
    .filter(Boolean);
  return texts.join("\n") || fallback;
}

// Cora workers run the pinned Pi harness with provider subscription models
// underneath it. Keep the worker identity explicit: Anthropic's subscription
// route is launched with Claude Code's compatibility system prompt, then this
// extension supplies the actual Cora worker contract without pretending the
// worker is the user-facing manager.
export default function coraPiWorkerExtension(pi: ExtensionAPI) {
  const bridge = loadBridge();
  const peerComms = activePeerCommsContext();
  const fence = fencedToolNames();
  let mcp: McpBridgeHandle | null = null;

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}

You are a Cora engineering worker running inside Codara Studio's pinned Pi
harness. The user-facing Cora manager has delegated one bounded task to you.

Worker contract:
- Treat the task prompt as an exact outcome and path-access contract.
- Work directly in the supplied current directory using Pi's native read,
  search, edit, write, and shell tools. Do not merely explain what another
  agent should do and do not spawn a second coding agent.
- The codara_preview_* and codara_terminal_* tools drive Codara Studio's
  built-in preview and agent terminal tabs, the same surface the user
  watches. Use them to verify visible UI and long-running commands for real
  (navigate, snapshot, evaluate, console, network) instead of guessing.
- For web research, use the web_search tool rather than fetching pages with
  curl or driving the preview browser, and cite the sources it returns. If
  web_search fails or rate-limits, or the task needs page-level depth, use the
  bundled deep_search tool (free, no API key, DuckDuckGo backed with a Bing
  HTML fallback); for structured data, fetch public endpoints (RSS feeds,
  published APIs) directly instead of waiting for the limit to clear. If
  deep_search reports the backends are bot-challenging rather than empty, do
  not rephrase and retry it: switch to web_search or a named public feed.${peerComms ? `
- web_search quota is shared by the whole worker batch, not per worker. The
  moment web_search returns a 429 or a rate-limit error, peer_send a one-line
  heads-up to all (subject like "web_search 429") before anything else, so
  peers switch to feeds and deep_search instead of each burning their own
  attempts on the same limit. Honor the same heads-up from a peer.` : ""}
- Never open the user's system browser or GUI applications (no open,
  xdg-open, osascript, start). All web access goes through web_search,
  deep_search, or direct HTTP fetches.
- Never sleep longer than 60 seconds in one command. Long waits burn the wall
  clock the user is watching; retry sooner or switch data source instead.
- Preserve existing user changes and obey every allowedPaths, forbiddenPaths,
  access, and verification constraint in the task prompt.
- Inspect evidence before editing, run the requested verification, and inspect
  the final diff. Never weaken tests to manufacture success.
- Repeating one tool call with identical arguments and an identical result is a
  loop, not persistence. Cora warns you on the third such call and refuses the
  fifth, so change the arguments, change tool, or report the blocker instead.${peerComms ? `
- Peer workers on this step are teammates, not competitors: use peer_list,
  peer_send, peer_inbox, and peer_await to share findings early, claim a scope
  before editing shared territory, and ask before duplicating work. Cora, the
  orchestrator, oversees the batch and is the only one who ends a worker
  session, finish your task and write the final report; never idle waiting
  for peers.` : ""}
- The final-report.json path and schema in the task prompt are mandatory. Write
  that report before ending, even when blocked or failed. Cora accepts the work
  from the report, not from an optimistic prose claim.
- Keep prose concise while working; the live Workers surface already explains
  the lifecycle to the user.${fence.size > 0 ? `
- Some tools are disabled for this worker by its access policy. A blocked call
  returns an explanation instead of running; work within the remaining tools
  and record the limitation in your final report if it blocks the task.` : ""}
${mcp?.promptSuffix() ?? ""}`,
  }));

  // Tool-access fence: veto blocked tools (and out-of-workspace write/edit
  // targets) before they execute. Registered before the repeat guard so a
  // blocked call never counts as a loop.
  if (fence.size > 0) {
    pi.on("tool_call", (event) => fenceDecision(event.toolName, event.input, fence));
  }

  const automationWorker = isAutomationWorker();
  for (const tool of bridge.listTools()) {
    if (!isWorkerSafeBridgeTool(tool.name, automationWorker)) continue;
    // Fenced bridge tools (terminal/evaluate for any preset, mutating preview
    // tools for readonly) are not offered at all: the roster stays honest and
    // the tool_call veto below remains the belt if one is invoked anyway.
    if (fence.has(tool.name.toLowerCase())) continue;
    pi.registerTool({
      name: tool.name,
      label: tool.name.replace(/^codara_/, "Codara · ").replaceAll("_", " "),
      description: tool.description,
      promptSnippet: tool.description,
      parameters: tool.inputSchema as never,
      async execute(_toolCallId, params) {
        const result = await bridge.callToolByName(tool.name, params);
        // Pi's extension contract represents a failed tool by rejecting the
        // execute promise; an `isError` property on the returned result is not
        // consumed by Pi. Translate MCP failures explicitly so the model and
        // Cora's decision adapter cannot mistake a rejected mutation for one
        // that was applied live.
        if (result.isError === true) {
          throw new Error(bridgeErrorMessage(result, `${tool.name} failed`));
        }
        return {
          content: (result.content ?? [{ type: "text", text: "null" }]) as never,
          details: result.details,
        };
      },
    });
  }

  // Loop guard. `tool_call` fires before every tool (native and registered)
  // and is the only hook that can veto one, so the counter lives there and the
  // change-approach note rides back on the tool's own result, where the model
  // reads it immediately instead of a turn later.
  const repeatGuard = createRepeatedCallGuard();

  pi.on("tool_call", (event) => {
    const decision = repeatGuard.observeCall({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });
    if (decision.action === "block") return { block: true, reason: decision.message };
    return undefined;
  });

  pi.on("tool_result", (event) => {
    const outcome = repeatGuard.observeResult({
      toolCallId: event.toolCallId,
      content: event.content,
      isError: event.isError,
    });
    if (!outcome?.note) return undefined;
    return { content: [...event.content, { type: "text" as const, text: outcome.note }] };
  });

  registerDeepSearch(pi);

  if (peerComms) registerWorkerPeerComms(pi, peerComms);

  // Worker MCP scoping is decided by the launcher, which writes a roster
  // filtered to the servers the user assigned to Pi workers. isWorkerSafeBridgeTool
  // above stays about Codara's own in-process studio roster.
  const mcpConfig = activeMcpBridgeConfig();
  if (mcpConfig) {
    try {
      mcp = registerMcpBridge(pi, mcpConfig);
    } catch {
      mcp = null;
    }
  }
}
