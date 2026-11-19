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
  PRESENCE_IDLE_MS,
  PRESENCE_INSTALL,
  PRESENCE_STOPPED_MS,
  PRESENCE_WORLD,
  hidesPresence,
  holdsPresence,
  newerSettings,
  pointerOf,
  presenceCall,
  presenceClick,
  pendingAfterAck,
  presenceSettings,
  presenceView,
  presenceWorldError,
  stopCopyFrom,
  stopPending,
  stoppedAgentsOn,
  withoutPresenceNodes,
} from "./lib/presence.js";
import {
  DEFAULT_BLOCKED_SITES,
  DEFAULT_PORTS,
  LINK_PATH,
  agentGroupTitle,
  agentTabId,
  badgeTitle,
  blockingRule,
  carriedSession,
  cdpPermission,
  childSessionError,
  closeTabError,
  commandUrl,
  groupForAgents,
  isRestrictedUrl,
  isTabShared,
  openedTabAnswer,
  parseBlockedSites,
  reachOf,
  reachPatch,
  USAGE_ACTIVE_MS,
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
  // tabId -> [{ key, name }]: Codara's list of agents the user stopped, as
  // Codara last sent it. Replaced, never merged: Codara owns the list.
  stoppedAgents: {},
  // Stops and give backs Codara has not confirmed yet: [{ id, op, tabId, key, name }].
  pendingStops: [],
  // Tabs Codara refuses after it could not read its saved stops: "all" or ids.
  pausedTabs: [],
  // This browser session's id: stops never outlive it (tab ids are reused).
  browserSession: null,
};
const LOCAL_DEFAULTS = {
  token: null,
  linkId: null,
  blockedSites: DEFAULT_BLOCKED_SITES,
  allowOpen: false,
  ports: null,
  lastReload: null,
  linkScan: null,
  presence: { overlay: true, glow: true, at: 0 },
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
  if (typeof state.browserSession !== "string") {
    state.browserSession = crypto.randomUUID();
    await chrome.storage.session.set({ browserSession: state.browserSession });
  }
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
  onConnected: () => {
    // Stops pressed while Codara was away go first; their tabs relay nothing until Codara confirms.
    void ready.then(() => sendPending());
    void reportTabs();
    void ready.then(() => link.send({ type: "presence_settings", ...presenceSettings(state.presence) }));
  },
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

// Codara's link closed, or another took its place, while the request
// waited: nothing it asked for happens to a tab.
function stillAsked(link) {
  if (link && !link.live()) throw new Error("Codara's link to this browser closed before this ran.");
}

async function handleRequest(request, link) {
  await ready;
  stillAsked(link);
  switch (request.type) {
    case "attach":
      await attachFor(request.tabId, link);
      return {};
    case "detach":
      await detachTab(Number(request.tabId));
      return {};
    case "cdp":
      return relayCommand(request, link);
    case "open":
      return openTab(request, link);
    case "close": {
      const tabId = Number(request.tabId);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error(`${agentTabId(tabId)} is closed.`);
      const refused = closeTabError(tab, shareChoice(), state.agentTabs, rules);
      if (refused) throw new Error(refused);
      stillAsked(link);
      await detachTab(tab.id);
      stillAsked(link);
      await chrome.tabs.remove(tab.id);
      return {};
    }
    case "activate": {
      const tab = await usableTab(request.tabId);
      stillAsked(link);
      await chrome.tabs.update(tab.id, { active: true });
      return {};
    }
    default:
      throw new Error(`Unknown request ${request.type}.`);
  }
}

// Attaches in flight per tab. One that finishes after its link closed lets
// go again, and a newer link's attach on that tab waits until it has.
const attaching = new Map();

async function attachFor(requestedTabId, link) {
  const tabId = (await usableTab(requestedTabId)).id;
  const before = attaching.get(tabId);
  const attach = (async () => {
    await before;
    // Checked again after the wait: the user may have unshared the tab, or
    // blocked its site, meanwhile.
    await usableTab(tabId);
    if (state.attached.includes(tabId)) return;
    stillAsked(link);
    await chrome.debugger.attach({ tabId }, "1.3");
    if (link && !link.live()) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      stillAsked(link);
    }
    await save({ attached: withValue(state.attached, tabId) });
    void refresh();
    void drawPresence(tabId);
  })();
  const settled = attach.catch(() => {});
  attaching.set(tabId, settled);
  try {
    await attach;
  } finally {
    if (attaching.get(tabId) === settled) attaching.delete(tabId);
  }
}

