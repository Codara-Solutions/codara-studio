import { createRequire } from "node:module";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeMcpBridgeConfig, registerMcpBridge, type McpBridgeHandle } from "./mcp-bridge";
import { activePeerCommsContext, registerWorkerPeerComms } from "./worker-peer-comms";

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

// The worker launch plan runs with SPARK_MCP_MODE=talk, so the bridge already
// exposes only the studio roster, but this allowlist, not the env-selected
// roster, is what keeps manager orchestration tools (spawn_workers, complete,
// message_workers, …) out of workers even if a future launch plan changes the
// mode. Whiteboard stays read-only for workers; edits are the manager's call.
function isWorkerSafeBridgeTool(name: string): boolean {
  return (
    name.startsWith("codara_preview_") ||
    name.startsWith("codara_terminal_") ||
    name === "codara_whiteboard_get"
  );
}

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
  curl or driving the preview browser, and cite the sources it returns.
- Preserve existing user changes and obey every allowedPaths, forbiddenPaths,
  access, and verification constraint in the task prompt.
- Inspect evidence before editing, run the requested verification, and inspect
  the final diff. Never weaken tests to manufacture success.${peerComms ? `
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
  the lifecycle to the user.
${mcp?.promptSuffix() ?? ""}`,
  }));

  for (const tool of bridge.listTools()) {
    if (!isWorkerSafeBridgeTool(tool.name)) continue;
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
