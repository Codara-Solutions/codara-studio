// Regression tests for the two blocking pre-authentication denial of
// service bugs found in the phase 1 adversarial review. These drive the
// REAL RemoteAccessService over real TCP sockets, because both bugs live in
// the accept path and neither is reachable from the in-process fake duplex
// the unit suite uses.
//
//   node scripts/test-remote-access-hostile.mjs
//
// F1: an accepted socket costs memory before anyone authenticates. The
// Noise layer sizes a buffer from a 24-bit length the peer declares in its
// first three bytes, so four bytes of attacker input allocate ~16 MiB, and
// with no handshake deadline that allocation was held forever. Asserted
// here: sockets past the pre-auth cap are refused at once, a silent socket
// is destroyed on the deadline, and total memory growth stays bounded well
// below what the attempted connections asked for.
//
// F2: stop() awaited server.close(), which Node only settles once every
// accepted connection has ended, so a single idle socket wedged shutdown
// forever, left the DHT announcing, and made the feature impossible to
// re-enable. Asserted here against a LOCAL DHT testnet (no public network):
// disable resolves promptly with an idle hostile socket attached, status
// returns to disabled, the DHT really is torn down, and re-enabling works.

import { connect } from "node:net";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const NoiseSecretStream = require("@hyperswarm/secret-stream");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Three bytes of 0xff declare the largest frame the Noise framing allows
// (~16 MiB); the fourth byte pushes the parser into the body state, which
// is where it allocates. This is the amplification primitive.
const EVIL_HEADER = Buffer.from([0xff, 0xff, 0xff, 0x00]);
const HANDSHAKE_DEADLINE_MS = 5_000;
const MAX_PENDING_HANDSHAKES = 8;
// Mirrors the caps in src/main/remote-access/index.ts.
const MAX_SESSIONS_PER_DEVICE = 4;
const MAX_TOTAL_SESSIONS = 16;

