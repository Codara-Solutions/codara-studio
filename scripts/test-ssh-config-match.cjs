#!/usr/bin/env node
"use strict";

// Which ssh_config blocks apply to a host (src/main/remote/ssh-config-match.ts),
// for the known-hosts and RevokedHostKeys settings Codara reads before
// trusting a key. Each expectation is what `ssh -G` (OpenSSH 9.6) printed for
// the same config; when ssh is installed the user-config cases are checked
// against it again here. Match user tests the account Codara logs in as;
// Match host the HostName with %h expanded, ignoring case; `?` is exactly one
// character; an Include's Host lines end with its file; `Match final`,
// `canonical` and CanonicalizeHostname reread the config with the HostName.
// A Match criterion Codara cannot evaluate as ssh does (exec, localnetwork,
// unknown) refuses the host only when its block could set a known-hosts
// setting still unset; a line ssh cannot read refuses every host. Both name
// the file and line. An ordinary config (Host, Match host, Match final)
// resolves exactly as before.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-ssh-match-"));
const HOME = path.join(TMP, "home");
const STATE = path.join(TMP, "state");
fs.mkdirSync(path.join(HOME, ".ssh"), { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const SYSTEM = path.join(TMP, "ssh_config");
const ME = os.userInfo().username;
const HAS_SSH = spawnSync("ssh", ["-V"], { encoding: "utf8" }).status === 0;

async function load() {
  const sources = {
    "../fs-atomic": `
      import { promises as fs } from "node:fs";
      export async function writeFileAtomic(file, text) { await fs.writeFile(file, text); }
    `,
    "../codara-home": `export function codaraHome() { return ${JSON.stringify(STATE)}; }`,
  };
  const outfile = path.join(TMP, "ssh-hosts.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/remote/ssh-hosts.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
    plugins: [
      {
        name: "ssh-match-stubs",
        setup(build) {
          for (const specifier of Object.keys(sources)) {
            const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({ path: specifier, namespace: "stub" }));
          }
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents: sources[args.path],
            loader: "js",
            resolveDir: ROOT,
          }));
        },
      },
    ],
  });
  return require(outfile);
}

function writeConfigs(user, system = "") {
  fs.writeFileSync(path.join(HOME, ".ssh", "config"), user);
  fs.writeFileSync(SYSTEM, system);
}

/** `ssh -G` for this config alone: its revokedhostkeys, or "refused" when ssh would not run. */
function sshG(config, host, user) {
  const file = path.join(TMP, "ssh-g-config");
  fs.writeFileSync(file, config);
  const result = spawnSync("ssh", ["-G", "-F", file, ...(user ? ["-l", user] : []), host], { encoding: "utf8" });
  if (result.status !== 0) return "refused";
  const line = result.stdout.split("\n").find((l) => l.startsWith("revokedhostkeys "));
  return line ? [line.slice("revokedhostkeys ".length)] : null;
}

