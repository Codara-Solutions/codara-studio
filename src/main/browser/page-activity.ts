// What a tab's page has been doing, recorded from its DevTools session from
// the moment the tab opens: navigations, loading, requests in flight and
// dev-server hot updates. Waits (wait.ts) read it instead of polling the page,
// and agent actions stamp it, so "after your last action" has a meaning.

import type { CdpSession } from "./cdp-session";

export interface NavigationRecord {
  at: number;
  url: string;
  /** History API or fragment change, not a new document. */
  sameDocument: boolean;
}

export type HmrKind = "start" | "update" | "reload" | "error";

export interface HmrRecord {
  at: number;
  kind: HmrKind;
  detail: string;
  /**
   * The first record of an update cycle: a rebuild line, or the first
   * hot-update request after other signals. An error in a cycle stays its
   * verdict even when the dev client logs "updated" after it, as Vite does.
   */
  opens?: boolean;
  /** Recorded from a hot-update request rather than a console line. */
  request?: boolean;
}

export interface InFlightRequest {
  url: string;
  at: number;
  /** The document that made it; a request of a document that was replaced never reports its end. */
  loaderId: string;
}

export interface PageActivity {
  /** When an agent last acted on the tab (click, type, key, navigate, ...); 0 before any. */
  lastActionAt: number;
  navigations: NavigationRecord[];
  /** Main frame loading started / stopped (Page.frameStartedLoading / frameStoppedLoading). */
  loadingStartedAt: number;
  loadingStoppedAt: number;
  /** A main-frame navigation was requested and has not committed yet. */
  navigationRequestedAt: number;
  inFlight: Map<string, InFlightRequest>;
  /** Last time a request started or ended. */
  lastNetworkAt: number;
  hmr: HmrRecord[];
  lastHmrAt: number;
  /** The newest hot update record a finished hmr wait already reported (the next wait looks past it), and whether it reported a failure. */
  hmrReported?: { at: number; failed: boolean };
}

const HISTORY_CAP = 30;

// Requests that stay open by design never let the network go idle.
const LONG_LIVED_TYPES = new Set(["EventSource", "WebSocket", "Ping"]);

// Console lines dev servers print around a hot update.
const HMR_CONSOLE: Array<[RegExp, HmrKind]> = [
  [/^\[vite\] (?:css )?hot updated:/i, "update"],
  [/^\[vite\] page reload/i, "reload"],
  [/^\[vite\] (?:Internal Server Error|error|failed to reload)/i, "error"],
  [/^\[hmr\] failed to reload/i, "error"],
  [/^\[Fast Refresh\] rebuilding/i, "start"],
  [/^\[Fast Refresh\] done/i, "update"],
  [/^\[Fast Refresh\] performing full reload/i, "reload"],
  [/^\[HMR\] (?:Checking for updates|Waiting for update signal)/i, "start"],
  [/^\[HMR\] (?:Updated modules|App is up to date|Nothing hot updated)/i, "update"],
  [/^\[HMR\] (?:Cannot apply update|The following modules couldn't be hot updated|Reloading)/i, "reload"],
  [/^\[webpack-dev-server\] App updated\. Recompiling/i, "start"],
  [/^\[webpack-dev-server\] (?:App updated|Nothing changed)/i, "update"],
  [/^\[webpack-dev-server\] (?:Errors while compiling|Warnings while compiling)/i, "error"],
  [/^\[parcel\] .*(?:Built|Updated)/i, "update"],
  [/^\[parcel\] .*(?:Build failed|error)/i, "error"],
];

// Requests a dev server's client makes for an update.
const HMR_REQUEST = /\.hot-update\.(?:json|js)(?:\?|$)|[?&]t=\d{10,}|\/_next\/static\/webpack\/[^/]+\.hot-update/;

export function classifyHmrConsole(text: string): HmrKind | null {
  const trimmed = text.replace(/^%c/, "").trim();
  for (const [pattern, kind] of HMR_CONSOLE) if (pattern.test(trimmed)) return kind;
  return null;
}

export function isHmrRequest(url: string): boolean {
  return HMR_REQUEST.test(url);
}

const activities = new WeakMap<CdpSession, PageActivity>();

export function pageActivity(session: CdpSession): PageActivity {
  let activity = activities.get(session);
  if (!activity) {
    activity = {
      lastActionAt: 0,
      navigations: [],
      loadingStartedAt: 0,
      loadingStoppedAt: 0,
      navigationRequestedAt: 0,
      inFlight: new Map(),
      lastNetworkAt: 0,
      hmr: [],
      lastHmrAt: 0,
    };
    activities.set(session, activity);
  }
  return activity;
}

/** An agent is about to act on the tab. */
export function noteAgentAction(session: CdpSession): void {
  pageActivity(session).lastActionAt = Date.now();
}

function pushCapped<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > HISTORY_CAP) list.shift();
}

const recording = new WeakSet<CdpSession>();