let failures = 0;
const check = (name, condition, detail) => {
  if (!condition) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

async function loadService() {
  const cacheDir = join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = join(cacheDir, "remote-access-hostile-service.cjs");
  await build({
    entryPoints: [join(ROOT, "src", "main", "remote-access", "index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": join(ROOT, "src", "shared") },
    external: ["sodium-native", "hyperdht", "@hyperswarm/secret-stream", "electron"],
  });
  delete require.cache[outfile];
  return require(outfile);
}

function makeService(RemoteAccessService, home, extra = {}) {
  return new RemoteAccessService({
    remoteDir: join(home, "remote"),
    deviceName: "Hostile Test Studio",
    appVersion: "0.0.0-test",
    listWorkspaces: async () => [],
    createTerminal: async () => {
      throw new Error("no terminals in this harness");
    },
    log: () => {},
    host: "127.0.0.1",
    advertisedAddrs: ["127.0.0.1"],
    dhtBootstrap: false,
    ...extra,
  });
}

// A raw TCP socket that never completes a handshake. `bytes` is what it
// sends immediately after connecting.
function hostileSocket(port, bytes) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const state = { socket, closed: false, closedAt: 0, connectedAt: 0 };
    socket.on("error", () => {
      // A refused or reset connection is a normal outcome here.
    });
    socket.on("close", () => {
      state.closed = true;
      state.closedAt = Date.now();
    });
    socket.on("connect", () => {
      state.connectedAt = Date.now();
      if (bytes) socket.write(bytes);
      resolvePromise(state);
    });
    setTimeout(() => reject(new Error("hostile socket never connected")), 5_000);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A legitimate client dial: Noise IK pinned to the computer's key, the same
// handshake the phone and the test client perform.
function noiseDial(port, keyPair, remotePublicKey) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("error", reject);
    const stream = new NoiseSecretStream(true, socket, {
      keyPair,
      remotePublicKey,
      pattern: "IK",
    });
    stream.on("error", reject);
    stream.on("open", () => resolvePromise(stream));
    setTimeout(() => reject(new Error("noise dial timed out")), 5_000);
  });
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function waitForFrame(stream, timeoutMs = 5_000) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("no frame arrived")), timeoutMs);
    stream.on("data", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function main() {
  const { RemoteAccessService } = await loadService();

  /* ====================================================================== */
  /* F1: unauthenticated memory amplification and handshake deadline        */
  /* ====================================================================== */

  {
    const home = mkdtempSync(join(tmpdir(), "codara-hostile-f1-"));
    const service = makeService(RemoteAccessService, home);
    try {
      const status = await service.setEnabled(true);
      check("F1 setup: listener is reachable", status.state === "reachable", status);
      const port = status.port;

      if (global.gc) global.gc();
      const baseline = process.memoryUsage().external;

      // Attempt far more connections than the pre-auth cap allows, each
      // asking for the maximum allocation. Unfixed, this is the 200 x 16 MiB
      // pattern that OOM-killed the app.
      const attempts = 40;
      const sockets = [];
      for (let i = 0; i < attempts; i += 1) {
        sockets.push(await hostileSocket(port, EVIL_HEADER));
      }
      await wait(500);

      const stillOpen = sockets.filter((s) => !s.closed).length;
      check(
        "F1: sockets past the pre-auth cap are refused immediately",
        stillOpen <= MAX_PENDING_HANDSHAKES,
        { attempts, stillOpen, cap: MAX_PENDING_HANDSHAKES },
      );

      if (global.gc) global.gc();
      const peak = process.memoryUsage().external;
      const grewMiB = (peak - baseline) / (1024 * 1024);
      // Every attempt asked for ~16 MiB. Only the ones inside the cap can
      // ever hold one, so the ceiling is ~8 x 16 MiB with headroom, not
      // 40 x 16 MiB (640 MiB).
      const ceilingMiB = (MAX_PENDING_HANDSHAKES + 4) * 16;
      check(
        "F1: unauthenticated memory growth stays bounded by the cap",
        grewMiB < ceilingMiB,
        { grewMiB: Math.round(grewMiB), ceilingMiB, attemptedMiB: attempts * 16 },
      );

      // The survivors must die on the deadline rather than linger.
      const survivors = sockets.filter((s) => !s.closed);
      await wait(HANDSHAKE_DEADLINE_MS + 2_000);
      const stillAliveAfterDeadline = survivors.filter((s) => !s.closed).length;
      check(
        "F1: a silent socket is destroyed on the handshake deadline",
        stillAliveAfterDeadline === 0,
        { survivors: survivors.length, stillAliveAfterDeadline },
      );

      if (global.gc) global.gc();
      const afterMiB = (process.memoryUsage().external - baseline) / (1024 * 1024);
      check(
        "F1: memory is released once the deadline reaps the sockets",
        afterMiB < ceilingMiB,
        { afterMiB: Math.round(afterMiB) },
      );

      for (const s of sockets) s.socket.destroy();
    } finally {
      await service.setEnabled(false).catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  }

  /* ====================================================================== */
  /* F2: shutdown wedged by one idle socket                                 */
  /* ====================================================================== */

  {
    const createTestnet = require("hyperdht/testnet");
    const HyperDHT = require("hyperdht");
    // A local DHT so the announce and its teardown are real without
    // touching the public network.
    const testnet = await createTestnet(4);
    const home = mkdtempSync(join(tmpdir(), "codara-hostile-f2-"));
    const service = makeService(RemoteAccessService, home, {
      dhtBootstrap: testnet.bootstrap,
    });
    try {
      const status = await service.setEnabled(true);
      check("F2 setup: listener is reachable", status.state === "reachable", status);
      check("F2 setup: the dht rung announced on the testnet", status.dhtReady === true, status);

      // One hostile socket: connected, mid-handshake, and silent. This is
      // the single connection that used to hang shutdown forever.
      const idle = await hostileSocket(status.port, EVIL_HEADER);
      // The client's "connect" fires on the SYN-ACK, which can be BEFORE
      // the server has accepted. Without this settle the shutdown races the
      // accept, server.close() finds no live connection, and the test
      // passes even against the unfixed code. Verified: with this wait the
      // pre-fix listener hangs here, without it the test is vacuous.
      await wait(300);
      check("F2 setup: the idle hostile socket is connected", idle.closed === false);

      const startedAt = Date.now();
      const disabled = await Promise.race([
        service.setEnabled(false).then(() => "resolved"),
        wait(HANDSHAKE_DEADLINE_MS + 5_000).then(() => "timed-out"),
      ]);
      const elapsed = Date.now() - startedAt;

      check("F2: disable resolves despite the idle socket", disabled === "resolved", {
        disabled,
        elapsed,
      });
      check("F2: disable does not wait for the handshake deadline", elapsed < HANDSHAKE_DEADLINE_MS, {
        elapsed,
      });
      check(
        "F2: status returns to disabled",
        service.getStatus().state === "disabled",
        service.getStatus(),
      );
      check("F2: the idle socket was destroyed by shutdown", idle.closed === true);

      // The DHT must really be torn down even though the TCP half of
      // shutdown had a hostile socket attached. This is asserted on the
      // listener's own state rather than by dialling the key: the firewall
      // refuses an unpaired probe whether or not we are still announcing,
      // so a connection attempt would fail either way and prove nothing.
      check("F2: the dht was torn down despite the stuck tcp close", service.isDhtActive() === false);

      // The lifecycle chain must not be poisoned: re-enabling has to work.
      const reEnabled = await Promise.race([
        service.setEnabled(true),
        wait(20_000).then(() => "timed-out"),
      ]);
      check(
        "F2: remote access can be re-enabled without an app restart",
        reEnabled !== "timed-out" && reEnabled.state === "reachable",
        reEnabled,
      );
      check(
        "F2: the dht rung comes back after a re-enable",
        reEnabled !== "timed-out" && reEnabled.dhtReady === true,
        reEnabled,
      );

      idle.socket.destroy();
    } finally {
      await service.setEnabled(false).catch(() => undefined);
      await testnet.destroy().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  }

  /* ====================================================================== */
  /* F3: connection caps make the per-connection terminal cap mean something */
  /* ====================================================================== */

  {
    const HyperDHT = require("hyperdht");
    const home = mkdtempSync(join(tmpdir(), "codara-hostile-f3-"));
    const service = makeService(RemoteAccessService, home);
    const clientKeyPair = HyperDHT.keyPair();
    const clientKeyB64 = clientKeyPair.publicKey.toString("base64");
    const opened = [];
    try {
      const status = await service.setEnabled(true);

      // Pair honestly first, so every connection below is AUTHORIZED. The
      // cap has to hold against a trusted-but-misbehaving device, which is
      // the whole threat: a paired phone is already allowed to spawn ptys.
      const session = service.startPairing();
      const payload = JSON.parse(session.qrPayload);
      const computerKey = Buffer.from(payload.pk, "base64");
      const pairStream = await noiseDial(status.port, clientKeyPair, computerKey);
      pairStream.write(encodeFrame({ t: "pair", secret: payload.secret, name: "cap-test" }));
      await waitForFrame(pairStream);
      pairStream.destroy();
      check("F3 setup: the test device paired", service.listPairedDevices().length === 1);

      // Now stack far more concurrent connections than one device may hold.
      const attempts = MAX_SESSIONS_PER_DEVICE + 4;
      for (let i = 0; i < attempts; i += 1) {
        const stream = await noiseDial(status.port, clientKeyPair, computerKey);
        opened.push(stream);
        await wait(60);
      }
      await wait(300);

      check(
        "F3: one device cannot exceed its concurrent session cap",
        service.sessionCountFor(clientKeyB64) <= MAX_SESSIONS_PER_DEVICE,
        { attempts, live: service.sessionCountFor(clientKeyB64), cap: MAX_SESSIONS_PER_DEVICE },
      );
      check(
        "F3: the global session count stays bounded too",
        service.totalSessionCount() <= MAX_TOTAL_SESSIONS,
        service.totalSessionCount(),
      );
      // The point of the cap: without it these connections would have
      // multiplied the 8-terminals-per-connection budget by `attempts`.
      check(
        "F3: the device's pty budget is capped, not multiplied per connection",
        service.sessionCountFor(clientKeyB64) * 8 < attempts * 8,
        { effectiveTerminalBudget: service.sessionCountFor(clientKeyB64) * 8 },
      );
    } finally {
      for (const s of opened) s.destroy();
      await service.setEnabled(false).catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  }

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all hostile-peer checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
