// What codara_preview_network returns: a compact list of the recorded
// requests, one request in detail (headers, timings, initiator, body) and a
// HAR export. Rows come from recorders/network.ts; bodies are fetched from
// the page's buffers only when asked for.

import { compactText, writeBrowserArtifact } from "./artifacts";
import type { CdpSession } from "./cdp-session";
import { buildHar, harTimings, redactHeaders } from "./har";
import { POST_DATA_CAP, clearNetwork, findNetworkEntry, isFinalHop, networkRing, type NetworkEntry } from "./recorders/network";
import type { BrowserTarget } from "./targets";

export class NetworkParamsError extends Error {}

const LIST_URL_CHARS = 300;
const DETAIL_HEADER_CHARS = 500;
const BODY_CHARS = 4_000;
const UNFINISHED_BODY_WAIT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The list shows a request once its status arrives, but Chrome holds the body
 * back until loading finishes and answers a read before that with "No data
 * found"; an agent that reads a detail right after the click would see no
 * body. Waits for the end of the request, bounded for a stream that never ends.
 */
async function untilFinished(entry: NetworkEntry, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!entry.finished && !entry.failed && Date.now() < end) await new Promise((done) => setTimeout(done, 25));
}

export interface NetworkFilter {
  url: string | null;
  types: Set<string> | null;
  status: ((status: number | null) => boolean) | null;
  failedOnly: boolean;
}

/** Accepts 404, "404", "4xx", "400-499" and ">=400". */
export function parseStatusFilter(raw: unknown): ((status: number | null) => boolean) | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const text = String(raw).trim().toLowerCase();
  let match: RegExpExecArray | null;
  if ((match = /^(\d{3})$/.exec(text))) {
    const code = Number(match[1]);
    return (status) => status === code;
  }
  if ((match = /^([1-5])xx$/.exec(text))) {
    const floor = Number(match[1]) * 100;
    return (status) => status !== null && status >= floor && status < floor + 100;
  }
  if ((match = /^(\d{3})\s*-\s*(\d{3})$/.exec(text))) {
    const low = Number(match[1]);
    const high = Number(match[2]);
    return (status) => status !== null && status >= low && status <= high;
  }
  if ((match = /^(>=|>|<=|<)\s*(\d{3})$/.exec(text))) {
    const bound = Number(match[2]);
    const op = match[1];
    return (status) =>
      status !== null && (op === ">=" ? status >= bound : op === ">" ? status > bound : op === "<=" ? status <= bound : status < bound);
  }
  throw new NetworkParamsError(`status must be a code (404), a class (4xx), a range (400-499) or a bound (>=400), not ${JSON.stringify(raw)}.`);
}

export function parseNetworkFilter(params: Record<string, unknown>): NetworkFilter {
  const url = typeof params.filter === "string" && params.filter ? params.filter : null;
  const types = typeof params.type === "string" && params.type.trim()
    ? new Set(params.type.split(",").map((type) => type.trim().toLowerCase()).filter(Boolean))
    : null;
  return { url, types, status: parseStatusFilter(params.status), failedOnly: params.failed === true };
}

/** A network error, a blocked or canceled load, or an HTTP error status. */
export function isFailedRequest(entry: NetworkEntry): boolean {
  return entry.failed || (entry.status !== null && entry.status >= 400);
}

export function matchesNetworkFilter(entry: NetworkEntry, filter: NetworkFilter): boolean {
  if (filter.url && !entry.url.includes(filter.url)) return false;
  if (filter.types && !filter.types.has((entry.type ?? "other").toLowerCase())) return false;
  if (filter.status && !filter.status(entry.status)) return false;
  if (filter.failedOnly && !isFailedRequest(entry)) return false;
  return true;
}

function durationMs(entry: NetworkEntry): number | null {
  if (entry.startTime === null || entry.endTime === null) return null;
  return Math.max(0, Math.round((entry.endTime - entry.startTime) * 1000));
}

