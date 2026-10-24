// tab.cdp for codara_browser_use: one DevTools protocol command on the tab's
// shared session (browser/cdp-session.ts), and event subscriptions read
// from a bounded buffer. Every command and event name passes
// browser/cdp-policy.ts first; the call itself is an ordinary preview.*
// call, so workspace scoping, Chrome access, the extension's own checks and
// the dialog guard apply as they do to any browser tool.
//
// The session is shared with Codara's recorders, so a snippet never sends
// Domain.enable or Domain.disable itself: enable takes a counted hold on the
// domain and disable gives that hold back, which keeps the console and
// network recorders alive whatever the snippet does. Holds and
// subscriptions belong to the caller (its run, pane and MCP process) and
// end after a few idle minutes, when given back, or with the tab.

import { randomBytes } from "node:crypto";

import { writeBrowserArtifact } from "../browser/artifacts";
import { RingBuffer, type CdpSession } from "../browser/cdp-session";
import { cdpDomain, cdpParamsError, checkCdpCommand, checkCdpEvent } from "../browser/cdp-policy";
import { redactHeaders } from "../browser/har";
import type { BrowserTarget } from "../browser/targets";
import { requireTarget } from "./core";
import { PreviewToolParamsError, type PreviewToolTable } from "./types";

const MAX_PARAMS_CHARS = 200_000;
const MAX_RESULT_CHARS = 1_000_000;
const MAX_EVENT_CHARS = 64_000;
const EVENT_BUFFER = 500;
const MAX_EVENTS_PER_SUBSCRIPTION = 20;
const MAX_SUBSCRIPTIONS_PER_OWNER = 8;
const MAX_SUBSCRIPTIONS = 64;
const MAX_READ_WAIT_MS = 30_000;
const MAX_READ = 500;
const IDLE_MS = 10 * 60_000;

/**
 * Set by code.ts on each call a snippet makes: the code session's key, which
 * names the agent's own MCP process. A symbol, so neither tool JSON nor a
 * snippet can set it, and the socket's scoping (which drops callerPid) keeps
 * it, since it edits the params object in place.
 */
export const CDP_OWNER: unique symbol = Symbol("cdpOwner");

/** Whose holds and subscriptions these are: the code session, else the scoped caller. */
function ownerOf(params: Record<string, unknown>): string {
  const session = (params as { [CDP_OWNER]?: unknown })[CDP_OWNER];
  if (typeof session === "string" && session) return `session:${session}`;
  return `caller:${["runId", "callerPaneId", "workspaceId"].map((field) => String(params[field] ?? "")).join("|")}`;
}

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new PreviewToolParamsError(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

// Cookie and authorization headers in the user's own browser carry live
// sign-ins that page scripts cannot read, so they stay redacted there, as in
// codara_preview_network. The extension already drops cookie headers from
// events unless the tab allows storage access.
const HEADER_FIELDS = new Set(["headers", "requestHeaders", "responseHeaders"]);
const RAW_HEADER_FIELDS = new Set(["headersText", "requestHeadersText", "associatedCookies", "blockedCookies", "exemptedCookies"]);

function redactSignIns(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => redactSignIns(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_HEADER_FIELDS.has(key)) continue;
    if (HEADER_FIELDS.has(key) && item && typeof item === "object" && !Array.isArray(item)) out[key] = redactHeaders(item as Record<string, string>);
    else out[key] = redactSignIns(item, depth + 1);
  }
  return out;
}

function forCaller(target: BrowserTarget, value: unknown): unknown {
  return target.kind === "chrome" ? redactSignIns(value) : value;
}

// ── Domain holds ────────────────────────────────────────────────────────────

interface OwnerHolds {
  releases: Map<string, () => Promise<void>>;
  timer: ReturnType<typeof setTimeout> | null;
}

const holds = new WeakMap<CdpSession, Map<string, OwnerHolds>>();

async function releaseAll(session: CdpSession, owner: string): Promise<void> {
  const record = holds.get(session)?.get(owner);
  if (!record) return;
  holds.get(session)?.delete(owner);
  if (record.timer) clearTimeout(record.timer);
  for (const release of record.releases.values()) await release().catch(() => {});
}

function ownerHolds(session: CdpSession, owner: string): OwnerHolds {
  let byOwner = holds.get(session);
  if (!byOwner) {
    holds.set(session, (byOwner = new Map()));
    session.onDispose(() => holds.delete(session));
  }
  let record = byOwner.get(owner);
  if (!record) byOwner.set(owner, (record = { releases: new Map(), timer: null }));
  if (record.timer) clearTimeout(record.timer);
  record.timer = setTimeout(() => void releaseAll(session, owner), IDLE_MS);
  record.timer.unref?.();
  return record;
}

