// Network recording for one tab, from the moment its session exists. Each
// row keeps what a HAR entry and a request detail need (headers, timing,
// initiator, sizes); bodies stay in the page's buffers and are fetched on
// demand (../network-detail.ts).

import type { CdpSession, RingBuffer } from "../cdp-session";

export const NETWORK_RING = "network";
export const NETWORK_RING_CAP = 500;

/** Longest request body kept in a row; HAR and detail reads fetch the rest. */
export const POST_DATA_CAP = 16_000;
const HEADER_VALUE_CAP = 8_000;
const PENDING_EXTRA_CAP = 200;

export interface NetworkInitiator {
  type: string;
  url: string | null;
  line: number | null;
}

/** Chromium's ResourceTiming: offsets in ms from requestTime (seconds, monotonic). */
export interface NetworkTiming {
  requestTime: number;
  proxyStart: number;
  proxyEnd: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  sslStart: number;
  sslEnd: number;
  sendStart: number;
  sendEnd: number;
  receiveHeadersEnd: number;
}

export interface NetworkEntry {
  /** Unique per row: the protocol request id, `<requestId>~<n>` for the nth redirect hop. */
  id: string;
  requestId: string;
  url: string;
  method: string | null;
  status: number | null;
  statusText: string | null;
  mimeType: string | null;
  /** Chromium's resource type: Document, Stylesheet, Script, Image, XHR, Fetch, ... */
  type: string | null;
  failed: boolean;
  errorText: string | null;
  at: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string> | null;
  postData: string | null;
  hasPostData: boolean;
  initiator: NetworkInitiator | null;
  protocol: string | null;
  remoteAddress: string | null;
  fromCache: boolean;
  /** Bytes on the wire, once the response finished. */
  encodedBytes: number | null;
  /** Monotonic seconds, comparable with timing.requestTime. */
  startTime: number | null;
  endTime: number | null;
  timing: NetworkTiming | null;
  /** Where a redirect hop went; its body is the next hop's. */
  redirectedTo: string | null;
  finished: boolean;
  /** The frame and the document load the request belongs to. */
  frameId: string | null;
  loaderId: string | null;
}

/** Why a request of a document that was replaced never finished. */
export const ABANDONED_BY_NAVIGATION = "net::ERR_ABORTED (the page navigated away)";

export function networkRing(session: CdpSession): RingBuffer<NetworkEntry> {
  return session.ring<NetworkEntry>(NETWORK_RING, NETWORK_RING_CAP);
}

interface RecorderState {
  byId: Map<string, NetworkEntry>;
  /** Every recorded row by its own id, redirect hops included. */
  rows: Map<string, NetworkEntry>;
  hops: Map<string, number>;
  // ExtraInfo events can arrive before or after the event they complete,
  // and a redirect's hops share one request id: the nth ExtraInfo of a
  // request id belongs to its nth hop, so they are keyed by row id.
  requestExtra: Map<string, Record<string, string>>;
  responseExtra: Map<string, Record<string, string>>;
  requestExtraSeen: Map<string, number>;
  responseExtraSeen: Map<string, number>;
}

function rowId(requestId: string, hop: number): string {
  return hop ? `${requestId}~${hop}` : requestId;
}

/** The row id the next ExtraInfo event of this request id belongs to. */
function nextExtraRow(seen: Map<string, number>, requestId: string): string {
  const hop = seen.get(requestId) ?? 0;
  seen.set(requestId, hop + 1);
  while (seen.size > PENDING_EXTRA_CAP * 5) seen.delete(seen.keys().next().value as string);
  return rowId(requestId, hop);
}

const states = new WeakMap<CdpSession, RecorderState>();

function headersOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    out[name] = text.length > HEADER_VALUE_CAP ? `${text.slice(0, HEADER_VALUE_CAP)}...` : text;
  }
  return out;
}

/** Header names compare case-insensitively; raw (ExtraInfo) headers replace parsed ones. */
function mergeHeaders(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  const extraNames = new Set(Object.keys(extra).map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(base)) if (!extraNames.has(name.toLowerCase())) merged[name] = value;
  return { ...merged, ...extra };
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value);
  while (map.size > PENDING_EXTRA_CAP) map.delete(map.keys().next().value as string);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function initiatorOf(raw: unknown): NetworkInitiator | null {
  if (!raw || typeof raw !== "object") return null;
  const initiator = raw as {
    type?: string;
    url?: string;
    lineNumber?: number;
    stack?: { callFrames?: Array<{ url?: string; lineNumber?: number }>; parent?: unknown };
  };
  const frame = initiator.stack?.callFrames?.find((call) => call.url);
  const line = num(initiator.lineNumber) ?? num(frame?.lineNumber);
  return {
    type: initiator.type ?? "other",
    url: str(initiator.url) ?? str(frame?.url),
    line: line === null ? null : line + 1,
  };
}

