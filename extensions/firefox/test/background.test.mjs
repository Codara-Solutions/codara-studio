import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { fakeBrowser, liveLink, loadBackground, settle } from "./fake-browser.mjs";

const SHOP = "https://shop.example/cart";
const tab = (id, more = {}) => ({ id, windowId: 1, url: SHOP, title: `Tab ${id}`, active: false, cookieStoreId: "firefox-default", ...more });

// Every event the background page listens to, and what firing it does to
// what a tab may share. A listener added to background.js fails this test
// until it is listed here: "tab" moves that tab's stamp only, "all" every
// tab's, "none" no stamp (it never takes access away).
const LISTENERS = {
  "tabs.onUpdated": "tab",
  "tabs.onAttached": "tab",
  "tabs.onDetached": "tab",
  "tabs.onRemoved": "tab",
  "windows.onRemoved": "all",
  "permissions.onRemoved": "all",
  "storage.onChanged": "all",
  "runtime.onMessage": "popup",
  "permissions.onAdded": "all",
  "tabs.onCreated": "none",
  "tabs.onActivated": "none",
  "webRequest.onBeforeRequest": "none",
  "webRequest.onSendHeaders": "none",
  "webRequest.onHeadersReceived": "none",
  "webRequest.onBeforeRedirect": "none",
  "webRequest.onResponseStarted": "none",
  "webRequest.onCompleted": "none",
  "webRequest.onErrorOccurred": "none",
  "runtime.onStartup": "none",
  "runtime.onInstalled": "none",
  "alarms.onAlarm": "none",
};

