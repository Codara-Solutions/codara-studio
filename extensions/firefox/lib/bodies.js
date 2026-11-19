// Response bodies for Network.getResponseBody, kept from Firefox's
// webRequest.filterResponseData while Codara records a shared tab's
// network log. Measured on Firefox 160 and ESR 153: the filter can be set
// once the response headers are in, sees the body as the page gets it
// (gzip already decoded); a body can end after onCompleted.
//
// The filter cannot pass on a transfer that breaks mid-body: its end fires
// whatever the status and closing it reports success, so the page can see
// a cut response end cleanly (measured: a fetch read 400 of 800 bytes as
// "ok"; Firefox reported NS_ERROR_NET_PARTIAL_TRANSFER). That window is
// kept small: only text responses an agent reads (no media, fonts, images
// or downloads), at most 5 MB each (Codara's cap for Chrome); past it the
// filter lets go (disconnect) and Firefox carries the rest itself, a
// failure included (measured: the page got its usual error). A body is
// given to Codara only once its row reached Codara and Firefox reported
// the request completed: never a cut body as a whole one.
// No browser.* here, so the tests run it in Node.

export const BODY_MAX = 5_000_000;
export const BODIES_MAX = 20_000_000;
export const HOPS_MAX = 1000;
const TEXT_MIME = /^(text\/|application\/(json|[\w.+-]*\+json|javascript|ecmascript|xml|[\w.+-]*\+xml|x-www-form-urlencoded|graphql))/i;
/** The request types whose bodies are kept, if their response is text (and not a download). */
export const BODY_TYPES = Object.freeze(["main_frame", "sub_frame", "xmlhttprequest", "script", "stylesheet", "other"]);

export const NO_BODY = "No resource with given identifier found";
export const BODY_FAILED = "Body not available: the transfer failed.";
export const BODY_TOO_LARGE = "Body not available: it is over 5 MB, more than the extension keeps.";
export const BODY_NOT_TEXT = "Body not available: in Firefox the extension keeps the bodies of text responses only (pages, fetches, scripts, style sheets), not media, fonts, images or downloads.";
export const BODY_DROPPED = "Body not available: it was dropped to keep the extension's memory bounded.";
export const BODY_LOADING = "The response body is still loading.";

const header = (details, name) => details.responseHeaders?.find((one) => one.name.toLowerCase() === name)?.value ?? "";

/**
 * Whether to copy a response's body, from its headers: { keep: true }, or
 * { keep: false, reason } (reason null: a response with no body to give).
 */
export function bodyPlan(details, cap = BODY_MAX) {
  const status = details.statusCode;
  if ((status >= 300 && status < 400) || status === 204 || details.method === "HEAD") return { keep: false, reason: null };
  if (!BODY_TYPES.includes(details.type) || /^\s*attachment/i.test(header(details, "content-disposition"))) return { keep: false, reason: BODY_NOT_TEXT };
  // Only a response that says it is text: no type said, no body kept.
  const type = header(details, "content-type").split(";")[0].trim();
  if (!TEXT_MIME.test(type)) return { keep: false, reason: BODY_NOT_TEXT };
  const length = Number(header(details, "content-length"));
  if (Number.isFinite(length) && length > cap) return { keep: false, reason: BODY_TOO_LARGE };
  return { keep: true };
}

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

// Bytes are packed into blocks of this size, and the budget counts the
// blocks held, so a body sent in tiny pieces costs what it holds.
const BLOCK = 64 * 1024;
// Reads waiting for a body at once, across the store.
export const READS_MAX = 8;
export const BODY_READS = "Too many body reads at once: try again in a moment.";

export class BodyStore {
  constructor({ perBody = BODY_MAX, total = BODIES_MAX, count = HOPS_MAX, block = BLOCK } = {}) {
    this.perBody = perBody;
    this.total = total;
    this.count = count;
    this.block = block;
    this.hops = new Map();
    this.size = 0;
    this.reads = 0;
  }

  /**
   * A request's hop starts (what an earlier hop kept is dropped); the hop
   * is the handle for what follows. `request` keeps the addresses checked
   * again when the body is read: url, documentUrl, originUrl, frameAncestors.
   * `release` is called if the hop is dropped while its body still comes
   * (the filter lets go, and Firefox carries the rest).
   */
  start(requestId, tabId, request, release = null) {
    this.drop(requestId);
    const hop = { requestId, tabId, request, release, blocks: [], bytes: 0, held: 0, contentType: "", ended: false, done: null, published: false, error: null, waiters: [] };
    this.hops.set(requestId, hop);
    if (this.hops.size > this.count) this.drop(this.hops.keys().next().value, BODY_DROPPED);
    return hop;
  }

  /** Its row reached Codara (its response was sent). */
  publish(requestId) {
    const hop = this.hops.get(requestId);
    if (hop) hop.published = true;
  }

