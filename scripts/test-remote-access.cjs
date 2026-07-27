// Harness for src/main/remote-access/: the pairing window (expiry, single
// use), the paired-device store (persistence, revocation, corrupt-file
// behavior), the firewall decision, RPC framing (length prefix, oversize
// rejection), and the RpcSession state machine over a fake duplex.
//
//   node scripts/test-remote-access.cjs
//
// The QR payload is additionally checked against the REAL phone parser
// (codara-mobile src/lib/remote/pairing-payload.ts) when that repo is
// checked out next to this one; interop with that parser is a hard
// contract, so a payload change that breaks the phone fails here first.
// No live DHT, no sockets: everything below is in-process.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const MOBILE_PARSER = path.resolve(
  ROOT,
  "..",
  "codara-mobile",
  "src",
  "lib",
  "remote",
  "pairing-payload.ts",
);

async function bundle(entry, outName) {
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, outName);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["sodium-native"],
  });
  delete require.cache[outfile];
  return require(outfile);
}

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

async function main() {
  const pairing = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "pairing.ts"),
    "remote-access-pairing-test.cjs",
  );
  const rpc = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "rpc.ts"),
    "remote-access-rpc-test.cjs",
  );

  /* ---- pairing window: expiry and single use ---------------------------- */

  const T0 = 1_700_000_000_000;
  const win = new pairing.PairingWindow(T0);
  const secret = Buffer.from(win.secretB64(), "base64");
  check("pairing secret is 32 bytes", secret.length === 32);
  check("pairing window expires exactly at ttl", win.expiresAt === T0 + 2 * 60 * 1000);
  check("wrong secret is refused", win.consume(Buffer.alloc(32, 7), T0 + 1000) === false);
  check("wrong-length proof is refused", win.consume(secret.subarray(0, 16), T0 + 1000) === false);
  check("a refused proof does not consume the window", win.isUsed() === false);
  check("correct secret is accepted", win.consume(secret, T0 + 1000) === true);
  check("the window is single use", win.consume(secret, T0 + 1001) === false);

  const expired = new pairing.PairingWindow(T0);
  const expiredSecret = Buffer.from(expired.secretB64(), "base64");
  check(
    "an expired window refuses the correct secret",
    expired.consume(expiredSecret, T0 + 2 * 60 * 1000) === false,
  );
  check(
    "expiry boundary: one ms before the deadline still works",
    new pairing.PairingWindow(T0).isExpired(T0 + 2 * 60 * 1000 - 1) === false,
  );

  /* ---- QR payload against the real phone parser ------------------------- */

  const qrWin = new pairing.PairingWindow(T0);
  const identityKey = Buffer.alloc(32, 3);
  const qr = pairing.buildQrPayloadString({
    publicKeyB64: identityKey.toString("base64"),
    addrs: ["192.168.1.20", "127.0.0.1"],
    port: 40123,
    window: qrWin,
    name: "Etienne's Studio \u001b[31m",
    now: T0,
  });
  const parsedQr = JSON.parse(qr);
  check("qr: v is 1", parsedQr.v === 1);
  check("qr: pk is canonical padded base64 of 32 bytes", parsedQr.pk === identityKey.toString("base64"));
  check("qr: iat is included", parsedQr.iat === T0);
  check("qr: secret decodes to 32 bytes", Buffer.from(parsedQr.secret, "base64").length === 32);
  check("qr: name is control-stripped", !/[\u0000-\u001f]/.test(parsedQr.name));

  if (fs.existsSync(MOBILE_PARSER)) {
    const mobile = await bundle(MOBILE_PARSER, "remote-access-mobile-parser-test.cjs");
    const accepted = mobile.parsePairingPayload(qr, T0 + 30_000);
    check("phone parser accepts our payload", accepted.ok === true, accepted);
    if (accepted.ok) {
      check("phone parser keeps our canonical pk", accepted.payload.pk === parsedQr.pk);
      check("phone parser keeps our addrs", accepted.payload.addrs.length === 2);
    }
    const stale = mobile.parsePairingPayload(qr, T0 + 2 * 60 * 1000 + 1);
    check("phone parser expires our payload after 2 minutes", stale.ok === false && stale.code === "expired", stale);
  } else {
    console.log("SKIP phone-parser interop (codara-mobile checkout not found)");
  }

  /* ---- paired-device store ---------------------------------------------- */

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-test-"));
  try {
    const store = new pairing.PairedDeviceStore(dir);
    const keyA = Buffer.alloc(32, 1);
    const keyB = Buffer.alloc(32, 2);
    check("empty store authorizes nothing", store.isAuthorized(keyA) === false);

    store.addDevice(keyA, "Phone A", T0);
    check("paired key is authorized", store.isAuthorized(keyA) === true);
    check("unknown key is rejected", store.isAuthorized(keyB) === false);
    check("wrong-length key is rejected", pairing.isAuthorizedKey(Buffer.alloc(16, 1), store.list()) === false);

    // Persistence: a new store over the same dir sees the same devices.
    const reread = new pairing.PairedDeviceStore(dir);
    check("devices persist across store instances", reread.isAuthorized(keyA) === true);
    check("persisted record keeps name and addedAt", (() => {
      const record = reread.list()[0];
      return record.name === "Phone A" && record.addedAt === T0;
    })());

    if (process.platform !== "win32") {
      const mode = fs.statSync(path.join(dir, "paired-devices.json")).mode & 0o777;
      check("paired-devices.json is 0600", mode === 0o600, mode.toString(8));
    }

    // Re-pairing the same key updates in place instead of duplicating.
    store.addDevice(keyA, "Phone A renamed", T0 + 5);
    check("re-pair does not duplicate", store.list().length === 1);
    check("re-pair updates the name", store.list()[0].name === "Phone A renamed");
    check("re-pair keeps the original addedAt", store.list()[0].addedAt === T0);

    // Revocation: key gone, persisted, and the firewall refuses it again.
    store.addDevice(keyB, "Phone B", T0 + 10);
    check("revoke reports removal", (await store.revokeDevice(keyA.toString("base64"))) === true);
    check("revoked key is rejected", store.isAuthorized(keyA) === false);
    check("other devices survive a revoke", store.isAuthorized(keyB) === true);
    check("revoke persists", new pairing.PairedDeviceStore(dir).isAuthorized(keyA) === false);
    check("revoking an unknown key is a no-op", (await store.revokeDevice(keyA.toString("base64"))) === false);

    // A corrupt trust store fails closed: nobody is authorized.
    fs.writeFileSync(path.join(dir, "paired-devices.json"), "{not json");
    const corrupt = new pairing.PairedDeviceStore(dir);
    check("corrupt device file authorizes nothing", corrupt.isAuthorized(keyB) === false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---- framing ---------------------------------------------------------- */

  const frameA = rpc.encodeFrame({ id: 1, method: "ping", params: { nonce: "n" } });
  check("frame length prefix matches body", frameA.readUInt32BE(0) === frameA.length - 4);

  const decoder = new rpc.FrameDecoder();
  // Two frames delivered across pathological chunk boundaries.
  const frameB = rpc.encodeFrame({ id: 2, ok: true, result: {} });
  const joined = Buffer.concat([frameA, frameB]);
  let decoded = [];
  for (let i = 0; i < joined.length; i += 3) {
    decoded = decoded.concat(decoder.push(joined.subarray(i, Math.min(i + 3, joined.length))));
  }
  check("decoder reassembles frames across chunk splits", decoded.length === 2);
  check("decoded frame round-trips", decoded[0].method === "ping" && decoded[1].id === 2);

  // Oversize: the declared length alone must reject, before any body bytes.
  const big = Buffer.alloc(4);
  big.writeUInt32BE(rpc.MAX_FRAME_BYTES + 1, 0);
  let limitErr = null;
  try {
    new rpc.FrameDecoder().push(big);
  } catch (err) {
    limitErr = err;
  }
  check("oversized declared frame throws FrameLimitError", limitErr?.name === "FrameLimitError");

  const atLimit = new rpc.FrameDecoder(64);
  const smallFrame = rpc.encodeFrame({ pad: "x".repeat(20) });
  check("frames under a custom limit pass", atLimit.push(smallFrame).length === 1);

  /* ---- rpc session ------------------------------------------------------ */

  // A minimal in-process duplex: write() parses server frames, push()
  // injects client bytes.
  // `writeAccepts` models Node's Writable contract: set it false to make
  // write() report backpressure, then call drain() to release it.
  function makeFakeStream() {
    const handlers = { data: [], close: [], error: [], drain: [] };
    const outDecoder = new rpc.FrameDecoder();
    const outbox = [];
    return {
      outbox,
      writeAccepts: true,
      write(buf) {
        for (const frame of outDecoder.push(buf)) outbox.push(frame);
        return this.writeAccepts;
      },
      destroyed: false,
      destroy() {
        this.destroyed = true;
        for (const h of handlers.close) h();
      },
      on(event, handler) {
        handlers[event].push(handler);
      },
      inject(buf) {
        for (const h of handlers.data) h(buf);
      },
      drain() {
        this.writeAccepts = true;
        for (const h of handlers.drain) h();
      },
    };
  }

  const madeTerminals = [];
  const services = {
    device: { publicKey: "pk", name: "Studio", role: "computer", version: "0.0.0" },
    listWorkspaces: async () => [{ id: "ws1", name: "One", path: "/tmp/one" }],
    createTerminal: async (request) => {
      const terminal = {
        request,
        closed: false,
        paused: false,
        written: [],
        write(data) {
          this.written.push(data);
        },
        resize() {},
        pause() {
          this.paused = true;
        },
        resume() {
          this.paused = false;
        },
        close() {
          this.closed = true;
        },
      };
      madeTerminals.push(terminal);
      return terminal;
    },
  };

  const stream = makeFakeStream();
  const session = new rpc.RpcSession(stream, services);
  const request = (id, method, params) => stream.inject(rpc.encodeFrame({ id, method, params }));
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  request(1, "workspaces.list", {});
  await flush();
  check(
    "methods before hello are refused",
    stream.outbox[0]?.ok === false && stream.outbox[0]?.error.code === "not-connected",
    stream.outbox[0],
  );

  request(2, "hello", { protocol: 99, device: services.device });
  await flush();
  check(
    "wrong protocol version is refused",
    stream.outbox[1]?.ok === false && stream.outbox[1]?.error.code === "unsupported-protocol",
  );

  request(3, "hello", { protocol: 0, device: { publicKey: "c", name: "Phone", role: "phone", version: "1" } });
  await flush();
  check(
    "hello succeeds and reports our device",
    stream.outbox[2]?.ok === true && stream.outbox[2]?.result.device.role === "computer",
    stream.outbox[2],
  );

  request(4, "workspaces.list", {});
  await flush();
  check("workspaces.list answers", stream.outbox[3]?.result.workspaces[0].id === "ws1");

  request(5, "terminal.create", { workspaceId: "ws1", cols: 80, rows: 24 });
  await flush();
  const terminalId = stream.outbox[4]?.result?.terminalId;
  check("terminal.create returns an id", typeof terminalId === "string", stream.outbox[4]);

  madeTerminals[0].request.onData("hi from pty");
  check(
    "pty output arrives as a terminal.data event",
    stream.outbox[5]?.event === "terminal.data" && stream.outbox[5]?.payload.data === "hi from pty",
    stream.outbox[5],
  );

  request(6, "terminal.write", { terminalId, data: "echo x\n" });
  await flush();
  check("terminal.write reaches the pty", madeTerminals[0].written[0] === "echo x\n");

  request(7, "terminal.write", { terminalId: "rt-nope", data: "x" });
  await flush();
  check(
    "unknown terminal id errors cleanly",
    stream.outbox[7]?.ok === false && stream.outbox[7]?.error.code === "unknown-terminal",
  );

  // Per-connection terminal cap.
  for (let i = 0; i < rpc.MAX_TERMINALS_PER_CONNECTION; i += 1) {
    request(10 + i, "terminal.create", { workspaceId: "ws1", cols: 80, rows: 24 });
  }
  await flush();
  // Replies interleave (cap refusals are synchronous, successes resolve a
  // spawn later), so search rather than assume ordering: of the 8 creates,
  // 7 fill the cap (one terminal already exists) and exactly 1 is refused.
  const refused = stream.outbox.filter(
    (frame) => frame?.ok === false && /terminals open/.test(frame?.error?.message ?? ""),
  );
  check("terminal cap refuses the create over the limit", refused.length === 1, refused.length);
  check("session tracks the capped terminal count", session.terminalCount() === rpc.MAX_TERMINALS_PER_CONNECTION);

  // destroy() (the revoke path) closes every terminal the session owns.
  session.destroy();
  check("destroy closes all session terminals", madeTerminals.every((t) => t.closed));
  check("destroy tears the stream down", stream.destroyed === true);

  // Oversized inbound frame drops the connection.
  const stream2 = makeFakeStream();
  void new rpc.RpcSession(stream2, services);
  const evil = Buffer.alloc(4);
  evil.writeUInt32BE(rpc.MAX_FRAME_BYTES + 1, 0);
  stream2.inject(evil);
  check("oversized inbound frame destroys the session", stream2.destroyed === true);
  check("no reply is sent for a framing violation", stream2.outbox.length === 0);

  /* ---- outbound backpressure (F5) --------------------------------------- */

  const bpStream = makeFakeStream();
  void new rpc.RpcSession(bpStream, services);
  const bpRequest = (id, method, params) =>
    bpStream.inject(rpc.encodeFrame({ id, method, params }));
  bpRequest(1, "hello", { protocol: 0, device: services.device });
  await flush();
  bpRequest(2, "terminal.create", { workspaceId: "ws1", cols: 80, rows: 24 });
  await flush();
  const bpTerminal = madeTerminals[madeTerminals.length - 1];
  check("a fresh terminal is not paused", bpTerminal.paused === false);

  // The peer stops draining: the next write reports backpressure, which
  // must stop the pty rather than let us buffer without limit.
  bpStream.writeAccepts = false;
  bpTerminal.request.onData("x".repeat(100));
  check("backpressure pauses the pty", bpTerminal.paused === true);

  // Past the cap, output is dropped instead of queued.
  const beforeDrop = bpStream.outbox.length;
  for (let i = 0; i < 20; i += 1) {
    bpTerminal.request.onData("y".repeat(100_000));
  }
  const emitted = bpStream.outbox.length - beforeDrop;
  check(
    "queued output past the cap is dropped, not buffered",
    emitted * 100_000 <= rpc.MAX_PENDING_EVENT_BYTES,
    emitted,
  );

  bpStream.drain();
  check("drain resumes the pty", bpTerminal.paused === false);
  const afterDrain = bpStream.outbox.length;
  bpTerminal.request.onData("z");
  check("output flows again after drain", bpStream.outbox.length === afterDrain + 1);

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all remote-access checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
