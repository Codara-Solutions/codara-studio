#!/usr/bin/env node
"use strict";

// ~/.ssh/config reading (src/main/remote/ssh-hosts.ts): Include (absolute,
// ~, relative to ~/.ssh, globs, cycles, depth), ProxyCommand and
// HostKeyAlias, the refusal of unsafe %h/%r/%n values at connect time, and
// that only main can give a host a proxy. Ports outside 1 to 65535 drop the
// host (ssh refuses them too), and UserKnownHostsFile / GlobalKnownHostsFile
// are read for the host-key check, never from a host the renderer saved.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-ssh-include-"));
const HOME = path.join(TMP, "home");
const STATE = path.join(TMP, "state");
fs.mkdirSync(path.join(HOME, ".ssh", "conf.d"), { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
// os.homedir() reads these before anything else.
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

function write(rel, text) {
  const file = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function stubs() {
  const sources = {
    "../fs-atomic": `
      import { promises as fs } from "node:fs";
      export async function writeFileAtomic(file, text) { await fs.writeFile(file, text); }
    `,
    "../codara-home": `export function codaraHome() { return ${JSON.stringify(STATE)}; }`,
  };
  return {
    name: "ssh-include-stubs",
    setup(build) {
      for (const specifier of Object.keys(sources)) {
        const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
          path: specifier,
          namespace: "ssh-include",
        }));
      }
      build.onLoad({ filter: /.*/, namespace: "ssh-include" }, (args) => ({
        contents: sources[args.path],
        loader: "js",
        resolveDir: ROOT,
      }));
    },
  };
}

async function load(name, entry) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [stubs()],
    logLevel: "silent",
  });
  return require(outfile);
}

const byId = (hosts, id) => hosts.find((h) => h.id === id);

async function testInclude(hosts) {
  write(
    ".ssh/config",
    [
      "# first line",
      "Include conf.d/*.conf",
      "Include ~/extra/tilde.conf",
      `Include ${path.join(HOME, "abs", "absolute.conf")} "${path.join(HOME, "abs", "quoted.conf")}"`,
      "Include missing/*.conf",
      "Include cycle-a.conf",
      "Host direct",
      "  HostName direct.example",
      "",
    ].join("\n"),
  );
  write(".ssh/conf.d/10-a.conf", "Host from-glob-a\n  HostName a.example\n  User ana\n");
  write(".ssh/conf.d/20-b.conf", "Host from-glob-b\n  HostName b.example\n  Port 2200\n");
  write(".ssh/conf.d/ignored.txt", "Host not-included\n  HostName no.example\n");
  write("extra/tilde.conf", "Host from-tilde\n  HostName t.example\n");
  write("abs/absolute.conf", "Host from-absolute\n  HostName abs.example\n");
  write("abs/quoted.conf", "Host from-quoted\n  HostName q.example\n");
  // cycle-a includes cycle-b which includes cycle-a again
  write(".ssh/cycle-a.conf", "Include cycle-b.conf\nHost cycle-a\n  HostName ca.example\n");
  write(".ssh/cycle-b.conf", "Include cycle-a.conf\nHost cycle-b\n  HostName cb.example\n");

  const list = await hosts.readSshConfigHosts();
  const ids = list.map((h) => h.id).sort();
  assert.deepEqual(ids, [
    "cycle-a",
    "cycle-b",
    "direct",
    "from-absolute",
    "from-glob-a",
    "from-glob-b",
    "from-quoted",
    "from-tilde",
  ]);
  assert.equal(byId(list, "from-glob-a").username, "ana");
  assert.equal(byId(list, "from-glob-b").port, 2200);
}

async function testDepthLimit(hosts) {
  // A chain of 20 files: the head is read, the tail beyond depth 16 is not.
  for (let i = 0; i < 20; i += 1) {
    write(
      `.ssh/chain-${i}.conf`,
      `Host chain-${i}\n  HostName c${i}.example\n${i < 19 ? `Include chain-${i + 1}.conf\n` : ""}`,
    );
  }
  write(".ssh/config", "Include chain-0.conf\n");
  const list = await hosts.readSshConfigHosts();
  assert(byId(list, "chain-0"), "chain head must be read");
  assert(byId(list, "chain-15"), "depth 16 is still read");
  assert(!byId(list, "chain-16"), "depth 17 is not read");
  assert(!byId(list, "chain-19"), "includes beyond depth 16 must be ignored");
}

