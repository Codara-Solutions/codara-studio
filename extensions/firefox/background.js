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

import { LinkClient } from "./lib/link-client.js";
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
  DEFAULT_BLOCKED_SITES,
  DEFAULT_PORTS,
  LINK_PATH,
  USAGE_ACTIVE_MS,
  agentTabId,
  badgeTitle,
  childSessionError,
  reachOf,
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
  if (!socket || !socket.sealer || socket.generation !== generation || !link.connected || !state?.token) return null;
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

async function save(patch) {
  await ready;
  Object.assign(state, patch);
  const session = {};
  const local = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key in SESSION_DEFAULTS) session[key] = value;
    else if (key in LOCAL_DEFAULTS) local[key] = value;
  }
  if ("blockedSites" in patch) rules = parseFirefoxBlockedSites(state.blockedSites);
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
    keepAwake(false);
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
        await save({ attached: withValue(state.attached, tab.id) });
        void refresh();
      }
      return {};
    }
    case "detach":
      await detachTab(Number(request.tabId));
      return {};
    case "cdp":
      return answerCommand(request);
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

async function answerCommand(request) {
  const child = childSessionError(request);
  if (child) throw new Error(child);
  const tab = await usableTab(request.tabId);
  const method = String(request.method ?? "");
  if (!state.attached.includes(tab.id)) throw new Error(`${agentTabId(tab.id)} is not attached.`);
  if (isDomainToggle(method)) return {};
  throw new Error(unsupportedMethodError(method));
}

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
    void save({ usage: { ...state.usage, [tabId]: usageOf(message) } }).then(() => {
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
      const mine = presenceSettings(state.presence);
      const next = newerSettings(mine, message);
      if (next.at !== mine.at) await save({ presence: next });
      else if (mine.at > presenceSettings(message).at) sendLive({ type: "presence_settings", ...mine });
    });
  } else if (message.type === "revoked") {
    void detachAll();
  }
}

// ── Attached tabs ───────────────────────────────────────────────────────────

async function detachTab(tabId) {
  if (!state.attached.includes(tabId)) return;
  await save({ attached: without(state.attached, tabId) });
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
chrome.tabs.onDetached.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
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
  if (state.shareWindows.includes(windowId)) await save({ shareWindows: without(state.shareWindows, windowId) });
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  const usage = { ...state.usage };
  delete usage[tabId];
  await save({
    shareTabs: without(state.shareTabs, tabId),
    stopped: without(state.stopped, tabId),
    storageTabs: without(state.storageTabs, tabId),
    agentTabs: without(state.agentTabs, tabId),
    attached: without(state.attached, tabId),
    usage,
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
    await save({ shareTabs: withValue(state.shareTabs, tabId), stopped: without(state.stopped, tabId) });
    return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const stillShared = stopNeedsMark(shareChoice(), tab);
  await save({
    shareTabs: without(state.shareTabs, tabId),
    storageTabs: without(state.storageTabs, tabId),
    stopped: stillShared ? withValue(state.stopped, tabId) : state.stopped,
  });
}

async function handlePopup(request) {
  await ready;
  switch (request.type) {
    case "state":
      if (request.opened === true) void link.wake();
      return popupState(request);
    case "connect":
      pairingWanted = true;
      generation += 1;
      // Firefox would unload the page while the user approves in Codara.
      keepAwakeWhilePairing();
      await link.connect({ pair: true });
      return popupState(request);
    case "unpair": {
      pairingWanted = false;
      generation += 1;
      // Closing waits for the sealed unpair frame to leave, so Codara forgets this browser too.
      const socket = link.socket;
      link.send({ type: "unpair" });
      await save({ token: null, linkId: null });
      await socket?.outbox?.catch(() => {});
      link.disconnect("idle");
      await detachAll();
      break;
    }
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
      await save(reachPatch(shareChoice(), request.reach, windowId, inWindow));
      if (request.reach !== "tabs") void link.wake();
      break;
    }
    case "stopAll":
      await save({ shareAll: false, shareWindows: [], shareTabs: [], stopped: [], storageTabs: [] });
      break;
    case "setStorage": {
      const tabId = Number(request.tabId);
      await save({ storageTabs: request.on === true ? withValue(state.storageTabs, tabId) : without(state.storageTabs, tabId) });
      break;
    }
    case "setAllowOpen":
      await save({ allowOpen: request.on === true });
      break;
    case "setPresence": {
      const mine = presenceSettings(state.presence);
      const next = {
        overlay: typeof request.overlay === "boolean" ? request.overlay : mine.overlay,
        glow: typeof request.glow === "boolean" ? request.glow : mine.glow,
        at: Math.max(Date.now(), mine.at + 1),
      };
      await save({ presence: next });
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
  for (const key of ["ports", "blockedSites", "allowOpen"]) {
    if (key in changes) state[key] = changes[key].newValue ?? LOCAL_DEFAULTS[key];
  }
  if ("blockedSites" in changes) rules = parseFirefoxBlockedSites(state.blockedSites);
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
