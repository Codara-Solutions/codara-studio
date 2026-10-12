// Boot and IPC entry of the Chrome extension link (the loopback server, the
// pairing prompt, the "chrome" browser backend). index.ts and ipc.ts call
// these once, so the work behind them never edits either shared file. The
// renderer side is window.spark.chromeLink (src/preload/areas/chrome-link.ts).

import type { IpcHandle } from "../../ipc";

/** After the agent socket and the window exist. */
export function startChromeLink(): void {}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerChromeLinkIpc(_handle: IpcHandle): void {}
