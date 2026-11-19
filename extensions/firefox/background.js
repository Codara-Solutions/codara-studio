// The event page: links this Firefox profile to Codara and lets agents use
// the tabs the user shared. Firefox gives extensions no debugger, so this
// page answers Codara's DevTools protocol requests itself, for the commands
// lib/firefox.js lists in the hello; Codara refuses every other one. Every
// request is checked here again (shared, not on a blocked site, not a page
// Firefox keeps extensions off), so the user's choices in the popup hold
// even if Codara asked for something else.
//
// Firefox unloads an idle event page, and traffic on its WebSocket does not
// count as activity (measured in Firefox 158, see README.md). While
// connected, each keep-alive tick makes one call into the browser, which
// does; an alarm reconnects after the page was unloaded anyway or Codara
// restarted. What the user chose lives in storage (session for this browser
// session, local for the pairing and the blocked sites), so a restarted page
// picks up where it left off.

import { AccessClock } from "./lib/access-clock.js";
import { BODY_FAILED, BODY_TYPES, BodyStore, NO_BODY, bodyPlan, copyBody } from "./lib/bodies.js";
import { consoleAddresses, consoleEvent } from "./lib/console.js";
import { STORAGE_WRITES, cookieGate, cookieUrls, readCookies, storageWriteRefusal } from "./lib/cookies.js";
import { LateReply, LinkClient } from "./lib/link-client.js";
import { failedEvent, finishedEvent, lateRedirectEnd, requestEvent, requestVisible, responseEvent } from "./lib/network.js";
import {
  NAVIGATE_BUSY_ERROR,
  noteNavigationChange,
  NAVIGATE_TIMEOUT_ERROR,
  answersNavigation,
  frameTree,
  freshPage,
  navigateAnswer,
  navigationPlan,
  startDeadline,
  navigateUrl,
  pageEvents,
} from "./lib/navigation.js";
import {
  CDP_METHODS,
  browserIdentity,
  isDomainToggle,
  isFirefoxRestrictedUrl,
  firefoxBlockingRule,
  isShareable,
  parseFirefoxBlockedSites,
  stopNeedsMark,
  unsupportedMethodError,
} from "./lib/firefox.js";
import {
  MOVED_ERROR,
  NO_ANSWER,
  PAGE_METHODS,
  accessError,
  accessKey,
  accessNeeds,
  accessRequest,
  accessRows,
  captureOptions,
  documentAddress,
  documentGuard,
  expressionAnswer,
  expressionScript,
  frameFailed,
  isPageChange,
  layoutMetrics,
  measureLayout,
  screenshotAnswer,
  unansweredAsks,
} from "./lib/page-tools.js";
import {
  DEFAULT_BLOCKED_SITES,
  DEFAULT_PORTS,
  LINK_PATH,
  USAGE_ACTIVE_MS,
  agentTabId,
  badgeTitle,
  childSessionError,
  reachOf,
  redactCdpEvent,
  reachPatch,
} from "./lib/policy.js";
import { newerSettings, presenceSettings } from "./lib/presence.js";

const SESSION_DEFAULTS = {
  shareAll: false,
  shareWindows: [],
  shareTabs: [],
  stopped: [],
  storageTabs: [],
  agentTabs: [],
  attached: [],
  usage: {},
  browserSession: null,
};
const LOCAL_DEFAULTS = {
  token: null,
  linkId: null,
  blockedSites: DEFAULT_BLOCKED_SITES,
  allowOpen: false,
  ports: null,
  linkScan: null,
  presence: { overlay: true, glow: true, at: 0 },
  // Permissions the popup asked the user for and Firefox has not granted
  // since: the user said no (or closed the question). The popup does not
  // ask again by itself; its button still does.
  asked: {},
};
const ALARM = "codara-link";
// A third of Firefox's default 30 s idle timeout.
const KEEP_AWAKE_MS = 10_000;
const PORT_PROBE_TIMEOUT_MS = 1_500;
const PAIRING_AWAKE_MS = 150_000;

let state = null;
// Every socket is stamped with the generation it was opened in; Connect and
// Disconnect start a new one. Work is done and reported only for the current
// link's own socket, sealed, of the current generation, while paired: nothing
// started on an older socket acts after the user's latest choice.
let generation = 0;
// The user pressed Connect and no Disconnect since (this page's lifetime only).
let pairingWanted = false;

class StampedWebSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    this.generation = generation;
  }
}

/** Send only on the live session (see liveSocket); the unpair frame is the one exception. */
function sendLive(message) {
  if (liveSocket()) link.send(message);
}

/** The link's socket, when it is the sealed, paired session of the current generation; else null. */
function liveSocket() {
  const socket = link.socket;
  // A link that has started closing is over: nothing new is copied for it.
  if (!socket || socket.readyState !== WebSocket.OPEN || !socket.sealer || socket.generation !== generation || !link.connected || !state?.token) return null;
  return socket;
}
let rules = parseFirefoxBlockedSites(DEFAULT_BLOCKED_SITES);
const ready = load();

async function load() {
  const [session, local] = await Promise.all([chrome.storage.session.get(SESSION_DEFAULTS), chrome.storage.local.get(LOCAL_DEFAULTS)]);
  // Nothing is attached to a page that just started: attaching is only a
  // mark here, and Codara drops its sessions with the socket the old page held.
  state = { ...SESSION_DEFAULTS, ...session, ...LOCAL_DEFAULTS, ...local, attached: [] };
  rules = parseFirefoxBlockedSites(state.blockedSites);
  if (typeof state.browserSession !== "string") state.browserSession = crypto.randomUUID();
  await chrome.storage.session.set({ attached: [], browserSession: state.browserSession });
}

// What a tab may share moved on: per tab its switch, attaching, sharing, its
// page or window; per window its sharing; for every tab sharing everything,
// the blocked sites, site access or the link. Stamped (lib/access-clock.js),
// so a cookie read that began before never goes out (tabCookies), even if
// the same access is given again meanwhile, while other tabs' and windows'
// changes leave it alone.
const access = new AccessClock();

/**
 * Applies a change to the extension's state and stores it. A change that
 * depends on the state is given as `(state) => patch`, worked out from the
 * state it is applied to in the same step: worked out before an await, it
 * could put back what another change took away meanwhile (a tab's cookie
 * switch turned off while another tab closed).
 */
async function save(update) {
  await ready;
  const patch = typeof update === "function" ? update(state) : update;
  access.save(state, patch);
  Object.assign(state, patch);
  const session = {};
  const local = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key in SESSION_DEFAULTS) session[key] = value;
    else if (key in LOCAL_DEFAULTS) local[key] = value;
  }
  if ("blockedSites" in patch) {
    rules = parseFirefoxBlockedSites(state.blockedSites);
    purgeBodies();
  }
  await Promise.all([
    Object.keys(session).length ? chrome.storage.session.set(session) : null,
    Object.keys(local).length ? chrome.storage.local.set(local) : null,
  ]);
}

const without = (list, value) => list.filter((item) => item !== value);
const withValue = (list, value) => (list.includes(value) ? list : [...list, value]);

function shareChoice() {
  return { all: state.shareAll, windows: state.shareWindows, tabs: state.shareTabs, stopped: state.stopped };
}

