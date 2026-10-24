// The service worker: links this browser profile to Codara and lets agents
// drive the tabs the user shared, through chrome.debugger. Every request
// Codara relays is checked here again (shared, not on a blocked site, the
// cookie and storage permission), so the user's choices in the popup hold
// even if Codara asked for something else.
//
// Chrome suspends an idle MV3 worker. While connected the link pings every
// 20 s, which keeps it alive; an alarm reconnects after the browser restarts
// or the worker was stopped anyway. What the user chose lives in
// chrome.storage (session for this browser session, local for the pairing
// and the blocked sites), so a restarted worker picks up where it left off.

import { LinkClient } from "./lib/link-client.js";
import {
  DEFAULT_BLOCKED_SITES,
  DEFAULT_PORTS,
  LINK_PATH,
  agentGroupFor,
  agentGroupTitle,
  agentTabId,
  blockingRule,
  carriedSession,
  cdpPermission,
  childSessionError,
  closeTabError,
  commandUrl,
  isRestrictedUrl,
  isTabShared,
  openedTabAnswer,
  parseBlockedSites,
  redactCdpEvent,
  shouldReload,
  storageScopeError,
} from "./lib/policy.js";

const SESSION_DEFAULTS = {
  shareAll: false,
  shareWindows: [],
  shareTabs: [],
  stopped: [],
  storageTabs: [],
  agentTabs: [],
  agentGroups: [],
  attached: [],
  usage: {},
};
const LOCAL_DEFAULTS = {
  token: null,
  linkId: null,
  blockedSites: DEFAULT_BLOCKED_SITES,
  allowOpen: false,
  ports: null,
  lastReload: null,
  linkScan: null,
};
const RELOAD_CARRY = "reloadCarry";
const ALARM = "codara-link";
const OPEN_LOAD_TIMEOUT_MS = 15_000;
const PORT_PROBE_TIMEOUT_MS = 1_500;

let state = null;
let rules = parseBlockedSites(DEFAULT_BLOCKED_SITES);
const ready = load();

async function load() {
  const [stored, local, carry] = await Promise.all([
    chrome.storage.session.get(SESSION_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS),
    chrome.storage.local.get(RELOAD_CARRY),
  ]);
  let session = stored;
  // Back from a reload Codara asked for: what the user shared survives it.
  if (carry[RELOAD_CARRY] !== undefined) {
    const carried = carriedSession(carry[RELOAD_CARRY], Date.now());
    await chrome.storage.local.remove(RELOAD_CARRY);
    if (carried) {
      session = { ...SESSION_DEFAULTS, ...pick(carried, Object.keys(SESSION_DEFAULTS)), attached: [] };
      await chrome.storage.session.set(session);
    }
  }
  state = { ...SESSION_DEFAULTS, ...session, ...LOCAL_DEFAULTS, ...local };
  rules = parseBlockedSites(state.blockedSites);
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
  if ("blockedSites" in patch) rules = parseBlockedSites(state.blockedSites);
  await Promise.all([
    Object.keys(session).length ? chrome.storage.session.set(session) : null,
    Object.keys(local).length ? chrome.storage.local.set(local) : null,
  ]);
}

const pick = (object, keys) => Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
const without = (list, value) => list.filter((item) => item !== value);
const withValue = (list, value) => (list.includes(value) ? list : [...list, value]);

function shareChoice() {
  return { all: state.shareAll, windows: state.shareWindows, tabs: state.shareTabs, stopped: state.stopped };
}

function browserIdentity() {
  const brands = navigator.userAgentData?.brands ?? [];
  const known = ["Microsoft Edge", "Brave", "Opera", "Vivaldi", "Google Chrome", "Chromium"];
  const brand = known.map((name) => brands.find((entry) => entry.brand === name)).find(Boolean);
  const version = brand?.version ?? /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "";
  return { name: brand?.brand ?? "Chromium", version };
}

