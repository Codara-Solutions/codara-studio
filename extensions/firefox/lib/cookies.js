// Network.getCookies for a shared tab, from Firefox's cookies API: only
// with the tab's cookie switch on, only for the tab's own site, and from
// the tab's own cookie store (a container or a private window keeps its
// own cookies). Codara only reads cookies in the user's own browser; it
// never sets, deletes or clears them there.
// No browser.* here, so the tests run it in Node.

import { isFirefoxRestrictedUrl, firefoxBlockingRule } from "./firefox.js";

// URLs one getCookies may ask about.
export const COOKIE_URLS_MAX = 20;

/** The URLs a getCookies asks about: its `urls`, else the tab's page. */
export function cookieUrls(params, tabUrl) {
  const asked = Array.isArray(params?.urls) ? params.urls.filter((url) => typeof url === "string" && url) : [];
  return asked.length ? asked : [tabUrl];
}

/** An http(s) URL without credentials, parsed once, or null. */
function webUrl(text) {
  try {
    const url = new URL(String(text ?? ""));
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}
const hostOf = (url) => url.hostname.replace(/\.$/, "");

/** The URL Firefox is asked about: the very one cookieRefusal checked. */
export const cookieUrl = (text) => webUrl(text)?.href ?? null;

/**
 * Why the cookies of `urls` may not go to Codara for this tab now, or null.
 * `tab` is { id, url }; `storageTabs` the tabs whose cookie switch is on.
 * Only the tab's own host and scheme: Firefox gives extensions no list of
 * public suffixes, so a domain above or below it cannot be told apart from
 * another site (a.github.io and github.io).
 */
export function cookieRefusal({ tab, urls, storageTabs, rules, ref }) {
  if (!tab || !storageTabs.includes(tab.id)) {
    return `Cookies and site storage of ${ref} need the user's permission: turn on "Read and change cookies and storage here" for this tab in the Codara extension popup.`;
  }
  // The tab's own page first: a tab now on a blocked site or a browser page gives nothing.
  const tabRule = firefoxBlockingRule(tab.url, rules);
  if (tabRule) return `${ref} is on a site agents may not use ("${tabRule.raw}" in the extension's blocked sites).`;
  const page = webUrl(tab.url);
  if (!page || isFirefoxRestrictedUrl(page.href)) return `${ref} shows a page with no cookies Codara may read.`;
  if (urls.length > COOKIE_URLS_MAX) return `At most ${COOKIE_URLS_MAX} URLs per cookie read.`;
  for (const text of urls) {
    const url = webUrl(text);
    if (!url || isFirefoxRestrictedUrl(url.href)) return `${text} has no cookies Codara may read.`;
    // The page's own scheme too: an http page sees no Secure cookie, and Firefox's site access is checked for the page's scheme.
    if (hostOf(url) !== hostOf(page) || url.protocol !== page.protocol) {
      return `${text} is not this tab's site; the cookie and storage permission covers ${page.protocol}//${hostOf(page)} only.`;
    }
    const rule = firefoxBlockingRule(url.href, rules);
    if (rule) return `${text} is on a site agents may not use ("${rule.raw}" in the extension's blocked sites).`;
  }
  return null;
}

/** Whether a cookie Firefox gave belongs to no blocked site or path (a domain cookie of a blocked parent does). */
export function cookieVisible(cookie, rules) {
  const host = String(cookie.domain ?? "").replace(/^\./, "");
  return Boolean(host) && !firefoxBlockingRule(`https://${host}${String(cookie.path ?? "/")}`, rules);
}

const SAME_SITE = { strict: "Strict", lax: "Lax", no_restriction: "None" };

/** A Firefox cookie as the protocol gives it (Firefox already writes a domain cookie's domain with its dot). */
export function cdpCookie(cookie) {
  const name = String(cookie.name ?? "");
  const value = String(cookie.value ?? "");
  const session = cookie.session === true || !Number.isFinite(cookie.expirationDate);
  const out = {
    name,
    value,
    domain: String(cookie.domain ?? ""),
    path: String(cookie.path ?? "/"),
    expires: session ? -1 : cookie.expirationDate,
    size: name.length + value.length,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    session,
  };
  if (SAME_SITE[cookie.sameSite]) out.sameSite = SAME_SITE[cookie.sameSite];
  return out;
}

/** The cookies of several URLs, each once, as the protocol gives them. */
export function cookiesAnswer(lists, visible = () => true) {
  const seen = new Map();
  for (const cookie of lists.flat()) {
    if (!visible(cookie)) continue;
    const key = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
    if (!seen.has(key)) seen.set(key, cdpCookie(cookie));
  }
  return { cookies: [...seen.values()] };
}

/** Why the user's command to change or clear storage in their own browser is not done: never silently ignored. */
export const STORAGE_WRITES = Object.freeze(["Network.setCookie", "Network.setCookies", "Network.deleteCookies", "Network.clearBrowserCookies", "Storage.clearDataForOrigin", "Storage.clearCookies", "Storage.setCookies"]);
export function storageWriteRefusal(method) {
  return `${method}: Codara does not change or clear cookies, IndexedDB or caches in your own browser, as in Chrome. With the tab's cookie switch on it reads the tab's cookies and reads and changes its local and session storage.`;
}

/**
 * Whether a cookie read may still go to Codara, asked before the read,
 * after it and when the answer leaves: the reason it may not, or null.
 * `now()` reads the extension's state at that moment: { changed (whether
 * anything that decides the tab's access changed since the read began,
 * lib/access-clock.js: the tab's switch, attaching, sharing, page or
 * window, its window's sharing, the blocked sites, site access or the
 * link, so access taken back and given again still ends the read), socket
 * (the live link), seen (the tab as last seen, or none), allowed (attached,
 * shared, not blocked), storageTabs, rules }.
 */
export function cookieGate({ urls, ref, now }) {
  const start = now();
  return () => {
    const state = now();
    if (state.changed) return `${ref} or what it may share changed while its cookies were read; ask again.`;
    if (!state.socket || state.socket !== start.socket) return "The link to Codara changed while the cookies were read.";
    if (!state.seen || !state.allowed) return `${ref} is no longer attached and shared with agents.`;
    return cookieRefusal({ tab: { id: state.seen.id, url: state.seen.url }, urls, storageTabs: state.storageTabs, rules: state.rules, ref });
  };
}

/**
 * Reads the cookies of `urls` with `getAll(url)`, past `refusal()` and
 * `permitted()` (Firefox's site access for them) before and after; `build()`
 * gives the answer only while `refusal()` is still null, without the
 * cookies of a site blocked by then (`rules()`).
 */
export async function readCookies(urls, { getAll, refusal, permitted, rules }) {
  const check = async () => {
    const before = refusal();
    if (before) throw new Error(before);
    if (!(await permitted())) throw new Error("Firefox has no access to this site for the Codara extension: allow it from the popup first.");
    const after = refusal();
    if (after) throw new Error(after);
  };
  await check();
  const lists = await Promise.all(urls.map((url) => getAll(cookieUrl(url))));
  await check();
  return {
    still: () => !refusal(),
    build: () => {
      const now = refusal();
      if (now) throw new Error(now);
      return cookiesAnswer(lists, (cookie) => cookieVisible(cookie, rules()));
    },
  };
}
