import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The change sequences below are what Firefox 153 ESR and 160 reported in
// tabs.onUpdated (measured, see README.md); the title and favicon changes
// in between carry nothing for page loads.
const LOAD = [{ status: "loading" }, { isArticle: false }, { title: "a.example/b" }, { status: "loading", url: "https://a.example/b" }, { title: "B" }, { status: "complete" }];
const HASH = [{ status: "complete", url: "https://a.example/b#part" }];
const ERROR_PAGE = [{ status: "loading" }, { status: "complete" }, { title: "nope.invalid/" }, { status: "complete", url: "https://nope.invalid/" }];

export async function run(assembled) {
  const nav = await import(pathToFileURL(join(assembled, "lib", "navigation.js")).href);
  const { NAVIGATE_ERROR, changeKind, frameTree, freshPage, isSameDocument, mainFrameId, navigateAnswer, navigateUrl, pageEvents } = nav;
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

  assert.deepEqual(LOAD.map(changeKind), ["started", null, null, "commit", null, "loaded"]);
  assert.deepEqual(HASH.map(changeKind), ["moved"]);
  assert.deepEqual(ERROR_PAGE.map(changeKind), ["started", "loaded", null, "moved"]);

  // ── navigate's answer ──
  assert.deepEqual(navigateAnswer(7, false, "commit", "L2"), { frameId, loaderId: "L2" });
  assert.deepEqual(navigateAnswer(7, false, null, "L2"), { frameId, loaderId: "L2" }, "still loading: Codara waits for the load event");
  assert.deepEqual(navigateAnswer(7, false, "moved", "L2"), { frameId, loaderId: "L2", errorText: NAVIGATE_ERROR });
  assert.deepEqual(navigateAnswer(7, true, null, "L2"), { frameId }, "a fragment: no loader, no load event to wait for");

  // ── events ──
  let ids = 0;
  const newId = () => `L${++ids}`;
  const replay = (changes, start = freshPage(newId)) => {
    let page = start;
    const sent = [];
    for (const change of changes) {
      const out = pageEvents(change, { id: 7 }, page, newId, 5000);
      page = out.page;
      sent.push(...out.events);
    }
    return { page, sent };
  };
  const start = freshPage(newId);
  assert.deepEqual(start, { loaderId: "L1", nextLoaderId: "L2", loading: false });
  const loaded = replay(LOAD, start);
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
  assert.deepEqual(hashed.sent, [["Page.navigatedWithinDocument", { frameId, url: "https://a.example/b#part" }]], "no load event for a fragment");
  assert.equal(hashed.page.loaderId, loaded.page.loaderId);

  // Firefox's error page: the load stops, and no load event says it loaded.
  const failed = replay(ERROR_PAGE, loaded.page);
  assert.deepEqual(failed.sent.map(([method]) => method), ["Page.frameStartedLoading", "Page.loadEventFired", "Page.frameStoppedLoading", "Page.navigatedWithinDocument"]);
  // A commit without the start before it still starts the load once.
  assert.deepEqual(replay([{ status: "loading", url: "https://a.example/c#top" }], loaded.page).sent.map(([method, params]) => [method, params.frame?.urlFragment]), [
    ["Page.frameStartedLoading", undefined],
    ["Page.frameNavigated", "#top"],
  ]);
  // A load the page was in before the extension saw it start sends no load event.
  assert.deepEqual(replay([{ status: "complete" }]).sent, []);

  assert.deepEqual(frameTree(7, "https://a.example/b#x", "L9"), {
    frameTree: { frame: { id: frameId, loaderId: "L9", url: "https://a.example/b", urlFragment: "#x", securityOrigin: "https://a.example", mimeType: "text/html" } },
  });
  return "navigation: which addresses navigate loads, its answer, and page-load events from Firefox's tab changes";
}
