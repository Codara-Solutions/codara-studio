#!/usr/bin/env node
"use strict";

// SSH port forwarding for remote workspaces (src/main/remote/port-detect.ts,
// port-forwarding.ts, port-forward-runtime.ts and the forwardOut and
// lifecycle hook in connections.ts). Guards:
//
//   - the terminal URL parser: Vite, Next.js, Django and uvicorn banners with
//     colors and split chunks; URLs without a port or off this machine are
//     ignored
//   - the remote listening-port parser for Linux ss (with and without -H),
//     Linux and macOS netstat, macOS lsof and /proc/net/tcp
//   - local port selection: the same number when free, then nearby, then
//     8000 above a low port, then any
//   - the whole lifecycle against an in-process ssh2 server through the real
//     connections.ts and runtime: a port listening at connect is offered, not
//     forwarded; a new one is forwarded and announced; a URL printed in a
//     remote terminal (an agent's codara_terminal_create pane is one) is
//     forwarded once the host answers on it; stop, manual forward and
//     codara_preview_navigate's rewrite to the local port; a drop closes the
//     local listeners, a reconnect restores them on the same ports; a user's
//     disconnect is never undone; removing the last workspace on the host
//     closes everything
//
//   node scripts/test-remote-port-forward.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { Server: SshServer, utils: sshUtils } = require("ssh2");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-port-forward-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(TMP, "codara");
for (const dir of [HOME, CODARA]) fs.mkdirSync(dir, { recursive: true });
// connections.ts reads ~/.ssh keys and the agent: neither may be the real ones.
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CODARA_HOME_DIR = CODARA;
delete process.env.SSH_AUTH_SOCK;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, check, { timeoutMs = 8_000, everyMs = 40, nudge } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    if (nudge) await nudge();
    await sleep(everyMs);
  }
}

// ── Bundles ──────────────────────────────────────────────────────────────────

function sharedAlias(build) {
  build.onResolve({ filter: /^@shared\// }, (args) => ({
    path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
  }));
}

function loadBundle(text) {
  const mod = { exports: {} };
  new Function("module", "exports", "require", text)(mod, mod.exports, require);
  return mod.exports;
}

async function bundleDetect() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/remote/port-detect.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [{ name: "shared", setup: sharedAlias }],
    logLevel: "silent",
  });
  return loadBundle(out.outputFiles[0].text);
}

const harness = {
  state: { workspaces: [], activeWorkspaceId: null },
  stateListeners: [],
  sessions: [],
  taps: new Map(),
  tails: new Map(),
  sent: [],
  hosts: new Map(),
};
globalThis.__portForwardHarness = harness;

const STUBS = {
  electron: `
    const h = globalThis.__portForwardHarness;
    module.exports = {
      app: { once() {} },
      webContents: { getAllWebContents: () => [{ isDestroyed: () => false, send: (channel, payload) => h.sent.push({ channel, payload }) }] },
      safeStorage: { isEncryptionAvailable: () => false },
    };`,
  "../pty-manager": `
    const h = globalThis.__portForwardHarness;
    exports.resourceSnapshot = () => ({ sessions: h.sessions.map((s) => ({ id: s.id, cwd: s.cwd })) });
    exports.tap = (id, handler) => { h.taps.set(id, handler); return () => h.taps.delete(id); };
    exports.readTail = (id) => (h.tails.has(id) ? Buffer.from(h.tails.get(id)) : null);`,
  "../storage": `
    const h = globalThis.__portForwardHarness;
    exports.loadState = async () => h.state;
    exports.onStateSaved = (listener) => { h.stateListeners.push(listener); return () => {}; };`,
  "./ssh-hosts": `
    exports.getHost = async (id) => globalThis.__portForwardHarness.hosts.get(id) ?? null;`,
  "./secret-store": `
    exports.getSecret = async (key) => (key.startsWith("password:") ? "test-password" : null);
    exports.setSecret = async () => {};
    exports.deleteSecret = async () => {};`,
  "../codara-home": `exports.codaraHome = () => ${JSON.stringify(CODARA)};`,
  "../fs-atomic": `
    const fs = require("node:fs");
    exports.writeFileAtomic = async (file, data) => fs.promises.writeFile(file, data);`,
};

