import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// lib/firefox.js imports Chrome's policy.js, so it runs from the assembled folder.
export async function run(assembled) {
  const { CDP_METHODS, browserIdentity, isDomainToggle, isFirefoxRestrictedUrl, isShareable, firefoxBlockingRule, parseFirefoxBlockedSites, stopNeedsMark, unsupportedMethodError } = await import(pathToFileURL(join(assembled, "lib", "firefox.js")).href);
  for (const url of [
    "about:preferences",
    "about:blank",
    "about:home",
    "about:addons",
    "moz-extension://0d0d0d0d-1111-4222-8333-444444444444/popup.html",
    "resource://gre/modules/x.js",
    "chrome://browser/content/browser.xhtml",
    "view-source:https://example.com/",
    "file:///home/user/notes.html",
    "data:text/html,hi",
    "https://addons.mozilla.org/en-US/firefox/",
    "https://accounts.firefox.com/signin",
    "https://support.mozilla.org/",
    "https://support.mozilla.org./",
  ]) {
    assert.equal(isFirefoxRestrictedUrl(url), true, url);
  }
  for (const url of ["https://example.com/", "http://127.0.0.1:8080/x", "https://mozilla.org/", "https://evil.example/?u=addons.mozilla.org", ""]) {
    assert.equal(isFirefoxRestrictedUrl(url), false, url);
  }

  // Blocked sites match the host as tab URLs spell it, written either way.
  const blockingRule = firefoxBlockingRule;
  const rules = parseFirefoxBlockedSites("bücher.example/privé\nbücher.example\n*.bänk.example/login\nxn--caf-dma.example\nplain.example\ndotted.example.");
  assert.equal(blockingRule("https://xn--bcher-kva.example/priv%C3%A9/x", rules)?.raw, "bücher.example/privé");
  // Any spelling of the same path: lower-case escapes, escaped letters.
  assert.equal(blockingRule("https://xn--bcher-kva.example/priv%c3%a9", rules)?.raw, "bücher.example/privé");
  assert.equal(blockingRule("https://xn--bcher-kva.example/%70riv%C3%A9", rules)?.raw, "bücher.example/privé");
  assert.equal(parseFirefoxBlockedSites("site.example/a%2fb")[0].path, "/a%2Fb", "an escaped separator stays escaped");
  assert.equal(blockingRule("https://site.example/a/b", parseFirefoxBlockedSites("site.example/a%2Fb")), null);
  assert.equal(blockingRule("https://dotted.example/", rules)?.raw, "dotted.example.");
  // Hosts as the URL parser reads them: IPv4 shorthand, other full stops.
  const parsed = parseFirefoxBlockedSites("127.1/private\nbücher.example\u3002/privé\n*.wild\uff0ebücher.example");
  assert.equal(blockingRule("http://127.0.0.1/private/x", parsed)?.raw, "127.1/private");
  assert.equal(blockingRule("https://xn--bcher-kva.example/priv%C3%A9", parsed)?.raw, "bücher.example\u3002/privé");
  assert.equal(blockingRule("https://a.wild.xn--bcher-kva.example/", parsed)?.raw, "*.wild\uff0ebücher.example");
  assert.equal(blockingRule("https://dotted.example./", rules)?.raw, "dotted.example.");
  assert.equal(blockingRule("https://xn--bcher-kva.example/", rules)?.raw, "bücher.example");
  assert.equal(blockingRule("https://shop.xn--bcher-kva.example/x", rules)?.raw, "bücher.example");
  assert.equal(blockingRule("https://www.xn--bnk-qla.example/login/2fa", rules)?.raw, "*.bänk.example/login");
  assert.equal(blockingRule("https://www.xn--bnk-qla.example/news", rules), null);
  assert.equal(blockingRule("https://xn--caf-dma.example/", rules)?.raw, "xn--caf-dma.example");
  assert.equal(blockingRule("https://plain.example/", rules)?.raw, "plain.example");
  assert.equal(blockingRule("https://example.com/", rules), null);

  const share = { all: true, windows: [], tabs: [], stopped: [9] };
  assert.equal(isShareable(share, { id: 1, windowId: 1, url: "https://example.com/" }), true);
  assert.equal(isShareable(share, { id: 2, windowId: 1, url: "about:addons" }), false, "a Firefox page is never shared, even with everything shared");
  assert.equal(isShareable(share, { id: 3, windowId: 1, url: "https://addons.mozilla.org/" }), false);
  assert.equal(isShareable(share, { id: 9, windowId: 1, url: "https://example.com/" }), false, "a stopped tab stays off");
  assert.equal(isShareable({ all: false, windows: [], tabs: [4], stopped: [] }, { id: 4, windowId: 1, url: "https://example.com/" }), true);
  assert.equal(isShareable(share, null), false);
  // Stop under This window or Everything is marked whatever the tab shows, a browser page included.
  for (const url of ["https://example.com/", "about:addons", "https://addons.mozilla.org/"]) {
    assert.equal(stopNeedsMark({ all: true, windows: [], tabs: [] }, { id: 5, windowId: 1, url }), true, url);
    assert.equal(stopNeedsMark({ all: false, windows: [1], tabs: [] }, { id: 5, windowId: 1, url }), true, url);
  }
  assert.equal(stopNeedsMark({ all: false, windows: [2], tabs: [5] }, { id: 5, windowId: 1, url: "https://example.com/" }), false, "a tab shared on its own just leaves the list");
  assert.equal(stopNeedsMark({ all: true, windows: [], tabs: [] }, null), false);

  assert.ok(CDP_METHODS.includes("Runtime.enable") && CDP_METHODS.includes("Network.disable"), "the recorders' domains start");
  assert.ok(CDP_METHODS.every((method) => /^[A-Z][A-Za-z]+\.[a-z][A-Za-z]+$/.test(method)), "every listed name is a protocol command");
  assert.equal(new Set(CDP_METHODS).size, CDP_METHODS.length);
  assert.ok(!CDP_METHODS.includes("Runtime.evaluate"), "nothing is listed before it works");
  assert.equal(isDomainToggle("Page.enable"), true);
  assert.equal(isDomainToggle("Page.navigate"), false);
  assert.equal(isDomainToggle("Tracing.enable"), false, "only the listed domains");
  assert.match(unsupportedMethodError("Tracing.start"), /^Tracing\.start is not available in Firefox/);

  assert.deepEqual(browserIdentity({ name: "Firefox", version: "158.0", vendor: "Mozilla" }), { name: "Firefox", version: "158.0" });
  assert.deepEqual(browserIdentity(null), { name: "Firefox", version: "" });
  return "firefox: pages Firefox keeps extensions off, sharing, the commands the hello lists";
}