  /** Firefox reported the request done (true) or failed (false). */
  outcome(requestId, completed) {
    const hop = this.hops.get(requestId);
    if (!hop || hop.done !== null) return;
    hop.done = completed;
    if (!completed && !hop.error) this.fail(hop);
    this.wake(hop);
  }

  /** Empties the hop, with the reason its body cannot be given. */
  fail(hop, error = BODY_FAILED) {
    this.size -= hop.held;
    Object.assign(hop, { blocks: [], bytes: 0, held: 0, error });
  }

  wake(hop) {
    if (hop.error || (hop.ended && hop.done !== null)) for (const wake of hop.waiters.splice(0)) wake();
  }

  /** A response with no body to give, for this reason (null: it has none). */
  skip(requestId, tabId, request, reason) {
    this.drop(requestId);
    if (reason) this.end(this.start(requestId, tabId, request), reason);
  }

  /** Copies a piece of the body; false once it is not kept (past the cap, or dropped): the filter should let go. */
  data(hop, chunk) {
    if (this.hops.get(hop.requestId) !== hop || hop.error) return false;
    if (hop.bytes + chunk.length > this.perBody) {
      this.fail(hop, BODY_TOO_LARGE);
      hop.ended = true;
      this.wake(hop);
      return false;
    }
    let at = 0;
    while (at < chunk.length) {
      const used = hop.bytes % this.block;
      if (used === 0 && hop.bytes / this.block === hop.blocks.length) {
        hop.blocks.push(new Uint8Array(this.block));
        hop.held += this.block;
        this.size += this.block;
      }
      const room = this.block - (hop.bytes % this.block);
      const piece = chunk.subarray(at, at + room);
      hop.blocks.at(-1).set(piece, hop.bytes % this.block);
      hop.bytes += piece.length;
      at += piece.length;
    }
    // The oldest go first, never the one being kept.
    for (const other of [...this.hops.values()]) {
      if (this.size <= this.total) break;
      if (other !== hop) this.drop(other.requestId, BODY_DROPPED);
    }
    return true;
  }

  type(requestId, contentType) {
    const hop = this.hops.get(requestId);
    if (hop && typeof contentType === "string") hop.contentType = contentType;
  }

  /** The hop's body ended, or failed (`error`: BODY_FAILED unless a reason is given). */
  end(hop, error = null) {
    if (this.hops.get(hop.requestId) !== hop || hop.ended) return;
    hop.ended = true;
    if (error && !hop.error) this.fail(hop, error.startsWith("Body not available") ? error : BODY_FAILED);
    this.wake(hop);
  }

  drop(requestId, error = NO_BODY) {
    const hop = this.hops.get(requestId);
    if (!hop) return;
    this.hops.delete(requestId);
    if (!hop.ended) hop.release?.();
    this.fail(hop, hop.error ?? error);
    hop.ended = true;
    for (const wake of hop.waiters.splice(0)) wake();
  }

  /** Drops every body whose request no longer passes `keep` (the blocked sites or site access changed). */
  purge(keep) {
    for (const hop of [...this.hops.values()]) if (!keep(hop.request)) this.drop(hop.requestId);
  }

  forgetTab(tabId) {
    for (const hop of [...this.hops.values()]) if (hop.tabId === tabId) this.drop(hop.requestId);
  }

  /** Whether this hop is still the one kept for its request. */
  holds(hop) {
    return this.hops.get(hop.requestId) === hop && !hop.error;
  }

  /**
   * The hop of a request of this tab once its body has ended (waiting up to
   * `waitMs`); throws the protocol's errors. The body itself is built by
   * answer(), at the last moment.
   */
  async body(requestId, tabId, waitMs = 10_000) {
    const hop = this.hops.get(String(requestId));
    if (!hop || hop.tabId !== tabId || !hop.published) throw new Error(NO_BODY);
    if (!hop.error && !(hop.ended && hop.done !== null)) {
      if (this.reads >= READS_MAX) throw new Error(BODY_READS);
      this.reads += 1;
      let timer;
      let wake;
      try {
        const ended = await Promise.race([
          new Promise((resolve) => hop.waiters.push((wake = () => resolve(true)))),
          new Promise((resolve) => (timer = setTimeout(() => resolve(false), waitMs))),
        ]);
        if (!ended) throw new Error(BODY_LOADING);
      } finally {
        clearTimeout(timer);
        this.reads -= 1;
        // A read that gave up leaves nothing behind.
        hop.waiters = hop.waiters.filter((other) => other !== wake);
      }
    }
    if (hop.error) throw new Error(hop.error);
    return hop;
  }

  /** The body of a hop body() gave, as the protocol answers it, while the store still holds it. */
  answer(hop) {
    if (hop.error) throw new Error(hop.error);
    if (!this.holds(hop)) throw new Error(NO_BODY);
    const bytes = new Uint8Array(hop.bytes);
    let at = 0;
    for (const block of hop.blocks) {
      const piece = block.subarray(0, Math.min(this.block, hop.bytes - at));
      bytes.set(piece, at);
      at += piece.length;
    }
    return bodyAnswer(bytes, hop.contentType);
  }
}
