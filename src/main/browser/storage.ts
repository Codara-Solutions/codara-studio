// Storage of a tab's origin: cookies, localStorage, sessionStorage,
// IndexedDB and Cache Storage, read, set and cleared over the tab's session.
// Page storage is reached through the page itself (the main world), cookies
// and forced clears through the protocol, so a Codara tab and a shared
// Chrome tab behave the same. On a Chrome tab, which carries the user's own
// logged-in sessions, cookies are read only and nothing is cleared beyond
// the page's own local and session storage.

import type { BrowserTarget } from "./targets";

export class StorageParamsError extends Error {}

export const STORAGE_AREAS = ["cookies", "local", "session", "indexeddb", "cache"] as const;
export type StorageArea = (typeof STORAGE_AREAS)[number];

const AREA_ALIASES: Record<string, StorageArea> = {
  cookie: "cookies",
  cookies: "cookies",
  local: "local",
  localstorage: "local",
  session: "session",
  sessionstorage: "session",
  indexeddb: "indexeddb",
  idb: "indexeddb",
  cache: "cache",
  caches: "cache",
  cachestorage: "cache",
};

const VALUE_CHARS = 200;
const ITEMS_SHOWN = 100;
const REDACTED = "[redacted]";
// Keys and values that usually hold a credential.
const SECRET_KEY = /token|auth|secret|passw|session|jwt|credential|api[-_]?key/i;
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

export function parseStorageArea(raw: unknown): StorageArea | null {
  if (raw === undefined || raw === null || raw === "" || raw === "all") return null;
  const area = AREA_ALIASES[String(raw).replace(/[\s_-]/g, "").toLowerCase()];
  if (!area) throw new StorageParamsError(`area must be one of ${STORAGE_AREAS.join(", ")}.`);
  return area;
}

interface PageOrigin {
  url: string;
  origin: string | null;
}

async function pageOrigin(target: BrowserTarget): Promise<PageOrigin> {
  const info = await target.info();
  let origin: string | null = null;
  try {
    const parsed = new URL(info.url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") origin = parsed.origin;
  } catch {
    origin = null;
  }
  return { url: info.url, origin };
}

function cut(value: string): string {
  return value.length > VALUE_CHARS ? `${value.slice(0, VALUE_CHARS)}... (${value.length} chars)` : value;
}

function maskStored(key: string, value: string, redact: boolean): string {
  if (redact && (SECRET_KEY.test(key) || JWT.test(value.trim()))) return `${REDACTED} (${value.length} chars)`;
  return cut(value);
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size?: number;
  httpOnly: boolean;
  secure: boolean;
  session?: boolean;
  sameSite?: string;
  partitionKey?: unknown;
}

async function cookiesFor(target: BrowserTarget, url: string): Promise<CdpCookie[]> {
  const result = await target.session.send<{ cookies?: CdpCookie[] }>("Network.getCookies", { urls: [url] });
  return result?.cookies ?? [];
}

function describeCookie(cookie: CdpCookie, redact: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: cookie.name,
    value: redact ? `${REDACTED} (${cookie.value.length} chars)` : cut(cookie.value),
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session || !(cookie.expires > 0) ? "session" : new Date(cookie.expires * 1000).toISOString(),
  };
  if (cookie.httpOnly) out.httpOnly = true;
  if (cookie.secure) out.secure = true;
  if (cookie.sameSite) out.sameSite = cookie.sameSite;
  return out;
}