const link = new LinkClient({
  WebSocket,
  ports: async () => {
    await ready;
    return Array.isArray(state.ports) && state.ports.length ? state.ports : DEFAULT_PORTS;
  },
  hello: async () => ({
    browser: browserIdentity(),
    // "reload": this version reloads itself when Codara ships a newer one.
    extension: { id: chrome.runtime.id, version: chrome.runtime.getManifest().version, features: ["reload"] },
  }),
  loadPairing: async () => {
    await ready;
    return state.token && state.linkId ? { token: state.token, linkId: state.linkId } : null;
  },
  savePairing: (token, linkId) => save({ token, linkId }),
  clearPairing: () => save({ token: null, linkId: null }),
  onRequest: handleRequest,
  onMessage: handleMessage,
  onReload: (message) => void reloadForUpdate(message),
  // A no-cors GET with nothing attached: Codara's link server answers it
  // 404 and the opaque answer only says something listens. Unlike a
  // WebSocket that cannot connect, a fetch that cannot connect is not
  // written to the extension's Errors list.
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
  onConnected: () => void reportTabs(),
  onDisconnected: () => void detachAll(),
});

// ── Requests from Codara ────────────────────────────────────────────────────

async function usableTab(tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab) throw new Error(`${agentTabId(tabId)} is closed.`);
  if (!isTabShared(shareChoice(), tab)) {
    throw new Error(`${agentTabId(tab.id)} is not shared with agents. Share it from the Codara extension popup first.`);
  }
  const rule = blockingRule(tab.url, rules);
  if (rule) {
    throw new Error(`${agentTabId(tab.id)} is on a site agents may not use ("${rule.raw}" in the extension's blocked sites).`);
  }
  return tab;
}

async function handleRequest(request) {
  await ready;
  switch (request.type) {
    case "attach": {
      const tab = await usableTab(request.tabId);
      if (!state.attached.includes(tab.id)) {
        await chrome.debugger.attach({ tabId: tab.id }, "1.3");
        await save({ attached: withValue(state.attached, tab.id) });
        void refresh();
      }
      return {};
    }
    case "detach":
      await detachTab(Number(request.tabId));
      return {};
    case "cdp":
      return relayCommand(request);
    case "open":
      return openTab(request);
    case "close": {
      const tabId = Number(request.tabId);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error(`${agentTabId(tabId)} is closed.`);
      const refused = closeTabError(tab, shareChoice(), state.agentTabs, rules);
      if (refused) throw new Error(refused);
      await detachTab(tab.id);
      await chrome.tabs.remove(tab.id);
      return {};
    }
    case "activate": {
      const tab = await usableTab(request.tabId);
      await chrome.tabs.update(tab.id, { active: true });
      return {};
    }
    default:
      throw new Error(`Unknown request ${request.type}.`);
  }
}

async function relayCommand(request) {
  const child = childSessionError(request);
  if (child) throw new Error(child);
  const tab = await usableTab(request.tabId);
  const method = String(request.method ?? "");
  const permission = cdpPermission(method);
  if (permission === "never") throw new Error(`${method} is not available on tabs of your own browser.`);
  if (permission === "storage" && !state.storageTabs.includes(tab.id)) {
    throw new Error(
      `Cookies and site storage of ${agentTabId(tab.id)} need the user's permission: turn on "Allow cookie and storage access" for this tab in the Codara extension popup.`,
    );
  }
  if (permission === "storage") {
    const outside = storageScopeError(request.params, tab.url, rules);
    if (outside) throw new Error(outside);
  }
  const url = commandUrl(method, request.params);
  if (url) {
    if (isRestrictedUrl(url)) throw new Error(`Agents cannot open ${url} in your browser.`);
    const rule = blockingRule(url, rules);
    if (rule) throw new Error(`${url} is on a site agents may not use ("${rule.raw}" in the extension's blocked sites).`);
  }
  if (!state.attached.includes(tab.id)) throw new Error(`${agentTabId(tab.id)} is not attached.`);
  return (await chrome.debugger.sendCommand({ tabId: tab.id }, method, request.params ?? {})) ?? {};
}