const manual = (host, username = "me") => ({ id: "m", host, port: 22, username, source: "manual" });

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ok  ${name}`);
};

// [name, ~/.ssh/config, host as typed, login (ssh -l), expected revoked list | null | refusal RegExp]
const MANUAL_CASES = [
  ["Match user tests the login, not the local account", "Match user root\n  RevokedHostKeys /r/root\n", "h1", "root", ["/r/root"]],
  ["Match user: the login wins over a User line", "Host *\n  User bob\nMatch user root\n  RevokedHostKeys /r\n", "h1", "root", ["/r"]],
  ["Match user is case-sensitive", "Match user ROOT\n  RevokedHostKeys /r\n", "h1", "root", null],
  ["Match user takes a pattern list", "Match user a,ro?t\n  RevokedHostKeys /r\n", "h1", "root", ["/r"]],
  ["Match localuser is the local account", `Match localuser ${ME}\n  RevokedHostKeys /r\n`, "h1", "root", ["/r"]],
  ["Host ? is exactly one character", "Host web?\n  RevokedHostKeys none\nHost *\n  RevokedHostKeys /r/q\n", "web", "me", ["/r/q"]],
  ["Host ? matches one character", "Host web?\n  RevokedHostKeys /r/one\nHost *\n  RevokedHostKeys /r/q\n", "web1", "me", ["/r/one"]],
  ["Match host ? is exactly one character", "Match host h?\n  RevokedHostKeys /r\n", "h", "me", null],
  ["Host patterns are case-sensitive", "Host Box.Example\n  RevokedHostKeys /r\n", "box.example", "me", null],
  ["Host takes no comma list", "Host a,h1\n  RevokedHostKeys /r\n", "h1", "me", null],
  ["Match host ignores case", "Match host H1\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["Match host sees HostName with %h", "Host h1\n  HostName %h.Example\nMatch host h1.example\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["Match originalhost sees the name as typed", "Host h1\n  HostName real\nMatch originalhost H1\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["Match !host", "Match !host other\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["Match !host on this host", "Match !host h1\n  RevokedHostKeys /r\n", "h1", "me", null],
  ["every criterion must match, even the same one twice", "Match host h2 host h1\n  RevokedHostKeys /r\n", "h1", "me", null],
  ["Match host=value", "Match host=h1\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["Match final rereads the config", "Match final host h1\n  RevokedHostKeys /r/fin\n", "h1", "me", ["/r/fin"]],
  ["Match canonical alone never matches", "Match canonical\n  RevokedHostKeys /r\n", "h1", "me", null],
  ["Match canonical matches on the final pass", "Match final host nomatch\n  User z\nMatch canonical\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["Match !final matches the first pass", "Match !final\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["the final pass matches Host lines against the lowercased HostName", "Host h1\n  HostName Real.Example\nHost real.example\n  RevokedHostKeys /r\nMatch final\n", "h1", "me", ["/r"]],
  ["CanonicalizeHostname yes rereads the config too", "CanonicalizeHostname yes\nHost h1\n  HostName real\nHost real\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["Match tagged", "Tag t\nMatch tagged t\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["Match all", "Match all\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["Match final all", "Match final all\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["the first value obtained wins", "Host h1\n  RevokedHostKeys /a\nHost *\n  RevokedHostKeys /b\n", "h1", "me", ["/a"]],
  // Criteria Codara cannot evaluate as ssh does.
  ["Match exec setting RevokedHostKeys", "Match exec \"true\"\n  RevokedHostKeys /r/exec\n", "h1", "me", /^~\/\.ssh\/config line 1 starts a "Match exec" block that sets RevokedHostKeys, and Codara cannot check "Match exec" the way ssh does\. Move RevokedHostKeys under a Host line or a Match host or Match user line, which Codara can check$/],
  ["Match !exec", "Match !exec false\n  RevokedHostKeys /r\n", "h1", "me", /line 1 starts a "Match !exec" block that sets RevokedHostKeys/],
  ["Match localnetwork", "Host h1\n  User u\nMatch localnetwork 0.0.0.0/0\n  UserKnownHostsFile /k\n", "h1", "me", /line 3 starts a "Match localnetwork" block that sets UserKnownHostsFile/],
  ["Match exec setting HostName where RevokedHostKeys depends on it", "Match exec true\n  HostName real\nMatch host real\n  RevokedHostKeys /r\n", "h1", "me", /line 1 starts a "Match exec" block that sets HostName/],
  ["Match exec ruled out by Match host on the same line", "Match host other exec true\n  RevokedHostKeys /r\nHost *\n  RevokedHostKeys /b\n", "h1", "me", ["/b"]],
  ["Match exec after RevokedHostKeys is set changes nothing", "Host *\n  RevokedHostKeys /a\nMatch exec true\n  RevokedHostKeys /b\n", "h1", "me", ["/a"]],
  ["Match exec setting only connection options", "Match exec true\n  IdentityFile /id\n  ProxyCommand nc %h %p\nHost *\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["CanonicalDomains may rename the host through DNS", "CanonicalizeHostname yes\nCanonicalDomains example.com\nHost *.example.com\n  RevokedHostKeys /r\n", "h1", "me", /^CanonicalizeHostname with CanonicalDomains lets ssh rename this host through DNS/],
  ["CanonicalDomains with a name that has too many dots", "CanonicalizeHostname yes\nCanonicalDomains example.com\nHost *\n  RevokedHostKeys /r\n", "a.b.example.org", "me", ["/r"]],
  // ssh refuses the whole file.
  ["a Match with no value", "Host *\n  RevokedHostKeys /r/all\nMatch user\n  User x\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 3 \(.+\)\. ssh will not connect anywhere until that line is fixed$/],
  ["'all' with another criterion", "Match all host h1\n  RevokedHostKeys /r\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 1 \('all' cannot be combined with other Match criteria\)/],
  ["an unclosed quote", "Host *\n  RevokedHostKeys /r\nMatch host \"h1\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 3/],
  ["a bad line in a block that does not apply", "Host other\n  RevokedHostKeys /r\nMatch user\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 3/],
  ["a keyword with no value", "Host other\n  RevokedHostKeys\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(RevokedHostKeys has no value\)\. ssh will not connect anywhere until that line is fixed$/],
  ["a keyword with = and no value", "Host *\n  HostKeyAlias=\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(HostKeyAlias has no value\)/],
  ["a keyword with an empty quoted value", "Host *\n  RevokedHostKeys \"\"\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(RevokedHostKeys has no value\)/],
  ["an empty quoted word in a list", "Host other\n  UserKnownHostsFile /a \"\"\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(UserKnownHostsFile has an empty value\)/],
  ["an empty User", "Host other\n  User \"\"\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(User has no value\)/],
  ["an empty word inside a ProxyCommand is a shell word", "Host other\n  ProxyCommand echo \"\"\nHost *\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  // ssh runs KnownHostsCommand and refuses what it prints as @revoked.
  ["KnownHostsCommand", "Host *\n  KnownHostsCommand /usr/local/bin/keys %H\n", "h1", "me", /^~\/\.ssh\/config line 2 sets KnownHostsCommand, which Codara does not run, so it cannot tell which keys that command trusts or revokes\. Remove KnownHostsCommand for this host, or set it to none, to connect from Codara$/],
  ["KnownHostsCommand none", "Host *\n  KnownHostsCommand none\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["KnownHostsCommand for another host", "Host other\n  KnownHostsCommand /bin/keys\n", "h1", "me", null],
  ["KnownHostsCommand under Match exec", "Match exec \"test -e /tmp/x\"\n  KnownHostsCommand /bin/keys\n", "h1", "me", /line 1 starts a "Match exec" block that sets KnownHostsCommand/],
  // Quotes, escapes and comments as ssh's argv_split reads them (OpenSSH 9.6).
  ["single quotes are stripped", "Host *\n  RevokedHostKeys '/r/x'\n", "h1", "me", ["/r/x"]],
  ["quotes join inside a word", "Host *\n  RevokedHostKeys /r/'a b'c\n", "h1", "me", ["/r/a bc"]],
  ["a backslash escapes a blank", "Host *\n  RevokedHostKeys /r/a\\ b\n", "h1", "me", ["/r/a b"]],
  ["keyword=value with quotes", "Host *\n  RevokedHostKeys='/r/q'\n", "h1", "me", ["/r/q"]],
  ["a quoted Host pattern", "Host 'h1'\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["a Match line keeps single quotes", "Match host 'h1'\n  RevokedHostKeys /r\n", "h1", "me", null],
  ["# inside a word is not a comment", "Host *\n  RevokedHostKeys /r/a#b\n", "h1", "me", ["/r/a#b"]],
  ["\"\" in a trailing comment", "Host *\n  IdentityFile /id # note \"\"\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["SetEnv FOO=\"\"", "Host *\n  SetEnv FOO=\"\"\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["SetEnv FOO=''", "Host *\n  SetEnv FOO=''\n  RevokedHostKeys /r\n", "h1", "me", ["/r"]],
  ["an empty single-quoted value", "Host other\n  UserKnownHostsFile ''\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(UserKnownHostsFile has no value\)/],
  ["an empty single-quoted word in a list", "Host *\n  GlobalKnownHostsFile /x ''\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(GlobalKnownHostsFile has an empty value\)/],
  ["HostKeyAlias ''", "Host *\n  HostKeyAlias ''\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(HostKeyAlias has no value\)/],
  ["a value that is only a comment", "Host *\n  RevokedHostKeys # none yet\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(RevokedHostKeys has no value\)/],
  ["Host with an empty pattern", "Host foo \"\"\n  RevokedHostKeys /r\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 1 \(Host has an empty value\)/],
  ["Host with an empty single-quoted pattern", "Host foo ''\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 1 \(Host has an empty value\)/],
  ["Match with an empty value", "Match host \"\"\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 1 \(Match host needs a value\)/],
  ["a quote left open", "Host *\n  RevokedHostKeys '/r\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(RevokedHostKeys has a quote that is not closed\)/],
  ["two values for RevokedHostKeys", "Host other\n  RevokedHostKeys /a /b\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(RevokedHostKeys has more than one value\)/],
  ["two values for HostName", "Host other\n  HostName a b\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(HostName has more than one value\)/],
  ["a keyword alone names it", "Host other\n  SendEnv\n", "h1", "me", /^ssh cannot read ~\/\.ssh\/config line 2 \(SendEnv has no value\)/],
];

async function testManualHosts(hosts) {
  for (const [name, config, host, login, expected] of MANUAL_CASES) {
    writeConfigs(config);
    const got = await hosts.knownHostsSettings(manual(host, login));
    if (expected instanceof RegExp) {
      assert.ok("refusal" in got, `${name}: refused (got ${JSON.stringify(got)})`);
      assert.match(got.refusal, expected, name);
    } else {
      assert.ok(!("refusal" in got), `${name}: not refused (${got.refusal})`);
      assert.deepEqual(got.revoked, expected, name);
    }
    // ssh -G neither runs exec nor KnownHostsCommand, nor resolves names.
    if (HAS_SSH && !/exec|localnetwork|CanonicalDomains|KnownHostsCommand/.test(config)) {
      const ssh = sshG(config, host, login);
      if (expected instanceof RegExp) assert.equal(ssh, "refused", `${name}: ssh refuses too`);
      else assert.deepEqual(ssh, expected, `${name}: as ssh -G prints`);
    }
  }
  ok(`a manual host: ${MANUAL_CASES.length} configs resolve as ssh -G does, or refuse`);
}

async function testIncludes(hosts) {
  const inc = path.join(HOME, ".ssh", "inc.conf");
  fs.writeFileSync(inc, "Host x\n  User y\n");
  writeConfigs(`Host *\n  Include ${inc}\n  RevokedHostKeys /r\n`);
  assert.deepEqual((await hosts.knownHostsSettings(manual("h1"))).revoked, ["/r"], "an included Host block ends with its file");
  if (HAS_SSH) assert.deepEqual(sshG(`Host *\n  Include ${inc}\n  RevokedHostKeys /r\n`, "h1"), ["/r"]);

  fs.writeFileSync(inc, "RevokedHostKeys /inc\nHost *\n  RevokedHostKeys /inc-all\n");
  writeConfigs(`Match host zz\n  Include ${inc}\nHost h1\n  RevokedHostKeys /r\n`);
  assert.deepEqual((await hosts.knownHostsSettings(manual("h1"))).revoked, ["/r"], "a file included where nothing applies applies nowhere");
  if (HAS_SSH) assert.deepEqual(sshG(`Match host zz\n  Include ${inc}\nHost h1\n  RevokedHostKeys /r\n`, "h1"), ["/r"]);

  fs.writeFileSync(inc, "Host *\n  RevokedHostKeys /inc\n");
  writeConfigs(`Match exec true\n  Include ${inc}\n`);
  assert.match(
    (await hosts.knownHostsSettings(manual("h1"))).refusal,
    /^~\/\.ssh\/config line 1 starts a "Match exec" block that sets RevokedHostKeys/,
    "a file included under Match exec counts as that block",
  );

  fs.writeFileSync(inc, "Host *\n  IdentityFile /id\nMatch user\n");
  writeConfigs(`Include ${inc}\n`);
  assert.match(
    (await hosts.knownHostsSettings(manual("h1"))).refusal,
    /^ssh cannot read ~\/\.ssh\/inc\.conf line 3 /,
    "a bad line in an included file names that file",
  );
  ok("Include: its own scope, nothing where it does not apply, and file and line in refusals");

  // ssh ignores an Include that matches nothing, or a directory, and stops
  // for a file it cannot open, a loop, or more than 16 levels, even where
  // the Include does not apply.
  const check = (config, expected, name) => {
    if (!HAS_SSH) return;
    const ssh = sshG(config, "h1");
    if (expected === "refused") assert.equal(ssh, "refused", `${name}: ssh refuses too`);
    else assert.deepEqual(ssh, expected, `${name}: as ssh -G prints`);
  };
  const dir = path.join(HOME, ".ssh", "inc.d");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, config] of [
    ["a missing Include", `Include ${HOME}/.ssh/nope.conf ${HOME}/.ssh/none-*.conf\nHost *\n  RevokedHostKeys /r\n`],
    ["an Include of a directory", `Include ${dir}\nHost *\n  RevokedHostKeys /r\n`],
  ]) {
    writeConfigs(config);
    assert.deepEqual(await hosts.knownHostsSettings(manual("h1")), { files: [path.join(HOME, ".ssh", "known_hosts"), path.join(HOME, ".ssh", "known_hosts2"), "/etc/ssh/ssh_known_hosts", "/etc/ssh/ssh_known_hosts2"], revoked: ["/r"] }, name);
    check(config, ["/r"], name);
  }

  const quoted = path.join(HOME, ".ssh", "quoted inc.conf");
  fs.writeFileSync(quoted, "Host *\n  RevokedHostKeys /r/inc\n");
  for (const [name, config] of [
    ["an Include in single quotes", `Include '${quoted}'\n`],
    ["an Include with a comment", `Include ${quoted.replace(/ /g, "\\ ")} # shared\n`],
  ]) {
    writeConfigs(config);
    assert.deepEqual((await hosts.knownHostsSettings(manual("h1"))).revoked, ["/r/inc"], name);
    check(config, ["/r/inc"], name);
  }

  if (process.getuid && process.getuid() !== 0) {
    const locked = path.join(HOME, ".ssh", "locked.conf");
    fs.writeFileSync(locked, "Host *\n  RevokedHostKeys /locked\n");
    fs.chmodSync(locked, 0o000);
    try {
      for (const [name, config] of [
        ["an Include ssh cannot open", `Include ${locked}\n`],
        ["one under a block that does not apply", `Host other\n  Include ${locked}\n`],
        ["one a glob matches", `Include ${HOME}/.ssh/lock*.conf\n`],
      ]) {
        writeConfigs(config);
        assert.match(
          (await hosts.knownHostsSettings(manual("h1"))).refusal,
          /^ssh cannot open ~\/\.ssh\/locked\.conf, included from ~\/\.ssh\/config line \d \(permission denied\)\. ssh will not connect anywhere until that line is fixed$/,
          name,
        );
        check(config, "refused", name);
      }
    } finally {
      fs.chmodSync(locked, 0o600);
    }
  } else {
    console.log("  skip unreadable Include (running as root)");
  }

  const chain = (levels) => {
    for (let i = 1; i <= levels; i++) {
      const body = i < levels ? `Include ${HOME}/.ssh/deep-${levels}-${i + 1}.conf\n` : "RevokedHostKeys /deep\n";
      fs.writeFileSync(path.join(HOME, ".ssh", `deep-${levels}-${i}.conf`), body);
    }
    return `Include ${HOME}/.ssh/deep-${levels}-1.conf\n`;
  };
  const sixteen = chain(16);
  writeConfigs(sixteen);
  assert.deepEqual((await hosts.knownHostsSettings(manual("h1"))).revoked, ["/deep"], "16 levels are read");
  check(sixteen, ["/deep"], "16 levels");
  const seventeen = chain(17);
  writeConfigs(seventeen);
  assert.match((await hosts.knownHostsSettings(manual("h1"))).refusal, /^~\/\.ssh\/deep-17-16\.conf line 1 nests Includes more than 16 levels deep/);
  check(seventeen, "refused", "17 levels");

  const loop = path.join(HOME, ".ssh", "loop.conf");
  fs.writeFileSync(loop, `Include ${loop}\n`);
  const looped = `Host other\n  Include ${loop}\nHost *\n  RevokedHostKeys /r\n`;
  writeConfigs(looped);
  assert.match((await hosts.knownHostsSettings(manual("h1"))).refusal, /^~\/\.ssh\/loop\.conf line 1 includes ~\/\.ssh\/loop\.conf inside itself/);
  check(looped, "refused", "an Include loop");
  ok("Include: missing files and directories are ignored; unreadable, looping or too deep refuses");
}