/** Hold a domain enabled for this caller; a second enable is a no-op. */
async function holdDomain(session: CdpSession, domain: string, params?: Record<string, unknown>): Promise<() => Promise<void>> {
  const release = await session.enable(domain, params && Object.keys(params).length ? params : undefined);
  // A paused page runs nothing, and no snippet could resume it (stepping is
  // refused), so the read-only debugger never stops on a breakpoint.
  if (domain === "Debugger") {
    // TEMP macOS CI diagnostics (fix/cora-macos-ci)
    const off = process.env.CODARA_DIAG_SKIP ? session.on("Debugger.paused", (params: unknown) => console.error("[diag] Debugger.paused", JSON.stringify(params).slice(0, 300))) : null;
    void off;
    await session.send("Debugger.setSkipAllPauses", { skip: true }).then(
      (r) => process.env.CODARA_DIAG_SKIP && console.error("[diag] setSkipAllPauses ok", JSON.stringify(r)),
      (e) => process.env.CODARA_DIAG_SKIP && console.error("[diag] setSkipAllPauses failed", String(e)),
    );
  }
  return release;
}

async function enableFor(session: CdpSession, owner: string, domain: string, params: Record<string, unknown>): Promise<void> {
  const record = ownerHolds(session, owner);
  if (record.releases.has(domain)) return;
  const release = await holdDomain(session, domain, params);
  if (record.releases.has(domain)) {
    await release();
    return;
  }
  record.releases.set(domain, release);
}

async function disableFor(session: CdpSession, owner: string, domain: string): Promise<void> {
  const record = holds.get(session)?.get(owner);
  const release = record?.releases.get(domain);
  if (!record || !release) return;
  record.releases.delete(domain);
  await release();
}

// ── send ────────────────────────────────────────────────────────────────────

async function send(params: Record<string, unknown>): Promise<unknown> {
  const decision = checkCdpCommand(params.method);
  if (!decision.ok) throw new PreviewToolParamsError(decision.reason);
  const method = params.method as string;
  const commandParams = plainObject(params.params, "params");
  if (JSON.stringify(commandParams).length > MAX_PARAMS_CHARS) throw new PreviewToolParamsError(`params are over ${MAX_PARAMS_CHARS} characters.`);
  const refused = cdpParamsError(method, commandParams);
  if (refused) throw new PreviewToolParamsError(refused);
  const target = await requireTarget(params);
  if (target.kind === "chrome") {
    const inUserBrowser = checkCdpCommand(method, { userBrowser: true });
    if (!inUserBrowser.ok) throw new PreviewToolParamsError(inUserBrowser.reason);
  }
  const session = target.session;
  const owner = ownerOf(params);
  const name = method.slice(decision.domain.length + 1);
  if (name === "enable") {
    await enableFor(session, owner, decision.domain, commandParams);
    return { ok: true, result: {} };
  }
  if (name === "disable") {
    await disableFor(session, owner, decision.domain);
    return { ok: true, result: {} };
  }
  ownerHolds(session, owner);
  const raw = await session.send<Record<string, unknown>>(method, commandParams);
  if (method === "Page.captureScreenshot" && typeof raw?.data === "string") {
    // Pixels ride on the tool result as an image, like tab.screenshot().
    const format = commandParams.format === "jpeg" || commandParams.format === "webp" ? commandParams.format : "png";
    return { ok: true, result: {}, dataUrl: `data:image/${format};base64,${raw.data}` };
  }
  const result = forCaller(target, raw ?? {});
  const text = JSON.stringify(result);
  if (text.length <= MAX_RESULT_CHARS) return { ok: true, result };
  const path = await writeBrowserArtifact(target.workspaceId, "cdp", { label: method, ext: "json", data: text });
  return {
    ok: true,
    result: null,
    path,
    chars: text.length,
    note: `The result is ${text.length} characters, over the ${MAX_RESULT_CHARS} returned inline; it is saved at path.`,
  };
}

// ── Events ──────────────────────────────────────────────────────────────────

interface CdpEvent {
  method: string;
  params: unknown;
  at: number;
}

interface Subscription {
  id: string;
  owner: string;
  target: BrowserTarget;
  events: string[];
  buffer: RingBuffer<CdpEvent>;
  waiters: Set<() => void>;
  stop: Array<() => void>;
  releases: Array<() => Promise<void>>;
  timer: ReturnType<typeof setTimeout> | null;
}

const subscriptions = new Map<string, Subscription>();

function closeSubscription(subscription: Subscription): void {
  if (subscriptions.get(subscription.id) !== subscription) return;
  subscriptions.delete(subscription.id);
  if (subscription.timer) clearTimeout(subscription.timer);
  for (const stop of subscription.stop.splice(0)) stop();
  for (const release of subscription.releases.splice(0)) void release().catch(() => {});
  for (const wake of subscription.waiters) wake();
  subscription.waiters.clear();
}

function touch(subscription: Subscription): void {
  if (subscription.timer) clearTimeout(subscription.timer);
  subscription.timer = setTimeout(() => closeSubscription(subscription), IDLE_MS);
  subscription.timer.unref?.();
}

