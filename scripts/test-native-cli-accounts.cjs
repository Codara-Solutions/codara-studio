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
  } else {
    assert.equal(env.CODEX_HOME, selectedPath);
    assert.equal("CLAUDE_CONFIG_DIR" in env, true);
  }
}

async function main() {
  const claudeRoot = path.join(TMP, "claude-store");
  const codexRoot = path.join(TMP, "codex-store");
  const personalClaude = path.join(TMP, "personal-claude");
  const personalCodex = path.join(TMP, "personal-codex");
  privateDir(personalClaude);
  privateDir(personalCodex);

  const claudeConnected = new Set([personalClaude]);
  const codexConnected = new Set([personalCodex]);
  const claudeLeases = new mod.ClaudeCliProfileLeaseRegistry();
  const codexLeases = new mod.CodexCliProfileLeaseRegistry();
  let claudeIdIndex = 0;
  let codexIdIndex = 4;
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
    idFactory: () => IDS[codexIdIndex++],
    authChecker: ({ homeDir }) =>
      codexConnected.has(homeDir)
        ? { connected: true }
        : { connected: false, reason: "missing" },
  });

  const processRequests = [];
  let processBehavior = async () => successResult();
  let tokenIndex = 0;
  const baseEnv = {
    PATH: process.env.PATH,
    SAFE_VALUE: "preserved",
    CLAUDE_CONFIG_DIR: "/wrong/claude",
    CODEX_HOME: "/wrong/codex",
    anthropic_api_key: "SECRET",
    Anthropic_Auth_Token: "SECRET",
    cLaUdE_cOdE_oAuTh_ToKeN: "SECRET",
    Claude_SecureStorage_Config_Dir: "/wrong/secure",
    openai_api_key: "SECRET",
    CoDeX_ApI_KeY: "SECRET",
    codex_access_token: "SECRET",
    Azure_OpenAI_Api_Key: "SECRET",
    OpenRouter_Api_Key: "SECRET",
  };
  const service = new mod.NativeCliAccountService({
    claudeStore,
    claudeLeases,
    codexStore,
    codexLeases,
    claudeExecutable: "/opt/codara/bin/claude",
    codexExecutable: "/opt/codara/bin/codex",
    baseEnv: () => ({ ...baseEnv }),
    processTimeoutMs: 3210,
    processMaxBufferBytes: 4321,
    processRunner: async (request) => {
      processRequests.push(request);
      return processBehavior(request);
    },
    tokenFactory: () =>
      `opaque-login-token-${String(++tokenIndex).padStart(12, "0")}`,
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
    ["claude", "codex"],
  );
  assert.deepEqual(
    initial.runtimes.flatMap((entry) => entry.profiles),
    [
      {
        runtime: "claude",
        id: "personal",
        label: "Existing Claude login",
        managed: false,
        isDefault: true,
        connected: true,
        inUse: false,
        status: "connected",
      },
      {
        runtime: "codex",
        id: "personal",
        label: "Existing Codex login",
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
    personalClaude,
    personalCodex,
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
  // config — neither the digest nor the address appears.
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

  const claudeCreated = await service.create({
    runtime: "claude",
    label: " Work Claude ",
  });
  const codexCreated = await service.create({
    runtime: "codex",
    label: " Work Codex ",
  });
  assert.equal(claudeCreated.profile.id, IDS[0]);
  assert.equal(claudeCreated.profile.runtime, "claude");
  assert.equal(claudeCreated.profile.status, "sign_in_required");
  assert.equal(codexCreated.profile.id, IDS[4]);
  assert.equal(codexCreated.profile.runtime, "codex");
  assert.equal(codexCreated.profile.status, "sign_in_required");
  assert.equal(JSON.stringify(claudeCreated).includes(claudeRoot), false);
  assert.equal(JSON.stringify(codexCreated).includes(codexRoot), false);

  await expectCode(
    () =>
      service.setDefault({
        runtime: "claude",
        profileId: claudeCreated.profile.id,
      }),
    "NATIVE_CLI_ACCOUNT_NOT_CONNECTED",
  );
  await expectCode(
    () =>
      service.setDefault({
        runtime: "codex",
        profileId: codexCreated.profile.id,
      }),
    "NATIVE_CLI_ACCOUNT_NOT_CONNECTED",
  );
  await expectCode(
    () =>
      service.rename({
        runtime: "claude",
        profileId: "personal",
        label: "No",
      }),
    "NATIVE_CLI_ACCOUNT_PERSONAL",
  );
  await expectCode(
    () => service.delete({ runtime: "codex", profileId: "personal" }),
    "NATIVE_CLI_ACCOUNT_PERSONAL",
  );

  const claudeManagedDir = path.join(
    claudeRoot,
    "accounts",
    claudeCreated.profile.id,
  );
  const codexManagedHome = path.join(
    codexRoot,
    "accounts",
    codexCreated.profile.id,
  );
  claudeConnected.add(claudeManagedDir);
  codexConnected.add(codexManagedHome);
  await service.rename({
    runtime: "claude",
    profileId: claudeCreated.profile.id,
    label: "Claude Primary",
  });
  await service.rename({
    runtime: "codex",
    profileId: codexCreated.profile.id,
    label: "Codex Primary",
  });
  await service.setDefault({
    runtime: "claude",
    profileId: claudeCreated.profile.id,
  });
  await service.setDefault({
    runtime: "codex",
    profileId: codexCreated.profile.id,
  });

  const defaultDeleteCount = processRequests.length;
  await expectCode(
    () =>
      service.delete({
        runtime: "claude",
        profileId: claudeCreated.profile.id,
      }),
    "NATIVE_CLI_ACCOUNT_DEFAULT",
  );
  assert.equal(
    processRequests.length,
    defaultDeleteCount,
    "default rejection must happen before logout",
  );

  // Login preparation is path-free and reserves the selected profile until
  // the main-owned terminal launcher finishes.
  await service.setDefault({ runtime: "claude", profileId: "personal" });
  const preparation = await service.prepareLogin({
    runtime: "claude",
    profileId: claudeCreated.profile.id,
  });
  assert.deepEqual(Object.keys(preparation).sort(), [
    "expiresAt",
    "launchToken",
    "profileId",
    "runtime",
  ]);
  const preparationJson = JSON.stringify(preparation);
  assert.equal(preparationJson.includes(claudeManagedDir), false);
  assert.equal(preparationJson.includes("claude auth login"), false);
  assert.equal(preparationJson.includes("CLAUDE_CONFIG_DIR"), false);
  assert.equal(
    (
      await service.inspect("claude")
    ).runtimes[0].profiles.find(
      (profile) => profile.id === claudeCreated.profile.id,
    ).inUse,
    true,
  );
  assert.throws(
    () =>
      claudeLeases.acquire(
        claudeCreated.profile.id,
        "terminal:late-during-login",
      ),
    /being deleted/i,
  );
  await expectCode(
    () =>
      service.logout({
        runtime: "claude",
        profileId: claudeCreated.profile.id,
      }),
    "NATIVE_CLI_ACCOUNT_ACTIVE",
  );
  await expectCode(
    () =>
      service.delete({
        runtime: "claude",
        profileId: claudeCreated.profile.id,
      }),
    "NATIVE_CLI_ACCOUNT_ACTIVE",
  );

  let loginSpec;
  await service.launchPreparedLogin(preparation.launchToken, async (spec) => {
    loginSpec = spec;
    assert.equal(
      (
        await service.inspect("claude")
      ).runtimes[0].profiles.find(
        (profile) => profile.id === claudeCreated.profile.id,
      ).inUse,
      true,
    );
    return successResult();
  });
  assert.equal(loginSpec.executable, "/opt/codara/bin/claude");
  assert.deepEqual(loginSpec.args, ["auth", "login"]);
  assert.equal(loginSpec.shell, false);
  assertSanitizedEnv(loginSpec.env, "claude", claudeManagedDir);
  assert.equal(claudeLeases.isLeased(claudeCreated.profile.id), false);
  await expectCode(
    () => service.launchPreparedLogin(preparation.launchToken, async () => successResult()),
    "NATIVE_CLI_ACCOUNT_LOGIN_PLAN_INVALID",
  );

  const codexSuccessPlan = await service.prepareLogin({
    runtime: "codex",
    profileId: codexCreated.profile.id,
  });
  let codexLoginSpec;
  await service.launchPreparedLogin(
    codexSuccessPlan.launchToken,
    async (spec) => {
      codexLoginSpec = spec;
      return successResult();
    },
  );
  assert.equal(codexLoginSpec.executable, "/opt/codara/bin/codex");
  assert.deepEqual(codexLoginSpec.args, ["login"]);
  assert.equal(codexLoginSpec.shell, false);
  assertSanitizedEnv(codexLoginSpec.env, "codex", codexManagedHome);

  // Main-owned launcher failures are typed, output-free, and always release
  // the exclusive login reservation.
  for (const [result, code] of [
    [
      {
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnFailed: true,
      },
      "NATIVE_CLI_ACCOUNT_LOGIN_SPAWN_FAILED",
    ],
    [
      {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        spawnFailed: false,
      },
      "NATIVE_CLI_ACCOUNT_LOGIN_TIMEOUT",
    ],
    [
      {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        spawnFailed: false,
      },
      "NATIVE_CLI_ACCOUNT_LOGIN_SIGNAL",
    ],
    [
      {
        exitCode: 7,
        signal: null,
        timedOut: false,
        spawnFailed: false,
      },
      "NATIVE_CLI_ACCOUNT_LOGIN_FAILED",
    ],
  ]) {
    const plan = await service.prepareLogin({
      runtime: "codex",
      profileId: codexCreated.profile.id,
    });
    await expectCode(
      () => service.launchPreparedLogin(plan.launchToken, async () => result),
      code,
    );
    assert.equal(codexLeases.isLeased(codexCreated.profile.id), false);
  }
  const thrownPlan = await service.prepareLogin({
    runtime: "codex",
    profileId: codexCreated.profile.id,
  });
  await expectCode(
    () =>
      service.launchPreparedLogin(thrownPlan.launchToken, async () => {
        throw new Error(`SECRET ${codexManagedHome}`);
      }),
    "NATIVE_CLI_ACCOUNT_LOGIN_SPAWN_FAILED",
  );

  const cancelPlan = await service.prepareLogin({
    runtime: "codex",
    profileId: codexCreated.profile.id,
  });
  assert.equal(await service.cancelPreparedLogin(cancelPlan.launchToken), true);
  assert.equal(await service.cancelPreparedLogin(cancelPlan.launchToken), false);
  assert.equal(codexLeases.isLeased(codexCreated.profile.id), false);

  let fakeNow = 1000;
  const expiryService = new mod.NativeCliAccountService({
    claudeStore,
    claudeLeases,
    codexStore,
    codexLeases,
    now: () => fakeNow,
    loginPlanTtlMs: 60_000,
    tokenFactory: () => "opaque-expiring-login-token-00000001",
  });
  const expiryPlan = await expiryService.prepareLogin({
    runtime: "claude",
    profileId: claudeCreated.profile.id,
  });
  fakeNow = expiryPlan.expiresAt;
  await expectCode(
    () =>
      expiryService.launchPreparedLogin(
        expiryPlan.launchToken,
        async () => successResult(),
      ),
    "NATIVE_CLI_ACCOUNT_LOGIN_PLAN_EXPIRED",
  );
  assert.equal(claudeLeases.isLeased(claudeCreated.profile.id), false);

  // Logout uses an exact argv with shell disabled, bounded discarded output,
  // and the selected case-insensitively sanitized profile environment.
  await service.logout({
    runtime: "claude",
    profileId: claudeCreated.profile.id,
  });
  await service.logout({
    runtime: "codex",
    profileId: codexCreated.profile.id,
  });
  const claudeLogout = processRequests.at(-2);
  const codexLogout = processRequests.at(-1);
  assert.equal(claudeLogout.executable, "/opt/codara/bin/claude");
  assert.deepEqual(claudeLogout.args, ["auth", "logout"]);
  assert.equal(claudeLogout.shell, false);
  assert.equal(claudeLogout.timeoutMs, 3210);
  assert.equal(claudeLogout.maxBufferBytes, 4321);
  assertSanitizedEnv(claudeLogout.env, "claude", claudeManagedDir);
  assert.equal(codexLogout.executable, "/opt/codara/bin/codex");
  assert.deepEqual(codexLogout.args, ["logout"]);
  assert.equal(codexLogout.shell, false);
  assertSanitizedEnv(codexLogout.env, "codex", codexManagedHome);

  for (const [behavior, code] of [
    [
      async () => {
        throw new Error(`SECRET ${claudeManagedDir}`);
      },
      "NATIVE_CLI_ACCOUNT_LOGOUT_SPAWN_FAILED",
    ],
    [
      async () => ({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        spawnFailed: false,
      }),
      "NATIVE_CLI_ACCOUNT_LOGOUT_TIMEOUT",
    ],
    [
      async () => ({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        spawnFailed: false,
      }),
      "NATIVE_CLI_ACCOUNT_LOGOUT_SIGNAL",
    ],
    [
      async () => ({
        exitCode: 9,
        signal: null,
        timedOut: false,
        spawnFailed: false,
      }),
      "NATIVE_CLI_ACCOUNT_LOGOUT_FAILED",
    ],
  ]) {
    processBehavior = behavior;
    await expectCode(
      () =>
        service.logout({
          runtime: "claude",
          profileId: claudeCreated.profile.id,
        }),
      code,
    );
    assert.equal(claudeLeases.isLeased(claudeCreated.profile.id), false);
  }
  processBehavior = async () => successResult();

  // Active leases fail before process invocation. Default rotation is allowed
  // while leased because it affects only future launches.
  await service.setDefault({ runtime: "codex", profileId: "personal" });
  const releaseActive = codexLeases.acquire(
    codexCreated.profile.id,
    "manager:active-run",
  );
  const beforeActive = processRequests.length;
  await expectCode(
    () =>
      service.logout({
        runtime: "codex",
        profileId: codexCreated.profile.id,
      }),
    "NATIVE_CLI_ACCOUNT_ACTIVE",
  );
  await expectCode(
    () =>
      service.delete({
        runtime: "codex",
        profileId: codexCreated.profile.id,
      }),
    "NATIVE_CLI_ACCOUNT_ACTIVE",
  );
  await service.setDefault({
    runtime: "codex",
    profileId: codexCreated.profile.id,
  });
  assert.equal(processRequests.length, beforeActive);
  releaseActive();
  await service.setDefault({ runtime: "codex", profileId: "personal" });

  // Delete asks the CLI to log out first, but process failures are best effort
  // and cannot strand or broaden the exact isolated-directory deletion.
  const disposable = await service.create({
    runtime: "codex",
    label: "Best effort delete",
  });
  const disposableHome = path.join(
    codexRoot,
    "accounts",
    disposable.profile.id,
  );
  codexConnected.add(disposableHome);
  const beforeBestEffort = processRequests.length;
  processBehavior = async () => ({
    exitCode: 23,
    signal: null,
    timedOut: false,
    spawnFailed: false,
  });
  const bestEffortDelete = await service.delete({
    runtime: "codex",
    profileId: disposable.profile.id,
  });
  assert.equal(bestEffortDelete.deleted, true);
  assert.equal(processRequests.length, beforeBestEffort + 1);
  assert.equal(fs.existsSync(disposableHome), false);
  processBehavior = async () => successResult();

  // The façade serializes default mutation behind an in-progress deletion.
  // The queued default change therefore observes a deleted profile rather than
  // turning the target into a logged-out undeletable default mid-operation.
  const raced = await service.create({
    runtime: "claude",
    label: "Delete/default race",
  });
  const racedDir = path.join(claudeRoot, "accounts", raced.profile.id);
  claudeConnected.add(racedDir);
  let enterRunner;
  let releaseRunner;
  const runnerEntered = new Promise((resolve) => {
    enterRunner = resolve;
  });
  const runnerReleased = new Promise((resolve) => {
    releaseRunner = resolve;
  });
  processBehavior = async () => {
    enterRunner();
    await runnerReleased;
    return successResult();
  };
  const deleting = service.delete({
    runtime: "claude",
    profileId: raced.profile.id,
  });
  await runnerEntered;
  const racingDefault = service.setDefault({
    runtime: "claude",
    profileId: raced.profile.id,
  });
  releaseRunner();
  assert.equal((await deleting).deleted, true);
  await expectCode(
    () => racingDefault,
    "NATIVE_CLI_ACCOUNT_NOT_FOUND",
  );
  processBehavior = async () => successResult();

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

  // Exercise the production execFile runner itself: spawn errors, timeouts,
  // signals, and max-buffer termination yield data-only outcomes with no
  // captured stdout/stderr.
  const baseProcessRequest = {
    runtime: "codex",
    args: [],
    env: { PATH: process.env.PATH },
    shell: false,
    timeoutMs: 1000,
    maxBufferBytes: 1024,
  };
  const missing = await mod.runNativeCliAccountProcess({
    ...baseProcessRequest,
    executable: path.join(TMP, "missing-executable"),
  });
  assert.equal(missing.spawnFailed, true);
  assert.equal(JSON.stringify(missing).includes(TMP), false);

  const timeoutScript = path.join(TMP, "timeout-child.cjs");
  fs.writeFileSync(timeoutScript, "setTimeout(() => {}, 10_000);");
  const timedOut = await mod.runNativeCliAccountProcess({
    ...baseProcessRequest,
    executable: process.execPath,
    args: [timeoutScript],
    timeoutMs: 25,
  });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.signal, "SIGTERM");

  const signalScript = path.join(TMP, "signal-child.cjs");
  fs.writeFileSync(signalScript, 'process.kill(process.pid, "SIGTERM");');
  const signaled = await mod.runNativeCliAccountProcess({
    ...baseProcessRequest,
    executable: process.execPath,
    args: [signalScript],
  });
  assert.equal(signaled.timedOut, false);
  assert.equal(signaled.signal, "SIGTERM");

  const noisyScript = path.join(TMP, "noisy-child.cjs");
  fs.writeFileSync(
    noisyScript,
    'process.stdout.write("SECRET_OUTPUT".repeat(10000));',
  );
  const noisy = await mod.runNativeCliAccountProcess({
    ...baseProcessRequest,
    executable: process.execPath,
    args: [noisyScript],
    maxBufferBytes: 64,
  });
  assert.notEqual(noisy.exitCode, 0);
  assert.equal(JSON.stringify(noisy).includes("SECRET_OUTPUT"), false);

  const serviceSource = fs.readFileSync(
    path.join(
      ROOT,
      "src",
      "main",
      "orchestration",
      "native-cli-accounts.ts",
    ),
    "utf8",
  );
  assert.equal(/\bexec\s*\(/.test(serviceSource), false);
  assert.equal(/shell:\s*true/.test(serviceSource), false);
  assert.match(serviceSource, /execFile\(/);
  assert.match(serviceSource, /maxBuffer:\s*request\.maxBufferBytes/);

  console.log(
    "PASS native CLI account façade: sanitized unified DTOs, hash-only Codex and Claude account fingerprints from read-only credential and config access, opaque exclusive login plans, exact bounded CLI processes, typed failures, race safety, and guarded deletion",
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
