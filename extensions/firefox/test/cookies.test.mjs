import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function run(assembled) {
  const { cookieUrls, cookieRefusal, cookiesAnswer, cdpCookie, cookieGate, readCookies, COOKIE_URLS_MAX } = await import(pathToFileURL(join(assembled, "lib", "cookies.js")).href);
  const { parseFirefoxBlockedSites } = await import(pathToFileURL(join(assembled, "lib", "firefox.js")).href);
  const rules = parseFirefoxBlockedSites("bank.example\nshop.example/account");
  const tab = { id: 4, url: "https://www.shop.example/cart" };
  const refusal = (urls, overrides = {}) => cookieRefusal({ tab, urls, storageTabs: [4], rules, ref: "tab 4", ...overrides });

  // What is asked: the given URLs, else the tab's page.
  assert.deepEqual(cookieUrls({}, tab.url), [tab.url]);
  assert.deepEqual(cookieUrls({ urls: [] }, tab.url), [tab.url]);
  assert.deepEqual(cookieUrls({ urls: ["https://shop.example/", 7, ""] }, tab.url), ["https://shop.example/"]);

  // The tab's own site, with its switch on; never another site, a blocked one or a browser page.
  assert.equal(refusal([tab.url]), null);
  assert.equal(refusal(["https://shop.example/", "https://img.www.shop.example/a"]), null, "the domains above and the hosts below");
  assert.match(refusal([tab.url], { storageTabs: [5] }), /need the user's permission/);
  assert.match(refusal([tab.url], { tab: null }), /need the user's permission/, "a tab gone meanwhile");
  assert.match(refusal(["https://other.example/"]), /not this tab's site/);
  assert.match(refusal(["https://example/"]), /not this tab's site/, "not a public suffix above the site");
  assert.match(refusal(["https://bank.example/"], { tab: { id: 4, url: "https://www.bank.example/" } }), /may not use/);
  assert.match(refusal(["https://shop.example/account/orders"]), /may not use/, "a blocked path of the tab's own site");
  assert.match(refusal(["about:config"]), /no cookies/);
  assert.match(refusal(["file:///etc/passwd"]), /no cookies/);
  assert.match(refusal(["https://"]), /not this tab's site/, "not a URL");
  assert.equal(refusal(["http://localhost:3000/"], { tab: { id: 4, url: "http://localhost:3000/app" } }), null, "a one-label host that is the tab's own");
  assert.match(refusal(["https://addons.mozilla.org/"], { tab: { id: 4, url: "https://addons.mozilla.org/" } }), /no cookies/);
  assert.match(refusal(Array(COOKIE_URLS_MAX + 1).fill(tab.url)), /At most/);

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
  const fresh = () => ({ taken: 0, socket, seen: { id: 4, url: tab.url }, allowed: true, storageTabs: [4], rules });
  const jar = [{ name: "sid", value: "secret", domain: "www.shop.example", path: "/" }];
  const changes = {
    "the cookie switch turned off": (state) => (state.storageTabs = []),
    "the tab detached, unshared or stopped": (state) => (state.allowed = false),
    "the tab closed": (state) => (state.seen = undefined),
    "the tab went to another site": (state) => (state.seen = { id: 4, url: "https://other.example/" }),
    "the tab went to a blocked path of its site": (state) => (state.seen = { id: 4, url: "https://shop.example/account/x" }),
    "the blocked sites now cover the site": (state) => (state.rules = parseFirefoxBlockedSites("shop.example")),
    "a site's access taken back": (state) => (state.taken += 1),
    "the link closed": (state) => (state.socket = null),
    "the link paired again": (state) => (state.socket = {}),
  };
  for (const [what, change] of Object.entries(changes)) {
    // During the read: refused, and the cookies never come out.
    let state = fresh();
    let release;
    const reading = readCookies([tab.url], () => new Promise((resolve) => (release = () => resolve(jar))), cookieGate({ urls: [tab.url], ref: "tab 4", now: () => ({ ...state }) }));
    await new Promise((resolve) => setImmediate(resolve));
    change(state);
    release();
    await assert.rejects(reading, (error) => !/secret/.test(error.message), `during the read: ${what}`);
    // After the read, before the answer leaves (it waits its turn on the link): refused when built.
    state = fresh();
    const read = await readCookies([tab.url], async () => jar, cookieGate({ urls: [tab.url], ref: "tab 4", now: () => ({ ...state }) }));
    assert.equal(read.still(), true);
    change(state);
    assert.equal(read.still(), false, `before it leaves: ${what}`);
    assert.throws(() => read.build(), (error) => !/secret/.test(error.message), `when built: ${what}`);
  }
  // Nothing changed: the answer.
  const state = fresh();
  const read = await readCookies([tab.url], async () => jar, cookieGate({ urls: [tab.url], ref: "tab 4", now: () => ({ ...state }) }));
  assert.deepEqual(read.build().cookies.map((cookie) => cookie.value), ["secret"]);
  // Refused before anything is read.
  let reads = 0;
  await assert.rejects(readCookies([tab.url], async () => (reads++, jar), cookieGate({ urls: [tab.url], ref: "tab 4", now: () => ({ ...fresh(), storageTabs: [] }) })), /need the user's permission/);
  assert.equal(reads, 0);
  return "cookies: the tab's own site only, with its switch on, never a blocked site or a browser page, as the protocol gives them, and nothing goes out once the switch, the tab, its site, the blocked sites, site access or the link changed during or after the read";
}