// Runs in the page; returns plain data only.
const PAGE_STORAGE = String.raw`(async (op) => {
  const areaOf = (name) => (name === "session" ? window.sessionStorage : window.localStorage);
  const dump = (store) => {
    const items = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      items.push([key, store.getItem(key) ?? ""]);
    }
    return items;
  };
  const withTimeout = (promise, ms, fallback) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
  if (op.kind === "read") {
    const out = {};
    if (op.areas.includes("local")) {
      try { out.local = dump(window.localStorage); } catch (error) { out.local = { error: String(error && error.message || error) }; }
    }
    if (op.areas.includes("session")) {
      try { out.session = dump(window.sessionStorage); } catch (error) { out.session = { error: String(error && error.message || error) }; }
    }
    if (op.areas.includes("indexeddb")) {
      try {
        const dbs = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
        out.indexeddb = [];
        for (const info of dbs.slice(0, 50)) {
          const entry = { name: info.name, version: info.version, stores: [] };
          const opened = await withTimeout(new Promise((resolve) => {
            const request = indexedDB.open(info.name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
          }), 2000, null);
          if (opened) {
            const names = [...opened.objectStoreNames].slice(0, 50);
            for (const name of names) {
              const count = await withTimeout(new Promise((resolve) => {
                try {
                  const request = opened.transaction(name, "readonly").objectStore(name).count();
                  request.onsuccess = () => resolve(request.result);
                  request.onerror = () => resolve(null);
                } catch { resolve(null); }
              }), 2000, null);
              entry.stores.push({ name, count });
            }
            opened.close();
          }
          out.indexeddb.push(entry);
        }
      } catch (error) { out.indexeddb = { error: String(error && error.message || error) }; }
    }
    if (op.areas.includes("cache")) {
      try {
        if (typeof caches === "undefined") throw new Error("Cache Storage needs a secure context (https or localhost)");
        out.cache = [];
        for (const name of (await caches.keys()).slice(0, 50)) {
          const cache = await caches.open(name);
          const keys = await cache.keys();
          out.cache.push({ name, entries: keys.length, urls: keys.slice(0, 5).map((request) => request.url) });
        }
      } catch (error) { out.cache = { error: String(error && error.message || error) }; }
    }
    return out;
  }
  if (op.kind === "set") {
    areaOf(op.area).setItem(op.name, op.value);
    return { ok: true };
  }
  if (op.kind === "remove") {
    const store = areaOf(op.area);
    const had = store.getItem(op.name) !== null;
    store.removeItem(op.name);
    return { removed: had ? 1 : 0 };
  }
  if (op.kind === "clear") {
    if (op.area === "local" || op.area === "session") {
      const store = areaOf(op.area);
      const removed = store.length;
      store.clear();
      return { removed };
    }
    if (op.area === "indexeddb") {
      const dbs = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
      let removed = 0;
      for (const info of dbs) {
        const done = await withTimeout(new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(info.name);
          request.onsuccess = () => resolve(true);
          request.onerror = () => resolve(false);
        }), 3000, false);
        if (done) removed += 1;
      }
      return { removed, of: dbs.length };
    }
    if (op.area === "cache") {
      if (typeof caches === "undefined") return { removed: 0 };
      const names = await caches.keys();
      let removed = 0;
      for (const name of names) if (await caches.delete(name)) removed += 1;
      return { removed };
    }
  }
  if (op.kind === "count") {
    const out = {};
    if (op.area === "indexeddb") out.count = typeof indexedDB.databases === "function" ? (await indexedDB.databases()).length : 0;
    if (op.area === "cache") out.count = typeof caches === "undefined" ? 0 : (await caches.keys()).length;
    return out;
  }
  throw new Error("unknown storage op");
})`;

async function inPage<T>(target: BrowserTarget, op: Record<string, unknown>): Promise<T> {
  return target.evaluate<T>(`${PAGE_STORAGE}(${JSON.stringify(op)})`, { awaitPromise: true });
}

function itemsOf(raw: unknown, redact: boolean): Record<string, unknown> {
  if (!Array.isArray(raw)) return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { error: "unreadable" };
  const items = raw as Array<[string, string]>;
  const shown = Object.fromEntries(items.slice(0, ITEMS_SHOWN).map(([key, value]) => [key, maskStored(key, value, redact)]));
  return items.length > ITEMS_SHOWN ? { count: items.length, shown: ITEMS_SHOWN, items: shown } : { count: items.length, items: shown };
}

export async function readStorage(
  target: BrowserTarget,
  options: { area: StorageArea | null; redact: boolean },
): Promise<Record<string, unknown>> {
  const page = await pageOrigin(target);
  const areas = options.area ? [options.area] : [...STORAGE_AREAS];
  const result: Record<string, unknown> = { ok: true, tabId: target.ref, url: page.url, origin: page.origin ?? "none" };
  if (areas.includes("cookies")) {
    if (page.origin) {
      const cookies = await cookiesFor(target, page.url);
      result.cookies = cookies.map((cookie) => describeCookie(cookie, options.redact));
    } else {
      result.cookies = [];
    }
  }
  const pageAreas = areas.filter((area) => area !== "cookies");
  if (pageAreas.length) {
    const data = await inPage<Record<string, unknown>>(target, { kind: "read", areas: pageAreas });
    if (data.local !== undefined) result.localStorage = itemsOf(data.local, options.redact);
    if (data.session !== undefined) result.sessionStorage = itemsOf(data.session, options.redact);
    if (data.indexeddb !== undefined) result.indexedDB = data.indexeddb;
    if (data.cache !== undefined) result.cacheStorage = data.cache;
  }
  if (options.redact && (result.cookies || result.localStorage || result.sessionStorage)) {
    result.note = "Cookie values and credential-like stored values are redacted; pass redact=false to read them.";
  }
  return result;
}

