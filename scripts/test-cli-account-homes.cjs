#!/usr/bin/env node
"use strict";

// Managed CLI homes (accounts spec 8) against a fake HOME: only allowlisted
// names are linked, nothing is created in the user's home, private names
// stay private, homes are refused inside protected paths, a link the CLI
// replaced with a file is left alone, the generated .claude.json drops the
// account and Codara's own entries, MCP servers merge one way, and a purge
// never follows a link out.
//
//   node scripts/test-cli-account-homes.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-cli-homes-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(HOME, ".codarastudio");
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = CODARA;
process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.GROK_HOME;

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    `export * from ${JSON.stringify(path.join(ROOT, "src", "main", "orchestration", "cli-account-homes.ts"))};\n`,
  );
  const out = path.join(TMP, "harness.cjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    external: ["electron"],
    logLevel: "silent",
    plugins: [
      {
        name: "cli-homes-harness",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  return require(out);
}

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

function treeHash(target) {
  if (!fs.existsSync(target)) return "absent";
  const hash = crypto.createHash("sha256");
  const visit = (current) => {
    const stats = fs.lstatSync(current);
    hash.update(`${path.relative(target, current)}|${stats.mode}|${stats.mtimeMs}\n`);
    if (stats.isSymbolicLink()) hash.update(fs.readlinkSync(current));
    else if (stats.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
    else hash.update(fs.readFileSync(current));
  };
  visit(target);
  return hash.digest("hex");
}

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const H = await buildHarness();
  const refused = (error) => error && error.name === "OutsideWriteError";
  const posix = process.platform !== "win32";

  // The user's own homes.
  const claudeHome = path.join(HOME, ".claude");
  fs.mkdirSync(path.join(claudeHome, "projects", "-work"), { recursive: true });
  writePrivate(path.join(claudeHome, "settings.json"), '{"theme":"dark"}');
  writePrivate(path.join(claudeHome, "CLAUDE.md"), "# me\n");
  writePrivate(path.join(claudeHome, ".credentials.json"), '{"claudeAiOauth":{}}');
  writePrivate(path.join(claudeHome, "statsig", "cache"), "x");
  writePrivate(
    path.join(HOME, ".claude.json"),
    JSON.stringify({
      oauthAccount: { accountUuid: "me" },
      userID: "user-hash",
      hasCompletedOnboarding: true,
      projects: { "/work": { hasTrustDialogAccepted: true } },
      mcpServers: {
        posthog: { type: "http", url: "https://mcp.posthog.com/mcp" },
        "codara-studio": { command: "node", _sparkManaged: true },
      },
    }),
  );
  const codexHome = path.join(HOME, ".codex");
  writePrivate(path.join(codexHome, "auth.json"), "{}");
  writePrivate(path.join(codexHome, "config.toml"), 'model = "gpt-5"\n');
  writePrivate(path.join(codexHome, "models_cache.json"), "{}");
  writePrivate(path.join(codexHome, "sessions", "a.jsonl"), "{}\n");
  writePrivate(path.join(codexHome, "auth.json.lock"), "");
  const grokHome = path.join(HOME, ".grok");
  writePrivate(path.join(grokHome, "auth.json"), "{}");
  writePrivate(path.join(grokHome, "config.toml"), 'model = "grok-4"\n');
  fs.mkdirSync(path.join(grokHome, "skills"), { recursive: true });
  const before = {
    claude: treeHash(claudeHome),
    config: treeHash(path.join(HOME, ".claude.json")),
    codex: treeHash(codexHome),
    grok: treeHash(grokHome),
  };

  // --- Claude --------------------------------------------------------------
  const claudeRoot = path.join(CODARA, "claude-cli");
  const claudeManaged = path.join(claudeRoot, "live", "home");
  const logs = [];
  await H.ensureClaudeManagedHome({
    home: claudeManaged,
    root: claudeRoot,
    systemHome: claudeHome,
    systemConfigDirEnv: null,
    log: (message) => logs.push(message),
  });
  if (posix) {
    assert.equal(fs.statSync(claudeManaged).mode & 0o777, 0o700);
    for (const name of ["projects", "settings.json", "CLAUDE.md"]) {
      assert.equal(fs.readlinkSync(path.join(claudeManaged, name)), path.join(claudeHome, name), name);
    }
    for (const name of ["todos", "plans", "skills", "history.jsonl"]) {
      assert.equal(fs.existsSync(path.join(claudeManaged, name)), false, `${name} is not created`);
      assert.equal(fs.existsSync(path.join(claudeHome, name)), false, `${name} is not created in the source`);
    }
    for (const name of [".credentials.json", "statsig"]) {
      assert.equal(fs.existsSync(path.join(claudeManaged, name)), false, `${name} stays private`);
    }
    for (const name of fs.readdirSync(claudeManaged)) {
      if (name === ".claude.json") continue;
      assert.ok(H.CLAUDE_SHARED_STATE_NAMES.includes(name), `${name} is on the allowlist`);
    }
  }
  pass("a managed Claude home links only allowlisted names that exist, and creates nothing in the source");

  const generated = JSON.parse(fs.readFileSync(path.join(claudeManaged, ".claude.json"), "utf8"));
  assert.equal(generated.oauthAccount, undefined);
  assert.equal(generated.userID, undefined);
  assert.equal(generated.hasCompletedOnboarding, true);
  assert.deepEqual(generated.projects, { "/work": { hasTrustDialogAccepted: true } });
  assert.deepEqual(generated.mcpServers, { posthog: { type: "http", url: "https://mcp.posthog.com/mcp" } });
  assert.deepEqual(H.managedClaudeConfigFrom(null), {});
  pass("the generated .claude.json drops the account, the user id and Codara's own MCP entry");

  // One-way MCP merge: the user's new server arrives, the home's own server
  // stays, a server the user removed is not removed here.
  const configFile = path.join(claudeManaged, ".claude.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({ ...generated, mcpServers: { ...generated.mcpServers, local: { command: "x" } } }),
    { mode: 0o600 },
  );
  const userConfig = JSON.parse(fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"));
  const userConfigNext = {
    ...userConfig,
    mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
  };
  // The user's file changes outside Codara; the next provisioning reads it.
  fs.writeFileSync(path.join(HOME, ".claude.json"), JSON.stringify(userConfigNext), { mode: 0o600 });
  before.config = treeHash(path.join(HOME, ".claude.json"));
  await H.ensureClaudeManagedHome({ home: claudeManaged, root: claudeRoot, systemHome: claudeHome, systemConfigDirEnv: null });
  const merged = JSON.parse(fs.readFileSync(configFile, "utf8")).mcpServers;
  assert.deepEqual(Object.keys(merged).sort(), ["linear", "local", "posthog"]);
  pass("MCP servers merge one way into the managed home");

  // A link Claude replaced with a file of its own is left alone, once logged.
  if (posix) {
    fs.unlinkSync(path.join(claudeManaged, "settings.json"));
    fs.writeFileSync(path.join(claudeManaged, "settings.json"), '{"own":true}', { mode: 0o600 });
    await H.ensureClaudeManagedHome({
      home: claudeManaged,
      root: claudeRoot,
      systemHome: claudeHome,
      systemConfigDirEnv: null,
      log: (message) => logs.push(message),
    });
    assert.equal(fs.readFileSync(path.join(claudeManaged, "settings.json"), "utf8"), '{"own":true}');
    assert.equal(fs.lstatSync(path.join(claudeManaged, "settings.json")).isSymbolicLink(), false);
    assert.ok(logs.some((line) => /settings\.json .*stays private/.test(line)));
    pass("a link the CLI replaced with a file of its own is left alone");
  }

  // Homes are refused outside Codara's CLI directory and inside the user's.
  await assert.rejects(
    () => H.ensureClaudeManagedHome({ home: path.join(claudeHome, "nested"), root: claudeHome, systemHome: claudeHome, systemConfigDirEnv: null }),
    refused,
  );
  await assert.rejects(
    () => H.ensureClaudeManagedHome({ home: path.join(TMP, "elsewhere"), root: claudeRoot, systemHome: claudeHome, systemConfigDirEnv: null }),
    refused,
  );
  await assert.rejects(
    () => H.ensureCodexManagedHome({ home: codexHome, root: HOME, systemHome: codexHome }),
    refused,
  );
  pass("a managed home is refused inside a protected home or outside its CLI's directory");

  // --- Codex ---------------------------------------------------------------
  const codexRoot = path.join(CODARA, "codex-cli");
  const codexManaged = path.join(codexRoot, "accounts", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "home");
  fs.mkdirSync(codexManaged, { recursive: true });
  if (posix) fs.symlinkSync(path.join(codexHome, "auth.json"), path.join(codexManaged, "auth.json"));
  await H.ensureCodexManagedHome({ home: codexManaged, root: codexRoot, systemHome: codexHome });
  if (posix) {
    assert.equal(fs.readlinkSync(path.join(codexManaged, "config.toml")), path.join(codexHome, "config.toml"));
    assert.equal(fs.readlinkSync(path.join(codexManaged, "sessions")), path.join(codexHome, "sessions"));
    assert.equal(fs.existsSync(path.join(codexManaged, "auth.json")), false, "an old shared auth.json link goes");
    assert.equal(fs.existsSync(path.join(codexManaged, "models_cache.json")), false);
    assert.equal(fs.existsSync(path.join(codexManaged, "auth.json.lock")), false, "a running Codex's lock is not linked");
    assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), "{}", "the link's target is untouched");
  }
  pass("a managed Codex home links every entry but the private ones and drops an old auth link");

  // --- Grok ----------------------------------------------------------------
  const grokRoot = path.join(CODARA, "grok-cli");
  const grokManaged = path.join(grokRoot, "accounts", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
  await H.ensureGrokManagedHome({ home: grokManaged, root: grokRoot, systemHome: grokHome });
  if (posix) {
    assert.equal(fs.readlinkSync(path.join(grokManaged, "skills")), path.join(grokHome, "skills"));
    assert.equal(fs.existsSync(path.join(grokManaged, "sessions")), false);
    assert.equal(fs.existsSync(path.join(grokHome, "sessions")), false, "nothing is created in the source");
  }
  assert.equal(fs.lstatSync(path.join(grokManaged, "config.toml")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(grokManaged, "config.toml"), "utf8"), 'model = "grok-4"\n');
  assert.equal(fs.existsSync(path.join(grokManaged, "auth.json")), false);
  pass("a managed Grok home links its allowlist and keeps a private copy of the config");

  // --- Purge ---------------------------------------------------------------
  const accountsRoot = path.join(codexRoot, "accounts");
  assert.equal(await H.purgeManagedPath(path.dirname(codexManaged), accountsRoot), true);
  assert.equal(fs.existsSync(path.dirname(codexManaged)), false);
  await assert.rejects(() => H.purgeManagedPath(accountsRoot, accountsRoot), refused);
  await assert.rejects(() => H.purgeManagedPath(path.join(TMP, "x"), accountsRoot), refused);
  pass("a purge removes the account directory without following its links, and nothing outside");

  assert.deepEqual(
    {
      claude: treeHash(claudeHome),
      config: treeHash(path.join(HOME, ".claude.json")),
      codex: treeHash(codexHome),
      grok: treeHash(grokHome),
    },
    before,
  );
  pass("the user's homes are unchanged after provisioning and purging");

  console.log(`\nPASS CLI account homes (${passes} checks)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