async function openTab(request) {
  if (!state.allowOpen) {
    throw new Error('Opening tabs is off. The user can turn on "Let agents open new tabs" in the Codara extension popup.');
  }
  const url = String(request.url ?? "");
  if (!/^https?:\/\//i.test(url)) throw new Error("Agents can open http and https pages only.");
  const rule = blockingRule(url, rules);
  if (rule) throw new Error(`${url} is on a site agents may not use ("${rule.raw}" in the extension's blocked sites).`);
  const tab = await chrome.tabs.create({ url, active: request.active === true });
  await save({ shareTabs: withValue(state.shareTabs, tab.id), agentTabs: withValue(state.agentTabs, tab.id) });
  const group = await groupOpenedTab(tab, request.group);
  const deadline = Date.now() + OPEN_LOAD_TIMEOUT_MS;
  let current = tab;
  while (current && current.status !== "complete" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await chrome.tabs.get(tab.id).catch(() => null);
  }
  // The tab list goes out before the answer, so Codara knows the tab is
  // shared by the time the agent uses its id.
  await refresh();
  return { ...openedTabAnswer(tab.id, current, url, rules), ...(group ? { group } : {}) };
}

// Puts a tab an agent just opened in the agent's named group in its window,
// joining one the extension made with that title. Only that new tab moves, so
// no tab the user shared is ever grouped. A failure leaves it ungrouped.
async function groupOpenedTab(tab, requested) {
  const title = agentGroupTitle(requested);
  if (!title || !chrome.tabGroups) return null;
  try {
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    const existing = agentGroupFor(groups, state.agentGroups, title);
    if (existing) {
      await chrome.tabs.group({ groupId: existing.id, tabIds: [tab.id] });
      return existing.title;
    }
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title });
    await save({ agentGroups: withValue(state.agentGroups, groupId) });
    return title;
  } catch {
    return null;
  }
}

function handleMessage(message) {
  if (message.type === "usage" && typeof message.tabId === "number") {
    void save({
      usage: { ...state.usage, [message.tabId]: { agent: String(message.agent ?? "An agent"), tool: String(message.tool ?? ""), at: Number(message.at) || Date.now() } },
    });
  } else if (message.type === "revoked") {
    void detachAll();
  }
}

// Codara copied a newer version of this extension into the folder Chrome
// loads it from: reload to run it. Codara asks only over the sealed session
// (LinkClient passes nothing else on), and a reload that did not bring the
// new version is not tried again for a while, so it can never loop.
async function reloadForUpdate(message) {
  await ready;
  const target = typeof message.version === "string" ? message.version : "";
  const now = Date.now();
  if (!shouldReload(chrome.runtime.getManifest().version, target, state.lastReload, now)) return;
  const session = pick(state, Object.keys(SESSION_DEFAULTS));
  await save({ lastReload: { version: target, at: now } });
  await chrome.storage.local.set({ [RELOAD_CARRY]: { at: now, session } });
  link.disconnect("idle");
  await detachAll();
  chrome.runtime.reload();
}

// ── Debugger sessions ───────────────────────────────────────────────────────

async function detachTab(tabId) {
  if (!state.attached.includes(tabId)) return;
  await save({ attached: without(state.attached, tabId) });
  await chrome.debugger.detach({ tabId }).catch(() => {});
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
    if (!tab || !isTabShared(shareChoice(), tab) || blockingRule(tab.url, rules)) {
      await detachTab(tabId);
      if (tab) link.send({ type: "detached", tabId, reason: "unshared" });
    }
  }
}