async function bundleRuntime() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "./port-forward-runtime";
        export { resolveRemotePreviewUrl } from "./port-forward-preview";
        export * as connections from "./connections";
      `,
      resolveDir: path.join(ROOT, "src/main/remote"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    // connections.ts loads ssh2 with import(); the real ssh2 comes from this
    // script's require, not from a bundled copy.
    supported: { "dynamic-import": false },
    external: ["ssh2"],
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(build) {
          sharedAlias(build);
          for (const name of Object.keys(STUBS)) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({ path: name, namespace: "stub" }));
          }
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
        },
      },
    ],
  });
  return loadBundle(out.outputFiles[0].text);
}

// ── Parser and selection checks ──────────────────────────────────────────────

function testTerminalUrls(detect) {
  const vite =
    "\x1b[32m  VITE\x1b[39m v5.4.0  ready in 312 ms\r\n\r\n" +
    "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n" +
    "  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: use \x1b[1m--host\x1b[22m to expose\r\n";
  assert.deepEqual(detect.terminalPortUrls(vite), [{ port: 5173, host: "localhost", scheme: "http", path: "/" }]);
  assert.deepEqual(
    detect.terminalPortUrls("   ▲ Next.js 14.2.3\n   - Local:        http://localhost:3000\n").map((u) => u.port),
    [3000],
  );
  assert.deepEqual(detect.terminalPortUrls("Starting development server at http://127.0.0.1:8000/\n"), [
    { port: 8000, host: "127.0.0.1", scheme: "http", path: "/" },
  ]);
  assert.deepEqual(
    detect.terminalPortUrls("INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)\n"),
    [{ port: 8000, host: "localhost", scheme: "http", path: "/" }],
  );
  assert.deepEqual(detect.terminalPortUrls("api at http://[::1]:4000/app?x=1 ready\n"), [
    { port: 4000, host: "::1", scheme: "http", path: "/app?x=1" },
  ]);
  assert.deepEqual(detect.terminalPortUrls("TLS on https://localhost:8443/\n").map((u) => u.scheme), ["https"]);
  assert.deepEqual(detect.terminalPortUrls("see http://localhost/ and http://example.com:8080/\n"), []);
  assert.deepEqual(detect.terminalPortUrls("http://localhost:80/ explicitly\n").map((u) => u.port), [80]);
  ok("terminal URLs: dev server banners, colors, 0.0.0.0, IPv6, https; no implicit or foreign ports");

  const scanner = new detect.TerminalPortScanner();
  assert.deepEqual(scanner.push("Local: http://localhost:5"), []);
  assert.deepEqual(scanner.push("173/"), [], "a line that has not ended waits");
  assert.deepEqual(scanner.push("\r\n").map((u) => u.port), [5173]);
  assert.deepEqual(scanner.push("\x1b[2K\rbuilding... 42%"), [], "redraws without a URL are not parsed");
  ok("scanner: a URL split across chunks is found once its line ends");

  const ctx = { sshPort: 2222 };
  assert.equal(detect.terminalPortAllowed(22, ctx), false);
  assert.equal(detect.terminalPortAllowed(2222, ctx), false, "the host's SSH port");
  assert.equal(detect.terminalPortAllowed(80, ctx), true, "a low port printed in a terminal is allowed");
  assert.equal(detect.terminalPortAllowed(5173, ctx), true);
  const auto = (entry) => detect.listeningPortAutoForwards({ addresses: ["127.0.0.1"], ...entry }, ctx);
  assert.equal(auto({ port: 5173, process: "node" }), true);
  assert.equal(auto({ port: 80 }), false, "below 1024 only from terminal output");
  assert.equal(auto({ port: 22 }), false);
  assert.equal(auto({ port: 41_234 }), false, "ephemeral ports are not dev servers");
  assert.equal(auto({ port: 1455, process: "codex" }), false, "an agent CLI's sign-in callback");
  assert.equal(auto({ port: 2222, process: "sshd" }), false);
  ok("system, SSH, ephemeral and agent CLI ports are not forwarded on their own");
}

const SS_H = `LISTEN 0      4096         127.0.0.53%lo:53         0.0.0.0:*
LISTEN 0      128                0.0.0.0:22         0.0.0.0:*
LISTEN 0      511              127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=4121,fd=24))
LISTEN 0      244              127.0.0.1:5432       0.0.0.0:*
LISTEN 0      128                   [::]:22            [::]:*
LISTEN 0      511                  [::1]:5173          [::]:*    users:(("node",pid=4121,fd=25))
LISTEN 0      4096                     *:8080             *:*    users:(("python3",pid=777,fd=3))
LISTEN 0      511     [::ffff:127.0.0.1]:3000             *:*    users:(("next-server (v1",pid=901,fd=21))`;

const SS_HEADER = `State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess
LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=4121,fd=24))
tcp    LISTEN 0      128              *:22               *:*`;

const LINUX_NETSTAT = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 127.0.0.1:5173          0.0.0.0:*               LISTEN      4121/node
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      -
tcp6       0      0 :::22                   :::*                    LISTEN      -
tcp6       0      0 ::1:5173                :::*                    LISTEN      4121/node`;

