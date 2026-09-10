import { createHash } from "node:crypto";
import type { RemoteAssetUpdate, RemoteMcpEditor, RemoteMcpTarget } from "./remote-access/rpc";
import { deleteAgentAsset, installAgentAssetToRuntime, listAgentAssets, listMcpWriteTargets, mcpServerRevision, readMcpServerDetail, saveMcpServer } from "./agent-sync";

type InventoryContext = Parameters<typeof listAgentAssets>[0];
export const REMOTE_BUILTIN_MCP_NAMES = new Set([
  "codara-studio", "spark-preview", "cora-preview", "spark-orchestrator", "cora-orchestrator",
]);

export function remoteCapabilityId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function findAsset(context: InventoryContext, id: string) {
  const inventory = listAgentAssets(context);
  const asset = [...inventory.mcp, ...inventory.skills].find((item) => remoteCapabilityId(item.id) === id);
  if (!asset || (asset.kind === "mcp" && REMOTE_BUILTIN_MCP_NAMES.has(asset.name))) {
    throw new Error("This capability is no longer available. Refresh the list.");
  }
  return asset;
}

export function readRemoteMcpEditor(context: InventoryContext, assetId?: string): RemoteMcpEditor {
  const targets: RemoteMcpTarget[] = listMcpWriteTargets(context).map(({ id, label, runtime, scope, format }) => ({
    id: remoteCapabilityId(id), label, runtime, scope, format,
  }));
  if (!assetId) return { targets };
  const asset = findAsset(context, assetId);
  if (asset.kind !== "mcp") throw new Error("Choose an MCP server to edit.");
  const detail = readMcpServerDetail({ id: asset.id });
  if (!detail) throw new Error("This server's configuration could not be read. Check it in Studio.");
  const { id, targetId, ...server } = detail;
  if (Buffer.byteLength(JSON.stringify(server), "utf8") > 64 * 1024) throw new Error("This configuration is too large to edit on the phone. Edit it in Studio.");
  const target = remoteCapabilityId(targetId);
  if (!targets.some((item) => item.id === target)) {
    targets.push({ id: target, label: "Current location", runtime: asset.runtime, scope: asset.scope,
      format: asset.runtime === "codex" || asset.runtime === "grok" ? "toml" : "json" });
  }
  return { targets, detail: { assetId: remoteCapabilityId(id), targetId: target, server, revision: mcpServerRevision(detail) } };
}

export async function updateRemoteAgentAsset(context: InventoryContext, input: Exclude<RemoteAssetUpdate, { action: "builtin" }>): Promise<string> {
  if (input.action === "saveMcp") {
    if (REMOTE_BUILTIN_MCP_NAMES.has(input.server.name.trim())) throw new Error("That name belongs to Codara's built-in server. Use the built-in controls instead.");
    const previous = input.replaceId ? findAsset(context, input.replaceId) : null;
    if (previous && previous.kind !== "mcp") throw new Error("Choose an MCP server to edit.");
    const detail = previous ? readMcpServerDetail({ id: previous.id }) : null;
    const target = listMcpWriteTargets(context).find((item) => remoteCapabilityId(item.id) === input.targetId);
    // A discovered server can keep its own configuration file even when that
    // file is not an offered destination for newly created entries.
    const targetId = target?.id ?? (detail && remoteCapabilityId(detail.targetId) === input.targetId ? detail.targetId : null);
    if (!targetId) throw new Error("This configuration location is no longer available. Reload the form.");
    const result = await saveMcpServer({ cwd: context.cwd, targetId, server: input.server,
      ...(previous ? { replaceId: previous.id, expectedRevision: input.revision } : {}) });
    if (!result.ok) throw new Error(result.error ?? "Could not save this server.");
    return `${result.name ?? input.server.name} was saved. Assign it to Cora or workers to use it in new sessions.`;
  }
  const asset = findAsset(context, input.assetId);
  if (input.action === "remove") {
    if (!asset.canDelete) throw new Error("This capability is managed by its plugin and cannot be removed here.");
    const result = await deleteAgentAsset({ id: asset.id });
    if (!result.ok) throw new Error(result.error ?? "Could not remove this capability.");
    return `${asset.name} was removed from ${asset.runtime} (${asset.scope === "user" ? "every workspace" : "this workspace"}).`;
  }
  if (!asset.syncable || (asset.kind === "skill" && input.runtime === "grok")) {
    throw new Error("This capability cannot be copied to that runtime.");
  }
  const result = await installAgentAssetToRuntime({ id: asset.id, target: input.runtime });
  if (!result.ok) throw new Error(result.error ?? "Could not install this capability.");
  return `${asset.name} was installed for ${input.runtime}. Changes apply to new sessions.`;
}

// Keep each encrypted reply small without hiding the rest of the inventory.
export function remoteCapabilityPage<T>(mcp: T[], skills: T[], offset = 0) {
  const end = offset + 200;
  return {
    mcp: mcp.slice(offset, end),
    skills: skills.slice(Math.max(0, offset - mcp.length), Math.max(0, end - mcp.length)),
    ...(end < mcp.length + skills.length ? { nextAssetOffset: end } : {}),
  };
}
