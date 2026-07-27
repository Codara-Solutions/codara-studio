// End-to-end proof for phone Remote Access, with no Electron and no live
// DHT: it boots the REAL RemoteAccessService (identity, listener, Noise IK,
// pairing, RPC, session registry) over a temp home and a real node-pty
// shell, then drives scripts/remote-test-client.mjs against it exactly as a
// phone would.
//
//   node scripts/remote-access-e2e.mjs
//
// Sequence: enable -> start pairing -> client pairs over LAN -> client
// reconnects and runs hello + workspaces.list + a terminal echo round trip
// -> revoke -> client is refused. Exit code 0 only if every stage behaves.
//
// The DHT rung is disabled here (dhtBootstrap: false) so the run needs no
// network; the LAN rung it exercises is the same Noise IK code path the DHT
// rung hands its streams to.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (!condition) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

// Bundle the service exactly as the main process would consume it, with the
// native and Electron-only bits left external.
async function loadService() {
  const cacheDir = join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = join(cacheDir, "remote-access-e2e-service.cjs");
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

function runClient(args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts", "remote-test-client.mjs"), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function indent(text) {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => `       ${line}`)
    .join("\n");
}

async function main() {
  const { RemoteAccessService } = await loadService();
  const pty = require("node-pty");

  const home = mkdtempSync(join(tmpdir(), "codara-remote-e2e-"));
  const clientDir = mkdtempSync(join(tmpdir(), "codara-remote-client-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "codara-remote-ws-"));
  const logLines = [];

  // A real pty per terminal.create, wired to the RPC session the same way
  // production.ts wires pty-manager.
  const liveTerminals = new Set();
  const service = new RemoteAccessService({
    remoteDir: join(home, "remote"),
    deviceName: "E2E Studio",
    appVersion: "0.0.0-e2e",
    listWorkspaces: async () => [{ id: "ws-e2e", name: "E2E workspace", path: workspaceDir }],
    createTerminal: async (request) => {
      if (request.workspaceId !== "ws-e2e") throw new Error("Unknown workspace");
      const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
      const child = pty.spawn(shell, [], {
        name: "xterm-color",
        cols: request.cols,
        rows: request.rows,
        cwd: workspaceDir,
        env: { ...process.env, PS1: "$ " },
      });
      liveTerminals.add(child);
      child.onData((data) => request.onData(data));
      child.onExit(() => {
        liveTerminals.delete(child);
        request.onExit();
      });
      return {
        write: (data) => child.write(data),
        resize: (cols, rows) => child.resize(cols, rows),
        close: () => {
          liveTerminals.delete(child);
          try {
            child.kill();
          } catch {
            // Already gone.
          }
        },
      };
    },
    log: (line) => logLines.push(line),
    // Loopback only, no DHT: this run must not touch the network.
    host: "127.0.0.1",
    dhtBootstrap: false,
    advertisedAddrs: ["127.0.0.1"],
  });

  try {
    /* ---- enable ---------------------------------------------------------- */
    const status = await service.setEnabled(true);
    check("listener reaches the reachable state", status.state === "reachable", status);
    check("listener reports a port", typeof status.port === "number" && status.port > 0, status.port);
    check("dht rung is off in this harness", status.dhtReady === false);

    /* ---- pairing --------------------------------------------------------- */
    const pairingStates = [];
    service.onPairingChanged((state) => pairingStates.push(state));
    const session = service.startPairing();
    const payload = JSON.parse(session.qrPayload);
    check("qr payload carries the live port", payload.port === status.port, payload.port);
    check("qr payload carries iat", typeof payload.iat === "number");
    check("no devices are paired yet", service.listPairedDevices().length === 0);

    console.log("  running: remote-test-client pair");
    const paired = await runClient(["pair", session.qrPayload], clientDir);
    console.log(indent(paired.stdout + paired.stderr));
    check("client pairs successfully", paired.code === 0, paired.stderr.trim());

    const devices = service.listPairedDevices();
    check("the device is now in the paired list", devices.length === 1, devices.length);
    check("paired device carries the client name", devices[0]?.name === "remote-test-client", devices[0]?.name);
    check("paired device exposes only a short key for display", devices[0]?.shortKey.length === 8);
    check(
      "the pairing modal is told about the new device",
      pairingStates.some((state) => state.phase === "paired" && state.deviceName === "remote-test-client"),
      pairingStates,
    );
    // Single use: the window was consumed by the pairing above, and the
    // listener stopped accepting strangers the moment it succeeded, so the
    // same QR must not pair a second device.
    const replay = await runClient(["pair", session.qrPayload], clientDir);
    check("replaying the same QR payload is refused", replay.code !== 0, replay.stdout.trim());
    check("a replayed pairing adds no device", service.listPairedDevices().length === 1);

    /* ---- connect + terminal round trip ----------------------------------- */
    console.log("  running: remote-test-client connect");
    const connected = await runClient(["connect", "--no-dht"], clientDir);
    console.log(indent(connected.stdout + connected.stderr));
    check("client reconnects and completes the round trip", connected.code === 0, connected.stderr.trim());
    check("hello identifies the computer", /hello: E2E Studio/.test(connected.stdout));
    check("ping nonce matches", /ping: nonce matched/.test(connected.stdout));
    check("workspaces.list returns the workspace", /E2E workspace/.test(connected.stdout));
    check("the terminal echoed through the pty", /hello-from-remote/.test(connected.stdout));
    check("round trip reported complete", /round trip complete/.test(connected.stdout));

    /* ---- revoke ---------------------------------------------------------- */
    const revoked = service.revokeDevice(devices[0].publicKey);
    check("revoke reports success", revoked === true);
    check("the paired list is empty after revoke", service.listPairedDevices().length === 0);

    console.log("  running: remote-test-client connect (after revoke)");
    const afterRevoke = await runClient(["connect", "--no-dht"], clientDir);
    console.log(indent(afterRevoke.stdout + afterRevoke.stderr));
    check("a revoked client cannot connect", afterRevoke.code !== 0, afterRevoke.stdout.trim());

    /* ---- secrets never reach the log ------------------------------------- */
    const log = logLines.join("\n");
    check("no pairing secret appears in the log", !log.includes(payload.secret));
    check("no full public key appears in the log", !log.includes(payload.pk));
    check("the log does name the device by short key", /paired device [A-Za-z0-9+/]{8} /.test(log), log);

    await service.setEnabled(false);
    check("disable returns to the disabled state", service.getStatus().state === "disabled");
  } finally {
    for (const child of liveTerminals) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
    await service.setEnabled(false).catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(clientDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("remote access end to end proof passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
