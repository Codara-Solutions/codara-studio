// A Firefox for the background page in Node: the WebExtension APIs
// background.js uses, with tabs, permissions and cookies the test sets,
// and every listener the page registers recorded by its event's name. The
// link never reaches a real Codara: the page's port probe fails and its
// WebSocket never opens; a test hands it a socket of its own (liveLink).

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const EXTENSION_ORIGIN = "moz-extension://test-uuid/";

class InertSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor() {
    this.readyState = InertSocket.CONNECTING;
  }
  send() {}
  close() {
    this.readyState = InertSocket.CLOSED;
  }
}

/** A fake `browser` (also `chrome`): `tabs` by id, granted site access, and a cookies.getAll the test can hold. */
export function fakeBrowser({ tabs = [], local = {}, getAll = async () => [] } = {}) {
  const listeners = new Map();
  const event = (name) => ({
    addListener: (fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    removeListener: (fn) => listeners.set(name, (listeners.get(name) ?? []).filter((other) => other !== fn)),
    hasListener: (fn) => (listeners.get(name) ?? []).includes(fn),
  });
  const events = (namespace, names) => Object.fromEntries(names.map((name) => [name, event(`${namespace}.${name}`)]));
  const area = (data) => ({
    get: async (defaults) => structuredClone({ ...defaults, ...data }),
    set: async (patch) => void Object.assign(data, structuredClone(patch)),
  });
  const open = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const calls = { getAll: [], sendMessage: [] };
  const fake = {
    tabs: open,
    calls,
    granted: true,
    getAll,
    beforeGet: null,
    listeners,
    api: {
      runtime: {
        id: "@codara-firefox",
        getManifest: () => ({ version: "0.1.0" }),
        getURL: (path) => `${EXTENSION_ORIGIN}${path}`,
        getBrowserInfo: async () => ({ name: "Firefox", version: "160.0" }),
        getPlatformInfo: async () => ({ os: "linux" }),
        ...events("runtime", ["onMessage", "onStartup", "onInstalled"]),
      },
      storage: { session: area({}), local: area({ ...local }), ...events("storage", ["onChanged"]) },
      tabs: {
        get: async (id) => {
          // Firefox answers as asked; a test can hold the answer on its way
          // (fake.beforeGet) and change things before the page reads it.
          const tab = open.get(id);
          const answer = tab ? { ...tab } : null;
          await fake.beforeGet?.(id);
          if (!answer) throw new Error(`Invalid tab ID: ${id}`);
          return answer;
        },
        query: async ({ windowId } = {}) => [...open.values()].filter((tab) => windowId === undefined || tab.windowId === windowId).map((tab) => ({ ...tab })),
        update: async (id, change) => ({ ...open.get(id), ...change }),
        reload: async () => {},
        sendMessage: async (...args) => void calls.sendMessage.push(args),
        ...events("tabs", ["onCreated", "onActivated", "onAttached", "onDetached", "onUpdated", "onRemoved"]),
      },
      windows: events("windows", ["onRemoved"]),
      permissions: {
        contains: async () => fake.granted,
        getAll: async () => ({ origins: [], permissions: [] }),
        ...events("permissions", ["onAdded", "onRemoved"]),
      },
      scripting: {
        getRegisteredContentScripts: async () => [],
        registerContentScripts: async () => {},
        executeScript: async () => [],
      },
      webRequest: {
        filterResponseData: () => {
          throw new Error("No body filter in the test.");
        },
        ...events("webRequest", ["onBeforeRequest", "onSendHeaders", "onHeadersReceived", "onBeforeRedirect", "onResponseStarted", "onCompleted", "onErrorOccurred"]),
      },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
      alarms: { create: async () => {}, ...events("alarms", ["onAlarm"]) },
      cookies: {
        getAll: (query) => {
          calls.getAll.push(query);
          return fake.getAll(query);
        },
      },
    },
    /** Calls every listener of `name` with `args`, and waits for what they started. */
    async fire(name, ...args) {
      await Promise.all((listeners.get(name) ?? []).map((listener) => listener(...args)));
      await settle();
    },
    /** A message from the extension's own popup, as Firefox delivers it. */
    async popup(request) {
      const sender = { id: "@codara-firefox", url: `${EXTENSION_ORIGIN}popup.html` };
      const answers = (listeners.get("runtime.onMessage") ?? []).map((listener) => new Promise((resolve) => (listener(request, sender, resolve) ? null : resolve(undefined))));
      const answer = (await Promise.all(answers)).find((value) => value !== undefined);
      await settle();
      if (answer?.error) throw new Error(answer.error);
      return answer;
    },
  };
  return fake;
}

/** Lets the page's own promise chains run out. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Loads the assembled background page against `fake`, once per process
 * (it is a module). `restore()` ends its link and puts WebSocket and fetch
 * back; `chrome` stays the fake, for the page's timers still running.
 */
export async function loadBackground(assembled, fake) {
  const saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  Object.assign(globalThis, {
    chrome: fake.api,
    browser: fake.api,
    WebSocket: InertSocket,
    fetch: async () => {
      throw new Error("No Codara in the test.");
    },
  });
  const page = await import(pathToFileURL(join(assembled, "background.js")).href);
  await page.ready;
  await settle();
  return {
    page,
    async restore() {
      page.link.disconnect("idle");
      await settle();
      Object.assign(globalThis, saved);
    },
  };
}

/** Makes the page's link a sealed, paired session on a socket the test holds; what it sends is kept in `sent`. */
export function liveLink(link) {
  const sent = [];
  const socket = {
    readyState: InertSocket.OPEN,
    generation: 0,
    epoch: link.epoch,
    sealer: { seal: async (message) => message },
    send: (frame) => sent.push(frame),
    close() {
      this.readyState = InertSocket.CLOSED;
    },
  };
  link.socket = socket;
  link.status = { ...link.status, state: "connected" };
  return { socket, sent };
}