export function startPageActivity(session: CdpSession): void {
  if (recording.has(session)) return;
  recording.add(session);
  const activity = pageActivity(session);
  let mainFrameId: string | null = null;
  const isMain = (frameId: unknown, parentId?: unknown) => {
    if (typeof frameId !== "string") return false;
    if (parentId === undefined) return mainFrameId === null || frameId === mainFrameId;
    return !parentId;
  };
  const hmr = (kind: HmrKind, detail: string, request = false) => {
    const at = Date.now();
    const previous = activity.hmr.at(-1);
    const opens = kind === "start" || (request && !previous?.request && previous?.kind !== "start");
    activity.lastHmrAt = at;
    pushCapped(activity.hmr, { at, kind, detail: detail.slice(0, 200), ...(opens ? { opens } : {}), ...(request ? { request } : {}) });
  };
  // Frame events can arrive before a main-frame navigation names the main
  // frame (the session attaches after the first load); until then an
  // iframe's loading or history change would pass for the page's own.
  session.send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree").then((result) => {
    const id = result?.frameTree?.frame?.id;
    if (mainFrameId === null && typeof id === "string") mainFrameId = id;
  }, () => {});

  session.on("Page.frameNavigated", (params) => {
    const frame = (params.frame ?? {}) as { id?: string; parentId?: string; url?: string; urlFragment?: string; loaderId?: string };
    if (frame.parentId || typeof frame.id !== "string") return;
    if (frame.loaderId) {
      for (const [requestId, request] of activity.inFlight) if (request.loaderId !== frame.loaderId) activity.inFlight.delete(requestId);
    }
    mainFrameId = frame.id;
    activity.navigationRequestedAt = 0;
    pushCapped(activity.navigations, { at: Date.now(), url: `${frame.url ?? ""}${frame.urlFragment ?? ""}`, sameDocument: false });
  });
  session.on("Page.navigatedWithinDocument", (params) => {
    if (!isMain(params.frameId)) return;
    pushCapped(activity.navigations, { at: Date.now(), url: typeof params.url === "string" ? params.url : "", sameDocument: true });
  });
  session.on("Page.frameRequestedNavigation", (params) => {
    if (isMain(params.frameId)) activity.navigationRequestedAt = Date.now();
  });
  session.on("Page.frameStartedLoading", (params) => {
    if (isMain(params.frameId)) activity.loadingStartedAt = Date.now();
  });
  session.on("Page.frameStoppedLoading", (params) => {
    if (!isMain(params.frameId)) return;
    activity.loadingStoppedAt = Date.now();
    activity.navigationRequestedAt = 0;
  });

  session.on("Network.requestWillBeSent", (params) => {
    const requestId = String(params.requestId ?? "");
    const request = (params.request ?? {}) as { url?: string };
    const url = typeof request.url === "string" ? request.url : "";
    activity.lastNetworkAt = Date.now();
    if (isHmrRequest(url)) hmr("update", url, true);
    if (typeof params.type === "string" && LONG_LIVED_TYPES.has(params.type)) return;
    if (/^(?:data|blob|about):/.test(url)) return;
    activity.inFlight.set(requestId, { url, at: Date.now(), loaderId: typeof params.loaderId === "string" ? params.loaderId : "" });
  });
  const finished = (params: Record<string, unknown>) => {
    activity.inFlight.delete(String(params.requestId ?? ""));
    activity.lastNetworkAt = Date.now();
  };
  session.on("Network.loadingFinished", finished);
  session.on("Network.loadingFailed", finished);
  session.on("Network.requestServedFromCache", finished);
  session.onDetach(() => activity.inFlight.clear());

  // Runtime.enable replays the messages the page already logged, with their
  // original timestamps, whenever the session enables it again; a replayed
  // hot update line is old news and must not satisfy (or fail) a new wait.
  const seen = new Set<string>();
  const firstSeen = (params: Record<string, unknown>, text: string) => {
    if (typeof params.timestamp !== "number") return true;
    const key = `${params.timestamp}|${text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > HISTORY_CAP * 4) seen.delete(seen.values().next().value as string);
    return true;
  };
  session.on("Runtime.consoleAPICalled", (params) => {
    const args = Array.isArray(params.args) ? (params.args as Array<{ value?: unknown; subtype?: string; description?: string }>) : [];
    const first = typeof args[0]?.value === "string" ? (args[0].value as string) : "";
    const rest = args.slice(1).map((arg) => (typeof arg.value === "string" ? arg.value : "")).join(" ");
    // A dev client reports a failed update by logging the error object
    // itself ("SyntaxError: ..."), then a line of its own.
    if (params.type === "error" && args[0]?.subtype === "error" && Date.now() - activity.lastHmrAt <= 2_000) {
      const description = (args[0].description ?? "").split("\n")[0];
      if (description && firstSeen(params, description)) hmr("error", description);
      return;
    }
    const kind = classifyHmrConsole(first);
    if (!kind) return;
    const detail = `${first.replace(/%c/g, "")} ${rest}`.trim();
    if (firstSeen(params, detail)) hmr(kind, detail);
  });
  session.on("Runtime.exceptionThrown", (params) => {
    // A failed hot update usually surfaces as an exception right after it.
    if (Date.now() - activity.lastHmrAt > 2_000) return;
    const details = (params.exceptionDetails ?? {}) as { text?: string; exception?: { description?: string } };
    const detail = details.exception?.description?.split("\n")[0] ?? details.text ?? "exception";
    if (firstSeen(params, detail)) hmr("error", detail);
  });

  session.hold("Page");
}
