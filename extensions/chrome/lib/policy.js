// The rules the extension enforces before Codara may touch a tab: which tabs
// are shared, which sites are never used, which DevTools protocol commands
// need the per-tab cookie and storage permission, and what an event must not
// carry without it. No chrome.* here, so the tests run it in Node.

export const PROTOCOL = 2;
export const DEFAULT_PORTS = [47615, 47616, 47617, 47618, 47619];
export const LINK_PATH = "/codara-chrome";

export const DEFAULT_BLOCKED_SITES = [
  "# Agents never use a tab on these sites, even a shared one.",
  "# One site per line. A domain covers its subdomains, * matches any",
  "# characters, and a path limits the rule to that part of the site.",
  "*.bank",
  "paypal.com",
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "hsbc.com",
  "revolut.com",
  "wise.com",
  "1password.com",
  "bitwarden.com",
  "lastpass.com",
  "dashlane.com",
  "keepersecurity.com",
  "proton.me/pass",
  "accounts.google.com",
  "passwords.google.com",
  "account.live.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
].join("\n");

const RESTRICTED_SCHEMES = /^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|brave|opera|vivaldi|view-source|extension):/i;
// Chromium refuses debugger access to its extension stores.
const STORE_HOSTS = [
  ["chromewebstore.google.com", ""],
  ["chrome.google.com", "/webstore"],
  ["microsoftedge.microsoft.com", "/addons"],
];

/** Parses the blocked-sites text into rules; comments and blank lines are skipped. */
export function parseBlockedSites(text) {
  const rules = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const bare = line.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const slash = bare.indexOf("/");
    const host = (slash < 0 ? bare : bare.slice(0, slash)).replace(/:\d+$/, "").toLowerCase();
    const path = slash < 0 ? "" : bare.slice(slash).replace(/\/+$/, "");
    if (!host) continue;
    rules.push({ raw: line, host, path });
  }
  return rules;
}

