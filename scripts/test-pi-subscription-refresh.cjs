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

globalThis.__refreshHarness = { authFile, packageRoot: PI_PACKAGE_ROOT, profileId: PROFILE_ID };

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
              provider: "anthropic",
              label: "Claude",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            }],
            defaults: { anthropic: globalThis.__refreshHarness.profileId },
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

  console.log(
    failures === 0
      ? "\nClaude subscription refresh renews credentials in place."
      : `\n${failures} refresh check(s) failed.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
