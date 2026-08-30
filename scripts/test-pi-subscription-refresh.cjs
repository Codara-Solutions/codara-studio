"use strict";

// Codara's background token refresh, driven end to end against the REAL
// installed Pi OAuth module and the REAL Pi AuthStorage. Only Electron, the
// account registry, and vendor HTTP are stubbed.
//
// The failure this exists to catch is silent and total. Pi's Anthropic module
// combines the caller's signal with its own deadline via
// `AbortSignal.any([signal, AbortSignal.timeout(...)])`, which throws
// ERR_INVALID_ARG_TYPE when the signal is undefined — before any request is
// made. Codara called `oauth.refresh(credential)` with no signal, so every
// Claude refresh threw, the usage probe reported "session expired", and the
// account router then dropped the account from rotation: no session could
// launch, so Pi never performed the refresh that would have cleared the state.
// Both connected Claude accounts sat stranded until the user reconnected by
// hand, over and over. Codex was unaffected because its module hands the
// signal straight to fetch, where undefined is legal.
//
// So the assertion that matters is not "refresh resolved" but "the request
// actually reached the network layer, carrying a real AbortSignal".
//
//   node scripts/test-pi-subscription-refresh.cjs

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-refresh-"));
const OUTFILE = path.join(TMP, "subscription-auth.cjs");
const PROFILE_ID = "55555555-5555-4555-8555-555555555555";
const CLI_ID = "66666666-6666-4666-8666-666666666666";
// The unified account service resolves its stores from the Codara home; keep
// every directory it may touch inside this fixture and away from the Keychain.
process.env.CODARA_HOME_DIR = path.join(TMP, "codara-home");
process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

const authDir = path.join(TMP, PROFILE_ID);
fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
const authFile = path.join(authDir, "auth.json");
fs.writeFileSync(
  authFile,
  JSON.stringify({
    anthropic: {
      type: "oauth",
      access: "stale-access-token",
      refresh: "stale-refresh-token",
      // Already lapsed, so the in-lock re-check refreshes rather than short-circuits.
      expires: Date.now() - 60_000,
    },
  }),
  { mode: 0o600 },
);

globalThis.__refreshHarness = {
  authFile,
  packageRoot: PI_PACKAGE_ROOT,
  profileId: PROFILE_ID,
  cliProfileId: CLI_ID,
  provider: "anthropic",
};