const MAC_NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.5173         *.*                    LISTEN
tcp6       0      0  ::1.5173               *.*                    LISTEN
tcp46      0      0  *.8080                 *.*                    LISTEN
tcp4       0      0  192.168.1.20.52344     17.57.146.52.5223      ESTABLISHED
tcp4       0      0  *.22                   *.*                    LISTEN`;

const MAC_LSOF = `COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      51234 etienne   24u  IPv4 0x8d2b7f0c1e4a1b2c      0t0  TCP 127.0.0.1:5173 (LISTEN)
node      51234 etienne   25u  IPv6 0x8d2b7f0c1e4a1b2d      0t0  TCP [::1]:5173 (LISTEN)
ControlCenter   612 etienne    9u  IPv4 0x8d2b7f0c1e4a1b2e      0t0  TCP *:7000 (LISTEN)
Google\\x20Chrome\\x20Helper 8123 etienne 30u IPv4 0x1 0t0 TCP 127.0.0.1:9222 (LISTEN)`;

const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1234 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1435 0100007F:C2D4 01 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000000000000000 20 4 30 10 -1
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41235 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41236 1 0000000000000000 100 0 0 10 0`;

function testListingParser(detect) {
  const ss = detect.parseListeningPorts(`@ss\n${SS_H}\n`);
  assert.equal(ss.listing, "ss");
  assert.deepEqual(
    ss.ports.map((p) => p.port),
    [22, 53, 3000, 5173, 5432, 8080],
  );
  const vite = ss.ports.find((p) => p.port === 5173);
  assert.deepEqual(vite, { port: 5173, addresses: ["127.0.0.1", "::1"], process: "node", pid: 4121 });
  assert.deepEqual(ss.ports.find((p) => p.port === 53).addresses, ["127.0.0.53"], "%lo scope dropped");
  assert.deepEqual(ss.ports.find((p) => p.port === 22).addresses, ["0.0.0.0", "::"]);
  assert.equal(ss.ports.find((p) => p.port === 3000).process, "next-server (v1");
  assert.deepEqual(ss.ports.find((p) => p.port === 8080).addresses, ["*"]);
  const header = detect.parseListeningPorts(`@ss\n${SS_HEADER}\n`);
  assert.deepEqual(header.ports.map((p) => [p.port, p.addresses]), [[22, ["*"]], [5173, ["127.0.0.1"]]]);
  ok("Linux ss, with and without -H and with an old Netid column");

  const linux = detect.parseListeningPorts(`@netstat\n${LINUX_NETSTAT}\n`);
  assert.deepEqual(linux.ports, [
    { port: 22, addresses: ["0.0.0.0", "::"] },
    { port: 5173, addresses: ["127.0.0.1", "::1"], pid: 4121, process: "node" },
  ]);
  const mac = detect.parseListeningPorts(`@netstat\n${MAC_NETSTAT}\n`);
  assert.deepEqual(mac.ports, [
    { port: 22, addresses: ["*"] },
    { port: 5173, addresses: ["127.0.0.1", "::1"] },
    { port: 8080, addresses: ["*"] },
  ]);
  ok("Linux netstat -ltnp and macOS netstat -an (dot ports), connections left out");

  const lsof = detect.parseListeningPorts(`@lsof\n${MAC_LSOF}\n`);
  assert.deepEqual(lsof.ports, [
    { port: 5173, addresses: ["127.0.0.1", "::1"], process: "node", pid: 51234 },
    { port: 7000, addresses: ["*"], process: "ControlCenter", pid: 612 },
    { port: 9222, addresses: ["127.0.0.1"], process: "Google Chrome Helper", pid: 8123 },
  ]);
  ok("macOS lsof, escaped command names unescaped");

  const proc = detect.parseListeningPorts(`@proc\n${PROC_NET_TCP}\n`);
  assert.deepEqual(proc.ports, [
    { port: 22, addresses: ["0.0.0.0"] },
    { port: 3000, addresses: ["::ffff:127.0.0.1"] },
    { port: 5173, addresses: ["127.0.0.1", "::1"] },
  ]);
  ok("/proc/net/tcp and tcp6 when no tool is installed");

  assert.deepEqual(detect.parseListeningPorts("@none\n"), { listing: "none", ports: [] });
  assert.deepEqual(detect.parseListeningPorts(""), { listing: "none", ports: [] });
  assert.equal(detect.parseListeningPorts("Welcome to the box!\n@ss\n" + SS_H).ports.length, 6, "a login banner before the marker");
  ok("@none and empty output mean no listing");

  assert.equal(detect.forwardTargetHost(["127.0.0.1", "::1"]), "127.0.0.1");
  assert.equal(detect.forwardTargetHost(["::1"]), "::1", "Vite bound to ::1 only");
  assert.equal(detect.forwardTargetHost(["::"]), "::1");
  assert.equal(detect.forwardTargetHost(["*"]), "127.0.0.1");
  assert.equal(detect.forwardTargetHost(["::ffff:127.0.0.1"]), "127.0.0.1");
  assert.equal(detect.forwardTargetHost(["10.0.0.5"]), "10.0.0.5");
  assert.equal(detect.forwardTargetHost([], "127.0.0.1"), "127.0.0.1");
  assert.equal(detect.forwardTargetHost([], "localhost"), "localhost");
  assert.equal(detect.forwardTargetHost([]), "localhost");
  ok("the remote end connects to the address the server is bound to");

  for (const tool of ["ss -ltnpH", "netstat -ltnp", "/proc/net/tcp", "lsof -nP +c 0 -iTCP -sTCP:LISTEN", "netstat -an -p tcp", "echo @none"]) {
    assert.ok(detect.REMOTE_LISTEN_SCRIPT.includes(tool), `listing script runs ${tool}`);
  }
  ok("the listing script covers Linux and macOS");
}

