"use strict";

// The sign-in flow lifecycle in src/main/orchestration/pi-subscription-auth.ts:
// a Settings panel that lost its view of a flow can get it back, an owner's
// abandoned flow never blocks its next sign-in, cancel works before the
// request id is known, a provider module that ignores its abort signal still
// releases the process-wide gate, and failures read as plain sentences rather
// than "cancelled" or a stack trace.
//
// Pi's OAuth module is replaced by a scripted fake; everything else that the
// login path touches outside the flow itself is stubbed.
//
//   node scripts/test-pi-subscription-login.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-login-"));
const OUTFILE = path.join(TMP, "subscription-auth.cjs");
const FAKE_OAUTH = path.join(TMP, "fake-oauth.mjs");

fs.writeFileSync(
  FAKE_OAUTH,
  [
    "const login = (provider) => (interaction) => globalThis.__loginHarness.login(provider, interaction);",
    'export const anthropicOAuth = { login: login("anthropic") };',
    'export const openaiCodexOAuth = { login: login("openai-codex") };',
    'export const xaiOAuth = { login: login("xai") };',
  ].join("\n"),
);

globalThis.__loginHarness = {
  fakeOAuth: FAKE_OAUTH,
  script: null,
  login(provider, interaction) {
    return this.script(provider, interaction);
  },
};

const stubPlugin = {
  name: "pi-subscription-login-harness",
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
    stub(/pi-runtime-electron$/, "runtime-electron", `
      export async function resolveCodaraPiLibrary() { return { packageRoot: "/fake", version: "0.0.0" }; }
      export async function resolveUserPiRuntime() { throw new Error("Pi is not installed"); }
    `);
    stub(/pi-runtime-install$/, "runtime-install", `
      export async function installPiCli() {}
      export function isPiCliInstalling() { return false; }
    `);
    stub(/pi-runtime$/, "runtime", `
      export const CODARA_PI_VERSION = "0.0.0";
      export const CODARA_PI_MIN_VERSION = "0.0.0";
      export async function resolvePiAiModulePath() { return globalThis.__loginHarness.fakeOAuth; }
    `);
    stub(/pi-account-auth-store$/, "auth-store", `
      export async function inspectPiAccountProfileAuthStore() {
        return { snapshot: { profiles: [], defaults: {} }, statuses: [] };
      }
      export async function resolvePiAccountRuntimeProfile() { throw new Error("unused"); }
      export async function deletePiAccountCredentialProfile() {}
      export function piAccountCredentialAccountEmail() { return undefined; }
      export function piAccountCredentialIdentityFingerprint() { return undefined; }
      export async function preparePiAccountCredentialTarget() { throw new Error("unused"); }
      export async function renamePiAccountProfile() { return {}; }
      export async function setDefaultPiAccountProfile() { return {}; }
      export class PiOAuthLoginGate {
        constructor() { this.activeRequestId = null; }
        acquire(requestId) {
          if (this.activeRequestId !== null) {
            throw new Error("Another Pi subscription login is already in progress");
          }
          this.activeRequestId = requestId;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            if (this.activeRequestId === requestId) this.activeRequestId = null;
          };
        }
      }
    `);
    stub(/unified-account-registry$/, "registry", `
      export async function terminalStatusesByProvider() { return new Map(); }
      export function unifiedAccountsFor() {
        return { switchSessionCount: async () => 0, adapter: { labels: { cliLabel: "CLI" } } };
      }
    `);
    stub(/credential-mirror$/, "mirror", `export const credentialMirror = { rearm() {} };`);
    stub(/pi-auth-storage$/, "auth-storage", `export async function loadPiAuthStorage() { throw new Error("unused"); }`);
    stub(/anthropic-account-identity$/, "identity", `export async function readAnthropicAccountProfile() { return {}; }`);
    stub(/pi-oauth-callback-server$/, "callback-server", `export async function startPiOAuthCallbackServer() { return null; }`);
    stub(/window-focus$/, "window-focus", `export function focusStudioWindow() {}`);
    stub(/pi-subscription-usage$/, "usage", `export function invalidatePiSubscriptionUsageCache() {}`);
    stub(/pi-model-catalog$/, "model-catalog", `export function invalidatePiModelCatalogCache() {}`);
    stub(/unified-account-migration$/, "migration", `export async function renewCoraAnthropicLogin() { return {}; }`);
  },
};