async function testProxyFields(hosts, proxy) {
  write(
    ".ssh/config",
    [
      "Host codara-dev",
      "  User codara",
      "  ProxyCommand '/opt/my tools/codaracloud' ssh-proxy '6f1c' --profile 'default'",
      "  HostKeyAlias codara-box.6f1c",
      "Host plain",
      "  HostName plain.example",
      "  ProxyCommand none",
      "Host jump",
      "  HostName jump.example",
      "  ProxyCommand ssh -W %h:%p bastion",
      "",
    ].join("\n"),
  );
  const list = await hosts.readSshConfigHosts();
  const dev = byId(list, "codara-dev");
  assert.equal(dev.proxyCommandTemplate, "'/opt/my tools/codaracloud' ssh-proxy '6f1c' --profile 'default'");
  assert.equal(dev.hostKeyAlias, "codara-box.6f1c");
  assert.equal(byId(list, "plain").proxyCommandTemplate, undefined);

  const inv = proxy.resolveProxyInvocation(byId(list, "jump"), "linux");
  assert.deepEqual(inv, { file: "/bin/sh", args: ["-c", "ssh -W jump.example:22 bastion"] });

  // A config whose HostName smuggles shell syntax is refused at connect time,
  // not at read time, and only for the tokens it substitutes.
  write(
    ".ssh/config",
    [
      "Host evil",
      "  HostName evil.example;touch${IFS}/tmp/pwned",
      "  ProxyCommand nc %h %p",
      "Host evil-user",
      "  HostName ok.example",
      "  User x$(id)",
      "  ProxyCommand nc %r@%h",
      "Host fine-user",
      "  HostName ok.example",
      "  User x$(id)",
      "  ProxyCommand nc %h",
      "",
    ].join("\n"),
  );
  const evil = await hosts.readSshConfigHosts();
  assert.throws(() => proxy.resolveProxyInvocation(byId(evil, "evil")), /not allowed/);
  assert.throws(() => proxy.resolveProxyInvocation(byId(evil, "evil-user")), /not allowed/);
  assert.deepEqual(proxy.resolveProxyInvocation(byId(evil, "fine-user"), "linux"), {
    file: "/bin/sh",
    args: ["-c", "nc ok.example"],
  });
}

async function testPortsAndKnownHostsFiles(hosts) {
  write(
    ".ssh/config",
    [
      "Host custom",
      "  HostName c.example",
      '  UserKnownHostsFile ~/.ssh/other_known "/srv/two known"',
      "  GlobalKnownHostsFile /etc/ssh/custom_global",
      "Host nofile",
      "  HostName n.example",
      "  UserKnownHostsFile none",
      "Host default-files",
      "  HostName d.example",
      "Host too-big",
      "  HostName b.example",
      "  Port 99999",
      "Host negative",
      "  HostName m.example",
      "  Port -22",
      "Host zero",
      "  HostName z.example",
      "  Port 0",
      "Host good",
      "  HostName g.example",
      "  Port 2222",
      "",
    ].join("\n"),
  );
  const list = await hosts.readSshConfigHosts();
  const ids = list.map((h) => h.id);
  for (const bad of ["too-big", "negative", "zero"]) assert.ok(!ids.includes(bad), `${bad}: a port ssh refuses drops the host`);
  assert.equal(byId(list, "good").port, 2222);
  const custom = byId(list, "custom");
  assert.deepEqual(custom.userKnownHostsFiles, [path.join(HOME, ".ssh", "other_known"), "/srv/two known"]);
  assert.deepEqual(custom.globalKnownHostsFiles, ["/etc/ssh/custom_global"]);
  assert.deepEqual(byId(list, "nofile").userKnownHostsFiles, [], "none reads no file");
  assert.equal(byId(list, "default-files").userKnownHostsFiles, undefined, "unset keeps ssh's defaults");
}

async function testOnlyMainSetsProxy(hosts) {
  write(".ssh/config", "");
  const forged = {
    id: "forged",
    host: "h.example",
    port: 22,
    username: "me",
    source: "manual",
    proxyCommand: ["/bin/touch", "/tmp/pwned"],
    proxyCommandTemplate: "touch /tmp/pwned",
    codaraBoxId: "6f1c0000-0000-4000-8000-000000000000",
    hostKeyAlias: "x",
    userKnownHostsFiles: ["/tmp/attacker_known_hosts"],
    globalKnownHostsFiles: ["/tmp/attacker_known_hosts"],
  };
  const saved = await hosts.saveManualHost(forged);
  const entry = byId(saved, "forged");
  for (const field of [
    "proxyCommand",
    "proxyCommandTemplate",
    "codaraBoxId",
    "hostKeyAlias",
    "userKnownHostsFiles",
    "globalKnownHostsFiles",
  ]) {
    assert.equal(entry[field], undefined, `${field} must not survive saveManualHost`);
  }
  await assert.rejects(hosts.saveCodaraHost({ ...forged, source: "manual" }), /Malformed/);
  await assert.rejects(
    hosts.saveCodaraHost({ ...forged, source: "codara-cloud", proxyCommand: undefined }),
    /Malformed/,
  );

  const boxHost = {
    id: "codara-dev",
    host: "codara-dev",
    port: 22,
    username: "codara",
    source: "codara-cloud",
    proxyCommand: ["/opt/codaracloud", "ssh-proxy", "6f1c0000-0000-4000-8000-000000000000"],
    hostKeyAlias: "codara-box.6f1c0000-0000-4000-8000-000000000000",
    codaraBoxId: "6f1c0000-0000-4000-8000-000000000000",
  };
  await hosts.saveCodaraHost(boxHost);
  const again = byId(await hosts.listHosts(), "codara-dev");
  assert.deepEqual(again, boxHost, "a Codara host round-trips through the registry");
  // A hand-edited file cannot turn a manual entry into a proxy.
  const file = path.join(STATE, "spark-remote-hosts.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.push({ ...forged, id: "hand-edited" });
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.equal(byId(await hosts.listHosts(), "hand-edited").proxyCommand, undefined);
}

(async () => {
  const hosts = await load("ssh-hosts", "src/main/remote/ssh-hosts.ts");
  const proxy = await load("proxy-command", "src/main/remote/proxy-command.ts");
  await testInclude(hosts);
  await testDepthLimit(hosts);
  await testProxyFields(hosts, proxy);
  await testPortsAndKnownHostsFiles(hosts);
  await testOnlyMainSetsProxy(hosts);
  console.log("ssh config include: ok");
})()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
