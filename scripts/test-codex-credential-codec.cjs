#!/usr/bin/env node
"use strict";

// The Codex credential codec: shape conversion between Codex CLI's auth.json
// and Pi's openai-codex credential, expiry derived from the access JWT, and
// the previous-wins merge that keeps id_token and account_id through a
// Pi-originated rotation. Also the atomic private-file store every codec
// writes through.
//
//   node scripts/test-codex-credential-codec.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-codex-codec-"));
const HOURS_240 = 240 * 60 * 60 * 1000;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const ACCOUNT = "acct-11111111-2222-4333-8444-555555555555";
const accessToken = (iatSeconds, extra = {}) =>
  jwt({
    iat: iatSeconds,
    exp: iatSeconds + 240 * 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT },
    ...extra,
  });
const idToken = (iatSeconds, email = "codex@example.com") =>
  jwt({ iat: iatSeconds, exp: iatSeconds + 3600, email });

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function build() {
  const entry = path.join(TMP, "entry.ts");
  const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(orchestration("account-adapters/codex-credential-codec.ts"))};`,
      `export * as mirror from ${JSON.stringify(orchestration("credential-mirror.ts"))};`,
      `export * as files from ${JSON.stringify(orchestration("native-cli-atomic-file.ts"))};`,
    ].join("\n"),
  );
  const out = path.join(TMP, "codec.cjs");
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
  const codec = M.createCodexCredentialCodec({ now: () => now });

  // auth.json -> canonical: expiry and issue time from the access JWT.
  {
    const file = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken(T0),
        access_token: accessToken(T0),
        refresh_token: "refresh-1",
        account_id: ACCOUNT,
      },
      last_refresh: "2026-08-01T00:00:00.000Z",
    };
    const canonical = codec.canonicalFromCli(file);
    assert.equal(canonical.access, file.tokens.access_token);
    assert.equal(canonical.refresh, "refresh-1");
    assert.equal(canonical.expiresAt, (T0 + 240 * 3600) * 1000);
    assert.equal(canonical.issuedAt, T0 * 1000);
    assert.deepEqual(canonical.extra, {
      idToken: file.tokens.id_token,
      accountId: ACCOUNT,
      authMode: "chatgpt",
    });
    assert.equal(codec.canonicalFromCli(null), null);
    assert.equal(codec.canonicalFromCli({ auth_mode: "chatgpt" }), null);
    assert.equal(codec.canonicalFromCli({ tokens: { refresh_token: "r" } }), null);
    pass("auth.json converts with the access JWT's exp and iat");

    // Fallbacks: an opaque access token uses the id_token's exp, then
    // last_refresh plus the 240h lifetime; account_id falls back to the JWT.
    const opaque = {
      tokens: { id_token: idToken(T0 + 5), access_token: "opaque-access", refresh_token: "r" },
      last_refresh: "2026-08-01T00:00:00.000Z",
    };
    assert.equal(codec.canonicalFromCli(opaque).expiresAt, (T0 + 5 + 3600) * 1000);
    assert.equal(codec.canonicalFromCli(opaque).issuedAt, Date.parse("2026-08-01T00:00:00.000Z"));
    const dated = { tokens: { access_token: "opaque", refresh_token: "r" }, last_refresh: "2026-08-01T00:00:00.000Z" };
    assert.equal(codec.canonicalFromCli(dated).expiresAt, Date.parse("2026-08-01T00:00:00.000Z") + HOURS_240);
    const noDate = { tokens: { access_token: "opaque", refresh_token: "r" } };
    assert.equal(codec.canonicalFromCli(noDate).expiresAt, 0);
    assert.equal(codec.canonicalFromCli(noDate).issuedAt, undefined);
    const noAccountId = { tokens: { access_token: accessToken(T0), refresh_token: "r" } };
    assert.equal(codec.canonicalFromCli(noAccountId).extra.accountId, ACCOUNT);
    pass("expiry falls back to id_token, then last_refresh + 240h; account id falls back to the JWT");
  }

  // Pi -> canonical: the same JWT expiry, so both sides compare one number.
  {
    const pi = {
      type: "oauth",
      access: accessToken(T0),
      refresh: "refresh-1",
      expires: T0 * 1000 + 12345,
      accountId: ACCOUNT,
    };
    const canonical = codec.canonicalFromPi(pi);
    assert.equal(canonical.expiresAt, (T0 + 240 * 3600) * 1000, "Pi's drifted expires is ignored when the JWT has exp");
    assert.equal(canonical.issuedAt, T0 * 1000);
    assert.deepEqual(canonical.extra, { accountId: ACCOUNT });
    const opaque = codec.canonicalFromPi({ type: "oauth", access: "opaque", refresh: "r", expires: 42 });
    assert.equal(opaque.expiresAt, 42);
    assert.equal(opaque.issuedAt, undefined);
    assert.equal(codec.canonicalFromPi({ type: "oauth", access: "opaque", refresh: "r" }), null);
    assert.equal(codec.canonicalFromPi({ type: "api_key", key: "x" }), null);
    const withIdToken = codec.canonicalFromPi({ ...pi, idToken: idToken(T0) });
    assert.equal(withIdToken.extra.idToken, idToken(T0));
    pass("a Pi credential derives its expiry from the same JWT and carries the account id");

    // Identical access on both sides is in sync even when Pi's expires drifted.
    const fromFile = codec.canonicalFromCli({
      tokens: { access_token: pi.access, refresh_token: "refresh-1", id_token: idToken(T0), account_id: ACCOUNT },
      last_refresh: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(M.mirror.compareCredentials(canonical, fromFile), "equal");
    pass("the same token in both shapes compares equal under expires drift");
  }

  // canonical -> Pi: JWT expiry, accountId from extra then previous then the JWT.
  {
    const canonical = { access: accessToken(T0), refresh: "r2", expiresAt: (T0 + 240 * 3600) * 1000, extra: { idToken: idToken(T0), accountId: ACCOUNT } };
    const record = codec.piRecordFromCanonical(canonical, { type: "oauth", accountId: "previous" });
    assert.deepEqual(record, {
      type: "oauth",
      access: canonical.access,
      refresh: "r2",
      expires: canonical.expiresAt,
      accountId: ACCOUNT,
      idToken: idToken(T0),
    });
    const fromPrevious = codec.piRecordFromCanonical({ ...canonical, extra: {} }, { type: "oauth", accountId: "previous" });
    assert.equal(fromPrevious.accountId, "previous");
    assert.equal("idToken" in fromPrevious, false);
    const fromJwt = codec.piRecordFromCanonical({ ...canonical, extra: {} });
    assert.equal(fromJwt.accountId, ACCOUNT);
    assert.deepEqual(codec.canonicalFromPi(record), { ...canonical, issuedAt: T0 * 1000 });
    pass("the Pi record carries the JWT expiry and the account id, and round-trips");
  }

  // canonical -> auth.json: previous wins, id_token and account_id survive,
  // last_refresh is stamped; a fresh file without id_token is refused.
  {
    const previous = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken(T0, "old@example.com"),
        access_token: accessToken(T0),
        refresh_token: "refresh-1",
        account_id: ACCOUNT,
        custom: "kept",
      },
      last_refresh: "2026-08-01T00:00:00.000Z",
      extra_top_level: true,
    };
    const rotated = { access: accessToken(T0 + 100), refresh: "refresh-2", expiresAt: (T0 + 100 + 240 * 3600) * 1000, extra: { accountId: "other-id" } };
    const merged = codec.cliRecordFromCanonical(rotated, previous);
    assert.equal(merged.tokens.access_token, rotated.access);
    assert.equal(merged.tokens.refresh_token, "refresh-2");
    assert.equal(merged.tokens.id_token, previous.tokens.id_token, "id_token survives a Pi rotation");
    assert.equal(merged.tokens.account_id, ACCOUNT, "previous account_id wins");
    assert.equal(merged.tokens.custom, "kept");
    assert.equal(merged.auth_mode, "chatgpt");
    assert.equal(merged.OPENAI_API_KEY, null);
    assert.equal(merged.extra_top_level, true);
    assert.equal(merged.last_refresh, now.toISOString());
    assert.equal(codec.cliRecordFromCanonical(rotated, null), null, "no id_token anywhere: nothing Codex would accept");
    const grown = codec.cliRecordFromCanonical({ ...rotated, extra: { idToken: idToken(T0 + 100), accountId: ACCOUNT } }, null);
    assert.deepEqual(grown, {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken(T0 + 100),
        access_token: rotated.access,
        refresh_token: "refresh-2",
        account_id: ACCOUNT,
      },
      last_refresh: now.toISOString(),
    });
    const fromJwtAccount = codec.cliRecordFromCanonical({ ...rotated, extra: { idToken: idToken(T0) } }, null);
    assert.equal(fromJwtAccount.tokens.account_id, ACCOUNT, "a fresh file reads the account id off the JWT");
    assert.deepEqual(codec.canonicalFromCli(grown), {
      access: rotated.access,
      refresh: "refresh-2",
      expiresAt: rotated.expiresAt,
      issuedAt: (T0 + 100) * 1000,
      extra: { idToken: idToken(T0 + 100), accountId: ACCOUNT, authMode: "chatgpt" },
    });
    pass("previous-wins merge keeps id_token and account_id; a fresh file needs an id_token");
  }

  // The atomic private-file store: 0600 files in 0700 directories, symlink
  // and world-readable destinations refused, unreadable input reported.
  {
    const dir = path.join(TMP, "store", "nested");
    const file = path.join(dir, "auth.json");
    await M.files.atomicWritePrivateFile(file, JSON.stringify({ a: 1 }));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(await M.files.readPrivateJsonFile(file), { kind: "value", value: { a: 1 } });
    assert.deepEqual(await M.files.readPrivateJsonFile(path.join(dir, "missing.json")), { kind: "none" });
    fs.writeFileSync(path.join(dir, "broken.json"), "{{{", { mode: 0o600 });
    assert.deepEqual(await M.files.readPrivateJsonFile(path.join(dir, "broken.json")), { kind: "unreadable", reason: "invalid" });
    fs.writeFileSync(path.join(dir, "public.json"), "{}", { mode: 0o644 });
    assert.deepEqual(await M.files.readPrivateJsonFile(path.join(dir, "public.json")), { kind: "unreadable", reason: "unsafe" });
    await assert.rejects(() => M.files.atomicWritePrivateFile(path.join(dir, "public.json"), "{}"), /not private/);
    assert.equal(fs.readFileSync(path.join(dir, "public.json"), "utf8"), "{}", "a world-readable file is left untouched");
    const target = path.join(dir, "elsewhere.json");
    fs.writeFileSync(target, "{}", { mode: 0o600 });
    fs.symlinkSync(target, path.join(dir, "link.json"));
    await assert.rejects(() => M.files.atomicWritePrivateFile(path.join(dir, "link.json"), '{"b":2}'), /not a regular file/);
    assert.equal(fs.readFileSync(target, "utf8"), "{}", "nothing is written through a symlink");
    assert.deepEqual(await M.files.readPrivateJsonFile(path.join(dir, "link.json")), { kind: "unreadable", reason: "unsafe" });
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false, "no temporary is left behind");
    await M.files.atomicCopyPrivateFile(file, path.join(dir, "copy.json"));
    assert.equal(fs.statSync(path.join(dir, "copy.json")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(dir, "copy.json"), "utf8"), JSON.stringify({ a: 1 }));
    assert.equal(await M.files.removePrivateFile(path.join(dir, "copy.json")), true);
    assert.equal(await M.files.removePrivateFile(path.join(dir, "copy.json")), false);
    pass("the private-file store writes 0600 atomically and refuses symlinks and public files");
  }

  console.log(`\nPASS codex credential codec (${passes} groups)`);
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