async function relayCommand(request, link) {
  const child = childSessionError(request);
  if (child) throw new Error(child);
  const tab = await usableTab(request.tabId);
  const method = String(request.method ?? "");
  const permission = cdpPermission(method);
  if (permission === "never") throw new Error(`${method} is not available on tabs of your own browser.`);
  if (permission === "storage" && !state.storageTabs.includes(tab.id)) {
    throw new Error(
      `Cookies and site storage of ${agentTabId(tab.id)} need the user's permission: turn on "Read and change cookies and storage here" for this tab in the Codara extension popup.`,
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
  // The overlay's own world is not the agent's to use.
  if (stopPending(state.pendingStops, tab.id)) {
    throw new Error(`The user pressed Stop on ${agentTabId(tab.id)}; Codara has not confirmed it yet, so nothing runs there. Do not retry; ask the user.`);
  }
  const reserved = presenceWorldError(method, request.params, hiddenFor(tab.id));
  if (reserved) throw new Error(reserved);
  const send = async () => {
    stillAsked(link);
    return (await chrome.debugger.sendCommand({ tabId: tab.id }, method, request.params ?? {})) ?? {};
  };
  // Always: a recording's end brings the overlay back even if it went quiet meanwhile.
  if (method === "Page.stopScreencast") return stopScreencast(tab.id, send);
  if (!presence.has(tab.id)) return send();
  if (method === "Page.startScreencast") return startScreencast(tab.id, send);
  if (holdsPresence(method)) {
    // The pill lets clicks through while this runs (at most 2 s), no longer.
    const point = pointerOf(method, request.params);
    await inWorld(tab.id, presenceCall("hold", true, point?.x ?? null, point?.y ?? null, point?.press ?? false));
    try {
      return await send();
    } finally {
      await inWorld(tab.id, presenceCall("hold", false));
    }
  }
  if (!hidesPresence(method)) return send();
  return withoutPresence(tab.id, send);
}

// Captures in flight per tab, a running screencast counting as one: the
// overlay comes back after the last one ends.
const capturing = new Map();
const screencasts = new Set();

async function concealFor(tabId) {
  capturing.set(tabId, (capturing.get(tabId) ?? 0) + 1);
  const hidden = (await inWorld(tabId, presenceCall("conceal", true))) === true || (await inWorld(tabId, presenceCall("conceal", true))) === true;
  if (!hidden) {
    await revealAfter(tabId);
    throw new Error("The page did not answer in time, so Codara could not keep its agent overlay out of this capture. Try again.");
  }
}

async function revealAfter(tabId) {
  const left = (capturing.get(tabId) ?? 1) - 1;
  if (left > 0) capturing.set(tabId, left);
  else {
    capturing.delete(tabId);
    await inWorld(tabId, presenceCall("conceal", false));
  }
}

/** What the agent captures is the page as it is: the overlay is out until every capture ends. */
async function withoutPresence(tabId, send) {
  await concealFor(tabId);
  try {
    return await send();
  } finally {
    await revealAfter(tabId);
  }
}

/** A recording keeps the overlay out of every frame until it stops. */
async function startScreencast(tabId, send) {
  if (screencasts.has(tabId)) return send();
  await concealFor(tabId);
  try {
    const answer = await send();
    screencasts.add(tabId);
    return answer;
  } catch (error) {
    await revealAfter(tabId);
    throw error;
  }
}

async function stopScreencast(tabId, send) {
  try {
    return await send();
  } finally {
    if (screencasts.delete(tabId)) await revealAfter(tabId);
    else if (!capturing.has(tabId) && worlds.has(tabId)) await inWorld(tabId, presenceCall("conceal", false));
  }
}

// ── The agent on the page ───────────────────────────────────────────────────
//
// lib/presence.js draws it; this keeps, per attached tab, who drives it, the
// host's node ids (so forwarded DOM events leave it out) and the agents the
// user stopped. The stops also live in Codara, which refuses the agent.

const presence = new Map();
// tabId -> the isolated world's execution context id, installed.
const worlds = new Map();
// tabId -> { backendIds, nodeIds, contextId }: what DOM and Runtime events must not show.
const hiddenNodes = new Map();
const PRESENCE_POLL_MS = 400;
const PRESENCE_CALL_MS = 1_000;

function hiddenFor(tabId) {
  let hidden = hiddenNodes.get(tabId);
  if (!hidden) hiddenNodes.set(tabId, (hidden = { backendIds: new Set(), nodeIds: new Set(), contextId: null, uniqueIds: new Set() }));
  hidden.contextId = worlds.get(tabId) ?? hidden.contextId;
  return hidden;
}

async function worldOf(tabId) {
  const target = { tabId };
  let contextId = worlds.get(tabId);
  if (contextId) return contextId;
  const { frameTree } = await chrome.debugger.sendCommand(target, "Page.getFrameTree");
  ({ executionContextId: contextId } = await chrome.debugger.sendCommand(target, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: PRESENCE_WORLD }));
  // Installed once per world; a navigation makes a new world.
  const installed = await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: PRESENCE_INSTALL, contextId, returnByValue: true });
  if (installed?.exceptionDetails) throw new Error("presence");
  worlds.set(tabId, contextId);
  hiddenFor(tabId).contextId = contextId;
  return contextId;
}

