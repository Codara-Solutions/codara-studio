#!/usr/bin/env node
"use strict";

// Connect-time Anthropic account identity: the one read that lets a Cora
// sign-in and a Claude Code sign-in be recognised as one account.
//
//   node scripts/test-anthropic-account-identity.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-anthropic-identity-"));
const ENTRY = path.join(TMP, "entry.ts");
const OUT = path.join(TMP, "bundle.cjs");
const source = (name) =>
  JSON.stringify(
    path.join(ROOT, "src", "main", "orchestration", name).replace(/\.ts$/, ""),
  );

fs.writeFileSync(
  ENTRY,
  [
    `export * from ${source("anthropic-account-identity.ts")};`,
    `export * from ${source("native-cli-account-identity.ts")};`,
  ].join("\n"),
);

buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: OUT,
});

const mod = require(OUT);

const ACCOUNT_UUID = "9b1f2c3d-4e5a-4b6c-8d9e-0f1a2b3c4d5e";
const EXPECTED = crypto
  .createHash("sha256")
  .update(ACCOUNT_UUID)
  .digest("hex");

const passed = [];
async function test(name, fn) {
  await fn();
  passed.push(name);
  console.log(`ok ${passed.length} - ${name}`);
}

function jsonResponse(body, ok = true) {
  return { ok, text: async () => JSON.stringify(body) };
}

