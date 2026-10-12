// Dev servers Codara keeps for a workspace and the status view
// (resources/codara-studio-mcp/tools/servers.cjs). Methods outside preview.*
// default to scope "none"; a handler that acts on the caller's workspace sets
// scope: "browser" to have it resolved first.

import type { PreviewToolTable } from "./types";

export const serverTools: PreviewToolTable = {};
