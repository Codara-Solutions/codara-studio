// Share as link, main-process side: signs and sends the page the renderer
// packaged after the user confirmed, and keeps this computer's list of shared
// pages. Electron-free (the caller passes the share directory and, in tests,
// a fetch), so the unit suite and the e2e harness can drive it directly.

import {
  SHARE_MAX_PAGE_BYTES,
  SHARE_MAX_TITLE_CHARS,
  SHARE_PAGE_ID_PATTERN,
  isShareExpiryDays,
  type ShareCreateInput,
  type SharedPage,
  type SharedPagesList,
  type ShareExpiryDays,
} from "../../shared/share";
import { loadOrCreateShareIdentity, type ShareIdentity } from "./identity";
import {
  createPageRequest,
  deletePageRequest,
  listPagesRequest,
  pageLink,
  parseRemotePage,
  parseRemotePageList,
  setExpiryRequest,
  shareBaseUrl,
  shareErrorMessage,
  type RemotePage,
  type ShareHttpRequest,
} from "./protocol";
import { readShareRecords, removeShareRecord, upsertShareRecord, writeShareRecords } from "./records";

const REQUEST_TIMEOUT_MS = 60_000;

export class ShareServiceError extends Error {}

export interface ShareServiceOptions {
  shareDir: string;
  fetchImpl?: typeof fetch;
  baseUrl?: () => string;
  log?: (line: string) => void;
}

export class ShareService {
  private identity: ShareIdentity | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: () => string;

  constructor(private readonly options: ShareServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? (() => shareBaseUrl());
  }

  async create(input: ShareCreateInput): Promise<SharedPage> {
    if (typeof input?.html !== "string" || input.html.length === 0) {
      throw new ShareServiceError("There is nothing to share.");
    }
    if (Buffer.byteLength(input.html, "utf8") > SHARE_MAX_PAGE_BYTES) {
      throw new ShareServiceError("This page is larger than 5 MB, the most a shared page can be.");
    }
    if (!isShareExpiryDays(input.ttlDays)) throw new ShareServiceError("Choose 7, 30 or 90 days.");
    const title = cleanTitle(input.title);
    const base = this.baseUrl();
    const response = await this.send(createPageRequest(base, this.signer(), input.html, input.ttlDays));
    const remote = parseRemotePage(await this.json(response, 201));
    if (!remote) throw new ShareServiceError("The share service sent an answer Studio does not understand.");
    const page: SharedPage = {
      id: remote.id,
      url: pageLink(base, remote.id),
      title,
      size: remote.size,
      createdAt: remote.createdAt,
      expiresAt: remote.expiresAt,
    };
    upsertShareRecord(this.options.shareDir, page);
    this.options.log?.(`share: created a page (${remote.size} bytes, ${input.ttlDays} days)`);
    return page;
  }

  // The service's list wins for which pages exist and when they expire. A page
  // it no longer has (expired, deleted elsewhere, taken down) drops out of the
  // local copy; one it has that this computer has no record of (a reinstall
  // with the same key) shows with a generic title.
  async list(): Promise<SharedPagesList> {
    const local = readShareRecords(this.options.shareDir);
    let base: string;
    let remote: RemotePage[] | null;
    try {
      base = this.baseUrl();
      const response = await this.send(listPagesRequest(base, this.signer()));
      remote = parseRemotePageList(await this.json(response, 200));
    } catch (err) {
      const now = Date.now();
      return {
        pages: local.filter((page) => page.expiresAt > now),
        offline: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!remote) {
      return { pages: local, offline: true, error: "The share service sent an answer Studio does not understand." };
    }
    const byId = new Map(local.map((page) => [page.id, page]));
    const pages: SharedPage[] = remote.map((entry) => ({
      id: entry.id,
      url: pageLink(base, entry.id),
      title: byId.get(entry.id)?.title ?? "Shared page",
      size: entry.size,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    }));
    writeShareRecords(this.options.shareDir, pages);
    return { pages, offline: false };
  }

  async delete(id: string): Promise<void> {
    assertId(id);
    const response = await this.send(deletePageRequest(this.baseUrl(), this.signer(), id));
    // Already gone on the service (expired, or deleted elsewhere): the user's
    // intent holds, so drop the local record too.
    if (response.status !== 204 && response.status !== 404) {
      await this.json(response, 204);
    }
    removeShareRecord(this.options.shareDir, id);
  }

  async setExpiry(id: string, ttlDays: ShareExpiryDays): Promise<SharedPage> {
    assertId(id);
    if (!isShareExpiryDays(ttlDays)) throw new ShareServiceError("Choose 7, 30 or 90 days.");
    const base = this.baseUrl();
    const response = await this.send(setExpiryRequest(base, this.signer(), id, ttlDays));
    if (response.status === 404) removeShareRecord(this.options.shareDir, id);
    const remote = parseRemotePage(await this.json(response, 200));
    if (!remote) throw new ShareServiceError("The share service sent an answer Studio does not understand.");
    const previous = readShareRecords(this.options.shareDir).find((page) => page.id === id);
    const page: SharedPage = {
      id,
      url: pageLink(base, id),
      title: previous?.title ?? "Shared page",
      size: remote.size,
      createdAt: remote.createdAt,
      expiresAt: remote.expiresAt,
    };
    upsertShareRecord(this.options.shareDir, page);
    return page;
  }

  /** The share key's public half, for diagnostics. Never the secret. */
  publicKey(): string {
    return this.signer().publicKeyB64;
  }

  private signer(): ShareIdentity {
    this.identity ??= loadOrCreateShareIdentity(this.options.shareDir);
    return this.identity;
  }

  private async send(request: ShareHttpRequest): Promise<Response> {
    try {
      return await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body ? { body: new Uint8Array(request.body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ShareServiceError("Could not reach the share service. Check your connection and try again.");
    }
  }

  private async json(response: Response, expected: number): Promise<unknown> {
    let body: unknown = null;
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    if (response.status !== expected) {
      const code =
        body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string"
          ? (body as { code: string }).code
          : undefined;
      throw new ShareServiceError(shareErrorMessage(response.status, code));
    }
    return body;
  }
}

function cleanTitle(raw: unknown): string {
  const title = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return (title || "Shared page").slice(0, SHARE_MAX_TITLE_CHARS);
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !SHARE_PAGE_ID_PATTERN.test(id)) {
    throw new ShareServiceError("Not a shared page id.");
  }
}