async function testSystemConfig(hosts) {
  writeConfigs("Host *\n  User root\n", "Match user root\n  RevokedHostKeys /r/sys\n");
  const list = await hosts.readSshConfigHosts();
  assert.deepEqual(list, [], "no concrete alias");
  writeConfigs("Host box\n  User root\n", "Match user root\n  RevokedHostKeys /r/sys\n");
  const box = (await hosts.readSshConfigHosts()).find((h) => h.id === "box");
  assert.deepEqual(box.revokedHostKeys, ["/r/sys"], "the system's Match user sees the User ~/.ssh/config set");
  assert.deepEqual((await hosts.knownHostsSettings(manual("h1", "root"))).revoked, ["/r/sys"], "and a manual host's login");
  assert.equal((await hosts.knownHostsSettings(manual("h1", "me"))).revoked, null);

  writeConfigs("Host h1\n  RevokedHostKeys none\n", "Host *\n  RevokedHostKeys /r/sys\n");
  assert.equal((await hosts.knownHostsSettings(manual("h1"))).revoked, null, "~/.ssh/config's none wins");

  writeConfigs("Host *\n  User x\n", "Host *\n  RevokedHostKeys /r\nMatch user\n");
  assert.match(
    (await hosts.knownHostsSettings(manual("h1"))).refusal,
    new RegExp(`^ssh cannot read ${SYSTEM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} line 3 `),
    "a bad line in the system config refuses too",
  );

  writeConfigs("Host other\n  HostName o\n", "Match localnetwork 10.0.0.0/8\n  GlobalKnownHostsFile /g\n");
  assert.match(
    (await hosts.knownHostsSettings(manual("h1"))).refusal,
    new RegExp(`^${SYSTEM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} line 1 starts a "Match localnetwork" block that sets GlobalKnownHostsFile`),
  );
  writeConfigs("", "");
  ok("~/.ssh/config and the system's are read as one, and refuse alike");
}

