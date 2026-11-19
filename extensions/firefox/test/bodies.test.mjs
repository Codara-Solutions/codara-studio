import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const bytes = (text) => new TextEncoder().encode(text);
const at = (url) => ({ url, documentUrl: "https://a.example/app", tabId: 1 });

export async function run(assembled) {
  const { BodyStore, bodyAnswer, NO_BODY, BODY_FAILED, BODY_TOO_LARGE, BODY_LOADING } = await import(pathToFileURL(join(assembled, "lib", "bodies.js")).href);

  // Text in its charset, the rest as base64, as the protocol gives them.
  assert.deepEqual(bodyAnswer(bytes('{"a":1}'), "application/json; charset=utf-8"), { body: '{"a":1}', base64Encoded: false });
  assert.deepEqual(bodyAnswer(new Uint8Array([0xe9]), "text/plain; charset=iso-8859-1"), { body: "é", base64Encoded: false });
  assert.deepEqual(bodyAnswer(new Uint8Array([137, 80, 78, 71]), "image/png"), { body: "iVBORw==", base64Encoded: true });
  assert.deepEqual(bodyAnswer(bytes("x"), "text/plain; charset=no-such"), { body: "x", base64Encoded: false });
  assert.equal(bodyAnswer(new Uint8Array(200_000).fill(65), "application/octet-stream").body.length, 266_668, "large bodies encode in pieces");

  const store = new BodyStore({ perBody: 10, total: 16, count: 6 });
  /** A body that reached its end, Firefox's completion and Codara's row. */
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
  assert.deepEqual(await pending, { request: at("https://a.example/data"), body: "hello", base64Encoded: false });
  await assert.rejects(store.body("7", 2), { message: NO_BODY }, "another tab's request");
  await assert.rejects(store.body("8", 1), { message: NO_BODY });

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
  assert.deepEqual(await store.body("10", 1), { request: at("https://a.example/final"), body: "ZmluYWw=", base64Encoded: true });

  // Bounds: over 10 bytes a body is not kept; over 16 bytes or 6 bodies in all, the oldest go first.
  whole("12", "0123456789A");
  await assert.rejects(store.body("12", 1), { message: BODY_TOO_LARGE });
  whole("13", "0123456789");
  await assert.rejects(store.body("7", 1), { message: NO_BODY }, "the oldest went to make room");
  assert.ok(store.size <= 16, `${store.size}`);
  for (let i = 0; i < 20; i++) whole(`empty-${i}`, "");
  assert.equal(store.hops.size, 6, "empty bodies are counted too");
  const open = store.start("14", 1, at("https://a.example/stream"));
  store.publish("14");
  const waiting = store.body("14", 1, 1000);
  store.forgetTab(1);
  await assert.rejects(waiting, { message: NO_BODY }, "a body waited for is let go with its tab");
  assert.equal(store.size, 0);
  void open;
  return "bodies: text or base64, only once published and completed, own tab only, redirects, bounded in bytes and count, no waiter left";
}
