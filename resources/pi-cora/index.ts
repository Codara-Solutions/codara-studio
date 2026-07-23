import { createRequire } from "node:module";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildCoraPiSystemPrompt,
  type CoraPiExecutionPolicy,
  type CoraPiMode,
} from "./prompt";

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

function activeMode(value = process.env.CODARA_PI_CHAT_MODE ?? process.env.SPARK_MCP_MODE): CoraPiMode {
  if (value === "auto" || value === "execute" || value === "automation") return value;
  return "talk";
}

function activeExecutionPolicy(
  value = process.env.CODARA_PI_EXECUTION_POLICY,
): CoraPiExecutionPolicy {
  if (value === "deep" || value === "frontier") return value;
  return "fast";
}

function bridgeErrorMessage(result: BridgeToolResult, fallback: string): string {
  const texts = (result.content ?? [])
    .map((block) => block.type === "text" && typeof block.text === "string" ? block.text.trim() : "")
    .filter(Boolean);
  return texts.join("\n") || fallback;
}

export default function codaraPiExtension(pi: ExtensionAPI) {
  const bridge = loadBridge();

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}

${buildCoraPiSystemPrompt(activeMode(), activeExecutionPolicy())}
`,
  }));

  for (const tool of bridge.listTools()) {
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
}