const stubPlugin = {
  name: "subscription-refresh-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));

    const stub = (filter, name, contents) => {
      build.onResolve({ filter }, () => ({ path: name, namespace: "stub" }));
      build.onLoad({ filter: new RegExp(`^${name}$`), namespace: "stub" }, () => ({
        loader: "js",
        contents,
      }));
    };

    stub(/^electron$/, "electron", `
      export const BrowserWindow = { getAllWindows: () => [] };
      export const shell = { openExternal: async () => undefined };
    `);
    // The runtime resolver points at the real installed Pi, so loadOAuth and
    // loadAuthStorage import the vendor's own modules rather than a fake.
    stub(/pi-runtime-electron$/, "runtime-electron", `
      export async function resolveCodaraPiRuntime() {
        return { packageRoot: globalThis.__refreshHarness.packageRoot, version: "0.0.0" };
      }
    `);
    stub(/pi-runtime-install$/, "runtime-install", `
      export async function installPinnedPiRuntime() {}
      export function isPinnedPiRuntimeInstalling() { return false; }
    `);
    stub(/pi-runtime$/, "runtime", `export const CODARA_PI_VERSION = "0.0.0";`);
    stub(/pi-account-auth-store$/, "auth-store", `
      export async function inspectPiAccountProfileAuthStore() {
        return {
          snapshot: {
            profiles: [{
              id: globalThis.__refreshHarness.profileId,
              provider: globalThis.__refreshHarness.provider,
              label: "Account",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            }],
            defaults: { [globalThis.__refreshHarness.provider]: globalThis.__refreshHarness.profileId },
          },
          statuses: [],
          reconciliation: {
            migratedProfileIds: [],
            missingCredentialProfileIds: [],
            orphanCredentialProfileIds: [],
          },
        };
      }
      export async function resolvePiAccountRuntimeProfile() {
        return {
          accountProfileId: globalThis.__refreshHarness.profileId,
          configDir: globalThis.__refreshHarness.authFile,
          authFile: globalThis.__refreshHarness.authFile,
        };
      }
      export async function deletePiAccountCredentialProfile() {}
      // Enough registry for the repair path: one row whose CLI half is the
      // managed profile the harness writes below.
      export function defaultPiAccountAuthStore() {
        return {
          rootDir: globalThis.__refreshHarness.authFile,
          registry: {
            async getProfile(id) {
              if (id !== globalThis.__refreshHarness.profileId) return null;
              return {
                id,
                provider: globalThis.__refreshHarness.provider,
                label: "Account",
                createdAt: "2026-08-01T00:00:00.000Z",
                updatedAt: "2026-08-01T00:00:00.000Z",
                cliProfileId: globalThis.__refreshHarness.cliProfileId,
              };
            },
            async profileForCliProfileId() { return undefined; },
            async snapshot() { return { version: 1, profiles: [], defaults: {} }; },
          },
        };
      }
      export function piAccountProfilePaths(_root, id) {
        return {
          configDir: path.dirname(globalThis.__refreshHarness.authFile),
          authFile: globalThis.__refreshHarness.authFile,
        };
      }
      import path from "node:path";
      export function piAccountCredentialAccountEmail() { return undefined; }
      export function piAccountCredentialIdentityFingerprint() { return undefined; }
      export async function preparePiAccountCredentialTarget() { return {}; }
      export async function renamePiAccountProfile() { return {}; }
      export async function setDefaultPiAccountProfile() { return {}; }
      export class PiOAuthLoginGate { async acquire() { return () => {}; } }
    `);
    // Pulled in by the lazily-imported cache invalidators on the delete path.
    stub(/pi-subscription-usage$/, "usage", `
      export function invalidatePiSubscriptionUsageCache() {}
    `);
    stub(/pi-model-catalog$/, "model-catalog", `
      export function invalidatePiModelCatalogCache() {}
    `);
    stub(/anthropic-account-identity$/, "identity", `
      export async function readAnthropicAccountIdentity() { return null; }
      export async function readAnthropicAccountProfile() { return {}; }
    `);
    stub(/pi-oauth-callback-server$/, "callback-server", `
      export async function startPiOAuthCallbackServer() { throw new Error("unused"); }
    `);
    stub(/window-focus$/, "window-focus", `export function focusStudioWindow() {}`);
  },
};

