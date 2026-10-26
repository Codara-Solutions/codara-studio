#!/usr/bin/env node
"use strict";

// ~/.ssh/config reading (src/main/remote/ssh-hosts.ts): Include (absolute,
// ~, relative to ~/.ssh, globs; a loop or more than 16 levels refuses), ProxyCommand and
// HostKeyAlias, the refusal of unsafe %h/%r/%n values at connect time, and
// that only main can give a host a proxy. Ports outside 1 to 65535 drop the
// host (ssh refuses them too), and UserKnownHostsFile / GlobalKnownHostsFile
// are read for the host-key check, never from a host the renderer saved;
// UserKnownHostsFile expands ${VAR} and every token ssh_config(5) allows it
// (%% %C %d %h %i %j %k %L %l %n %p %r %u) in one pass, with the values
// `ssh -G` prints (OpenSSH 9.6): %h and a HostKeyAlias lowercased, %j the
// last ProxyJump hop's host, %r the account name, and HostName's own %h.
// Keywords ignore case. A value ssh cannot expand (unknown token, unset
// variable) makes the host refuse to connect, as ssh does, instead of
// dropping the file. RevokedHostKeys expands like UserKnownHostsFile, and
// /etc/ssh/ssh_config (with its Includes) gives what ~/.ssh/config does not
// set. Both apply to config hosts and to any other (manual, Codara box),
// matched by the name Codara connects to.

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

// ssh reads ~/.ssh/config and its Includes only when nobody but their owner
// can write them (test-ssh-config-match covers the other modes).
function write(rel, text) {
  const file = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o600);
  return file;
}