const shared = (tab) => isShareable(shareChoice(), tab);

const link = new LinkClient({
  WebSocket: StampedWebSocket,
  ports: async () => {
    await ready;
    return Array.isArray(state.ports) && state.ports.length ? state.ports : DEFAULT_PORTS;
  },
  hello: async () => ({
    browser: browserIdentity(await browser.runtime.getBrowserInfo().catch(() => null)),
    extension: { id: chrome.runtime.id, version: chrome.runtime.getManifest().version, features: [], capabilities: { cdp: CDP_METHODS } },
  }),
  loadPairing: async () => {
    await ready;
    return state.token && state.linkId ? { token: state.token, linkId: state.linkId } : null;
  },
  // A pairing is kept only while the user's Connect is the latest thing they
  // asked for: one finishing after Disconnect is dropped and closed.
  savePairing: async (token, linkId) => {
    if (!pairingWanted || link.socket?.generation !== generation) {
      link.disconnect("idle");
      throw new Error("Disconnected in the meantime.");
    }
    pairingWanted = false;
    await save({ token, linkId });
  },
  clearPairing: () => save({ token: null, linkId: null }),
  onRequest: handleRequest,
  onMessage: handleMessage,
  // A no-cors GET with nothing attached: Codara's link server answers it 404.
  probe: async (port) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PORT_PROBE_TIMEOUT_MS);
    try {
      await fetch(`http://127.0.0.1:${port}${LINK_PATH}`, { mode: "no-cors", credentials: "omit", cache: "no-store", signal: abort.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  },
  loadScan: async () => {
    await ready;
    return state.linkScan;
  },
  saveScan: (scan) => save({ linkScan: scan }),
  onConnected: () => {
    // A reconnect that was under way when the user pressed Disconnect, or a
    // session that is not sealed: neither may carry anything.
    if (!liveSocket()) {
      link.disconnect("idle");
      return;
    }
    keepAwake(true);
    void reportTabs();
    void ready.then(() => sendLive({ type: "presence_settings", ...presenceSettings(state.presence) }));
  },
  onDisconnected: () => {
    access.all();
    keepAwake(false);
    // Every body filter lets go at once, before the tabs are let go one by one.
    forgetAllBodies();
    void detachAll();
  },
});

// A call that goes through the browser's parent process resets the event
// page's idle timer; socket traffic alone does not.
let awakeTimer = null;
let pairingAwakeTimer = null;
function keepAwake(on) {
  clearInterval(awakeTimer);
  clearTimeout(pairingAwakeTimer);
  awakeTimer = on ? setInterval(() => void browser.runtime.getPlatformInfo().catch(() => {}), KEEP_AWAKE_MS) : null;
}

/** Awake for Codara's approval window (two minutes) and a little more, unless connected by then. */
function keepAwakeWhilePairing() {
  keepAwake(true);
  pairingAwakeTimer = setTimeout(() => {
    if (!link.connected) keepAwake(false);
  }, PAIRING_AWAKE_MS);
}

// ── Requests from Codara ────────────────────────────────────────────────────

async function usableTab(tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab) throw new Error(`${agentTabId(tabId)} is closed.`);
  if (!shared(tab)) throw new Error(`${agentTabId(tab.id)} is not shared with agents. Share it from the Codara extension popup first.`);
  const rule = firefoxBlockingRule(tab.url, rules);
  if (rule) throw new Error(`${agentTabId(tab.id)} is on a site agents may not use ("${rule.raw}" in the extension's blocked sites).`);
  return tab;
}

/** Why agents may not use a tab on this address (as usableTab says it), or null. */
function pageRefusal(tabId, url) {
  if (isFirefoxRestrictedUrl(url)) return `${agentTabId(tabId)} is not shared with agents. Share it from the Codara extension popup first.`;
  const rule = firefoxBlockingRule(url, rules);
  return rule ? `${agentTabId(tabId)} is on a site agents may not use ("${rule.raw}" in the extension's blocked sites).` : null;
}

/** Throws unless the socket a request came on is still the live one (see liveSocket). */
function stillLive(socket) {
  if (!socket || liveSocket() !== socket) throw new Error("This browser is no longer paired with Codara on this connection.");
}

async function handleRequest(request) {
  const socket = link.socket;
  await ready;
  stillLive(socket);
  switch (request.type) {
    case "attach": {
      const tab = await usableTab(request.tabId);
      stillLive(socket);
      if (!state.attached.includes(tab.id)) {
        // From the next millisecond: an entry logged in this one may predate the attachment.
        attachedSince.set(tab.id, Date.now() + 1);
        await save((now) => ({ attached: withValue(now.attached, tab.id) }));
        void refresh();
        // A page loaded before this heard "off": its hook starts keeping now, nothing from before.
        void switchConsole(tab.id);
      }
      return {};
    }
    case "detach":
      await detachTab(Number(request.tabId));
      return {};
    case "cdp":
      return answerCommand(request, socket);
    case "open":
    case "close":
      throw new Error("Opening and closing tabs is not available in Firefox yet. The user opens or closes the tab, and shares it from the Codara extension popup.");
    case "activate": {
      const tab = await usableTab(request.tabId);
      stillLive(socket);
      await chrome.tabs.update(tab.id, { active: true });
      return {};
    }
    default:
      throw new Error(`Unknown request ${request.type}.`);
  }
}

async function answerCommand(request, socket) {
  // Noted before the first look at the tab: whatever changes its access from
  // here on ends a read that holds it, even while the tab is looked up.
  const since = access.now();
  const lookedAt = lookStart();
  const child = childSessionError(request);
  if (child) throw new Error(child);
  const method = String(request.method ?? "");
  if (method === "Page.navigate") return navigateTab(Number(request.tabId), request.params ?? {}, socket);
  const tab = await usableTab(request.tabId);
  if (!state.attached.includes(tab.id)) throw new Error(`${agentTabId(tab.id)} is not attached.`);
  if (isDomainToggle(method)) {
    // A domain's events go to Codara from its enable on, as the debugger
    // sends them: on this request's own connection only.
    stillLive(socket);
    const [domain, verb] = method.split(".");
    const on = eventDomains.get(tab.id) ?? new Set();
    if (verb === "enable") on.add(domain);
    else on.delete(domain);
    eventDomains.set(tab.id, on);
    seeTab(tab, lookedAt);
    if (domain === "Page") pageOf(tab.id, tab.url);
    if (domain === "Network" && verb === "disable") forgetRequests(tab.id);
    if (domain === "Network" && verb === "enable") bodyFilters(tab.id, true);
    if (domain === "Runtime") await switchConsole(tab.id);
    return {};
  }
  if (method === "Network.getResponseBody") return responseBody(tab.id, request.params ?? {}, socket);
  if (method === "Network.getCookies") return tabCookies(tab.id, request.params ?? {}, socket, since);
  if (STORAGE_WRITES.includes(method)) throw new Error(storageWriteRefusal(method));
  if (method === "Page.getFrameTree") {
    const now = await stillUsable(tab.id, socket);
    return frameTree(now.id, now.url, pageOf(now.id, now.url).loaderId);
  }
  if (!PAGE_METHODS.includes(method)) throw new Error(unsupportedMethodError(method));
  const params = request.params !== null && typeof request.params === "object" ? request.params : {};
  for (const need of accessNeeds(method)) {
    if (!(await granted(need, tab.url))) throw new Error(accessError(need, tab.url, wasAsked(need, tab.url)));
  }
  switch (method) {
    case "Runtime.evaluate":
      return evaluateInPage(tab.id, params, socket);
    case "Page.getLayoutMetrics": {
      // Stamped before the page is pinned: any change from here on drops the reading.
      const loads = navigations.get(tab.id) ?? 0;
      const page = await pinDocument(tab.id, socket);
      const [frame] = await inDocument(page, () => chrome.scripting.executeScript({ target: page.target, func: measureLayout, args: [page.tab.url] }));
      const metrics = layoutMetrics(frame?.result);
      // The sizes of a page the tab has since left would frame a full-page capture wrongly.
      await stillOnPage(page.tab, loads, socket);
      return metrics;
    }
    case "Page.captureScreenshot": {
      const now = await stillUsable(tab.id, socket);
      // Firefox removes captureTab with access to all sites.
      if (typeof chrome.tabs.captureTab !== "function") throw new Error(accessError("allSites", now.url, wasAsked("allSites", now.url)));
      // captureTab takes a tab, not a document: an image taken while the tab
      // went elsewhere (a blocked site, say) is dropped.
      const loads = navigations.get(now.id) ?? 0;
      const image = await chrome.tabs.captureTab(now.id, captureOptions(params));
      await stillOnPage(now, loads, socket);
      return screenshotAnswer(image);
    }
  }
  throw new Error(unsupportedMethodError(method));
}

