import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const bytes = (text) => new TextEncoder().encode(text);

export async function run(assembled) {
  const { BodyStore, bodyAnswer, NO_BODY, BODY_FAILED, BODY_TOO_LARGE, BODY_LOADING } = await import(pathToFileURL(join(assembled, "lib", "bodies.js")).href);

  // Text in its charset, the rest as base64, as the protocol gives them.
  assert.deepEqual(bodyAnswer(bytes('{"a":1}'), "application/json; charset=utf-8"), { body: '{"a":1}', base64Encoded: false });
  assert.deepEqual(bodyAnswer(new Uint8Array([0xe9]), "text/plain; charset=iso-8859-1"), { body: "é", base64Encoded: false });
  assert.deepEqual(bodyAnswer(new Uint8Array([137, 80, 78, 71]), "image/png"), { body: "iVBORw==", base64Encoded: true });
  assert.deepEqual(bodyAnswer(bytes("x"), "text/plain; charset=no-such"), { body: "x", base64Encoded: false });
  assert.equal(bodyAnswer(new Uint8Array(200_000).fill(65), "application/octet-stream").body.length, 266_668, "large bodies encode in pieces");

  const store = new BodyStore({ perBody: 10, total: 16 });
  // A body waits for its end, and only its own tab gets it.
  const hop = store.start("7", 1, "https://a.example/data");
  store.type("7", "text/plain");
  store.data(hop, bytes("hel"));
  const pending = store.body("7", 1, 1000);
  store.data(hop, bytes("lo"));
  store.end(hop);
  assert.deepEqual(await pending, { url: "https://a.example/data", body: "hello", base64Encoded: false });
  await assert.rejects(store.body("7", 2), { message: NO_BODY }, "another tab's request");
  await assert.rejects(store.body("8", 1), { message: NO_BODY });
  const slow = store.start("9", 1, "https://a.example/slow");
  await assert.rejects(store.body("9", 1, 20), { message: BODY_LOADING });

  // A redirect: the first hop fails ("Channel redirected"), the next hop is the body; a late error of the old hop changes nothing.
  const first = store.start("10", 1, "https://a.example/hop");
  const next = store.start("10", 1, "https://a.example/final");
  store.end(first, "Channel redirected");
  store.data(next, bytes("final"));
  store.end(next);
  assert.deepEqual(await store.body("10", 1), { url: "https://a.example/final", body: "ZmluYWw=", base64Encoded: true });
  const failed = store.start("11", 1, "https://a.example/broken");
  store.end(failed, "Channel redirected");
  await assert.rejects(store.body("11", 1), { message: BODY_FAILED });

  // Bounds: over 10 bytes a body is not kept; over 16 in all the oldest go first.
  const big = store.start("12", 1, "https://a.example/big");
  store.data(big, bytes("0123456789A"));
  store.end(big);
  await assert.rejects(store.body("12", 1), { message: BODY_TOO_LARGE });
  assert.ok(store.size <= 16, `${store.size}`);
  const newest = store.start("13", 1, "https://a.example/new");
  store.data(newest, bytes("0123456789"));
  store.end(newest);
  await assert.rejects(store.body("7", 1), { message: NO_BODY }, "the oldest went to make room");
  assert.deepEqual(await store.body("13", 1), { url: "https://a.example/new", body: "MDEyMzQ1Njc4OQ==", base64Encoded: true }, "untyped bodies are base64");
  assert.ok(store.size <= 16);
  const waiting = store.body("9", 1, 1000);
  store.forgetTab(1);
  await assert.rejects(waiting, { message: NO_BODY }, "a body waited for is let go with its tab");
  assert.equal(store.size, 0);
  void slow;
  return "bodies: text or base64, waits for the end, own tab only, redirects, bounded per body and in all";
}
