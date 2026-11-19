// Response bodies for Network.getResponseBody, kept from Firefox's
// webRequest.filterResponseData while a shared tab's network log is on.
// Measured on Firefox 160: the filter sees the body as the page gets it
// (gzip already decoded, binary as is, a cached load too); a redirect's own
// hop ends with "Channel redirected" and the next hop gets a new filter
// under the same request id; the body can end after onCompleted. Bounded:
// at most 10 MB per body and 50 MB in all, the oldest dropped first.
// No browser.* here, so the tests run it in Node.

export const BODY_MAX = 10 * 1024 * 1024;
export const BODIES_MAX = 50 * 1024 * 1024;
const TEXT_MIME = /^(text\/|application\/(json|[\w.+-]*\+json|javascript|ecmascript|xml|[\w.+-]*\+xml|x-www-form-urlencoded|graphql)|image\/svg\+xml)/i;

export const NO_BODY = "No resource with given identifier found";
export const BODY_FAILED = "No data found for resource with given identifier";
export const BODY_TOO_LARGE = "The response body is over 10 MB, more than the extension keeps.";
export const BODY_DROPPED = "The response body was dropped to keep the extension's memory bounded.";
export const BODY_LOADING = "The response body is still loading.";

function base64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** The body as the protocol gives it: text for text types (in their charset), base64 for the rest. */
export function bodyAnswer(bytes, contentType = "") {
  const [mime, ...options] = String(contentType).split(";");
  if (!TEXT_MIME.test(mime.trim())) return { body: base64(bytes), base64Encoded: true };
  const charset = options.map((option) => /^\s*charset=(.+)$/i.exec(option)?.[1]).find(Boolean)?.replace(/"/g, "") ?? "utf-8";
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return { body: decoder.decode(bytes), base64Encoded: false };
}

export class BodyStore {
  constructor({ perBody = BODY_MAX, total = BODIES_MAX } = {}) {
    this.perBody = perBody;
    this.total = total;
    this.hops = new Map();
    this.size = 0;
  }

  /** A request's hop starts (what an earlier hop kept is dropped); the hop is the handle for what follows. */
  start(requestId, tabId, url) {
    this.drop(requestId);
    const hop = { requestId, tabId, url, chunks: [], bytes: 0, contentType: "", ended: false, error: null, waiters: [] };
    this.hops.set(requestId, hop);
    return hop;
  }

  data(hop, chunk) {
    if (this.hops.get(hop.requestId) !== hop || hop.error) return;
    if (hop.bytes + chunk.length > this.perBody) {
      this.size -= hop.bytes;
      Object.assign(hop, { chunks: [], bytes: 0, error: BODY_TOO_LARGE });
      return;
    }
    hop.chunks.push(chunk.slice());
    hop.bytes += chunk.length;
    this.size += chunk.length;
    // The oldest go first, never the one being kept.
    for (const other of this.hops.values()) {
      if (this.size <= this.total) break;
      if (other !== hop) this.drop(other.requestId, BODY_DROPPED);
    }
  }

  type(requestId, contentType) {
    const hop = this.hops.get(requestId);
    if (hop && typeof contentType === "string") hop.contentType = contentType;
  }

  /** The hop's body ended, or failed (a redirect's own hop fails: the next hop starts its own). */
  end(hop, error = null) {
    if (this.hops.get(hop.requestId) !== hop || hop.ended) return;
    hop.ended = true;
    if (error && !hop.error) {
      this.size -= hop.bytes;
      Object.assign(hop, { chunks: [], bytes: 0, error: BODY_FAILED });
    }
    for (const wake of hop.waiters.splice(0)) wake();
  }

  drop(requestId, error = NO_BODY) {
    const hop = this.hops.get(requestId);
    if (!hop) return;
    this.hops.delete(requestId);
    this.size -= hop.bytes;
    Object.assign(hop, { chunks: [], bytes: 0, error: hop.error ?? error, ended: true });
    for (const wake of hop.waiters.splice(0)) wake();
  }

  forgetTab(tabId) {
    for (const hop of [...this.hops.values()]) if (hop.tabId === tabId) this.drop(hop.requestId);
  }

  /**
   * The body of a request of this tab, once it has ended (waiting up to
   * `waitMs`), with the address it came from; throws the protocol's errors.
   */
  async body(requestId, tabId, waitMs = 10_000) {
    const hop = this.hops.get(String(requestId));
    if (!hop || hop.tabId !== tabId) throw new Error(NO_BODY);
    if (!hop.ended) {
      let timer;
      const ended = await Promise.race([
        new Promise((resolve) => hop.waiters.push(() => resolve(true))),
        new Promise((resolve) => (timer = setTimeout(() => resolve(false), waitMs))),
      ]);
      clearTimeout(timer);
      if (!ended) throw new Error(BODY_LOADING);
    }
    if (hop.error) throw new Error(hop.error);
    const bytes = new Uint8Array(hop.bytes);
    let at = 0;
    for (const chunk of hop.chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return { url: hop.url, ...bodyAnswer(bytes, hop.contentType) };
  }
}