async function testConfigHosts(hosts) {
  // ssh refuses every host when a line is unreadable; Codara still lists
  // the hosts, each with the reason.
  writeConfigs("Host one\n  HostName one.example\n  RevokedHostKeys /r/one\nMatch user\nHost two\n  HostName two.example\n");
  const broken = await hosts.readSshConfigHosts();
  assert.deepEqual(broken.map((h) => h.id), ["one", "two"]);
  for (const host of broken) {
    assert.match(host.sshConfigRefusal, /^ssh cannot read ~\/\.ssh\/config line 4 /, host.id);
    assert.deepEqual(await hosts.knownHostsSettings(host), { refusal: host.sshConfigRefusal });
  }

  writeConfigs("Host work\n  HostName w.example\nMatch exec \"test -e /tmp/vpn\"\n  RevokedHostKeys /r/vpn\n");
  const [work] = await hosts.readSshConfigHosts();
  assert.match(work.sshConfigRefusal, /^~\/\.ssh\/config line 3 starts a "Match exec" block that sets RevokedHostKeys/);

  writeConfigs("Host *\n  User root\nHost box\n  HostName b.example\nMatch user root\n  RevokedHostKeys /r/root\n");
  const [rootBox] = await hosts.readSshConfigHosts();
  assert.equal(rootBox.username, "root");
  assert.deepEqual(rootBox.revokedHostKeys, ["/r/root"], "a config host's Match user sees its User");
  if (HAS_SSH) assert.deepEqual(sshG("Host *\n  User root\nHost box\n  HostName b.example\nMatch user root\n  RevokedHostKeys /r/root\n", "box"), ["/r/root"]);
  ok("a config host carries the refusal, for a bad line anywhere or a Match Codara cannot check");
}

