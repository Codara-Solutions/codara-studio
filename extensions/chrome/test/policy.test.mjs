import assert from "node:assert/strict";

import {
  DEFAULT_BLOCKED_SITES,
  blockingRule,
  cdpPermission,
  commandUrl,
  isBlockedUrl,
  isRestrictedUrl,
  isTabShared,
  parseBlockedSites,
  redactCdpEvent,
} from "../lib/policy.js";

export function run() {
  const defaults = parseBlockedSites(DEFAULT_BLOCKED_SITES);
  assert.ok(defaults.length >= 10, "the preset lists bank and password manager examples");
  assert.ok(defaults.every((rule) => !rule.raw.startsWith("#")), "comments are not rules");
  assert.equal(isBlockedUrl("https://www.paypal.com/myaccount", defaults), true, "a domain covers its subdomains");
  assert.equal(isBlockedUrl("https://notpaypal.com/", defaults), false, "but not a longer name");
  assert.equal(isBlockedUrl("https://online.example.bank/login", defaults), true, "* matches any characters");
  assert.equal(isBlockedUrl("https://proton.me/pass/vault", defaults), true, "a path limits the rule");
  assert.equal(isBlockedUrl("https://proton.me/mail", defaults), false);
  assert.equal(isBlockedUrl("https://proton.me/passage", defaults), false, "a path matches whole segments");
  assert.equal(isBlockedUrl("chrome://settings", defaults), false, "only web pages match");

  const custom = parseBlockedSites("# notes\n\n  https://Admin.Example.com:8443/panel/  \nlocalhost\n*.internal\n");
  assert.deepEqual(custom.map((rule) => [rule.host, rule.path]), [["admin.example.com", "/panel"], ["localhost", ""], ["*.internal", ""]]);
  assert.equal(blockingRule("http://localhost:5173/app", custom).raw, "localhost");
  assert.equal(isBlockedUrl("https://admin.example.com/panel/users", custom), true);
  assert.equal(isBlockedUrl("https://admin.example.com/other", custom), false);
  assert.equal(isBlockedUrl("https://wiki.corp.internal/", custom), true);
  assert.equal(isBlockedUrl("not a url", custom), false);

  for (const url of ["chrome://extensions", "edge://settings", "chrome-extension://abc/popup.html", "devtools://devtools", "about:settings", "view-source:https://a.b", "https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/x", "https://microsoftedge.microsoft.com/addons/x"]) {
    assert.equal(isRestrictedUrl(url), true, url);
  }
  for (const url of ["about:blank", "https://chrome.google.com/other", "http://127.0.0.1:3000/", "file:///tmp/x.html", ""]) {
    assert.equal(isRestrictedUrl(url), false, url);
  }

  assert.equal(cdpPermission("Runtime.evaluate"), "allow");
  assert.equal(cdpPermission("Input.dispatchMouseEvent"), "allow");
  assert.equal(cdpPermission("Network.getResponseBody"), "allow");
  for (const method of ["Network.getCookies", "Network.setCookie", "Network.deleteCookies", "DOMStorage.getDOMStorageItems", "IndexedDB.requestData", "CacheStorage.requestEntries", "Storage.getUsageAndQuota", "Fetch.enable"]) {
    assert.equal(cdpPermission(method), "storage", method);
  }
  for (const method of ["Network.getAllCookies", "Storage.getCookies", "Network.clearBrowserCookies", "Storage.clearDataForOrigin", "Browser.close", "Target.createTarget", "Target.attachToTarget", "Page.close"]) {
    assert.equal(cdpPermission(method), "never", method);
  }
  assert.equal(cdpPermission("Target.getTargetInfo"), "allow");
  assert.equal(commandUrl("Page.navigate", { url: "https://a.b/" }), "https://a.b/");
  assert.equal(commandUrl("Runtime.evaluate", { expression: "1" }), null);

  const extra = { requestId: "1", headers: { Cookie: "sid=1", Accept: "*/*" }, associatedCookies: [{ cookie: { name: "sid" } }] };
  assert.deepEqual(redactCdpEvent("Network.requestWillBeSentExtraInfo", extra, false), { requestId: "1", headers: { Accept: "*/*" } });
  assert.equal(redactCdpEvent("Network.requestWillBeSentExtraInfo", extra, true), extra, "with permission nothing is removed");
  const response = { requestId: "1", headers: { "set-cookie": "sid=2", "content-type": "text/html" }, headersText: "HTTP/1.1 200\r\nSet-Cookie: sid=2", blockedCookies: [] };
  assert.deepEqual(redactCdpEvent("Network.responseReceivedExtraInfo", response, false), { requestId: "1", headers: { "content-type": "text/html" } });
  const received = redactCdpEvent("Network.responseReceived", { response: { url: "u", headers: { "Set-Cookie": "a" }, requestHeaders: { cookie: "b", x: "1" }, headersText: "raw" } }, false);
  assert.deepEqual(received.response, { url: "u", headers: {}, requestHeaders: { x: "1" } });
  const sent = redactCdpEvent("Network.requestWillBeSent", { request: { url: "u", headers: { cookie: "a", "x-y": "z" } } }, false);
  assert.deepEqual(sent.request.headers, { "x-y": "z" });
  const other = { a: 1 };
  assert.equal(redactCdpEvent("Page.loadEventFired", other, false), other);

  const tab = { id: 7, windowId: 2, url: "https://example.com/" };
  const none = { all: false, windows: [], tabs: [], stopped: [] };
  assert.equal(isTabShared(none, tab), false, "nothing is shared by default");
  assert.equal(isTabShared({ ...none, tabs: [7] }, tab), true);
  assert.equal(isTabShared({ ...none, windows: [2] }, tab), true);
  assert.equal(isTabShared({ ...none, windows: [3] }, tab), false);
  assert.equal(isTabShared({ ...none, all: true }, tab), true);
  assert.equal(isTabShared({ ...none, all: true, stopped: [7] }, tab), false, "a stopped tab stays off with every tab shared");
  assert.equal(isTabShared({ ...none, all: true }, { ...tab, url: "chrome://settings" }), false, "browser pages are never shared");
  return "policy: blocked sites, browser pages, protocol permissions, cookie redaction and sharing";
}
