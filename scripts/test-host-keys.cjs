#!/usr/bin/env node
"use strict";

// Host keys (src/main/remote/host-keys.ts and verifyHostKey in
// connections.ts, Machines phase 2). Guards:
//
//   - fingerprints read exactly as `ssh-keygen -lf` prints them, and the key
//     type comes from the key itself
//   - ~/.ssh/known_hosts matching: plain names for port 22, `[host]:port`
//     otherwise, hashed names, `*` / `?` patterns and `!` negation; a
//     `@revoked` key always loses, `@cert-authority` lines are not host keys
//   - with confirmation off (the default) a new key is trusted on first use,
//     as before
//   - with it on: a key the user's known_hosts lists connects without asking;
//     an unknown one asks first, with a long enough handshake timeout to read
//     the question; refusing stores nothing and asks for no password; a
//     revoked key never connects; Codara Cloud boxes keep trust on first use
//   - a changed key is refused, the row carries both fingerprints, and
//     trusting the new key replaces that host's entry and connects; a key
//     that disagrees with the user's known_hosts is a changed key too, never
//     a first-use question
//   - a ~/.ssh/config host with HostKeyAlias is confirmed like any other,
//     looked up in known_hosts by the alias with no port, as OpenSSH does
//   - "Trust the new key" trusts only the key the card showed, and only
//     until the host is disconnected, edited or removed
//   - every host-key prompt that ends (answered, cancelled, timed out) is
//     reported closed so every window drops it
//   - a new machine that does not answer fails after the normal connect
//     timeout; only a machine that answered waits for the user
//
//   node scripts/test-host-keys.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash, createHmac, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-host-keys-"));

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

function wireKey(type, body) {
  const t = Buffer.from(type);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(t.length);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([head, t, len, body]);
}

async function bundle(entry, plugins, outName) {
  const outfile = path.join(TMP, outName);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  return require(outfile);
}

function connectionStubs() {
  const sources = {
    ssh2: `
      import { EventEmitter } from "node:events";
      export class Client extends EventEmitter {
        connect(config) {
          const h = globalThis.__codaraHostKeyHarness;
          h.connects.push(config);
          if (h.unreachable) return;
          config.hostVerifier(h.serverKey, (trusted) => {
            setImmediate(() => {
              if (trusted) this.emit("ready");
              else this.emit("error", new Error("Host denied (verification failed)"));
            });
          });
        }
        end() { setImmediate(() => this.emit("close")); return this; }
        destroy() { return this; }
      }
      export const utils = { parseKey() { return {}; } };
    `,
    "./ssh-hosts": `
      export async function getHost(hostId) {
        return globalThis.__codaraHostKeyHarness.hosts[hostId] ?? null;
      }
    `,
    "./codara-boxes": "export async function wakeCodaraBox() {}",
    "./box-key-retry": `
      export function nextFreshKeyDelayMs() { return null; }
      export function clearFreshBoxKey() {}
      export function abortableDelay() { return Promise.resolve(); }
    `,
    "./secret-store": `
      export async function getSecret(key) { return key.startsWith("password:") ? "pw" : null; }
      export async function setSecret() {}
      export async function deleteSecret() {}
    `,
    "../fs-atomic": `
      export async function writeFileAtomic(file, text) {
        globalThis.__codaraHostKeyHarness.files.set(file, text);
      }
    `,
    "../codara-home": "export function codaraHome() { return '/codara-home'; }",
    "node:fs": `
      export const existsSync = () => false;
      export const promises = {
        async readFile(file) {
          const text = globalThis.__codaraHostKeyHarness.files.get(String(file));
          if (text === undefined) {
            const error = new Error("ENOENT");
            error.code = "ENOENT";
            throw error;
          }
          return text;
        },
      };
    `,
    "node:os": "export function homedir() { return '/home/me'; }",
  };
  return {
    name: "host-key-stubs",
    setup(build) {
      for (const specifier of Object.keys(sources)) {
        const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({ path: specifier, namespace: "hk" }));
      }
      build.onLoad({ filter: /.*/, namespace: "hk" }, (args) => ({ contents: sources[args.path], loader: "js" }));
    },
  };
}

function hasSshKeygen() {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (err) {
    return err.status !== undefined && err.status !== 127 && err.code !== "ENOENT";
  }
}

