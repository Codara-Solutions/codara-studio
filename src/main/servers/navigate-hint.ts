// What a browser navigation to a local port that does not answer adds to its
// error: the workspace's saved server for that port and how to start it, so
// an agent that restarted (or a different agent) gets the same server back
// instead of guessing a command or starting a second copy.

import { loopbackPreviewTarget } from "../preview-navigation";
import { portOfUrl } from "./detect";
import { serversService } from "./service";

export async function savedServerHint(workspaceId: unknown, rawUrl: string): Promise<string> {
  const target = loopbackPreviewTarget(rawUrl);
  if (!target) return "";
  try {
    const service = serversService();
    const id = typeof workspaceId === "string" && workspaceId ? workspaceId : await service.activeWorkspaceId();
    if (!id) return "";
    const servers = await service.keeper().list(id, { probe: false });
    const server = servers.find((item) => (item.port ?? portOfUrl(item.url)) === target.port);
    if (!server) {
      return ` To keep a dev server running across agent restarts, start it with codara_terminal_servers (action "start", command) or \`cora server start --command "..."\`.`;
    }
    if (server.state === "running" || server.state === "pane") {
      return ` Server "${server.id}" of this workspace (${server.command}) is running but not answering yet; read its output with codara_terminal_servers action "logs", id "${server.id}".`;
    }
    return ` Server "${server.id}" of this workspace serves this port (${server.command}) and is ${server.state}: start it with codara_terminal_servers action "start", id "${server.id}" (or \`cora server start ${server.id}\`).`;
  } catch {
    return "";
  }
}
