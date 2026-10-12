// Network recording for one tab, from the moment its session exists.

import type { CdpSession, RingBuffer } from "../cdp-session";

export const NETWORK_RING = "network";
export const NETWORK_RING_CAP = 500;

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string | null;
  status: number | null;
  mimeType: string | null;
  failed: boolean;
  errorText: string | null;
  at: string;
}

export function networkRing(session: CdpSession): RingBuffer<NetworkEntry> {
  return session.ring<NetworkEntry>(NETWORK_RING, NETWORK_RING_CAP);
}

const indexes = new WeakMap<CdpSession, Map<string, NetworkEntry>>();

export function startNetworkRecorder(session: CdpSession): void {
  if (indexes.has(session)) return;
  const ring = networkRing(session);
  const byId = new Map<string, NetworkEntry>();
  indexes.set(session, byId);
  const track = (entry: NetworkEntry) => {
    const dropped = ring.push(entry);
    // A redirect's hops share one request id; only the newest hop is indexed.
    if (dropped && byId.get(dropped.requestId) === dropped) byId.delete(dropped.requestId);
    byId.set(entry.requestId, entry);
  };
  session.on("Network.requestWillBeSent", (params) => {
    const requestId = String(params.requestId ?? "");
    const request = (params.request ?? {}) as { url?: string; method?: string };
    // A redirect reuses the request id: the hop that redirected is its own row.
    track({
      requestId,
      url: typeof request.url === "string" ? request.url : "",
      method: typeof request.method === "string" ? request.method : null,
      status: null,
      mimeType: null,
      failed: false,
      errorText: null,
      at: new Date().toISOString(),
    });
  });
  session.on("Network.responseReceived", (params) => {
    const entry = byId.get(String(params.requestId ?? ""));
    const response = (params.response ?? {}) as { status?: number; mimeType?: string };
    if (!entry) return;
    if (typeof response.status === "number") entry.status = response.status;
    if (typeof response.mimeType === "string") entry.mimeType = response.mimeType;
  });
  session.on("Network.loadingFailed", (params) => {
    const entry = byId.get(String(params.requestId ?? ""));
    if (!entry) return;
    entry.failed = true;
    entry.errorText = typeof params.errorText === "string" ? params.errorText : "failed";
  });
  // Bodies stay in the page's buffers so a later read can still fetch them.
  session.hold("Network", { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000 });
}

/** Forget recorded requests (clear=true). */
export function clearNetwork(session: CdpSession): void {
  networkRing(session).clear();
  indexes.get(session)?.clear();
}
