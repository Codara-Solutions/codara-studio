import type { ChatMode } from "@shared/types";

const MCP_PREFIX = "mcp__codara-studio__";

// Keep these aligned with resources/codara-studio-mcp/server.js. Claude's
// Agent SDK exposes MCP tools under fully-qualified names, but an existing
// transcript or prompt can still emit the server's bare tool name. Aliasing
// at the SDK boundary makes those calls restart-safe and avoids turning a
// harmless naming mismatch into a visible <tool_use_error> loop.
const STUDIO_TOOLS = [
  "codara_preview_list",
  "codara_preview_url",
  "codara_preview_navigate",
  "codara_preview_snapshot",
  "codara_preview_click",
  "codara_preview_type",
  "codara_preview_press_key",
  "codara_preview_evaluate",
  "codara_preview_wait_for",
  "codara_preview_screenshot",
  "codara_preview_mouse",
  "codara_preview_scroll",
  "codara_preview_hover",
  "codara_preview_drag",
  "codara_preview_key",
  "codara_preview_upload",
  "codara_preview_console",
  "codara_preview_network",
  "codara_preview_resize",
  "codara_preview_run",
  "codara_terminal_create",
  "codara_terminal_write",
  "codara_terminal_read",
] as const;

const EXECUTE_TOOLS = [
  "codara_spawn_terminals",
  "codara_spawn_workers",
  "codara_ask_user",
  "codara_complete",
  "codara_name_chat",
  "codara_remember",
  "codara_request_next_iteration",
  "codara_get_worker_status",
  "codara_wait_for_workers",
  "codara_message_workers",
  "codara_check_messages",
] as const;

const AUTOMATION_TOOLS = [
  "codara_list_automations",
  "codara_get_automation",
  "codara_create_automation",
  "codara_update_automation",
  "codara_run_automation",
  "codara_wait_for_automation",
  "codara_set_automation_enabled",
  "codara_pause_automation",
  "codara_resume_automation",
  "codara_stop_automation",
  "codara_delete_automation",
  "codara_name_chat",
  "codara_ask_user",
] as const;

export function buildClaudeMcpToolAliases(mode: ChatMode): Record<string, string> {
  const modeTools =
    mode === "automation"
      ? AUTOMATION_TOOLS
      : mode === "execute" || mode === "auto"
        ? EXECUTE_TOOLS
        : [];
  if (modeTools.length === 0) return {};
  return Object.fromEntries(
    [...STUDIO_TOOLS, ...modeTools].map((name) => [name, `${MCP_PREFIX}${name}`]),
  );
}
