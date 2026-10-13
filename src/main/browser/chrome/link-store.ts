// The browsers the user paired, kept in Codara's own data folder
// (<codara home>/chrome-link/links.json), never in the browser's profile.
// Only a hash of each token is stored: the extension holds the token, and
// the hash is enough to recognise it.

import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ChromeBrowserInfo } from "./protocol";

export interface PairedBrowser {
  linkId: string;
  tokenSha256: string;
  extensionId: string;
  browser: ChromeBrowserInfo;
  pairedAt: string;
  lastSeenAt: string | null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class ChromeLinkStore {
  private links: PairedBrowser[] = [];

  /** `file` null keeps the pairings in memory only (tests). */
  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { links?: unknown };
      if (Array.isArray(parsed.links)) {
        this.links = parsed.links.filter(
          (link): link is PairedBrowser =>
            !!link && typeof link === "object" && typeof (link as PairedBrowser).linkId === "string" &&
            typeof (link as PairedBrowser).tokenSha256 === "string" && typeof (link as PairedBrowser).extensionId === "string",
        );
      }
    } catch {
      // No pairings yet, or an unreadable file: the user pairs again.
    }
  }

  list(): PairedBrowser[] {
    return this.links.map((link) => ({ ...link }));
  }

  /** The pairing this token belongs to, only from the extension it was issued to. */
  find(token: string, extensionId: string): PairedBrowser | null {
    const hash = Buffer.from(hashToken(token), "hex");
    for (const link of this.links) {
      const stored = Buffer.from(link.tokenSha256, "hex");
      if (stored.length === hash.length && timingSafeEqual(stored, hash) && link.extensionId === extensionId) return { ...link };
    }
    return null;
  }

  add(link: PairedBrowser): void {
    this.links = [...this.links.filter((entry) => entry.linkId !== link.linkId), link];
    this.persist();
  }

  remove(linkId: string): boolean {
    const before = this.links.length;
    this.links = this.links.filter((link) => link.linkId !== linkId);
    if (this.links.length === before) return false;
    this.persist();
    return true;
  }

  touch(linkId: string, at = new Date().toISOString()): void {
    const link = this.links.find((entry) => entry.linkId === linkId);
    if (!link) return;
    link.lastSeenAt = at;
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, links: this.links }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* best effort on filesystems without modes */
    }
  }
}
