#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-native-cli-accounts-"));
const ENTRY = path.join(TMP, "entry.ts");
const OUT = path.join(TMP, "native-cli-accounts.cjs");
const source = (name) =>
  JSON.stringify(
    path.join(ROOT, "src", "main", "orchestration", name).replace(/\.ts$/, ""),
  );

fs.writeFileSync(
  ENTRY,
  [
    `export * from ${source("native-cli-accounts.ts")};`,
    `export * from ${source("claude-cli-account-profiles.ts")};`,
    `export * from ${source("claude-cli-profile-execution.ts")};`,
    `export * from ${source("codex-cli-account-profiles.ts")};`,
    `export * from ${source("codex-cli-profile-execution.ts")};`,
    `export * from ${source("grok-cli-account-profiles.ts")};`,
    `export * from ${source("grok-cli-profile-execution.ts")};`,
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
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
];

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function privateFile(file, contents) {
  privateDir(path.dirname(file));
  fs.writeFileSync(file, contents, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

async function expectCode(promiseFactory, code) {
  let failure;
  try {
    await promiseFactory();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof mod.NativeCliAccountError);
  assert.equal(failure.code, code);
  assert.equal(
    /SECRET|auth\.json|account-profiles\.json|codara-native-cli-accounts-/i.test(
      failure.message,
    ),
    false,
    `safe error leaked implementation data: ${failure.message}`,
  );
  return failure;
}

function successResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnFailed: false,
  };
}

function assertSanitizedEnv(env, runtime, selectedPath) {
  assert.equal(env.SAFE_VALUE, "preserved");
  const upperKeys = new Set(Object.keys(env).map((key) => key.toUpperCase()));
  const runtimeOverrides =
    runtime === "claude"
      ? [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        ]
      : runtime === "grok"
        ? ["XAI_API_KEY", "GROK_API_KEY", "GROK_ACCESS_TOKEN"]
        : [
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "AZURE_OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
          ];
  for (const key of runtimeOverrides) {
    assert.equal(upperKeys.has(key), false, `${runtime} retained ${key}`);
  }
  if (runtime === "claude") {
    assert.equal(env.CLAUDE_CONFIG_DIR, selectedPath);
    assert.equal("CODEX_HOME" in env, true);
  } else if (runtime === "grok") {
    assert.equal(env.GROK_HOME, selectedPath);
  } else {
    assert.equal(env.CODEX_HOME, selectedPath);
    assert.equal("CLAUDE_CONFIG_DIR" in env, true);
  }
}

async function main() {
  const claudeRoot = path.join(TMP, "claude-store");
  const codexRoot = path.join(TMP, "codex-store");
  const grokRoot = path.join(TMP, "grok-store");
  const personalClaude = path.join(TMP, "personal-claude");
  const personalCodex = path.join(TMP, "personal-codex");
  const personalGrok = path.join(TMP, "personal-grok");
  privateDir(personalClaude);
  privateDir(personalCodex);
  privateDir(personalGrok);

  const claudeConnected = new Set([personalClaude]);
  const codexConnected = new Set([personalCodex]);
  const grokConnected = new Set([personalGrok]);
  const claudeLeases = new mod.ClaudeCliProfileLeaseRegistry();
  const codexLeases = new mod.CodexCliProfileLeaseRegistry();
  const grokLeases = new mod.GrokCliProfileLeaseRegistry();
  let claudeIdIndex = 0;
  let codexIdIndex = 4;
  let grokIdIndex = 6;
  const claudeStore = new mod.ClaudeCliAccountProfileStore(claudeRoot, {
    personalConfigDir: personalClaude,
    personalConfigDirEnv: null,
    leases: claudeLeases,
    idFactory: () => IDS[claudeIdIndex++],
    authChecker: ({ configDir }) =>
      claudeConnected.has(configDir)
        ? { connected: true }
        : { connected: false, reason: "missing" },
  });
  const codexStore = new mod.CodexCliAccountProfileStore(codexRoot, {
    personalHomeDir: personalCodex,
    leases: codexLeases,
    // Codex now carries every generic login-plan case; the fixed pool covers
    // the ids the suite asserts on and random ids serve the rest.
    idFactory: () => IDS[codexIdIndex++] ?? crypto.randomUUID(),
    authChecker: ({ homeDir }) =>
      codexConnected.has(homeDir)
        ? { connected: true }
        : { connected: false, reason: "missing" },
  });
  const grokStore = new mod.GrokCliAccountProfileStore(grokRoot, {
    personalHomeDir: personalGrok,
    leases: grokLeases,
    idFactory: () => IDS[grokIdIndex++],
    authChecker: ({ homeDir }) =>
      grokConnected.has(homeDir)
        ? { connected: true }
        : { connected: false, reason: "missing" },
  });

  const service = new mod.NativeCliAccountService({
    claudeStore,
    claudeLeases,
    codexStore,
    codexLeases,
    grokStore,
    grokLeases,
  });

  assert.throws(
    () =>
      new mod.NativeCliAccountService({
        claudeStore,
      }),
    /store and lease registry/i,
  );
  await expectCode(
    () => service.inspect("not-a-runtime"),
    "NATIVE_CLI_ACCOUNT_INVALID_RUNTIME",
  );

  const initial = await service.inspect();
  assert.deepEqual(
    initial.runtimes.map((entry) => entry.runtime),
    ["claude", "codex", "grok"],
  );
  assert.deepEqual(
    initial.runtimes.flatMap((entry) => entry.profiles),
    [
      {
        runtime: "claude",
        id: "personal",
        label: "Account 1",
        managed: false,
        isDefault: true,
        connected: true,
        inUse: false,
        status: "connected",
      },
      {
        runtime: "codex",
        id: "personal",
        label: "Account 1",
        managed: false,
        isDefault: true,
        connected: true,
        inUse: false,
        status: "connected",
      },
      {
        runtime: "grok",
        id: "personal",
        label: "Account 1",
        managed: false,
        isDefault: true,
        connected: true,
        inUse: false,
        status: "connected",
      },
    ],
  );
  const initialJson = JSON.stringify(initial);
  for (const forbidden of [
    claudeRoot,
    codexRoot,
    grokRoot,
    personalClaude,
    personalCodex,
    personalGrok,
    "SECRET",
    "auth.json",
  ]) {
    assert.equal(initialJson.includes(forbidden), false);
  }

  // Account pairing: the Codex credential's ChatGPT account id is hashed with
  // the same unsalted sha256 Pi's account store uses, so a Cora connection and
  // this sign-in can be recognised as one account. Only the digest is exposed.
  const CHATGPT_ACCOUNT_ID = "acct_11112222-3333-4444-5555-666677778888";
  // A card also shows which login it is, so the address in the sign-in's OpenID
  // claims is read alongside the account id. The claims are decoded, never
  // verified, and nothing but the address is kept.
  const CODEX_EMAIL = "codex-user@example.com";
  const jwt = (claims) =>
    [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      "not-a-real-signature",
    ].join(".");
  const EXPECTED_FINGERPRINT = crypto
    .createHash("sha256")
    .update(CHATGPT_ACCOUNT_ID)
    .digest("hex");
  const personalCodexAuth = path.join(personalCodex, "auth.json");
  privateFile(
    personalCodexAuth,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({ email: CODEX_EMAIL, sub: "SECRET" }),
        access_token: "SECRET",
        refresh_token: "SECRET",
        account_id: CHATGPT_ACCOUNT_ID,
      },
      last_refresh: "2026-07-31T10:25:19.354Z",
    }),
  );
  const beforeCredentialStat = fs.statSync(personalCodexAuth);
  const fingerprinted = await service.inspect("codex");
  const personalCodexRow = fingerprinted.runtimes[0].profiles.find(
    (profile) => profile.id === "personal",
  );
  assert.equal(personalCodexRow.accountFingerprint, EXPECTED_FINGERPRINT);
  assert.equal(personalCodexRow.email, CODEX_EMAIL);
  const fingerprintedJson = JSON.stringify(fingerprinted);
  for (const forbidden of [CHATGPT_ACCOUNT_ID, "SECRET", "account_id", "tokens"]) {
    assert.equal(
      fingerprintedJson.includes(forbidden),
      false,
      `${forbidden} must not cross the native account projection`,
    );
  }
  // Read-only: reading a credential never rewrites or touches it.
  const afterCredentialStat = fs.statSync(personalCodexAuth);
  assert.equal(
    afterCredentialStat.mtimeMs,
    beforeCredentialStat.mtimeMs,
    "reading the account id must not modify the credential file",
  );
  assert.equal(afterCredentialStat.size, beforeCredentialStat.size);

  // Claude sign-ins are fingerprinted from the account uuid Claude Code stored
  // when it signed in, which is the same uuid the Cora side captures when its
  // own login finishes. Until that file exists there is simply no digest.
  const beforeClaudeRows = (await service.inspect("claude")).runtimes[0].profiles;
  assert.equal(
    beforeClaudeRows.some((profile) => "accountFingerprint" in profile),
    false,
    "an unreadable Claude config must leave the account unpaired",
  );
  const ANTHROPIC_ACCOUNT_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const EXPECTED_CLAUDE_FINGERPRINT = crypto
    .createHash("sha256")
    .update(ANTHROPIC_ACCOUNT_UUID)
    .digest("hex");
  // personalClaude is TMP/personal-claude and the personal profile runs with no
  // CLAUDE_CONFIG_DIR, so Claude Code's config sits beside it, in TMP.
  const personalClaudeConfig = path.join(TMP, ".claude.json");
  privateFile(
    personalClaudeConfig,
    JSON.stringify({
      oauthAccount: {
        accountUuid: ANTHROPIC_ACCOUNT_UUID,
        emailAddress: "someone@example.com",
        organizationUuid: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      },
      projects: {},
      oauthAccessToken: "SECRET",
    }),
  );
  const beforeConfigStat = fs.statSync(personalClaudeConfig);
  const claudeFingerprinted = await service.inspect("claude");
  const personalClaudeRow = claudeFingerprinted.runtimes[0].profiles.find(
    (profile) => profile.id === "personal",
  );
  assert.equal(personalClaudeRow.accountFingerprint, EXPECTED_CLAUDE_FINGERPRINT);
  assert.equal(personalClaudeRow.email, "someone@example.com");
  const claudeFingerprintedJson = JSON.stringify(claudeFingerprinted);
  for (const forbidden of [
    ANTHROPIC_ACCOUNT_UUID,
    "SECRET",
    "accountUuid",
    "oauthAccount",
  ]) {
    assert.equal(
      claudeFingerprintedJson.includes(forbidden),
      false,
      `${forbidden} must not cross the native account projection`,
    );
  }
  const afterConfigStat = fs.statSync(personalClaudeConfig);
  assert.equal(
    afterConfigStat.mtimeMs,
    beforeConfigStat.mtimeMs,
    "reading the account uuid must not modify the Claude config",
  );
  assert.equal(afterConfigStat.size, beforeConfigStat.size);
  // A signed-out profile is never read for identity, however readable its
  // config: neither the digest nor the address appears.
  const signedOutClaude = (
    await new mod.NativeCliAccountService({
      claudeStore: new mod.ClaudeCliAccountProfileStore(claudeRoot, {
        personalConfigDir: personalClaude,
        personalConfigDirEnv: null,
        leases: claudeLeases,
        authChecker: () => ({ connected: false, reason: "missing" }),
      }),
      claudeLeases,
      codexStore,
      codexLeases,
    }).inspect("claude")
  ).runtimes[0].profiles;
  assert.equal(
    signedOutClaude.some(
      (profile) => "accountFingerprint" in profile || "email" in profile,
    ),
    false,
    "a signed-out Claude profile must not carry an account identity",
  );

  // Unreadable, absent, and API-key-only credentials pair with nothing rather
  // than failing the inspection.
  assert.equal(
    await mod.readCodexCliAccountFingerprint(path.join(TMP, "missing-auth.json")),
    undefined,
  );
  const malformed = path.join(TMP, "malformed-auth.json");
  privateFile(malformed, "{not json");
  assert.equal(await mod.readCodexCliAccountFingerprint(malformed), undefined);
  const apiKeyOnly = path.join(TMP, "api-key-auth.json");
  privateFile(apiKeyOnly, JSON.stringify({ OPENAI_API_KEY: "SECRET" }));
  assert.equal(await mod.readCodexCliAccountFingerprint(apiKeyOnly), undefined);
  assert.equal(
    await mod.readCodexCliAccountFingerprint(personalCodexAuth),
    EXPECTED_FINGERPRINT,
  );
  assert.deepEqual(await mod.readCodexCliAccountIdentity(personalCodexAuth), {
    fingerprint: EXPECTED_FINGERPRINT,
    email: CODEX_EMAIL,
  });
  assert.deepEqual(await mod.readCodexCliAccountIdentity(malformed), {});

  // Grok Build writes a keyed-by-issuer auth.json (`https://auth.x.ai::<client>`
  // → { user_id, email, key }), not the Codex `{ tokens }` shape. The user_id
  // is the same uuid Pi hashes from the xAI access token's `sub`, so a Cora
  // connection and this sign-in pair as one card. The email is a plaintext
  // field; xAI access tokens do not carry an `email` claim.
  const GROK_USER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const GROK_EMAIL = "first.last@example.com";
  const EXPECTED_GROK_FINGERPRINT = crypto
    .createHash("sha256")
    .update(GROK_USER_ID)
    .digest("hex");
  const grokAccess = jwt({ sub: GROK_USER_ID, scope: "openid email" });
  const personalGrokAuth = path.join(personalGrok, "auth.json");
  privateFile(
    personalGrokAuth,
    JSON.stringify({
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        key: grokAccess,
        auth_mode: "oidc",
        user_id: GROK_USER_ID,
        email: GROK_EMAIL,
        principal_id: GROK_USER_ID,
        refresh_token: "SECRET",
      },
    }),
  );
  const grokIdentity = await mod.readGrokCliAccountIdentity(personalGrokAuth);
  assert.deepEqual(grokIdentity, {
    fingerprint: EXPECTED_GROK_FINGERPRINT,
    email: GROK_EMAIL,
  });
  const grokInspected = await service.inspect("grok");
  const personalGrokRow = grokInspected.runtimes[0].profiles.find(
    (profile) => profile.id === "personal",
  );
  assert.equal(personalGrokRow.accountFingerprint, EXPECTED_GROK_FINGERPRINT);
  assert.equal(personalGrokRow.email, GROK_EMAIL);
  const grokInspectedJson = JSON.stringify(grokInspected);
  for (const forbidden of [GROK_USER_ID, "SECRET", "user_id", "refresh_token"]) {
    assert.equal(
      grokInspectedJson.includes(forbidden),
      false,
      `${forbidden} must not cross the grok account projection`,
    );
  }
  // A Codex-shaped leftover still pairs on account_id / JWT email so fixtures
  // and older dumps do not silently un-pair.
  const grokCodexShaped = path.join(TMP, "grok-codex-shaped-auth.json");
  privateFile(
    grokCodexShaped,
    JSON.stringify({
      tokens: {
        account_id: GROK_USER_ID,
        id_token: jwt({ email: GROK_EMAIL }),
        access_token: "SECRET",
      },
    }),
  );
  assert.deepEqual(await mod.readGrokCliAccountIdentity(grokCodexShaped), {
    fingerprint: EXPECTED_GROK_FINGERPRINT,
    email: GROK_EMAIL,
  });
  assert.deepEqual(await mod.readGrokCliAccountIdentity(malformed), {});

  // A sign-in file whose claims cannot be decoded still pairs on its account
  // id; only the address is dropped. Every shape below is a claims payload that
  // is not one: wrong segment count, not base64url JSON, no email claim, and an
  // email that is not one.
  for (const brokenIdToken of [
    "not-a-jwt",
    "only.two",
    "aaa.bbb.ccc.ddd",
    `${Buffer.from("{}").toString("base64url")}.%%%%.sig`,
    jwt({ sub: "no-email-claim" }),
    jwt({ email: "  " }),
    jwt({ email: "not an address" }),
    jwt({ email: `${"a".repeat(300)}@example.com` }),
    jwt({ email: 42 }),
  ]) {
    const brokenAuth = path.join(TMP, "broken-id-token-auth.json");
    privateFile(
      brokenAuth,
      JSON.stringify({
        tokens: { id_token: brokenIdToken, account_id: CHATGPT_ACCOUNT_ID },
      }),
    );
    assert.deepEqual(
      await mod.readCodexCliAccountIdentity(brokenAuth),
      { fingerprint: EXPECTED_FINGERPRINT },
      `a malformed id token must leave the account without an email: ${brokenIdToken.slice(0, 24)}`,
    );
    fs.rmSync(brokenAuth, { force: true });
  }
  assert.equal(mod.jwtEmailClaim(jwt({ email: CODEX_EMAIL })), CODEX_EMAIL);
  assert.equal(mod.jwtEmailClaim(undefined), undefined);

  // The Claude config is read the same way: only the two account fields, and a
  // config with an unusable address still pairs on its uuid.
  const brokenEmailConfig = path.join(TMP, "broken-email", ".claude.json");
  privateFile(
    brokenEmailConfig,
    JSON.stringify({
      oauthAccount: {
        accountUuid: ANTHROPIC_ACCOUNT_UUID,
        emailAddress: "not an address",
      },
    }),
  );
  assert.deepEqual(
    await mod.readClaudeCliAccountIdentity(
      path.join(TMP, "broken-email", "config"),
      null,
      path.join(TMP, "broken-email"),
    ),
    { fingerprint: EXPECTED_CLAUDE_FINGERPRINT },
  );
  assert.deepEqual(
    await mod.readClaudeCliAccountIdentity(
      path.join(TMP, "missing-config"),
      null,
      path.join(TMP, "missing-config"),
    ),
    {},
  );

  fs.rmSync(personalCodexAuth, { force: true });

  // Every CLI profile is one half of an account now: every mutation that
  // used to go through this facade is refused with one typed code, so a
  // caller learns to use the account card (accounts.login.start /
  // accounts.use on the socket). Inspection and rename still work.
  for (const runtime of ["claude", "codex", "grok"]) {
    await expectCode(
      async () => service.assertNotUnified(runtime, "personal"),
      "NATIVE_CLI_ACCOUNT_UNIFIED",
    );
    for (const gone of ["create", "setDefault", "prepareLogin", "logout", "delete", "launchPreparedLogin", "cancelPreparedLogin", "setSessionShutdown"]) {
      assert.equal(typeof service[gone], "undefined", `${gone} must not exist on the facade`);
    }
  }
  const unified = await expectCode(
    async () => service.assertNotUnified("codex", "personal"),
    "NATIVE_CLI_ACCOUNT_UNIFIED",
  );
  assert.equal(unified.runtime, "codex");
  assert.equal(unified.profileId, "personal");
  assert.match(unified.message, /one sign-in serves Cora and the CLI together/);
  const claudeCreated = await claudeStore.createProfile({ label: " Work Claude " });
  assert.equal(claudeCreated.profile.id, IDS[0]);
  const claudeManagedDir = path.join(claudeRoot, "accounts", claudeCreated.profile.id);
  claudeConnected.add(claudeManagedDir);
  const renamedClaude = await service.rename({
    runtime: "claude",
    profileId: claudeCreated.profile.id,
    label: "Claude Primary",
  });
  assert.equal(renamedClaude.profile.label, "Claude Primary");
  assert.equal(renamedClaude.profile.status, "connected");
  assert.equal(JSON.stringify(renamedClaude).includes(claudeRoot), false);
  const codexCreated = await codexStore.createProfile({ label: " Work Codex " });
  assert.equal(codexCreated.profile.id, IDS[4]);
  const renamedCodex = await service.rename({
    runtime: "codex",
    profileId: codexCreated.profile.id,
    label: "Codex Primary",
  });
  assert.equal(renamedCodex.profile.label, "Codex Primary");
  assert.equal(renamedCodex.profile.status, "sign_in_required");
  assert.equal(renamedCodex.profile.managed, true);
  const grokCreated = await grokStore.createProfile({ label: "Work Grok" });
  const renamedGrok = await service.rename({
    runtime: "grok",
    profileId: grokCreated.profile.id,
    label: "Grok Primary",
  });
  assert.equal(renamedGrok.profile.label, "Grok Primary");
  assert.equal(JSON.stringify(renamedGrok).includes(grokRoot), false);
  for (const runtime of ["claude", "codex", "grok"]) {
    await expectCode(
      () => service.rename({ runtime, profileId: "personal", label: "No" }),
      "NATIVE_CLI_ACCOUNT_PERSONAL",
    );
  }
  await expectCode(
    () => service.rename({ runtime: "codex", profileId: IDS[9] ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc", label: "Missing" }),
    "NATIVE_CLI_ACCOUNT_NOT_FOUND",
  );
  await expectCode(
    () => service.rename({ runtime: "codex", profileId: "not a profile id", label: "Missing" }),
    "NATIVE_CLI_ACCOUNT_NOT_FOUND",
  );


  // Corrupt and symlinked stores become stable typed failures without leaking
  // the injected registry bytes or filesystem locations.
  const corruptRoot = path.join(TMP, "corrupt-claude-store");
  privateDir(corruptRoot);
  privateFile(
    path.join(corruptRoot, "account-profiles.json"),
    '{"version":1,"profiles":[],"defaultProfileId":"personal","token":"SECRET_REGISTRY"}',
  );
  const corruptLeases = new mod.ClaudeCliProfileLeaseRegistry();
  const corruptStore = new mod.ClaudeCliAccountProfileStore(corruptRoot, {
    personalConfigDir: personalClaude,
    leases: corruptLeases,
    authChecker: () => ({ connected: false }),
  });
  const corruptService = new mod.NativeCliAccountService({
    claudeStore: corruptStore,
    claudeLeases: corruptLeases,
    codexStore,
    codexLeases,
  });
  const corruptError = await expectCode(
    () => corruptService.inspect("claude"),
    "NATIVE_CLI_ACCOUNT_STORE_CORRUPT",
  );
  assert.equal(corruptError.message.includes(corruptRoot), false);
  assert.equal(corruptError.message.includes("SECRET_REGISTRY"), false);

  const linkedTarget = path.join(TMP, "linked-codex-target");
  privateDir(linkedTarget);
  const linkedRoot = path.join(TMP, "linked-codex-store");
  fs.symlinkSync(linkedTarget, linkedRoot, "dir");
  const linkedLeases = new mod.CodexCliProfileLeaseRegistry();
  const linkedStore = new mod.CodexCliAccountProfileStore(linkedRoot, {
    personalHomeDir: personalCodex,
    leases: linkedLeases,
    authChecker: () => ({ connected: false }),
  });
  const linkedService = new mod.NativeCliAccountService({
    claudeStore,
    claudeLeases,
    codexStore: linkedStore,
    codexLeases: linkedLeases,
  });
  const linkedError = await expectCode(
    () => linkedService.inspect("codex"),
    "NATIVE_CLI_ACCOUNT_STORE_UNSAFE",
  );
  assert.equal(linkedError.message.includes(linkedRoot), false);

  const serviceSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "orchestration", "native-cli-accounts.ts"),
    "utf8",
  );
  assert.doesNotMatch(serviceSource, /execFile|child_process|spawn\(/);
  assert.doesNotMatch(serviceSource, /prepareLogin|logout|setDefault|sessionShutdown/);

  console.log(
    "PASS native CLI account facade: sanitized unified DTOs, hash-only Codex, Claude and Grok account fingerprints from read-only credential and config access, every mutation but rename refused in favour of the unified account services, and typed store failures",
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