/** One list row: only the fields that have a value. */
export function networkRow(entry: NetworkEntry): Record<string, unknown> {
  const row: Record<string, unknown> = { id: entry.id, method: entry.method ?? "GET" };
  if (entry.status !== null) row.status = entry.status;
  if (entry.type) row.type = entry.type;
  row.url = entry.url.length > LIST_URL_CHARS ? `${entry.url.slice(0, LIST_URL_CHARS)}...` : entry.url;
  const ms = durationMs(entry);
  if (ms !== null) row.ms = ms;
  if (entry.encodedBytes !== null) row.bytes = entry.encodedBytes;
  if (entry.fromCache) row.cached = true;
  if (entry.failed) row.error = entry.errorText ?? "failed";
  else if (!entry.finished) row.pending = true;
  if (entry.redirectedTo) row.redirectedTo = entry.redirectedTo;
  return row;
}

function clampLimit(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 100;
  return Math.min(500, Math.max(1, value));
}

const TEXT_MIME = /^(text\/|application\/(json|[\w.+-]*\+json|javascript|ecmascript|xml|[\w.+-]*\+xml|x-www-form-urlencoded|graphql)|image\/svg\+xml)/i;

export function isTextMime(mimeType: string | null): boolean {
  return Boolean(mimeType && TEXT_MIME.test(mimeType));
}

export interface ResponseBody {
  /** Decoded text, or null for a binary body. */
  text: string | null;
  base64: string | null;
  bytes: number;
}

/** The response body from the page's buffers, decoded when it is text. */
export async function readResponseBody(session: CdpSession, entry: NetworkEntry): Promise<ResponseBody> {
  const result = await session.send<{ body?: string; base64Encoded?: boolean }>("Network.getResponseBody", { requestId: entry.requestId });
  const body = result?.body ?? "";
  if (!result?.base64Encoded) return { text: body, base64: null, bytes: Buffer.byteLength(body) };
  const buffer = Buffer.from(body, "base64");
  if (isTextMime(entry.mimeType)) return { text: buffer.toString("utf8"), base64: body, bytes: buffer.length };
  return { text: null, base64: body, bytes: buffer.length };
}

function extensionFor(mimeType: string | null): string {
  const subtype = (mimeType ?? "").split(";")[0].split("/")[1] ?? "";
  const clean = subtype.replace(/^x-/, "").replace(/\+.*$/, "").replace(/[^a-z0-9]/gi, "");
  if (clean === "jpeg") return "jpg";
  if (clean === "javascript") return "js";
  return clean.slice(0, 8) || "bin";
}

function capHeaderValues(headers: Record<string, string> | null): Record<string, string> | null {
  if (!headers) return null;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, value.length > DETAIL_HEADER_CHARS ? `${value.slice(0, DETAIL_HEADER_CHARS)}...` : value]),
  );
}

