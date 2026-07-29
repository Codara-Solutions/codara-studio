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
// No live relay, no sockets: everything below is in-process.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
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
const MOBILE_RPC_TYPES = path.resolve(
  ROOT,
  "..",
  "codara-mobile",
  "src",
  "lib",
  "remote",
  "types.ts",
);
const MOBILE_STABLE_PORT = path.resolve(
  ROOT,
  "..",
  "codara-mobile",
  "worklet",
  "lib",
  "stable-port.js",
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
    // Native addons must load from their installed package paths rather than
    // from inside the generated cache bundle, where require.addon cannot find
    // their prebuilds.
    external: ["sodium-native", "@hyperswarm/secret-stream", "ws"],
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
  const identity = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "identity.ts"),
    "remote-access-identity-test.cjs",
  );
  const localPolicy = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "local-policy.ts"),
    "remote-access-local-policy-test.cjs",
  );
  const fileMutations = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "file-mutations.ts"),
    "remote-access-file-mutations-test.cjs",
  );
  const imageUpload = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "image-upload.ts"),
    "remote-access-image-upload-test.cjs",
  );
  const coraPolicy = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "cora-policy.ts"),
    "remote-access-cora-policy-test.cjs",
  );
  const stablePort = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "stable-port.ts"),
    "remote-access-stable-port-test.cjs",
  );
  const remoteAccess = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "index.ts"),
    "remote-access-lifecycle-test.cjs",
  );
  const remoteIndexSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "remote-access", "index.ts"),
    "utf8",
  );
  const productionSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "remote-access", "production.ts"),
    "utf8",
  );
  const rpcSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "remote-access", "rpc.ts"),
    "utf8",
  );
  const rendererTerminalRpcSource = fs.readFileSync(
    path.join(
      ROOT,
      "src",
      "renderer",
      "src",
      "components",
      "Terminal",
      "terminalRpc.ts",
    ),
    "utf8",
  );
  const terminalSessionSource = fs.readFileSync(
    path.join(
      ROOT,
      "src",
      "renderer",
      "src",
      "components",
      "Terminal",
      "useTerminalSession.ts",
    ),
    "utf8",
  );
  const ptyManagerSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "pty-manager.ts"),
    "utf8",
  );
  check(
    "phone-origin terminal geometry reaches both the Studio xterm and PTY",
    productionSource.includes("initialCols: request.cols") &&
      productionSource.includes("initialRows: request.rows") &&
      productionSource.includes('"resize"') &&
      productionSource.includes(
        "pty.resize(result.paneId, cols, rows)",
      ) &&
      rpcSource.includes("await terminal.resize(cols, rows)") &&
      rendererTerminalRpcSource.includes("setExternalTerminalSize(paneId, cols, rows)") &&
      terminalSessionSource.includes(
        "term.resize(externalGrid.cols, externalGrid.rows)",
      ) &&
      ptyManagerSource.includes("if (!opts.preserveSizeOnAttach)"),
  );
  check(
    "remote files.list applies Studio's generated-directory filter",
    productionSource.includes("isStudioExplorerIgnoredDirectory(entry.name)"),
  );
  check(
    "remote file reads refuse a final-component symlink swap",
    productionSource.includes("fsConstants.O_NOFOLLOW"),
  );
  {
    const exitNotify = productionSource.indexOf("request.onExit();");
    const exitTabClose = productionSource.indexOf(
      'requestTerminalOp("destroy"',
      exitNotify,
    );
    check(
      "natural terminal exit notifies the phone before closing its desktop tab",
      exitNotify >= 0 && exitTabClose > exitNotify && exitTabClose - exitNotify < 500,
      { exitNotify, exitTabClose },
    );
  }
  check(
    "the phone can never name the files a session delete touches",
    // RemoteWorkerSessionInfo deliberately omits cwd and transcriptPath, so the
    // delete has to rebuild both from the computer's own workspace listing.
    !/export interface RemoteWorkerSessionInfo \{[^}]*(cwd|transcriptPath)/.test(rpcSource) &&
      productionSource.includes("const sessions = await listLocalWorkerSessions(input.runtime, root)") &&
      productionSource.includes("cwd: match.cwd") &&
      productionSource.includes("transcriptPath: match.transcriptPath"),
  );
  check(
    "a phone board write goes through the guarded user path at the revision it read",
    productionSource.includes("if (current.revision !== input.baseRevision)") &&
      productionSource.includes("baseRevision: current.revision") &&
      productionSource.includes("workspaceCwd: root"),
  );
  check(
    "queueing is refused on an automation's chat, where the nudge never runs",
    // board-nudge drops any run carrying an automationId, so the queue lane
    // there would be a promise nothing keeps. The phone hides the action; the
    // server must not accept it either.
    productionSource.includes("if (run.automationId) {") &&
      productionSource.includes("cannot be queued from the phone") &&
      // and the phone is told which runs those are
      productionSource.includes("...(run.automationId ? { automated: true } : {})"),
  );
  check(
    "concurrent session deletes serialize per runtime, not per session",
    // Two deletes of different sessions still rewrite the same provider
    // history file, so a per-session key would let one clobber the other.
    productionSource.includes(
      'JSON.stringify(["workerSession.delete", input.workspaceId, input.runtime])',
    ),
  );
  check(
    "remote run detail reports plan progress over the WHOLE plan, not the capped list",
    productionSource.includes("stepsTotal: plan.total") &&
      productionSource.includes("stepsFinished: plan.finished") &&
      productionSource.includes("MAX_CORA_RUN_STEPS"),
  );
  check(
    "production serializes and persistently looks up Cora retry keys",
    productionSource.includes("coraMessageMutations.run") &&
      productionSource.includes("findRemoteCoraRetry(await listRuns(workspace.id)"),
  );
  check(
    "production listener uses identity-derived candidates unless an exact test port is present",
    remoteIndexSource.includes(
      "this.deps.port !== undefined",
    ) &&
      remoteIndexSource.includes(
        "portCandidates: stableRemoteAccessPortCandidates(this.identity.publicKey)",
      ),
  );
  check(
    "the listener advances candidates only for an occupied bind",
    remoteIndexSource.includes("portCandidates:") &&
      fs
        .readFileSync(path.join(ROOT, "src", "main", "remote-access", "listener.ts"), "utf8")
        .includes('code !== "EADDRINUSE"'),
  );
  check(
    "an explicit test port of zero is not mistaken for an absent override",
    remoteIndexSource.includes(
      "this.deps.port !== undefined",
    ),
  );
  {
    const keys = [
      Buffer.alloc(32, 0),
      Buffer.alloc(32, 7),
      Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
      Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)),
    ];
    check(
      "identity-derived listener candidates are bounded, complete, and distinct",
      keys.every((key) => {
        const ports = stablePort.stableRemoteAccessPortCandidates(key);
        return ports.length === stablePort.REMOTE_ACCESS_PORT_CANDIDATE_COUNT &&
          new Set(ports).size === ports.length &&
          ports.every(
            (port) =>
              port >= stablePort.REMOTE_ACCESS_PORT_MIN &&
              port < stablePort.REMOTE_ACCESS_PORT_MIN + stablePort.REMOTE_ACCESS_PORT_SPAN,
          );
      }),
      keys.map((key) => stablePort.stableRemoteAccessPortCandidates(key)),
    );
    if (fs.existsSync(MOBILE_STABLE_PORT)) {
      delete require.cache[MOBILE_STABLE_PORT];
      const mobileStablePort = require(MOBILE_STABLE_PORT);
      check(
        "desktop and phone derive the same ordered restart candidates from every pinned key",
        keys.every(
          (key) =>
            JSON.stringify(stablePort.stableRemoteAccessPortCandidates(key)) ===
            JSON.stringify(
              mobileStablePort.stableRemoteAccessPortCandidates(key.toString("base64")),
            ),
        ),
      );
    } else {
      console.log("SKIP mobile restart-port parity (codara-mobile checkout not found)");
    }
  }
  {
    // The real service lifecycle (with relay disabled and loopback-only) must
    // release and rebind the same derived port. This is the exact sequence a
    // stopped/restarted `npm run dev` process performs.
    const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-restart-"));
    const restartDeps = {
      remoteDir: restartDir,
      deviceName: "Restart Test Studio",
      appVersion: "test",
      host: "127.0.0.1",
      relayUrl: false,
      listWorkspaces: async () => [],
      createTerminal: async () => {
        throw new Error("not used");
      },
      log: () => {},
    };
    const service = new remoteAccess.RemoteAccessService(restartDeps);
    let restartedService = null;
    try {
      await service.setEnabled(true);
      const firstPort = service.getStatus().port;
      const key = identity.loadOrCreateIdentity(restartDir).publicKey;
      const candidates = stablePort.stableRemoteAccessPortCandidates(key);
      await service.setEnabled(false);
      // A fresh service instance reloads the key from disk like a new Electron
      // process; this is stronger than toggling one in-memory singleton.
      restartedService = new remoteAccess.RemoteAccessService(restartDeps);
      await restartedService.setEnabled(true);
      const secondPort = restartedService.getStatus().port;
      check(
        "a fresh desktop process rebinds the paired phone's exact stable candidate",
        firstPort === candidates[0] &&
          secondPort === firstPort &&
          restartedService.getStatus().state === "reachable",
        { firstPort, secondPort, state: restartedService.getStatus().state },
      );
    } finally {
      await service.setEnabled(false);
      if (restartedService) await restartedService.setEnabled(false);
      fs.rmSync(restartDir, { recursive: true, force: true });
    }
  }
  {
    // Occupy candidate zero like an unrelated dev server or an ephemeral
    // socket could. A production service must remain reachable on the next
    // deterministic candidate; the phone derives the same ordered set.
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-fallback-"));
    const key = identity.loadOrCreateIdentity(fallbackDir).publicKey;
    const candidates = stablePort.stableRemoteAccessPortCandidates(key);
    const blocker = net.createServer();
    const logs = [];
    let fallbackService = null;
    try {
      await new Promise((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(candidates[0], "127.0.0.1", resolve);
      });
      fallbackService = new remoteAccess.RemoteAccessService({
        remoteDir: fallbackDir,
        deviceName: "Fallback Test Studio",
        appVersion: "test",
        host: "127.0.0.1",
        relayUrl: false,
        listWorkspaces: async () => [],
        createTerminal: async () => {
          throw new Error("not used");
        },
        log: (line) => logs.push(line),
      });
      await fallbackService.setEnabled(true);
      const actual = fallbackService.getStatus().port;
      check(
        "an occupied first stable candidate advances the production service",
        fallbackService.getStatus().state === "reachable" &&
          actual !== candidates[0] &&
          candidates.slice(1).includes(actual),
        { actual, candidates, state: fallbackService.getStatus().state },
      );
      check(
        "the occupied-candidate fallback is visible in local diagnostics",
        logs.some((line) => line.includes("trying the next stable candidate")),
        logs,
      );
    } finally {
      if (fallbackService) await fallbackService.setEnabled(false);
      await new Promise((resolve) => blocker.close(resolve));
      fs.rmSync(fallbackDir, { recursive: true, force: true });
    }
  }
  {
    const zeroDir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-zero-port-"));
    const zeroService = new remoteAccess.RemoteAccessService({
      remoteDir: zeroDir,
      deviceName: "Zero Port Test Studio",
      appVersion: "test",
      host: "127.0.0.1",
      port: 0,
      relayUrl: false,
      listWorkspaces: async () => [],
      createTerminal: async () => {
        throw new Error("not used");
      },
      log: () => {},
    });
    try {
      await zeroService.setEnabled(true);
      check(
        "an explicit zero test port still asks the OS for an available port",
        zeroService.getStatus().state === "reachable" &&
          typeof zeroService.getStatus().port === "number" &&
          zeroService.getStatus().port > 0,
        zeroService.getStatus(),
      );
    } finally {
      await zeroService.setEnabled(false);
      fs.rmSync(zeroDir, { recursive: true, force: true });
    }
  }
  if (fs.existsSync(MOBILE_RPC_TYPES)) {
    const mobileTypesSource = fs.readFileSync(MOBILE_RPC_TYPES, "utf8");
    const interfaceKeys = (source, name) => {
      const body = source.match(
        new RegExp(`export interface ${name} \\{([\\s\\S]*?)^\\}`, "m"),
      )?.[1] ?? "";
      return [...body.matchAll(/^\s*(?:'([^']+)'|([A-Za-z][A-Za-z0-9]*))\s*:/gm)]
        .map((match) => match[1] || match[2])
        .sort();
    };
    const mobileMethods = interfaceKeys(mobileTypesSource, "RpcMethods");
    const desktopMethods = [...rpcSource.matchAll(/^\s*case "([^"]+)":/gm)]
      .map((match) => match[1])
      .sort();
    const mobileEvents = interfaceKeys(mobileTypesSource, "RpcEvents");
    check(
      "desktop dispatch implements every live mobile RPC method and no extras",
      mobileMethods.length > 0 &&
        JSON.stringify(desktopMethods) === JSON.stringify(mobileMethods),
      { desktopMethods, mobileMethods },
    );
    check(
      "desktop emits every live mobile RPC event",
      mobileEvents.length > 0 &&
        mobileEvents.every((event) => rpcSource.includes(`pushEvent("${event}"`)),
      mobileEvents,
    );
    check(
      "desktop and mobile negotiate the same RPC protocol version",
      rpc.RPC_PROTOCOL_VERSION ===
        Number(mobileTypesSource.match(/RPC_PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1]),
    );
  } else {
    console.log("SKIP mobile RPC contract parity (codara-mobile checkout not found)");
  }

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

  /* ---- pairing address classification (item 8a) ------------------------- */

  // Pairing accepts a peer only from a local address; lanAddresses only
  // advertises the same, so the "same network" property is enforced, not
  // just claimed.
  check("loopback is local", pairing.isPrivateOrLocalAddress("127.0.0.1") === true);
  check("10/8 is local", pairing.isPrivateOrLocalAddress("10.4.5.6") === true);
  check("172.16/12 is local", pairing.isPrivateOrLocalAddress("172.20.1.1") === true);
  check("172.32 is NOT local", pairing.isPrivateOrLocalAddress("172.32.0.1") === false);
  check("192.168/16 is local", pairing.isPrivateOrLocalAddress("192.168.1.24") === true);
  check("169.254/16 link-local is local", pairing.isPrivateOrLocalAddress("169.254.10.10") === true);
  check("a public IPv4 is NOT local", pairing.isPrivateOrLocalAddress("8.8.8.8") === false);
  check("a routable IPv4 is NOT local", pairing.isPrivateOrLocalAddress("203.0.113.7") === false);
  check("IPv4-mapped loopback is local", pairing.isPrivateOrLocalAddress("::ffff:127.0.0.1") === true);
  check("IPv4-mapped public is NOT local", pairing.isPrivateOrLocalAddress("::ffff:8.8.8.8") === false);
  check("IPv6 loopback is local", pairing.isPrivateOrLocalAddress("::1") === true);
  check("IPv6 link-local is local", pairing.isPrivateOrLocalAddress("fe80::1%en0") === true);
  check("IPv6 unique-local is local", pairing.isPrivateOrLocalAddress("fd00::1234") === true);
  check("public IPv6 is NOT local", pairing.isPrivateOrLocalAddress("2606:4700:4700::1111") === false);
  check("empty/undefined address is NOT local", pairing.isPrivateOrLocalAddress(undefined) === false);
  check(
    "lanAddresses advertises only local addresses",
    pairing.lanAddresses().every((addr) => pairing.isPrivateOrLocalAddress(addr)),
    pairing.lanAddresses(),
  );

  // The key fingerprint the desktop shows matches the phone's short form
  // (leading eight bytes, uppercase hex, groups of four).
  {
    const key = Buffer.alloc(32);
    key.set([0x7f, 0x3a, 0x91, 0xc2, 0x5e, 0x08, 0x4b, 0x6d]);
    check(
      "key fingerprint matches the phone confirm-screen format",
      identity.keyFingerprint(key.toString("base64")) === "7F3A 91C2 5E08 4B6D",
      identity.keyFingerprint(key.toString("base64")),
    );
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

  /* ---- local filesystem policy ----------------------------------------- */

  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-outside-"));
    try {
      fs.mkdirSync(path.join(root, "project", "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "project", "src", "index.ts"), "export {};\n");
      const nested = await localPolicy.resolveExistingInside(root, "project/src", {
        directory: true,
        rejectSymlinks: true,
      });
      check(
        "filesystem policy resolves an ordinary directory inside its root",
        nested.path === fs.realpathSync(path.join(root, "project", "src")),
        nested,
      );
      check(
        "filesystem policy emits slash-separated workspace paths",
        localPolicy.toWireRelative(nested.root, nested.path) === "project/src",
      );
      check(
        "remote explorer hides the same generated trees as Studio",
        [
          ".git",
          "node_modules",
          "out",
          "dist",
          "build",
          ".next",
          ".turbo",
          "coverage",
        ].every(localPolicy.isStudioExplorerIgnoredDirectory) &&
          !localPolicy.isStudioExplorerIgnoredDirectory("src"),
      );

      let traversalError = null;
      try {
        await localPolicy.resolveExistingInside(root, "../", { directory: true });
      } catch (err) {
        traversalError = err;
      }
      check("filesystem policy rejects lexical parent traversal", Boolean(traversalError));

      let outsideError = null;
      try {
        await localPolicy.resolveExistingInside(root, outside, {
          allowAbsolute: true,
          directory: true,
        });
      } catch (err) {
        outsideError = err;
      }
      check("filesystem policy rejects an absolute path outside its root", Boolean(outsideError));

      if (process.platform !== "win32") {
        fs.symlinkSync(path.join(root, "project", "src"), path.join(root, "linked-src"));
        let symlinkError = null;
        try {
          await localPolicy.resolveExistingInside(root, "linked-src/index.ts", {
            rejectSymlinks: true,
          });
        } catch (err) {
          symlinkError = err;
        }
        check(
          "filesystem policy rejects symlinks even when they resolve back inside",
          /symbolic link/i.test(symlinkError?.message ?? ""),
          symlinkError?.message,
        );

        fs.symlinkSync(outside, path.join(root, "escape"));
        let symlinkEscapeError = null;
        try {
          await localPolicy.resolveExistingInside(root, "escape", { directory: true });
        } catch (err) {
          symlinkEscapeError = err;
        }
        check("filesystem policy rejects a symlink escape from the root", Boolean(symlinkEscapeError));
      }

      const glyphs = "🙂".repeat(100);
      const truncated = localPolicy.truncateUtf8(glyphs, 33);
      check(
        "UTF-8 truncation stays inside its byte budget without a broken glyph",
        Buffer.byteLength(truncated, "utf8") <= 33 && !truncated.includes("\ufffd"),
        { bytes: Buffer.byteLength(truncated, "utf8"), truncated },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }

  /* ---- workspace-bound file mutations --------------------------------- */

  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-mutate-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-mutate-outside-"));
    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.mkdirSync(path.join(root, "archive"));
      fs.mkdirSync(path.join(root, ".git"));
      fs.writeFileSync(path.join(root, "src", "existing.ts"), "keep");
      fs.writeFileSync(path.join(outside, "outside.txt"), "outside");

      const created = await fileMutations.createRemoteWorkspaceEntry(root, {
        parentPath: "src",
        name: "new.ts",
        kind: "file",
      });
      check(
        "remote Explorer creates an exclusive workspace-relative file",
        created.path === "src/new.ts" &&
          created.ext === "ts" &&
          fs.readFileSync(path.join(root, "src", "new.ts"), "utf8") === "",
        created,
      );

      const folder = await fileMutations.createRemoteWorkspaceEntry(root, {
        name: "notes",
        kind: "directory",
      });
      check(
        "remote Explorer creates a folder without recursive path injection",
        folder.path === "notes" && folder.isDir && fs.statSync(path.join(root, "notes")).isDirectory(),
        folder,
      );

      const renamed = await fileMutations.renameRemoteWorkspaceEntry(root, {
        path: "src/new.ts",
        name: "renamed.ts",
      });
      check(
        "remote Explorer renames without leaving the workspace",
        renamed.path === "src/renamed.ts" &&
          !fs.existsSync(path.join(root, "src", "new.ts")) &&
          fs.existsSync(path.join(root, "src", "renamed.ts")),
        renamed,
      );

      let collisionError = null;
      try {
        await fileMutations.renameRemoteWorkspaceEntry(root, {
          path: "src/renamed.ts",
          name: "existing.ts",
        });
      } catch (err) {
        collisionError = err;
      }
      check(
        "remote rename refuses to overwrite an existing entry",
        /already exists/i.test(collisionError?.message ?? "") &&
          fs.readFileSync(path.join(root, "src", "existing.ts"), "utf8") === "keep" &&
          fs.existsSync(path.join(root, "src", "renamed.ts")),
        collisionError?.message,
      );

      const moved = await fileMutations.moveRemoteWorkspaceEntry(root, {
        path: "src/renamed.ts",
        destinationPath: "archive",
      });
      check(
        "remote Explorer moves an entry into another workspace folder",
        moved.path === "archive/renamed.ts" &&
          !fs.existsSync(path.join(root, "src", "renamed.ts")) &&
          fs.existsSync(path.join(root, "archive", "renamed.ts")),
        moved,
      );

      let traversalError = null;
      try {
        await fileMutations.createRemoteWorkspaceEntry(root, {
          parentPath: "../",
          name: "escape.txt",
          kind: "file",
        });
      } catch (err) {
        traversalError = err;
      }
      check(
        "remote create cannot traverse outside its workspace",
        Boolean(traversalError) && !fs.existsSync(path.join(path.dirname(root), "escape.txt")),
        traversalError?.message,
      );

      let hiddenError = null;
      try {
        await fileMutations.createRemoteWorkspaceEntry(root, {
          parentPath: ".git",
          name: "phone-owned",
          kind: "file",
        });
      } catch (err) {
        hiddenError = err;
      }
      check(
        "remote mutations cannot enter Explorer-hidden metadata trees",
        /outside the phone Explorer/i.test(hiddenError?.message ?? "") &&
          !fs.existsSync(path.join(root, ".git", "phone-owned")),
        hiddenError?.message,
      );

      let reservedNameError = null;
      try {
        await fileMutations.createRemoteWorkspaceEntry(root, {
          name: "CON.txt",
          kind: "file",
        });
      } catch (err) {
        reservedNameError = err;
      }
      check(
        "remote entry names use a portable cross-platform policy",
        /reserved/i.test(reservedNameError?.message ?? ""),
        reservedNameError?.message,
      );

      fs.mkdirSync(path.join(root, "tree", "child"), { recursive: true });
      let recursiveMoveError = null;
      try {
        await fileMutations.moveRemoteWorkspaceEntry(root, {
          path: "tree",
          destinationPath: "tree/child",
        });
      } catch (err) {
        recursiveMoveError = err;
      }
      check(
        "remote move refuses to put a folder inside itself",
        /into itself/i.test(recursiveMoveError?.message ?? "") &&
          fs.existsSync(path.join(root, "tree", "child")),
        recursiveMoveError?.message,
      );

      if (process.platform !== "win32") {
        fs.symlinkSync(outside, path.join(root, "outside-link"));
        let symlinkMutationError = null;
        try {
          await fileMutations.deleteRemoteWorkspaceEntry(root, {
            path: "outside-link/outside.txt",
          });
        } catch (err) {
          symlinkMutationError = err;
        }
        check(
          "remote delete rejects a symlink escape and preserves the outside target",
          Boolean(symlinkMutationError) &&
            fs.readFileSync(path.join(outside, "outside.txt"), "utf8") === "outside",
          symlinkMutationError?.message,
        );
      }

      let rootDeleteError = null;
      try {
        await fileMutations.deleteRemoteWorkspaceEntry(root, { path: "" });
      } catch (err) {
        rootDeleteError = err;
      }
      check(
        "remote delete can never remove the workspace root",
        /workspace root/i.test(rootDeleteError?.message ?? "") && fs.existsSync(root),
        rootDeleteError?.message,
      );

      const deleted = await fileMutations.deleteRemoteWorkspaceEntry(root, {
        path: "archive/renamed.ts",
      });
      check(
        "remote delete reports its refresh parent and removes only the selected entry",
        deleted.deletedPath === "archive/renamed.ts" &&
          deleted.parentPath === "archive" &&
          !fs.existsSync(path.join(root, "archive", "renamed.ts")) &&
          fs.existsSync(path.join(root, "src", "existing.ts")),
        deleted,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }

  /* ---- Remote terminal image uploads ---------------------------------- */

  {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-image-test-"));
    const imageDirectory = path.join(directory, "image dir");
    try {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const upload = await imageUpload.createRemoteImageUpload(
        imageDirectory,
        {
          workspaceId: "ws1",
          name: "../Holiday Photo.heic",
          mimeType: "image/jpeg",
          size: jpeg.length,
        },
        "darwin",
      );
      await upload.write(jpeg.subarray(0, 3));
      await upload.write(jpeg.subarray(3));
      const attachment = await upload.finish();
      check(
        "remote image upload uses a private server-selected path and a safe terminal token",
        attachment.name === "Holiday Photo.jpg" &&
          attachment.path.startsWith(`${imageDirectory}${path.sep}`) &&
          attachment.inputToken.includes("\\ ") &&
          fs.readFileSync(attachment.path).equals(jpeg),
        attachment,
      );

      const partial = await imageUpload.createRemoteImageUpload(imageDirectory, {
        workspaceId: "ws1",
        name: "partial.jpg",
        mimeType: "image/jpeg",
        size: jpeg.length,
      });
      await partial.write(jpeg.subarray(0, 3));
      const beforeAbort = fs.readdirSync(imageDirectory).length;
      await partial.abort();
      check(
        "aborting an image upload removes its incomplete temp file",
        fs.readdirSync(imageDirectory).length === beforeAbort - 1,
      );

      const forged = await imageUpload.createRemoteImageUpload(imageDirectory, {
        workspaceId: "ws1",
        name: "forged.jpg",
        mimeType: "image/jpeg",
        size: 6,
      });
      await forged.write(Buffer.from("NOTJPG"));
      let forgedError = null;
      try {
        await forged.finish();
      } catch (err) {
        forgedError = err;
      }
      check(
        "remote image upload rejects bytes that do not match the declared image type",
        /valid supported image/i.test(forgedError?.message ?? "") &&
          fs.readdirSync(imageDirectory).length === 1,
        forgedError?.message,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  /* ---- Cora retry idempotency ------------------------------------------ */

  {
    const persistedRun = {
      id: "run-persisted",
      workspaceId: "ws1",
      humanMessages: [{
        id: "message-1",
        clientMessageId: "phone-retry-1",
        runId: "run-persisted",
        author: "user",
        kind: "note",
        message: "Build the feature",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    };
    const retry = coraPolicy.findRemoteCoraRetry([persistedRun], {
      workspaceId: "ws1",
      message: "Build the feature",
      clientMessageId: "phone-retry-1",
    });
    check(
      "a new-conversation retry finds its durable run without a run id",
      retry === persistedRun,
    );

    let collision = null;
    try {
      coraPolicy.findRemoteCoraRetry([persistedRun], {
        workspaceId: "ws1",
        message: "A different request",
        clientMessageId: "phone-retry-1",
      });
    } catch (err) {
      collision = err;
    }
    check(
      "a reused Cora retry key cannot silently replace different content",
      /already used/i.test(collision?.message ?? ""),
      collision?.message,
    );

    let wrongRun = null;
    try {
      coraPolicy.findRemoteCoraRetry([persistedRun], {
        workspaceId: "ws1",
        runId: "run-other",
        message: "Build the feature",
        clientMessageId: "phone-retry-1",
      });
    } catch (err) {
      wrongRun = err;
    }
    check(
      "an existing-run retry key cannot cross into another run",
      /another Cora run/i.test(wrongRun?.message ?? ""),
      wrongRun?.message,
    );

    const queue = new coraPolicy.KeyedSerialQueue();
    const order = [];
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run("ws1:phone-retry-2", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
      return "first";
    });
    const second = queue.run("ws1:phone-retry-2", async () => {
      order.push("second-start");
      return "second";
    });
    await Promise.resolve();
    await Promise.resolve();
    check(
      "same-key Cora deliveries do not start concurrently",
      order.join(",") === "first-start",
      order,
    );
    releaseFirst();
    check(
      "same-key Cora deliveries settle in order",
      JSON.stringify(await Promise.all([first, second])) ===
        JSON.stringify(["first", "second"]) &&
        order.join(",") === "first-start,first-end,second-start",
      order,
    );
    await Promise.resolve();
    check("settled Cora retry keys leave no queue entry", queue.size() === 0, queue.size());

    await queue.run("ws1:phone-retry-failed", async () => {
      throw new Error("simulated first delivery failure");
    }).catch(() => undefined);
    const recovered = await queue.run(
      "ws1:phone-retry-failed",
      async () => "retry-ran",
    );
    check(
      "a failed Cora delivery does not wedge its retry key",
      recovered === "retry-ran",
      recovered,
    );
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

  /* ---- frame-count cap and linear buffering (item 2) -------------------- */

  // A single chunk that carries more than MAX_FRAMES_PER_PUSH complete frames
  // is treated as fatal, so a ~16 MiB write of tiny frames cannot turn into
  // millions of synchronous JSON.parse calls. Pre-fix the decoder returned
  // every frame with no cap.
  {
    const tiny = rpc.encodeFrame(0);
    const flood = Buffer.concat(Array.from({ length: rpc.MAX_FRAMES_PER_PUSH + 5 }, () => tiny));
    let countErr = null;
    try {
      new rpc.FrameDecoder().push(flood);
    } catch (err) {
      countErr = err;
    }
    check("a chunk over the per-push frame cap throws FrameCountError", countErr?.name === "FrameCountError", countErr?.name);

    // Exactly at the cap is still accepted: the cap is a ceiling, not an
    // off-by-one.
    const atCap = Buffer.concat(Array.from({ length: rpc.MAX_FRAMES_PER_PUSH }, () => tiny));
    check("a chunk exactly at the per-push frame cap is accepted", new rpc.FrameDecoder().push(atCap).length === rpc.MAX_FRAMES_PER_PUSH);

    // The declared-length cap still rejects before the body is buffered, even
    // when the body bytes never arrive: only the 4-byte prefix is present.
    const headerOnly = Buffer.alloc(4);
    headerOnly.writeUInt32BE(rpc.MAX_FRAME_BYTES + 1, 0);
    let limitErr2 = null;
    try {
      new rpc.FrameDecoder().push(headerOnly);
    } catch (err) {
      limitErr2 = err;
    }
    check("oversize is rejected from the length prefix alone, no body", limitErr2?.name === "FrameLimitError");

    // Byte-at-a-time delivery of a large frame reassembles correctly and
    // stays linear (the chunk-list buffer never re-copies consumed bytes).
    const bigBody = { blob: "q".repeat(200_000) };
    const bigFrame = rpc.encodeFrame(bigBody);
    const dripDecoder = new rpc.FrameDecoder();
    let dripped = [];
    const started = Date.now();
    for (let i = 0; i < bigFrame.length; i += 1) {
      dripped = dripped.concat(dripDecoder.push(bigFrame.subarray(i, i + 1)));
    }
    check("byte-at-a-time delivery reassembles the frame", dripped.length === 1 && dripped[0].blob.length === 200_000);
    check("byte-at-a-time delivery stays fast (linear, not quadratic)", Date.now() - started < 4000, Date.now() - started);
  }

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
      ended: false,
      end() {
        this.ended = true;
        for (const h of handlers.close) h();
      },
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

  // Revocation is an authenticated terminal condition, unlike an ordinary
  // Studio shutdown. It removes session access synchronously but gracefully
  // flushes one control event so the phone suppresses its reconnect loop.
  {
    const revokedStream = makeFakeStream();
    const revokedSession = new rpc.RpcSession(revokedStream, services);
    revokedStream.inject(
      rpc.encodeFrame({
        id: 1,
        method: "hello",
        params: { protocol: 0, device: services.device },
      }),
    );
    await flush();
    const before = revokedStream.outbox.length;
    revokedSession.revoke();
    check(
      "revocation sends its authenticated terminal reason before closing",
      revokedStream.outbox[before]?.event === "session.revoked" &&
        revokedStream.ended === true,
      revokedStream.outbox.slice(before),
    );
    revokedStream.inject(rpc.encodeFrame({ id: 2, method: "ping", params: { nonce: "late" } }));
    await flush();
    check(
      "a revoked session cannot process another request while its notice flushes",
      revokedStream.outbox.length === before + 1,
      revokedStream.outbox.slice(before),
    );
  }

  // Oversized inbound frame drops the connection.
  const stream2 = makeFakeStream();
  void new rpc.RpcSession(stream2, services);
  const evil = Buffer.alloc(4);
  evil.writeUInt32BE(rpc.MAX_FRAME_BYTES + 1, 0);
  stream2.inject(evil);
  check("oversized inbound frame destroys the session", stream2.destroyed === true);
  check("no reply is sent for a framing violation", stream2.outbox.length === 0);

  // Individually valid async requests still need a concurrency ceiling. A
  // paired but compromised phone must not fan out unbounded filesystem/git/
  // Cora work while earlier calls are still pending.
  {
    const held = [];
    let started = 0;
    const limitedStream = makeFakeStream();
    const limitedSession = new rpc.RpcSession(limitedStream, {
      ...services,
      listWorkspaces: () => {
        started += 1;
        return new Promise((resolve) => held.push(resolve));
      },
    });
    const limitedRequest = (id, method, params) =>
      limitedStream.inject(rpc.encodeFrame({ id, method, params }));
    limitedRequest(1, "hello", {
      protocol: 0,
      device: { publicKey: "phone", name: "Phone", role: "phone", version: "1" },
    });
    await flush();
    for (let i = 0; i < rpc.MAX_IN_FLIGHT_REQUESTS + 1; i += 1) {
      limitedRequest(100 + i, "workspaces.list", {});
    }
    await flush();
    const overflowId = 100 + rpc.MAX_IN_FLIGHT_REQUESTS;
    check(
      "async RPC work is capped per connection",
      started === rpc.MAX_IN_FLIGHT_REQUESTS,
      started,
    );
    check(
      "a request beyond the async-work cap receives a bounded error",
      limitedStream.outbox.some(
        (frame) =>
          frame?.id === overflowId &&
          frame?.ok === false &&
          /already in progress/i.test(frame?.error?.message ?? ""),
      ),
      limitedStream.outbox.at(-1),
    );
    for (const release of held) release([]);
    await flush();
    limitedRequest(1000, "workspaces.list", {});
    await flush();
    check(
      "the async-work slot is released when a request settles",
      started === rpc.MAX_IN_FLIGHT_REQUESTS + 1,
      started,
    );
    held.at(-1)([]);
    await flush();
    limitedSession.destroy();
  }

  /* ---- fatal frame abandons the rest of its chunk (item 7) ------------- */

  // A malformed frame and a valid terminal.create delivered in ONE decrypted
  // chunk: the malformed frame destroys the session synchronously, and the
  // create that follows it in the same chunk must never reach the spawn path.
  {
    const stream3 = makeFakeStream();
    void new rpc.RpcSession(stream3, services);
    stream3.inject(rpc.encodeFrame({ id: 1, method: "hello", params: { protocol: 0, device: services.device } }));
    await flush();
    const before = madeTerminals.length;
    const malformed = rpc.encodeFrame(12345); // a bare number is not a request
    const create = rpc.encodeFrame({ id: 2, method: "terminal.create", params: { workspaceId: "ws1", cols: 80, rows: 24 } });
    stream3.inject(Buffer.concat([malformed, create]));
    await flush();
    check("a fatal frame destroys the session", stream3.destroyed === true);
    check(
      "a terminal.create after a fatal frame in the same chunk never spawns",
      madeTerminals.length === before,
      madeTerminals.length - before,
    );
  }

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

  /* ---- all writes gated, paused-birth terminals (item 6) --------------- */

  {
    const g = makeFakeStream();
    void new rpc.RpcSession(g, services);
    const greq = (id, method, params) => g.inject(rpc.encodeFrame({ id, method, params }));
    greq(1, "hello", { protocol: 0, device: services.device });
    await flush();
    // Back the peer up first, then create a terminal: it must be born paused
    // so its opening burst is held at the pty, not produced into a paused
    // session and dropped.
    g.writeAccepts = false;
    greq(2, "ping", { nonce: "x" }); // a reply that returns backpressure
    await flush();
    greq(3, "terminal.create", { workspaceId: "ws1", cols: 80, rows: 24 });
    await flush();
    const born = madeTerminals[madeTerminals.length - 1];
    check("a terminal created while backpressured is born paused", born.paused === true);

    // A peer that never drains but keeps forcing replies must not grow our
    // write queue without bound: past MAX_PENDING_WRITE_BYTES the session is
    // destroyed rather than buffered forever. Ordinary replies, not just
    // terminal events, are what this bounds.
    let guard = 0;
    while (!g.destroyed && guard < 5000) {
      greq(100 + guard, "ping", { nonce: "y".repeat(4000) });
      guard += 1;
      if (guard % 200 === 0) await flush();
    }
    await flush();
    check("a peer that will not drain replies has its session closed", g.destroyed === true, guard);
  }

  /* ---- additive desktop services + terminal event ordering ------------- */

  {
    const calls = [];
    let sharedTerminal = null;
    const uploadedImageChunks = [];
    let imageUploadAborts = 0;
    const extendedServices = {
      ...services,
      peerDevice: {
        publicKey: "trusted-phone-key",
        name: "Etienne's iPhone",
        role: "phone",
        version: "1",
      },
      listDirectories: async (requestedPath) => {
        calls.push(["directories.list", requestedPath]);
        return {
          path: "/Users/e/Projects",
          parentPath: "/Users/e",
          rootPath: "/Users/e",
          directories: [{ name: "Codara", path: "/Users/e/Projects/Codara" }],
        };
      },
      addWorkspace: async (input) => {
        calls.push(["workspaces.add", input]);
        return {
          id: "ws-added",
          name: input.name ?? "Added",
          path: input.path,
          color: "#2AA298",
          branch: "main",
        };
      },
      listWorkspaceOrganization: async () => ({
        groups: [{ id: "group-studio", name: "Studio", collapsed: false }],
        railOrder: ["group-studio"],
      }),
      createWorkspaceGroup: async (name) => {
        calls.push(["workspaces.group.create", name]);
        return { id: "group-new", name, collapsed: false };
      },
      updateWorkspaceGroup: async (input) => {
        calls.push(["workspaces.group.update", input]);
        return {
          id: input.groupId,
          name: input.name ?? "Studio",
          collapsed: input.collapsed ?? false,
        };
      },
      deleteWorkspaceGroup: async (groupId) => {
        calls.push(["workspaces.group.delete", groupId]);
      },
      moveWorkspace: async (input) => {
        calls.push(["workspaces.move", input]);
        return {
          id: input.workspaceId,
          name: "One",
          path: "/tmp/one",
          ...(input.groupId ? { groupId: input.groupId } : {}),
        };
      },
      reorderWorkspaceRail: async (input) => {
        calls.push(["workspaces.rail.move", input]);
      },
      listFiles: async (input) => {
        calls.push(["files.list", input]);
        return {
          path: input.path ?? "",
          parentPath: input.path ? "" : null,
          entries: [{ name: "src", path: "src", isDir: true }],
        };
      },
      readFile: async (input) => {
        calls.push(["files.read", input]);
        return {
          path: input.path,
          name: "index.ts",
          content: "export {};",
          size: 10,
          mtimeMs: 12,
        };
      },
      createFileEntry: async (input) => {
        calls.push(["files.create", input]);
        return {
          name: input.name,
          path: `${input.parentPath ? `${input.parentPath}/` : ""}${input.name}`,
          isDir: input.kind === "directory",
        };
      },
      renameFileEntry: async (input) => {
        calls.push(["files.rename", input]);
        const parent = input.path.includes("/")
          ? input.path.slice(0, input.path.lastIndexOf("/") + 1)
          : "";
        return { name: input.name, path: `${parent}${input.name}`, isDir: false };
      },
      moveFileEntry: async (input) => {
        calls.push(["files.move", input]);
        const name = input.path.split("/").at(-1);
        return {
          name,
          path: `${input.destinationPath ? `${input.destinationPath}/` : ""}${name}`,
          isDir: false,
        };
      },
      deleteFileEntry: async (input) => {
        calls.push(["files.delete", input]);
        return {
          deletedPath: input.path,
          parentPath: input.path.includes("/")
            ? input.path.slice(0, input.path.lastIndexOf("/"))
            : "",
        };
      },
      getGitStatus: async (workspaceId) => {
        calls.push(["git.status", workspaceId]);
        return {
          isRepo: true,
          branch: "main",
          detached: false,
          ahead: 1,
          behind: 0,
          staged: [],
          unstaged: [{ path: "src/index.ts", status: "modified" }],
          hasConflicts: false,
        };
      },
      getGitLog: async (input) => {
        calls.push(["git.log", input]);
        return {
          isRepo: true,
          commits: [{
            hash: "a".repeat(40),
            shortHash: "aaaaaaa",
            subject: "Remote history",
            author: "Codara",
            relativeDate: "now",
            parentHashes: [],
            refs: ["main"],
            isHead: true,
          }],
        };
      },
      getGitCommitDetail: async (input) => {
        calls.push(["git.commitDetail", input]);
        return {
          hash: input.hash,
          shortHash: input.hash.slice(0, 7),
          subject: "Remote history",
          body: "Commit body",
          author: "Codara",
          authorEmail: "codara@example.com",
          relativeDate: "now",
          isoDate: "2026-01-01T00:00:00.000Z",
          parentHashes: [],
          refs: ["main"],
          isHead: true,
          files: [{
            path: "src/index.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
          }],
        };
      },
      listCoraHistory: async (workspaceId) => {
        calls.push(["cora.history", workspaceId]);
        return [{
          id: "run-1",
          workspaceId,
          title: "Remote work",
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          messageCount: 1,
          lastMessage: "hello",
          activeWorkers: 1,
        }];
      },
      getCoraRun: async (input) => {
        calls.push(["cora.get", input]);
        return {
          id: input.runId,
          workspaceId: input.workspaceId,
          title: "Remote work",
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          messageCount: 1,
          activeWorkers: 1,
          messages: [{
            id: "message-1",
            author: "cora",
            kind: "note",
            message: "hello",
            createdAt: "2026-01-01T00:01:00.000Z",
          }],
        };
      },
      sendCoraMessage: async (input) => {
        calls.push(["cora.send", input]);
        return {
          id: input.runId ?? "run-new",
          workspaceId: input.workspaceId,
          title: "Remote work",
          status: "planning",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          messageCount: 1,
          activeWorkers: 0,
          messages: [{
            id: "message-user",
            author: "user",
            kind: "note",
            message: input.message,
            createdAt: "2026-01-01T00:01:00.000Z",
          }],
        };
      },
      listWorkerSessions: async (input) => {
        calls.push(["workerSessions.list", input]);
        return [{
          runtime: input.runtime,
          sessionId: "session-codex-1",
          title: "Continue the mobile terminal",
          updatedAt: "2026-07-28T20:00:00.000Z",
        }];
      },
      deleteWorkerSession: async (input) => {
        calls.push(["workerSessions.delete", input]);
        return {
          deleted: true,
          memoryDeleted: input.memoryScope !== "none",
          memoryScope: input.memoryScope,
          warnings: ["Codex's delete command failed"],
        };
      },
      getAutomation: async (input) => {
        calls.push(["automations.get", input]);
        return {
          id: input.automationId,
          name: "Nightly sweep",
          enabled: true,
          status: "idle",
          triggerKind: "cron",
          triggerSummary: "Every night at 02:00",
          iteration: 3,
          model: "claude-opus-5",
          effort: "high",
          prompt: "Review yesterday's diffs",
          history: [{
            iteration: 2,
            runId: "run-loom-2",
            startedAt: "2026-07-29T02:00:00.000Z",
            finishedAt: "2026-07-29T02:11:00.000Z",
            status: "complete",
            summary: "Nothing to fix",
            costUsd: 0.42,
            stopReason: "agent-done",
          }],
        };
      },
      getCoraWhiteboard: async (input) => {
        calls.push(["cora.whiteboard.get", input]);
        if (input.runId === "run-blank") return null;
        return {
          title: "How the phone reads a run",
          summary: "Flattened for the phone",
          nodes: [
            { id: "n1", kind: "topic", title: "Remote access" },
            { id: "n2", kind: "risk", title: "Frame budget", tone: "warning" },
          ],
          edges: [{ id: "e1", from: "n1", to: "n2", label: "bounded by" }],
          updatedAt: "2026-07-29T10:00:00.000Z",
        };
      },
      getCoraBoard: async (input) => {
        calls.push(["cora.board.get", input]);
        return {
          revision: 4,
          cards: [{
            id: "card-1",
            title: "Ship the phone board",
            status: "idea",
            order: 1,
            updatedAt: "2026-07-29T09:00:00.000Z",
          }],
        };
      },
      updateCoraBoard: async (input) => {
        calls.push(["cora.board.update", input]);
        // Stand in for the real revision guard: a write composed against an
        // older revision is reported back, not applied.
        const applied = input.baseRevision === 4;
        return {
          applied,
          board: {
            revision: applied ? 5 : 4,
            cards: [{
              id: "card-1",
              title: "Ship the phone board",
              status: applied && input.action === "queue" ? "queued" : "idea",
              order: 1,
              updatedAt: "2026-07-29T09:05:00.000Z",
            }],
          },
        };
      },
      beginImageUpload: async (input) => {
        calls.push(["files.imageUpload.begin", input]);
        return {
          async write(data) {
            uploadedImageChunks.push(Buffer.from(data));
          },
          async finish() {
            return {
              name: input.name,
              mimeType: input.mimeType,
              size: input.size,
              path: "/tmp/phone-image.jpg",
              inputToken: "/tmp/phone-image.jpg",
            };
          },
          async abort() {
            imageUploadAborts += 1;
          },
        };
      },
      createTerminal: async (request) => {
        calls.push(["terminal.create", request]);
        // A renderer-backed shell can print its prompt before the awaited
        // create service returns. RPC must hold this until the response tells
        // the phone which terminalId owns it.
        request.onData("opening prompt");
        sharedTerminal = {
          request,
          closed: false,
          detached: false,
          write() {},
          resize() {},
          close() {
            this.closed = true;
          },
          detach() {
            this.detached = true;
          },
          desktopTabId: "term-desktop",
          title: "Etienne's iPhone · Codex",
        };
        return sharedTerminal;
      },
    };
    const ex = makeFakeStream();
    const exSession = new rpc.RpcSession(ex, extendedServices);
    const exReq = (id, method, params) => ex.inject(rpc.encodeFrame({ id, method, params }));
    exReq(1, "hello", {
      protocol: 0,
      device: { publicKey: "forged", name: "Forged name", role: "phone", version: "1" },
    });
    await flush();

    exReq(11, "workspaces.list", {});
    await flush();
    check(
      "workspaces.list returns Studio workspace folders and top-level order",
      ex.outbox.at(-1)?.result?.groups?.[0]?.name === "Studio" &&
        ex.outbox.at(-1)?.result?.railOrder?.[0] === "group-studio",
      ex.outbox.at(-1),
    );
    exReq(2, "directories.list", { path: "/Users/e/Projects" });
    await flush();
    check(
      "directories.list delegates and returns the bounded listing shape",
      ex.outbox.at(-1)?.result?.directories?.[0]?.name === "Codara",
      ex.outbox.at(-1),
    );
    exReq(3, "workspaces.add", { path: "/Users/e/Projects/Codara", name: "  Mobile  " });
    await flush();
    check(
      "workspaces.add trims its display name and returns appearance metadata",
      calls.at(-1)?.[1]?.name === "Mobile" &&
        ex.outbox.at(-1)?.result?.workspace?.color === "#2AA298",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(31, "workspaces.group.create", { name: "  Mobile folder  " });
    await flush();
    check(
      "workspaces.group.create trims and delegates its bounded name",
      calls.at(-1)?.[0] === "workspaces.group.create" &&
        calls.at(-1)?.[1] === "Mobile folder" &&
        ex.outbox.at(-1)?.result?.group?.id === "group-new",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(32, "workspaces.group.update", {
      groupId: "group-studio",
      name: "  Products  ",
      collapsed: true,
    });
    await flush();
    check(
      "workspaces.group.update delegates name and collapsed state",
      calls.at(-1)?.[0] === "workspaces.group.update" &&
        calls.at(-1)?.[1]?.name === "Products" &&
        calls.at(-1)?.[1]?.collapsed === true,
      calls.at(-1),
    );
    exReq(33, "workspaces.move", {
      workspaceId: "ws1",
      groupId: "group-studio",
      beforeWorkspaceId: null,
    });
    await flush();
    check(
      "workspaces.move delegates an explicit group destination",
      calls.at(-1)?.[0] === "workspaces.move" &&
        calls.at(-1)?.[1]?.groupId === "group-studio" &&
        ex.outbox.at(-1)?.result?.workspace?.groupId === "group-studio",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(331, "workspaces.move", {
      workspaceId: "ws1",
      groupId: null,
      beforeRailItemId: "group-studio",
    });
    await flush();
    check(
      "workspaces.move delegates an atomic top-level drop position",
      calls.at(-1)?.[0] === "workspaces.move" &&
        calls.at(-1)?.[1]?.groupId === null &&
        calls.at(-1)?.[1]?.beforeRailItemId === "group-studio",
      calls.at(-1),
    );
    exReq(34, "workspaces.rail.move", {
      itemId: "group-studio",
      beforeItemId: null,
    });
    await flush();
    check(
      "workspaces.rail.move delegates top-level ordering",
      calls.at(-1)?.[0] === "workspaces.rail.move" &&
        calls.at(-1)?.[1]?.beforeItemId === null,
      calls.at(-1),
    );
    exReq(35, "workspaces.group.delete", { groupId: "group-studio" });
    await flush();
    check(
      "workspaces.group.delete delegates without deleting workspaces",
      calls.at(-1)?.[0] === "workspaces.group.delete" &&
        calls.at(-1)?.[1] === "group-studio" &&
        ex.outbox.at(-1)?.ok === true,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(4, "files.list", { workspaceId: "ws1", path: "" });
    await flush();
    check("files.list returns workspace-relative entries", ex.outbox.at(-1)?.result?.entries?.[0]?.path === "src");
    exReq(5, "files.read", { workspaceId: "ws1", path: "src/index.ts" });
    await flush();
    check("files.read wraps its file DTO", ex.outbox.at(-1)?.result?.file?.content === "export {};");
    exReq(51, "files.create", {
      workspaceId: "ws1",
      parentPath: "src",
      name: "mobile.ts",
      kind: "file",
    });
    await flush();
    check(
      "files.create delegates a bounded leaf mutation and returns its entry",
      calls.at(-1)?.[0] === "files.create" &&
        ex.outbox.at(-1)?.result?.entry?.path === "src/mobile.ts",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(52, "files.rename", {
      workspaceId: "ws1",
      path: "src/mobile.ts",
      name: "phone.ts",
    });
    await flush();
    check(
      "files.rename delegates one workspace-relative entry",
      calls.at(-1)?.[0] === "files.rename" &&
        ex.outbox.at(-1)?.result?.entry?.path === "src/phone.ts",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(53, "files.move", {
      workspaceId: "ws1",
      path: "src/phone.ts",
      destinationPath: "archive",
    });
    await flush();
    check(
      "files.move delegates a destination folder instead of an arbitrary target path",
      calls.at(-1)?.[1]?.destinationPath === "archive" &&
        ex.outbox.at(-1)?.result?.entry?.path === "archive/phone.ts",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(54, "files.delete", { workspaceId: "ws1", path: "archive/phone.ts" });
    await flush();
    check(
      "files.delete returns the parent that the phone should refresh",
      ex.outbox.at(-1)?.result?.deleted?.parentPath === "archive",
      ex.outbox.at(-1),
    );
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    exReq(55, "files.imageUpload.begin", {
      workspaceId: "ws1",
      name: "phone.jpg",
      mimeType: "image/jpeg",
      size: imageBytes.length,
    });
    await flush();
    const imageUploadId = ex.outbox.at(-1)?.result?.uploadId;
    check(
      "files.imageUpload.begin returns a session-owned bounded chunk size",
      typeof imageUploadId === "string" &&
        ex.outbox.at(-1)?.result?.chunkBytes === imageUpload.REMOTE_IMAGE_CHUNK_BYTES,
      ex.outbox.at(-1),
    );
    exReq(56, "files.imageUpload.chunk", {
      uploadId: imageUploadId,
      offset: 1,
      data: imageBytes.toString("base64"),
    });
    await flush();
    check(
      "files.imageUpload.chunk rejects out-of-order offsets before writing",
      ex.outbox.at(-1)?.error?.code === "invalid-params" && uploadedImageChunks.length === 0,
      ex.outbox.at(-1),
    );
    exReq(57, "files.imageUpload.chunk", {
      uploadId: imageUploadId,
      offset: 0,
      data: imageBytes.toString("base64"),
    });
    await flush();
    check(
      "files.imageUpload.chunk acknowledges decoded bytes",
      ex.outbox.at(-1)?.result?.received === imageBytes.length &&
        Buffer.concat(uploadedImageChunks).equals(imageBytes),
      ex.outbox.at(-1),
    );
    exReq(58, "files.imageUpload.finish", { uploadId: imageUploadId });
    await flush();
    check(
      "files.imageUpload.finish exposes only the server-created attachment",
      ex.outbox.at(-1)?.result?.attachment?.inputToken === "/tmp/phone-image.jpg" &&
        imageUploadAborts === 0,
      ex.outbox.at(-1),
    );
    exReq(6, "git.status", { workspaceId: "ws1" });
    await flush();
    check("git.status returns source-control changes", ex.outbox.at(-1)?.result?.status?.unstaged?.length === 1);
    exReq(61, "git.log", { workspaceId: "ws1", limit: 25 });
    await flush();
    check(
      "git.log delegates a bounded history depth",
      calls.at(-1)?.[1]?.limit === 25 &&
        ex.outbox.at(-1)?.result?.log?.commits?.[0]?.isHead === true,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforeOversizedLog = calls.length;
    exReq(64, "git.log", { workspaceId: "ws1", limit: 1000 });
    await flush();
    check(
      "git.log rejects an unbounded history request before spawning git",
      ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeOversizedLog,
      {
        callsBeforeOversizedLog,
        callsAfter: calls.length,
        response: ex.outbox.at(-1),
      },
    );
    exReq(62, "git.commitDetail", { workspaceId: "ws1", hash: "a".repeat(40) });
    await flush();
    check(
      "git.commitDetail returns metadata and changed files",
      ex.outbox.at(-1)?.result?.commit?.files?.[0]?.additions === 2,
      ex.outbox.at(-1),
    );
    const callsBeforeBadHash = calls.length;
    exReq(63, "git.commitDetail", { workspaceId: "ws1", hash: "--help" });
    await flush();
    check(
      "git.commitDetail rejects option-shaped hashes before spawning git",
      ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeBadHash,
      { callsBeforeBadHash, callsAfter: calls.length, response: ex.outbox.at(-1) },
    );
    exReq(7, "cora.history", { workspaceId: "ws1" });
    await flush();
    check("cora.history returns workspace runs", ex.outbox.at(-1)?.result?.runs?.[0]?.id === "run-1");
    exReq(8, "cora.get", { workspaceId: "ws1", runId: "run-1" });
    await flush();
    check("cora.get returns bounded messages", ex.outbox.at(-1)?.result?.run?.messages?.[0]?.author === "cora");
    exReq(9, "cora.send", {
      workspaceId: "ws1",
      runId: "run-1",
      message: "  keep going  ",
      clientMessageId: "phone-message-1",
    });
    await flush();
    check(
      "cora.send trims and delegates a stable client message id",
      calls.at(-1)?.[1]?.message === "keep going" &&
        calls.at(-1)?.[1]?.clientMessageId === "phone-message-1",
      calls.at(-1),
    );

    exReq(95, "workerSessions.list", {
      workspaceId: "ws1",
      runtime: "codex",
    });
    await flush();
    check(
      "workerSessions.list returns workspace-scoped resumable workers",
      calls.at(-1)?.[0] === "workerSessions.list" &&
        calls.at(-1)?.[1]?.workspaceId === "ws1" &&
        ex.outbox.at(-1)?.result?.sessions?.[0]?.sessionId === "session-codex-1",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );

    /* ---- worker session delete ---------------------------------------- */

    exReq(96, "workerSessions.delete", {
      workspaceId: "ws1",
      runtime: "codex",
      sessionId: "session-codex-1",
    });
    await flush();
    check(
      "workerSessions.delete delegates only a workspace, runtime, session id and scope",
      calls.at(-1)?.[0] === "workerSessions.delete" &&
        JSON.stringify(Object.keys(calls.at(-1)?.[1] ?? {}).sort()) ===
          JSON.stringify(["memoryScope", "runtime", "sessionId", "workspaceId"]) &&
        // An omitted scope is the narrow one, never a wider delete.
        calls.at(-1)?.[1]?.memoryScope === "none" &&
        ex.outbox.at(-1)?.result?.deleted === true &&
        ex.outbox.at(-1)?.result?.memoryDeleted === false &&
        ex.outbox.at(-1)?.result?.warnings?.length === 1,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(961, "workerSessions.delete", {
      workspaceId: "ws1",
      runtime: "codex",
      sessionId: "session-codex-1",
      memoryScope: "codex-all",
    });
    await flush();
    check(
      "workerSessions.delete carries an explicit memory scope and reports what it removed",
      calls.at(-1)?.[1]?.memoryScope === "codex-all" &&
        ex.outbox.at(-1)?.result?.memoryDeleted === true &&
        ex.outbox.at(-1)?.result?.memoryScope === "codex-all",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    {
      // A memory scope belongs to exactly one runtime. Codex's scope wipes
      // every local Codex memory on the machine, so it must never be reachable
      // through a Claude delete, and vice versa.
      const callsBefore = calls.length;
      const mismatched = [
        { runtime: "claude", memoryScope: "codex-all" },
        { runtime: "codex", memoryScope: "claude-project" },
        { runtime: "claude", memoryScope: "everything" },
        { runtime: "codex", memoryScope: 1 },
      ];
      for (const params of mismatched) {
        exReq(962, "workerSessions.delete", {
          workspaceId: "ws1",
          sessionId: "session-codex-1",
          ...params,
        });
      }
      await flush();
      const refusals = ex.outbox
        .slice(-mismatched.length)
        .filter((frame) => frame?.ok === false && frame?.error?.code === "invalid-params");
      check(
        "a memory scope from the other runtime is refused, never widened",
        refusals.length === mismatched.length && calls.length === callsBefore,
        { refusals: refusals.length, newCalls: calls.length - callsBefore },
      );
    }
    {
      // A phone cannot name a path here, so the only injection surface left is
      // the session id itself; it must be refused before any service runs.
      const callsBefore = calls.length;
      for (const sessionId of ["../../etc/passwd", "", "-leading-dash", "a".repeat(200)]) {
        exReq(97, "workerSessions.delete", {
          workspaceId: "ws1",
          runtime: "codex",
          sessionId,
        });
      }
      exReq(98, "workerSessions.delete", {
        workspaceId: "ws1",
        runtime: "shell",
        sessionId: "session-codex-1",
      });
      await flush();
      const refusals = ex.outbox
        .slice(-5)
        .filter((frame) => frame?.ok === false && frame?.error?.code === "invalid-params");
      check(
        "workerSessions.delete refuses a malformed session id or runtime without calling the service",
        refusals.length === 5 && calls.length === callsBefore,
        { refusals: refusals.length, newCalls: calls.length - callsBefore },
      );
    }

    /* ---- automation detail --------------------------------------------- */

    exReq(97, "automations.get", { workspaceId: "ws1", automationId: "loom-1" });
    await flush();
    check(
      "automations.get returns the loom's worker, prompt and pass history",
      calls.at(-1)?.[0] === "automations.get" &&
        calls.at(-1)?.[1]?.workspaceId === "ws1" &&
        ex.outbox.at(-1)?.result?.automation?.model === "claude-opus-5" &&
        ex.outbox.at(-1)?.result?.automation?.history?.[0]?.stopReason === "agent-done" &&
        ex.outbox.at(-1)?.result?.automation?.history?.[0]?.costUsd === 0.42,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    {
      const callsBefore = calls.length;
      for (const params of [null, { workspaceId: "ws1" }, { automationId: "loom-1" }]) {
        exReq(971, "automations.get", params);
      }
      await flush();
      const refusals = ex.outbox
        .slice(-3)
        .filter((frame) => frame?.ok === false && frame?.error?.code === "invalid-params");
      check(
        "automations.get refuses a request that does not name both the workspace and the loom",
        refusals.length === 3 && calls.length === callsBefore,
        { refusals: refusals.length, newCalls: calls.length - callsBefore },
      );
    }

    /* ---- Cora whiteboard ------------------------------------------------ */

    exReq(99, "cora.whiteboard.get", { workspaceId: "ws1", runId: "run-1" });
    await flush();
    check(
      "cora.whiteboard.get returns nodes and edges without canvas geometry",
      calls.at(-1)?.[0] === "cora.whiteboard.get" &&
        ex.outbox.at(-1)?.result?.whiteboard?.nodes?.length === 2 &&
        ex.outbox.at(-1)?.result?.whiteboard?.edges?.[0]?.label === "bounded by" &&
        !("x" in (ex.outbox.at(-1)?.result?.whiteboard?.nodes?.[0] ?? {})),
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(991, "cora.whiteboard.get", { workspaceId: "ws1", runId: "run-blank" });
    await flush();
    check(
      "a chat with no whiteboard answers null rather than an error",
      ex.outbox.at(-1)?.ok === true && ex.outbox.at(-1)?.result?.whiteboard === null,
      ex.outbox.at(-1),
    );

    /* ---- Cora Board ---------------------------------------------------- */

    exReq(100, "cora.board.get", { workspaceId: "ws1", runId: "run-1" });
    await flush();
    check(
      "cora.board.get returns the chat's revisioned card list",
      calls.at(-1)?.[0] === "cora.board.get" &&
        ex.outbox.at(-1)?.result?.board?.revision === 4 &&
        ex.outbox.at(-1)?.result?.board?.cards?.[0]?.id === "card-1",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(101, "cora.board.update", {
      workspaceId: "ws1",
      runId: "run-1",
      baseRevision: 4,
      action: "add-idea",
      title: "  Try the board on the phone  ",
      description: "  with a body  ",
    });
    await flush();
    check(
      "cora.board.update add-idea trims its card text and carries the read revision",
      calls.at(-1)?.[1]?.title === "Try the board on the phone" &&
        calls.at(-1)?.[1]?.description === "with a body" &&
        calls.at(-1)?.[1]?.baseRevision === 4 &&
        ex.outbox.at(-1)?.result?.applied === true,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(102, "cora.board.update", {
      workspaceId: "ws1",
      runId: "run-1",
      baseRevision: 4,
      action: "queue",
      cardId: "card-1",
    });
    await flush();
    check(
      "cora.board.update queue names one card and returns the advanced board",
      calls.at(-1)?.[1]?.action === "queue" &&
        calls.at(-1)?.[1]?.cardId === "card-1" &&
        ex.outbox.at(-1)?.result?.board?.revision === 5 &&
        ex.outbox.at(-1)?.result?.board?.cards?.[0]?.status === "queued",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(103, "cora.board.update", {
      workspaceId: "ws1",
      runId: "run-1",
      baseRevision: 2,
      action: "delete",
      cardId: "card-1",
    });
    await flush();
    check(
      "a stale board write is reported unapplied with the current board, not an error",
      ex.outbox.at(-1)?.ok === true &&
        ex.outbox.at(-1)?.result?.applied === false &&
        ex.outbox.at(-1)?.result?.board?.revision === 4,
      ex.outbox.at(-1),
    );
    {
      const callsBefore = calls.length;
      const badWrites = [
        // add-idea without a usable title
        { workspaceId: "ws1", runId: "run-1", baseRevision: 4, action: "add-idea" },
        { workspaceId: "ws1", runId: "run-1", baseRevision: 4, action: "add-idea", title: "   " },
        {
          workspaceId: "ws1",
          runId: "run-1",
          baseRevision: 4,
          action: "add-idea",
          title: "x".repeat(rpc.MAX_BOARD_CARD_TITLE_LENGTH + 1),
        },
        // card actions without a card
        { workspaceId: "ws1", runId: "run-1", baseRevision: 4, action: "queue" },
        { workspaceId: "ws1", runId: "run-1", baseRevision: 4, action: "delete", cardId: "" },
        // lanes the phone may not assign, and revisions that are not one
        { workspaceId: "ws1", runId: "run-1", baseRevision: 4, action: "done", cardId: "card-1" },
        { workspaceId: "ws1", runId: "run-1", baseRevision: -1, action: "queue", cardId: "card-1" },
        { workspaceId: "ws1", runId: "run-1", baseRevision: 1.5, action: "queue", cardId: "card-1" },
        { workspaceId: "ws1", baseRevision: 4, action: "queue", cardId: "card-1" },
      ];
      for (const params of badWrites) exReq(104, "cora.board.update", params);
      await flush();
      const refusals = ex.outbox
        .slice(-badWrites.length)
        .filter((frame) => frame?.ok === false && frame?.error?.code === "invalid-params");
      check(
        "cora.board.update refuses every malformed write before the board is touched",
        refusals.length === badWrites.length && calls.length === callsBefore,
        { refusals: refusals.length, newCalls: calls.length - callsBefore },
      );
    }

    const beforeCreate = ex.outbox.length;
    exReq(10, "terminal.create", {
      workspaceId: "ws1",
      cols: 92,
      rows: 31,
      profile: "codex",
      resumeSessionId: "session-codex-1",
      title: "Phone worker",
    });
    await flush();
    const createdFrames = ex.outbox.slice(beforeCreate);
    const createResponse = createdFrames[0];
    const createData = createdFrames[1];
    check(
      "terminal.create response precedes bootstrap terminal.data",
      createResponse?.id === 10 &&
        createResponse?.ok === true &&
        createData?.event === "terminal.data" &&
        createData?.payload?.terminalId === createResponse?.result?.terminalId,
      createdFrames,
    );
    check(
      "terminal.create exposes the visible desktop tab and trusted phone name",
      createResponse?.result?.desktopTabId === "term-desktop" &&
        calls.at(-1)?.[1]?.profile === "codex" &&
        calls.at(-1)?.[1]?.resumeSessionId === "session-codex-1" &&
        calls.at(-1)?.[1]?.origin?.deviceName === "Etienne's iPhone",
      { response: createResponse, origin: calls.at(-1)?.[1]?.origin },
    );

    exSession.destroy();
    check(
      "disconnect closes a visible shared terminal instead of detaching it",
      sharedTerminal?.closed === true && sharedTerminal?.detached === false,
      sharedTerminal,
    );
  }

  /* ---- old-Studio degradation for the optional surfaces ---------------- */

  {
    // The base services object has no board and no session delete, exactly
    // like a Studio that predates them. The phone must be told the method is
    // unknown so it hides the affordance instead of showing a dead control.
    const old = makeFakeStream();
    void new rpc.RpcSession(old, services);
    old.inject(rpc.encodeFrame({ id: 1, method: "hello", params: { protocol: 0 } }));
    await flush();
    const before = old.outbox.length;
    old.inject(rpc.encodeFrame({
      id: 2,
      method: "cora.board.get",
      params: { workspaceId: "ws1", runId: "run-1" },
    }));
    old.inject(rpc.encodeFrame({
      id: 5,
      method: "cora.whiteboard.get",
      params: { workspaceId: "ws1", runId: "run-1" },
    }));
    old.inject(rpc.encodeFrame({
      id: 3,
      method: "cora.board.update",
      params: { workspaceId: "ws1", runId: "run-1", baseRevision: 0, action: "queue", cardId: "c" },
    }));
    old.inject(rpc.encodeFrame({
      id: 4,
      method: "workerSessions.delete",
      params: { workspaceId: "ws1", runtime: "claude", sessionId: "abc" },
    }));
    await flush();
    const answers = old.outbox.slice(before);
    check(
      "an older Studio answers unknown-method for the board, whiteboard and session delete",
      answers.length === 4 &&
        answers.every(
          (frame) => frame?.ok === false && frame?.error?.code === "unknown-method",
        ),
      answers,
    );
  }

  /* ---- early terminal exit and oversized outbound reply guards --------- */

  {
    const early = makeFakeStream();
    const earlyServices = {
      ...services,
      createTerminal: async (request) => {
        request.onExit();
        return { write() {}, resize() {}, close() {} };
      },
    };
    void new rpc.RpcSession(early, earlyServices);
    early.inject(rpc.encodeFrame({ id: 1, method: "hello", params: { protocol: 0 } }));
    await flush();
    const before = early.outbox.length;
    early.inject(rpc.encodeFrame({
      id: 2,
      method: "terminal.create",
      params: { workspaceId: "ws1", cols: 80, rows: 24 },
    }));
    await flush();
    const frames = early.outbox.slice(before);
    check(
      "a terminal that exits before registration returns one create error",
      frames.length === 1 && frames[0]?.id === 2 && frames[0]?.ok === false,
      frames,
    );
    check(
      "an early terminal exit never emits an unassociable terminal.exit",
      !frames.some((frame) => frame?.event === "terminal.exit"),
      frames,
    );

    const huge = makeFakeStream();
    void new rpc.RpcSession(huge, {
      ...services,
      listWorkspaces: async () => [{
        id: "huge",
        name: "x".repeat(rpc.MAX_FRAME_BYTES + 100),
        path: "/tmp",
      }],
    });
    huge.inject(rpc.encodeFrame({ id: 1, method: "hello", params: { protocol: 0 } }));
    await flush();
    huge.inject(rpc.encodeFrame({ id: 2, method: "workspaces.list", params: {} }));
    await flush();
    check(
      "an oversized service response becomes a compact RPC error",
      huge.outbox.at(-1)?.id === 2 &&
        huge.outbox.at(-1)?.ok === false &&
        /too large/i.test(huge.outbox.at(-1)?.error?.message ?? ""),
      huge.outbox.at(-1),
    );
  }

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
