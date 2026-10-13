// codara_preview_wait_for: wait for the page to reach a state, on any
// browser target. Conditions combine (all must hold):
//
//   selector + state   an element is attached, visible or hidden; with
//                      fresh, only elements added since the agent's last
//                      action count, so `h1` cannot match the page a click
//                      is leaving
//   url                the address equals a URL or path, matches a glob
//                      (*), or a /regular expression/
//   navigation         a navigation committed since the last action
//   load               domcontentloaded, load, or networkidle (load plus no
//                      request in flight for 500 ms)
//   stableMs           no DOM change for that long
//   hmr                the dev server's latest hot update (or reload)
//                      finished and the page settled
//
// Navigation, loading, requests and hot updates come from the tab's
// recorded activity (page-activity.ts); the DOM is read with one short page
// call per tick, which also survives the page being replaced mid-wait.

import { createPreviewDOM } from "../../shared/preview-dom";
import { isHmrRequest, pageActivity, type PageActivity } from "./page-activity";
import type { BrowserTarget } from "./targets";

export const WAIT_DEFAULT_MS = 5_000;
export const WAIT_LOAD_DEFAULT_MS = 15_000;
export const WAIT_MAX_MS = 50_000;
const TICK_MS = 100;
const PROBE_TIMEOUT_MS = 1_500;
const NETWORK_IDLE_MS = 500;
/** A click that navigates starts loading a moment after it returns. */
const ACTION_SETTLE_MS = 250;
/** A hot update counts if it came after the last action or this recently. */
const HMR_LOOKBACK_MS = 10_000;
const HMR_QUIET_MS = 300;

export type LoadState = "domcontentloaded" | "load" | "networkidle";
export type ElementState = "attached" | "visible" | "hidden";

export interface WaitRequest {
  selector: string | null;
  state: ElementState;
  fresh: boolean;
  url: string | null;
  navigation: boolean;
  load: LoadState | null;
  stableMs: number | null;
  hmr: boolean;
  timeoutMs: number;
}

export class WaitRequestError extends Error {}

export function normalizeWaitRequest(params: Record<string, unknown>): WaitRequest {
  const text = (key: string) => (typeof params[key] === "string" && (params[key] as string).trim() ? (params[key] as string).trim() : null);
  const selector = text("selector");
  const state = params.state === undefined ? "visible" : params.state;
  if (state !== "attached" && state !== "visible" && state !== "hidden") throw new WaitRequestError("state must be attached, visible or hidden.");
  const load = params.load === undefined || params.load === null ? null : params.load;
  if (load !== null && load !== "domcontentloaded" && load !== "load" && load !== "networkidle") {
    throw new WaitRequestError("load must be domcontentloaded, load or networkidle.");
  }
  const stableMs = typeof params.stableMs === "number" && Number.isFinite(params.stableMs) && params.stableMs > 0
    ? Math.min(10_000, Math.round(params.stableMs))
    : null;
  const request: WaitRequest = {
    selector,
    state,
    fresh: params.fresh === true,
    url: text("url"),
    navigation: params.navigation === true,
    load: load as LoadState | null,
    stableMs,
    hmr: params.hmr === true,
    timeoutMs: 0,
  };
  if (!request.selector && !request.url && !request.navigation && !request.load && !request.stableMs && !request.hmr) {
    throw new WaitRequestError("Give at least one condition: selector, url, navigation, load, stableMs or hmr.");
  }
  if (request.fresh && !request.selector) throw new WaitRequestError("fresh needs a selector.");
  const slow = request.navigation || request.load !== null || request.hmr;
  const asked = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? params.timeoutMs : null;
  request.timeoutMs = Math.max(0, Math.min(WAIT_MAX_MS, Math.round(asked ?? (slow ? WAIT_LOAD_DEFAULT_MS : WAIT_DEFAULT_MS))));
  return request;
}

/** Whether href is the URL a wait names: exact (or a path on this origin), a glob with *, or /regex/. */
export function matchUrl(pattern: string, href: string): boolean {
  const p = pattern.trim();
  if (p.length > 2 && p.startsWith("/") && p.endsWith("/")) {
    try {
      return new RegExp(p.slice(1, -1)).test(href);
    } catch {
      /* not a valid expression: treat it as a path */
    }
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(href);
  } catch {
    parsed = null;
  }
  const path = parsed ? `${parsed.pathname}${parsed.search}${parsed.hash}` : href;
  if (p.includes("*")) {
    const source = p.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    const glob = new RegExp(`^${source}$`);
    return glob.test(p.startsWith("/") ? path : href);
  }
  if (p === href) return true;
  try {
    const resolved = new URL(p, href);
    if (resolved.href === href) return true;
    // "/settings" also matches "/settings?tab=2" only when written that way;
    // a trailing slash difference is not a different page.
    if (parsed && p.startsWith("/") && !p.includes("?") && !p.includes("#")) {
      return resolved.origin === parsed.origin && resolved.pathname.replace(/\/$/, "") === parsed.pathname.replace(/\/$/, "");
    }
  } catch {
    /* not a URL */
  }
  return false;
}