function hostMatches(rule, host) {
  if (rule.host.includes("*")) {
    const pattern = rule.host.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${pattern}$`).test(host);
  }
  return host === rule.host || host.endsWith(`.${rule.host}`);
}

function parseUrl(url) {
  try {
    return new URL(String(url ?? ""));
  } catch {
    return null;
  }
}

/** The rule that blocks this URL, or null. Only web pages can match. */
export function blockingRule(url, rules) {
  const parsed = parseUrl(url);
  if (!parsed || !/^(https?|wss?|ftp):$/.test(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  for (const rule of rules) {
    if (!hostMatches(rule, host)) continue;
    if (rule.path && !(parsed.pathname === rule.path || parsed.pathname.startsWith(`${rule.path}/`))) continue;
    return rule;
  }
  return null;
}

export function isBlockedUrl(url, rules) {
  return blockingRule(url, rules) !== null;
}

/** Browser pages, other extensions and the extension stores, which no agent may drive. */
export function isRestrictedUrl(url) {
  const text = String(url ?? "");
  if (!text) return false;
  if (RESTRICTED_SCHEMES.test(text)) return true;
  if (/^about:/i.test(text)) return !/^about:blank$/i.test(text);
  const parsed = parseUrl(text);
  if (!parsed) return false;
  return STORE_HOSTS.some(([host, path]) => parsed.hostname === host && (!path || parsed.pathname.startsWith(path)));
}

// Methods that read or change the browser's cookies and site storage. They
// need the tab's own "cookie and storage" permission; Fetch interception is
// here too because it sees every request's cookie header.
const STORAGE_EXACT = new Set([
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Page.getCookies",
]);
const STORAGE_PREFIXES = ["DOMStorage.", "IndexedDB.", "CacheStorage.", "Storage.", "Fetch."];
// Never relayed: they reach beyond the shared tab (the whole profile's
// cookies or cache, other targets, the browser itself).
const NEVER_EXACT = new Set([
  "Network.getAllCookies",
  "Storage.getCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Storage.clearDataForOrigin",
  "Storage.clearDataForStorageKey",
  "Storage.clearCookies",
  "Storage.setCookies",
  "Page.close",
  "Page.crash",
  // Loads any URL with the profile's cookies and hands back the body, past
  // CORS and the blocked sites.
  "Network.loadNetworkResource",
  // Points the tab's downloads at any folder on the user's disk.
  "Page.setDownloadBehavior",
]);
const NEVER_PREFIXES = ["Browser.", "SystemInfo.", "Tethering.", "Extensions.", "PWA.", "BluetoothEmulation."];
// Auto-attach would open sessions on the tab's frames and workers, and
// discovery reports every other target in the browser: neither passes the
// tab's sharing and blocked-sites checks, so only the tab's own info is read.
const TARGET_ALLOWED = new Set(["Target.getTargetInfo"]);

/**
 * Why a request may not go to a session inside the tab (a frame or worker,
 * whose site the blocked-sites list never checked), or null.
 */
export function childSessionError(request) {
  if (request?.sessionId === undefined || request?.sessionId === null) return null;
  return "Agents use the tab's own page only: its frames and workers are not reachable in your own browser.";
}

const AGENT_GROUP_TITLE_MAX = 48;

/**
 * The title of the tab group an agent asked to open a tab in, cleaned the way
 * Codara cleans its own group names, or "" for none.
 */
export function agentGroupTitle(raw) {
  const text = typeof raw === "string" ? raw : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, AGENT_GROUP_TITLE_MAX)
    .trim();
}

/**
 * The group an agent's new tab joins: one of this window's groups the
 * extension made, titled the same ignoring case. A group the user made is
 * never joined, so an agent's tab never lands among the user's own.
 */
export function agentGroupFor(groups, agentGroupIds, title) {
  const key = String(title ?? "").toLowerCase();
  if (!key) return null;
  return (
    (groups ?? []).find(
      (group) => agentGroupIds.includes(group.id) && String(group.title ?? "").toLowerCase() === key,
    ) ?? null
  );
}

/**
 * What the agent learns about a tab it opened. A page that redirected to a
 * blocked site tells it nothing: not where it ended, nor its title.
 */
export function openedTabAnswer(tabId, current, requested, rules) {
  const url = current?.url || requested;
  if (blockingRule(url, rules) || (current?.pendingUrl && blockingRule(current.pendingUrl, rules))) {
    return { tabId, url: "", title: "", blocked: true };
  }
  return { tabId, url, title: current?.title ?? "" };
}

/** "allow", "storage" (needs the tab's cookie and storage permission) or "never". */
export function cdpPermission(method) {
  const name = String(method ?? "");
  if (NEVER_EXACT.has(name) || NEVER_PREFIXES.some((prefix) => name.startsWith(prefix))) return "never";
  if (name.startsWith("Target.") && !TARGET_ALLOWED.has(name)) return "never";
  if (STORAGE_EXACT.has(name) || STORAGE_PREFIXES.some((prefix) => name.startsWith(prefix))) return "storage";
  return "allow";
}

// Where a cookie or storage command can point besides the tab's own page.
function storageScopes(params) {
  const out = [];
  const take = (value) => {
    if (typeof value === "string" && value) out.push(value);
  };
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const key of ["url", "domain", "origin", "securityOrigin", "storageKey"]) take(value[key]);
    for (const nested of ["storageId", "storageBucket"]) walk(value[nested]);
  };
  if (!params || typeof params !== "object") return out;
  walk(params);
  if (Array.isArray(params.urls)) params.urls.forEach(take);
  if (Array.isArray(params.cookies)) params.cookies.forEach(walk);
  return out;
}

function scopeHost(scope) {
  // A storage key is the origin, then partition data after a caret.
  const text = scope.split("^")[0];
  const parsed = parseUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text.replace(/^\./, "")}`);
  return parsed ? parsed.hostname.toLowerCase().replace(/\.$/, "") : null;
}

/**
 * Why a cookie or storage command reaches past the tab it was granted on,
 * or null. The per-tab permission covers that tab's site (its host, the
 * domains above it and the hosts below it), never another site and never
 * a blocked one.
 */