async function main() {
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "pi-subscription-auth.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: OUTFILE,
    plugins: [stubPlugin],
    logLevel: "silent",
  });

  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), signal: options && options.signal });
    return new Response(
      JSON.stringify({
        access_token: "fresh-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const { refreshPiSubscriptionProfileCredential } = require(OUTFILE);

  let access;
  let thrown = null;
  try {
    access = await refreshPiSubscriptionProfileCredential(PROFILE_ID, "anthropic");
  } catch (error) {
    thrown = error;
  }

  check("a lapsed Claude credential refreshes instead of throwing", () => {
    assert.strictEqual(thrown, null, thrown && thrown.message);
    assert.strictEqual(access, "fresh-access-token");
  });

  // The regression itself: the old code threw inside AbortSignal.any, so the
  // token endpoint was never called at all.
  check("the refresh actually reaches Anthropic's token endpoint", () => {
    assert.strictEqual(calls.length, 1, `expected one token request, saw ${calls.length}`);
    assert.match(calls[0].url, /\/oauth\/token$/);
  });

  check("the request carries a real AbortSignal, as Pi's module requires", () => {
    assert.ok(calls[0].signal instanceof AbortSignal, "refresh was issued without an AbortSignal");
    assert.strictEqual(calls[0].signal.aborted, false);
  });

  check("the rotated credential is written back through Pi's own auth store", () => {
    const stored = JSON.parse(fs.readFileSync(authFile, "utf8")).anthropic;
    assert.strictEqual(stored.access, "fresh-access-token");
    assert.strictEqual(stored.refresh, "rotated-refresh-token");
    assert.ok(stored.expires > Date.now(), "refreshed credential must not already be expired");
  });

  check("the auth file stays owner-only", () => {
    if (process.platform === "win32") return;
    assert.strictEqual(fs.statSync(authFile).mode & 0o077, 0);
  });

  // The repair path. Claude Code refreshed this account in a terminal and
  // rotated the refresh token, so Cora's copy is dead: Anthropic rejects it.
  // The unified service then takes the fresher terminal copy and the refresh
  // is retried once with it, after which both files hold the new token.
  const claudeDir = path.join(
    process.env.CODARA_HOME_DIR,
    "claude-cli",
    "accounts",
    CLI_ID,
  );
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(claudeDir, 0o700);
  const claudeFile = path.join(claudeDir, ".credentials.json");
  const now = Date.now();
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "dead-access",
        refresh: "dead-refresh",
        expires: now - 60_000,
      },
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    claudeFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "terminal-access",
        refreshToken: "terminal-refresh",
        // Raw expiry: fresher than Cora's (Pi stores raw minus five minutes),
        // and still lapsed, so the retry really has to refresh.
        expiresAt: now + 250_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    }),
    { mode: 0o600 },
  );
  fs.chmodSync(claudeFile, 0o600);
  const grants = [];
  globalThis.fetch = async (url, options) => {
    const body = String(options && options.body);
    const dead = body.includes("dead-refresh");
    grants.push(dead ? "dead" : "terminal");
    if (dead) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        access_token: "repaired-access-token",
        refresh_token: "repaired-refresh-token",
        expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  let repairedAccess;
  let repairThrown = null;
  try {
    repairedAccess = await refreshPiSubscriptionProfileCredential(PROFILE_ID, "anthropic");
  } catch (error) {
    repairThrown = error;
  }
  check("a rejected refresh token is repaired from the fresher terminal copy and retried once", () => {
    assert.strictEqual(repairThrown, null, repairThrown && repairThrown.message);
    assert.strictEqual(repairedAccess, "repaired-access-token");
    assert.deepStrictEqual(grants, ["dead", "terminal"]);
  });
  check("both files converge on the repaired token", () => {
    const stored = JSON.parse(fs.readFileSync(authFile, "utf8")).anthropic;
    assert.strictEqual(stored.refresh, "repaired-refresh-token");
    const terminal = JSON.parse(fs.readFileSync(claudeFile, "utf8")).claudeAiOauth;
    assert.strictEqual(terminal.accessToken, "repaired-access-token");
    assert.strictEqual(terminal.refreshToken, "repaired-refresh-token");
    assert.strictEqual(terminal.subscriptionType, "max", "Claude-only fields survive the mirror");
    assert.strictEqual(fs.statSync(claudeFile).mode & 0o077, 0);
  });

  // The same repair for the two providers whose CLI half is a file the
  // mirror reads through its codec: a Grok managed home and a Codex vault
  // slot (the marker names personal, so the managed slot is its vault file).
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
  const cases = [
    {
      provider: "xai",
      profileId: "77777777-7777-4777-8777-777777777777",
      cliProfileId: "88888888-8888-4888-8888-888888888888",
      terminalFile: path.join(process.env.CODARA_HOME_DIR, "grok-cli", "accounts", "88888888-8888-4888-8888-888888888888", "auth.json"),
      // Opaque tokens: the slot's expires_at decides, still lapsed so the
      // retry has to refresh.
      terminalContent: (now) =>
        JSON.stringify({
          "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
            key: "terminal-access",
            auth_mode: "oidc",
            create_time: "2026-08-01T00:00:00.000Z",
            user_id: "u",
            principal_id: "u",
            principal_type: "User",
            refresh_token: "terminal-refresh",
            expires_at: new Date(now + 250_000).toISOString(),
            oidc_issuer: "https://auth.x.ai",
            oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
          },
        }),
      response: () => ({ access_token: "repaired-access-token", refresh_token: "repaired-refresh-token", expires_in: 3600 }),
      readTerminal: (file) => {
        const slot = JSON.parse(fs.readFileSync(file, "utf8"))["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"];
        return { access: slot.key, refresh: slot.refresh_token, kept: slot.auth_mode === "oidc" && slot.user_id === "u" };
      },
    },
    {
      provider: "openai-codex",
      profileId: "99999999-9999-4999-8999-999999999999",
      cliProfileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      terminalFile: path.join(process.env.CODARA_HOME_DIR, "codex-cli", "accounts", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "auth.json"),
      terminalContent: (now) =>
        JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            id_token: jwt({ exp: Math.floor((now + 30_000) / 1000), email: "codex@example.com" }),
            access_token: "terminal-access",
            refresh_token: "terminal-refresh",
            account_id: "acct-1",
          },
          last_refresh: "2026-08-01T00:00:00.000Z",
        }),
      response: () => ({
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
        refresh_token: "repaired-refresh-token",
        expires_in: 3600,
      }),
      readTerminal: (file) => {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return { access: parsed.tokens.access_token, refresh: parsed.tokens.refresh_token, kept: parsed.tokens.account_id === "acct-1" && typeof parsed.tokens.id_token === "string" };
      },
    },
  ];
  for (const testCase of cases) {
    const caseDir = path.join(TMP, testCase.provider);
    fs.mkdirSync(caseDir, { recursive: true, mode: 0o700 });
    const caseAuthFile = path.join(caseDir, "auth.json");
    globalThis.__refreshHarness = {
      ...globalThis.__refreshHarness,
      authFile: caseAuthFile,
      profileId: testCase.profileId,
      cliProfileId: testCase.cliProfileId,
      provider: testCase.provider,
    };
    const caseNow = Date.now();
    fs.writeFileSync(
      caseAuthFile,
      JSON.stringify({
        [testCase.provider]: { type: "oauth", access: "dead-access", refresh: "dead-refresh", expires: caseNow - 60_000, accountId: "acct-1" },
      }),
      { mode: 0o600 },
    );
    fs.mkdirSync(path.dirname(testCase.terminalFile), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(testCase.terminalFile), 0o700);
    fs.writeFileSync(testCase.terminalFile, testCase.terminalContent(caseNow), { mode: 0o600 });
    fs.chmodSync(testCase.terminalFile, 0o600);
    const caseGrants = [];
    globalThis.fetch = async (url, options) => {
      const body = String(options && options.body);
      const dead = body.includes("dead-refresh");
      caseGrants.push(dead ? "dead" : "terminal");
      if (dead) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(testCase.response()), { status: 200, headers: { "content-type": "application/json" } });
    };
    let caseAccess;
    let caseThrown = null;
    try {
      caseAccess = await refreshPiSubscriptionProfileCredential(testCase.profileId, testCase.provider);
    } catch (error) {
      caseThrown = error;
    }
    check(`a rejected ${testCase.provider} refresh token is repaired from the terminal copy and retried once`, () => {
      assert.strictEqual(caseThrown, null, caseThrown && caseThrown.message);
      assert.ok(caseAccess, "the retry produced an access token");
      assert.deepStrictEqual(caseGrants, ["dead", "terminal"]);
    });
    check(`both ${testCase.provider} files converge on the repaired token`, () => {
      const stored = JSON.parse(fs.readFileSync(caseAuthFile, "utf8"))[testCase.provider];
      assert.strictEqual(stored.refresh, "repaired-refresh-token");
      const terminal = testCase.readTerminal(testCase.terminalFile);
      assert.strictEqual(terminal.access, stored.access);
      assert.strictEqual(terminal.refresh, "repaired-refresh-token");
      assert.ok(terminal.kept, "provider-only fields survive the mirror");
      assert.strictEqual(fs.statSync(testCase.terminalFile).mode & 0o077, 0);
    });
  }

  console.log(
    failures === 0
      ? "\nSubscription refresh renews credentials in place for every provider."
      : `\n${failures} refresh check(s) failed.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
