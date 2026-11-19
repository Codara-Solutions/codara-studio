// Page loads in DevTools protocol form, from what Firefox tells extensions
// about a tab: Page.navigate through tabs.update, the frame tree of the
// tab's own page, and the page-load events Codara waits for, made from
// tabs.onUpdated. Measured in Firefox 153 ESR and 160 (see README.md):
//
// - tabs.update resolves at once, before the load starts;
// - a new document reports { status: "loading" }, then { status: "loading",
//   url } when it commits, then { status: "complete" } at its load event;
// - a #hash change or history.pushState reports one { status: "complete", url };
// - so does Firefox's own error page (an address that does not resolve, a
//   server that does not answer), with no loading commit before it.
//
// No browser.* here, so the tests run it in Node.

export const NAVIGATION_METHODS = Object.freeze(["Page.getFrameTree", "Page.navigate"]);

/** The tab's own page as one frame: Firefox lists a tab's frames only to extensions with the webNavigation permission. */
export function mainFrameId(tabId) {
  return `firefox-tab-${tabId}`;
}

const NAVIGATE_PARAMS = ["url", "frameId", "referrer", "transitionType", "referrerPolicy"];

/**
 * The address Page.navigate may load in the tab, or throws why not: web
 * pages only, in the tab's own page, and never a site the user blocked or
 * a page Firefox keeps extensions off.
 */
export function navigateUrl(params, tabId, { isRestricted, blockingRule }) {
  const extra = Object.keys(params).filter((name) => !NAVIGATE_PARAMS.includes(name));
  if (extra.length) throw new Error(`Page.navigate takes only url in Firefox, not ${extra.join(", ")}.`);
  if (params.frameId !== undefined && params.frameId !== mainFrameId(tabId)) {
    throw new Error("Page.navigate in a frame is not available in Firefox: agents navigate the tab's own page.");
  }
  if (typeof params.referrer === "string" && params.referrer) throw new Error("Firefox cannot load a page with another referrer for an extension.");
  const url = typeof params.url === "string" ? params.url.trim() : "";
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Page.navigate needs an absolute http or https url.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || isRestricted(parsed.href)) {
    throw new Error(`Agents cannot open ${url} in Firefox.`);
  }
  const rule = blockingRule(parsed.href);
  if (rule) throw new Error(`${url} is on a site agents may not use ("${rule.raw}" in the extension's blocked sites).`);
  return parsed.href;
}

/** Whether going from one address to another only moves to a #fragment of the same document, as Firefox and Chrome do it. */
export function isSameDocument(from, to) {
  try {
    const before = new URL(from);
    const after = new URL(to);
    if (!after.hash && !to.endsWith("#")) return false;
    before.hash = "";
    after.hash = "";
    return before.href === after.href;
  } catch {
    return false;
  }
}

/** What Firefox's change says about a navigation: a new document committed, the tab moved within its document (or to an error page), the load ended, or nothing. */
export function changeKind(change) {
  if (change.url !== undefined) return change.status === "loading" ? "commit" : "moved";
  if (change.status === "loading") return "started";
  if (change.status === "complete") return "loaded";
  return null;
}

export const NAVIGATE_ERROR =
  "Firefox showed its error page instead: the site did not answer, or its address did not resolve.";

/**
 * Page.navigate's answer once the tab's next change came (or null when none
 * came in time: the load is still on its way). A cross-document navigation
 * whose first address change is not a loading commit ended on Firefox's
 * error page.
 */
export function navigateAnswer(tabId, sameDocument, kind, loaderId) {
  const frameId = mainFrameId(tabId);
  if (sameDocument) return { frameId };
  if (kind === "moved") return { frameId, loaderId, errorText: NAVIGATE_ERROR };
  return { frameId, loaderId };
}

/** A frame's address as the protocol gives it: the fragment apart. */
function frameAddress(url) {
  const text = String(url ?? "");
  const at = text.indexOf("#");
  return at < 0 ? { url: text } : { url: text.slice(0, at), urlFragment: text.slice(at) };
}

function originOf(url) {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? "://" : origin;
  } catch {
    return "://";
  }
}

/** The protocol's frame for the tab's page. */
export function frameOf(tabId, url, loaderId) {
  return { id: mainFrameId(tabId), loaderId, ...frameAddress(url), securityOrigin: originOf(url), mimeType: "text/html" };
}

/** Page.getFrameTree's answer: the tab's own page, without its frames. */
export function frameTree(tabId, url, loaderId) {
  return { frameTree: { frame: frameOf(tabId, url, loaderId) } };
}

/**
 * A tab's page as the extension tracks it: the document's loader id, the
 * one its next document will get (so a navigation can name it before it
 * commits), and whether a load is under way.
 */
export function freshPage(newId) {
  return { loaderId: newId(), nextLoaderId: newId(), loading: false };
}

/**
 * The protocol events for one change of a tab, as [method, params] pairs,
 * and the tab's page after it. Firefox reports no DOMContentLoaded, so only
 * the load event is sent: Codara's navigate waits for either.
 */
export function pageEvents(change, tab, page, newId, now) {
  const frameId = mainFrameId(tab.id);
  const timestamp = now / 1000;
  const events = [];
  let { loaderId, nextLoaderId, loading } = page;
  switch (changeKind(change)) {
    case "started":
      if (!loading) events.push(["Page.frameStartedLoading", { frameId }]);
      loading = true;
      break;
    case "commit":
      if (!loading) events.push(["Page.frameStartedLoading", { frameId }]);
      loading = true;
      loaderId = nextLoaderId;
      nextLoaderId = newId();
      events.push(["Page.frameNavigated", { frame: frameOf(tab.id, change.url, loaderId), type: "Navigation" }]);
      break;
    case "moved":
      events.push(["Page.navigatedWithinDocument", { frameId, url: change.url }]);
      if (loading) events.push(["Page.frameStoppedLoading", { frameId }]);
      loading = false;
      break;
    case "loaded":
      if (loading) {
        events.push(["Page.loadEventFired", { timestamp }], ["Page.frameStoppedLoading", { frameId }]);
      }
      loading = false;
      break;
  }
  return { events, page: { loaderId, nextLoaderId, loading } };
}