function timingOf(raw: unknown): NetworkTiming | null {
  if (!raw || typeof raw !== "object") return null;
  const timing = raw as Record<string, unknown>;
  const requestTime = num(timing.requestTime);
  if (requestTime === null) return null;
  const read = (key: string) => num(timing[key]) ?? -1;
  return {
    requestTime,
    proxyStart: read("proxyStart"),
    proxyEnd: read("proxyEnd"),
    dnsStart: read("dnsStart"),
    dnsEnd: read("dnsEnd"),
    connectStart: read("connectStart"),
    connectEnd: read("connectEnd"),
    sslStart: read("sslStart"),
    sslEnd: read("sslEnd"),
    sendStart: read("sendStart"),
    sendEnd: read("sendEnd"),
    receiveHeadersEnd: read("receiveHeadersEnd"),
  };
}

interface ResponseLike {
  url?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, unknown>;
  mimeType?: string;
  protocol?: string;
  remoteIPAddress?: string;
  remotePort?: number;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  fromPrefetchCache?: boolean;
  encodedDataLength?: number;
  timing?: unknown;
}

function applyResponse(entry: NetworkEntry, response: ResponseLike, state: RecorderState): void {
  if (typeof response.status === "number") entry.status = response.status;
  entry.statusText = str(response.statusText) ?? entry.statusText;
  entry.mimeType = str(response.mimeType) ?? entry.mimeType;
  entry.protocol = str(response.protocol) ?? entry.protocol;
  if (response.remoteIPAddress) {
    entry.remoteAddress = response.remotePort ? `${response.remoteIPAddress}:${response.remotePort}` : response.remoteIPAddress;
  }
  entry.fromCache = Boolean(response.fromDiskCache || response.fromServiceWorker || response.fromPrefetchCache);
  entry.timing = timingOf(response.timing) ?? entry.timing;
  let headers = headersOf(response.headers);
  const extra = state.responseExtra.get(entry.id);
  if (extra) {
    headers = mergeHeaders(headers, extra);
    state.responseExtra.delete(entry.id);
  }
  entry.responseHeaders = headers;
}