/** Run an overlay call in the tab's isolated world, installing it first. Never throws. */
async function inWorld(tabId, expression) {
  const evaluate = async () => {
    const contextId = await worldOf(tabId);
    const answer = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression, contextId, returnByValue: true });
    if (answer?.exceptionDetails) throw new Error("presence");
    return answer?.result?.value;
  };
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), PRESENCE_CALL_MS);
  });
  try {
    return await Promise.race([evaluate().catch(() => (worlds.delete(tabId), evaluate())), deadline]);
  } catch {
    worlds.delete(tabId);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Learn the host's backend node id, by reference, so DOM events about it are dropped. */
async function learnHostNode(tabId) {
  const target = { tabId };
  try {
    const contextId = await worldOf(tabId);
    const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: presenceCall("hostNode"), contextId });
    if (!result?.objectId) return;
    const { node } = await chrome.debugger.sendCommand(target, "DOM.describeNode", { objectId: result.objectId });
    await chrome.debugger.sendCommand(target, "Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
    if (Number.isInteger(node?.backendNodeId)) hiddenFor(tabId).backendIds.add(node.backendNodeId);
  } catch {
    // The inline style still marks it.
  }
}

async function drawPresence(tabId) {
  await ready;
  const entry = presence.get(tabId);
  if (!entry || !state.attached.includes(tabId)) return;
  const settings = presenceSettings(state.presence);
  const ttl = (entry.state === "stopped" ? PRESENCE_STOPPED_MS : PRESENCE_IDLE_MS) + 2_000;
  // A capture or recording in flight: hidden before it is drawn.
  if (capturing.has(tabId)) await inWorld(tabId, presenceCall("conceal", true));
  const shown = await inWorld(tabId, presenceCall("show", presenceView({ ...entry, glow: settings.glow }), ttl));
  if (shown === "new") await learnHostNode(tabId);
}

async function clearPresence(tabId, { draw = true } = {}) {
  const entry = presence.get(tabId);
  // A recording still running keeps its record until stopScreencast, so a
  // pill drawn again before then stays out of its frames. Only a detach ends it.
  if (!draw) {
    screencasts.delete(tabId);
    capturing.delete(tabId);
    hiddenNodes.delete(tabId);
  }
  if (!entry) return;
  presence.delete(tabId);
  clearTimeout(entry.timer);
  clearInterval(entry.poll);
  if (draw && state.attached.includes(tabId)) await inWorld(tabId, presenceCall("remove"));
  worlds.delete(tabId);
}

function stoppedOn(tabId) {
  return stoppedAgentsOn(state.stoppedAgents, state.pendingStops, tabId);
}

/** Send every request Codara has not confirmed; they stay until it answers with its list. */
function sendPending() {
  for (const request of state.pendingStops) {
    link.send({ type: request.op === "stop" ? "presence_stop" : "presence_allow", id: request.id, tabId: request.tabId, key: request.key, name: request.name, session: state.browserSession });
  }
}