// Host, Match host and Match final only: every field as before, as ssh -G.
// Match final rereads the file with HostName, so `Host *.lan` reaches nas.
async function testOrdinaryConfig(hosts) {
  const config = [
    "Host *.lan",
    "  User pi",
    "  UserKnownHostsFile ~/.ssh/known_lan",
    "Host nas",
    "  HostName nas.lan",
    "  Port 2222",
    "  IdentityFile ~/.ssh/id_nas",
    "Host web",
    "  HostName web.example.com",
    "  User deploy",
    "  ProxyCommand ssh -W %h:%p bastion",
    "  HostKeyAlias web-key",
    "Match host *.example.com",
    "  RevokedHostKeys /etc/ssh/revoked_example",
    "Match final host *.lan",
    "  GlobalKnownHostsFile /etc/ssh/lan_known",
    "Host *",
    "  IdentityFile ~/.ssh/id_ed25519",
    "",
  ].join("\n");
  writeConfigs(config);
  const list = await hosts.readSshConfigHosts();
  const home = (p) => path.join(HOME, p);
  assert.deepEqual(list, [
    {
      id: "nas",
      host: "nas.lan",
      port: 2222,
      username: "pi",
      identityFile: home(".ssh/id_nas"),
      source: "ssh-config",
      userKnownHostsFiles: [home(".ssh/known_lan")],
      globalKnownHostsFiles: ["/etc/ssh/lan_known"],
    },
    {
      id: "web",
      host: "web.example.com",
      port: 22,
      username: "deploy",
      identityFile: home(".ssh/id_ed25519"),
      source: "ssh-config",
      proxyCommandTemplate: "ssh -W %h:%p bastion",
      hostKeyAlias: "web-key",
      revokedHostKeys: ["/etc/ssh/revoked_example"],
    },
  ]);
  for (const host of list) {
    const settings = await hosts.knownHostsSettings(host);
    assert.ok(!("refusal" in settings), host.id);
  }
  // A manual host on the same names reads the same blocks.
  assert.deepEqual(await hosts.knownHostsSettings(manual("pi.lan")), {
    files: [home(".ssh/known_lan"), "/etc/ssh/lan_known"],
    revoked: null,
  });
  assert.deepEqual((await hosts.knownHostsSettings(manual("api.example.com"))).revoked, ["/etc/ssh/revoked_example"]);
  if (HAS_SSH) {
    const plain = config.replace(/~\//g, `${HOME}/`);
    for (const [alias, field, want] of [
      ["nas", "globalknownhostsfile", "/etc/ssh/lan_known"],
      ["nas", "port", "2222"],
      ["nas", "user", "pi"],
      ["nas", "userknownhostsfile", `${HOME}/.ssh/known_lan`],
      ["web", "revokedhostkeys", "/etc/ssh/revoked_example"],
      ["web", "user", "deploy"],
      ["pi.lan", "userknownhostsfile", `${HOME}/.ssh/known_lan`],
      ["pi.lan", "user", "pi"],
    ]) {
      const file = path.join(TMP, "ssh-g-config");
      fs.writeFileSync(file, plain);
      const out = spawnSync("ssh", ["-G", "-F", file, alias], { encoding: "utf8" }).stdout;
      const line = out.split("\n").find((l) => l.startsWith(`${field} `));
      assert.equal(line, `${field} ${want}`, `${alias} ${field}: as ssh -G`);
    }
  }
  ok("an ordinary config (Host, Match host, Match final) resolves as before and as ssh -G");

  writeConfigs("Host nas nas2\n  HostName nas.lan\n");
  assert.deepEqual((await hosts.readSshConfigHosts()).map((h) => [h.id, h.host]), [["nas", "nas.lan"], ["nas2", "nas.lan"]]);
  ok("a Host line with several aliases lists each of them");

  // ssh strips the quotes from a file list: the file itself is read.
  const files = "Host *\n  UserKnownHostsFile '/k/kh' \"/k/b c\"\n";
  writeConfigs(files);
  assert.deepEqual((await hosts.knownHostsSettings(manual("h1"))).files.slice(0, 2), ["/k/kh", "/k/b c"]);
  if (HAS_SSH) {
    const file = path.join(TMP, "ssh-g-config");
    fs.writeFileSync(file, files);
    const out = spawnSync("ssh", ["-G", "-F", file, "h1"], { encoding: "utf8" }).stdout;
    assert.ok(out.split("\n").includes("userknownhostsfile /k/kh /k/b c"), "as ssh -G prints");
  }
  ok("quoted UserKnownHostsFile paths name the files ssh reads");
}

(async () => {
  const hosts = await load();
  hosts.setSystemSshConfigPathForTests(SYSTEM);
  if (!HAS_SSH) console.log("  (no ssh: expectations only, no live ssh -G check)");
  await testManualHosts(hosts);
  await testIncludes(hosts);
  await testSystemConfig(hosts);
  await testConfigHosts(hosts);
  await testOrdinaryConfig(hosts);
  console.log(`\n${passed} passed`);
})()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