async function testPortSelection(detect) {
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  assert.deepEqual(detect.candidateLocalPorts(5173), [...range(5173, 5183), 0]);
  assert.deepEqual(
    detect.candidateLocalPorts(5173, { preferred: 5180 }),
    [5180, ...range(5173, 5179), ...range(5181, 5183), 0],
    "a restored forward tries its old local port first",
  );
  assert.deepEqual(detect.candidateLocalPorts(80), [...range(80, 90), ...range(8080, 8090), 0]);
  assert.deepEqual(detect.candidateLocalPorts(5173, { reserved: new Set([5173, 5174]) }).slice(0, 2), [5175, 5176]);
  assert.deepEqual(detect.candidateLocalPorts(65_535), [65_535, 0]);
  const taken = new Set([5173, 5174]);
  const tried = [];
  const bound = await detect.bindFirstFree(detect.candidateLocalPorts(5173), async (port) => {
    tried.push(port);
    return taken.has(port) ? null : `server:${port}`;
  });
  assert.deepEqual(bound, { port: 5175, value: "server:5175" });
  assert.deepEqual(tried, [5173, 5174, 5175]);
  assert.equal(await detect.bindFirstFree([1, 2], async () => null), null);
  assert.equal(detect.localForwardUrl("http", 5174, "/app?x=1"), "http://localhost:5174/app?x=1");
  ok("local ports: same number, nearby, 8000 above a low port, then any");
}

// ── In-process SSH server ────────────────────────────────────────────────────