function stubs() {
  const sources = {
    "../fs-atomic": `
      import { promises as fs } from "node:fs";
      export async function writeFileAtomic(file, text) { await fs.writeFile(file, text); }
    `,
    "../codara-home": `export function codaraHome() { return ${JSON.stringify(STATE)}; }`,
    "../path-reconstruction": `export async function getEnrichedEnv() { return process.env; }`,
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
  const list = await hosts.readSshConfigHosts();
  const ids = list.map((h) => h.id).sort();
  assert.deepEqual(ids, [
    "direct",
    "from-absolute",
    "from-glob-a",
    "from-glob-b",
    "from-quoted",
    "from-tilde",
  ]);
  assert.equal(byId(list, "from-glob-a").username, "ana");
  assert.equal(byId(list, "from-glob-b").port, 2200);
  for (const host of list) assert.equal(host.sshConfigRefusal, undefined, `${host.id}: a missing include is not an error`);

  // cycle-a includes cycle-b which includes cycle-a again: ssh stops, so
  // every host is listed with the reason.
  write(".ssh/config", "Include cycle-a.conf\nHost direct\n  HostName direct.example\n");
  write(".ssh/cycle-a.conf", "Include cycle-b.conf\nHost cycle-a\n  HostName ca.example\n");
  write(".ssh/cycle-b.conf", "Include cycle-a.conf\nHost cycle-b\n  HostName cb.example\n");
  const cycle = await hosts.readSshConfigHosts();
  assert.deepEqual(cycle.map((h) => h.id), ["cycle-a", "cycle-b", "direct"]);
  for (const host of cycle) {
    assert.match(host.sshConfigRefusal, /^~\/\.ssh\/cycle-b\.conf line 1 includes ~\/\.ssh\/cycle-a\.conf inside itself/, host.id);
  }
}

async function testDepthLimit(hosts) {
  // A chain of 20 files: the head is read, the tail beyond depth 16 is not,
  // and ssh stops there, so the hosts carry the reason.
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
  assert.match(byId(list, "chain-0").sshConfigRefusal, /^~\/\.ssh\/chain-15\.conf line 3 nests Includes more than 16 levels deep/);
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

async function testKnownHostsTokens(hosts) {
  process.env.CODARA_TEST_KH = "/srv/kh";
  delete process.env.CODARA_TEST_UNSET;
  write(
    ".ssh/config",
    [
      "Host tok",
      "  HostName t.example",
      '  UserKnownHostsFile %d/.ssh/kh_%h ${CODARA_TEST_KH}/x /tmp/%u_%k /tmp/100%%',
      "Host aliased-tok",
      "  HostName a.example",
      "  HostKeyAlias keyname",
      "  UserKnownHostsFile /tmp/%k",
      "",
    ].join("\n"),
  );
  const list = await hosts.readSshConfigHosts();
  const user = os.userInfo().username;
  assert.deepEqual(
    byId(list, "tok").userKnownHostsFiles,
    [path.join(HOME, ".ssh", "kh_t.example"), "/srv/kh/x", `/tmp/${user}_tok`, "/tmp/100%"],
    "tokens and variables expand",
  );
  assert.deepEqual(byId(list, "aliased-tok").userKnownHostsFiles, ["/tmp/keyname"], "%k is the HostKeyAlias when set");

  write(
    ".ssh/config",
    [
      "Host all-tokens",
      "  HostName r.example",
      "  Port 2222",
      "  User bob",
      "  UserKnownHostsFile ~/.ssh/kh/%n_%p /tmp/%r@%l /tmp/%L /tmp/%i /tmp/%C /tmp/j%j",
      "Host jumpy",
      "  HostName q.example",
      "  User carol",
      "  ProxyJump bastion.example",
      "  UserKnownHostsFile /tmp/j%j /tmp/%C",
      "",
    ].join("\n"),
  );
  const tokens = await hosts.readSshConfigHosts();
  const full = os.hostname();
  const short = full.split(".")[0];
  const uid = String(os.userInfo().uid);
  const hash = (text) => require("node:crypto").createHash("sha1").update(text).digest("hex");
  assert.deepEqual(byId(tokens, "all-tokens").userKnownHostsFiles, [
    path.join(HOME, ".ssh", "kh", "all-tokens_2222"),
    `/tmp/bob@${full}`,
    `/tmp/${short}`,
    `/tmp/${uid}`,
    `/tmp/${hash(`${full}r.example2222bob`)}`,
    "/tmp/j",
  ], "%n %p %r %l %L %i %C expand, and %j is empty without ProxyJump");
  assert.deepEqual(byId(tokens, "jumpy").userKnownHostsFiles, [
    "/tmp/jbastion.example",
    `/tmp/${hash(`${full}q.example22carolbastion.example`)}`,
    `/tmp/${hash(`${full}q.example22carol`)}`,
  ], "%j is the ProxyJump, and %C hashes %l%h%p%r%j (and %l%h%p%r, as ssh before 9.6)");
}

// Each expected value is what `ssh -G` printed for the same config.
async function testTokensAsSshExpandsThem(hosts) {
  process.env.CODARA_TEST_PCT = "a%b";
  const realUser = process.env.USER;
  process.env.USER = "not-the-account-name";
  try {
    write(
      ".ssh/config",
      [
        "Host KeyAlHost",
        "  HostName %h.Example.COM",
        "  HostKeyAlias KeyAl",
        "  ProxyJump alice@Bastion.example:2200",
        "  UserKnownHostsFile /x/k_%k/h_%h/j_%j/n_%n/r_%r/C_%C",
        "Host multi",
        "  HostName Multi.Example",
        "  ProxyJump a.example,bob@B.Example:2222",
        "  UserKnownHostsFile /x/j_%j/C_%C",
        "Host v6",
        "  ProxyJump carol@[fe80::1]:2022",
        "  UserKnownHostsFile /x/j_%j",
        "Host older",
        "  HostName o.example",
        "  User u",
        "  ProxyJump b.example",
        "  UserKnownHostsFile /x/C_%C",
        "Host onepass",
        "  UserKnownHostsFile /x/${CODARA_TEST_PCT}/%%h",
        "Host lower",
        "  hostname L.example",
        "  userknownhostsfile /x/%h",
        "Host MixedCase",
        "  HostName Mixed.Example",
        "  UserKnownHostsFile /x/k_%k",
        "Host literal",
        "  HostName 100%%.%h",
        "Host badname",
        "  HostName a%Zb",
        "",
      ].join("\n"),
    );
    const list = await hosts.readSshConfigHosts();
    const user = os.userInfo().username;
    const full = os.hostname();
    const hash = (text) => require("node:crypto").createHash("sha1").update(text).digest("hex");
    const keyAl = byId(list, "KeyAlHost");
    assert.equal(keyAl.host, "KeyAlHost.Example.COM", "HostName's %h is the alias");
    assert.equal(keyAl.username, user, "with no User, the account name, not $USER");
    assert.deepEqual(keyAl.userKnownHostsFiles, [
      `/x/k_keyal/h_keyalhost.example.com/j_Bastion.example/n_KeyAlHost/r_${user}/C_${hash(`${full}keyalhost.example.com22${user}Bastion.example`)}`,
    ], "%k and %h lowercased, %j the jump host alone, %n as written");
    assert.deepEqual(byId(list, "multi").userKnownHostsFiles, [
      `/x/j_B.Example/C_${hash(`${full}multi.example22${user}B.Example`)}`,
    ], "%j is the last hop");
    assert.deepEqual(byId(list, "v6").userKnownHostsFiles, ["/x/j_fe80::1"]);
    assert.deepEqual(byId(list, "older").userKnownHostsFiles, [
      `/x/C_${hash(`${full}o.example22ub.example`)}`,
      `/x/C_${hash(`${full}o.example22u`)}`,
    ]);
    assert.deepEqual(byId(list, "onepass").userKnownHostsFiles, ["/x/a%b/%h"], "a variable's value is not expanded again");
    assert.equal(byId(list, "lower").host, "L.example", "keywords ignore case");
    assert.deepEqual(byId(list, "lower").userKnownHostsFiles, ["/x/l.example"]);
    assert.deepEqual(byId(list, "MixedCase").userKnownHostsFiles, ["/x/k_MixedCase"], "without HostKeyAlias, %k is the alias as written");
    assert.equal(byId(list, "literal").host, "100%.literal");
    assert.match(byId(list, "badname").sshConfigRefusal, /^HostName "a%Zb" uses %Z, which ssh does not accept there$/);
  } finally {
    if (realUser === undefined) delete process.env.USER;
    else process.env.USER = realUser;
  }
}

// ssh refuses to connect when a value cannot be expanded (`ssh -G` prints
// "unknown key %Z", "env var ${X} has no value", ...); Codara refuses too.
async function testRefusalsAndRevokedHostKeys(hosts) {
  delete process.env.CODARA_TEST_UNSET;
  write(
    ".ssh/config",
    [
      "Host bad-token",
      "  UserKnownHostsFile /tmp/ok /tmp/%Z",
      "Host unset-var",
      "  UserKnownHostsFile ${CODARA_TEST_UNSET}/y",
      "Host lone",
      "  UserKnownHostsFile /tmp/a%",
      "Host empty-var",
      "  UserKnownHostsFile /tmp/${}",
      "Host open-var",
      "  UserKnownHostsFile /tmp/${HOME",
      "Host revoked",
      "  HostName R.example",
      "  RevokedHostKeys ~/.ssh/revoked_%h",
      "Host revoked-none",
      "  RevokedHostKeys none",
      "Host revoked-bad",
      "  RevokedHostKeys /tmp/%Z",
      "",
    ].join("\n"),
  );
  const list = await hosts.readSshConfigHosts();
  const refusals = {
    "bad-token": 'UserKnownHostsFile "/tmp/%Z" uses %Z, which ssh does not accept there',
    "unset-var": 'UserKnownHostsFile "${CODARA_TEST_UNSET}/y" uses ${CODARA_TEST_UNSET}, which is not set',
    lone: 'UserKnownHostsFile "/tmp/a%" ends with a lone %',
    "empty-var": 'UserKnownHostsFile "/tmp/${}" has an empty ${}',
    "open-var": 'UserKnownHostsFile "/tmp/${HOME" has a ${ with no closing }',
    "revoked-bad": 'RevokedHostKeys "/tmp/%Z" uses %Z, which ssh does not accept there',
  };
  for (const [id, refusal] of Object.entries(refusals)) {
    const host = byId(list, id);
    assert.equal(host.sshConfigRefusal, refusal, id);
    assert.equal(host.userKnownHostsFiles, undefined, `${id}: no file is read in its place`);
    assert.deepEqual(await hosts.knownHostsSettings(host), { refusal }, id);
  }
  assert.deepEqual(byId(list, "revoked").revokedHostKeys, [[path.join(HOME, ".ssh", "revoked_r.example")]]);
  assert.equal(byId(list, "revoked-none").revokedHostKeys, undefined, "none: no file");
  assert.deepEqual(await hosts.knownHostsSettings(byId(list, "revoked")), {
    files: [
      path.join(HOME, ".ssh", "known_hosts"),
      path.join(HOME, ".ssh", "known_hosts2"),
      "/etc/ssh/ssh_known_hosts",
      "/etc/ssh/ssh_known_hosts2",
    ],
    revoked: [[path.join(HOME, ".ssh", "revoked_r.example")]],
  }, "ssh's default known_hosts files");
}

async function testSystemSshConfig(hosts) {
  const etc = path.join(TMP, "etc-ssh");
  fs.mkdirSync(path.join(etc, "ssh_config.d"), { recursive: true });
  const system = path.join(etc, "ssh_config");
  fs.writeFileSync(
    system,
    [
      "Include ssh_config.d/*.conf",
      "Host *",
      "  GlobalKnownHostsFile /etc/ssh/all_known",
      "  UserKnownHostsFile /etc/ssh/users/%r_%h",
      "  RevokedHostKeys /etc/ssh/revoked",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(etc, "ssh_config.d", "corp.conf"),
    ["Host *.corp", "  GlobalKnownHostsFile /etc/ssh/corp_known /etc/ssh/corp_known2", ""].join("\n"),
  );
  fs.chmodSync(path.join(etc, "ssh_config.d", "corp.conf"), 0o644);
  write(
    ".ssh/config",
    [
      "Host cfg",
      "  HostName NAS.corp",
      "  User dev",
      "Host own-file",
      "  HostName own.corp",
      "  UserKnownHostsFile ~/.ssh/own_known",
      "",
    ].join("\n"),
  );
  const manual = { id: "nas", host: "nas.corp", port: 22, username: "ops", source: "manual" };
  hosts.setSystemSshConfigPathForTests(system);
  try {
    assert.deepEqual(await hosts.knownHostsSettings(manual), {
      files: ["/etc/ssh/users/ops_nas.corp", "/etc/ssh/corp_known", "/etc/ssh/corp_known2"],
      revoked: [["/etc/ssh/revoked"]],
    }, "any host: an Include relative to /etc/ssh, first match wins, tokens expand");
    const list = await hosts.readSshConfigHosts();
    assert.deepEqual(await hosts.knownHostsSettings(byId(list, "cfg")), {
      files: ["/etc/ssh/users/dev_nas.corp", "/etc/ssh/all_known"],
      revoked: [["/etc/ssh/revoked"]],
    }, "a config host is matched by its alias, as ssh matches Host lines");
    assert.deepEqual(
      (await hosts.knownHostsSettings(byId(list, "own-file"))).files,
      [path.join(HOME, ".ssh", "own_known"), "/etc/ssh/all_known"],
      "~/.ssh/config wins over the system's",
    );

    // ssh reads ~/.ssh/config before the system's for any host, matched by
    // the name it connects to: a manual host and a Codara box too.
    write(
      ".ssh/config",
      [
        "Host nas.corp",
        "  UserKnownHostsFile ~/.ssh/corp_%h",
        "Host *",
        "  RevokedHostKeys ~/.ssh/revoked_global",
        "",
      ].join("\n"),
    );
    assert.deepEqual(await hosts.knownHostsSettings(manual), {
      files: [path.join(HOME, ".ssh", "corp_nas.corp"), "/etc/ssh/corp_known", "/etc/ssh/corp_known2"],
      revoked: [[path.join(HOME, ".ssh", "revoked_global")]],
    }, "~/.ssh/config wins for a manual host, the system's fills the rest");
    const box = {
      id: "codara-dev",
      host: "codara-dev",
      port: 22,
      username: "codara",
      source: "codara-cloud",
      hostKeyAlias: "codara-box.b1",
      codaraBoxId: "b1",
      proxyCommand: ["/opt/codaracloud", "ssh-proxy", "b1"],
    };
    assert.deepEqual((await hosts.knownHostsSettings(box)).revoked, [[path.join(HOME, ".ssh", "revoked_global")]], "a Codara box too");
    write(".ssh/config", "Host *\n  UserKnownHostsFile ~/.ssh/kh_%Z\n");
    assert.deepEqual(await hosts.knownHostsSettings(manual), {
      refusal: 'UserKnownHostsFile "~/.ssh/kh_%Z" uses %Z, which ssh does not accept there',
    }, "and ssh refuses a manual host whose ~/.ssh/config value it cannot expand");
    write(".ssh/config", "");

    fs.writeFileSync(system, "Host *.corp\n  GlobalKnownHostsFile none\n  UserKnownHostsFile /etc/%Z\n");
    assert.deepEqual(await hosts.knownHostsSettings(manual), {
      refusal: 'UserKnownHostsFile "/etc/%Z" uses %Z, which ssh does not accept there',
    }, "ssh refuses the system's value too");
    fs.writeFileSync(system, "Host *.corp\n  GlobalKnownHostsFile none\n");
    assert.deepEqual((await hosts.knownHostsSettings(manual)).files, [
      path.join(HOME, ".ssh", "known_hosts"),
      path.join(HOME, ".ssh", "known_hosts2"),
    ], "none reads no system file; unset keeps the user's defaults");
    fs.rmSync(system);
    assert.deepEqual((await hosts.knownHostsSettings(manual)).files, [
      path.join(HOME, ".ssh", "known_hosts"),
      path.join(HOME, ".ssh", "known_hosts2"),
      "/etc/ssh/ssh_known_hosts",
      "/etc/ssh/ssh_known_hosts2",
    ], "no system config: ssh's defaults");
  } finally {
    hosts.setSystemSshConfigPathForTests(path.join(TMP, "no-system-ssh-config"));
  }
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
    revokedHostKeys: [["/tmp/attacker_revoked"]],
    sshConfigRefusal: "forged",
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
    "revokedHostKeys",
    "sshConfigRefusal",
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
  // The machine's own /etc/ssh/ssh_config must not change what these expect.
  hosts.setSystemSshConfigPathForTests(path.join(TMP, "no-system-ssh-config"));
  const proxy = await load("proxy-command", "src/main/remote/proxy-command.ts");
  await testInclude(hosts);
  await testDepthLimit(hosts);
  await testProxyFields(hosts, proxy);
  await testPortsAndKnownHostsFiles(hosts);
  await testKnownHostsTokens(hosts);
  await testTokensAsSshExpandsThem(hosts);
  await testRefusalsAndRevokedHostKeys(hosts);
  await testSystemSshConfig(hosts);
  await testOnlyMainSetsProxy(hosts);
  console.log("ssh config include: ok");
})()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
