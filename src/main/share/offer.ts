// An agent's "offer to share this file" (the codara_share_offer MCP tool).
// The offer only puts the Share prompt in front of the user: Studio opens the
// file and shows what would be shared, and nothing leaves the computer unless
// the user clicks Share there. This module checks the request; agent-socket
// pushes the accepted path to the app window. Electron-free so the unit suite
// can drive it.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { SHARE_MAX_PAGE_BYTES, shareableKind } from "../../shared/share";

// One prompt per caller every few seconds: an agent in a loop must not be
// able to bury the user in Share prompts.
export const SHARE_OFFER_MIN_INTERVAL_MS = 10_000;
const MAX_TRACKED_CALLERS = 256;

export type ShareOfferCheck =
  | { ok: true; path: string }
  | { ok: false; reason: "invalid" | "not_shareable" | "missing" | "too_large" | "not_allowed" | "rate_limited"; message: string };

export interface ShareOfferDeps {
  /** The fs sandbox read gate. Throws when the renderer could not read this path. */
  assertReadable: (absolute: string) => Promise<void>;
  now?: () => number;
}

export class ShareOfferGate {
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly deps: ShareOfferDeps) {}

  async check(rawPath: unknown, callerKey: string): Promise<ShareOfferCheck> {
    if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 4096 || rawPath.includes("\0")) {
      return { ok: false, reason: "invalid", message: "path must be an absolute file path" };
    }
    if (!path.isAbsolute(rawPath) || /^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)) {
      return { ok: false, reason: "invalid", message: "path must be an absolute path on this computer" };
    }
    if (!shareableKind(rawPath)) {
      return { ok: false, reason: "not_shareable", message: "only .html and .md files can be shared as a link" };
    }
    let real: string;
    try {
      real = await fsp.realpath(rawPath);
      const stat = await fsp.stat(real);
      if (!stat.isFile()) return { ok: false, reason: "missing", message: "path is not a file" };
      if (stat.size > SHARE_MAX_PAGE_BYTES) {
        return { ok: false, reason: "too_large", message: "the file is larger than 5 MB, the most a shared page can be" };
      }
    } catch {
      return { ok: false, reason: "missing", message: "file not found" };
    }
    // The link target, not the link, decides the kind: a .md symlink to a key
    // file is not a page.
    if (!shareableKind(real)) {
      return { ok: false, reason: "not_shareable", message: "only .html and .md files can be shared as a link" };
    }
    try {
      await this.deps.assertReadable(real);
    } catch {
      return {
        ok: false,
        reason: "not_allowed",
        message: "Codara can only share files in a folder open in Codara. Ask the user to open that folder first.",
      };
    }
    const now = (this.deps.now ?? Date.now)();
    const last = this.lastAt.get(callerKey);
    if (last !== undefined && now - last < SHARE_OFFER_MIN_INTERVAL_MS) {
      return { ok: false, reason: "rate_limited", message: "a Share prompt was just shown; wait for the user" };
    }
    if (this.lastAt.size >= MAX_TRACKED_CALLERS) this.lastAt.clear();
    this.lastAt.set(callerKey, now);
    return { ok: true, path: real };
  }
}
