#!/usr/bin/env node
"use strict";

// Every cora.send from a paired phone can start a Cora manager turn on the
// user's subscription, and the September 2026 review found nothing limiting
// how often a phone may send one. RemoteAccessService now gives each paired
// device a token bucket (src/main/remote-access/device-rate-limit.ts) keyed by
// its Noise-authenticated key. This suite drives the real service and RPC
// session over fake streams and checks that:
//
//   - a burst the phone's outbox can produce after a reconnect goes through;
//   - the next message is refused with `rate-limited`, which the phone's
//     outbox treats as transient (the message stays queued and is retried);
//   - reconnecting does not refill the budget, time does;
//   - one phone's budget never limits another phone.
//
//   node scripts/test-remote-access-cora-send-rate.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (!condition) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

async function bundle(entry, outName, dir) {
  const outfile = path.join(dir, outName);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["sodium-native", "@hyperswarm/secret-stream", "ws"],
  });
  return require(outfile);
}

function makeFakeStream(rpc, keyByte) {
  const handlers = { data: [], close: [], error: [], drain: [] };
  const decoder = new rpc.FrameDecoder();
  const outbox = [];
  return {
    remotePublicKey: Buffer.alloc(32, keyByte),
    outbox,
    destroyed: false,
    ended: false,
    write(buf) {
      for (const frame of decoder.push(buf)) outbox.push(frame);
      return true;
    },
    end() {
      this.ended = true;
      for (const handler of handlers.close) handler();
    },
    destroy() {
      this.destroyed = true;
      for (const handler of handlers.close) handler();
    },
    on(event, handler) {
      handlers[event].push(handler);
    },
    inject(buf) {
      for (const handler of handlers.data) handler(buf);
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-cora-send-rate-"));
  // Native addons stay external and must resolve from this checkout's
  // node_modules, so the bundles live in its cache rather than in tmp.
  const cacheRoot = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const bundleDir = fs.mkdtempSync(path.join(cacheRoot, "cora-send-rate-"));
  const rpc = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "rpc.ts"),
    "rpc.cjs",
    bundleDir,
  );
  const remoteAccess = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "index.ts"),
    "remote-access.cjs",
    bundleDir,
  );
  const { CORA_SEND_BURST, CORA_SEND_REFILL_MS } = remoteAccess;

  let clock = Date.parse("2026-09-25T12:00:00.000Z");
  const sent = [];
  const service = new remoteAccess.RemoteAccessService({
    remoteDir: path.join(dir, "remote"),
    deviceName: "Rate Test",
    appVersion: "test",
    now: () => clock,
    listWorkspaces: async () => [],
    sendCoraMessage: async (input) => {
      sent.push(input.clientMessageId);
      return {
        run: {
          id: input.runId ?? "run-new",
          workspaceId: input.workspaceId,
          title: "Remote work",
          status: "planning",
          createdAt: "2026-09-25T12:00:00.000Z",
          updatedAt: "2026-09-25T12:00:00.000Z",
          messageCount: 1,
          activeWorkers: 0,
          messages: [],
        },
        cursor: "cursor",
      };
    },
    createTerminal: async () => {
      throw new Error("not used");
    },
    log: () => {},
  });

  let nextId = 1;
  const connect = async (keyByte) => {
    const stream = makeFakeStream(rpc, keyByte);
    service.onAuthorizedStream(stream);
    stream.inject(
      rpc.encodeFrame({
        id: nextId++,
        method: "hello",
        params: {
          protocol: rpc.RPC_PROTOCOL_VERSION,
          device: { publicKey: "claimed", name: "Phone", role: "phone", version: "1" },
        },
      }),
    );
    await flush();
    return stream;
  };
  const send = async (stream, clientMessageId) => {
    const id = nextId++;
    stream.inject(
      rpc.encodeFrame({
        id,
        method: "cora.send",
        params: { workspaceId: "ws1", message: "hello", clientMessageId },
      }),
    );
    for (let turn = 0; turn < 5; turn += 1) await flush();
    return stream.outbox.find((frame) => frame.id === id);
  };

  try {
    check(
      "the budget allows an outbox burst and then one message every few seconds",
      CORA_SEND_BURST >= 10 && CORA_SEND_REFILL_MS > 0 && CORA_SEND_REFILL_MS <= 10_000,
      { CORA_SEND_BURST, CORA_SEND_REFILL_MS },
    );

    const phoneA = await connect(1);
    const burst = [];
    for (let index = 0; index < CORA_SEND_BURST; index += 1) {
      burst.push(await send(phoneA, `a-${index}`));
    }
    check(
      "a full burst of messages is delivered",
      burst.every((reply) => reply?.ok === true) && sent.length === CORA_SEND_BURST,
      { sent: sent.length, lastReply: burst.at(-1) },
    );

    const limited = await send(phoneA, "a-over");
    check(
      "the next message is refused as rate-limited without reaching Cora",
      limited?.error?.code === "rate-limited" && !sent.includes("a-over"),
      limited,
    );

    const reconnected = await connect(1);
    const afterReconnect = await send(reconnected, "a-reconnected");
    check(
      "reconnecting does not refill the phone's budget",
      afterReconnect?.error?.code === "rate-limited" && !sent.includes("a-reconnected"),
      afterReconnect,
    );

    const phoneB = await connect(2);
    const otherPhone = await send(phoneB, "b-0");
    check(
      "another paired phone keeps its own budget",
      otherPhone?.ok === true && sent.includes("b-0"),
      otherPhone,
    );

    clock += CORA_SEND_REFILL_MS;
    const refilled = await send(reconnected, "a-refilled");
    const drainedAgain = await send(reconnected, "a-drained");
    check(
      "time refills one message per interval",
      refilled?.ok === true &&
        sent.includes("a-refilled") &&
        drainedAgain?.error?.code === "rate-limited",
      { refilled, drainedAgain },
    );

    const invalid = await send(reconnected, "");
    check(
      "a malformed cora.send is rejected as invalid, not as rate-limited",
      invalid?.error?.code === "invalid-params",
      invalid,
    );
  } finally {
    await service.setEnabled(false).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