async function main() {
  await test("the profile endpoint's account uuid becomes the digest", async () => {
    const calls = [];
    const fingerprint = await mod.readAnthropicAccountFingerprint("sk-ant-oat01-token", {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          account: {
            uuid: ACCOUNT_UUID,
            email: "someone@example.com",
            display_name: "Someone",
          },
          organization: { uuid: "org-uuid", name: "Org" },
        });
      },
    });
    assert.equal(fingerprint, EXPECTED);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, mod.ANTHROPIC_OAUTH_PROFILE_URL);
    assert.equal(calls[0].url, "https://api.anthropic.com/api/oauth/profile");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(
      calls[0].init.headers.Authorization,
      "Bearer sk-ant-oat01-token",
    );
  });

  await test("the same read reports the account's email for the card", async () => {
    const identity = await mod.readAnthropicAccountIdentity("sk-ant-oat01-token", {
      fetchImpl: async () =>
        jsonResponse({
          account: {
            uuid: ACCOUNT_UUID,
            email_address: "someone@example.com",
            display_name: "Someone",
          },
          organization: { uuid: "org-uuid", name: "Org" },
        }),
    });
    assert.deepEqual(identity, {
      fingerprint: EXPECTED,
      email: "someone@example.com",
    });
    // Nothing else in the response is kept, whatever the endpoint sends.
    assert.deepEqual(Object.keys(identity).sort(), ["email", "fingerprint"]);
  });

  await test("an unusable or missing address leaves the card without one", async () => {
    for (const account of [
      { uuid: ACCOUNT_UUID },
      { uuid: ACCOUNT_UUID, email_address: "" },
      { uuid: ACCOUNT_UUID, email_address: "not an address" },
      { uuid: ACCOUNT_UUID, email_address: 42 },
      { uuid: ACCOUNT_UUID, email_address: `someone@example.com\nX-Injected: 1` },
    ]) {
      assert.deepEqual(
        await mod.readAnthropicAccountIdentity("sk-ant-oat01-token", {
          fetchImpl: async () => jsonResponse({ account }),
        }),
        { fingerprint: EXPECTED },
      );
    }
    // An address with no uuid still identifies the card, just not its pairing.
    assert.deepEqual(
      await mod.readAnthropicAccountIdentity("sk-ant-oat01-token", {
        fetchImpl: async () =>
          jsonResponse({ account: { email: "someone@example.com" } }),
      }),
      { email: "someone@example.com" },
    );
  });

  await test("a Claude Code sign-in for the same account hashes identically", async () => {
    const configDir = fs.mkdtempSync(path.join(TMP, "claude-"));
    const home = fs.mkdtempSync(path.join(TMP, "home-"));
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          accountUuid: ACCOUNT_UUID,
          emailAddress: "someone@example.com",
          organizationUuid: "org-uuid",
        },
        projects: {},
      }),
    );
    const fingerprint = await mod.readClaudeCliAccountFingerprint(
      configDir,
      null,
      home,
    );
    assert.equal(fingerprint, EXPECTED);
    // Same file, same read: the address Claude Code stored is what its card
    // shows, and nothing else in that config is looked at.
    assert.deepEqual(
      await mod.readClaudeCliAccountIdentity(configDir, null, home),
      { fingerprint: EXPECTED, email: "someone@example.com" },
    );
  });

  await test("casing cannot split one account into two cards", async () => {
    assert.equal(
      mod.anthropicAccountFingerprint(ACCOUNT_UUID.toUpperCase()),
      EXPECTED,
    );
    assert.equal(mod.anthropicAccountFingerprint(` ${ACCOUNT_UUID} `), EXPECTED);
  });

  await test("CLAUDE_CONFIG_DIR moves where the account is looked for", async () => {
    const configDir = fs.mkdtempSync(path.join(TMP, "managed-"));
    const home = fs.mkdtempSync(path.join(TMP, "otherhome-"));
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_UUID } }),
    );
    assert.equal(
      await mod.readClaudeCliAccountFingerprint(configDir, configDir, home),
      EXPECTED,
    );
    // The same profile with no CLAUDE_CONFIG_DIR reads the home file instead,
    // which is empty here, so it pairs with nothing.
    assert.equal(
      await mod.readClaudeCliAccountFingerprint(configDir, null, home),
      undefined,
    );
  });

  await test("a legacy .config.json wins over the home file", async () => {
    const configDir = fs.mkdtempSync(path.join(TMP, "legacy-"));
    const home = fs.mkdtempSync(path.join(TMP, "legacyhome-"));
    const other = "11111111-2222-4333-8444-555555555555";
    fs.writeFileSync(
      path.join(configDir, ".config.json"),
      JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_UUID } }),
    );
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: other } }),
    );
    assert.equal(
      await mod.readClaudeCliAccountFingerprint(configDir, null, home),
      EXPECTED,
    );
  });

  await test("a signed-out or unreadable config simply has no digest", async () => {
    const configDir = fs.mkdtempSync(path.join(TMP, "empty-"));
    const home = fs.mkdtempSync(path.join(TMP, "emptyhome-"));
    assert.equal(
      await mod.readClaudeCliAccountFingerprint(configDir, null, home),
      undefined,
    );
    fs.writeFileSync(path.join(home, ".claude.json"), "{ not json");
    assert.equal(
      await mod.readClaudeCliAccountFingerprint(configDir, null, home),
      undefined,
    );
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ projects: {} }),
    );
    assert.equal(
      await mod.readClaudeCliAccountFingerprint(configDir, null, home),
      undefined,
    );
    assert.deepEqual(
      await mod.readClaudeCliAccountIdentity(configDir, null, home),
      {},
    );
  });

  await test("a symlinked config is refused rather than followed", async () => {
    const configDir = fs.mkdtempSync(path.join(TMP, "link-"));
    const home = fs.mkdtempSync(path.join(TMP, "linkhome-"));
    const real = path.join(configDir, "real.json");
    fs.writeFileSync(
      real,
      JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_UUID } }),
    );
    fs.symlinkSync(real, path.join(home, ".claude.json"));
    assert.equal(
      await mod.readClaudeCliAccountFingerprint(configDir, null, home),
      undefined,
    );
  });

  await test("a refused, offline, or nonsense profile read pairs nothing", async () => {
    const cases = [
      async () => jsonResponse({ account: { uuid: ACCOUNT_UUID } }, false),
      async () => ({ ok: true, text: async () => "<html>nope</html>" }),
      async () => jsonResponse({ organization: { uuid: "org" } }),
      async () => jsonResponse({ account: { uuid: "" } }),
      async () => {
        throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
      },
    ];
    for (const fetchImpl of cases) {
      assert.equal(
        await mod.readAnthropicAccountFingerprint("sk-ant-oat01-token", {
          fetchImpl,
        }),
        undefined,
      );
    }
  });

  await test("a hung endpoint gives up instead of holding the login", async () => {
    let aborted = false;
    const fingerprint = await mod.readAnthropicAccountFingerprint("sk-ant-oat01-token", {
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    assert.equal(fingerprint, undefined);
    assert.equal(aborted, true);
  });

  await test("no token means no request at all", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return jsonResponse({ account: { uuid: ACCOUNT_UUID } });
    };
    assert.equal(
      await mod.readAnthropicAccountFingerprint("", { fetchImpl }),
      undefined,
    );
    assert.equal(
      await mod.readAnthropicAccountFingerprint("   ", { fetchImpl }),
      undefined,
    );
    assert.deepEqual(
      await mod.readAnthropicAccountIdentity("", { fetchImpl }),
      {},
    );
    assert.equal(called, false);
  });

  console.log(
    `\nPASS connect-time Anthropic account identity: one bearer read of the OAuth profile, hashed into the same id space as a Claude Code sign-in and carrying only that account's address for display, with every failure leaving the account unpaired`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