function makeOwner(id) {
  const events = [];
  return { id, events, emit: (event) => events.push(event) };
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A login that shows a browser URL, then waits for the abort signal (or, when
// told to, ignores it like a module whose server never checks the signal).
function browserLogin({ ignoreAbort = false, notify = true } = {}) {
  return (_provider, interaction) => new Promise((_resolve, reject) => {
    if (notify) interaction.notify({ type: "auth_url", url: "https://example.test/authorize?state=abc" });
    if (!ignoreAbort) {
      interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
    }
  });
}

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
  const auth = require(OUTFILE);
  const harness = globalThis.__loginHarness;
  auth.setPiLoginTimingForTests({ graceMs: 40 });

  // ── a remounted panel gets the open flow back ─────────────────────────────
  harness.script = browserLogin();
  const ownerA = makeOwner("window:a");
  const first = await auth.startPiSubscriptionProfileLoginForOwner({ provider: "anthropic" }, ownerA);
  await waitFor(() => ownerA.events.some((event) => event.type === "auth_url"), "auth_url should arrive");
  ownerA.events.length = 0;
  const again = await auth.startPiSubscriptionProfileLoginForOwner({ provider: "anthropic" }, ownerA);
  assert.equal(again.requestId, first.requestId, "asking again for the same account reuses the open flow");
  assert.deepEqual(
    ownerA.events.map((event) => `${event.type}:${event.requestId}`),
    [`started:${first.requestId}`, `auth_url:${first.requestId}`],
    "the reused flow replays its started and browser events",
  );
  ownerA.events.length = 0;
  const resumed = auth.resumePiSubscriptionLoginForOwner(ownerA);
  assert.equal(resumed?.requestId, first.requestId, "resume names the owner's open flow");
  assert.ok(ownerA.events.some((event) => event.type === "auth_url" && event.url.includes("authorize")));
  assert.equal(auth.resumePiSubscriptionLoginForOwner(makeOwner("window:other")), null, "resume is per owner");
  console.log("PASS a remounted panel can resume its open sign-in");

  // ── another owner hits a gate message that says what to do ────────────────
  const ownerB = makeOwner("window:b");
  await assert.rejects(
    auth.startPiSubscriptionProfileLoginForOwner({ provider: "xai" }, ownerB),
    (error) => /already in progress/.test(error.message) && /cancel it there/.test(error.message),
  );
  console.log("PASS a busy gate explains where the other sign-in is");

  // ── the same owner switching provider replaces its abandoned flow ─────────
  ownerA.events.length = 0;
  const switched = await auth.startPiSubscriptionProfileLoginForOwner({ provider: "openai-codex" }, ownerA);
  assert.notEqual(switched.requestId, first.requestId);
  assert.ok(
    !ownerA.events.some((event) => event.requestId === first.requestId && (event.type === "cancelled" || event.type === "failed")),
    "a superseded flow ends silently instead of overwriting the new panel",
  );
  console.log("PASS an owner's own abandoned flow never blocks its next sign-in");

  // ── cancel works before the panel learned its request id ──────────────────
  ownerA.events.length = 0;
  auth.cancelPiSubscriptionLoginForOwner(undefined, ownerA);
  await waitFor(() => ownerA.events.some((event) => event.type === "cancelled"), "cancel should settle");
  const cancelled = ownerA.events.find((event) => event.type === "cancelled");
  assert.equal(cancelled.requestId, switched.requestId);
  assert.equal(cancelled.message, "Sign-in cancelled.");
  const afterCancel = await auth.startPiSubscriptionProfileLoginForOwner({ provider: "xai" }, ownerB);
  assert.ok(afterCancel.requestId, "a cancel releases the gate for other owners");
  auth.cancelPiSubscriptionLoginForOwner(afterCancel.requestId, ownerB);
  await waitFor(() => ownerB.events.some((event) => event.type === "cancelled"), "owner B cancel should settle");
  console.log("PASS cancel without a request id ends the owner's flow and frees the gate");

  // ── a stall in a module that ignores its abort still frees the gate ───────
  auth.setPiLoginTimingForTests({ stallMs: 30 });
  harness.script = browserLogin({ ignoreAbort: true, notify: false });
  const ownerC = makeOwner("window:c");
  await auth.startPiSubscriptionProfileLoginForOwner({ provider: "anthropic" }, ownerC);
  await waitFor(() => ownerC.events.some((event) => event.type === "failed"), "the stall should fail the flow");
  assert.match(ownerC.events.find((event) => event.type === "failed").message, /stalled before producing a login URL/);
  assert.equal(ownerC.events.filter((event) => event.type === "failed" || event.type === "cancelled").length, 1);
  auth.setPiLoginTimingForTests({ stallMs: 45_000 });
  console.log("PASS a stalled flow fails once and releases the gate even when the module ignores abort");

  // ── a browser sign-in left open past the deadline fails and frees the gate ─
  auth.setPiLoginTimingForTests({ flowMs: 60 });
  harness.script = browserLogin({ ignoreAbort: true });
  const ownerD = makeOwner("window:d");
  await auth.startPiSubscriptionProfileLoginForOwner({ provider: "anthropic" }, ownerD);
  await waitFor(() => ownerD.events.some((event) => event.type === "failed"), "the deadline should fail the flow");
  assert.match(ownerD.events.find((event) => event.type === "failed").message, /not finished within/);
  auth.setPiLoginTimingForTests({ flowMs: 10 * 60 * 1000 });
  console.log("PASS an abandoned browser sign-in times out");

  // ── a provider timeout is a failure with a plain message, not a cancel ────
  harness.script = async () => {
    throw new Error(
      "Token exchange request failed. url=https://example.test/token; redirect_uri=http://localhost:53692/callback; response_type=authorization_code; details=TimeoutError: The operation was aborted due to timeout; stack=TimeoutError: The operation was aborted\n    at fetch (node:internal)",
    );
  };
  const ownerE = makeOwner("window:e");
  await auth.startPiSubscriptionProfileLoginForOwner({ provider: "anthropic" }, ownerE);
  await waitFor(() => ownerE.events.some((event) => event.type === "failed" || event.type === "cancelled"), "the flow should settle");
  const timedOut = ownerE.events.find((event) => event.type === "failed" || event.type === "cancelled");
  assert.equal(timedOut.type, "failed", "an 'aborted due to timeout' error is not a user cancel");
  assert.match(timedOut.message, /took too long/);
  assert.doesNotMatch(timedOut.message, /stack=|details=/);
  console.log("PASS a provider timeout reads as a failure the user can act on");

  // ── the friendly mapping ──────────────────────────────────────────────────
  assert.match(auth.friendlyPiSignInError(new Error("listen EADDRINUSE: address already in use 127.0.0.1:53692")), /sign-in port/);
  assert.match(
    auth.friendlyPiSignInError(new Error("Token exchange request failed. url=x; details=Error: HTTP request failed. status=400; url=x; body={\"error\":\"invalid_grant\"}")),
    /code expired/,
  );
  assert.equal(
    auth.friendlyPiSignInError(new Error("OAuth state mismatch; details=Error: boom; stack=Error: boom\n    at x")),
    "OAuth state mismatch",
  );
  assert.equal(auth.friendlyPiSignInError(new Error("")), "The sign-in failed. Try again.");
  console.log("PASS sign-in errors map to plain sentences without diagnostics");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