function isBlockedEvent(method, params) {
  if (!params || typeof params !== "object") return false;
  if (typeof params.documentURL === "string" && blockingRule(params.documentURL, rules)) return true;
  if (method === "Network.requestWillBeSent" && params.type === "Document" && blockingRule(params.request?.url, rules)) return true;
  return false;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!state || typeof source.tabId !== "number" || !state.attached.includes(source.tabId)) return;
  // A frame's or worker's session never passed the blocked-sites check.
  if (source.sessionId) return;
  if (method === "Page.frameNavigated" && !params?.frame?.parentId && blockingRule(params?.frame?.url, rules)) {
    void detachTab(source.tabId).then(() => link.send({ type: "detached", tabId: source.tabId, reason: "blocked_site" }));
    return;
  }
  if (isBlockedEvent(method, params)) return;
  link.send({
    type: "cdp_event",
    tabId: source.tabId,
    method,
    params: redactCdpEvent(method, params, state.storageTabs.includes(source.tabId)),
  });
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  await ready;
  const tabId = source.tabId;
  if (typeof tabId !== "number" || !state.attached.includes(tabId)) return;
  const patch = { attached: without(state.attached, tabId) };
  // Cancel on Chrome's debugging bar is the user saying stop: every tab
  // agents could use is stopped until the user shares it again.
  if (reason === "canceled_by_user") {
    const shared = (await chrome.tabs.query({})).filter((tab) => isTabShared(shareChoice(), tab)).map((tab) => tab.id);
    Object.assign(patch, { shareAll: false, shareWindows: [], shareTabs: [], stopped: [...new Set([...state.stopped, ...shared])] });
  }
  await save(patch);
  link.send({ type: "detached", tabId, reason });
  void refresh();
});

// ── Tabs ────────────────────────────────────────────────────────────────────

let reportTimer = null;

/** Tell Codara which tabs agents may use. Unshared tabs are never sent, and a blocked one only as blocked. */
async function reportTabs() {
  await ready;
  if (!link.connected) return;
  const tabs = await chrome.tabs.query({});
  const shared = [];
  for (const tab of tabs) {
    if (!isTabShared(shareChoice(), tab)) continue;
    const blocked = blockingRule(tab.url, rules) !== null;
    shared.push({
      tabId: tab.id,
      windowId: tab.windowId,
      url: blocked ? "" : tab.url ?? tab.pendingUrl ?? "",
      title: blocked ? "" : tab.title ?? "",
      active: tab.active === true,
      attached: state.attached.includes(tab.id),
      blocked,
      storage: state.storageTabs.includes(tab.id),
      openedByAgent: state.agentTabs.includes(tab.id),
    });
  }
  link.send({ type: "tabs", tabs: shared, allowOpen: state.allowOpen });
}

async function updateBadges() {
  await ready;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const shared = isTabShared(shareChoice(), tab) && !blockingRule(tab.url, rules);
    const attached = state.attached.includes(tab.id);
    const text = !shared ? "" : attached ? "AI" : "ON";
    await chrome.action.setBadgeText({ tabId: tab.id, text }).catch(() => {});
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: attached ? "#b45309" : "#15803d" }).catch(() => {});
      await chrome.action.setTitle({ tabId: tab.id, title: attached ? "Codara: an agent is using this tab" : "Codara: agents may use this tab" }).catch(() => {});
    } else {
      await chrome.action.setTitle({ tabId: tab.id, title: "Codara" }).catch(() => {});
    }
  }
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
chrome.tabs.onReplaced.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.url !== undefined) {
    await ready;
    if (state.attached.includes(tabId) && blockingRule(change.url, rules)) {
      await detachTab(tabId);
      link.send({ type: "detached", tabId, reason: "blocked_site" });
    }
  }
  if (change.url !== undefined || change.title !== undefined || change.status !== undefined) scheduleRefresh();
});
chrome.tabGroups?.onRemoved.addListener(async (group) => {
  await ready;
  if (state.agentGroups.includes(group.id)) await save({ agentGroups: without(state.agentGroups, group.id) });
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
  const rule = blockingRule(tab.url, rules);
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    agentId: agentTabId(tab.id),
    title: tab.title ?? "",
    url: tab.url ?? tab.pendingUrl ?? "",
    shared: isTabShared(shareChoice(), tab),
    restricted: isRestrictedUrl(tab.url ?? tab.pendingUrl),
    blocked: rule?.raw ?? null,
    attached: state.attached.includes(tab.id),
    storage: state.storageTabs.includes(tab.id),
    openedByAgent: state.agentTabs.includes(tab.id),
    usage: state.usage[tab.id] ?? null,
  };
}

