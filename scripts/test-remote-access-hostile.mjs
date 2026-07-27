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

const PAIRED_DEVICES_FILE = "paired-devices.json";

// The store on its own, without the service around it. Bundled separately
// so the F4 test can drive PairedDeviceStore directly.
async function loadPairing() {
  const cacheDir = join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = join(cacheDir, "remote-access-hostile-pairing.cjs");
  await build({
    entryPoints: [join(ROOT, "src", "main", "remote-access", "pairing.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": join(ROOT, "src", "shared") },
    external: ["sodium-native"],
  });
  delete require.cache[outfile];
  return require(outfile);
}

// Reads the trust file the way a fresh app launch would.
function readDevices(home) {
  try {
    const raw = require("node:fs").readFileSync(join(home, PAIRED_DEVICES_FILE), "utf8");
    return JSON.parse(raw).devices ?? [];
  } catch {
    return [];
  }
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

  /* ====================================================================== */
  /* F4: a revoke must never be undone by an in-flight last-seen flush      */
  /* ====================================================================== */

  {
    // The store's cosmetic last-seen flush is async. A revoke is synchronous
    // and is the security boundary of the feature, so it has to win no
    // matter where the flush happens to be. This drives the REAL scheduled
    // flush callback and fires the revoke inside the async write window by
    // holding fs.promises.writeFile open, which makes the race deterministic
    // instead of relying on timing luck.
    const pairingModule = await loadPairing();
    const nodeFs = require("node:fs");
    const realWriteFile = nodeFs.promises.writeFile;

    const home = mkdtempSync(join(tmpdir(), "codara-hostile-f4-"));
    const deviceKey = Buffer.alloc(32, 9);
    const deviceKeyB64 = deviceKey.toString("base64");
    try {
      const store = new pairingModule.PairedDeviceStore(home);
      store.addDevice(deviceKey, "Doomed phone", Date.now());
      check("F4 setup: the device is paired and on disk", readDevices(home).length === 1);

      // Hold the flush inside its write, revoke while it is suspended, then
      // let it finish. This is step 2-to-4 of the reported sequence.
      let releaseWrite;
      let writeEntered;
      const entered = new Promise((r) => {
        writeEntered = r;
      });
      const released = new Promise((r) => {
        releaseWrite = r;
      });
      let intercepted = false;
      nodeFs.promises.writeFile = async (...args) => {
        if (!intercepted && String(args[0]).includes(PAIRED_DEVICES_FILE)) {
          intercepted = true;
          writeEntered();
          await released;
        }
        return realWriteFile.apply(nodeFs.promises, args);
      };

      // Schedule the flush the way production does, then run it now rather
      // than waiting out the coalescing delay.
      store.touchLastSeen(deviceKey, Date.now());
      const flushing = store.flushPendingWrites();
      await entered;

      // The revoke lands while the flush is suspended mid-write.
      const revoked = store.revokeDevice(deviceKeyB64);
      check("F4: revoke reports success during the flush window", revoked === true);
      check("F4: revoke is durable immediately", readDevices(home).length === 0, readDevices(home));

      releaseWrite();
      await flushing;
      await store.flushPendingWrites();

      check(
        "F4: the in-flight flush did not resurrect the revoked device on disk",
        readDevices(home).length === 0,
        readDevices(home),
      );

      // The real proof: a fresh store, as a new app launch would build it.
      const reloaded = new pairingModule.PairedDeviceStore(home);
      check(
        "F4: a fresh store does not re-authorize the revoked device",
        reloaded.isAuthorized(deviceKey) === false,
        reloaded.list(),
      );

      // The hardest window: the revoke lands while the flush's RENAME is
      // already on the threadpool, so the flush genuinely can clobber the
      // authoritative file and the only cure is re-asserting the truth
      // afterwards. Intercepting rename (not writeFile) is what puts the
      // race in that exact window.
      //
      // Note on what this case does and does not prove. Unlike the F4 case
      // above, it does NOT fail against the ORIGINAL code, because there
      // both writers shared one tmp path: the synchronous revoke happened to
      // overwrite and then rename away the very staging file the flush was
      // about to publish, so the flush's rename failed with ENOENT and the
      // revoke survived by accident. What this case guards is the deliberate
      // repair in the CURRENT design, where unique tmp names remove that
      // accident. Verified by deleting the post-rename repair: both
      // assertions below fail without it.
      nodeFs.promises.writeFile = realWriteFile;
      const realRename = nodeFs.promises.rename;
      const home2 = mkdtempSync(join(tmpdir(), "codara-hostile-f4b-"));
      try {
        const store3 = new pairingModule.PairedDeviceStore(home2);
        store3.addDevice(deviceKey, "Doomed again", Date.now());

        let releaseRename;
        let renameEntered;
        const enteredRename = new Promise((r) => {
          renameEntered = r;
        });
        const releasedRename = new Promise((r) => {
          releaseRename = r;
        });
        let renameIntercepted = false;
        nodeFs.promises.rename = async (...args) => {
          if (!renameIntercepted && String(args[1]).includes(PAIRED_DEVICES_FILE)) {
            renameIntercepted = true;
            renameEntered();
            await releasedRename;
          }
          return realRename.apply(nodeFs.promises, args);
        };

        store3.touchLastSeen(deviceKey, Date.now());
        const flushing3 = store3.flushPendingWrites();
        await enteredRename;
        check("F4b: revoke lands while the flush rename is in flight", store3.revokeDevice(deviceKeyB64) === true);
        releaseRename();
        await flushing3;
        await store3.flushPendingWrites();

        check(
          "F4b: the clobbering rename is repaired, revoke is the last word",
          readDevices(home2).length === 0,
          readDevices(home2),
        );
        check(
          "F4b: a fresh store still does not re-authorize",
          new pairingModule.PairedDeviceStore(home2).isAuthorized(deviceKey) === false,
        );
      } finally {
        nodeFs.promises.rename = realRename;
        rmSync(home2, { recursive: true, force: true });
      }

      // A flush that is NOT racing a revoke must still persist lastSeen,
      // otherwise the fix would have quietly broken the feature.
      const store2 = new pairingModule.PairedDeviceStore(home);
      store2.addDevice(deviceKey, "Second phone", 1000);
      store2.touchLastSeen(deviceKey, 4242);
      await store2.flushPendingWrites();
      check(
        "F4: an unraced last-seen flush still persists normally",
        readDevices(home)[0]?.lastSeenAt === 4242,
        readDevices(home)[0],
      );
    } finally {
      nodeFs.promises.writeFile = realWriteFile;
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