/** A Stop or a give back is a request to Codara, which owns the list. */
async function requestStop(op, tabId, key, name) {
  await save({ pendingStops: [...state.pendingStops, { id: crypto.randomUUID(), op, tabId, key, name: name ?? null }] });
  sendPending();
  scheduleRefresh();
}

/** Codara's list: the copy is replaced by it, and what it acknowledged stops waiting. */
async function applyStops(message) {
  const copy = stopCopyFrom(message);
  const pendingStops = typeof message.acked === "string" ? pendingAfterAck(state.pendingStops, message.acked) : state.pendingStops;
  const pausedTabs = message.paused === "all" ? "all" : Array.isArray(message.paused) ? message.paused.filter(Number.isInteger) : [];
  await save({ stoppedAgents: copy, pendingStops, pausedTabs });
  for (const [tabId, entry] of presence) {
    const stopped = stoppedOn(tabId).some((agent) => agent.key === entry.key);
    if (stopped && entry.state === "working") {
      // Confirmed: the pill says so now.
      entry.state = "stopped";
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => void clearPresence(tabId), PRESENCE_STOPPED_MS);
      void drawPresence(tabId);
    } else if (!stopped && entry.state === "stopped" && entry.key) {
      void clearPresence(tabId);
    }
  }
  scheduleRefresh();
}

/** An agent's call on a shared tab: name it on the page until it goes quiet. */
function notePresence(tabId, usage) {
  // Turned off: nothing is drawn, installed or polled in the page.
  if (!presenceSettings(state.presence).overlay) return;
  // A stopped agent is refused; its calls do not bring the pill back.
  if (usage.key && stoppedOn(tabId).some((agent) => agent.key === usage.key)) return;
  const previous = presence.get(tabId);
  if (previous?.state === "stopped" && previous.key === usage.key) return;
  const entry = previous ?? { history: new Map() };
  // A new agent on the pill gets a new random id: a Stop pressed on the old
  // one still stops the old one, and ids never repeat after a worker restart.
  if (!previous || previous.key !== usage.key || previous.state === "stopped") entry.id = crypto.randomUUID();
  Object.assign(entry, { key: usage.key, name: usage.name, runtime: usage.runtime, state: "working", keyless: !usage.key });
  entry.history.set(entry.id, { key: usage.key, name: usage.name });
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => void clearPresence(tabId), PRESENCE_IDLE_MS);
  // The pill's Stop stays in the page until read here.
  entry.poll ??= setInterval(() => void readPresenceClicks(tabId), PRESENCE_POLL_MS);
  presence.set(tabId, entry);
  void drawPresence(tabId);
}

async function readPresenceClicks(tabId) {
  // Nothing to read on a tab the extension no longer drives.
  if (!state.attached.includes(tabId)) return clearPresence(tabId, { draw: false });
  const clicks = await inWorld(tabId, presenceCall("take"));
  const entry = presence.get(tabId);
  if (!entry || !Array.isArray(clicks) || clicks.length === 0) return;
  let stoppedShown = false;
  for (const click of clicks.map(presenceClick)) {
    // Only ids this extension handed out count; a page cannot make them up.
    const agent = click && entry.history.get(click.id);
    if (!agent) continue;
    if (agent.key) {
      // Shown as stopped once Codara confirms; nothing runs on the tab meanwhile.
      if (!stoppedOn(tabId).some((stopped) => stopped.key === agent.key)) await requestStop("stop", tabId, agent.key, agent.name);
    } else {
      // An older Codara cannot refuse one agent: take the whole tab back.
      await handlePopup({ type: "stopTab", tabId });
      if (click.id === entry.id) stoppedShown = true;
    }
  }
  if (!stoppedShown || entry.state === "stopped") return;
  entry.state = "stopped";
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => void clearPresence(tabId), PRESENCE_STOPPED_MS);
  await drawPresence(tabId);
}

async function setPresence(settings) {
  await save({ presence: settings });
  for (const tabId of [...presence.keys()]) {
    if (settings.overlay) void drawPresence(tabId);
    else void clearPresence(tabId);
  }
}

