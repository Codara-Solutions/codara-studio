// Network.getCookies for a shared tab, from Firefox's cookies API: only
// with the tab's cookie switch on, only for the tab's own site, and from
// the tab's own cookie store (a container or a private window keeps its
// own cookies). Codara only reads cookies in the user's own browser; it
// never sets, deletes or clears them there.
// No browser.* here, so the tests run it in Node.

import { isFirefoxRestrictedUrl, firefoxBlockingRule } from "./firefox.js";
import { storageScopeError } from "./policy.js";

// URLs one getCookies may ask about.
export const COOKIE_URLS_MAX = 20;

/** The URLs a getCookies asks about: its `urls`, else the tab's page. */
export function cookieUrls(params, tabUrl) {
  const asked = Array.isArray(params?.urls) ? params.urls.filter((url) => typeof url === "string" && url) : [];
  return asked.length ? asked : [tabUrl];
}

/**
 * Why the cookies of `urls` may not go to Codara for this tab now, or null.
 * `tab` is { id, url }; `storageTabs` the tabs whose cookie switch is on.
 */
export function cookieRefusal({ tab, urls, storageTabs, rules, ref }) {
  if (!tab || !storageTabs.includes(tab.id)) {
    return `Cookies and site storage of ${ref} need the user's permission: turn on "Read and change cookies and storage here" for this tab in the Codara extension popup.`;
  }
  // The tab's own page first: a tab now on a blocked site or a browser page gives nothing.
  const tabRule = firefoxBlockingRule(tab.url, rules);
  if (tabRule) return `${ref} is on a site agents may not use ("${tabRule.raw}" in the extension's blocked sites).`;
  if (!/^https?:\/\//i.test(String(tab.url ?? "")) || isFirefoxRestrictedUrl(tab.url)) return `${ref} shows a page with no cookies Codara may read.`;
  if (urls.length > COOKIE_URLS_MAX) return `At most ${COOKIE_URLS_MAX} URLs per cookie read.`;
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url) || isFirefoxRestrictedUrl(url)) return `${url} has no cookies Codara may read.`;
    // Never a bare top-level domain above the tab's site (a host of one label is the tab's own only).
    const host = hostOf(url);
    if (!host || (!host.includes(".") && host !== hostOf(tab.url))) return `${url} is not this tab's site; the cookie and storage permission covers ${hostOf(tab.url)} only.`;
    const rule = firefoxBlockingRule(url, rules);
    if (rule) return `${url} is on a site agents may not use ("${rule.raw}" in the extension's blocked sites).`;
  }
  return storageScopeError({ urls }, tab.url, rules);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/\.$/, "");
  } catch {
    return "";
  }
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
export function cookiesAnswer(lists) {
  const seen = new Map();
  for (const cookie of lists.flat()) {
    const key = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
    if (!seen.has(key)) seen.set(key, cdpCookie(cookie));
  }
  return { cookies: [...seen.values()] };
}

/**
 * Whether a cookie read may still go to Codara, asked before the read,
 * after it and when the answer leaves: the reason it may not, or null.
 * `now()` reads the extension's state at that moment: { taken (site access
 * taken back, counted), socket (the live link), seen (the tab as last seen,
 * or none if closed), allowed (attached, shared, not blocked), storageTabs,
 * rules }.
 */
export function cookieGate({ urls, ref, now }) {
  const start = now();
  return () => {
    const state = now();
    if (state.taken !== start.taken) return `The user took back a site's access while the cookies of ${ref} were read; ask again.`;
    if (!state.socket || state.socket !== start.socket) return "The link to Codara changed while the cookies were read.";
    if (!state.seen || !state.allowed) return `${ref} is no longer attached and shared with agents.`;
    return cookieRefusal({ tab: { id: state.seen.id, url: state.seen.url }, urls, storageTabs: state.storageTabs, rules: state.rules, ref });
  };
}

/**
 * Reads the cookies of `urls` with `getAll(url)`, past `refusal()` before
 * and after; `build()` gives the answer only while `refusal()` is still
 * null, so nothing goes out once what allowed the read has changed.
 */
export async function readCookies(urls, getAll, refusal) {
  const before = refusal();
  if (before) throw new Error(before);
  const answer = cookiesAnswer(await Promise.all(urls.map(getAll)));
  const after = refusal();
  if (after) throw new Error(after);
  return {
    still: () => !refusal(),
    build: () => {
      const now = refusal();
      if (now) throw new Error(now);
      return answer;
    },
  };
}