async function popupState(request) {
  const tabs = await chrome.tabs.query({});
  const current = typeof request.tabId === "number" ? tabs.find((tab) => tab.id === request.tabId) : null;
  return {
    status: link.status,
    paired: Boolean(state.token),
    shareAll: state.shareAll,
    windowShared: typeof request.windowId === "number" && state.shareWindows.includes(request.windowId),
    allowOpen: state.allowOpen,
    blockedSites: state.blockedSites,
    current: current ? describeTab(current) : null,
    shared: tabs.filter((tab) => isTabShared(shareChoice(), tab)).map(describeTab),
  };
}

async function setTabShared(tabId, on) {
  if (on) {
    await save({ shareTabs: withValue(state.shareTabs, tabId), stopped: without(state.stopped, tabId) });
    return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const stillShared = tab && isTabShared({ ...shareChoice(), tabs: without(state.shareTabs, tabId) }, tab);
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
      await link.connect({ pair: true });
      return popupState(request);
    case "unpair":
      link.send({ type: "unpair" });
      await save({ token: null, linkId: null });
      link.disconnect("idle");
      await detachAll();
      break;
    case "shareTab":
      await setTabShared(Number(request.tabId), request.on === true);
      if (request.on === true) void link.wake();
      break;
    case "stopTab":
      await setTabShared(Number(request.tabId), false);
      break;
    case "shareWindow": {
      const windowId = Number(request.windowId);
      if (request.on === true) {
        const inWindow = (await chrome.tabs.query({ windowId })).map((tab) => tab.id);
        await save({ shareWindows: withValue(state.shareWindows, windowId), stopped: state.stopped.filter((id) => !inWindow.includes(id)) });
        void link.wake();
      } else {
        await save({ shareWindows: without(state.shareWindows, windowId) });
      }
      break;
    }
    case "shareAll":
      await save(request.on === true ? { shareAll: true, stopped: [] } : { shareAll: false });
      if (request.on === true) void link.wake();
      break;
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

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  // Only this extension's own pages (the popup and the options page) steer it.
  if (sender.id !== chrome.runtime.id || !request || typeof request.type !== "string") return false;
  handlePopup(request).then(respond, (error) => respond({ error: error instanceof Error ? error.message : String(error) }));
  return true;
});

// The ports of a second Codara (or a test instance) are set from the service
// worker's console with chrome.storage.local.set({ ports: [...] }); they are
// searched at once, without reloading the extension.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !state) return;
  for (const key of ["ports", "blockedSites", "allowOpen"]) {
    if (key in changes) state[key] = changes[key].newValue ?? LOCAL_DEFAULTS[key];
  }
  if ("blockedSites" in changes) rules = parseBlockedSites(state.blockedSites);
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
  // Debugger sessions do not outlive a browser restart; drop stale marks.
  const live = new Set((await chrome.debugger.getTargets()).filter((target) => target.attached && typeof target.tabId === "number").map((target) => target.tabId));
  await save({ attached: state.attached.filter((tabId) => live.has(tabId)) });
  await link.connect();
  await updateBadges();
});

// The service worker's own console (chrome://extensions, "Inspect views")
// and the test suite reach the same actions as the popup through this.
globalThis.codara = { handlePopup, link, state: () => state };
