// What differs in Firefox, kept out of the shared Chrome files so the Chrome
// extension ships exactly what it did: which pages Firefox keeps every
// extension off, and which DevTools protocol commands this extension answers.
// Firefox has no debugger API for extensions, so the extension answers
// Codara's "cdp" requests itself for the commands listed here; Codara reads
// the list from the hello and refuses every other command before it is sent.
// No browser.* here, so the tests run it in Node.

import { NAVIGATION_METHODS } from "./navigation.js";
import { PAGE_METHODS } from "./page-tools.js";
import { blockingRule, isRestrictedUrl, isTabShared, parseBlockedSites } from "./policy.js";

// Firefox's extensions.webextensions.restrictedDomains: no extension may
// script these, so a shared tab there would give agents nothing.
const RESTRICTED_HOSTS = new Set([
  "accounts-static.cdn.mozilla.net",
  "accounts.firefox.com",
  "addons.cdn.mozilla.net",
  "addons.mozilla.org",
  "api.accounts.firefox.com",
  "content.cdn.mozilla.net",
  "discovery.addons.mozilla.org",
  "install.mozilla.org",
  "oauth.accounts.firefox.com",
  "profile.accounts.firefox.com",
  "support.mozilla.org",
  "sync.services.mozilla.com",
]);
// about:blank too: a page can open one, write into it and title it, and it
// carries that page's origin, so it is no safer than the page.
const FIREFOX_SCHEMES = /^(moz-extension|resource|about|file|data|blob|javascript|jar|view-source|chrome):/i;

/** Browser pages, local files, other extensions and Mozilla's own sites, which no agent may drive in Firefox. */
export function isFirefoxRestrictedUrl(url) {
  const text = String(url ?? "");
  if (!text) return false;
  if (FIREFOX_SCHEMES.test(text) || isRestrictedUrl(text)) return true;
  try {
    return RESTRICTED_HOSTS.has(new URL(text).hostname.toLowerCase().replace(/\.$/, ""));
  } catch {
    return false;
  }
}

/** Whether agents may use a tab: shared, and on a page Firefox lets extensions reach. */
export function isShareable(share, tab) {
  if (!tab || isFirefoxRestrictedUrl(tab.url ?? tab.pendingUrl)) return false;
  return isTabShared(share, tab);
}

/** A hostname as the URL parser spells it ("127.1" is "127.0.0.1", "bücher" is "xn--bcher-kva"), or null. */
function parsedHost(host) {
  try {
    return new URL(`http://${host}/`).hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * A rule's host as the browser spells it in tab URLs, without a trailing
 * dot. Wildcard labels stay as written; the other labels are read by the URL
 * parser like the browser reads them.
 */
function canonicalHost(host) {
  const dotted = host.replace(/[\u3002\uff0e\uff61]/g, ".").replace(/\.$/, "");
  if (!dotted.includes("*")) return parsedHost(dotted) ?? dotted;
  // Label by label, each inside a dummy domain so "127" stays a label and
  // is not read as an IPv4 address.
  return dotted
    .split(".")
    .map((label) => (label.includes("*") ? label : parsedHost(`${label}.invalid`)?.slice(0, -".invalid".length) ?? label))
    .join(".");
}

/**
 * One spelling per path: percent escapes in upper case, and escapes of
 * letters, digits and -._~ decoded (RFC 3986 says they mean the same).
 * Escaped separators (%2F) stay escaped.
 */
function canonicalEscapes(path) {
  return path.replace(/%[0-9a-f]{2}/gi, (escape) => {
    const char = String.fromCharCode(parseInt(escape.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(char) ? char : escape.toUpperCase();
  });
}

/** A path as tab URLs spell it, canonical: "/privé" and "/priv%c3%a9" are "/priv%C3%A9". */
function urlPath(path) {
  if (!path) return path;
  try {
    return canonicalEscapes(new URL(`http://host.invalid${path.startsWith("/") ? "" : "/"}${path}`).pathname).replace(/\/+$/, "");
  } catch {
    return path;
  }
}

/** The blocked-site rule a tab URL falls under (rules from parseFirefoxBlockedSites), its path read canonically. */
export function firefoxBlockingRule(url, rules) {
  let canonical = url;
  try {
    const parsed = new URL(String(url ?? ""));
    parsed.pathname = canonicalEscapes(parsed.pathname);
    canonical = parsed.href;
  } catch {
    // Not a URL: blockingRule refuses to match it too.
  }
  return blockingRule(canonical, rules);
}

/**
 * The blocked-site rules in the form tab URLs use: punycode hosts without a
 * trailing dot and percent-encoded paths, so "bücher.example/privé" blocks
 * https://xn--bcher-kva.example/priv%C3%A9.
 */
export function parseFirefoxBlockedSites(text) {
  return parseBlockedSites(text).map((rule) => ({ ...rule, host: canonicalHost(rule.host), path: urlPath(rule.path) }));
}

/**
 * Whether turning a tab off must also mark it stopped: This window or
 * Everything still covers it. Decided by window alone, whatever page the tab
 * shows, so a tab stopped on a browser page stays off when it leaves it.
 */
export function stopNeedsMark(share, tab) {
  return Boolean(tab) && (share.all === true || (Array.isArray(share.windows) && share.windows.includes(tab.windowId)));
}

// The domains whose enable and disable Codara's recorders send on attach.
// They are answered so the session starts, and events in DevTools format
// follow for what the extension records.
const DOMAINS = ["Log", "Network", "Page", "Runtime"];

/** The DevTools protocol commands this extension answers, as listed in its hello. */
export const CDP_METHODS = Object.freeze([...DOMAINS.flatMap((domain) => [`${domain}.disable`, `${domain}.enable`]), ...PAGE_METHODS, ...NAVIGATION_METHODS, "Network.getResponseBody", "Network.getCookies"].sort());

/** Whether a command is one the extension answers without doing anything. */
export function isDomainToggle(method) {
  const [domain, verb] = String(method ?? "").split(".");
  return DOMAINS.includes(domain) && (verb === "enable" || verb === "disable");
}

/** The refusal for a command this extension does not answer. */
export function unsupportedMethodError(method) {
  return `${method} is not available in Firefox: Firefox gives extensions no debugger, and the Codara extension for Firefox cannot do it another way.`;
}

/**
 * The browser's name for the hello, from runtime.getBrowserInfo(). Its
 * version is not sent: Mozilla counts browser details as technical data,
 * which an add-on may pass on only with its own optional consent, and Codara
 * needs no version (the hello lists the commands the extension answers).
 */
export function browserIdentity(info) {
  const name = typeof info?.name === "string" && info.name ? info.name : "Firefox";
  return { name, version: "" };
}
