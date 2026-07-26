// Bundled free web search for Cora's Pi harness.
//
// The primary research tool is the provider-native web_search extension, which
// rides the user's subscription OAuth. This module is the resilient no-key
// fallback and the page-depth option: it queries DuckDuckGo's public HTML
// endpoints (html.duckduckgo.com, then lite.duckduckgo.com) and, in deep mode,
// fetches the winning pages and returns readable-text digests. When both DDG
// endpoints come back empty or walled it falls through to one alternate no-key
// HTML backend (Bing). Everything is parsed with defensive regexes and string ops
// because Pi loads this file via jiti inside the bundled runtime, where bare
// npm specifiers do not resolve; Node >= 18 guarantees global fetch. A
// malformed SERP or a dead page degrades to fewer or snippet-only results,
// never to a thrown turn. A bot-challenge response is classified as such and
// reported distinctly from a genuinely empty SERP, because only one of the two
// is worth rephrasing the query for.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SerpResult {
  title: string;
  url: string;
  snippet: string;
}

export interface DeepSearchParams {
  query?: unknown;
  mode?: unknown;
  max_results?: unknown;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: { get?(name: string): string | null };
  body?: unknown;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    headers: Record<string, string>;
    redirect: "follow" | "manual";
    signal: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface DeepSearchOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

// A generic desktop UA: DDG's HTML endpoints serve the parseable markup to
// browsers and reject blank or bot-labeled agents far more often.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Worst case stays under the 45s budget: two sequential DuckDuckGo attempts,
// one shorter alternate-backend attempt, plus one concurrent page wave
// (12 + 12 + 8 + 10 = 42s).
const SERP_TIMEOUT_MS = 12_000;
const ALT_SERP_TIMEOUT_MS = 8_000;
const PAGE_TIMEOUT_MS = 10_000;
const PAGE_BODY_LIMIT_BYTES = 200 * 1024;
const PAGE_DIGEST_LIMIT_CHARS = 2_000;
const MAX_REDIRECT_HOPS = 4;
export const DEEP_SEARCH_DEFAULT_RESULTS = 5;
export const DEEP_SEARCH_MAX_RESULTS = 8;

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      // Upper bound matters: fromCodePoint THROWS past 0x10ffff, and this
      // decoder runs on arbitrary fetched HTML, so a malformed entity must
      // pass through untouched rather than take down the digest.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    })
    .replace(/&#(\d+);/g, (match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** DDG SERP links are redirect wrappers whose uddg parameter is the
 * URL-encoded target. Unwrap it; pass anything else through, upgrading
 * protocol-relative hrefs to https. */
export function decodeDuckDuckGoRedirect(href: string): string {
  const raw = decodeEntities(href).trim();
  if (!raw) return "";
  const wrapped = /[?&]uddg=([^&]+)/.exec(raw);
  if (wrapped) {
    try {
      return decodeURIComponent(wrapped[1]);
    } catch {
      // Fall through to the raw href.
    }
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

function isAdUrl(url: string): boolean {
  return url.includes("duckduckgo.com/y.js") || url.includes("ad_provider=") || url.includes("ad_domain=");
}

// html.duckduckgo.com marks titles with class result__a and snippets with
// result__snippet; lite.duckduckgo.com uses result-link and result-snippet
// with single-quoted attributes. Both are matched here. Titles and snippets
// are paired by document position because ad rows can break index pairing.
const TITLE_ANCHOR_PATTERN = /<a\b[^>]*class=["'][^"']*(?:result__a|result-link)[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
const SNIPPET_PATTERN = /<(a|td|div|span)\b[^>]*(?:result__snippet|result-snippet)[^>]*>([\s\S]*?)<\/\1>/gi;

export function parseDuckDuckGoSerp(html: string, maxResults: number): SerpResult[] {
  const snippets: Array<{ index: number; text: string }> = [];
  SNIPPET_PATTERN.lastIndex = 0;
  for (let match = SNIPPET_PATTERN.exec(html); match; match = SNIPPET_PATTERN.exec(html)) {
    snippets.push({ index: match.index, text: stripTags(match[2]) });
  }

  const results: SerpResult[] = [];
  const seen = new Set<string>();
  const anchors: Array<{ index: number; tag: string }> = [];
  TITLE_ANCHOR_PATTERN.lastIndex = 0;
  for (let match = TITLE_ANCHOR_PATTERN.exec(html); match; match = TITLE_ANCHOR_PATTERN.exec(html)) {
    anchors.push({ index: match.index, tag: match[0] });
  }

  for (let position = 0; position < anchors.length && results.length < maxResults; position++) {
    const anchor = anchors[position];
    const href = /href=["']([^"']*)["']/i.exec(anchor.tag)?.[1] ?? "";
    const url = decodeDuckDuckGoRedirect(href);
    if (!url || !/^https?:\/\//i.test(url) || isAdUrl(url) || seen.has(url)) continue;
    const title = stripTags(anchor.tag.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>\s*$/i, ""));
    if (!title) continue;
    const nextAnchorIndex = position + 1 < anchors.length ? anchors[position + 1].index : Infinity;
    const snippet = snippets.find(
      (candidate) => candidate.index > anchor.index && candidate.index < nextAnchorIndex,
    )?.text ?? "";
    seen.add(url);
    results.push({ title, url, snippet });
  }
  return results;
}

/** Bing sometimes wraps a result link in /ck/a?...&u=a1<base64url of the
 * target>. Unwrap that form; pass anything else through, upgrading
 * protocol-relative hrefs to https like the DDG decoder does. */
export function decodeBingRedirect(href: string): string {
  const raw = decodeEntities(href).trim();
  if (!raw) return "";
  const wrapped = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(raw);
  if (wrapped) {
    const decoded = decodeBase64Url(wrapped[1]);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

// Buffer under the bundled Node runtime, atob in any leaner host. Result URLs
// are ASCII (percent-encoded bytes stay ASCII), so atob's byte string is
// already the URL. A malformed payload degrades to "", never throws.
function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const host = globalThis as {
    Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } };
    atob?: (input: string) => string;
  };
  try {
    if (host.Buffer) return host.Buffer.from(padded, "base64").toString("utf8");
    if (host.atob) return host.atob(padded);
  } catch {
    // Fall through to the empty string; the caller keeps the raw href.
  }
  return "";
}

function isBingInternalUrl(url: string): boolean {
  return /^https?:\/\/(?:[a-z0-9-]+\.)*(?:bing\.com|microsofttranslator\.com|go\.microsoft\.com)\//i.test(url);
}

// Bing's no-JS HTML rows: <li class="b_algo"> holding the title in an
// <h2><a href> and the snippet in a <p>. Rows are sliced between consecutive
// b_algo openings rather than at the first </li>, because a row's own deep-link
// or attribution list nests <li> elements that would otherwise close the row
// before its <h2> and lose the whole result.
const BING_ROW_OPEN_PATTERN = /<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>/gi;
const BING_ROW_CLOSE_PATTERN = /<\/li\s*>/gi;
const BING_LIST_CLOSE_PATTERN = /<\/ol\s*>/i;
const BING_TITLE_PATTERN = /<h2\b[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;
const BING_SNIPPET_PATTERN = /<p\b[^>]*>([\s\S]*?)<\/p>/i;

/** Slice each b_algo row body: from the end of its opening tag to the last
 * </li> before the next row starts (or before the list closes), so nested
 * lists inside the row cannot truncate it. */
export function extractBingRows(html: string): string[] {
  const openings: Array<{ start: number; bodyStart: number }> = [];
  BING_ROW_OPEN_PATTERN.lastIndex = 0;
  for (let match = BING_ROW_OPEN_PATTERN.exec(html); match; match = BING_ROW_OPEN_PATTERN.exec(html)) {
    openings.push({ start: match.index, bodyStart: match.index + match[0].length });
  }
  return openings.map((opening, position) => {
    const limit = position + 1 < openings.length ? openings[position + 1].start : html.length;
    const segment = html.slice(opening.bodyStart, limit);
    const listClose = segment.search(BING_LIST_CLOSE_PATTERN);
    const bounded = listClose >= 0 ? segment.slice(0, listClose) : segment;
    let rowClose = -1;
    BING_ROW_CLOSE_PATTERN.lastIndex = 0;
    for (
      let match = BING_ROW_CLOSE_PATTERN.exec(bounded);
      match;
      match = BING_ROW_CLOSE_PATTERN.exec(bounded)
    ) {
      rowClose = match.index;
    }
    return rowClose >= 0 ? bounded.slice(0, rowClose) : bounded;
  });
}

export function parseBingSerp(html: string, maxResults: number): SerpResult[] {
  const results: SerpResult[] = [];
  const seen = new Set<string>();
  for (const row of extractBingRows(html)) {
    if (results.length >= maxResults) break;
    const titleMatch = BING_TITLE_PATTERN.exec(row);
    if (!titleMatch) continue;
    const url = decodeBingRedirect(titleMatch[1]);
    if (!url || !/^https?:\/\//i.test(url) || isBingInternalUrl(url) || seen.has(url)) continue;
    const title = stripTags(titleMatch[2]);
    if (!title) continue;
    const snippetMatch = BING_SNIPPET_PATTERN.exec(row);
    seen.add(url);
    results.push({ title, url, snippet: snippetMatch ? stripTags(snippetMatch[1]) : "" });
  }
  return results;
}

/** Why a zero-row response has zero rows. "challenge" means a bot wall was
 * served instead of a SERP, which no amount of rephrasing fixes; "empty" means
 * the backend answered and simply had nothing to list. */
export type SerpVerdict = "results" | "challenge" | "empty";

// Markers of a bot wall (DDG's anomaly page, a Cloudflare interstitial, a
// captcha). Consulted last, and only once zero rows parsed: a body that states
// it found nothing, or that still ships result-row markup, is treated as an
// answer even when the page chrome happens to load an anomaly or captcha
// script, so a genuine SERP is not misread as a wall.
const CHALLENGE_MARKERS = [
  "anomaly",
  "unusual traffic",
  "unusual activity",
  "automated queries",
  "are you a robot",
  "are you human",
  "verify you are human",
  "verifying you are human",
  "captcha",
  "challenge-platform",
  "cf-challenge",
  "just a moment",
  "enable javascript and cookies",
];

// The phrasings these backends use for a genuinely empty SERP. "no results"
// stays unqualified on purpose so the bare "No results." that lite.duckduckgo
// .com can emit counts too; a wall page announces a challenge, not a count.
const NO_RESULTS_MARKERS = ["no results", "no-results", "did not match any documents"];

// Result-row markup, not a bare mention: the class attribute has to be there,
// so a wall page that merely ships the SERP stylesheet does not read as a
// container.
export const DDG_CONTAINER_PATTERN =
  /class=["'][^"']*(?:result__a|result__snippet|results_links|result-link|result-snippet)/i;
export const BING_CONTAINER_PATTERN = /class=["'][^"']*\bb_algo\b|id=["']b_results["']/i;

/** A bot challenge and an empty SERP are byte-for-byte different but produce
 * the same zero rows, so the two must be told apart here rather than collapsed
 * into one useless "no parseable results" string. */
export function classifySerpBody(
  status: number,
  html: string,
  resultCount: number,
  containerPattern: RegExp,
): SerpVerdict {
  if (resultCount > 0) return "results";
  // DDG answers a challenged request with 202 and a wall page. fetch's `ok` is
  // true across the whole 2xx range, so 202 must be checked explicitly.
  if (status === 202) return "challenge";
  const probe = html.toLowerCase();
  // A page that states it found nothing answered the query, even when the page
  // bundle happens to reference anomaly or captcha scripts the way ordinary
  // SERP chrome does. Wall pages announce a challenge, never a result count.
  if (NO_RESULTS_MARKERS.some((marker) => probe.includes(marker))) return "empty";
  // Result-row markup with zero usable rows means every row was an ad or a
  // duplicate we filtered: an answer we could not use, not a wall. This has to
  // outrank the generic markers, or one ad row mentioning a captcha would turn
  // a real SERP into a challenge verdict.
  if (containerPattern.test(html)) return "empty";
  if (CHALLENGE_MARKERS.some((marker) => probe.includes(marker))) return "challenge";
  // No rows, no container, no statement: a wall or an interstitial, not a
  // search answer.
  return "challenge";
}

/** Best-effort readable text: drop non-content blocks, keep block boundaries
 * as newlines, strip the remaining tags, and collapse whitespace. */
export function extractReadableText(html: string): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol)\s*>/gi, "\n")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(withBreaks)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildPageDigest(text: string, limit: number = PAGE_DIGEST_LIMIT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[digest truncated at ${limit} characters]`;
}

export function normalizeMaxResults(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEEP_SEARCH_DEFAULT_RESULTS;
  return Math.max(1, Math.min(DEEP_SEARCH_MAX_RESULTS, Math.trunc(parsed)));
}

function withTimeout(ms: number, outer?: AbortSignal): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${Math.round(ms / 1000)}s`)),
    ms,
  );
  const onOuterAbort = () => controller.abort(outer?.reason ?? new Error("aborted"));
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    },
  };
}

async function readBodyCapped(response: FetchResponseLike, limitBytes: number): Promise<string> {
  const body = response.body as { getReader?(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | undefined;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return text.length > limitBytes ? text.slice(0, limitBytes) : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let bytes = 0;
  try {
    while (bytes < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out + decoder.decode();
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
}

interface SerpBackend {
  /** Short host label used in error strings. */
  label: string;
  /** Display name of whoever answered, used in the result header. */
  provider: string;
  endpoint: string;
  timeoutMs: number;
  parse(html: string, maxResults: number): SerpResult[];
  containerPattern: RegExp;
}

// DuckDuckGo first (both public endpoints), then one alternate no-key HTML
// backend so a DDG-wide bot wall is not the end of the fallback chain. Bing is
// the only one whose no-JS markup maps as cleanly as DDG's, and it is held to
// the same discipline: defensive regexes, redirect unwrapping, and the same
// challenge classification.
const SERP_BACKENDS: SerpBackend[] = [
  {
    label: "html.duckduckgo.com",
    provider: "DuckDuckGo",
    endpoint: "https://html.duckduckgo.com/html/?q=",
    timeoutMs: SERP_TIMEOUT_MS,
    parse: parseDuckDuckGoSerp,
    containerPattern: DDG_CONTAINER_PATTERN,
  },
  {
    label: "lite.duckduckgo.com",
    provider: "DuckDuckGo",
    endpoint: "https://lite.duckduckgo.com/lite/?q=",
    timeoutMs: SERP_TIMEOUT_MS,
    parse: parseDuckDuckGoSerp,
    containerPattern: DDG_CONTAINER_PATTERN,
  },
  {
    label: "bing.com",
    provider: "Bing",
    endpoint: "https://www.bing.com/search?q=",
    timeoutMs: ALT_SERP_TIMEOUT_MS,
    parse: parseBingSerp,
    containerPattern: BING_CONTAINER_PATTERN,
  },
];

interface SerpAnswer {
  results: SerpResult[];
  provider: string;
}

async function fetchSerp(
  query: string,
  maxResults: number,
  fetchImpl: FetchLike,
  outer?: AbortSignal,
): Promise<SerpAnswer> {
  const errors: string[] = [];
  // Counted, not a single sticky flag: one walled backend must not make the
  // terminal error claim the whole chain was walled when another backend
  // actually answered "zero results", which is the one case rephrasing helps.
  let walled = 0;
  let answeredEmpty = 0;
  for (const backend of SERP_BACKENDS) {
    const timeout = withTimeout(backend.timeoutMs, outer);
    try {
      const response = await fetchImpl(`${backend.endpoint}${encodeURIComponent(query)}`, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        redirect: "follow",
        signal: timeout.signal,
      });
      if (!response.ok) {
        // 403 and 429 from a free SERP endpoint are the same wall as a
        // challenge page, just expressed in the status line.
        if (response.status === 403 || response.status === 429) {
          walled += 1;
          errors.push(`${backend.label}: HTTP ${response.status} (blocked or rate limited)`);
        } else {
          errors.push(`${backend.label}: HTTP ${response.status}`);
        }
        continue;
      }
      const html = await readBodyCapped(response, PAGE_BODY_LIMIT_BYTES * 2);
      const results = backend.parse(html, maxResults);
      const verdict = classifySerpBody(response.status, html, results.length, backend.containerPattern);
      if (verdict === "results") return { results, provider: backend.provider };
      if (verdict === "challenge") {
        walled += 1;
        errors.push(`${backend.label}: bot challenge page (HTTP ${response.status}, no result rows)`);
      } else {
        answeredEmpty += 1;
        errors.push(`${backend.label}: zero results for this query`);
      }
    } catch (error) {
      errors.push(`${backend.label}: ${errorText(error)}`);
    } finally {
      timeout.release();
    }
  }
  if (walled > 0 && answeredEmpty === 0) {
    throw new Error(
      `Free web search is being bot-challenged, not merely empty, for "${query}". ${errors.join("; ")}. The public HTML endpoints served challenge pages instead of results, so retrying deep_search with different terms will not clear it: use the provider web_search tool, or fetch a known public endpoint directly (RSS or Atom feeds, published JSON APIs, documentation pages you can name).`,
    );
  }
  if (walled > 0) {
    // Mixed chain: some backends walled, at least one answered and had nothing.
    // Rephrasing can still help here, so say both things instead of pretending
    // the whole chain was walled.
    throw new Error(
      `Free web search returned nothing for "${query}". ${errors.join("; ")}. Some backends were walled (a challenge page or a blocking status) while others answered with zero results, so the query itself may be too narrow: one rephrase is worth trying, and if that also comes back empty use the provider web_search tool or fetch a known public endpoint directly (RSS or Atom feeds, published JSON APIs, documentation pages you can name).`,
    );
  }
  throw new Error(
    `Free web search failed for "${query}". ${errors.join("; ")}. Try again with different terms, use web_search, or fetch a known public endpoint directly.`,
  );
}

/** Fetch one result page, following redirects only within the page's own
 * origin, with the body capped. Throws on any failure; the caller degrades
 * that page to its search snippet. */
async function fetchPageText(
  url: string,
  fetchImpl: FetchLike,
  outer?: AbortSignal,
): Promise<string> {
  const origin = new URL(url).origin;
  const timeout = withTimeout(PAGE_TIMEOUT_MS, outer);
  try {
    let current = url;
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
      const response = await fetchImpl(current, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
        redirect: "manual",
        signal: timeout.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        if (!location) throw new Error(`HTTP ${response.status} redirect without a location`);
        const next = new URL(location, current);
        // Same origin, with one exception: the plain http-to-https upgrade on
        // the same host and port, the single most common redirect for older
        // indexed URLs. Anything else (other host, https-to-http downgrade)
        // stays refused.
        const startUrl = new URL(origin);
        const schemeUpgrade =
          startUrl.protocol === "http:" &&
          next.protocol === "https:" &&
          next.hostname === startUrl.hostname &&
          (next.port || "443") === (startUrl.port || "443");
        if (next.origin !== origin && !schemeUpgrade) {
          throw new Error(`redirect leaves ${origin} for ${next.origin}; not followed`);
        }
        current = next.toString();
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await readBodyCapped(response, PAGE_BODY_LIMIT_BYTES);
    }
    throw new Error(`more than ${MAX_REDIRECT_HOPS} redirects`);
  } finally {
    timeout.release();
  }
}

function renderResultHeader(index: number, result: SerpResult): string {
  return `${index + 1}. ${result.title}\n   ${result.url}`;
}

export async function executeDeepSearch(
  params: DeepSearchParams,
  options: DeepSearchOptions = {},
): Promise<string> {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) throw new Error("deep_search requires a non-empty query string.");
  const mode = params.mode === "deep" ? "deep" : "quick";
  const maxResults = normalizeMaxResults(params.max_results);
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);

  const { results, provider } = await fetchSerp(query, maxResults, fetchImpl, options.signal);
  const header = `${provider} ${mode} results for "${query}" (${results.length} result${results.length === 1 ? "" : "s"}, public endpoint):`;

  if (mode === "quick") {
    const blocks = results.map((result, index) =>
      `${renderResultHeader(index, result)}${result.snippet ? `\n   ${result.snippet}` : ""}`,
    );
    return [header, "", ...blocks].join("\n");
  }

  const digests = await Promise.all(results.map(async (result) => {
    try {
      const html = await fetchPageText(result.url, fetchImpl, options.signal);
      const text = extractReadableText(html);
      if (!text) throw new Error("page produced no readable text");
      return buildPageDigest(text);
    } catch (error) {
      const fallback = result.snippet ? `Search snippet: ${result.snippet}` : "No snippet available.";
      return `[page fetch failed: ${errorText(error)}]\n${fallback}`;
    }
  }));

  const blocks = results.map((result, index) => {
    const digest = digests[index].split("\n").map((line) => `   ${line}`).join("\n");
    return `${renderResultHeader(index, result)}\n${digest}`;
  });
  return [header, ...blocks].join("\n\n");
}

export const DEEP_SEARCH_DESCRIPTION =
  "Free web search over DuckDuckGo's public HTML endpoints, falling through to Bing's HTML endpoint when both come back empty or bot-walled. No API key and no subscription quota, but result quality is below the provider web_search tool, so prefer web_search first and use deep_search when web_search fails, rate limits, or the task needs page-level depth. mode \"quick\" returns the top results as title, url, and snippet. mode \"deep\" also fetches the top pages concurrently and returns a readable-text digest per page; a page that cannot be fetched degrades to its search snippet. If the error says the backends are bot-challenging, free scraping is walled for now: do not rephrase and retry, switch to web_search or fetch a public feed or API endpoint directly.";

export function registerDeepSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "deep_search",
    label: "Deep search",
    description: DEEP_SEARCH_DESCRIPTION,
    promptSnippet: "Free DuckDuckGo then Bing search fallback; deep mode digests the top pages",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query.",
        },
        mode: {
          type: "string",
          enum: ["quick", "deep"],
          description:
            "quick returns title, url, snippet per result; deep also fetches each result page and returns a readable-text digest. Defaults to quick.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: DEEP_SEARCH_MAX_RESULTS,
          description: `Maximum results (and pages fetched in deep mode). Defaults to ${DEEP_SEARCH_DEFAULT_RESULTS}, capped at ${DEEP_SEARCH_MAX_RESULTS}.`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params: DeepSearchParams, signal?: AbortSignal) {
      const text = await executeDeepSearch(params, { signal });
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
}
