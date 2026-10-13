// Boot and IPC entry of the dev-server keeper, the status view and the
// per-runtime launch arguments. index.ts and ipc.ts call these once, so the
// work behind them never edits either shared file. The renderer side is
// window.spark.servers (src/preload/areas/servers.ts).

import type { IpcHandle } from "../ipc";

/** After the agent socket and the window exist. */
export function startServers(): void {}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerServersIpc(_handle: IpcHandle): void {}