/**
 * Page.navigate: the address is checked right before Firefox loads it,
 * and the answer waits for the tab's change that answers it, as the
 * debugger's waits for the commit: the new document, Firefox's error page,
 * or the fragment reached.
 */
async function navigateTab(tabId, params, socket) {
  // One deadline for the whole answer, from the request's arrival, under the 30 s Codara waits.
  const deadline = startDeadline(NAVIGATE_WAIT_MS);
  if (params === null || typeof params !== "object") throw new Error("Page.navigate needs an absolute http or https url.");
  const checks = { isRestricted: isFirefoxRestrictedUrl, blockingRule: (address) => firefoxBlockingRule(address, rules) };
  navigateUrl(params, tabId, checks);
  // One navigation per tab, from before its first look at the tab until its
  // answer is sent: overlapping loads could not be told apart.
  if (navigating.has(tabId)) throw new Error(NAVIGATE_BUSY_ERROR);
  navigating.add(tabId);
  try {
    const now = await untilDeadline(stillUsable(tabId, socket), deadline);
    // Checked again with nothing awaited before the load: the user may have blocked the site meanwhile.
    const url = navigateUrl(params, now.id, checks);
    if (deadline.passed()) throw new Error(NAVIGATE_TIMEOUT_ERROR);
    const page = pageOf(now.id, now.url);
    const plan = navigationPlan(page, now.url, url);
    // A #fragment of Firefox's error page stays the error page: the failed load it is.
    if (plan === "error") return navigateAnswer(now.id, true, "failed", null);
    if (plan === "there") return navigateAnswer(now.id, true, "moved", null);
    const sameDocument = plan === "fragment";
    // The id the next document gets, also when it commits after the answer.
    const { nextLoaderId } = page;
    const waiter = waitForNavigation(now.id, { sameDocument, url, started: false }, deadline);
    try {
      await untilDeadline(plan === "reload" ? chrome.tabs.reload(now.id) : chrome.tabs.update(now.id, { url }), deadline);
    } catch (error) {
      waiter.done(null);
      throw error;
    }
    const kind = await waiter.answer;
    // A redirect may have taken the tab to a blocked site or a page Firefox
    // keeps extensions off, even if it left again since (the tab was let go then).
    if (waiter.target.refused) throw new Error(waiter.target.refused);
    await untilDeadline(stillUsable(now.id, socket), deadline);
    // Codara stops waiting at 30 s: an answer past the deadline is none.
    if (deadline.passed()) throw new Error(NAVIGATE_TIMEOUT_ERROR);
    return navigateAnswer(now.id, sameDocument, kind, nextLoaderId);
  } finally {
    navigating.delete(tabId);
  }
}

/**
 * The tab's navigation waiting for its answer: the change that answers it
 * (see answersNavigation), or null at the deadline or when the tab closes.
 */
function waitForNavigation(tabId, target, deadline) {
  let resolve;
  const waiter = {
    target,
    answer: new Promise((done) => (resolve = done)),
    done(kind) {
      clearTimeout(timer);
      // Only its own entry: a later navigation's stays.
      if (navigationWaiters.get(tabId) === waiter) navigationWaiters.delete(tabId);
      resolve(kind);
    },
  };
  const timer = setTimeout(() => waiter.done(null), deadline.left());
  navigationWaiters.set(tabId, waiter);
  return waiter;
}

function untilDeadline(promise, deadline) {
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(NAVIGATE_TIMEOUT_ERROR)), deadline.left())));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The tab's tracked page, its address filled in from a checked tab when not known yet. */
function pageOf(tabId, url = null) {
  const page = pages.get(tabId) ?? freshPage(newLoaderId);
  if (page.url === null && url) page.url = url;
  pages.set(tabId, page);
  return page;
}

const newLoaderId = () => crypto.randomUUID().replace(/-/g, "").toUpperCase();

/** The tab again, right before the extension acts in it: still shared, allowed, attached, and the request still live. */
async function stillUsable(tabId, socket) {
  stillLive(socket);
  const tab = await usableTab(tabId);
  stillLive(socket);
  if (!state.attached.includes(tab.id)) throw new Error(`${agentTabId(tab.id)} is not attached.`);
  return tab;
}

/** Throws unless the tab is still usable and on the page `before` was, with no page load since `loads`. */
async function stillOnPage(before, loads, socket) {
  const after = await stillUsable(before.id, socket);
  if (after.url !== before.url || (navigations.get(before.id) ?? 0) !== loads) throw new Error(MOVED_ERROR);
}

/**
 * The document the tab shows, if it is the page just checked (shared, not
 * blocked): every script for one request is bound to it by its id, so
 * Firefox itself refuses to run one in any other document, a reload of the
 * same address included. Read in the extension's own world.
 */
async function pinDocument(tabId, socket) {
  const tab = await stillUsable(tabId, socket);
  const [frame] = await inDocument({ tab }, () => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: documentAddress }));
  if (typeof frame?.documentId !== "string" || frame.result !== tab.url) throw new Error(MOVED_ERROR);
  return { tab, target: { tabId: tab.id, documentIds: [frame.documentId] } };
}

/** Firefox's own refusals as plain errors: the tab moved to a site not allowed, or left the pinned document. */
async function inDocument({ tab }, work) {
  try {
    return await work();
  } catch (error) {
    const message = String(error?.message);
    if (/missing host permission/i.test(message)) throw new Error(accessError("site", tab.url, wasAsked("site", tab.url)));
    if (/invalid documentid/i.test(message)) throw new Error(MOVED_ERROR);
    throw error;
  }
}

