// What the address pill understands, kept free of React so
// scripts/test-browser-pane.cjs bundles it as is.

import { localFilePath } from "@shared/local-file-address";
import type { DevServerStatus } from "@shared/servers";
import { pathToFileUrl } from "../../../lib/pathToFileUrl";

/** `home` expands a typed `~/...`; without it such a path is not understood. */
export function normalizeUrl(raw: string, home: string | null = null): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const local = localFilePath(trimmed, home);
  if (local) return pathToFileUrl(local);
  // A port alone opens the local server on it.
  const port = /^:?(\d{2,5})(\/.*)?$/.exec(trimmed);
  if (port && Number(port[1]) <= 65535) return `http://localhost:${port[1]}${port[2] ?? ""}`;
  if (/^localhost(:|\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:|\/|$)/.test(trimmed)) return `http://${trimmed}`;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/** Whether the browser can load `url` at all; anything else would load nothing. */
export function isLoadableUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function serverUrl(server: Pick<DevServerStatus, "url" | "port">): string | null {
  if (server.url) return server.url;
  return server.port ? `http://localhost:${server.port}` : null;
}

function portOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(parsed.hostname)) return null;
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return null;
  }
}

/** The running server whose port the URL is on, if any. */
export function serverForUrl<T extends Pick<DevServerStatus, "url" | "port">>(servers: readonly T[], url: string): T | null {
  const port = portOf(url);
  if (!port) return null;
  return servers.find((server) => {
    const target = serverUrl(server);
    return target ? portOf(target) === port : false;
  }) ?? null;
}
