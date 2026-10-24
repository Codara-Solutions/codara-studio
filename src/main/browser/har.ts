// HAR 1.2 (http://www.softwareishard.com/blog/har-12-spec/) from recorded
// network rows. Timing phases follow the conversion Chromium's DevTools uses
// for its own HAR export, so a file opens the same in any HAR viewer.

import type { NetworkEntry } from "./recorders/network";

export const REDACTED = "[redacted]";

// Credentials a HAR shared in a pull request or pasted to a model must not
// carry unless the caller opts out.
const SECRET_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"]);

const HAR_BODY_CHARS = 1_000_000;
const HAR_BODIES_TOTAL_CHARS = 20_000_000;

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, SECRET_HEADERS.has(name.toLowerCase()) ? REDACTED : value]),
  );
}

export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
  send: number;
  wait: number;
  receive: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The HAR phases of a row; -1 marks a phase that did not happen (a reused connection has no dns or connect). */
export function harTimings(entry: NetworkEntry): HarTimings {
  const timing = entry.timing;
  const total = entry.startTime !== null && entry.endTime !== null ? Math.max(0, (entry.endTime - entry.startTime) * 1000) : 0;
  if (!timing) return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: round(total), receive: 0 };
  // Time between the request being issued and the network stack starting it.
  const queued = entry.startTime !== null ? Math.max(0, (timing.requestTime - entry.startTime) * 1000) : 0;
  const firstActivity = [timing.dnsStart, timing.connectStart, timing.sendStart].find((value) => value >= 0) ?? 0;
  const blocked = queued + Math.max(0, firstActivity);
  const span = (start: number, end: number) => (start >= 0 && end >= start ? end - start : -1);
  const dns = span(timing.dnsStart, timing.dnsEnd);
  const connect = span(timing.connectStart, timing.connectEnd);
  const ssl = span(timing.sslStart, timing.sslEnd);
  const send = Math.max(0, span(timing.sendStart, timing.sendEnd));
  const wait = Math.max(0, timing.receiveHeadersEnd - Math.max(0, timing.sendEnd));
  const endOffset = entry.endTime !== null ? (entry.endTime - timing.requestTime) * 1000 : timing.receiveHeadersEnd;
  const receive = Math.max(0, endOffset - timing.receiveHeadersEnd);
  return { blocked: round(blocked), dns: round(dns), connect: round(connect), ssl: round(ssl), send: round(send), wait: round(wait), receive: round(receive) };
}

function harTotal(timings: HarTimings): number {
  // ssl is already inside connect.
  const parts = [timings.blocked, timings.dns, timings.connect, timings.send, timings.wait, timings.receive];
  return round(parts.reduce((sum, value) => sum + (value > 0 ? value : 0), 0));
}

type HarPair = { name: string; value: string };

function pairs(headers: Record<string, string> | null): HarPair[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

function headerValue(headers: Record<string, string> | null, name: string): string | null {
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === name) return value;
  return null;
}

function queryString(url: string): HarPair[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function requestCookies(headers: Record<string, string>, redact: boolean): HarPair[] {
  const raw = headerValue(headers, "cookie");
  if (!raw) return [];
  return raw.split(/;\s*/).filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    const name = eq < 0 ? part : part.slice(0, eq);
    return { name, value: redact ? REDACTED : eq < 0 ? "" : part.slice(eq + 1) };
  });
}

function responseCookies(headers: Record<string, string> | null, redact: boolean): HarPair[] {
  const raw = headerValue(headers, "set-cookie");
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const first = line.split(";")[0];
    const eq = first.indexOf("=");
    const name = eq < 0 ? first : first.slice(0, eq);
    return { name: name.trim(), value: redact ? REDACTED : eq < 0 ? "" : first.slice(eq + 1) };
  });
}

function httpVersion(protocol: string | null): string {
  if (!protocol) return "";
  const lower = protocol.toLowerCase();
  if (lower === "h2") return "HTTP/2.0";
  if (lower === "h3" || lower.startsWith("http/3") || lower === "quic") return "HTTP/3";
  return lower.startsWith("http/") ? protocol.toUpperCase() : protocol;
}

