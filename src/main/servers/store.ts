// The remembered dev servers of each workspace, in Codara's own data folder
// (<codara home>/workspace-data/<workspace>/servers/servers.json), never in
// the user's repository. Holds commands, ports, URLs and env NAMES only.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { DevServerSpec } from "@shared/servers";
import { writeFileAtomic } from "../fs-atomic";
import { workspaceDataDir } from "../workspace-data";
import { checkEnvNames, SERVER_ID_RE } from "./detect";

const MAX_SERVERS_PER_WORKSPACE = 50;

export function serversFile(workspaceId: string): string {
  return workspaceDataDir(workspaceId, "servers", "servers.json");
}

function cleanSpec(raw: unknown): DevServerSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !SERVER_ID_RE.test(value.id)) return null;
  if (typeof value.command !== "string" || !value.command.trim()) return null;
  if (typeof value.cwd !== "string" || !value.cwd) return null;
  const port = typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port < 65_536 ? value.port : null;
  return {
    id: value.id,
    command: value.command,
    cwd: value.cwd,
    port,
    url: typeof value.url === "string" && value.url ? value.url : null,
    envNames: checkEnvNames(value.envNames),
    autoStart: value.autoStart === true,
    source: value.source === "user" ? "user" : "agent",
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

export interface ServerStore {
  list(workspaceId: string): Promise<DevServerSpec[]>;
  /** Replaces the workspace's list through `change`, one writer at a time per workspace. */
  update<T>(workspaceId: string, change: (servers: DevServerSpec[]) => T | Promise<T>): Promise<T>;
}

export function createServerStore(): ServerStore {
  const cache = new Map<string, DevServerSpec[]>();
  const queues = new Map<string, Promise<unknown>>();

  async function read(workspaceId: string): Promise<DevServerSpec[]> {
    const cached = cache.get(workspaceId);
    if (cached) return cached;
    let servers: DevServerSpec[] = [];
    try {
      const parsed = JSON.parse(await fs.readFile(serversFile(workspaceId), "utf8")) as { servers?: unknown };
      servers = (Array.isArray(parsed.servers) ? parsed.servers : [])
        .map(cleanSpec)
        .filter((spec): spec is DevServerSpec => spec !== null);
    } catch {
      servers = [];
    }
    cache.set(workspaceId, servers);
    return servers;
  }

  return {
    async list(workspaceId) {
      await queues.get(workspaceId)?.catch(() => undefined);
      return (await read(workspaceId)).map((spec) => ({ ...spec, envNames: [...spec.envNames] }));
    },
    update(workspaceId, change) {
      const previous = queues.get(workspaceId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          const current = (await read(workspaceId)).map((spec) => ({ ...spec, envNames: [...spec.envNames] }));
          const result = await change(current);
          const kept = current.slice(-MAX_SERVERS_PER_WORKSPACE);
          const file = serversFile(workspaceId);
          await fs.mkdir(dirname(file), { recursive: true });
          await writeFileAtomic(file, `${JSON.stringify({ version: 1, servers: kept }, null, 2)}\n`);
          cache.set(workspaceId, kept);
          return result;
        });
      queues.set(workspaceId, next);
      return next;
    },
  };
}
