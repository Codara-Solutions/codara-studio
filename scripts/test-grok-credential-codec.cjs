#!/usr/bin/env node
"use strict";

// The Grok credential codec: the issuer-keyed slot of ~/.grok/auth.json
// against Pi's xai credential, expiry from the access JWT with the five
// minute skew Pi subtracts, the previous-wins slot merge, and the verified
// full-shape synthesis of a brand-new slot.
//
//   node scripts/test-grok-credential-codec.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-grok-codec-"));
const SKEW = 5 * 60 * 1000;
const SUBJECT = "11111111-2222-4333-8444-555555555555";
const TEAM = "22222222-2222-4333-8444-555555555555";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const key = (iatSeconds, extra = {}) =>
  jwt({ sub: SUBJECT, iat: iatSeconds, exp: iatSeconds + 3600, email: "grok@example.com", team_id: TEAM, ...extra });

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function build() {
  const out = path.join(TMP, "codec.cjs");
  const entry = path.join(TMP, "entry.ts");
  const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(orchestration("account-adapters/grok-credential-codec.ts"))};`,
      `export * as mirror from ${JSON.stringify(orchestration("credential-mirror.ts"))};`,
    ].join("\n"),
  );
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
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onResolve({ filter: /pi-runtime-electron$/ }, () => ({ path: "rt", namespace: "stub" }));
          build.onLoad({ filter: /^rt$/, namespace: "stub" }, () => ({
            loader: "js",
            contents: `export async function resolveCodaraPiRuntime() { throw new Error("not used"); }`,
          }));
        },
      },
    ],
  });
  return require(out);
}

async function main() {
  const M = await build();
  const T0 = 1_800_000_000;
  const now = new Date("2026-08-30T12:00:00.000Z");
  const codec = M.createGrokCredentialCodec({ now: () => now });
  const SLOT = M.GROK_AUTH_SLOT_KEY;
  assert.equal(SLOT, "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828");

  const fullSlot = (n) => ({
    key: key(T0 + n),
    auth_mode: "oidc",
    create_time: "2026-08-01T00:00:00.000Z",
    user_id: SUBJECT,
    email: "grok@example.com",
    first_name: "Grok",
    last_name: "User",
    profile_image_asset_id: "asset",
    principal_type: "User",
    principal_id: SUBJECT,
    team_id: TEAM,
    coding_data_retention_opt_out: true,
    refresh_token: `refresh-${n}`,
    expires_at: new Date((T0 + n + 3600) * 1000).toISOString(),
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
  });

  // auth.json -> canonical: the slot's JWT decides the expiry; metadata rides in extra.
  {
    const file = { [SLOT]: fullSlot(0), "other-key": { unrelated: true } };
    const canonical = codec.canonicalFromCli(file);
    assert.equal(canonical.access, file[SLOT].key);
    assert.equal(canonical.refresh, "refresh-0");
    assert.equal(canonical.expiresAt, (T0 + 3600) * 1000);
    assert.equal(canonical.issuedAt, T0 * 1000);
    assert.equal(canonical.extra.slotKey, SLOT);
    assert.equal(canonical.extra.user_id, SUBJECT);
    assert.equal(canonical.extra.coding_data_retention_opt_out, true);
    assert.equal("key" in canonical.extra, false);
    assert.equal("refresh_token" in canonical.extra, false);
    assert.equal("expires_at" in canonical.extra, false);
    assert.equal(codec.canonicalFromCli(null), null);
    assert.equal(codec.canonicalFromCli({}), null);
    assert.equal(codec.canonicalFromCli({ "other-key": { key: "x" } }), null, "only an auth.x.ai slot counts");
    const opaque = { [SLOT]: { ...fullSlot(0), key: "opaque-key" } };
    assert.equal(codec.canonicalFromCli(opaque).expiresAt, (T0 + 3600) * 1000, "expires_at is the fallback");
    assert.equal(codec.canonicalFromCli(opaque).issuedAt, undefined);
    assert.equal(codec.canonicalFromCli({ [SLOT]: { key: "opaque-key" } }).expiresAt, 0);
    assert.equal(codec.canonicalFromCli({ [SLOT]: { key: "opaque-key" } }).refresh, "");
    pass("the slot converts with the JWT's exp and iat and carries its metadata");
  }

  // Pi -> canonical: the JWT's exp, or expires plus the skew Pi subtracted.
  {
    const pi = { type: "oauth", access: key(T0), refresh: "refresh-0", expires: T0 * 1000 - SKEW + 999 };
    const canonical = codec.canonicalFromPi(pi);
    assert.equal(canonical.expiresAt, (T0 + 3600) * 1000);
    assert.equal(canonical.issuedAt, T0 * 1000);
    assert.equal(codec.canonicalFromPi({ type: "oauth", access: "opaque", refresh: "r", expires: 1000 }).expiresAt, 1000 + SKEW);
    assert.equal(codec.canonicalFromPi({ type: "oauth", access: "opaque", refresh: "r" }), null);
    assert.equal(codec.canonicalFromPi({ type: "api_key", key: "x" }), null);
    assert.deepEqual(codec.piRecordFromCanonical(canonical), {
      type: "oauth",
      access: pi.access,
      refresh: "refresh-0",
      expires: (T0 + 3600) * 1000 - SKEW,
    });
    assert.equal(M.mirror.compareCredentials(canonical, codec.canonicalFromCli({ [SLOT]: fullSlot(0) })), "equal");
    assert.equal(M.mirror.compareCredentials(canonical, codec.canonicalFromCli({ [SLOT]: fullSlot(10) })), "cli-newer");
    assert.equal(M.mirror.compareCredentials(codec.canonicalFromPi({ ...pi, access: key(T0 + 20) }), codec.canonicalFromCli({ [SLOT]: fullSlot(10) })), "pi-newer");
    pass("a Pi credential derives its expiry from the JWT, writes it back skewed, and compares against the slot");
  }

  // canonical -> auth.json with a previous slot: previous wins for metadata,
  // the three credential fields change, an empty refresh keeps the slot's.
  {
    const previous = { [SLOT]: fullSlot(0), "other-key": { unrelated: true } };
    const rotated = { access: key(T0 + 50), refresh: "refresh-50", expiresAt: (T0 + 50 + 3600) * 1000 };
    const merged = codec.cliRecordFromCanonical(rotated, previous);
    assert.equal(merged["other-key"].unrelated, true);
    const slot = merged[SLOT];
    assert.equal(slot.key, rotated.access);
    assert.equal(slot.refresh_token, "refresh-50");
    assert.equal(slot.expires_at, new Date(rotated.expiresAt).toISOString());
    assert.equal(slot.first_name, "Grok");
    assert.equal(slot.coding_data_retention_opt_out, true);
    assert.equal(slot.create_time, "2026-08-01T00:00:00.000Z");
    const keptRefresh = codec.cliRecordFromCanonical({ ...rotated, refresh: "" }, previous);
    assert.equal(keptRefresh[SLOT].refresh_token, "refresh-0", "xAI may not rotate; the slot's refresh token stays");
    assert.deepEqual(codec.canonicalFromCli(merged), {
      access: rotated.access,
      refresh: "refresh-50",
      expiresAt: rotated.expiresAt,
      issuedAt: (T0 + 50) * 1000,
      extra: codec.canonicalFromCli(previous).extra,
    });
    pass("a previous slot keeps its metadata and gets the rotated credential");
  }

  // A brand-new slot: the verified full shape from the JWT claims, no
  // tokens invented, the subject mandatory.
  {
    const fresh = codec.cliRecordFromCanonical({ access: key(T0), refresh: "refresh-0", expiresAt: (T0 + 3600) * 1000 }, null);
    assert.deepEqual(Object.keys(fresh), [SLOT]);
    assert.deepEqual(fresh[SLOT], {
      key: key(T0),
      auth_mode: "oidc",
      create_time: now.toISOString(),
      user_id: SUBJECT,
      email: "grok@example.com",
      first_name: "",
      last_name: "",
      profile_image_asset_id: "",
      principal_type: "User",
      principal_id: SUBJECT,
      team_id: TEAM,
      coding_data_retention_opt_out: false,
      refresh_token: "refresh-0",
      expires_at: new Date((T0 + 3600) * 1000).toISOString(),
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    });
    const withRowEmail = M.createGrokCredentialCodec({ now: () => now, accountEmail: "row@example.com" });
    assert.equal(withRowEmail.cliRecordFromCanonical({ access: key(T0), refresh: "r", expiresAt: 1 }, null)[SLOT].email, "row@example.com");
    const noClaims = codec.cliRecordFromCanonical({ access: key(T0, { email: undefined, team_id: undefined }), refresh: "r", expiresAt: 1 }, null);
    assert.equal("email" in noClaims[SLOT], false);
    assert.equal("team_id" in noClaims[SLOT], false);
    assert.equal(codec.cliRecordFromCanonical({ access: "opaque", refresh: "r", expiresAt: 1 }, null), null, "no subject, no slot");
    assert.equal(codec.cliRecordFromCanonical({ access: "opaque", refresh: "r", expiresAt: 1 }, { unrelated: {} }), null);
    const roundTrip = codec.canonicalFromCli(fresh);
    assert.equal(roundTrip.access, key(T0));
    assert.equal(roundTrip.refresh, "refresh-0");
    assert.equal(roundTrip.extra.user_id, SUBJECT);
    const other = codec.cliRecordFromCanonical({ access: key(T0), refresh: "r", expiresAt: 1, extra: { slotKey: "https://auth.x.ai::custom" } }, null);
    assert.deepEqual(Object.keys(other), ["https://auth.x.ai::custom"]);
    pass("a fresh slot has exactly the verified shape and is refused without a subject");
  }

  console.log(`\nPASS grok credential codec (${passes} groups)`);
}

main()
  .then(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  });
