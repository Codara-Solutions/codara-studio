import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function run(assembled) {
  const { cookieUrls, cookieRefusal, cookieUrl, cookieVisible, cookiesAnswer, cdpCookie, cookieGate, readCookies, storageWriteRefusal, STORAGE_WRITES, COOKIE_URLS_MAX } = await import(pathToFileURL(join(assembled, "lib", "cookies.js")).href);
  const { parseFirefoxBlockedSites } = await import(pathToFileURL(join(assembled, "lib", "firefox.js")).href);
  const rules = parseFirefoxBlockedSites("bank.example\nshop.example/account\nlogin.example.test");
  const tab = { id: 4, url: "https://shop.example/cart" };
  const refusal = (urls, overrides = {}) => cookieRefusal({ tab, urls, storageTabs: [4], rules, ref: "tab 4", ...overrides });

  // What is asked: the given URLs, else the tab's page.
  assert.deepEqual(cookieUrls({}, tab.url), [tab.url]);
  assert.deepEqual(cookieUrls({ urls: [] }, tab.url), [tab.url]);
  assert.deepEqual(cookieUrls({ urls: ["https://shop.example/", 7, ""] }, tab.url), ["https://shop.example/"]);

  // The tab's own host only, with its switch on; never another site, a blocked one or a browser page.
  assert.equal(refusal([tab.url, "https://shop.example/other?x=1"]), null);
  // The page's own scheme only: an http page's switch gives no Secure cookie, and site access is checked for the page's scheme.
  assert.match(refusal(["http://shop.example/"]), /not this tab's site/);
  assert.match(refusal(["https://shop.example/"], { tab: { id: 4, url: "http://shop.example/" } }), /not this tab's site/);
  assert.equal(refusal(["http://shop.example/a"], { tab: { id: 4, url: "http://shop.example/" } }), null);
  assert.match(refusal([tab.url], { storageTabs: [5] }), /need the user's permission/);
  assert.match(refusal([tab.url], { tab: null }), /need the user's permission/, "a tab gone meanwhile");
  assert.match(refusal(["https://other.example/"]), /not this tab's site/);
  // Firefox gives extensions no list of public suffixes: neither a domain above nor a host below.
  assert.match(refusal(["https://example/"]), /not this tab's site/);
  assert.match(refusal(["https://img.shop.example/"]), /not this tab's site/);
  assert.match(refusal(["https://github.io/"], { tab: { id: 4, url: "https://project.github.io/" } }), /not this tab's site/);
  // Credentials in a URL could make the checked host and the read one differ: refused, and what is read is the URL checked.
  assert.match(refusal(["https://other.example^@shop.example/"]), /no cookies/);
  assert.match(refusal(["https://user:pw@shop.example/"]), /no cookies/);
  assert.equal(cookieUrl("https://SHOP.example./a"), "https://shop.example./a");
  assert.match(refusal(["https://bank.example/"], { tab: { id: 4, url: "https://www.bank.example/" } }), /may not use/);
  assert.match(refusal(["https://shop.example/account/orders"]), /may not use/, "a blocked path of the tab's own site");
  assert.match(refusal([tab.url], { tab: { id: 4, url: "https://shop.example/account/x" } }), /tab 4 is on a site agents may not use/, "the tab itself on a blocked path");
  assert.match(refusal(["about:config"]), /no cookies/);
  assert.match(refusal(["file:///etc/passwd"]), /no cookies/);
  assert.match(refusal(["https://"]), /no cookies/, "not a URL");
  assert.equal(refusal(["http://localhost:3000/"], { tab: { id: 4, url: "http://localhost:3000/app" } }), null, "a one-label host that is the tab's own");
  assert.match(refusal(["https://addons.mozilla.org/"], { tab: { id: 4, url: "https://addons.mozilla.org/" } }), /no cookies/);
  assert.match(refusal(Array(COOKIE_URLS_MAX + 1).fill(tab.url)), /At most/);
  // A cookie Firefox gives for an allowed page can belong to a blocked parent or path: it is left out.
  assert.equal(cookieVisible({ domain: ".login.example.test", path: "/" }, rules), false);
  assert.equal(cookieVisible({ domain: "app.example.test", path: "/" }, rules), true);
  assert.equal(cookieVisible({ domain: ".shop.example", path: "/account" }, rules), false);
  assert.equal(cookieVisible({ domain: "", path: "/" }, rules), false);
  // Changing or clearing storage in the user's own browser is refused with the reason, as in Chrome.
  for (const method of STORAGE_WRITES) assert.match(storageWriteRefusal(method), /does not change or clear cookies/);
  assert.ok(STORAGE_WRITES.includes("Network.setCookie") && STORAGE_WRITES.includes("Storage.clearDataForOrigin"));

  // As the protocol gives them: Firefox's domain kept (a domain cookie's dot included), session and same-site mapped.
  assert.deepEqual(cdpCookie({ name: "sid", value: "abc", domain: ".shop.example", path: "/", hostOnly: false, httpOnly: true, secure: true, session: false, expirationDate: 1900000000.5, sameSite: "lax" }), {
    name: "sid",
    value: "abc",
    domain: ".shop.example",
    path: "/",
    expires: 1900000000.5,
    size: 6,
    httpOnly: true,
    secure: true,
    session: false,
    sameSite: "Lax",
  });
  const session = cdpCookie({ name: "a", value: "", domain: "www.shop.example", path: "/x", session: true, sameSite: "no_restriction" });
  assert.equal(session.expires, -1);
  assert.equal(session.session, true);
  assert.equal(session.sameSite, "None");
  assert.equal("sameSite" in cdpCookie({ name: "b", value: "1", domain: "d", path: "/", sameSite: "unspecified" }), false);
  // Several URLs: each cookie once.
  const one = { name: "a", value: "1", domain: ".shop.example", path: "/" };
  assert.equal(cookiesAnswer([[one], [one, { ...one, path: "/x" }]]).cookies.length, 2);
  // Races: whatever changes while Firefox reads the cookies, nothing goes out once what allowed the read changed.
  const socket = {};
  const fresh = () => ({ generation: 0, socket, seen: { id: 4, url: tab.url }, allowed: true, storageTabs: [4], rules });
  const jar = [{ name: "sid", value: "secret", domain: "shop.example", path: "/" }];
  const reader = (state, getAll, permitted = async () => true) =>
    readCookies([tab.url], { getAll, refusal: cookieGate({ urls: [tab.url], ref: "tab 4", now: () => ({ ...state }) }), permitted, rules: () => state.rules });
  const changes = {
    "the cookie switch turned off": (state) => (state.storageTabs = []),
    // The background moves the generation on for any change of access, so access taken back and given again still ends the read.
    "the switch turned off and on again": (state) => (state.generation += 1),
    "the tab detached and attached again": (state) => (state.generation += 1),
    "the tab detached, unshared or stopped": (state) => (state.allowed = false),
    "the tab closed": (state) => (state.seen = undefined),
    "the tab went to another site": (state) => (state.seen = { id: 4, url: "https://other.example/" }),
    "the tab went to a blocked path of its site": (state) => (state.seen = { id: 4, url: "https://shop.example/account/x" }),
    "the blocked sites now cover the site": (state) => (state.rules = parseFirefoxBlockedSites("shop.example")),
    "the link closed": (state) => (state.socket = null),
    "the link paired again": (state) => (state.socket = {}),
  };
  for (const [what, change] of Object.entries(changes)) {
    // During the read: refused, and the cookies never come out.
    let state = fresh();
    let release;
    const reading = reader(state, () => new Promise((resolve) => (release = () => resolve(jar))));
    await new Promise((resolve) => setImmediate(resolve));
    change(state);
    release();
    await assert.rejects(reading, (error) => !/secret/.test(error.message), `during the read: ${what}`);
    // After the read, before the answer leaves (it waits its turn on the link): refused when built.
    state = fresh();
    const read = await reader(state, async () => jar);
    assert.equal(read.still(), true);
    change(state);
    assert.equal(read.still(), false, `before it leaves: ${what}`);
    assert.throws(() => read.build(), (error) => !/secret/.test(error.message), `when built: ${what}`);
  }
  // Firefox's site access, asked before and after the read.
  let reads = 0;
  await assert.rejects(reader(fresh(), async () => (reads++, jar), async () => false), /no access to this site/);
  assert.equal(reads, 0);
  let access = true;
  await assert.rejects(reader(fresh(), async () => ((access = false), jar), async () => access), /no access to this site/, "taken back during the read");
  // Refused before anything is read.
  await assert.rejects(reader({ ...fresh(), storageTabs: [] }, async () => (reads++, jar)), /need the user's permission/);
  assert.equal(reads, 0);
  // Nothing changed: the answer, without a cookie of a site blocked by the time it leaves.
  const state = fresh();
  const read = await reader(state, async () => [...jar, { name: "sso", value: "x", domain: ".login.example.test", path: "/" }]);
  assert.deepEqual(read.build().cookies.map((cookie) => cookie.name), ["sid"]);
  return "cookies: the tab's own site only, with its switch on, never a blocked site or a browser page, as the protocol gives them, and nothing goes out once the switch, the tab, its site, the blocked sites, site access or the link changed during or after the read";
}