export function startNetworkRecorder(session: CdpSession): void {
  if (states.has(session)) return;
  const ring = networkRing(session);
  const state: RecorderState = {
    byId: new Map(),
    rows: new Map(),
    hops: new Map(),
    requestExtra: new Map(),
    responseExtra: new Map(),
    requestExtraSeen: new Map(),
    responseExtraSeen: new Map(),
  };
  states.set(session, state);
  const { byId } = state;
  const track = (entry: NetworkEntry) => {
    const dropped = ring.push(entry);
    // A redirect's hops share one request id; only the newest hop is indexed.
    if (dropped && state.rows.get(dropped.id) === dropped) state.rows.delete(dropped.id);
    if (dropped && byId.get(dropped.requestId) === dropped) {
      byId.delete(dropped.requestId);
      state.hops.delete(dropped.requestId);
      state.requestExtraSeen.delete(dropped.requestId);
      state.responseExtraSeen.delete(dropped.requestId);
    }
    byId.set(entry.requestId, entry);
    state.rows.set(entry.id, entry);
  };
  session.on("Network.requestWillBeSent", (params) => {
    const requestId = String(params.requestId ?? "");
    const request = (params.request ?? {}) as {
      url?: string;
      urlFragment?: string;
      method?: string;
      headers?: Record<string, unknown>;
      postData?: string;
      hasPostData?: boolean;
    };
    const timestamp = num(params.timestamp);
    // A redirect reuses the request id: the hop that redirected is its own
    // row, completed here by the redirect response.
    const previous = byId.get(requestId);
    let hop = 0;
    if (previous && params.redirectResponse) {
      applyResponse(previous, params.redirectResponse as ResponseLike, state);
      previous.redirectedTo = typeof request.url === "string" ? request.url : null;
      previous.endTime = timestamp ?? previous.endTime;
      previous.finished = true;
      hop = (state.hops.get(requestId) ?? 0) + 1;
      state.hops.set(requestId, hop);
    } else {
      state.hops.delete(requestId);
    }
    const id = rowId(requestId, hop);
    let requestHeaders = headersOf(request.headers);
    const extra = state.requestExtra.get(id);
    if (extra) {
      requestHeaders = mergeHeaders(requestHeaders, extra);
      state.requestExtra.delete(id);
    }
    const postData = typeof request.postData === "string" ? request.postData.slice(0, POST_DATA_CAP) : null;
    const wallTime = num(params.wallTime);
    track({
      id,
      requestId,
      url: typeof request.url === "string" ? request.url + (request.urlFragment ?? "") : "",
      method: typeof request.method === "string" ? request.method : null,
      status: null,
      statusText: null,
      mimeType: null,
      type: str(params.type),
      failed: false,
      errorText: null,
      at: new Date(wallTime !== null ? wallTime * 1000 : Date.now()).toISOString(),
      requestHeaders,
      responseHeaders: null,
      postData,
      hasPostData: Boolean(request.hasPostData || postData),
      initiator: initiatorOf(params.initiator),
      protocol: null,
      remoteAddress: null,
      fromCache: false,
      encodedBytes: null,
      startTime: timestamp,
      endTime: null,
      timing: null,
      redirectedTo: null,
      finished: false,
      frameId: str(params.frameId),
      loaderId: str(params.loaderId),
    });
  });
  session.on("Network.requestWillBeSentExtraInfo", (params) => {
    const id = nextExtraRow(state.requestExtraSeen, String(params.requestId ?? ""));
    const headers = headersOf(params.headers);
    const entry = state.rows.get(id);
    if (entry) entry.requestHeaders = mergeHeaders(entry.requestHeaders, headers);
    else remember(state.requestExtra, id, headers);
  });
  session.on("Network.responseReceived", (params) => {
    const entry = byId.get(String(params.requestId ?? ""));
    if (!entry) return;
    applyResponse(entry, (params.response ?? {}) as ResponseLike, state);
    entry.type = str(params.type) ?? entry.type;
    // A document about to replace its frame's previous one ends that
    // document's unfinished requests, and Chromium reports no failure for
    // them; without this they would stay pending for good.
    if (entry.type === "Document" && entry.frameId && entry.loaderId) {
      for (const row of ring.toArray()) {
        if (row.finished || row.frameId !== entry.frameId || !row.loaderId || row.loaderId === entry.loaderId) continue;
        row.failed = true;
        row.finished = true;
        row.errorText = ABANDONED_BY_NAVIGATION;
      }
    }
  });
  session.on("Network.responseReceivedExtraInfo", (params) => {
    const id = nextExtraRow(state.responseExtraSeen, String(params.requestId ?? ""));
    const headers = headersOf(params.headers);
    const entry = state.rows.get(id);
    if (entry?.responseHeaders) entry.responseHeaders = mergeHeaders(entry.responseHeaders, headers);
    else remember(state.responseExtra, id, headers);
  });
  session.on("Network.loadingFinished", (params) => {
    const entry = byId.get(String(params.requestId ?? ""));
    if (!entry) return;
    // The old document outlived the new one's response long enough to finish it.
    if (entry.errorText === ABANDONED_BY_NAVIGATION) {
      entry.failed = false;
      entry.errorText = null;
    }
    entry.finished = true;
    entry.endTime = num(params.timestamp) ?? entry.endTime;
    entry.encodedBytes = num(params.encodedDataLength) ?? entry.encodedBytes;
  });
  session.on("Network.loadingFailed", (params) => {
    const entry = byId.get(String(params.requestId ?? ""));
    if (!entry) return;
    entry.failed = true;
    entry.finished = true;
    entry.endTime = num(params.timestamp) ?? entry.endTime;
    const reason = str(params.blockedReason) ?? str(params.corsErrorStatus && (params.corsErrorStatus as { corsError?: string }).corsError);
    const text = typeof params.errorText === "string" && params.errorText ? params.errorText : "failed";
    entry.errorText = params.canceled === true ? `${text} (canceled)` : reason ? `${text} (${reason})` : text;
    entry.type = str(params.type) ?? entry.type;
  });
  // Bodies stay in the page's buffers so a later read can still fetch them.
  session.hold("Network", { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000 });
}

/** Forget recorded requests (clear=true). */
export function clearNetwork(session: CdpSession): void {
  networkRing(session).clear();
  const state = states.get(session);
  if (!state) return;
  state.byId.clear();
  state.rows.clear();
  state.hops.clear();
  state.requestExtra.clear();
  state.responseExtra.clear();
  state.requestExtraSeen.clear();
  state.responseExtraSeen.clear();
}

/** The row an agent named by its id, or the newest hop of a protocol request id. */
export function findNetworkEntry(session: CdpSession, id: string | number): NetworkEntry | null {
  // A command line reads an id such as 3412.10 as the number 3412.1, so a
  // number matches the id it was parsed from.
  const matches = (entry: NetworkEntry) => (typeof id === "number" ? Number(entry.id) === id : entry.id === id);
  const rows = networkRing(session).toArray();
  for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i])) return rows[i];
  for (const entry of states.get(session)?.byId.values() ?? []) if (matches(entry)) return entry;
  return null;
}

/** Whether this row is the hop whose body the protocol can return. */
export function isFinalHop(session: CdpSession, entry: NetworkEntry): boolean {
  return states.get(session)?.byId.get(entry.requestId) === entry;
}
