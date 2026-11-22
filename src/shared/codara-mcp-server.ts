// Recognizes the process an agent CLI starts for Codara's tools: Codara's own
// MCP server, under its current and legacy folder names (the same names
// global-config-cleanup.ts looks for in CLI configs).

const MANAGED_SERVER_DIRS = "codara-studio-mcp|cora-preview-mcp|cora-orchestrator-mcp|spark-preview-mcp|spark-orchestrator-mcp";

// Inside a whole command line: the script path ends at a quote, whitespace or
// the end. macOS `ps` leaves paths with spaces unquoted, so the start of the
// path cannot be relied on, only the folder and file name.
const MANAGED_MCP_SERVER_IN_COMMAND = new RegExp(
  `(?:^|[\\\\/"'\\s])(?:${MANAGED_SERVER_DIRS})[\\\\/]server\\.js(?=["'\\s]|$)`,
  "i",
);

/** True when a process command line runs one of Codara's MCP server scripts. */
export function commandRunsCodaraMcpServer(command: string): boolean {
  return MANAGED_MCP_SERVER_IN_COMMAND.test(command);
}
