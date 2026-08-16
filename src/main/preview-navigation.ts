import { connect } from "node:net";

const LOOPBACK_RETRY_DELAYS_MS = [0, 80, 240, 500] as const;
const LOOPBACK_CONNECT_TIMEOUT_MS = 350;

export interface LoopbackPreviewTarget {
  host: string;
  port: number;
}

export function loopbackPreviewTarget(rawUrl: string): LoopbackPreviewTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
    return null;
  }
  const port = url.port
    ? Number.parseInt(url.port, 10)
    : url.protocol === "https:"
      ? 443
      : 80;
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535
    ? { host: hostname, port }
    : null;
}

function canConnect(target: LoopbackPreviewTarget): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host: target.host, port: target.port });
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(LOOPBACK_CONNECT_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.unref();
  });
}

/**
 * Prevent Electron from navigating a preview guest into a loopback port that
 * is not listening. Chromium prints every rejected webview load (and often a
 * GPU mailbox cascade) to the dev terminal before renderer code can catch it.
 * External/file/data URLs pass through; only local development servers are
 * probed, with a short startup grace period.
 */
/**
 * Is a local dev server actually listening behind this URL right now?
 *
 * Same probe as waitForLoopbackPreviewServer (including its short startup
 * grace period, so a server that printed its banner milliseconds ago still
 * passes), exposed for callers that must DECIDE rather than navigate — today
 * the auto-open-preview path, which would otherwise spawn a tab onto a dead
 * port whenever replayed terminal history mentions one. Non-loopback URLs are
 * unprobeable from here and are reported unreachable: this answers "is a local
 * server up", not "is this URL good".
 */
export async function isLoopbackPreviewServerUp(rawUrl: string): Promise<boolean> {
  if (!loopbackPreviewTarget(rawUrl)) return false;
  return waitForLoopbackPreviewServer(rawUrl);
}

export async function waitForLoopbackPreviewServer(rawUrl: string): Promise<boolean> {
  const target = loopbackPreviewTarget(rawUrl);
  if (!target) return true;
  for (const delayMs of LOOPBACK_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    if (await canConnect(target)) return true;
  }
  return false;
}