export function storageScopeError(params, tabUrl, rules) {
  const tab = parseUrl(tabUrl);
  const tabHost = tab ? tab.hostname.toLowerCase().replace(/\.$/, "") : "";
  for (const scope of storageScopes(params)) {
    const host = scopeHost(scope);
    const related = host && tabHost && (host === tabHost || tabHost.endsWith(`.${host}`) || host.endsWith(`.${tabHost}`));
    if (!related) return `${scope} is not this tab's site; the cookie and storage permission covers ${tabHost || "the tab's page"} only.`;
    const rule = blockingRule(`https://${host}/`, rules);
    if (rule) return `${scope} is on a site agents may not use ("${rule.raw}" in the extension's blocked sites).`;
  }
  return null;
}

/** The URL a command would load in the tab, so a blocked site is refused before it loads. */
export function commandUrl(method, params) {
  if (method === "Page.navigate" && params && typeof params.url === "string") return params.url;
  return null;
}

function withoutHeaders(headers, names) {
  if (!headers || typeof headers !== "object") return headers;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!names.includes(key.toLowerCase())) out[key] = value;
  }
  return out;
}

const COOKIE_HEADERS = ["cookie", "set-cookie"];

/**
 * An event as Codara may see it. Without the tab's cookie and storage
 * permission, cookie headers and cookie lists are removed; everything else
 * passes through unchanged.
 */
export function redactCdpEvent(method, params, allowStorage) {
  if (allowStorage || !params || typeof params !== "object") return params;
  switch (method) {
    case "Network.requestWillBeSent":
      return params.request ? { ...params, request: { ...params.request, headers: withoutHeaders(params.request.headers, COOKIE_HEADERS) } } : params;
    case "Network.requestWillBeSentExtraInfo": {
      const { associatedCookies: _cookies, ...rest } = params;
      return { ...rest, headers: withoutHeaders(params.headers, COOKIE_HEADERS) };
    }
    case "Network.responseReceivedExtraInfo": {
      const { blockedCookies: _blocked, headersText: _text, exemptedCookies: _exempted, ...rest } = params;
      return { ...rest, headers: withoutHeaders(params.headers, COOKIE_HEADERS) };
    }
    case "Network.responseReceived": {
      if (!params.response) return params;
      const { requestHeadersText: _req, headersText: _res, ...response } = params.response;
      return {
        ...params,
        response: {
          ...response,
          headers: withoutHeaders(response.headers, COOKIE_HEADERS),
          ...(response.requestHeaders ? { requestHeaders: withoutHeaders(response.requestHeaders, COOKIE_HEADERS) } : {}),
        },
      };
    }
    case "Network.webSocketWillSendHandshakeRequest":
      return params.request ? { ...params, request: { ...params.request, headers: withoutHeaders(params.request.headers, COOKIE_HEADERS) } } : params;
    case "Network.webSocketHandshakeResponseReceived": {
      if (!params.response) return params;
      const { headersText: _res, requestHeadersText: _req, ...response } = params.response;
      return {
        ...params,
        response: {
          ...response,
          headers: withoutHeaders(response.headers, COOKIE_HEADERS),
          ...(response.requestHeaders ? { requestHeaders: withoutHeaders(response.requestHeaders, COOKIE_HEADERS) } : {}),
        },
      };
    }
    default:
      return params;
  }
}

/**
 * Whether agents may use a tab. `share` is what the user chose in the popup:
 * { all, windows: [windowId], tabs: [tabId], stopped: [tabId] }. A stopped
 * tab stays off even inside a shared window or with every tab shared.
 */
export function isTabShared(share, tab) {
  if (!tab || typeof tab.id !== "number") return false;
  if (isRestrictedUrl(tab.url ?? tab.pendingUrl)) return false;
  if ((share.stopped ?? []).includes(tab.id)) return false;
  return share.all === true || (share.windows ?? []).includes(tab.windowId) || (share.tabs ?? []).includes(tab.id);
}

/** The tab id agents pass to Codara's browser tools. */
export function agentTabId(tabId) {
  return `chrome:${tabId}`;
}
