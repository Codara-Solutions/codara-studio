import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The change sequences below are what Firefox 153 ESR and 160 reported in
// tabs.onUpdated (measured, see README.md); the title and favicon changes
// in between carry nothing for page loads.
const LOAD = [{ status: "loading" }, { isArticle: false }, { title: "a.example/b" }, { status: "loading", url: "https://a.example/b" }, { title: "B" }, { status: "complete" }];
const HASH = [{ status: "complete", url: "https://a.example/b#part" }];
const ERROR_PAGE = [{ status: "loading" }, { status: "complete" }, { title: "nope.invalid/" }, { status: "complete", url: "https://nope.invalid/" }];
// A page that changes its route while it still loads: the address changes
// report "loading" too, but only the first after the start is a new document.
const ROUTED_WHILE_LOADING = [{ status: "loading" }, { status: "loading", url: "https://a.example/app" }, { status: "loading", url: "https://a.example/app?x=1" }, { status: "loading", url: "https://a.example/app/route" }, { status: "complete" }];

export async function run(assembled) {
  const nav = await import(pathToFileURL(join(assembled, "lib", "navigation.js")).href);
  const { NAVIGATE_ERROR, NAVIGATE_TIMEOUT_ERROR, answersNavigation, frameTree, freshPage, isSameDocument, mainFrameId, navigateAnswer, navigateUrl, pageEvents } = nav;
  const frameId = mainFrameId(7);

  // ── which addresses Page.navigate loads ──
  const checks = {
    isRestricted: (url) => /^about:|addons\.mozilla\.org/.test(url),
    blockingRule: (url) => (new URL(url).hostname === "bank.example" ? { raw: "bank.example" } : null),
  };
  assert.equal(navigateUrl({ url: " https://a.example/b?q=1 " }, 7, checks), "https://a.example/b?q=1");
  assert.equal(navigateUrl({ url: "http://127.0.0.1:3000/", frameId, transitionType: "typed" }, 7, checks), "http://127.0.0.1:3000/");
  assert.throws(() => navigateUrl({ url: "https://bank.example/login" }, 7, checks), /on a site agents may not use \("bank\.example"/);
  assert.throws(() => navigateUrl({ url: "https://addons.mozilla.org/" }, 7, checks), /Agents cannot open https:\/\/addons\.mozilla\.org\/ in Firefox/);
  for (const url of ["about:blank", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ftp://a.example/", "view-source:https://a.example/"]) {
    assert.throws(() => navigateUrl({ url }, 7, checks), /Agents cannot open/, url);
  }
  for (const url of [undefined, "", "/relative", 42]) assert.throws(() => navigateUrl({ url }, 7, checks), /absolute http or https url/, String(url));
  assert.throws(() => navigateUrl({ url: "https://a.example/", frameId: "child" }, 7, checks), /in a frame is not available in Firefox/);
  assert.throws(() => navigateUrl({ url: "https://a.example/", referrer: "https://b.example/" }, 7, checks), /another referrer/);
  assert.throws(() => navigateUrl({ url: "https://a.example/", scriptToEvaluateOnLoad: "x" }, 7, checks), /takes only url in Firefox, not scriptToEvaluateOnLoad/);

  // ── same document or a new one ──
  assert.equal(isSameDocument("https://a.example/b", "https://a.example/b#part"), true);
  assert.equal(isSameDocument("https://a.example/b#one", "https://a.example/b#two"), true);
  assert.equal(isSameDocument("https://a.example/b#one", "https://a.example/b"), false, "no fragment: Firefox loads the page again");
  assert.equal(isSameDocument("https://a.example/b", "https://a.example/b"), false);
  assert.equal(isSameDocument("https://a.example/b", "https://a.example/c#part"), false);
  assert.equal(isSameDocument("https://a.example/b?x=1", "https://a.example/b?x=2#part"), false);

  // ── navigate's answer ──
  assert.deepEqual(navigateAnswer(7, false, "commit", "L2"), { frameId, loaderId: "L2" });
  assert.deepEqual(navigateAnswer(7, false, "failed", "L2"), { frameId, loaderId: "L2", errorText: NAVIGATE_ERROR });
  assert.deepEqual(navigateAnswer(7, false, "moved", "L2"), { frameId, loaderId: "L2", errorText: NAVIGATE_ERROR });
  assert.deepEqual(navigateAnswer(7, true, "moved", "L2"), { frameId }, "a fragment: no loader, no load event to wait for");
  // Nothing committed in time: never an answer that something loaded.
  assert.deepEqual(navigateAnswer(7, false, null, "L2"), { frameId, errorText: NAVIGATE_TIMEOUT_ERROR });
  assert.deepEqual(navigateAnswer(7, true, null, "L2"), { frameId, errorText: NAVIGATE_TIMEOUT_ERROR });

  // Which tab change answers a navigation.
  const newDocument = { sameDocument: false, url: "https://a.example/c", started: true };
  // Before a load started since it was asked, nothing answers it: an older load's commit, the old page's route change, an error page.
  const notStarted = { ...newDocument, started: false };
  assert.equal(answersNavigation("commit", { status: "loading", url: "https://a.example/old-load" }, notStarted), false);
  assert.equal(answersNavigation("moved", { status: "complete", url: "https://a.example/b/route" }, notStarted), false);
  assert.equal(answersNavigation("failed", { status: "complete", url: "https://nope.invalid/" }, notStarted), false);
  const fragment = { sameDocument: true, url: "https://a.example/b#part" };
  assert.equal(answersNavigation("commit", { status: "loading", url: "https://a.example/c" }, newDocument), true);
  assert.equal(answersNavigation("failed", { status: "complete", url: "https://nope.invalid/" }, newDocument), true);
  assert.equal(answersNavigation("moved", { status: "loading", url: "https://a.example/b?route" }, newDocument), false, "the old page's route change while it loads");
  assert.equal(answersNavigation("started", { status: "loading" }, newDocument), false);
  assert.equal(answersNavigation("moved", { status: "complete", url: "https://a.example/b#part" }, fragment), true);
  assert.equal(answersNavigation("moved", { status: "loading", url: "https://a.example/b#part" }, fragment), true, "a fragment while the page loads");
  assert.equal(answersNavigation("moved", { status: "complete", url: "https://a.example/b#other" }, fragment), false);
  assert.equal(answersNavigation("commit", { status: "loading", url: "https://a.example/b#part" }, fragment), false);

  // A page agents may not use, reached on the way, is remembered until the answer: a redirect
  // to a blocked site that the tab leaves again is refused like one that stays there.
  const refusal = (url) => (new URL(url).hostname === "bank.example" ? "tab 7 is on a site agents may not use" : null);
  const bounced = { sameDocument: false, url: "https://a.example/go", started: false };
  for (const change of [{ status: "loading" }, { status: "loading", url: "https://bank.example/" }, { status: "loading" }, { status: "loading", url: "https://a.example/back" }]) {
    nav.noteNavigationChange(bounced, change.url ? "commit" : "started", change, refusal);
  }
  assert.deepEqual(bounced, { sameDocument: false, url: "https://a.example/go", started: true, refused: "tab 7 is on a site agents may not use" });
  const clean = { sameDocument: false, url: "https://a.example/go", started: false };
  nav.noteNavigationChange(clean, "started", { status: "loading" }, refusal);
  nav.noteNavigationChange(clean, "commit", { status: "loading", url: "https://a.example/go" }, refusal);
  assert.deepEqual(clean, { sameDocument: false, url: "https://a.example/go", started: true });

  // ── events ──
  let ids = 0;
  const newId = () => `L${++ids}`;
  const replay = (changes, start = freshPage(newId)) => {
    let page = start;
    const sent = [];
    const kinds = [];
    for (const change of changes) {
      const out = pageEvents(change, { id: 7 }, page, newId, 5000);
      page = out.page;
      sent.push(...out.events);
      kinds.push(out.kind);
    }
    return { page, sent, kinds };
  };
  const start = freshPage(newId);
  assert.deepEqual(start, { loaderId: "L1", nextLoaderId: "L2", url: null, loading: false, awaitingCommit: false, aborted: false, showsError: false, known: false });
  const loaded = replay(LOAD, start);
  assert.deepEqual(loaded.kinds, ["started", null, null, "commit", null, "loaded"]);
  assert.deepEqual(loaded.sent, [
    ["Page.frameStartedLoading", { frameId }],
    ["Page.frameNavigated", { frame: { id: frameId, loaderId: "L2", url: "https://a.example/b", securityOrigin: "https://a.example", mimeType: "text/html" }, type: "Navigation" }],
    ["Page.loadEventFired", { timestamp: 5 }],
    ["Page.frameStoppedLoading", { frameId }],
  ]);
  // The loader id navigate answered with is the one the document commits under.
  assert.equal(loaded.page.loaderId, start.nextLoaderId);
  assert.equal(loaded.page.loading, false);

  const hashed = replay(HASH, loaded.page);
  assert.deepEqual(hashed.kinds, ["moved"]);
  assert.deepEqual(hashed.sent, [["Page.navigatedWithinDocument", { frameId, url: "https://a.example/b#part" }]], "no load event for a fragment");
  assert.equal(hashed.page.loaderId, loaded.page.loaderId);

  // Firefox's error page: the load stops, no load event says it loaded, and no event names the error page.
  const failed = replay(ERROR_PAGE, loaded.page);
  assert.deepEqual(failed.kinds, ["started", "loaded", null, "failed"]);
  assert.deepEqual(failed.sent.map(([method]) => method), ["Page.frameStartedLoading", "Page.frameStoppedLoading"]);
  assert.equal(failed.page.loaderId, loaded.page.loaderId);
  // The tab shows the error page until a load starts: a #fragment there stays on it (measured), never a route change.
  assert.equal(failed.page.showsError, true);
  const onErrorPage = replay([{ status: "complete", url: "https://nope.invalid/#retry" }], failed.page);
  assert.deepEqual([onErrorPage.kinds, onErrorPage.sent, onErrorPage.page.showsError], [["failed"], [], true]);
  assert.equal(answersNavigation("failed", { status: "complete", url: "https://nope.invalid/#retry" }, { sameDocument: true, url: "https://nope.invalid/#retry" }), true);
  assert.deepEqual(navigateAnswer(7, true, "failed", "L2"), { frameId, errorText: NAVIGATE_ERROR });
  // It stays on until a new page commits: a load on its way does not make the error page a page.
  assert.equal(replay([{ status: "loading" }], failed.page).page.showsError, true);
  assert.equal(replay([{ status: "loading" }, { status: "loading", url: "https://a.example/b" }], failed.page).page.showsError, false);
  // How navigate goes there: the same #fragment address on an error page never answers success, and
  // "already there" only for a page seen loading.
  const { navigationPlan } = nav;
  assert.equal(navigationPlan(failed.page, "https://nope.invalid/#x", "https://nope.invalid/#x"), "error");
  assert.equal(navigationPlan(replay([{ status: "loading" }], failed.page).page, "https://nope.invalid/#x", "https://nope.invalid/#x"), "error");
  assert.equal(navigationPlan(failed.page, "https://nope.invalid/", "https://nope.invalid/#y"), "error");
  assert.equal(navigationPlan(failed.page, "https://nope.invalid/", "https://nope.invalid/"), "load");
  assert.equal(navigationPlan(loaded.page, "https://a.example/b#x", "https://a.example/b#x"), "there");
  assert.equal(navigationPlan(loaded.page, "https://a.example/b", "https://a.example/b#x"), "fragment");
  assert.equal(navigationPlan(loaded.page, "https://a.example/b", "https://a.example/c"), "load");
  assert.equal(navigationPlan(freshPage(newId), "https://a.example/b#x", "https://a.example/b#x"), "reload", "a page not seen loading is loaded again");
  assert.equal(loaded.page.showsError, false);
  // An error page Firefox shows without starting a load (a port it refuses), on another site: still no page.
  const refused = replay([{ title: "127.0.0.1:1/x" }, { status: "complete", url: "http://127.0.0.1:1/x" }], loaded.page);
  assert.deepEqual([refused.kinds, refused.sent], [[null, "failed"], []]);
  // The page's own pushState after a failed load stays a route change once a new load started.
  assert.deepEqual(replay([...LOAD, { status: "complete", url: "https://a.example/b/route" }], failed.page).kinds.at(-1), "moved");
  // Route changes while the page loads move within the new document, and its load still ends with the load event.
  const routed = replay(ROUTED_WHILE_LOADING, loaded.page);
  assert.deepEqual(routed.kinds, ["started", "commit", "moved", "moved", "loaded"]);
  assert.deepEqual(routed.sent.map(([method, params]) => [method, params.frame?.url ?? params.url]), [
    ["Page.frameStartedLoading", undefined],
    ["Page.frameNavigated", "https://a.example/app"],
    ["Page.navigatedWithinDocument", "https://a.example/app?x=1"],
    ["Page.navigatedWithinDocument", "https://a.example/app/route"],
    ["Page.loadEventFired", undefined],
    ["Page.frameStoppedLoading", undefined],
  ]);
  // A fragment in the committed address is the frame's urlFragment.
  const withFragment = replay([{ status: "loading" }, { status: "loading", url: "https://a.example/c#top" }], loaded.page);
  assert.deepEqual(withFragment.sent[1][1].frame, { id: frameId, loaderId: withFragment.page.loaderId, url: "https://a.example/c", urlFragment: "#top", securityOrigin: "https://a.example", mimeType: "text/html" });
  // An address change with no load started (the extension started mid-load) is not taken for a new document.
  assert.deepEqual(replay([{ status: "loading", url: "https://a.example/d" }]).kinds, ["moved"]);
  // A load the page was in before the extension saw it start sends no load event.
  assert.deepEqual(replay([{ status: "complete" }]).sent, []);

  assert.deepEqual(frameTree(7, "https://a.example/b#x", "L9"), {
    frameTree: { frame: { id: frameId, loaderId: "L9", url: "https://a.example/b", urlFragment: "#x", securityOrigin: "https://a.example", mimeType: "text/html" } },
  });
  return "navigation: which addresses navigate loads, its answer, and page-load events from Firefox's tab changes";
}