/**
 * Runtime.evaluate in the page's own world, once: the expression runs inside
 * a wrapper that returns its value or what it threw, as Codara's protocol
 * gives them (Firefox would give a thrown error empty).
 */
async function evaluateInPage(tabId, params, socket) {
  if (params.contextId !== undefined || params.uniqueContextId !== undefined) {
    throw new Error("Runtime.evaluate in another world or frame is not available in Firefox: agents use the tab's own page.");
  }
  const expression = String(params.expression ?? "");
  const awaitPromise = params.awaitPromise === true;
  // It runs in the document pinned here, on the address checked (see
  // documentGuard), and its answer leaves only while the tab is still shared
  // and allowed (the agent's own code may navigate it).
  const page = await pinDocument(tabId, socket);
  await stillUsable(tabId, socket);
  // Firefox removes the API when the user takes the permission back.
  if (!chrome.userScripts) throw new Error(accessError("scripts", page.tab.url, wasAsked("scripts", page.tab.url)));
  const moved = `codara-moved-${crypto.randomUUID()}`;
  const js = [{ code: documentGuard(page.tab.url, moved) }, { code: expressionScript(expression, { awaitPromise }) }];
  const [frame] = await inDocument(page, () => chrome.userScripts.execute({ js, target: page.target, world: "MAIN", injectImmediately: true }));
  await stillUsable(tabId, socket);
  if (!frame) throw new Error(`${agentTabId(tabId)} has no page to run the script in.`);
  if (frame.error === moved) throw new Error(MOVED_ERROR);
  return frameFailed(frame) ? NO_ANSWER : expressionAnswer(frame.result);
}

// ── Firefox permissions ─────────────────────────────────────────────────────

const NEED_NAMES = ["site", "scripts", "allSites"];

async function granted(need, url) {
  const request = accessRequest(need, url);
  return request ? chrome.permissions.contains(request).catch(() => false) : false;
}

function wasAsked(need, url) {
  return Boolean(state.asked?.[accessKey(need, url)]);
}

/** What the popup offers for a tab: the permissions still missing, each with its sentence and request. */
async function accessView(request) {
  const tab = typeof request.tabId === "number" ? await chrome.tabs.get(request.tabId).catch(() => null) : null;
  if (!tab || !accessRequest("site", tab.url) || isFirefoxRestrictedUrl(tab.url) || firefoxBlockingRule(tab.url, rules)) return { shared: false, rows: [] };
  const has = {};
  const asked = {};
  for (const need of NEED_NAMES) {
    has[need] = await granted(need, tab.url);
    asked[need] = wasAsked(need, tab.url);
  }
  const rows = accessRows({ url: tab.url, reach: reachOf(shareChoice(), request.windowId), has, asked });
  return {
    shared: shared(tab),
    rows: rows.map((row) => ({ ...row, tabId: tab.id, asked: asked[row.need], key: accessKey(row.need, tab.url), request: accessRequest(row.need, tab.url) })),
  };
}

const ASK_KEY = /^(?:scripts|allSites|site:https?:\/\/[^/\s]+\/\*)$/;

/** Forget the asks Firefox has granted since, so only a no is remembered. */
async function forgetGrantedAsks() {
  await ready;
  const granted = await chrome.permissions.getAll().catch(() => ({}));
  await save((now) => ({ asked: unansweredAsks(now.asked, granted) }));
}

// In line with the popup's actions, so a grant never overtakes the ask it
// answers. A read under way when access was given counts as changed too: it
// was checked against what was granted before.
// Site access given: a cookie read asks Firefox for it, so a read under way
// is asked again (scripts in pages alone change no read).
chrome.permissions.onAdded.addListener((added) => {
  if (added?.origins?.length) access.all();
  popupQueue = popupQueue.then(forgetGrantedAsks).catch(() => {});
});
// A site the user took back: no body kept from before goes out (reads check again too).
chrome.permissions.onRemoved.addListener(() => {
  access.all();
  bodies.purge(() => false);
});

const usageBadgeTimers = new Map();

function usageOf(message) {
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  const agent = text(message.agent, 120) || "An agent";
  return {
    agent,
    name: text(message.name, 60) || agent,
    runtime: /^[a-z0-9-]{1,24}$/.test(message.runtime ?? "") ? message.runtime : null,
    key: typeof message.key === "string" ? message.key.slice(0, 200) : null,
    tool: text(message.tool, 80),
    at: Number(message.at) || Date.now(),
  };
}

function handleMessage(message) {
  // Settings and usage only from the sealed session of the paired Codara,
  // never from whatever answers while a pairing waits for approval.
  if (message.type !== "revoked" && !liveSocket()) return;
  if (message.type === "usage" && typeof message.tabId === "number") {
    const tabId = message.tabId;
    const usage = usageOf(message);
    void save((now) => ({ usage: { ...now.usage, [tabId]: usage } })).then(() => {
      void updateTabBadge(tabId);
      clearTimeout(usageBadgeTimers.get(tabId));
      usageBadgeTimers.set(tabId, setTimeout(() => {
        usageBadgeTimers.delete(tabId);
        void updateTabBadge(tabId);
      }, USAGE_ACTIVE_MS + 100));
    });
  } else if (message.type === "presence_settings") {
    // The newer change wins; tell Codara when ours is the newer one.
    void ready.then(async () => {
      let mine = null;
      await save((now) => {
        mine = presenceSettings(now.presence);
        const next = newerSettings(mine, message);
        return next.at !== mine.at ? { presence: next } : {};
      });
      if (mine.at > presenceSettings(message).at) sendLive({ type: "presence_settings", ...mine });
    });
  } else if (message.type === "revoked") {
    void detachAll();
  }
}

// ── Attached tabs ───────────────────────────────────────────────────────────

async function detachTab(tabId) {
  eventDomains.delete(tabId);
  attachedSince.delete(tabId);
  forgetRequests(tabId);
  void switchConsole(tabId);
  if (!state.attached.includes(tabId)) return;
  await save((now) => ({ attached: without(now.attached, tabId) }));
  void refresh();
}

async function detachAll() {
  await ready;
  for (const tabId of [...state.attached]) await detachTab(tabId);
}

/** Detach every tab the user's choices no longer allow. */
async function enforceSharing() {
  for (const tabId of [...state.attached]) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !shared(tab) || firefoxBlockingRule(tab.url, rules)) {
      await detachTab(tabId);
      if (tab) sendLive({ type: "detached", tabId, reason: "unshared" });
    }
  }
}

// ── Console and network ─────────────────────────────────────────────────────

// Where each tab was last seen (window and address), so a request is
// checked against where its tab is now without waiting on Firefox.
const tabsSeen = new Map();
// When Firefox last told of each tab in an event (loaded, moved, closed). A
// lookup that began before that answers with an older view, and it never
// overwrites the event's: lookups pass the tick lookStart() gave as they began.
const tabsHeard = new Map();
let heardTicks = 0;
function heardOf(tabId) {
  tabsHeard.set(tabId, ++heardTicks);
}
const lookStart = () => heardTicks;
function seeTab(tab, lookedAt = Infinity) {
  if (!Number.isInteger(tab?.id) || (tabsHeard.get(tab.id) ?? 0) > lookedAt) return;
  tabsSeen.set(tab.id, { id: tab.id, windowId: tab.windowId, url: tab.url });
}