async function requestDetail(target: BrowserTarget, entry: NetworkEntry, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const redact = params.redact !== false;
  const label = `${entry.id}-${entry.url.replace(/^\w+:\/\//, "").slice(0, 40)}`;
  const detail: Record<string, unknown> = {
    ...networkRow(entry),
    url: entry.url,
    statusText: entry.statusText,
    mimeType: entry.mimeType,
    protocol: entry.protocol,
    remoteAddress: entry.remoteAddress,
    startedAt: entry.at,
    initiator: entry.initiator,
    timings: entry.timing ? harTimings(entry) : null,
    requestHeaders: capHeaderValues(redact ? redactHeaders(entry.requestHeaders) : entry.requestHeaders),
    responseHeaders: capHeaderValues(redact && entry.responseHeaders ? redactHeaders(entry.responseHeaders) : entry.responseHeaders),
  };
  if (entry.hasPostData) {
    let postData = entry.postData;
    if (postData === null || postData.length >= POST_DATA_CAP) {
      postData = await target.session
        .send<{ postData?: string }>("Network.getRequestPostData", { requestId: entry.requestId })
        .then((result) => result?.postData ?? postData)
        .catch(() => postData);
    }
    if (postData !== null) {
      const compact = await compactText(target.workspaceId, "network", `${label}-request`, postData, BODY_CHARS);
      detail.requestBody = compact.fullPath ? { text: compact.text, totalChars: compact.totalChars, path: compact.fullPath } : compact.text;
    }
  }
  if (params.body === false) return detail;
  if (entry.failed || entry.status === null || !isFinalHop(target.session, entry) || entry.redirectedTo) {
    detail.body = { unavailable: entry.failed ? "the request failed" : entry.status === null ? "no response yet" : "a redirect has no body" };
    return detail;
  }
  try {
    // A body still streaming (a page that never reads it, a long poll) may
    // never finish; the protocol waits for it, so the read is bounded.
    if (!entry.finished) await untilFinished(entry, UNFINISHED_BODY_WAIT_MS);
    const body = entry.finished
      ? await readResponseBody(target.session, entry)
      : await withTimeout(readResponseBody(target.session, entry), UNFINISHED_BODY_WAIT_MS, "the response has not finished");
    if (body.text !== null) {
      const compact = await compactText(target.workspaceId, "network", `${label}-response`, body.text, BODY_CHARS, extensionFor(entry.mimeType) === "json" ? "json" : "txt");
      detail.body = compact.fullPath ? { text: compact.text, totalChars: compact.totalChars, path: compact.fullPath } : compact.text;
    } else {
      const path = await writeBrowserArtifact(target.workspaceId, "network", {
        label: `${label}-response`,
        ext: extensionFor(entry.mimeType),
        data: Buffer.from(body.base64 ?? "", "base64"),
      });
      detail.body = { binary: entry.mimeType ?? "application/octet-stream", bytes: body.bytes, path };
    }
  } catch (error) {
    // The page dropped the body (evicted from its buffers, or a navigation cleared them).
    const message = error instanceof Error ? error.message : String(error);
    detail.body = {
      unavailable: /no (?:resource|data found for resource) with given identifier/i.test(message)
        ? "the page no longer holds this body: it navigated or reloaded since, or its buffer dropped it"
        : message,
    };
  }
  return detail;
}

async function exportHar(target: BrowserTarget, entries: NetworkEntry[], params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const info = await target.info().catch(() => null);
  const har = await buildHar(entries, {
    pageUrl: info?.url ?? null,
    pageTitle: info?.title ?? null,
    redact: params.redact !== false,
    body: params.body === false ? null : (entry) => (isFinalHop(target.session, entry) ? readResponseBody(target.session, entry) : Promise.resolve(null)),
  });
  const path = await writeBrowserArtifact(target.workspaceId, "network", {
    label: `${target.ref}-har`,
    ext: "har",
    data: JSON.stringify(har, null, 1),
  });
  return {
    ok: true,
    tabId: target.ref,
    har: path,
    entries: har.log.entries.length,
    bodies: har.log.entries.filter((entry) => typeof entry.response.content.text === "string").length,
    redacted: params.redact !== false,
  };
}

/** codara_preview_network: list, one request in detail, or a HAR export. */
export async function networkTool(target: BrowserTarget, rawParams: Record<string, unknown>): Promise<unknown> {
  // Cookie and authorization headers in the user's own browser carry live
  // sign-ins that page scripts cannot read, so they stay redacted there.
  const params = target.kind === "chrome" && rawParams.redact === false ? { ...rawParams, redact: true } : rawParams;
  const session = target.session;
  if (params.clear === true) {
    clearNetwork(session);
    return { ok: true, tabId: target.ref, cleared: true, requests: [] };
  }
  if ((typeof params.id === "string" && params.id) || (typeof params.id === "number" && Number.isFinite(params.id))) {
    const entry = findNetworkEntry(session, params.id);
    if (!entry) throw new NetworkParamsError(`No recorded request has id ${params.id}. List the tab's requests for current ids.`);
    return { ok: true, tabId: target.ref, request: await requestDetail(target, entry, params) };
  }
  const filter = parseNetworkFilter(params);
  const ring = networkRing(session);
  const matching = ring.toArray().filter((entry) => matchesNetworkFilter(entry, filter));
  if (params.har === true) return exportHar(target, matching, params);
  const limit = clampLimit(params.limit);
  const rows = matching.slice(-limit).map(networkRow);
  const result: Record<string, unknown> = { ok: true, tabId: target.ref, count: rows.length, matching: matching.length, total: ring.size };
  if (ring.dropped) result.dropped = ring.dropped;
  result.requests = rows;
  return result;
}
