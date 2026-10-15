// IPC entry of Share as link. ipc.ts calls registerShareIpc once; the renderer
// side is window.spark.share (src/preload/areas/share.ts). Every channel goes
// through the trusted-sender `handle`, so only the app window can upload,
// list, extend or delete. The renderer sends the finished page and gets back
// links and metadata; the share key never leaves main.
//
// While it builds the page, the renderer reads the page's local files and its
// CDN files through share:readAsset and share:fetchRemote, which apply the
// embedding rules main-side (real paths, the CDN allowlist, size and time
// caps). Neither sends anything of the user's anywhere.

import { join } from "node:path";
import { isShareExpiryDays, type ShareCreateInput, type ShareExpiryDays } from "../../shared/share";
import { codaraHome } from "../codara-home";
import { logMain } from "../file-log";
import { assertAllowedReadPathResolved } from "../fs-sandbox";
import type { IpcHandle } from "../ipc";
import { readShareAsset } from "./assets";
import { fetchShareRemote } from "./remote";
import type { ShareService } from "./service";

let service: ShareService | null = null;

export function shareDir(): string {
  return join(codaraHome(), "share");
}

// Deferred like Remote Access: the signing stack (sodium) loads the first
// time the user shares or opens Shared pages, not at app start.
async function shareService(): Promise<ShareService> {
  if (service) return service;
  const { ShareService } = await import("./service");
  service ??= new ShareService({
    shareDir: shareDir(),
    // Sizes and counts only: never a link, a page id or page content.
    log: (line) => logMain("share", line),
  });
  return service;
}

function expiryOf(value: unknown): ShareExpiryDays {
  if (!isShareExpiryDays(value)) throw new Error("Choose 7, 30 or 90 days.");
  return value;
}

function idOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("Not a shared page id.");
  return value;
}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerShareIpc(handle: IpcHandle): void {
  handle("share:create", async (_event, input: unknown) => {
    const raw = (input ?? {}) as Partial<ShareCreateInput>;
    return (await shareService()).create({
      html: typeof raw.html === "string" ? raw.html : "",
      title: typeof raw.title === "string" ? raw.title : "",
      ttlDays: expiryOf(raw.ttlDays),
    });
  });
  handle("share:list", async () => (await shareService()).list());
  handle("share:readAsset", (_event, request: unknown) =>
    readShareAsset(request, { assertReadable: assertAllowedReadPathResolved }),
  );
  handle("share:fetchRemote", (_event, request: unknown) => fetchShareRemote(request));
  handle("share:delete", async (_event, id: unknown) => (await shareService()).delete(idOf(id)));
  handle("share:setExpiry", async (_event, input: unknown) => {
    const raw = (input ?? {}) as { id?: unknown; ttlDays?: unknown };
    return (await shareService()).setExpiry(idOf(raw.id), expiryOf(raw.ttlDays));
  });
}