/** Whether Codara may get this tab's events: attached, shared where it is now, not on a blocked site. */
function eventsAllowed(tab) {
  return Boolean(state && tab && state.attached.includes(tab.id) && shared(tab) && !firefoxBlockingRule(tab.url, rules));
}

/**
 * The console hook's mode for a tab (console-hook.js): "on" sends, "wait"
 * keeps the page's last entries for Runtime.enable to replay, only while
 * the tab is attached and shared; "off" sends and keeps nothing.
 */
function consoleMode(tab) {
  if (!eventsAllowed(tab)) return "off";
  return eventsOn(tab.id, "Runtime") ? "on" : "wait";
}

// When each tab's current attachment began: the hook drops what a page
// logged before it. Unknown after the event page restarts, so then from
// its start.
const attachedSince = new Map();
const startedAt = Date.now() + 1;
const consoleAnswer = (tab) => ({ mode: consoleMode(tab), since: attachedSince.get(tab?.id) ?? startedAt });

/**
 * Tells the tab's console hook its mode. Turning it on also puts the hook
 * into a page loaded before it was registered (it guards against a second
 * copy); Firefox refuses where the extension may not use the site.
 */
async function switchConsole(tabId) {
  // Only the newest switch of a tab speaks, with the mode as it is when it does.
  const turn = (consoleSwitches.get(tabId) ?? 0) + 1;
  consoleSwitches.set(tabId, turn);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (consoleAnswer(tab).mode === "on") await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["console-hook.js"] }).catch(() => {});
  const now = await chrome.tabs.get(tabId).catch(() => null);
  if (consoleSwitches.get(tabId) !== turn) return;
  await chrome.tabs.sendMessage(tabId, { type: "codara-console", ...consoleAnswer(now) }, { frameId: 0 }).catch(() => {});
}
const consoleSwitches = new Map();

// The hook runs from document start on every site the user let the
// extension use, so it sees what a page logs before Codara asks.
chrome.scripting
  .getRegisteredContentScripts({ ids: ["codara-console"] })
  .then((found) => found.length || chrome.scripting.registerContentScripts([{ id: "codara-console", js: ["console-hook.js"], matches: ["<all_urls>"], runAt: "document_start", allFrames: false, persistAcrossSessions: false }]))
  .catch(() => {});

// At most this many console entries a second per tab, whatever its pages do.
const CONSOLE_PER_SECOND = 100;
const consoleBudgets = new Map();
function consoleBudget(tabId) {
  const second = Math.floor(Date.now() / 1000);
  const budget = consoleBudgets.get(tabId);
  if (budget?.second !== second) consoleBudgets.set(tabId, { second, count: 1 });
  else budget.count += 1;
  return consoleBudgets.get(tabId).count <= CONSOLE_PER_SECOND;
}

// Requests seen per id until they end: the request (sent to Codara or not
// yet), and the redirect response that led to its next hop. A request
// that never ends (it went where the extension may not look) is forgotten
// with the tab, or when too many are open.
const requests = new Map();
const REQUESTS_KEPT = 500;
function forgetAllBodies() {
  for (const tabId of [...bodyListeners.keys()]) bodyFilters(tabId, false);
  bodies.purge(() => false);
}
function forgetRequests(tabId) {
  for (const [id, seen] of requests) if (seen.details.tabId === tabId) requests.delete(id);
  bodies.forgetTab(tabId);
  bodyFilters(tabId, false);
}

// Response bodies (lib/bodies.js), kept only for the requests Codara sees,
// and only text responses (bodyPlan), decided once their headers are in.
// The filter needs a blocking listener; one registered at the top would
// hold every tab's requests while Firefox wakes this page, so each
// recorded tab gets its own, from Network.enable to its end (nothing is
// ever blocked: the listener only sets the copy).
const bodies = new BodyStore();
const bodyListeners = new Map();
function bodyFilters(tabId, on) {
  const listener = bodyListeners.get(tabId);
  if (on && !listener) {
    const keep = (details) => void (networkWanted(details) && keepBody(details));
    browser.webRequest.onHeadersReceived.addListener(keep, { urls: ["<all_urls>"], tabId, types: BODY_TYPES }, ["blocking", "responseHeaders"]);
    bodyListeners.set(tabId, keep);
  }
  if (!on && listener) {
    browser.webRequest.onHeadersReceived.removeListener(listener);
    bodyListeners.delete(tabId);
  }
}

function keepBody(details) {
  // Only a request in the log, this very hop (one that started while it was recorded), on the live link.
  if (requests.get(details.requestId)?.details.url !== details.url || !liveSocket()) return;
  const { url, documentUrl, originUrl, frameAncestors, type, tabId } = details;
  const request = { url, documentUrl, originUrl, frameAncestors, type, tabId };
  const plan = bodyPlan(details);
  if (!plan.keep) return bodies.skip(details.requestId, tabId, request, plan.reason);
  let filter;
  try {
    filter = browser.webRequest.filterResponseData(details.requestId);
  } catch {
    return bodies.skip(details.requestId, tabId, request, BODY_FAILED);
  }
  // Copied only while the tab may be (still shared and recorded, on the live link).
  copyBody(filter, bodies, { requestId: details.requestId, tabId, request }, () => networkWanted(details) && Boolean(liveSocket()));
}

/**
 * Network.getResponseBody: a body whose row Codara has, of this tab, still
 * shared and attached; its request is checked again as the log checks it
 * (its site, page, origin and frames), since the blocked sites may have
 * changed meanwhile.
 */
async function responseBody(tabId, params, socket) {
  await stillUsable(tabId, socket);
  const hop = await bodies.body(String(params.requestId ?? ""), tabId);
  const { request } = hop;
  // The user may have taken the site back meanwhile (taking it back later drops the body).
  const { protocol, hostname } = new URL(request.url);
  const allowed = await chrome.permissions.contains({ origins: [`${protocol}//${hostname}/*`] }).catch(() => false);
  await stillUsable(tabId, socket);
  if (!requestVisible(request, blockedUrl)) throw new Error(`The response of ${request.url} is from a site agents may not use (the extension's blocked sites).`);
  // Still the body kept for that request, its tab still recorded and shared,
  // on this link: asked again when the answer is built and once it is sealed.
  const still = () =>
    allowed && liveSocket() === socket && bodies.holds(hop) && eventsOn(tabId, "Network") && eventsAllowed(tabsSeen.get(tabId)) && requestVisible(request, blockedUrl);
  if (!still()) throw new Error(NO_BODY);
  // Built only when its turn to leave comes: one body copy at a time, never one that lost its access.
  return new LateReply(() => {
    if (!still()) throw new Error(NO_BODY);
    return bodies.answer(hop);
  }, still);
}

/**
 * Network.getCookies (lib/cookies.js): the tab's own site's cookies, from
 * its own cookie store, with its cookie switch on. Everything that allowed
 * the read is asked again when the answer leaves: the switch, the tab still
 * attached and shared on that site, the blocked sites, the site access and
 * the link.
 */
