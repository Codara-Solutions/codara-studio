// Dev servers Codara keeps for a workspace and the status view
// (resources/codara-studio-mcp/tools/servers.cjs). Methods outside preview.*
// default to scope "none"; a handler that acts on the caller's workspace sets
// scope: "browser" to have it resolved first.

import type { DevServerStatus } from "@shared/servers";
import { ServerConflictError, ServerInputError } from "../servers/keeper";
import { serversService } from "../servers/service";
import { PreviewToolParamsError, type PreviewToolHost, type PreviewToolTable } from "./types";

const ACTIONS = new Set(["list", "start", "stop", "restart", "logs", "save", "forget"]);

function text(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** What an agent needs per server, without the bookkeeping fields. */
function brief(server: DevServerStatus): Record<string, unknown> {
  return {
    id: server.id,
    state: server.state,
    health: server.health,
    url: server.url,
    port: server.port,
    command: server.command,
    cwd: server.cwd,
    ...(server.paneId ? { paneId: server.paneId } : {}),
    ...(server.autoStart ? { autoStart: true } : {}),
    ...(server.envNames.length ? { envNames: server.envNames } : {}),
    ...(server.missingEnv.length ? { missingEnv: server.missingEnv } : {}),
    ...(server.exitCode !== null ? { exitCode: server.exitCode } : {}),
  };
}

async function callerWorkspace(params: Record<string, unknown>): Promise<string> {
  const workspaceId = text(params, "workspaceId") ?? (await serversService().activeWorkspaceId());
  if (!workspaceId) throw new PreviewToolParamsError("No workspace is open in Codara.");
  return workspaceId;
}

function needId(params: Record<string, unknown>, action: string): string {
  const id = text(params, "id");
  if (!id) throw new PreviewToolParamsError(`${action} needs the id of a server; list shows them.`);
  return id;
}

async function runServers(params: Record<string, unknown>): Promise<unknown> {
  const action = text(params, "action") ?? "list";
  if (!ACTIONS.has(action)) throw new PreviewToolParamsError(`action must be one of ${[...ACTIONS].join(", ")}`);
  const workspaceId = await callerWorkspace(params);
  const keeper = serversService().keeper();
  try {
    switch (action) {
      case "list": {
        const servers = await keeper.list(workspaceId);
        return {
          servers: servers.map(brief),
          ...(servers.length ? {} : { hint: "No servers yet. start with a command remembers one; one started in a terminal pane is learned when its URL appears." }),
        };
      }
      case "start":
      case "restart": {
        const env = params.env && typeof params.env === "object" ? (params.env as Record<string, string>) : undefined;
        const result =
          action === "restart"
            ? await keeper.restart(workspaceId, needId(params, action), env ? { env } : {})
            : await keeper.start({
                workspaceId,
                id: text(params, "id"),
                command: text(params, "command"),
                cwd: text(params, "cwd"),
                port: params.port as number | undefined,
                url: text(params, "url"),
                env,
                autoStart: typeof params.autoStart === "boolean" ? params.autoStart : undefined,
                source: "agent",
              });
        return {
          ...brief(result.server),
          ready: result.ready,
          ...(result.alreadyRunning ? { alreadyRunning: true } : {}),
          ...(result.output ? { output: result.output } : {}),
          next: result.server.paneId
            ? `logs with id "${result.server.id}" (or codara_terminal_read paneId ${result.server.paneId}) shows its output`
            : undefined,
        };
      }
      case "stop": {
        const result = await keeper.stop(workspaceId, needId(params, action));
        return { ...brief(result.server), ...(result.alreadyStopped ? { alreadyStopped: true } : {}) };
      }
      case "logs": {
        const since = typeof params.since === "number" ? params.since : undefined;
        return keeper.logs(workspaceId, needId(params, action), since);
      }
      case "save":
        return brief(
          await keeper.save({
            workspaceId,
            id: needId(params, action),
            command: text(params, "command"),
            cwd: text(params, "cwd"),
            port: params.port === undefined ? undefined : (params.port as number | null),
            url: params.url === undefined ? undefined : (text(params, "url") ?? null),
            autoStart: typeof params.autoStart === "boolean" ? params.autoStart : undefined,
          }),
        );
      case "forget":
        return keeper.forget(workspaceId, needId(params, action));
    }
  } catch (error) {
    if (error instanceof ServerInputError || error instanceof ServerConflictError) {
      throw new PreviewToolParamsError(error.message);
    }
    throw error;
  }
  return null;
}

async function hello(params: Record<string, unknown>, _method: string, host: PreviewToolHost): Promise<unknown> {
  const runId = text(params, "runId") ?? null;
  const pid = typeof params.callerPid === "number" && Number.isSafeInteger(params.callerPid) ? params.callerPid : null;
  if (!runId) await host.scopeToCaller(params);
  serversService().status().noteHello({
    paneId: text(params, "callerPaneId") ?? null,
    workspaceId: text(params, "workspaceId") ?? null,
    runId,
    client: text(params, "client")?.slice(0, 40) ?? null,
    pid,
  });
  return { ok: true };
}

export const serverTools: PreviewToolTable = {
  "terminal.servers": { run: runServers, scope: "browser", trustedRunsOnly: true },
  "status.hello": { run: hello, scope: "none" },
};
