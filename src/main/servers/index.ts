// Boot and IPC entry of the dev-server keeper and the status view. index.ts and ipc.ts call these once, so the
// work behind them never edits either shared file. The renderer side is
// window.spark.servers (src/preload/areas/servers.ts).

import { app } from "electron";

import type { DevServerSaveInput, DevServerStartInput } from "@shared/servers";
import type { IpcHandle } from "../ipc";
import {
  activeWorkspaceId,
  serverKeeper,
  startPaneLearner,
  statusRegistry,
  statusSnapshot,
  stopServerRuntime,
} from "./runtime";
import { provideServersService } from "./service";

provideServersService({ keeper: serverKeeper, status: statusRegistry, activeWorkspaceId });

// The renderer lists its panes only once its window has loaded.
const LEARNER_START_DELAY_MS = 5_000;

let started = false;

/** After the agent socket and the window exist. */
export function startServers(): void {
  if (started) return;
  started = true;
  setTimeout(startPaneLearner, LEARNER_START_DELAY_MS).unref?.();
  app.once("will-quit", stopServerRuntime);
}

function workspaceIdOf(input: unknown): string {
  const value = input && typeof input === "object" ? (input as { workspaceId?: unknown }).workspaceId : input;
  if (typeof value !== "string" || !value) throw new Error("workspaceId is required");
  return value;
}

function idOf(input: unknown): string {
  const value = input && typeof input === "object" ? (input as { id?: unknown }).id : undefined;
  if (typeof value !== "string" || !value) throw new Error("id is required");
  return value;
}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerServersIpc(handle: IpcHandle): void {
  handle("servers:status", (_event, workspaceId: unknown) =>
    statusSnapshot(typeof workspaceId === "string" && workspaceId ? workspaceId : null),
  );
  handle("servers:workspaceOpened", (_event, workspaceId: unknown) => serverKeeper().autoStart(workspaceIdOf(workspaceId)));
  handle("servers:start", (_event, input: DevServerStartInput) =>
    serverKeeper().start({ ...input, workspaceId: workspaceIdOf(input), source: "user", wait: false }),
  );
  handle("servers:stop", (_event, input: unknown) => serverKeeper().stop(workspaceIdOf(input), idOf(input)));
  handle("servers:restart", (_event, input: unknown) => serverKeeper().restart(workspaceIdOf(input), idOf(input), { wait: false }));
  handle("servers:logs", (_event, input: unknown) => {
    const since = input && typeof input === "object" ? (input as { since?: unknown }).since : undefined;
    return serverKeeper().logs(workspaceIdOf(input), idOf(input), typeof since === "number" ? since : undefined);
  });
  handle("servers:save", (_event, input: DevServerSaveInput) => serverKeeper().save({ ...input, workspaceId: workspaceIdOf(input) }));
  handle("servers:forget", (_event, input: unknown) => serverKeeper().forget(workspaceIdOf(input), idOf(input)));
}