async function tabCookies(tabId, params, socket, since) {
  const lookedAt = lookStart();
  const tab = await stillUsable(tabId, socket);
  seeTab(tab, lookedAt);
  // Firefox names every tab's store; read without it, the default store
  // would answer for a container tab or a private window.
  if (typeof tab.cookieStoreId !== "string" || !tab.cookieStoreId) throw new Error(`Firefox did not say which cookie store ${agentTabId(tabId)} uses, so its cookies are not read.`);
  const storeId = tab.cookieStoreId;
  const urls = cookieUrls(params, tab.url);
  const refusal = cookieGate({
    urls,
    ref: agentTabId(tabId),
    // The window this request's own look found: had the tab moved since, its own stamp moved too.
    now: () => ({ changed: access.changedSince(since, tabId, tab.windowId), socket: liveSocket(), seen: tabsSeen.get(tabId), allowed: eventsAllowed(tabsSeen.get(tabId)), storageTabs: state.storageTabs, rules }),
  });
  const read = await readCookies(urls, {
    getAll: (url) => browser.cookies.getAll({ url, storeId }),
    refusal,
    // Firefox's own site access for the tab's site (every URL asked is on its host).
    // (asked only once the refusal passed, so the tab shows a web page).
    permitted: () => {
      const { protocol, hostname } = new URL(tab.url);
      return chrome.permissions.contains({ origins: [`${protocol}//${hostname}/*`] }).catch(() => false);
    },
    rules: () => rules,
  });
  const lookedAgain = lookStart();
  seeTab(await stillUsable(tabId, socket), lookedAgain);
  return new LateReply(read.build, read.still);
}

/** The blocked sites changed: bodies of requests the log would not show now go. */
function purgeBodies() {
  bodies.purge((request) => requestVisible(request, blockedUrl));
}

const blockedUrl = (url) => firefoxBlockingRule(url, rules) !== null;
function networkWanted(details) {
  return eventsOn(details.tabId, "Network") && eventsAllowed(tabsSeen.get(details.tabId)) && requestVisible(details, blockedUrl);
}

function sendNetwork(details, [method, params]) {
  // Cookies stay out unless the user turned on the cookie switch for this tab, as in Chrome.
  sendLive({ type: "cdp_event", tabId: details.tabId, method, params: redactCdpEvent(method, params, state.storageTabs.includes(details.tabId)) });
}

/**
 * The redirect response that led to this hop, if Codara may still see it
 * (its site may have been blocked since); otherwise the request ends here.
 */
function redirectOf(seen) {
  if (!seen.redirect || requestVisible(seen.redirect, blockedUrl)) return true;
  requestLost(seen.details, HIDDEN_REDIRECT);
  return false;
}

/**
 * Sends the hop's own event first if Firefox reported none with headers (a
 * cached load). Whether the request still goes on to Codara.
 */
function requestSent(details) {
  const seen = requests.get(details.requestId);
  if (!seen) return false;
  if (seen.sent) return true;
  if (!redirectOf(seen)) return false;
  sendNetwork(details, requestEvent(seen.details, { headers: [], redirect: seen.redirect, loaderId: loaderOf(seen.details) }));
  Object.assign(seen, { sent: true, open: true, redirect: null });
  return true;
}

/** Ends a request Codara will hear no more of: failed, if Codara has its row. */
function requestLost(details, why) {
  const seen = requests.get(details.requestId);
  requests.delete(details.requestId);
  bodies.drop(details.requestId);
  if (seen?.open) sendNetwork(details, failedEvent({ ...details, error: why }));
}

const loaderOf = (details) => (details.type === "main_frame" ? pageOf(details.tabId).nextLoaderId : pageOf(details.tabId).loaderId);
const ALL_URLS = { urls: ["<all_urls>"] };
const HIDDEN_REDIRECT = "Redirected to a site the extension may not show.";

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!networkWanted(details)) return;
  requests.set(details.requestId, { redirect: null, ...requests.get(details.requestId), details, sent: false });
  if (requests.size > REQUESTS_KEPT) {
    const [oldest] = requests.values();
    if (networkWanted(oldest.details)) requestLost(oldest.details, "Too many requests open at once to follow this one.");
    else {
      requests.delete(oldest.details.requestId);
      bodies.drop(oldest.details.requestId);
    }
  }
}, ALL_URLS);
chrome.webRequest.onSendHeaders.addListener((details) => {
  const seen = requests.get(details.requestId);
  if (!seen || seen.sent || !networkWanted(details) || !redirectOf(seen)) return;
  sendNetwork(details, requestEvent(details, { headers: details.requestHeaders, redirect: seen.redirect, loaderId: loaderOf(details) }));
  Object.assign(seen, { sent: true, open: true, redirect: null });
}, ALL_URLS, ["requestHeaders"]);
chrome.webRequest.onBeforeRedirect.addListener(async (details) => {
  const seen = requests.get(details.requestId);
  if (!seen || !networkWanted(details) || !requestSent(details)) return;
  Object.assign(seen, { redirect: details, sent: false });
  // The next hop goes where Codara may not look (a blocked site), or where
  // Firefox tells the extension nothing (a site it may not use): this
  // request ends here for Codara, its redirect response unsent.
  const next = { ...details, url: details.redirectUrl, documentUrl: details.type === "main_frame" ? details.redirectUrl : details.documentUrl };
  if (!requestVisible(next, blockedUrl)) return requestLost(details, HIDDEN_REDIRECT);
  const { protocol, hostname } = new URL(details.redirectUrl);
  const allowed = await chrome.permissions.contains({ origins: [`${protocol}//${hostname}/*`] }).catch(() => false);
  // Sharing is checked again: the tab may have left what was shared while Firefox answered.
  const ending = lateRedirectEnd({ allowed, seen, now: requests.get(details.requestId), redirect: details, wanted: networkWanted(details) });
  if (ending === "end") requestLost(details, HIDDEN_REDIRECT);
  else if (ending === "forget") {
    requests.delete(details.requestId);
    bodies.drop(details.requestId);
  }
}, ALL_URLS, ["responseHeaders"]);
chrome.webRequest.onResponseStarted.addListener((details) => {
  if (!requests.has(details.requestId) || !networkWanted(details) || !requestSent(details)) return;
  bodies.type(details.requestId, details.responseHeaders?.find((header) => header.name.toLowerCase() === "content-type")?.value);
  sendNetwork(details, responseEvent(details, loaderOf(details)));
  bodies.publish(details.requestId);
}, ALL_URLS, ["responseHeaders"]);
for (const [event, toEvent] of [[chrome.webRequest.onCompleted, finishedEvent], [chrome.webRequest.onErrorOccurred, failedEvent]]) {
  event.addListener((details) => {
    const shown = requests.has(details.requestId) && networkWanted(details) && requestSent(details);
    if (shown) sendNetwork(details, toEvent(details));
    // Firefox's word on the transfer: a body is given only after it completed, and only for a row Codara got the end of.
    if (shown) bodies.outcome(details.requestId, toEvent === finishedEvent);
    else bodies.drop(details.requestId);
    requests.delete(details.requestId);
  }, ALL_URLS);
}

// ── Tabs ────────────────────────────────────────────────────────────────────

let reportTimer = null;

