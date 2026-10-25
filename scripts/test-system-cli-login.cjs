#!/usr/bin/env node
"use strict";

// The System login reader (accounts spec 4) against a fake HOME: identity
// from each CLI's own files, signed-out states, a user-set home, the macOS
// Keychain existence check (a fake `security` that records its argv, never
// with -w), and a byte-identical tree after every read and watch.
//
//   node scripts/test-system-cli-login.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-system-login-")));
const HOME = path.join(TMP, "home");
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = path.join(HOME, ".codarastudio");
delete process.env.CODARA_DISABLE_KEYCHAIN;

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    `export * from ${JSON.stringify(path.join(ROOT, "src", "main", "orchestration", "system-cli-login.ts"))};\n`,
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
        name: "system-login-harness",
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

function treeHash(dir) {
  if (!fs.existsSync(dir)) return "absent";
  const hash = crypto.createHash("sha256");
  if (fs.lstatSync(dir).isFile()) {
    const stats = fs.lstatSync(dir);
    return hash.update(`${stats.mode}|${stats.mtimeMs}|`).update(fs.readFileSync(dir)).digest("hex");
  }
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stats = fs.lstatSync(full);
      hash.update(`${path.relative(dir, full)}|${stats.mode}|${stats.mtimeMs}|${stats.size}\n`);
      if (stats.isDirectory()) walk(full);
      else if (stats.isFile()) hash.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const S = await buildHarness();
  const options = { homeDir: HOME, env: {} };

  // Nothing signed in: every CLI answers signed out and nothing is created.
  for (const provider of ["anthropic", "openai-codex", "xai"]) {
    const login = await S.readSystemLogin(provider, { ...options, platform: "linux" });
    assert.equal(login.signedIn, false, provider);
    assert.equal(login.email, undefined);
  }
  assert.equal(fs.existsSync(HOME), false, "reading created nothing");
  const disposable = S.watchSystemLogin("anthropic", () => undefined, options);
  disposable.dispose();
  assert.equal(fs.existsSync(HOME), false, "watching a missing home created nothing");
  pass("signed-out CLIs read as signed out and nothing is created");

  // Claude: identity from ~/.claude.json, signed-in from the credential's
  // existence (its bytes are never parsed for the answer).
  const claudeUuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  writePrivate(path.join(HOME, ".claude", ".credentials.json"), "not even json");
  writePrivate(
    path.join(HOME, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: claudeUuid, emailAddress: "Me@Example.com" } }),
  );
  // Codex: the ChatGPT login's id_token names the account and its email.
  const codexAccount = "acct-11111111-1111-4111-8111-111111111111";
  writePrivate(
    path.join(HOME, ".codex", "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({ email: "codex@example.com" }),
        access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: codexAccount } }),
        refresh_token: "r",
        account_id: codexAccount,
      },
    }),
  );
  // Grok: the auth slot's key names the subject.
  const grokSubject = "22222222-2222-4222-8222-222222222222";
  writePrivate(
    path.join(HOME, ".grok", "auth.json"),
    JSON.stringify({
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        key: jwt({ sub: grokSubject, email: "grok@example.com" }),
        user_id: grokSubject,
        email: "grok@example.com",
        refresh_token: "r",
      },
    }),
  );
  const hashes = () => ({
    claude: treeHash(path.join(HOME, ".claude")),
    config: treeHash(path.join(HOME, ".claude.json")),
    codex: treeHash(path.join(HOME, ".codex")),
    grok: treeHash(path.join(HOME, ".grok")),
  });
  const before = hashes();

  const claude = await S.readSystemLogin("anthropic", { ...options, platform: "linux" });
  assert.equal(claude.signedIn, true);
  assert.equal(claude.email.toLowerCase(), "me@example.com");
  assert.equal(claude.home, path.join(HOME, ".claude"));
  assert.ok(claude.identityFingerprint);
  assert.equal("accessToken" in claude, false);
  const codex = await S.readSystemLogin("openai-codex", options);
  assert.equal(codex.signedIn, true);
  assert.equal(codex.email, "codex@example.com");
  assert.equal(codex.identityFingerprint, sha(codexAccount));
  const grok = await S.readSystemLogin("xai", options);
  assert.equal(grok.signedIn, true);
  assert.equal(grok.identityFingerprint, sha(grokSubject));
  assert.ok(!JSON.stringify([claude, codex, grok]).includes('"r"'), "no token travels in the answer");
  pass("each CLI's identity is read from its own files, without a token in the answer");

  // A Codex API-key login is signed in without an identity.
  writePrivate(path.join(TMP, "api-codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
  const apiKey = await S.readSystemLogin("openai-codex", { homeDir: HOME, env: { CODEX_HOME: path.join(TMP, "api-codex") } });
  assert.deepEqual(
    { signedIn: apiKey.signedIn, apiKey: apiKey.apiKey, email: apiKey.email },
    { signedIn: true, apiKey: true, email: undefined },
  );
  pass("a Codex API-key login reads as signed in with no account");

  // A user-set home is the System login; one inside Codara's home is a
  // retired export and is ignored.
  const custom = path.join(TMP, "custom-claude");
  writePrivate(path.join(custom, ".credentials.json"), "{}");
  writePrivate(path.join(custom, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "other", emailAddress: "custom@example.com" } }));
  const userSet = await S.readSystemLogin("anthropic", { homeDir: HOME, env: { CLAUDE_CONFIG_DIR: custom }, platform: "linux" });
  assert.equal(userSet.home, custom);
  assert.equal(userSet.email, "custom@example.com");
  const retired = await S.readSystemLogin("anthropic", {
    homeDir: HOME,
    env: { CLAUDE_CONFIG_DIR: path.join(HOME, ".codarastudio", "claude-cli", "live", "home") },
    platform: "linux",
  });
  assert.equal(retired.home, path.join(HOME, ".claude"));
  assert.equal(S.systemCliHome("xai", { homeDir: HOME, env: { GROK_HOME: path.join(TMP, "g") } }), path.join(TMP, "g"));
  pass("a user-set home is honored, a Codara-managed one is ignored");

  // macOS without a credentials file: the Keychain is asked whether the item
  // exists, never for its secret (no -w), for the base or the suffixed item.
  if (process.platform !== "win32") {
    const argvLog = path.join(TMP, "security-argv.log");
    const fakeSecurity = path.join(TMP, "security");
    fs.writeFileSync(fakeSecurity, `#!/bin/sh\necho "$@" >> ${JSON.stringify(argvLog)}\nexit 0\n`, { mode: 0o755 });
    const keychainHome = path.join(TMP, "keychain-home");
    writePrivate(path.join(keychainHome, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: claudeUuid } }));
    const mac = await S.readSystemLogin("anthropic", {
      homeDir: keychainHome,
      env: {},
      platform: "darwin",
      securityBinary: fakeSecurity,
    });
    assert.equal(mac.signedIn, true);
    const suffixed = await S.readSystemLogin("anthropic", {
      homeDir: keychainHome,
      env: { CLAUDE_CONFIG_DIR: custom + "-mac" },
      platform: "darwin",
      securityBinary: fakeSecurity,
    });
    assert.equal(suffixed.signedIn, true);
    const calls = fs.readFileSync(argvLog, "utf8").trim().split("\n");
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call, /^find-generic-password -a \S+ -s Claude Code-credentials/);
      assert.doesNotMatch(call, /(^| )-w( |$)/, "the secret is never asked for");
    }
    assert.match(calls[0], /-s Claude Code-credentials$/);
    assert.match(calls[1], /-s Claude Code-credentials-[0-9a-f]{8}$/);
    pass("the Keychain is asked only whether the item exists, never for its secret");
  }

  // Reading and watching left every home byte for byte, mtime for mtime.
  const watchers = ["anthropic", "openai-codex", "xai"].map((provider) =>
    S.watchSystemLogin(provider, () => undefined, options),
  );
  for (const watcher of watchers) watcher.dispose();
  assert.deepEqual(hashes(), before);
  pass("reading and watching the System login change nothing");

  console.log(`\nPASS System CLI login (${passes} checks)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
