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
    `export { claudeIdentityOf } from ${source("claude-cli-live-login.ts")};`,
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
    const { fingerprint } = await mod.readAnthropicAccountProfile("sk-ant-oat01-token", {
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
    const identity = await mod.readAnthropicAccountProfile("sk-ant-oat01-token", {
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
      accountUuid: ACCOUNT_UUID,
      organizationUuid: "org-uuid",
      email: "someone@example.com",
    });
    // Nothing else in the response is kept, whatever the endpoint sends.
    assert.deepEqual(Object.keys(identity).sort(), [
      "accountUuid",
      "email",
      "fingerprint",
      "organizationUuid",
    ]);
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
        await mod.readAnthropicAccountProfile("sk-ant-oat01-token", {
          fetchImpl: async () => jsonResponse({ account }),
        }),
        { fingerprint: EXPECTED, accountUuid: ACCOUNT_UUID },
      );
    }
    // An address with no uuid still identifies the card, just not its pairing.
    assert.deepEqual(
      await mod.readAnthropicAccountProfile("sk-ant-oat01-token", {
        fetchImpl: async () =>
          jsonResponse({ account: { email: "someone@example.com" } }),
      }),
      { email: "someone@example.com" },
    );
  });

  await test("a Claude Code sign-in for the same account hashes identically", async () => {
    // The oauthAccount block Claude Code stores beside its login: only the
    // uuid and the address are looked at.
    assert.deepEqual(
      mod.claudeIdentityOf({
        accountUuid: ACCOUNT_UUID,
        emailAddress: "someone@example.com",
        organizationUuid: "org-uuid",
      }),
      { fingerprint: EXPECTED, email: "someone@example.com" },
    );
    // An unusable address still pairs on the uuid.
    assert.deepEqual(
      mod.claudeIdentityOf({ accountUuid: ACCOUNT_UUID, emailAddress: "not an address" }),
      { fingerprint: EXPECTED },
    );
  });

  await test("casing cannot split one account into two cards", async () => {
    assert.equal(
      mod.anthropicAccountFingerprint(ACCOUNT_UUID.toUpperCase()),
      EXPECTED,
    );
    assert.equal(mod.anthropicAccountFingerprint(` ${ACCOUNT_UUID} `), EXPECTED);
  });

  await test("a signed-out Claude Code login simply has no digest", async () => {
    assert.deepEqual(mod.claudeIdentityOf(null), {});
    assert.deepEqual(mod.claudeIdentityOf({}), {});
    assert.deepEqual(mod.claudeIdentityOf({ accountUuid: "  " }), {});
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
        (await mod.readAnthropicAccountProfile("sk-ant-oat01-token", { fetchImpl }))
          .fingerprint,
        undefined,
      );
    }
  });

  await test("a hung endpoint gives up instead of holding the login", async () => {
    let aborted = false;
    const { fingerprint } = await mod.readAnthropicAccountProfile("sk-ant-oat01-token", {
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
    assert.deepEqual(await mod.readAnthropicAccountProfile("", { fetchImpl }), {});
    assert.deepEqual(await mod.readAnthropicAccountProfile("   ", { fetchImpl }), {});
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