/** Tell Codara which tabs agents may use. Unshared tabs are never sent, and a blocked one only as blocked. */
async function reportTabs() {
  await ready;
  const socket = liveSocket();
  if (!socket) return;
  const list = [];
  const tabs = await chrome.tabs.query({});
  if (liveSocket() !== socket) return;
  for (const tab of tabs) {
    if (!shared(tab)) continue;
    const blocked = firefoxBlockingRule(tab.url, rules) !== null;
    list.push({
      tabId: tab.id,
      windowId: tab.windowId,
      url: blocked ? "" : tab.url ?? "",
      title: blocked ? "" : tab.title ?? "",
      active: tab.active === true,
      attached: state.attached.includes(tab.id),
      blocked,
      storage: state.storageTabs.includes(tab.id),
      openedByAgent: state.agentTabs.includes(tab.id),
    });
  }
  // Opening tabs is not in Firefox yet, so Codara picks another browser for it.
  link.send({ type: "tabs", tabs: list, allowOpen: false, session: state.browserSession });
}

async function updateBadge(tab) {
  const usable = shared(tab) && !firefoxBlockingRule(tab.url, rules);
  const attached = state.attached.includes(tab.id);
  const text = !usable ? "" : attached ? "AI" : "ON";
  await chrome.action.setBadgeText({ tabId: tab.id, text }).catch(() => {});
  if (text) await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: attached ? "#b45309" : "#15803d" }).catch(() => {});
  await chrome.action.setTitle({ tabId: tab.id, title: badgeTitle({ shared: usable, attached, usage: state.usage[tab.id], now: Date.now() }) }).catch(() => {});
}

async function updateBadges() {
  await ready;
  for (const tab of await chrome.tabs.query({})) await updateBadge(tab);
}

async function updateTabBadge(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) await updateBadge(tab);
}

async function refresh() {
  await Promise.all([reportTabs(), updateBadges()]);
}

function scheduleRefresh() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => void refresh(), 250);
}

chrome.tabs.onCreated.addListener(scheduleRefresh);
chrome.tabs.onActivated.addListener(scheduleRefresh);
chrome.tabs.onAttached.addListener(scheduleRefresh);
// A tab moved to another window may have left what the user shared: no
// event of it goes on, and it is let go if so.
// Between windows a tab is in none: nothing of it goes on until it lands.
chrome.tabs.onDetached.addListener((tabId) => {
  access.tab(tabId);
  heardOf(tabId);
  const seen = tabsSeen.get(tabId);
  if (seen) seen.windowId = null;
  // Its bodies and requests go too (a hop that starts between windows is none
  // of Codara's), and the filters still copying let go.
  for (const [id, seen] of requests) if (seen.details.tabId === tabId) requests.delete(id);
  bodies.forgetTab(tabId);
});
chrome.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
  access.tab(tabId);
  heardOf(tabId);
  const seen = tabsSeen.get(tabId);
  if (seen) seen.windowId = newWindowId;
  await ready;
  await enforceSharing();
  await switchConsole(tabId);
});
chrome.tabs.onDetached.addListener(scheduleRefresh);
// Page changes per tab (loads and route changes), so a capture or a layout
// reading can tell the tab did not leave its page at any point meanwhile.
const navigations = new Map();
// Each tab's page (lib/navigation.js), the tabs whose page events Codara
// asked for, and the navigation waiting for each tab's answer.
const pages = new Map();
// The protocol domains whose events Codara asked for, per tab.
const eventDomains = new Map();
const eventsOn = (tabId, domain) => eventDomains.get(tabId)?.has(domain) === true;
const navigationWaiters = new Map();
const navigating = new Set();
const NAVIGATE_WAIT_MS = 25_000;

// A tab's changes that never say its page or access changed. Any other
// (a load starting with no address yet, a discard, a status) moves its stamp.
const COSMETIC_CHANGES = new Set(["title", "favIconUrl", "audible", "mutedInfo", "attention", "isArticle", "sharingState", "pinned", "autoDiscardable"]);
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (Object.keys(change).some((key) => !COSMETIC_CHANGES.has(key))) access.tab(tabId);
  heardOf(tabId);
  seeTab(tab);
  if (isPageChange(change)) navigations.set(tabId, (navigations.get(tabId) ?? 0) + 1);
  const { events, page, kind } = pageEvents(change, { id: tabId }, pageOf(tabId), newLoaderId, Date.now());
  pages.set(tabId, page);
  // Only for a tab Codara still may use: never a page on a blocked site, nor one Firefox keeps extensions off.
  if (events.length && state && eventsOn(tabId, "Page") && state.attached.includes(tabId) && shared(tab) && !firefoxBlockingRule(tab.url, rules)) {
    for (const [method, params] of events) sendLive({ type: "cdp_event", tabId, method, params });
  }
  const waiter = navigationWaiters.get(tabId);
  if (waiter) noteNavigationChange(waiter.target, kind, change, (address) => pageRefusal(tabId, address));
  if (waiter && answersNavigation(kind, change, waiter.target)) waiter.done(kind);
  if (change.url !== undefined) {
    await ready;
    if (state.attached.includes(tabId) && (firefoxBlockingRule(change.url, rules) || isFirefoxRestrictedUrl(change.url))) {
      await detachTab(tabId);
      sendLive({ type: "detached", tabId, reason: "blocked_site" });
    }
  }
  if (change.url !== undefined || change.title !== undefined || change.status !== undefined) scheduleRefresh();
});
chrome.windows.onRemoved.addListener(async (windowId) => {
  await ready;
  await save((now) => (now.shareWindows.includes(windowId) ? { shareWindows: without(now.shareWindows, windowId) } : {}));
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  access.tab(tabId);
  // Kept heard, so a lookup answered before the close does not bring the tab back.
  heardOf(tabId);
  tabsSeen.delete(tabId);
  attachedSince.delete(tabId);
  consoleSwitches.delete(tabId);
  consoleBudgets.delete(tabId);
  forgetRequests(tabId);
  navigations.delete(tabId);
  pages.delete(tabId);
  eventDomains.delete(tabId);
  navigationWaiters.get(tabId)?.done(null);
  navigating.delete(tabId);
  await save((now) => {
    const usage = { ...now.usage };
    delete usage[tabId];
    return {
      shareTabs: without(now.shareTabs, tabId),
      stopped: without(now.stopped, tabId),
      storageTabs: without(now.storageTabs, tabId),
      agentTabs: without(now.agentTabs, tabId),
      attached: without(now.attached, tabId),
      usage,
    };
  });
  scheduleRefresh();
});

// ── The popup and the options page ──────────────────────────────────────────

function describeTab(tab) {
  const rule = firefoxBlockingRule(tab.url, rules);
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    agentId: agentTabId(tab.id),
    title: tab.title ?? "",
    url: tab.url ?? "",
    shared: shared(tab),
    restricted: isFirefoxRestrictedUrl(tab.url) ? "browser" : false,
    blocked: rule?.raw ?? null,
    attached: state.attached.includes(tab.id),
    storage: state.storageTabs.includes(tab.id),
    openedByAgent: state.agentTabs.includes(tab.id),
    usage: state.usage[tab.id] ?? null,
    stoppedAgents: [],
    paused: false,
  };
}