async function openTab(request, link) {
  if (!state.allowOpen) {
    throw new Error('Opening tabs is off. The user can turn on "Open new tabs in a group" in the Codara extension popup.');
  }
  const url = String(request.url ?? "");
  if (!/^https?:\/\//i.test(url)) throw new Error("Agents can open http and https pages only.");
  const rule = blockingRule(url, rules);
  if (rule) throw new Error(`${url} is on a site agents may not use ("${rule.raw}" in the extension's blocked sites).`);
  const tab = await chrome.tabs.create({ url, active: request.active === true });
  await save({ shareTabs: withValue(state.shareTabs, tab.id), agentTabs: withValue(state.agentTabs, tab.id) });
  const group = await groupOpenedTab(tab, request.group, link);
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
async function groupOpenedTab(tab, requested, link) {
  const title = agentGroupTitle(requested);
  if (!title || !chrome.tabGroups) return null;
  return groupForAgents({
    tab,
    title,
    agentGroupIds: state.agentGroups,
    live: () => !link || link.live(),
    tabs: chrome.tabs,
    tabGroups: chrome.tabGroups,
    record: (groupId) => save({ agentGroups: withValue(state.agentGroups, groupId) }),
  });
}

const usageBadgeTimers = new Map();

// The last call Codara reported on a tab. name and runtime come from Codara
// 0.43 on; an older Codara sends only the agent's label.
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
  if (message.type === "usage" && typeof message.tabId === "number") {
    void save({
      usage: { ...state.usage, [message.tabId]: usageOf(message) },
    }).then(() => {
      // The button names the agent while it acts, then goes back to "an agent".
      const tabId = message.tabId;
      void updateTabBadge(tabId);
      if (state.attached.includes(tabId) || state.shareTabs.includes(tabId) || state.shareAll || state.shareWindows.length) {
        void chrome.tabs.get(tabId).then((tab) => {
          if (isTabShared(shareChoice(), tab) && !blockingRule(tab.url, rules)) notePresence(tabId, state.usage[tabId]);
        }, () => {});
      }
      clearTimeout(usageBadgeTimers.get(tabId));
      usageBadgeTimers.set(tabId, setTimeout(() => {
        usageBadgeTimers.delete(tabId);
        void updateTabBadge(tabId);
      }, USAGE_ACTIVE_MS + 100));
    });
  } else if (message.type === "presence_point" && typeof message.tabId === "number") {
    // Where an action by selector lands; mouse commands carry their own point.
    if (presence.has(message.tabId) && Number.isFinite(message.x) && Number.isFinite(message.y)) {
      void inWorld(message.tabId, presenceCall("move", Math.round(message.x), Math.round(message.y), message.press === true));
    }
  } else if (message.type === "presence_stops") {
    // Codara's stop list, the only truth: on connect and on every change.
    void ready.then(() => applyStops(message));
  } else if (message.type === "presence_settings") {
    // The newer change wins; tell Codara when ours is the newer one.
    void ready.then(async () => {
      const mine = presenceSettings(state.presence);
      const next = newerSettings(mine, message);
      if (next.at !== mine.at) await setPresence(next);
      else if (mine.at > presenceSettings(message).at) link.send({ type: "presence_settings", ...mine });
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
  await clearPresence(tabId);
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
  // The overlay's own world and node are not the page's.
  if (method === "Runtime.executionContextCreated" && params?.context?.name === PRESENCE_WORLD) {
    // Its unique id is refused to agents too.
    if (typeof params.context.uniqueId === "string") hiddenFor(source.tabId).uniqueIds.add(params.context.uniqueId);
    return;
  }
  if (method.startsWith("DOM.") || method === "Runtime.executionContextDestroyed") {
    params = withoutPresenceNodes(method, params, hiddenFor(source.tabId));
    if (!params) return;
  }
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
  // No debugger to remove it with: the overlay's own timer takes it down.
  void clearPresence(tabId, { draw: false });
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
  link.send({ type: "tabs", tabs: shared, allowOpen: state.allowOpen, session: state.browserSession });
}

async function updateBadge(tab) {
  const shared = isTabShared(shareChoice(), tab) && !blockingRule(tab.url, rules);
  const attached = state.attached.includes(tab.id);
  const text = !shared ? "" : attached ? "AI" : "ON";
  await chrome.action.setBadgeText({ tabId: tab.id, text }).catch(() => {});
  if (text) await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: attached ? "#b45309" : "#15803d" }).catch(() => {});
  const title = badgeTitle({ shared, attached, usage: state.usage[tab.id], now: Date.now() });
  await chrome.action.setTitle({ tabId: tab.id, title }).catch(() => {});
}

async function updateBadges() {
  await ready;
  for (const tab of await chrome.tabs.query({})) await updateBadge(tab);
}

/** The button of one tab, after an agent's call on it. */
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
chrome.tabs.onReplaced.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  // A new document drops the overlay with its isolated world: draw it again.
  if (change.status !== undefined && presence.has(tabId)) {
    worlds.delete(tabId);
    if (change.status === "complete") void drawPresence(tabId);
  }
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
// A closed window's sharing goes with it: window ids are not reused within a
// session, but the list should say what is really shared.
chrome.windows.onRemoved.addListener(async (windowId) => {
  await ready;
  if (state.shareWindows.includes(windowId)) await save({ shareWindows: without(state.shareWindows, windowId) });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  const usage = { ...state.usage };
  delete usage[tabId];
  const stoppedAgents = { ...state.stoppedAgents };
  delete stoppedAgents[tabId];
  const pendingStops = state.pendingStops.filter((request) => request.tabId !== tabId);
  await save({
    stoppedAgents,
    pendingStops,
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

function describeTab(tab, fileAccess = true) {
  const rule = blockingRule(tab.url, rules);
  const url = tab.url ?? tab.pendingUrl;
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    agentId: agentTabId(tab.id),
    title: tab.title ?? "",
    url: tab.url ?? tab.pendingUrl ?? "",
    shared: isTabShared(shareChoice(), tab),
    // Why Chrome keeps the extension off this tab: its own pages, or a local
    // file while "Allow access to file URLs" is off.
    restricted: isRestrictedUrl(url) ? "browser" : isRestrictedUrl(url, { fileAccess }) ? "file" : false,
    blocked: rule?.raw ?? null,
    attached: state.attached.includes(tab.id),
    storage: state.storageTabs.includes(tab.id),
    openedByAgent: state.agentTabs.includes(tab.id),
    usage: state.usage[tab.id] ?? null,
    stoppedAgents: stoppedOn(tab.id),
    paused: state.pausedTabs === "all" || (Array.isArray(state.pausedTabs) && state.pausedTabs.includes(tab.id)),
  };
}

async function popupState(request) {
  const tabs = await chrome.tabs.query({});
  const current = typeof request.tabId === "number" ? tabs.find((tab) => tab.id === request.tabId) : null;
  const fileAccess = await chrome.extension.isAllowedFileSchemeAccess().catch(() => false);
  // Only open windows count; a closed window's id can stay in the list.
  const open = new Set(tabs.map((tab) => tab.windowId));
  const otherWindows = state.shareWindows.filter((id) => id !== request.windowId && open.has(id));
  return {
    status: link.status,
    paired: Boolean(state.token),
    shareAll: state.shareAll,
    windowShared: typeof request.windowId === "number" && state.shareWindows.includes(request.windowId),
    reach: reachOf(shareChoice(), request.windowId),
    otherWindows: otherWindows.length,
    // Tabs switched on one by one in other windows that are not shared whole.
    otherTabs: tabs.filter((tab) => tab.windowId !== request.windowId && !otherWindows.includes(tab.windowId) && state.shareTabs.includes(tab.id) && isTabShared(shareChoice(), tab)).length,
    allowOpen: state.allowOpen,
    presence: presenceSettings(state.presence),
    blockedSites: state.blockedSites,
    current: current ? describeTab(current, fileAccess) : null,
    shared: tabs.filter((tab) => isTabShared(shareChoice(), tab)).map((tab) => describeTab(tab, fileAccess)),
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
      // Ends the link at once, so a pairing Codara approves meanwhile is
      // not kept; the token is cleared after any pairing write in flight.
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
    case "giveBack":
      if (typeof request.key === "string") await requestStop("allow", Number(request.tabId), request.key);
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
      await setPresence(next);
      link.send({ type: "presence_settings", ...next });
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
