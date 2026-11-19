import assert from "node:assert/strict";

import {
  DEFAULT_BLOCKED_SITES,
  agentGroupFor,
  agentGroupTitle,
  badgeTitle,
  RELOAD_CARRY_MS,
  USAGE_ACTIVE_MS,
  RELOAD_RETRY_MS,
  blockingRule,
  carriedSession,
  cdpPermission,
  childSessionError,
  closeTabError,
  commandUrl,
  compareVersions,
  isBlockedUrl,
  isRestrictedUrl,
  isTabShared,
  openedTabAnswer,
  otherWindowsText,
  parseBlockedSites,
  redactCdpEvent,
  REACH_TEXT,
  REACHES,
  agentColorVar,
  reachOf,
  reachPatch,
  shouldReload,
  storageScopeError,
  toolVerb,
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
  // Local files are off until "Allow access to file URLs" is on.
  assert.equal(isRestrictedUrl("file:///tmp/x.html", { fileAccess: false }), true);
  assert.equal(isRestrictedUrl("file:///tmp/x.html", { fileAccess: true }), false);
  assert.equal(isRestrictedUrl("https://a.b/", { fileAccess: false }), false);

  assert.equal(cdpPermission("Runtime.evaluate"), "allow");
  assert.equal(cdpPermission("Input.dispatchMouseEvent"), "allow");
  assert.equal(cdpPermission("Network.getResponseBody"), "allow");
  for (const method of ["Network.getCookies", "Network.setCookie", "Network.deleteCookies", "DOMStorage.getDOMStorageItems", "IndexedDB.requestData", "CacheStorage.requestEntries", "Storage.getUsageAndQuota", "Fetch.enable"]) {
    assert.equal(cdpPermission(method), "storage", method);
  }
  for (const method of ["Network.getAllCookies", "Storage.getCookies", "Network.clearBrowserCookies", "Storage.clearDataForOrigin", "Browser.close", "Target.createTarget", "Target.attachToTarget", "Page.close"]) {
    assert.equal(cdpPermission(method), "never", method);
  }
  for (const method of ["Network.loadNetworkResource", "Page.setDownloadBehavior"]) {
    assert.equal(cdpPermission(method), "never", `${method} reaches past the tab`);
  }
  assert.equal(cdpPermission("Target.getTargetInfo"), "allow");
  for (const method of ["Target.setAutoAttach", "Target.setDiscoverTargets", "Target.sendMessageToTarget"]) {
    assert.equal(cdpPermission(method), "never", `${method} reaches frames, workers or other tabs`);
  }
  assert.equal(childSessionError({ type: "cdp", tabId: 5, method: "Runtime.evaluate" }), null);
  assert.match(childSessionError({ type: "cdp", tabId: 5, method: "Runtime.evaluate", sessionId: "frame-1" }), /frames and workers are not reachable/);

  // A tab an agent opened that ended on a blocked site says nothing about it.
  assert.deepEqual(openedTabAnswer(9, { url: "https://news.example/a", title: "News" }, "https://news.example/", defaults), { tabId: 9, url: "https://news.example/a", title: "News" });
  assert.deepEqual(openedTabAnswer(9, { url: "https://www.paypal.com/myaccount", title: "PayPal: Summary" }, "https://short.example/x", defaults), { tabId: 9, url: "", title: "", blocked: true });
  assert.deepEqual(openedTabAnswer(9, { url: "https://short.example/x", pendingUrl: "https://www.paypal.com/", title: "" }, "https://short.example/x", defaults), { tabId: 9, url: "", title: "", blocked: true });
  assert.deepEqual(openedTabAnswer(9, null, "https://news.example/", defaults), { tabId: 9, url: "https://news.example/", title: "" });

  // The cookie and storage permission covers the tab's own site only.
  const page = "https://app.example.com/inbox";
  assert.equal(storageScopeError({}, page, defaults), null, "no scope: the tab's own page");
  assert.equal(storageScopeError({ urls: ["https://app.example.com/", "https://cdn.app.example.com/x"] }, page, defaults), null);
  assert.equal(storageScopeError({ name: "sid", value: "1", domain: ".example.com" }, page, defaults), null, "a parent domain is the same site");
  assert.equal(storageScopeError({ storageId: { securityOrigin: "https://app.example.com", isLocalStorage: true } }, page, defaults), null);
  assert.equal(storageScopeError({ storageKey: "https://app.example.com/^0https://example.com" }, page, defaults), null);
  assert.match(storageScopeError({ urls: ["https://app.example.com/", "https://mail.other.com/"] }, page, defaults), /mail\.other\.com.*not this tab's site/);
  assert.match(storageScopeError({ securityOrigin: "https://www.paypal.com" }, page, defaults), /not this tab's site/);
  assert.match(storageScopeError({ cookies: [{ name: "a", value: "b", url: "https://evil.test/" }] }, page, defaults), /evil\.test/);
  assert.match(storageScopeError({ storageBucket: { storageKey: "https://other.org/" } }, page, defaults), /other\.org/);
  assert.match(storageScopeError({ urls: ["https://www.paypal.com/"] }, "https://paypal.com/", defaults), /blocked sites/, "a blocked site stays blocked");
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
  // A redirect that sets a cookie: its Set-Cookie comes out too.
  const redirected = redactCdpEvent("Network.requestWillBeSent", { request: { url: "u", headers: {} }, redirectResponse: { status: 302, headers: { Location: "/next", "Set-Cookie": "s=1; HttpOnly" }, headersText: "raw", requestHeaders: { Cookie: "a" } } }, false);
  assert.deepEqual(redirected.redirectResponse, { status: 302, headers: { Location: "/next" }, requestHeaders: {} });
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

  assert.equal(agentGroupTitle("  Fix\n login   flow "), "Fix login flow");
  assert.equal(agentGroupTitle(2024), "2024", "the CLI sends a numeric name as a number");
  assert.equal(agentGroupTitle({ name: "x" }), "");
  assert.equal(agentGroupTitle("x".repeat(80)).length, 48);
  const groups = [
    { id: 1, title: "Login" },
    { id: 2, title: "login" },
    { id: 3, title: "Docs" },
  ];
  assert.equal(agentGroupFor(groups, [2, 3], "LOGIN")?.id, 2, "joins the extension's group by title, ignoring case");
  assert.equal(agentGroupFor(groups, [3], "Login"), null, "never the user's own group of that title");
  assert.equal(agentGroupFor(groups, [1, 2, 3], ""), null);

  // Closing: a tab an agent opened or the user shared, never a blocked one.
  const share = { all: false, windows: [7], tabs: [21], stopped: [] };
  const webTab = (id, extra = {}) => ({ id, windowId: 1, url: "https://example.com/", ...extra });
  assert.equal(closeTabError(webTab(20), share, [20], defaults), null, "a tab an agent opened");
  assert.equal(closeTabError(webTab(21), share, [], defaults), null, "a tab the user shared");
  assert.equal(closeTabError(webTab(22, { windowId: 7 }), share, [], defaults), null, "a tab of a shared window");
  assert.equal(closeTabError(webTab(23), { ...share, all: true }, [], defaults), null, "a tab while everything is shared");
  assert.match(closeTabError(webTab(24), share, [], defaults), /chrome:24 was not opened by an agent and is not shared/);
  assert.match(closeTabError(webTab(21), { ...share, stopped: [21] }, [], defaults), /not shared/, "a tab the user stopped");
  assert.match(closeTabError(webTab(21, { url: "https://www.paypal.com/" }), share, [], defaults), /blocked sites/);
  assert.match(closeTabError(webTab(20, { url: "https://www.paypal.com/" }), share, [20], defaults), /blocked sites/, "even one an agent opened");
  assert.match(closeTabError(null, share, [], defaults), /already closed/);

  // Updating: reload for a newer version only, and not again for a while.
  assert.equal(compareVersions("1.0.0", "1.1.0"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.1", "1.1.0"), 0);
  const now = 1_000_000_000;
  assert.equal(shouldReload("1.0.0", "1.1.0", null, now), true);
  assert.equal(shouldReload("1.1.0", "1.1.0", null, now), false, "already current");
  assert.equal(shouldReload("1.2.0", "1.1.0", null, now), false, "never a downgrade");
  assert.equal(shouldReload("1.0.0", "", null, now), false);
  assert.equal(shouldReload("1.0.0", "1.1.0", { version: "1.1.0", at: now - 1000 }, now), false, "a reload that did not help is not repeated");
  assert.equal(shouldReload("1.0.0", "1.1.0", { version: "1.1.0", at: now - RELOAD_RETRY_MS }, now), true, "but tried again later");
  assert.equal(shouldReload("1.0.0", "1.2.0", { version: "1.1.0", at: now - 1000 }, now), true, "a newer version is tried at once");
  const session = { shareTabs: [3], agentTabs: [3] };
  assert.deepEqual(carriedSession({ at: now - 5000, session }, now), session, "sharing survives the reload");
  assert.equal(carriedSession({ at: now - RELOAD_CARRY_MS, session }, now), null, "a stale carry is dropped: tab ids are reused after a restart");
  assert.equal(carriedSession({ at: now + 5000, session }, now), null);
  assert.equal(carriedSession(null, now), null);
  const usage = { agent: "Claude Code in pane 3f2a", at: now - 1000 };
  assert.equal(badgeTitle({ shared: true, attached: true, usage, now }), "Codara: Claude Code in pane 3f2a is using this tab. Open to stop it.", "the button names the agent while it acts");
  assert.equal(badgeTitle({ shared: true, attached: true, usage: { ...usage, at: now - USAGE_ACTIVE_MS }, now }), "Codara: an agent is using this tab", "and stops naming it once it is idle");
  assert.equal(badgeTitle({ shared: true, attached: false, usage, now }), "Codara: agents may use this tab");
  assert.equal(badgeTitle({ shared: false, attached: true, usage, now }), "Codara");

  // The popup's reach is a view of the stored switches: what a user had
  // before the update reads back as one reach, and no reach shares more than
  // the switches it stands for.
  assert.equal(reachOf({ all: false, windows: [] }, 7), "tabs", "a fresh install shares nothing beyond picked tabs");
  assert.equal(reachOf({ all: false, windows: [7] }, 7), "window");
  assert.equal(reachOf({ all: false, windows: [7] }, 8), "tabs", "another window's sharing is its own");
  assert.equal(reachOf({ all: true, windows: [] }, 7), "all");
  assert.equal(reachOf({ all: true, windows: [7] }, 7), "all", "every tab outranks one window");
  const before = { all: false, windows: [3], tabs: [41], stopped: [50, 70] };
  assert.deepEqual(reachPatch(before, "window", 7, [70, 71]), { shareAll: false, shareWindows: [3, 7], stopped: [50] }, "a window lifts only its own tabs' stops");
  assert.deepEqual(reachPatch({ ...before, windows: [3, 7] }, "tabs", 7, [70]), { shareAll: false, shareWindows: [3] }, "picked tabs and other windows stay as they were");
  assert.deepEqual(reachPatch(before, "all", 7, []), { shareAll: true, stopped: [] }, "as the old every-tab switch");
  assert.deepEqual(reachPatch({ all: true, windows: [7], stopped: [70] }, "window", 7, [70, 71]).stopped, [70], "narrowing from every tab keeps the tabs the user stopped");
  assert.ok(!("shareTabs" in reachPatch(before, "tabs", 7, [])), "the tabs a user shared one by one are never touched");
  assert.ok(!("allowOpen" in reachPatch(before, "all", 7, [])), "opening tabs keeps its own switch");
  assert.throws(() => reachPatch(before, "everything", 7, []), /Unknown reach/);
  for (const reach of REACHES) {
    const patch = reachPatch(before, reach, 7, [70]);
    const after = { all: patch.shareAll ?? before.all, windows: patch.shareWindows ?? before.windows, tabs: before.tabs, stopped: patch.stopped ?? before.stopped };
    assert.equal(reachOf(after, 7), reach, `picking ${reach} reads back as ${reach}`);
    assert.ok(REACH_TEXT[reach].label && REACH_TEXT[reach].includes, "every reach says what it includes");
  }
  assert.equal(toolVerb("codara_preview_click"), "clicked");
  assert.equal(toolVerb("codara_preview_screenshot"), "took a screenshot");
  assert.equal(toolVerb("codara_preview_set_viewport"), "used set viewport");
  assert.equal(toolVerb(""), "used this tab");
  assert.equal(agentColorVar("claude"), "var(--agent-claude)");
  assert.equal(agentColorVar("aider"), "var(--accent)", "an agent without a colour of its own uses the accent");
  assert.equal(agentColorVar("x);background:url(y"), "var(--accent)");
  // The reach note counts what stays shared elsewhere: whole windows and
  // tabs switched on one by one.
  assert.equal(otherWindowsText({}), "Other windows stay off.");
  assert.equal(otherWindowsText({ otherWindows: 1 }), "Another window you shared stays shared.");
  assert.equal(otherWindowsText({ otherWindows: 3 }), "3 other windows you shared stay shared.");
  assert.equal(otherWindowsText({ otherTabs: 1 }), "A tab you shared in another window stays shared.");
  assert.equal(otherWindowsText({ otherWindows: 1, otherTabs: 2 }), "Another window you shared stays shared. 2 tabs you shared in other windows stay shared.");

  return "policy: popup reach maps to the stored switches, toolbar button names the driving agent, blocked sites, browser pages, protocol permissions, cookie redaction, sharing, agent tab groups, closing tabs and self-updates";
}