async function popupState(request) {
  const tabs = await chrome.tabs.query({});
  const current = typeof request.tabId === "number" ? tabs.find((tab) => tab.id === request.tabId) : null;
  const open = new Set(tabs.map((tab) => tab.windowId));
  const otherWindows = state.shareWindows.filter((id) => id !== request.windowId && open.has(id));
  return {
    status: link.status,
    paired: Boolean(state.token),
    shareAll: state.shareAll,
    windowShared: typeof request.windowId === "number" && state.shareWindows.includes(request.windowId),
    reach: reachOf(shareChoice(), request.windowId),
    otherWindows: otherWindows.length,
    otherTabs: tabs.filter((tab) => tab.windowId !== request.windowId && !otherWindows.includes(tab.windowId) && state.shareTabs.includes(tab.id) && shared(tab)).length,
    allowOpen: false,
    presence: presenceSettings(state.presence),
    blockedSites: state.blockedSites,
    current: current ? describeTab(current) : null,
    shared: tabs.filter(shared).map(describeTab),
  };
}

async function setTabShared(tabId, on) {
  if (on) {
    await save((now) => ({ shareTabs: withValue(now.shareTabs, tabId), stopped: without(now.stopped, tabId) }));
    return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  await save((now) => ({
    shareTabs: without(now.shareTabs, tabId),
    storageTabs: without(now.storageTabs, tabId),
    stopped: stopNeedsMark(shareChoice(), tab) ? withValue(now.stopped, tabId) : now.stopped,
  }));
}

async function handlePopup(request) {
  await ready;
  switch (request.type) {
    case "state":
      if (request.opened === true) void link.wake();
      return popupState(request);
    case "access":
      return accessView(request);
    case "accessAsked":
      // The popup says so right before Firefox's question shows.
      if (typeof request.key !== "string" || !ASK_KEY.test(request.key)) throw new Error("Unknown permission.");
      await save((now) => ({ asked: { ...now.asked, [request.key]: Date.now() } }));
      return {};
    case "connect":
      pairingWanted = true;
      generation += 1;
      // Firefox would unload the page while the user approves in Codara.
      keepAwakeWhilePairing();
      await link.connect({ pair: true });
      return popupState(request);
    case "unpair":
      pairingWanted = false;
      generation += 1;
      // The shared client's Disconnect: the link ends at once (a pairing
      // Codara approves meanwhile is not kept), the sealed unpair frame
      // leaves so Codara forgets this browser too, and the token is cleared
      // after any pairing write in flight.
      await link.forget({ type: "unpair" });
      await detachAll();
      break;
    case "shareTab":
      await setTabShared(Number(request.tabId), request.on === true);
      if (request.on === true) void link.wake();
      break;
    case "stopTab":
      await setTabShared(Number(request.tabId), false);
      break;
    case "setReach": {
      const windowId = typeof request.windowId === "number" ? request.windowId : null;
      const inWindow = windowId === null ? [] : (await chrome.tabs.query({ windowId })).map((tab) => tab.id);
      await save(() => reachPatch(shareChoice(), request.reach, windowId, inWindow));
      if (request.reach !== "tabs") void link.wake();
      break;
    }
    case "stopAll":
      await save({ shareAll: false, shareWindows: [], shareTabs: [], stopped: [], storageTabs: [] });
      break;
    case "setStorage": {
      const tabId = Number(request.tabId);
      await save((now) => ({ storageTabs: request.on === true ? withValue(now.storageTabs, tabId) : without(now.storageTabs, tabId) }));
      break;
    }
    case "setAllowOpen":
      await save({ allowOpen: request.on === true });
      break;
    case "setPresence": {
      let next = null;
      await save((now) => {
        const mine = presenceSettings(now.presence);
        next = {
          overlay: typeof request.overlay === "boolean" ? request.overlay : mine.overlay,
          glow: typeof request.glow === "boolean" ? request.glow : mine.glow,
          at: Math.max(Date.now(), mine.at + 1),
        };
        return { presence: next };
      });
      sendLive({ type: "presence_settings", ...next });
      break;
    }
    case "setBlockedSites":
      await save({ blockedSites: typeof request.text === "string" ? request.text : DEFAULT_BLOCKED_SITES });
      break;
    default:
      throw new Error(`Unknown action ${request.type}.`);
  }
  await enforceSharing();
  await refresh();
  return popupState(request);
}

const OWN_PAGES = ["popup.html", "options.html"].map((page) => chrome.runtime.getURL(page));

/** The popup or the options page of this extension, never a script of it running in a web page. */
function fromOwnPage(sender) {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
  const page = sender.url.split(/[?#]/)[0];
  return OWN_PAGES.includes(page);
}

// One action at a time, in the order the user made them: a Stop all is never
// undone by an Everything that was still reading the tabs.
let popupQueue = Promise.resolve();

// The console hook in a page's own frame (console-hook.js): it may only ask
// its mode, and send what the page logged; the page's own data, checked
// and capped by lib/console.js, and dropped unless this tab is shared with
// Codara and Codara asked.
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id || fromOwnPage(sender) || !sender.tab || sender.frameId !== 0 || typeof sender.url !== "string") return false;
  if (firefoxBlockingRule(sender.url, rules) || isFirefoxRestrictedUrl(sender.url)) return false;
  if (request?.type === "codara-console-hello") {
    void ready.then(() => respond(consoleAnswer(sender.tab)));
    return true;
  }
  // An entry from before the tab's current attachment (a replay the hook
  // should have dropped) never goes on.
  const fresh = request?.entry?.at >= consoleAnswer(sender.tab).since;
  if (request?.type === "codara-console-entry" && fresh && consoleMode(sender.tab) === "on" && consoleBudget(sender.tab.id)) {
    const event = consoleEvent(request.entry);
    // A same-origin frame on a blocked path can log into this page: such an entry is dropped whole.
    const fromBlocked = event && consoleAddresses(event[1]).some((url) => firefoxBlockingRule(url, rules));
    if (event && !fromBlocked) sendLive({ type: "cdp_event", tabId: sender.tab.id, method: event[0], params: event[1] });
  }
  return false;
});

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (!fromOwnPage(sender) || !request || typeof request.type !== "string") return false;
  const run = popupQueue.then(() => handlePopup(request));
  popupQueue = run.catch(() => {});
  run.then(respond, (error) => respond({ error: error instanceof Error ? error.message : String(error) }));
  return true;
});

// The ports of a second Codara (or a test instance) are set with
// browser.storage.local.set({ ports: [...] }) from an extension page; they
// are searched at once.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !state) return;
  if ("blockedSites" in changes) access.all();
  for (const key of ["ports", "blockedSites", "allowOpen"]) {
    if (key in changes) state[key] = changes[key].newValue ?? LOCAL_DEFAULTS[key];
  }
  if ("blockedSites" in changes) {
    rules = parseFirefoxBlockedSites(state.blockedSites);
    purgeBodies();
  }
  if ("ports" in changes && !link.connected) void link.wake();
});

// ── Waking up ───────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void link.connect();
});
chrome.runtime.onStartup.addListener(() => void link.wake());
chrome.runtime.onInstalled.addListener(() => void link.wake());
void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
void ready.then(async () => {
  await link.connect();
  await updateBadges();
});

// For the tests' fake Firefox (test/fake-browser.mjs); Firefox ignores what
// an event page exports.
export { access, link, ready, tabsSeen };