export interface PageProbe {
  href: string;
  readyState: string;
  title: string;
  quietMs: number;
  selector?: { count: number; visible: number; fresh: number; matched: boolean; ref?: string; tag?: string; text?: string };
}

// Stringified into the page; may use only its arguments and page globals.
export function waitProbe(
  args: { selector: string | null; state: string; fresh: boolean },
  createDOM: typeof createPreviewDOM,
): PageProbe {
  type Watch = { last: number };
  const host = window as unknown as Record<symbol, unknown>;
  const watchKey = Symbol.for("codara.preview.domWatch");
  let watch = host[watchKey] as Watch | undefined;
  if (!watch) {
    const created: Watch = { last: performance.now() };
    host[watchKey] = created;
    watch = created;
    new MutationObserver(() => {
      created.last = performance.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  const probe: PageProbe = {
    href: location.href,
    readyState: document.readyState,
    title: document.title,
    quietMs: Math.round(performance.now() - watch.last),
  };
  if (!args.selector) return probe;
  const dom = createDOM();
  let elements: Element[];
  if (args.selector.startsWith("@")) {
    const el = dom.find(args.selector, true);
    elements = el ? [el] : [];
  } else {
    elements = Array.from(document.querySelectorAll(args.selector));
  }
  const baseline = host[Symbol.for("codara.preview.baseline")] as { seen: WeakSet<Element> } | undefined;
  const isFresh = (el: Element) => !baseline || !baseline.seen.has(el);
  const visible = elements.filter((el) => dom.visible(el));
  const candidates = args.fresh ? elements.filter(isFresh) : elements;
  let matched = false;
  let match: Element | undefined;
  if (args.state === "hidden") matched = candidates.every((el) => !dom.visible(el));
  else {
    match = args.state === "attached" ? candidates[0] : candidates.find((el) => dom.visible(el));
    matched = !!match;
  }
  probe.selector = {
    count: elements.length,
    visible: visible.length,
    fresh: elements.filter(isFresh).length,
    matched,
    ...(match
      ? {
          ref: dom.ref(match),
          tag: match.tagName.toLowerCase(),
          text: ((match as HTMLElement).innerText ?? match.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        }
      : {}),
  };
  return probe;
}

/** Page expression that records which elements exist now, for fresh waits. */
export const MARK_BASELINE_EXPRESSION =
  "(() => { window[Symbol.for('codara.preview.baseline')] = { at: Date.now(), seen: new WeakSet(document.querySelectorAll('*')) }; return true; })()";

export interface Verdict {
  ok: boolean;
  /** Unmet conditions, readable. */
  waiting: string[];
  /** A condition that can no longer be met (the dev server reported an error). */
  failure?: string;
}

/** Decide whether the conditions hold; pure, for tests. */
export function checkWait(
  request: WaitRequest,
  activity: PageActivity,
  probe: PageProbe | null,
  now: number,
  startedAt: number,
): Verdict {
  const waiting: string[] = [];
  const since = activity.lastActionAt || startedAt;
  if (request.navigation && !activity.navigations.some((nav) => nav.at >= since)) {
    waiting.push(activity.lastActionAt ? "no navigation since your last action" : "no navigation since the wait started");
  }
  if (request.url) {
    const href = probe?.href ?? activity.navigations.at(-1)?.url ?? "";
    if (!matchUrl(request.url, href)) waiting.push(`url is ${href || "unknown"}`);
  }
  if (request.load) {
    const pendingNavigation = activity.navigationRequestedAt > 0 || activity.loadingStartedAt > activity.loadingStoppedAt;
    const settling = activity.lastActionAt > 0 && now - activity.lastActionAt < ACTION_SETTLE_MS;
    const ready = probe?.readyState ?? "unknown";
    if (pendingNavigation) waiting.push("a navigation is still loading");
    else if (settling) waiting.push("the last action just happened");
    else if (request.load === "domcontentloaded" ? ready === "loading" || ready === "unknown" : ready !== "complete") {
      waiting.push(`document.readyState is ${ready}`);
    } else if (request.load === "networkidle") {
      const busy = activity.inFlight.size;
      if (busy > 0) {
        const urls = [...activity.inFlight.values()].slice(0, 3).map((request) => request.url.slice(0, 120));
        waiting.push(`${busy} request${busy === 1 ? "" : "s"} in flight (${urls.join(", ")})`);
      } else if (now - activity.lastNetworkAt < NETWORK_IDLE_MS) waiting.push("the network was busy less than 500 ms ago");
    }
  }
  let failure: string | undefined;
  if (request.hmr) {
    const from = Math.max(activity.lastActionAt, startedAt - HMR_LOOKBACK_MS);
    const updates = activity.hmr.filter((record) => record.at >= from);
    const last = updates.at(-1);
    if (!last) waiting.push("no hot update or reload seen yet");
    else if (last.kind === "error") failure = `The dev server reported an error after the update: ${last.detail}`;
    else if (last.kind === "start") waiting.push("the dev server is rebuilding");
    else if (last.kind === "reload" && !activity.navigations.some((nav) => nav.at >= last.at && !nav.sameDocument)) {
      waiting.push("the page has not reloaded yet");
    } else if (now - activity.lastHmrAt < HMR_QUIET_MS || [...activity.inFlight.values()].some((entry) => isHmrRequest(entry.url))) {
      waiting.push("the update is still being applied");
    } else if (probe && probe.readyState !== "complete") waiting.push("the reloaded page is still loading");
    else if (probe && probe.quietMs < HMR_QUIET_MS) waiting.push("the DOM is still changing");
  }
  if (request.selector) {
    const sel = probe?.selector;
    if (!sel) waiting.push(`could not read the page to check ${request.selector}`);
    else if (!sel.matched) {
      const old = sel.count - sel.fresh;
      const detail = sel.count === 0
        ? "no element matches"
        : request.fresh && sel.fresh === 0
          ? `${old} element${old === 1 ? "" : "s"} match but all existed before your last action`
          : `${sel.count} match, ${sel.visible} visible`;
      waiting.push(`${request.selector} is not ${request.state}${request.fresh ? " (fresh)" : ""}: ${detail}`);
    }
  }
  if (request.stableMs && (!probe || probe.quietMs < request.stableMs)) {
    waiting.push(`the DOM changed ${probe ? `${probe.quietMs} ms` : "too recently"} ago`);
  }
  return { ok: waiting.length === 0 && !failure, waiting, ...(failure ? { failure } : {}) };
}

function describeConditions(request: WaitRequest): string {
  const parts: string[] = [];
  if (request.navigation) parts.push("a navigation");
  if (request.url) parts.push(`url ${request.url}`);
  if (request.load) parts.push(request.load);
  if (request.hmr) parts.push("the hot update to finish");
  if (request.selector) parts.push(`${request.selector} ${request.state}${request.fresh ? " (fresh)" : ""}`);
  if (request.stableMs) parts.push(`${request.stableMs} ms without DOM changes`);
  return parts.join(" + ");
}

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the page did not answer")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function waitForPage(target: BrowserTarget, request: WaitRequest): Promise<Record<string, unknown>> {
  const activity = pageActivity(target.session);
  const startedAt = Date.now();
  const deadline = startedAt + request.timeoutMs;
  const expression = `(${waitProbe.toString()})(${JSON.stringify({ selector: request.selector, state: request.state, fresh: request.fresh })}, ${createPreviewDOM.toString()})`;
  let probe: PageProbe | null = null;
  let probeError: string | null = null;
  for (;;) {
    try {
      probe = await bounded(target.evaluate<PageProbe>(expression), PROBE_TIMEOUT_MS);
      probeError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A bad selector never starts matching; anything else (the page being
      // replaced, a busy renderer) is worth another tick.
      if (/SyntaxError|is not a valid selector|Stale element reference/.test(message)) throw new WaitRequestError(message);
      probe = null;
      probeError = message;
    }
    const now = Date.now();
    const verdict = checkWait(request, activity, probe, now, startedAt);
    if (verdict.failure) {
      return { ok: false, error: verdict.failure, waitedMs: now - startedAt, url: probe?.href ?? null };
    }
    if (verdict.ok) {
      const lastHmr = request.hmr ? activity.hmr.at(-1) : undefined;
      return {
        ok: true,
        waitedMs: now - startedAt,
        url: probe?.href ?? null,
        title: probe?.title ?? null,
        ...(probe?.selector?.ref ? { element: { ref: probe.selector.ref, tag: probe.selector.tag, text: probe.selector.text } } : {}),
        ...(request.navigation ? { navigation: activity.navigations.at(-1) ?? null } : {}),
        ...(lastHmr ? { hmr: { kind: lastHmr.kind, detail: lastHmr.detail } } : {}),
      };
    }
    if (now >= deadline) {
      const seen = verdict.waiting.join("; ") + (probeError && !probe ? `; last page read failed: ${probeError}` : "");
      return {
        ok: false,
        error: `Timed out after ${request.timeoutMs} ms waiting for ${describeConditions(request)}. Seen: ${seen}.`,
        waitedMs: now - startedAt,
        url: probe?.href ?? null,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(TICK_MS, Math.max(0, deadline - now))));
  }
}
