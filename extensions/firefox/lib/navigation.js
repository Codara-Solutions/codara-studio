// Page loads in DevTools protocol form, from what Firefox tells extensions
// about a tab: Page.navigate through tabs.update, the frame tree of the
// tab's own page, and the page-load events Codara waits for, made from
// tabs.onUpdated. Measured in Firefox 153 ESR and 160 (see README.md):
//
// - tabs.update resolves at once, before the load starts;
// - a new document reports { status: "loading" }, then { status: "loading",
//   url } when it commits, then { status: "complete" } at its load event;
// - a #hash change or history.pushState reports one { url } with the tab's
//   status: "loading" while the page still loads, else "complete";
// - Firefox's own error page (an address that does not resolve, a server
//   that does not answer) reports { status: "complete", url }, with no
//   loading commit before it.
// So a commit is the first loading address change after a load started,
// and a load that ends before any commit was a failed one: the address
// change after it is Firefox's error page, as is a finished one to another
// site (a document cannot move itself to another origin).
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

/**
 * How navigate goes from the tab's address to another: "load" a new
 * document; "fragment", a #fragment of the loaded page; "there", already
 * at that address of a page seen loading; "reload", that address of a
 * page not seen loading (loaded again, so the answer says what it is);
 * "error", any #fragment of Firefox's error page, which stays the error
 * page (measured), so never a success.
 */
export function navigationPlan(page, from, to) {
  if (!isSameDocument(from, to)) return "load";
  if (page.showsError) return "error";
  if (from !== to) return "fragment";
  return page.known ? "there" : "reload";
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

/**
 * What Firefox's change says about the tab's page: a load started, a new
 * document committed, the tab moved within its document, Firefox showed
 * its error page ("failed"), the load ended, or nothing.
 */
export function changeKind(change, page) {
  if (change.url !== undefined) {
    if (change.status === "loading") return page.awaitingCommit ? "commit" : "moved";
    // A #fragment on Firefox's error page moves within the error page (measured).
    return page.aborted || page.showsError || otherOrigin(page.url, change.url) ? "failed" : "moved";
  }
  if (change.status === "loading") return "started";
  if (change.status === "complete") return "loaded";
  return null;
}

function otherOrigin(before, after) {
  if (!before) return false;
  try {
    return new URL(before).origin !== new URL(after).origin;
  } catch {
    return true;
  }
}

export const NAVIGATE_ERROR =
  "Firefox showed its error page instead: the site did not answer, or its address did not resolve.";
export const NAVIGATE_TIMEOUT_ERROR = "Firefox did not start showing the page in 25 s.";
export const NAVIGATE_BUSY_ERROR = "Another navigation of this tab is still on its way; wait for it to load, then navigate again.";

/**
 * Notes on a navigation what a tab change tells it: a load started since
 * it was asked, or the tab reached a page agents may not use (`refusal`
 * gives why for an address, or null). The refusal is kept until the
 * answer, so a redirect to a blocked site that the tab leaves again is
 * refused like one that stays there.
 */
export function noteNavigationChange(target, kind, change, refusal) {
  if (kind === "started") target.started = true;
  if (change.url !== undefined && !target.refused) {
    const why = refusal(change.url);
    if (why) target.refused = why;
  }
}

/**
 * Whether a tab change answers a navigation, given the changes since it
 * was asked (`target.started`: a load started since). For a new document:
 * its commit or Firefox's error page, only after a load started since it
 * was asked (a route change of the old page never answers it); for a
 * fragment, the tab reaching that address.
 */
export function answersNavigation(kind, change, target) {
  if (target.sameDocument) return (kind === "moved" || kind === "failed") && change.url === target.url;
  if (!target.started) return false;
  return kind === "commit" || kind === "failed" || (kind === "moved" && change.status !== "loading");
}

/**
 * Page.navigate's answer once the tab's change came, or null when none
 * came in time. A new document's first address change that is not a
 * loading commit is Firefox's error page.
 */
export function navigateAnswer(tabId, sameDocument, kind, loaderId) {
  const frameId = mainFrameId(tabId);
  if (kind === null) return { frameId, errorText: NAVIGATE_TIMEOUT_ERROR };
  // Still Firefox's error page, a #fragment of it included: never "loaded".
  if (kind === "failed") return sameDocument ? { frameId, errorText: NAVIGATE_ERROR } : { frameId, loaderId, errorText: NAVIGATE_ERROR };
  if (sameDocument) return { frameId };
  if (kind !== "commit") return { frameId, loaderId, errorText: NAVIGATE_ERROR };
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
 * commits), its address once known, whether a load is under way and has
 * not committed yet, whether the last load ended without a commit,
 * whether the tab shows Firefox's error page (until a new page commits),
 * and whether the extension saw what the tab shows load (or fail).
 */
export function freshPage(newId, url = null) {
  return { loaderId: newId(), nextLoaderId: newId(), url, loading: false, awaitingCommit: false, aborted: false, showsError: false, known: false };
}

/**
 * The protocol events for one change of a tab, as [method, params] pairs,
 * the tab's page after it, and the change's kind. Firefox reports no
 * DOMContentLoaded, so only the load event is sent: Codara's navigate waits
 * for either.
 */
export function pageEvents(change, tab, page, newId, now) {
  const frameId = mainFrameId(tab.id);
  const timestamp = now / 1000;
  const events = [];
  let { loaderId, nextLoaderId, url, loading, awaitingCommit, aborted, showsError, known } = page;
  const kind = changeKind(change, page);
  const stop = () => {
    if (loading) events.push(["Page.frameStoppedLoading", { frameId }]);
    loading = false;
    awaitingCommit = false;
  };
  switch (kind) {
    case "started":
      if (!loading) events.push(["Page.frameStartedLoading", { frameId }]);
      loading = true;
      awaitingCommit = true;
      aborted = false;
      break;
    case "commit":
      awaitingCommit = false;
      loaderId = nextLoaderId;
      nextLoaderId = newId();
      url = change.url;
      showsError = false;
      known = true;
      events.push(["Page.frameNavigated", { frame: frameOf(tab.id, change.url, loaderId), type: "Navigation" }]);
      break;
    case "moved":
      url = change.url;
      events.push(["Page.navigatedWithinDocument", { frameId, url: change.url }]);
      // A route change while the page loads leaves the load going.
      if (change.status !== "loading") stop();
      break;
    case "failed":
      // Firefox's error page is no page of the site: no event names it.
      url = change.url;
      aborted = false;
      showsError = true;
      known = true;
      stop();
      break;
    case "loaded":
      // Only a committed document has a load event; a load that ended before its commit failed.
      if (loading && !awaitingCommit) events.push(["Page.loadEventFired", { timestamp }]);
      if (awaitingCommit) aborted = true;
      stop();
      break;
  }
  return { events, page: { loaderId, nextLoaderId, url, loading, awaitingCommit, aborted, showsError, known }, kind };
}