function record(subscription: Subscription, method: string, params: Record<string, unknown>): void {
  let value: unknown = forCaller(subscription.target, params);
  const size = JSON.stringify(value)?.length ?? 0;
  if (size > MAX_EVENT_CHARS) value = { truncated: true, chars: size, note: `The event's params were over ${MAX_EVENT_CHARS} characters.` };
  subscription.buffer.push({ method, params: value, at: Date.now() });
  for (const wake of subscription.waiters) wake();
  subscription.waiters.clear();
}

function readEventNames(value: unknown, context: { userBrowser?: boolean } = {}): string[] {
  const names = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (!names.length || names.length > MAX_EVENTS_PER_SUBSCRIPTION) {
    throw new PreviewToolParamsError(`events must name 1 to ${MAX_EVENTS_PER_SUBSCRIPTION} DevTools protocol events, such as "Network.responseReceived".`);
  }
  for (const name of names) {
    const decision = checkCdpEvent(name, context);
    if (!decision.ok) throw new PreviewToolParamsError(decision.reason);
  }
  return [...new Set(names as string[])];
}

async function subscribe(params: Record<string, unknown>): Promise<unknown> {
  const events = readEventNames(params.events);
  const owner = ownerOf(params);
  const mine = [...subscriptions.values()].filter((entry) => entry.owner === owner);
  if (mine.length >= MAX_SUBSCRIPTIONS_PER_OWNER) closeSubscription(mine[0]);
  if (subscriptions.size >= MAX_SUBSCRIPTIONS) closeSubscription(subscriptions.values().next().value as Subscription);
  const target = await requireTarget(params);
  if (target.kind === "chrome") readEventNames(events, { userBrowser: true });
  const session = target.session;
  const subscription: Subscription = {
    id: `cdp-${randomBytes(6).toString("hex")}`,
    owner,
    target,
    events,
    buffer: new RingBuffer<CdpEvent>(EVENT_BUFFER),
    waiters: new Set(),
    stop: [],
    releases: [],
    timer: null,
  };
  for (const event of events) subscription.stop.push(session.on(event, (eventParams, method) => record(subscription, method, eventParams)));
  subscription.stop.push(session.onDispose(() => closeSubscription(subscription)));
  subscriptions.set(subscription.id, subscription);
  touch(subscription);
  // An event only fires while its domain is on; the subscription holds it.
  try {
    for (const domain of new Set(events.map((event) => cdpDomain(event) as string))) {
      subscription.releases.push(await holdDomain(session, domain));
    }
  } catch (error) {
    closeSubscription(subscription);
    throw error;
  }
  return { ok: true, subscription: subscription.id, events };
}

function ownSubscription(params: Record<string, unknown>): Subscription {
  const subscription = typeof params.subscription === "string" ? subscriptions.get(params.subscription) : undefined;
  // Another caller's id reads as unknown, so ids reveal nothing.
  if (!subscription || subscription.owner !== ownerOf(params)) {
    throw new PreviewToolParamsError("No such event subscription: it was closed, sat idle for 10 minutes, or its tab closed. Subscribe again with tab.cdp.on().");
  }
  return subscription;
}

async function read(params: Record<string, unknown>): Promise<unknown> {
  const subscription = ownSubscription(params);
  touch(subscription);
  const waitMs = typeof params.waitMs === "number" && params.waitMs > 0 ? Math.min(params.waitMs, MAX_READ_WAIT_MS) : 0;
  if (!subscription.buffer.size && waitMs) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, waitMs);
      function done() {
        clearTimeout(timer);
        subscription.waiters.delete(done);
        resolve();
      }
      subscription.waiters.add(done);
    });
  }
  const max = typeof params.max === "number" && params.max > 0 ? Math.min(Math.floor(params.max), MAX_READ) : MAX_READ;
  const all = subscription.buffer.toArray();
  const dropped = subscription.buffer.dropped;
  const taken = all.slice(0, max);
  subscription.buffer.clear();
  for (const rest of all.slice(max)) subscription.buffer.push(rest);
  return {
    ok: true,
    events: taken,
    ...(subscription.buffer.size ? { more: subscription.buffer.size } : {}),
    ...(dropped ? { dropped } : {}),
    ...(subscriptions.has(subscription.id) ? {} : { closed: true }),
  };
}

async function events(params: Record<string, unknown>): Promise<unknown> {
  const action = typeof params.action === "string" ? params.action : "";
  if (action === "subscribe") return subscribe(params);
  if (action === "read") return read(params);
  if (action === "unsubscribe") {
    closeSubscription(ownSubscription(params));
    return { ok: true, closed: true };
  }
  throw new PreviewToolParamsError("action must be subscribe, read or unsubscribe.");
}

/** Ends every subscription and hold (tests). */
export function closeCdpSubscriptions(): void {
  for (const subscription of [...subscriptions.values()]) closeSubscription(subscription);
}

export function cdpSubscriptionCount(): number {
  return subscriptions.size;
}

export const cdpPreviewTools: PreviewToolTable = {
  "preview.cdp": { run: send, targets: "any" },
  "preview.cdp_events": { run: events, targets: "any" },
};