(async () => {
  const keys = await bundle("src/main/remote/host-keys.ts", [], "host-keys.cjs");
  const key = wireKey("ssh-ed25519", randomBytes(32));
  const other = wireKey("ssh-ed25519", randomBytes(32));
  const b64 = key.toString("base64");

  {
    assert.equal(keys.hostKeyType(key), "ssh-ed25519");
    assert.equal(keys.hostKeyType(Buffer.from("junk")), "unknown");
    assert.equal(keys.storedFingerprint(key), createHash("sha256").update(key).digest("base64"));
    assert.equal(keys.displayFingerprint(keys.storedFingerprint(key)), keys.sshFingerprint(key));
    if (hasSshKeygen()) {
      const file = path.join(TMP, "id_test");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file], { stdio: "ignore" });
      const pub = fs.readFileSync(`${file}.pub`, "utf8").trim().split(/\s+/);
      const listed = execFileSync("ssh-keygen", ["-lf", `${file}.pub`], { encoding: "utf8" }).split(/\s+/)[1];
      assert.equal(keys.sshFingerprint(Buffer.from(pub[1], "base64")), listed);
      assert.equal(keys.hostKeyType(Buffer.from(pub[1], "base64")), pub[0]);
    } else {
      console.log("  skip ssh-keygen comparison (no ssh-keygen)");
    }
    ok("fingerprints and key types read as ssh-keygen prints them");
  }

  {
    const v = (text, host, port, k = key) => keys.knownHostsVerdict(text, host, port, k).kind;
    assert.equal(v(`nas.local ssh-ed25519 ${b64}`, "nas.local", 22), "match");
    assert.equal(v(`NAS.local ssh-ed25519 ${b64}`, "nas.local", 22), "match", "host names ignore case");
    assert.equal(v(`nas.local ssh-ed25519 ${b64}`, "nas.local", 2222), "none", "a plain name is port 22 only");
    assert.equal(v(`[nas.local]:2222 ssh-ed25519 ${b64}`, "nas.local", 2222), "match");
    assert.equal(v(`alias,10.0.0.5 ssh-ed25519 ${b64}`, "10.0.0.5", 22), "match");
    assert.equal(v(`nas.local ssh-ed25519 ${b64}`, "nas.local", 22, other), "mismatch", "another key of the same type: changed");
    const listed = keys.knownHostsVerdict(`nas.local ssh-ed25519 ${b64}`, "nas.local", 22, other);
    assert.ok(listed.kind === "mismatch" && listed.listedKey.equals(key), "the mismatch carries the listed key");
    assert.equal(
      v(`nas.local ssh-ed25519 ${other.toString("base64")}\nnas.local ssh-ed25519 ${b64}`, "nas.local", 22),
      "match",
      "any line listing the key wins over another that does not",
    );
    assert.equal(v(`nas.local ssh-rsa ${wireKey("ssh-rsa", randomBytes(64)).toString("base64")}`, "nas.local", 22), "none", "another key type is not a change");
    assert.equal(v(`other.local ssh-ed25519 ${other.toString("base64")}`, "nas.local", 22), "none");
    assert.equal(v(`*.tail1234.ts.net ssh-ed25519 ${b64}`, "nas.tail1234.ts.net", 22), "match");
    assert.equal(v(`10.0.0.? ssh-ed25519 ${b64}`, "10.0.0.7", 22), "match");
    assert.equal(v(`10.0.0.*,!10.0.0.7 ssh-ed25519 ${b64}`, "10.0.0.7", 22), "none", "negation wins");
    const salt = randomBytes(20);
    const hash = createHmac("sha1", salt).update("[nas.local]:2222").digest("base64");
    assert.equal(v(`|1|${salt.toString("base64")}|${hash} ssh-ed25519 ${b64}`, "nas.local", 2222), "match");
    assert.equal(v(`|1|${salt.toString("base64")}|${hash} ssh-ed25519 ${b64}`, "nas.local", 22), "none");
    assert.equal(
      v(`nas.local ssh-ed25519 ${b64}\n@revoked * ssh-ed25519 ${b64}`, "nas.local", 22),
      "revoked",
      "a revoked key loses even when listed",
    );
    assert.equal(v(`@cert-authority *.local ssh-ed25519 ${b64}`, "nas.local", 22), "none");
    assert.equal(v(`# nas.local ssh-ed25519 ${b64}\n\n`, "nas.local", 22), "none");
    if (hasSshKeygen()) {
      const file = path.join(TMP, "known_hosts");
      fs.writeFileSync(file, `[nas.local]:2222 ssh-ed25519 ${b64}\n`);
      execFileSync("ssh-keygen", ["-H", "-f", file], { stdio: "ignore" });
      const hashed = fs.readFileSync(file, "utf8");
      assert.match(hashed, /^\|1\|/);
      assert.equal(v(hashed, "nas.local", 2222), "match", "ssh-keygen -H output matches");
    }
    ok("known_hosts matching: ports, hashed names, patterns, negation, revoked and CA lines");
  }

  const harness = {
    connects: [],
    prompts: [],
    statuses: [],
    files: new Map(),
    serverKey: key,
    hosts: {
      nas: { id: "nas", host: "nas.local", port: 22, username: "dev", source: "manual" },
      vps: { id: "vps", host: "203.0.113.7", port: 2222, username: "dev", source: "manual" },
      box: { id: "box", host: "box", port: 22, username: "dev", source: "codara-cloud", hostKeyAlias: "codara-box:b1", codaraBoxId: "b1" },
      aliased: { id: "aliased", host: "10.0.0.9", port: 2200, username: "dev", source: "ssh-config", hostKeyAlias: "builder" },
    },
  };
  globalThis.__codaraHostKeyHarness = harness;
  delete process.env.SSH_AUTH_SOCK;
  const conns = await bundle("src/main/remote/connections.ts", [connectionStubs()], "connections.cjs");
  const KNOWN = "/codara-home/spark-known-hosts.json";
  const stored = () => JSON.parse(harness.files.get(KNOWN) ?? "{}");
  let confirm = false;
  let answer = null;
  conns.setHostKeyConfirmation(async () => confirm);
  conns.setStatusSender((s) => harness.statuses.push(s));
  const closed = [];
  conns.setHostKeyPromptSender((request) => {
    harness.prompts.push(request);
    if (answer === "hold") return;
    setImmediate(() => conns.answerHostKeyPrompt({ requestId: request.requestId, trust: answer }));
  });
  conns.setHostKeyPromptClosedSender((requestId) => closed.push(requestId));
  const connect = async (hostId) => {
    const conn = await conns.getConnection(hostId);
    try {
      await conn.ensure();
    } catch {
      /* the status says why */
    }
    return conns.getConnectionStatus(hostId);
  };
  const reset = () => {
    for (const id of Object.keys(harness.hosts)) conns.disconnectHost(id);
    harness.files.clear();
    harness.prompts.length = 0;
    harness.connects.length = 0;
    harness.serverKey = key;
    harness.unreachable = false;
    closed.length = 0;
  };

  {
    const status = await connect("nas");
    assert.equal(status.state, "connected");
    assert.equal(harness.prompts.length, 0);
    assert.equal(stored()["nas.local:22"], keys.storedFingerprint(key));
    assert.equal(harness.connects[0].readyTimeout, 20_000);
    ok("confirmation off: a new key is trusted on first use, as before");
  }

  {
    reset();
    confirm = true;
    harness.files.set("/home/me/.ssh/known_hosts", `nas.local ssh-ed25519 ${b64}\n`);
    const status = await connect("nas");
    assert.equal(status.state, "connected");
    assert.equal(harness.prompts.length, 0, "a key the user's ssh already trusts is not asked about");
    assert.equal(stored()["nas.local:22"], keys.storedFingerprint(key));

    reset();
    answer = true;
    const asked = await connect("vps");
    assert.equal(asked.state, "connected");
    assert.equal(harness.prompts.length, 1);
    assert.deepEqual(
      { ...harness.prompts[0], requestId: undefined },
      { requestId: undefined, hostId: "vps", hostLabel: "203.0.113.7:2222", keyType: "ssh-ed25519", fingerprint: keys.sshFingerprint(key) },
    );
    assert.equal(harness.connects[0].readyTimeout, 5 * 60_000, "the handshake waits while the user reads");
    assert.equal(stored()["203.0.113.7:2222"], keys.storedFingerprint(key));
    await connect("vps");
    assert.equal(harness.prompts.length, 1, "asked once, not on every connect");

    reset();
    answer = false;
    const refused = await connect("vps");
    assert.equal(refused.state, "error");
    assert.match(refused.error, /was not trusted/);
    assert.equal(harness.connects.length, 1, "no password round after a refused key");
    assert.deepEqual(stored(), {});

    // A pane reconnecting on its own (quiet) never asks about a key.
    reset();
    answer = true;
    const quietError = await (await conns.getConnection("vps")).ensure({ quiet: true }).then(() => null, (e) => e);
    assert.ok(quietError, "a quiet connect to a machine with an unknown key fails");
    assert.equal(harness.prompts.length, 0, "and never asks about the key");
    assert.deepEqual(stored(), {});

    reset();
    harness.files.set("/home/me/.ssh/known_hosts", `@revoked nas.local ssh-ed25519 ${b64}\n`);
    const revoked = await connect("nas");
    assert.equal(revoked.state, "error");
    assert.match(revoked.error, /revoked/);
    assert.equal(harness.prompts.length, 0);

    reset();
    const box = await connect("box");
    assert.equal(box.state, "connected");
    assert.equal(harness.prompts.length, 0, "Codara Cloud boxes keep trust on first use");
    ok("confirmation on: known_hosts first, then the user; refusing or a revoked key never connects");
  }

  {
    reset();
    confirm = true;
    harness.files.set(KNOWN, JSON.stringify({ "nas.local:22": keys.storedFingerprint(other) }));
    harness.statuses.length = 0;
    const changed = await connect("nas");
    assert.equal(changed.state, "error");
    assert.match(changed.error, /changed since Codara last connected/);
    assert.deepEqual(changed.hostKeyChange, {
      hostLabel: "nas.local:22",
      previousFingerprint: keys.sshFingerprint(other),
      newFingerprint: keys.sshFingerprint(key),
      keyType: "ssh-ed25519",
    });
    assert.ok(harness.statuses.some((s) => s.state === "error" && s.hostKeyChange), "the broadcast carries it too");
    assert.equal(harness.prompts.length, 0, "a changed key is never a first-use question");
    const shown = changed.hostKeyChange.newFingerprint;
    assert.equal(await conns.trustChangedHostKey("vps", shown), false, "nothing to trust on another host");
    assert.equal(await conns.trustChangedHostKey("nas", shown), true);
    assert.equal(stored()["nas.local:22"], keys.storedFingerprint(key));
    const after = await connect("nas");
    assert.equal(after.state, "connected");
    assert.equal(after.hostKeyChange, undefined);

    reset();
    confirm = false;
    harness.files.set(KNOWN, JSON.stringify({ "nas.local:22": keys.storedFingerprint(other) }));
    const legacy = await connect("nas");
    assert.equal(legacy.state, "error");
    assert.match(legacy.error, /possible MITM/);
    assert.equal(legacy.hostKeyChange, undefined);
    ok("a changed key is refused with both fingerprints, and trusting it replaces only that entry");
  }

  {
    reset();
    confirm = true;
    answer = true;
    harness.files.set("/home/me/.ssh/known_hosts", `nas.local ssh-ed25519 ${other.toString("base64")}\n`);
    const mismatch = await connect("nas");
    assert.equal(mismatch.state, "error");
    assert.equal(harness.prompts.length, 0, "a key known_hosts contradicts is never a first-use question");
    assert.match(mismatch.error, /changed/);
    assert.deepEqual(mismatch.hostKeyChange, {
      hostLabel: "nas.local:22",
      previousFingerprint: keys.sshFingerprint(other),
      newFingerprint: keys.sshFingerprint(key),
      keyType: "ssh-ed25519",
      listedBy: "known_hosts",
    });
    assert.deepEqual(stored(), {});
    assert.equal(await conns.trustChangedHostKey("nas", mismatch.hostKeyChange.newFingerprint), true);
    assert.equal(stored()["nas.local:22"], keys.storedFingerprint(key));
    assert.equal((await connect("nas")).state, "connected");
    ok("a key that disagrees with ~/.ssh/known_hosts is refused as changed, with the listed key's fingerprint");
  }

  {
    reset();
    confirm = true;
    answer = true;
    const asked = await connect("aliased");
    assert.equal(asked.state, "connected");
    assert.equal(harness.prompts.length, 1, "a HostKeyAlias host is asked about like any other");
    assert.equal(harness.prompts[0].hostLabel, "builder");
    assert.equal(harness.connects[0].readyTimeout, 5 * 60_000);
    assert.equal(stored().builder, keys.storedFingerprint(key));

    reset();
    harness.files.set("/home/me/.ssh/known_hosts", `builder ssh-ed25519 ${b64}\n`);
    assert.equal((await connect("aliased")).state, "connected");
    assert.equal(harness.prompts.length, 0, "known_hosts is read by the alias");

    reset();
    answer = false;
    harness.files.set("/home/me/.ssh/known_hosts", `[builder]:2200 ssh-ed25519 ${b64}\n[10.0.0.9]:2200 ssh-ed25519 ${b64}\n`);
    assert.equal((await connect("aliased")).state, "error");
    assert.equal(harness.prompts.length, 1, "the alias is looked up with no port, never the real address");

    reset();
    harness.files.set("/home/me/.ssh/known_hosts", `builder ssh-ed25519 ${other.toString("base64")}\n`);
    const changed = await connect("aliased");
    assert.equal(changed.state, "error");
    assert.equal(changed.hostKeyChange?.previousFingerprint, keys.sshFingerprint(other));
    ok("HostKeyAlias hosts from ~/.ssh/config are confirmed, matched by the alias as OpenSSH does");
  }

  {
    reset();
    confirm = true;
    harness.files.set(KNOWN, JSON.stringify({ "nas.local:22": keys.storedFingerprint(other) }));
    const first = await connect("nas");
    // Another key arrives after the card was drawn: trusting must not take it.
    const third = wireKey("ssh-ed25519", randomBytes(32));
    harness.serverKey = third;
    await connect("nas");
    assert.equal(await conns.trustChangedHostKey("nas", first.hostKeyChange.newFingerprint), false);
    assert.equal(stored()["nas.local:22"], keys.storedFingerprint(other), "nothing trusted");

    harness.serverKey = key;
    const shown = (await connect("nas")).hostKeyChange.newFingerprint;
    conns.disconnectHost("nas");
    assert.equal(await conns.trustChangedHostKey("nas", shown), false, "a disconnect forgets the offer");

    await connect("nas");
    conns.forgetChangedHostKey("nas");
    assert.equal(await conns.trustChangedHostKey("nas", shown), false, "editing or removing the host forgets it");
    assert.equal(stored()["nas.local:22"], keys.storedFingerprint(other));
    ok("Trust the new key trusts only the key the card showed, until the host is disconnected or edited");
  }

  {
    reset();
    confirm = true;
    answer = true;
    await connect("vps");
    assert.deepEqual(closed, [harness.prompts[0].requestId], "an answered prompt is closed in every window");

    reset();
    answer = "hold";
    const pending = connect("vps");
    while (harness.prompts.length === 0) await new Promise((r) => setImmediate(r));
    conns.disconnectHost("vps");
    await pending;
    assert.deepEqual(closed, [harness.prompts[0].requestId], "a cancelled prompt is closed");

    reset();
    conns.setHostKeyTimeoutsForTests({ promptMs: 20 });
    const expired = await connect("vps");
    assert.equal(expired.state, "error");
    assert.deepEqual(closed, [harness.prompts[0].requestId], "a prompt nobody answered is closed");
    ok("a host-key prompt that ends in any way is reported closed");
  }

  {
    reset();
    confirm = true;
    harness.unreachable = true;
    conns.setHostKeyTimeoutsForTests({ reachMs: 30 });
    const started = Date.now();
    const down = await Promise.race([
      connect("vps"),
      new Promise((resolve) => setTimeout(() => resolve({ state: "still waiting" }), 2_000)),
    ]);
    assert.equal(down.state, "error", "a machine that never answers fails on the connect timeout");
    assert.match(down.error, /did not answer|timed out/i);
    assert.ok(Date.now() - started < 1_500);
    conns.setHostKeyTimeoutsForTests({ reachMs: 20_000, promptMs: 5 * 60_000 });
    ok("a new machine that is down fails after the connect timeout, not the prompt's five minutes");
  }

  reset();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