function refuseOnUserBrowser(target: BrowserTarget, what: string): void {
  if (target.kind === "chrome") {
    throw new StorageParamsError(
      `Codara does not ${what} in your own browser, where it would sign you out of sites. Use a Codara browser tab (storage action fresh gives a logged-out one).`,
    );
  }
}

export async function setStorageItem(
  target: BrowserTarget,
  options: { area: StorageArea | null; name: unknown; value: unknown },
): Promise<Record<string, unknown>> {
  const area = options.area;
  if (area !== "cookies" && area !== "local" && area !== "session") {
    throw new StorageParamsError("set needs area cookies, local or session.");
  }
  if (typeof options.name !== "string" || !options.name) throw new StorageParamsError("set needs a name.");
  const value = typeof options.value === "string" ? options.value : options.value === undefined ? "" : JSON.stringify(options.value);
  const page = await pageOrigin(target);
  if (area === "cookies") {
    refuseOnUserBrowser(target, "change cookies");
    if (!page.origin) throw new StorageParamsError("Cookies need an http or https page.");
    const result = await target.session.send<{ success?: boolean }>("Network.setCookie", {
      name: options.name,
      value,
      url: page.url,
      path: "/",
    });
    if (result && result.success === false) throw new Error(`The browser refused the cookie ${options.name}.`);
  } else {
    await inPage(target, { kind: "set", area, name: options.name, value });
  }
  return { ok: true, tabId: target.ref, origin: page.origin ?? "none", area, set: options.name };
}

async function clearCookies(target: BrowserTarget, page: PageOrigin, name: string | null): Promise<number> {
  if (!page.origin) return 0;
  const cookies = (await cookiesFor(target, page.url)).filter((cookie) => !name || cookie.name === name);
  for (const cookie of cookies) {
    await target.session.send("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path });
  }
  return cookies.length;
}

/** Storage.clearDataForOrigin closes open IndexedDB connections, which deleteDatabase from the page waits on. */
async function clearForOrigin(target: BrowserTarget, page: PageOrigin, area: "indexeddb" | "cache"): Promise<number> {
  const before = await inPage<{ count?: number }>(target, { kind: "count", area }).catch(() => ({ count: undefined }));
  if (page.origin) {
    try {
      await target.session.send("Storage.clearDataForOrigin", {
        origin: page.origin,
        storageTypes: area === "indexeddb" ? "indexeddb" : "cache_storage",
      });
      return before.count ?? 0;
    } catch {
      // Fall back to the page's own API.
    }
  }
  const result = await inPage<{ removed?: number }>(target, { kind: "clear", area });
  return result.removed ?? 0;
}

export async function clearStorage(
  target: BrowserTarget,
  options: { area: StorageArea | null; name: unknown },
): Promise<Record<string, unknown>> {
  const name = typeof options.name === "string" && options.name ? options.name : null;
  if (name && options.area !== "cookies" && options.area !== "local" && options.area !== "session") {
    throw new StorageParamsError("Removing one item by name needs area cookies, local or session.");
  }
  const areas = options.area ? [options.area] : [...STORAGE_AREAS];
  if (target.kind === "chrome" && areas.some((area) => area !== "local" && area !== "session")) {
    refuseOnUserBrowser(target, "clear cookies, IndexedDB or caches");
  }
  const page = await pageOrigin(target);
  const removed: Record<string, number> = {};
  for (const area of areas) {
    if (area === "cookies") removed.cookies = await clearCookies(target, page, name);
    else if (area === "local" || area === "session") {
      const result = await inPage<{ removed?: number }>(target, name ? { kind: "remove", area, name } : { kind: "clear", area });
      removed[area === "local" ? "localStorage" : "sessionStorage"] = result.removed ?? 0;
    } else {
      removed[area === "indexeddb" ? "indexedDB" : "cacheStorage"] = await clearForOrigin(target, page, area);
    }
  }
  return { ok: true, tabId: target.ref, origin: page.origin ?? "none", removed };
}