export interface HarBody {
  text: string | null;
  base64: string | null;
  bytes: number;
}

export interface HarOptions {
  pageUrl: string | null;
  pageTitle: string | null;
  redact: boolean;
  /** Fetches a finished row's body; null leaves bodies out. */
  body: ((entry: NetworkEntry) => Promise<HarBody | null>) | null;
  creatorVersion?: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: Record<string, unknown>;
  response: Record<string, unknown> & { content: { size: number; mimeType: string; text?: string; encoding?: string; comment?: string } };
  cache: Record<string, never>;
  timings: HarTimings;
  pageref?: string;
  serverIPAddress?: string;
  _resourceType?: string;
  _initiator?: unknown;
  _error?: string;
}

export interface Har {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    pages: Array<Record<string, unknown>>;
    entries: HarEntry[];
  };
}

export async function buildHar(rows: NetworkEntry[], options: HarOptions): Promise<Har> {
  let bodyBudget = HAR_BODIES_TOTAL_CHARS;
  const entries: HarEntry[] = [];
  const pageref = "page_1";
  for (const row of rows) {
    const timings = harTimings(row);
    const requestHeaders = options.redact ? redactHeaders(row.requestHeaders) : row.requestHeaders;
    const responseHeaders = row.responseHeaders && options.redact ? redactHeaders(row.responseHeaders) : row.responseHeaders;
    const mimeType = row.mimeType ?? headerValue(row.responseHeaders, "content-type") ?? "x-unknown";
    const content: HarEntry["response"]["content"] = { size: row.encodedBytes ?? 0, mimeType };
    if (options.body && row.finished && !row.failed && !row.redirectedTo && bodyBudget > 0) {
      const body = await options.body(row).catch(() => null);
      if (body) {
        content.size = body.bytes;
        if (body.text !== null && body.text.length <= Math.min(HAR_BODY_CHARS, bodyBudget)) {
          content.text = body.text;
          bodyBudget -= body.text.length;
        } else if (body.text === null && body.base64 !== null && body.base64.length <= Math.min(HAR_BODY_CHARS, bodyBudget)) {
          content.text = body.base64;
          content.encoding = "base64";
          bodyBudget -= body.base64.length;
        } else {
          content.comment = "body left out: over the size cap";
        }
      }
    }
    const postMime = headerValue(row.requestHeaders, "content-type") ?? "application/octet-stream";
    const entry: HarEntry = {
      startedDateTime: row.at,
      time: harTotal(timings),
      request: {
        method: row.method ?? "GET",
        url: row.url,
        httpVersion: httpVersion(row.protocol),
        cookies: requestCookies(row.requestHeaders, options.redact),
        headers: pairs(requestHeaders),
        queryString: queryString(row.url),
        ...(row.postData !== null ? { postData: { mimeType: postMime, text: row.postData } } : {}),
        headersSize: -1,
        bodySize: row.postData !== null ? Buffer.byteLength(row.postData) : 0,
      },
      response: {
        status: row.status ?? 0,
        statusText: row.statusText ?? "",
        httpVersion: httpVersion(row.protocol),
        cookies: responseCookies(row.responseHeaders, options.redact),
        headers: pairs(responseHeaders),
        content,
        redirectURL: row.redirectedTo ?? headerValue(row.responseHeaders, "location") ?? "",
        headersSize: -1,
        bodySize: row.encodedBytes ?? -1,
      },
      cache: {},
      timings,
      pageref,
    };
    if (row.remoteAddress) entry.serverIPAddress = row.remoteAddress.replace(/^\[?([^\]]*?)\]?(:\d+)?$/, "$1");
    if (row.type) entry._resourceType = row.type.toLowerCase();
    if (row.initiator) entry._initiator = row.initiator;
    if (row.failed) entry._error = row.errorText ?? "failed";
    entries.push(entry);
  }
  const first = rows[0];
  return {
    log: {
      version: "1.2",
      creator: { name: "Codara Studio", version: options.creatorVersion ?? "1" },
      pages: [{
        startedDateTime: first?.at ?? new Date().toISOString(),
        id: pageref,
        title: options.pageTitle || options.pageUrl || "",
        pageTimings: {},
      }],
      entries,
    },
  };
}