/** A listening "remote" port: remote number -> upstream HTTP server on this machine. */
const remote = {
  ports: new Map(),
  /** Answering on the host but left out of the listing, so only another source can find them. */
  hidden: new Set(),
  execs: [],
  tcpip: [],
  clients: [],
  listingFormat: "ss",
};

function listingOutput() {
  const rows = [...remote.ports.keys()].filter((port) => !remote.hidden.has(port)).map(
    (port) => `LISTEN 0      511              127.0.0.1:${port}       0.0.0.0:*    users:(("node",pid=${4000 + (port % 1000)},fd=24))`,
  );
  return `@ss\nLISTEN 0      128                0.0.0.0:22         0.0.0.0:*\n${rows.join("\n")}\n`;
}

function startSshServer() {
  const hostKey = sshUtils.generateKeyPairSync("ed25519").private;
  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    remote.clients.push(client);
    client.on("error", () => undefined);
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "codara" && ctx.password === "test-password") ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          remote.execs.push(info.command);
          let stdin = "";
          stream.on("data", (chunk) => {
            stdin += chunk;
          });
          stream.on("end", () => {
            let out = "";
            if (info.command === "sh -s" && stdin.includes("ss -ltnpH")) out = listingOutput();
            else if (/^ps -o args= -p \d+$/.test(info.command)) out = "node node_modules/.bin/vite --port 5173\n";
            stream.write(out);
            stream.exit(0);
            stream.end();
          });
        });
      });
      // direct-tcpip: what an ssh -L forward opens on the server.
      client.on("tcpip", (accept, reject, info) => {
        remote.tcpip.push({ destIP: info.destIP, destPort: info.destPort });
        const upstream = remote.ports.get(info.destPort);
        if (!upstream) return reject();
        const socket = net.connect({ host: "127.0.0.1", port: upstream });
        socket.once("error", () => reject());
        socket.once("connect", () => {
          socket.removeAllListeners("error");
          const channel = accept();
          socket.on("error", () => channel.destroy());
          channel.on("error", () => socket.destroy());
          channel.pipe(socket).pipe(channel);
        });
      });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function listen(serverOrHandler, port) {
  const server = typeof serverOrHandler === "function" ? http.createServer(serverOrHandler) : serverOrHandler;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function devServer(body) {
  const server = await listen((_req, res) => res.end(body), 0);
  return { server, port: server.address().port };
}

/** A port in [20000, 30000) that nothing on this machine holds right now. */
async function freePortInRange(avoid = new Set()) {
  for (let i = 0; i < 200; i += 1) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    if (avoid.has(port)) continue;
    const probe = net.createServer();
    const free = await new Promise((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port in range");
}

function get(port, urlPath = "/") {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("request timed out")));
  });
}

