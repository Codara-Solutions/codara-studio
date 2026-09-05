"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { notifyRelease } = require("./notify-release.cjs");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-sse-"));
  try {
    const outfile = path.join(dir, "sse.cjs");
    esbuild.buildSync({ entryPoints: [path.join(__dirname, "../src/main/sse-client.ts")],
      outfile, bundle: true, platform: "node", format: "cjs" });
    const { createEventParser, subscribeToEvents } = require(outfile);
    const events = [];
    const parse = createEventParser((event) => events.push(event));
    for (const character of ': ping\r\n\r\nid: 1\r\nevent: release\r\ndata: first\r\ndata: second\r\n\r\n') parse(character);
    assert.deepEqual(events, [{ id: "1", event: "release", data: "first\nsecond" }]);
    assert.throws(() => createEventParser(() => {})("x".repeat(65_537)), /too large/);
    const originalFetch = global.fetch;
    let signal;
    let cancelled = false;
    try {
      global.fetch = async (_url, init) => {
        signal = init.signal;
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode("event: resync\ndata: {}\n\n"));
          signal.addEventListener("abort", () => controller.error(new Error("aborted")));
        }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
      };
      const delivered = new Promise((resolve) => {
        const stop = subscribeToEvents({ url: "https://events.test", onEvent(event) {
          assert.equal(event.event, "resync");
          stop(); resolve();
        } });
      });
      await delivered;
      assert(signal.aborted);
    } finally { global.fetch = originalFetch; }
    assert.equal(await notifyRelease({}, () => { throw new Error("must not fetch"); }), false);
    const calls = [];
    assert.equal(await notifyRelease({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://identity.test/token?a=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-test" }, async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1 ? new Response(JSON.stringify({ value: "identity-test" })) : new Response(null, { status: 202 });
    }), true);
    assert.equal(new URL(calls[0].url).searchParams.get("audience"), "https://studio.codarasolutions.com/hooks/releases");
    assert.equal(calls[1].init.headers.authorization, "Bearer identity-test");
    console.log("PASS SSE framing, bounds, cancellation, and authenticated release notification");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((err) => { console.error(err); process.exitCode = 1; });
