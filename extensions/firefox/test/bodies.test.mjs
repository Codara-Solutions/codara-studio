import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const bytes = (text) => new TextEncoder().encode(text);
const at = (url) => ({ url, documentUrl: "https://a.example/app", tabId: 1 });

export async function run(assembled) {
  const { BodyStore, bodyAnswer, bodyPlan, NO_BODY, BODY_FAILED, BODY_TOO_LARGE, BODY_NOT_TEXT, BODY_LOADING, BODY_READS } = await import(pathToFileURL(join(assembled, "lib", "bodies.js")).href);

  // A link that has started closing is not live: no filter is set and no chunk kept for it
  // (the background has no harness, so its code is read).
  const background = readFileSync(join(assembled, "background.js"), "utf8");
  const live = background.slice(background.indexOf("function liveSocket() {"), background.indexOf("\n}\n", background.indexOf("function liveSocket() {")));
  assert.match(live, /socket\.readyState !== WebSocket\.OPEN/);

  // Which bodies are copied, from the response headers: text an agent reads, at most 5 MB, never downloads.
  const response = (type, headers, extra = {}) => ({ type, statusCode: 200, method: "GET", responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })), ...extra });
  assert.deepEqual(bodyPlan(response("xmlhttprequest", { "Content-Type": "application/json" })), { keep: true });
  assert.deepEqual(bodyPlan(response("main_frame", { "content-type": "text/html; charset=utf-8", "Content-Length": "5000000" })), { keep: true });
  assert.deepEqual(bodyPlan(response("script", { "Content-Type": "text/javascript" })), { keep: true });
  for (const type of ["application/problem+json", "application/atom+xml", "application/x-www-form-urlencoded", "text/css"]) assert.deepEqual(bodyPlan(response("other", { "Content-Type": type })), { keep: true }, type);
  assert.deepEqual(bodyPlan(response("xmlhttprequest", { "Content-Type": "text/plain", "Content-Length": "5000001" })), { keep: false, reason: BODY_TOO_LARGE });
  for (const [type, headers] of [["image", { "Content-Type": "image/png" }], ["media", {}], ["font", {}], ["websocket", {}], ["xmlhttprequest", { "Content-Type": "application/octet-stream" }], ["xmlhttprequest", { "Content-Type": "video/mp4" }], ["xmlhttprequest", { "Content-Type": "image/svg+xml" }], ["xmlhttprequest", { "Content-Type": "application/vnd.a+json-compressed" }], ["xmlhttprequest", { "Content-Type": "application/jsonx" }], ["xmlhttprequest", {}], ["script", {}], ["other", { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=a.csv" }]]) {
    assert.deepEqual(bodyPlan(response(type, headers)), { keep: false, reason: BODY_NOT_TEXT }, `${type} ${JSON.stringify(headers)}`);
  }
  for (const extra of [{ statusCode: 302 }, { statusCode: 204 }, { method: "HEAD" }]) assert.deepEqual(bodyPlan(response("xmlhttprequest", { "Content-Type": "text/plain" }, extra)), { keep: false, reason: null });

  // Text in its charset, the rest as base64, as the protocol gives them.
  assert.deepEqual(bodyAnswer(bytes('{"a":1}'), "application/json; charset=utf-8"), { body: '{"a":1}', base64Encoded: false });
  assert.deepEqual(bodyAnswer(new Uint8Array([0xe9]), "text/plain; charset=iso-8859-1"), { body: "é", base64Encoded: false });
  assert.deepEqual(bodyAnswer(new Uint8Array([137, 80, 78, 71]), "image/png"), { body: "iVBORw==", base64Encoded: true });
  assert.deepEqual(bodyAnswer(bytes("x"), "text/plain; charset=no-such"), { body: "x", base64Encoded: false });
  assert.equal(bodyAnswer(new Uint8Array(200_000).fill(65), "application/octet-stream").body.length, 266_668, "large bodies encode in pieces");

  const store = new BodyStore({ perBody: 10, total: 16, count: 6, block: 4 });
  /** A body that reached its end, Firefox's completion and Codara's row. */
  /** What Codara gets: the hop once ended, and its body built at the last moment. */
  const read = async (id, tab = 1, waitMs) => store.answer(await store.body(id, tab, waitMs));
  const whole = (id, text, url = `https://a.example/${id}`) => {
    const hop = store.start(id, 1, at(url));
    store.data(hop, bytes(text));
    store.end(hop);
    store.publish(id);
    store.outcome(id, true);
    return hop;
  };

  // A body waits for its end and Firefox's word on the transfer, and only its own tab gets it.
  const hop = store.start("7", 1, at("https://a.example/data"));
  store.type("7", "text/plain");
  store.data(hop, bytes("hel"));
  await assert.rejects(store.body("7", 1, 20), { message: NO_BODY }, "not before its row reached Codara");
  store.publish("7");
  const pending = store.body("7", 1, 1000);
  store.data(hop, bytes("lo"));
  store.end(hop);
  store.outcome("7", true);
  const given = await pending;
  assert.ok(given === hop && store.holds(hop), "the read names the hop it read, to check it again later");
  assert.deepEqual(given.request, at("https://a.example/data"));
  assert.deepEqual(store.answer(given), { body: "hello", base64Encoded: false });
  await assert.rejects(store.body("7", 2), { message: NO_BODY }, "another tab's request");
  await assert.rejects(store.body("8", 1), { message: NO_BODY });

  // A response not copied says why.
  store.skip("6", 1, at("https://a.example/photo"), BODY_NOT_TEXT);
  store.publish("6");
  await assert.rejects(store.body("6", 1), { message: BODY_NOT_TEXT });
  // The filter's own failure: explicit, no partial body.
  const broken = store.start("5", 1, at("https://a.example/broken-filter"));
  store.data(broken, bytes("par"));
  store.end(broken, "Invalid request ID");
  store.publish("5");
  await assert.rejects(store.body("5", 1), { message: BODY_FAILED });

  // The filter's end says nothing of a broken transfer: a body Firefox reports failed is never given.
  const cut = store.start("9", 1, at("https://a.example/cut"));
  store.publish("9");
  store.data(cut, bytes("part"));
  store.end(cut);
  await assert.rejects(store.body("9", 1, 20), { message: BODY_LOADING }, "waits for Firefox's word");
  assert.equal(cut.waiters.length, 0, "a read that gave up leaves no waiter behind");
  store.outcome("9", false);
  await assert.rejects(store.body("9", 1), { message: BODY_FAILED });

  // A redirect: the first hop fails ("Channel redirected"), the next hop is the body; a late error of the old hop changes nothing.
  const first = store.start("10", 1, at("https://a.example/hop"));
  const next = store.start("10", 1, at("https://a.example/final"));
  store.end(first, "Channel redirected");
  store.data(next, bytes("final"));
  store.end(next);
  store.publish("10");
  store.outcome("10", true);
  assert.deepEqual(await read("10"), { body: "ZmluYWw=", base64Encoded: true });

  // Bounds: over 10 bytes a body is not kept; over 16 bytes or 6 bodies in all, the oldest go first.
  const over = store.start("12", 1, at("https://a.example/12"));
  assert.equal(store.data(over, bytes("0123456789")), true);
  assert.equal(store.data(over, bytes("A")), false, "past the cap: the filter is told to let go");
  store.publish("12");
  await assert.rejects(store.body("12", 1, 1000), { message: BODY_TOO_LARGE }, "answered at once, no waiting for an end that will not come");
  whole("13", "0123456789");
  await assert.rejects(store.body("7", 1), { message: NO_BODY }, "the oldest went to make room");
  assert.ok(store.size <= 16, `${store.size}`);
  // Tiny pieces are packed into blocks, and the budget counts the blocks held.
  const tiny = store.start("15", 1, at("https://a.example/tiny"));
  for (let i = 0; i < 9; i++) store.data(tiny, bytes("z"));
  assert.equal(tiny.held, 12, "9 bytes in 3 blocks of 4");
  assert.equal(tiny.blocks.length, 3);
  store.end(tiny);
  store.publish("15");
  store.outcome("15", true);
  const tinyHop = await store.body("15", 1);
  assert.equal(store.answer(tinyHop).body, "enp6enp6enp6", "zzzzzzzzz, as base64");
  // A body dropped while it still comes lets its filter go.
  let released = 0;
  const flowing = store.start("16", 1, at("https://a.example/flowing"), () => released++);
  store.drop("16");
  store.drop("15");
  assert.throws(() => store.answer(tinyHop), { message: NO_BODY }, "a body dropped after the read is never built");
  assert.equal(released, 1);
  assert.equal(store.data(flowing, bytes("x")), false, "nothing more is kept for it");
  // The blocked sites changed: bodies of requests the log would not show now go.
  whole("17", "kept", "https://a.example/kept");
  whole("18", "gone", "https://bank.example/gone");
  store.purge((request) => !request.url.includes("bank.example"));
  await assert.rejects(store.body("18", 1), { message: NO_BODY });
  assert.equal((await read("17")).body, "a2VwdA==");
  for (let i = 0; i < 20; i++) whole(`empty-${i}`, "");
  assert.equal(store.hops.size, 6, "empty bodies are counted too");
  assert.match(BODY_FAILED, /^Body not available: the transfer failed/);
  const open = store.start("14", 1, at("https://a.example/stream"));
  store.publish("14");
  const waiting = store.body("14", 1, 1000);
  // At most 8 reads wait at once, across the store.
  const crowd = Array.from({ length: 7 }, () => store.body("14", 1, 1000).catch((error) => error.message));
  await assert.rejects(store.body("14", 1, 1000), { message: BODY_READS });
  store.forgetTab(1);
  await assert.rejects(waiting, { message: NO_BODY }, "a body waited for is let go with its tab");
  assert.deepEqual(await Promise.all(crowd), Array(7).fill(NO_BODY));
  assert.equal(store.reads, 0, "every read gave its place back");
  assert.equal(store.size, 0);
  void open;
  return "bodies: text or base64, only once published and completed, own tab only, redirects, bounded in bytes and count, no waiter left";
}