function refused(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

// ── Lifecycle against the real runtime ───────────────────────────────────────

async function testLifecycle() {
  const sshd = await startSshServer();
  const sshPort = sshd.address().port;
  harness.hosts.set("box", { id: "box", host: "127.0.0.1", port: sshPort, username: "codara", source: "manual" });

  const api = await bundleRuntime();
  const handlers = new Map();
  api.registerPortForwardIpc((channel, listener) => handlers.set(channel, listener));
  const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
  const manager = api.portForwarding();
  const conn = api.connections;
  assert.deepEqual([...handlers.keys()].sort(), ["ports:forward", "ports:snapshot", "ports:stop"]);

  const snapshot = () => invoke("ports:snapshot", "ws-remote");
  const forwardOf = async (port) => (await snapshot())?.forwards.find((f) => f.remotePort === port);
  const notices = () => harness.sent.filter((m) => m.channel === "ports:notice").map((m) => m.payload);
  const pollUntil = (what, check) => waitFor(what, check, { nudge: () => manager.pollHost("box") });

  // Two workspaces on the host and one local; the host is not connected yet.
  harness.state = {
    workspaces: [
      { id: "ws-remote", cwd: "ssh://box/home/codara/app" },
      { id: "ws-remote-2", cwd: "ssh://box/home/codara/api" },
      { id: "ws-local", cwd: TMP },
    ],
    activeWorkspaceId: "ws-remote",
  };
  for (const listener of harness.stateListeners) listener(harness.state);
  await sleep(20);
  assert.deepEqual(await snapshot(), { hostId: "box", connected: false, forwards: [], available: [], listing: "pending" });
  assert.equal(await invoke("ports:snapshot", "ws-local"), null, "a local workspace has no Ports list");
  assert.equal(remote.clients.length, 0, "forwarding never connects a host by itself");
  ok("nothing runs, and nothing connects, before the host is connected");

  // A server already running when the host connects is offered, not forwarded.
  const early = await devServer("early");
  const earlyRemote = await freePortInRange();
  remote.ports.set(earlyRemote, early.port);
  await (await conn.getConnection("box")).ensure();
  await waitFor("the first listing", async () => (await snapshot()).listing === "ss");
  let snap = await snapshot();
  assert.equal(snap.connected, true);
  assert.deepEqual(snap.forwards, []);
  assert.deepEqual(snap.available.map((a) => a.port), [earlyRemote], "22 is never offered");
  assert.ok(remote.execs.includes("sh -s"), "the listing script goes in on stdin, not through the login shell");
  ok("a port listening at connect is offered under Listening, not forwarded");

  // A server that starts afterwards is forwarded to the same local port and announced.
  const vite = await devServer("vite");
  const viteRemote = await freePortInRange(new Set([earlyRemote]));
  remote.ports.set(viteRemote, vite.port);
  const viteForward = await pollUntil("the new port to be forwarded", () => forwardOf(viteRemote));
  assert.equal(viteForward.source, "listening");
  assert.equal(viteForward.state, "active");
  assert.equal(viteForward.localPort, viteRemote, "the same local port when it is free");
  assert.equal(viteForward.localUrl, `http://localhost:${viteRemote}/`);
  assert.equal(viteForward.remoteHost, "127.0.0.1");
  assert.equal(await get(viteRemote), "vite");
  assert.deepEqual(notices(), [
    { hostId: "box", remotePort: viteRemote, localPort: viteRemote, url: `http://localhost:${viteRemote}/` },
  ]);
  await pollUntil("the process command", async () => (await forwardOf(viteRemote)).command);
  assert.equal((await forwardOf(viteRemote)).command, "node node_modules/.bin/vite --port 5173");
  assert.match((await forwardOf(viteRemote)).process, /^node \(\d+\)$/);
  ok("a port that starts listening is forwarded on the same number, announced once, and serves HTTP");

  // A local port already taken moves the forward to a nearby one.
  const busyRemote = await freePortInRange(new Set([earlyRemote, viteRemote]));
  const blocker = await listen(net.createServer(), busyRemote);
  const api2 = await devServer("api");
  remote.ports.set(busyRemote, api2.port);
  const moved = await pollUntil("the busy port to be forwarded", () => forwardOf(busyRemote));
  assert.notEqual(moved.localPort, busyRemote);
  assert.ok(moved.localPort > busyRemote && moved.localPort <= busyRemote + 10, `nearby port, got ${moved.localPort}`);
  assert.equal(await get(moved.localPort), "api");
  assert.equal(notices().at(-1).localPort, moved.localPort);
  ok("a local port already in use moves the forward to a free nearby one");

  // A URL printed in a remote terminal (an agent's codara_terminal_create pane is one).
  const web = await devServer("web");
  const webRemote = await freePortInRange(new Set([earlyRemote, viteRemote, busyRemote]));
  const deadRemote = await freePortInRange(new Set([earlyRemote, viteRemote, busyRemote, webRemote]));
  harness.sessions = [
    { id: "pane-agent", cwd: "ssh://box/home/codara/app" },
    { id: "pane-local", cwd: TMP },
  ];
  harness.tails.set("pane-agent", "$ npm run dev\r\n");
  manager.syncPanes();
  assert.ok(harness.taps.has("pane-agent"));
  assert.ok(!harness.taps.has("pane-local"), "local panes are not read");
  const write = (text) => harness.taps.get("pane-agent")(Buffer.from(text));
  // Printed but nothing listening on the host (stale history): never forwarded.
  write(`old banner http://localhost:${deadRemote}/\r\n`);
  // Left out of the listing, so the 4 s poll cannot find it first: only output names it.
  remote.hidden.add(webRemote);
  remote.ports.set(webRemote, web.port);
  write(`  \x1b[1mLocal\x1b[22m:   http://localhost:${webRemote.toString().slice(0, 2)}`);
  write(`${webRemote.toString().slice(2)}/dashboard\r\n`);
  const printed = await waitFor("the printed port to be forwarded", () => forwardOf(webRemote));
  assert.equal(printed.source, "terminal");
  assert.equal(printed.localUrl, `http://localhost:${webRemote}/dashboard`);
  assert.equal(await get(webRemote, "/dashboard"), "web");
  assert.equal(notices().at(-1).url, `http://localhost:${webRemote}/dashboard`);
  remote.hidden.delete(webRemote);
  await sleep(4_000);
  assert.equal(await forwardOf(deadRemote), undefined, "a URL the host does not answer on is not forwarded");
  ok("a URL printed in a remote terminal is forwarded once the host answers on it, with its path");

  // Stop: closed, and not forwarded again while the server keeps running.
  await invoke("ports:stop", { workspaceId: "ws-remote", port: webRemote });
  assert.equal(await forwardOf(webRemote), undefined);
  assert.ok(await refused(webRemote));
  write(`  Local:   http://localhost:${webRemote}/\r\n`);
  await manager.pollHost("box");
  await sleep(600);
  assert.equal(await forwardOf(webRemote), undefined, "a stopped port stays stopped");
  ok("stop forwarding closes the local port and it is not forwarded again on its own");

  // Forward by hand, and the manual forward from the Listening list.
  snap = await invoke("ports:forward", { workspaceId: "ws-remote-2", port: earlyRemote });
  const manual = snap.forwards.find((f) => f.remotePort === earlyRemote);
  assert.equal(manual.source, "manual");
  assert.equal(await get(manual.localPort), "early");
  assert.ok(!snap.available.some((a) => a.port === earlyRemote), "forwarded ports leave the Listening list");
  await assert.rejects(invoke("ports:forward", { workspaceId: "ws-remote", port: 70_000 }), /1 to 65535/);
  await assert.rejects(invoke("ports:forward", { workspaceId: "ws-local", port: 3000 }), /not on an SSH host/);
  ok("a port forwarded by hand serves, from either workspace on the host; bad input is refused");

  // codara_preview_navigate: localhost:<remote port> opens the forwarded local port.
  const preview = await devServer("preview");
  const previewRemote = await freePortInRange(new Set([earlyRemote, viteRemote, busyRemote, webRemote, deadRemote]));
  remote.hidden.add(previewRemote);
  remote.ports.set(previewRemote, preview.port);
  const resolved = await api.resolveRemotePreviewUrl("ws-remote", `http://localhost:${previewRemote}/app?x=1`);
  assert.deepEqual(resolved, { url: `http://localhost:${previewRemote}/app?x=1` });
  assert.equal((await forwardOf(previewRemote)).source, "agent");
  assert.equal(await get(previewRemote, "/app?x=1"), "preview");
  remote.hidden.delete(previewRemote);
  const viaMoved = await api.resolveRemotePreviewUrl(undefined, `http://127.0.0.1:${busyRemote}/`);
  assert.deepEqual(viaMoved, { url: `http://127.0.0.1:${moved.localPort}/` }, "the active workspace, and a moved port");
  const notListening = await api.resolveRemotePreviewUrl("ws-remote", `http://localhost:${deadRemote}/`);
  assert.match(notListening.error, new RegExp(`Nothing is listening on port ${deadRemote} on box`));
  assert.equal(await api.resolveRemotePreviewUrl("ws-local", "http://localhost:5173/"), null, "local workspaces are untouched");
  assert.equal(await api.resolveRemotePreviewUrl("ws-remote", "https://example.com/"), null);
  ok("codara_preview_navigate to localhost:<port> in a remote workspace opens the forward, or says nothing listens");

  // A port that stops listening loses its automatic forward; a manual one stays.
  remote.ports.delete(busyRemote);
  await pollUntil("the stopped server's forward to go", async () => !(await forwardOf(busyRemote)));
  assert.ok(await refused(moved.localPort));
  blocker.close();
  remote.ports.delete(earlyRemote);
  await manager.pollHost("box");
  await manager.pollHost("box");
  await manager.pollHost("box");
  assert.equal((await forwardOf(earlyRemote))?.source, "manual", "a manual forward stays until stopped");
  remote.ports.set(earlyRemote, early.port);
  ok("an automatic forward closes when its server stops; a manual one stays");

  // The connection drops: local listeners close and wait; a reconnect restores them.
  const before = (await snapshot()).forwards.filter((f) => f.state === "active").map((f) => [f.remotePort, f.localPort]);
  assert.ok(before.length >= 3);
  remote.clients.at(-1).end();
  await waitFor("the forwards to wait", async () => {
    const s = await snapshot();
    return !s.connected && s.forwards.every((f) => f.state === "waiting" && f.localPort === null);
  });
  for (const [, local] of before) assert.ok(await refused(local), `local ${local} closes with the connection`);
  assert.equal(conn.getConnectionStatus("box").state, "disconnected");
  await sleep(300);
  assert.equal(conn.getConnectionStatus("box").state, "disconnected", "nothing reconnects on its own");
  ok("a dropped connection closes every local port and keeps the forwards waiting");

  const clientsBefore = remote.clients.length;
  await (await conn.getConnection("box")).ensure();
  assert.equal(remote.clients.length, clientsBefore + 1);
  await waitFor("the forwards to come back", async () => {
    const s = await snapshot();
    return s.connected && s.forwards.length === before.length && s.forwards.every((f) => f.state === "active");
  });
  const after = (await snapshot()).forwards.map((f) => [f.remotePort, f.localPort]);
  assert.deepEqual(after, before, "each forward comes back on its old local port");
  assert.equal(await get(viteRemote), "vite");
  assert.equal(await get(previewRemote, "/app?x=1"), "preview");
  ok("a reconnect restores the forwards that were active, on the same local ports");

  // The user disconnects: forwards wait, and a poll or a connection to a local port does not reconnect.
  const noticesBefore = notices().length;
  conn.disconnectHost("box");
  await waitFor("the disconnect to land", async () => !(await snapshot()).connected);
  await manager.pollHost("box");
  manager.syncPanes();
  assert.ok(await refused(viteRemote));
  await sleep(200);
  assert.equal(conn.getConnectionStatus("box").state, "disconnected", "a disconnected host stays disconnected");
  assert.equal(notices().length, noticesBefore, "restores and waits are quiet");
  ok("a host the user disconnected is never reconnected by forwarding");

  // Reconnect, then remove one of the two workspaces: forwards stay; remove the last: all close.
  await (await conn.getConnection("box")).ensure();
  await waitFor("the forwards to come back", async () => (await snapshot()).forwards.every((f) => f.state === "active"));
  harness.state = { ...harness.state, workspaces: harness.state.workspaces.filter((w) => w.id !== "ws-remote") };
  for (const listener of harness.stateListeners) listener(harness.state);
  assert.equal(await get(viteRemote), "vite", "another workspace on the host keeps the forwards");
  snap = await invoke("ports:snapshot", "ws-remote-2");
  assert.ok(snap.forwards.length > 0);
  harness.state = { ...harness.state, workspaces: harness.state.workspaces.filter((w) => w.id !== "ws-remote-2") };
  for (const listener of harness.stateListeners) listener(harness.state);
  for (const [remotePort, local] of after) assert.ok(await refused(local), `local ${local} (remote ${remotePort}) closes`);
  assert.equal(harness.taps.size, 0, "terminal taps are released");
  assert.equal(await invoke("ports:snapshot", "ws-remote-2"), null);
  ok("closing the last workspace on the host closes every forward and lets go of its terminals");

  conn.disposeAllConnections();
  manager.dispose();
  for (const server of [early.server, vite.server, api2.server, web.server, preview.server]) server.close();
  sshd.close();
}

(async () => {
  const detect = await bundleDetect();
  testTerminalUrls(detect);
  testListingParser(detect);
  await testPortSelection(detect);
  await testLifecycle();
  console.log(`\n${passed} checks passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch((error) => {
  console.error(error);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