export async function run(assembled) {
  const { AccessClock, accessMoves } = await import(pathToFileURL(join(assembled, "lib", "access-clock.js")).href);

  // ── the clock alone ──
  const clock = new AccessClock();
  const first = clock.of(1);
  clock.tab(2);
  assert.equal(clock.of(1), first, "another tab's change leaves this tab's stamp");
  clock.tab(1);
  const second = clock.of(1);
  assert.notEqual(second, first);
  clock.all();
  assert.notEqual(clock.of(1), second, "a change for every tab moves it too");
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    i % 3 ? clock.tab(1) : clock.all();
    assert.ok(!seen.has(clock.of(1)), "a stamp never comes back");
    seen.add(clock.of(1));
  }
  assert.deepEqual(accessMoves({ attached: [1, 2] }, { attached: [2, 3] }), { all: false, tabs: [1, 3] });
  assert.deepEqual(accessMoves({ shareTabs: [1], stopped: [] }, { shareTabs: [1], stopped: [] }), { all: false, tabs: [] }, "written unchanged: nothing moves");
  assert.deepEqual(accessMoves({ storageTabs: [1] }, { storageTabs: [1, 4] }), { all: false, tabs: [4] }, "a cookie switch reaches its own tab");
  assert.deepEqual(accessMoves({ blockedSites: "a" }, { blockedSites: "b" }), { all: true, tabs: [] });
  assert.deepEqual(accessMoves({ shareWindows: [1] }, { shareWindows: [] }).all, true);
  assert.deepEqual(accessMoves({ shareAll: false }, { shareAll: true }).all, true);
  assert.deepEqual(accessMoves({ usage: {} }, { usage: { 1: {} } }), { all: false, tabs: [] }, "what an agent did is no access");

  // Every save() of a patch that reads the state gives it as (state) => patch,
  // worked out where it is applied: a literal patch built from `state.` may be stale.
  const source = readFileSync(join(assembled, "background.js"), "utf8");
  for (let at = source.indexOf("save({"); at >= 0; at = source.indexOf("save({", at + 1)) {
    let depth = 0;
    let end = at + 5;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}" && --depth === 0) break;
    }
    const patch = source.slice(at, end + 1);
    assert.ok(!/\bstate\./.test(patch) && !/shareChoice\(/.test(patch), `a literal save() patch reads the state; give it as (now) => patch: ${patch}`);
  }

  // ── the background page itself, in a fake Firefox ──
  let hold = null;
  const jar = [{ name: "sid", value: "secret", domain: "shop.example", path: "/" }];
  const fake = fakeBrowser({
    tabs: [tab(1), tab(2, { url: "https://other.example/" }), tab(3, { cookieStoreId: undefined })],
    local: { token: "FAKE_test_token", linkId: "link-test" },
    getAll: () => (hold ? new Promise((resolve) => (hold = () => resolve(jar))) : Promise.resolve(jar)),
  });
  const { page, restore } = await loadBackground(assembled, fake);
  try {
    const { access, link } = page;
    liveLink(link);
    const request = (body) => link.deps.onRequest(body);
    for (const id of [1, 2, 3]) {
      await fake.popup({ type: "shareTab", tabId: id, on: true });
      await fake.popup({ type: "setStorage", tabId: id, on: true });
      await request({ type: "attach", tabId: id });
    }

    // Every listener the page registered is accounted for.
    const registered = [...fake.listeners.keys()].filter((name) => fake.listeners.get(name).length);
    for (const name of registered) assert.ok(name in LISTENERS, `background.js listens to ${name}: say in LISTENERS whether it changes what a tab may share`);
    for (const name of Object.keys(LISTENERS)) {
      if (name !== "webRequest.onHeadersReceived") assert.ok(registered.includes(name), `${name} is listed but no longer listened to`);
    }

    // Each listener that changes access moves the stamp it should, and no other tab's.
    const moves = async (what, expect, act) => {
      const before = { 1: access.of(1), 2: access.of(2) };
      await act();
      const moved = [1, 2].filter((id) => access.of(id) !== before[id]);
      assert.deepEqual(moved, expect === "all" ? [1, 2] : expect, `${what}: expected ${JSON.stringify(expect)} to move`);
    };
    const cookies = (tabId) => request({ type: "cdp", tabId, method: "Network.getCookies", params: {} });
    const ready = async (id) => {
      await fake.popup({ type: "shareTab", tabId: id, on: true });
      await fake.popup({ type: "setStorage", tabId: id, on: true });
      await request({ type: "attach", tabId: id });
    };
    await moves("tab 1 loads a page", [1], () => fake.fire("tabs.onUpdated", 1, { url: SHOP }, fake.tabs.get(1)));
    await moves("tab 1 only changes its title", [], () => fake.fire("tabs.onUpdated", 1, { title: "x", favIconUrl: "" }, fake.tabs.get(1)));
    // A load can start with no address yet: its status alone moves the stamp.
    await moves("tab 1 starts a load", [1], () => fake.fire("tabs.onUpdated", 1, { status: "loading" }, fake.tabs.get(1)));
    await moves("tab 1 is discarded", [1], () => fake.fire("tabs.onUpdated", 1, { discarded: true }, fake.tabs.get(1)));
    await moves("tab 1 leaves its window", [1], () => fake.fire("tabs.onDetached", 1, { oldWindowId: 1, oldPosition: 0 }));
    await moves("tab 1 lands in a window", [1], () => fake.fire("tabs.onAttached", 1, { newWindowId: 1, newPosition: 0 }));
    await fake.popup({ type: "setReach", reach: "window", windowId: 9 });
    await moves("a shared window closes", "all", () => fake.fire("windows.onRemoved", 9));
    await moves("an unshared window closes", [], () => fake.fire("windows.onRemoved", 8));
    await moves("site access taken back", "all", () => fake.fire("permissions.onRemoved", { origins: ["https://shop.example/*"], permissions: [] }));
    await moves("site access granted", "all", () => fake.fire("permissions.onAdded", { origins: ["https://more.example/*"], permissions: [] }));
    await moves("the blocked sites changed in storage", "all", () => fake.fire("storage.onChanged", { blockedSites: { newValue: "bank.example\nnew.example" } }, "local"));
    await moves("the ports changed in storage", [], () => fake.fire("storage.onChanged", { ports: { newValue: [47615] } }, "local"));
    await moves("tab 1's cookie switch turned off", [1], () => fake.popup({ type: "setStorage", tabId: 1, on: false }));
    await moves("tab 1's cookie switch turned on", [1], () => fake.popup({ type: "setStorage", tabId: 1, on: true }));
    await moves("tab 1 stopped", [1], () => fake.popup({ type: "stopTab", tabId: 1 }));
    await moves("tab 1 shared again", [1], () => fake.popup({ type: "shareTab", tabId: 1, on: true }));
    await ready(1);
    await moves("the blocked sites changed in the options page", "all", () => fake.popup({ type: "setBlockedSites", text: "bank.example" }));
    await moves("everything shared", "all", () => fake.popup({ type: "setReach", reach: "all", windowId: 1 }));
    await moves("back to single tabs", "all", () => fake.popup({ type: "setReach", reach: "tabs", windowId: 1 }));
    await moves("tab 1 detached by Codara", [1], () => request({ type: "detach", tabId: 1 }));
    await moves("tab 1 attached by Codara", [1], () => request({ type: "attach", tabId: 1 }));
    // Tab 2 not attached: the link's own stamp moves it, not detaching.
    await request({ type: "detach", tabId: 2 });
    await moves("the link closes", "all", async () => {
      link.close();
      await settle();
    });
    liveLink(link);
    for (const id of [1, 2, 3]) await request({ type: "attach", tabId: id });
    await moves("another tab opens and is focused", [], async () => {
      await fake.fire("tabs.onCreated", tab(7));
      await fake.fire("tabs.onActivated", { tabId: 7, windowId: 1 });
    });
    // Stopped first: closing moves its stamp by itself, not through its sharing.
    await fake.popup({ type: "stopTab", tabId: 2 });
    await moves("tab 2 closes", [2], async () => {
      fake.tabs.delete(2);
      await fake.fire("tabs.onRemoved", 2, { windowId: 1, isWindowClosing: false });
    });
    fake.tabs.set(2, tab(2, { url: "https://other.example/" }));
    await ready(2);
    await moves("Stop all", "all", () => fake.popup({ type: "stopAll" }));
    for (const id of [1, 2, 3]) await ready(id);

    // Changes worked out from the state they apply to: closing tab 2 while tab 1's
    // switch turns off never puts the switch back (in either order).
    // The close lands at every point of the switch's way through the page.
    for (let ticks = 0; ticks < 16; ticks += 1) {
      fake.tabs.set(2, tab(2, { url: "https://other.example/" }));
      await ready(2);
      await fake.popup({ type: "setStorage", tabId: 1, on: true });
      fake.tabs.delete(2);
      const off = fake.popup({ type: "setStorage", tabId: 1, on: false });
      for (let i = 0; i < ticks; i += 1) await Promise.resolve();
      await Promise.all([off, fake.fire("tabs.onRemoved", 2, { windowId: 1, isWindowClosing: false })]);
      await assert.rejects(cookies(1), /need the user's permission/, `tab 1's switch stays off (tab 2 closed ${ticks} ticks into the switch)`);
    }
    fake.tabs.set(2, tab(2, { url: "https://other.example/" }));
    for (const id of [1, 2]) await ready(id);

    // ── a cookie read in a busy browser ──
    const names = (answer) => answer.build().cookies.map((cookie) => cookie.name);
    const busy = [
      ["tab 2 loads a page", () => fake.fire("tabs.onUpdated", 2, { url: "https://other.example/next" }, { ...fake.tabs.get(2), url: "https://other.example/next" })],
      ["tab 2 moves to another window", async () => {
        await fake.fire("tabs.onDetached", 2, { oldWindowId: 1, oldPosition: 1 });
        await fake.fire("tabs.onAttached", 2, { newWindowId: 1, newPosition: 1 });
      }],
      ["tab 2 is detached by Codara", () => request({ type: "detach", tabId: 2 })],
      ["another tab closes", () => fake.fire("tabs.onRemoved", 7, { windowId: 1, isWindowClosing: false })],
    ];
    for (const [what, change] of busy) {
      // During the read.
      hold = true;
      const reading = cookies(1);
      await settle();
      assert.equal(typeof hold, "function", "the read reached Firefox");
      await change();
      hold();
      hold = null;
      assert.deepEqual(names(await reading), ["sid"], `${what} during a read of tab 1 does not end it`);
      // After the read, before the answer leaves.
      const read = await cookies(1);
      await change();
      assert.equal(read.still(), true, `${what} before tab 1's answer leaves does not end it`);
      assert.deepEqual(names(read), ["sid"]);
      await request({ type: "attach", tabId: 2 });
    }
    // The unsafe direction: any change to the tab itself, even one undone, still ends its read.
    const own = [
      ["tab 1 loads a page", () => fake.fire("tabs.onUpdated", 1, { url: SHOP }, fake.tabs.get(1))],
      ["tab 1 starts a load with no address yet", () => fake.fire("tabs.onUpdated", 1, { status: "loading" }, fake.tabs.get(1))],
      ["site access granted for another site", () => fake.fire("permissions.onAdded", { origins: ["https://more.example/*"], permissions: [] })],
      ["tab 1 moves window and back", async () => {
        await fake.fire("tabs.onDetached", 1, { oldWindowId: 1, oldPosition: 0 });
        await fake.fire("tabs.onAttached", 1, { newWindowId: 1, newPosition: 0 });
      }],
      ["tab 1 detached and attached again", async () => {
        await request({ type: "detach", tabId: 1 });
        await request({ type: "attach", tabId: 1 });
      }],
      ["tab 1 stopped and shared again", async () => {
        await fake.popup({ type: "stopTab", tabId: 1 });
        await fake.popup({ type: "shareTab", tabId: 1, on: true });
        await fake.popup({ type: "setStorage", tabId: 1, on: true });
        await request({ type: "attach", tabId: 1 });
      }],
      ["tab 1's switch off and on", async () => {
        await fake.popup({ type: "setStorage", tabId: 1, on: false });
        await fake.popup({ type: "setStorage", tabId: 1, on: true });
      }],
      ["site access taken back", () => fake.fire("permissions.onRemoved", { origins: ["https://shop.example/*"], permissions: [] })],
      ["the blocked sites changed", () => fake.popup({ type: "setBlockedSites", text: `bank.example\nelsewhere-${(edits += 1)}.example` })],
    ];
    let edits = 0;
    for (const [what, change] of own) {
      hold = true;
      const reading = cookies(1);
      await settle();
      await change();
      hold();
      hold = null;
      await assert.rejects(reading, (error) => !/secret/.test(error.message), `${what} during the read ends it`);
      const read = await cookies(1);
      await change();
      assert.equal(read.still(), false, `${what} before the answer leaves ends it`);
      assert.throws(() => read.build(), (error) => !/secret/.test(error.message), `${what}: nothing built`);
    }

    // The tab's own cookie store, and never the default one in its place.
    fake.calls.getAll.length = 0;
    await cookies(1);
    assert.deepEqual(fake.calls.getAll, [{ url: SHOP, storeId: "firefox-default" }]);
    fake.calls.getAll.length = 0;
    await assert.rejects(cookies(3), /cookie store/);
    assert.equal(fake.calls.getAll.length, 0, "a tab whose cookie store Firefox did not name is never read");
  } finally {
    await restore();
  }
  return "background: every listener that changes what a tab may share moves its stamp; a busy browser never ends another tab's cookie read, any change to the tab itself does; cookies only from the tab's own store";
}
