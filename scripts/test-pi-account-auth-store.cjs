"use strict";

// Focused harness for per-profile Pi credential isolation and migration.
//
//   node scripts/test-pi-account-auth-store.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-account-auth-"));
const ENTRY = path.join(
  ROOT,
  "src",
  "main",
  "orchestration",
  "pi-account-auth-store.ts",
);
const SHARED_DIR = path.join(ROOT, "src", "shared");

// Same @shared alias every sibling suite uses: this graph reaches pi-runtime.ts,
// whose runtime imports from @shared esbuild cannot resolve without the app's
// tsconfig paths.
const sharedAliasPlugin = {
  name: "pi-account-auth-store-shared-alias",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

const IDS = {
  anthropic: "20000000-0000-4000-8000-000000000001",
  openai: "20000000-0000-4000-8000-000000000002",
  extra: "20000000-0000-4000-8000-000000000003",
  orphan: "20000000-0000-4000-8000-000000000004",
};

let assertions = 0;
let failures = 0;

function check(name, condition, detail = "") {
  assertions += 1;
  if (condition) {
    console.log(`ok ${assertions} - ${name}`);
    return;
  }
  failures += 1;
  console.error(`not ok ${assertions} - ${name}${detail ? `\n  ${detail}` : ""}`);
}

async function expectThrows(name, operation, pattern) {
  let error = null;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  check(
    name,
    error instanceof Error && (!pattern || pattern.test(error.message)),
    error ? `${error.name}: ${error.message}` : "did not throw",
  );
  return error;
}

function mode(pathname) {
  return fs.statSync(pathname).mode & 0o777;
}

async function main() {
  const outfile = path.join(TMP, "pi-account-auth-store.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [sharedAliasPlugin],
  });
  const {
    PiAccountAuthStore,
    PiOAuthLoginGate,
    piAccountCredentialAccountEmail,
    piAccountCredentialIdentityFingerprint,
    piAccountProfilePaths,
  } = require(outfile);
  const { PiAccountProfileRegistry } = require(
    path.join(TMP, "pi-account-auth-store.cjs"),
  );

  // The bundled entry does not re-export the registry. Bundle its source once
  // for deterministic migration ids.
  const registryOut = path.join(TMP, "pi-account-profiles.cjs");
  await esbuild.build({
    entryPoints: [
      path.join(ROOT, "src", "main", "orchestration", "pi-account-profiles.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: registryOut,
    logLevel: "silent",
    plugins: [sharedAliasPlugin],
  });
  const Registry = require(registryOut).PiAccountProfileRegistry;

  const root = path.join(TMP, "store");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const legacy = {
    anthropic: {
      type: "oauth",
      access: "anthropic-access-must-never-leak",
      refresh: "anthropic-refresh-must-never-leak",
      expires: Date.now() + 3_600_000,
    },
    "openai-codex": {
      type: "oauth",
      access: "openai-access-must-never-leak",
      refresh: "openai-refresh-must-never-leak",
      expires: Date.now() + 3_600_000,
      accountId: "acct-private-123",
    },
    futureProvider: { type: "oauth", access: "leave-unknown-provider-alone" },
  };
  fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify(legacy), {
    mode: 0o600,
  });
  const idQueue = [IDS.anthropic, IDS.openai, IDS.extra];
  const registry = new Registry(root, {
    idFactory: () => idQueue.shift() || IDS.extra,
    now: () => new Date("2026-07-30T12:00:00.000Z"),
  });
  const store = new PiAccountAuthStore(root, registry);

  const first = await store.inspect();
  check(
    "legacy provider records migrate into one private profile directory each",
    first.snapshot.profiles.length === 2 &&
      first.statuses.every((status) => status.connected) &&
      first.reconciliation.migratedProfileIds.length === 2,
    JSON.stringify(first),
  );
  const profileByProvider = new Map(
    first.snapshot.profiles.map((profile) => [profile.provider, profile]),
  );
  const anthropicProfile = profileByProvider.get("anthropic");
  const openaiProfile = profileByProvider.get("openai-codex");
  const anthropicPaths = piAccountProfilePaths(root, anthropicProfile.id);
  const openaiPaths = piAccountProfilePaths(root, openaiProfile.id);
  check(
    "profile directories and credential files have private permissions",
    process.platform === "win32" ||
      (
        mode(anthropicPaths.configDir) === 0o700 &&
        mode(openaiPaths.configDir) === 0o700 &&
        mode(anthropicPaths.authFile) === 0o600 &&
        mode(openaiPaths.authFile) === 0o600
      ),
  );
  const anthropicDisk = JSON.parse(fs.readFileSync(anthropicPaths.authFile, "utf8"));
  const openaiDisk = JSON.parse(fs.readFileSync(openaiPaths.authFile, "utf8"));
  check(
    "each auth file contains only its owning provider",
    Object.keys(anthropicDisk).join(",") === "anthropic" &&
      Object.keys(openaiDisk).join(",") === "openai-codex",
  );
  const remainingLegacy = JSON.parse(fs.readFileSync(path.join(root, "auth.json"), "utf8"));
  check(
    "legacy retirement is atomic and preserves unknown provider records",
    Object.keys(remainingLegacy).join(",") === "futureProvider",
    JSON.stringify(remainingLegacy),
  );
  check(
    "sanitized inspection never contains token material or auth paths",
    !/must-never-leak|auth\\.json|acct-private/.test(JSON.stringify(first)),
    JSON.stringify(first),
  );
  const second = await store.inspect();
  check(
    "migration is idempotent after supported legacy entries are retired",
    second.snapshot.profiles.length === 2 &&
      second.reconciliation.migratedProfileIds.length === 0,
  );

  const defaultAnthropic = await store.resolve({ provider: "anthropic" });
  check(
    "runtime resolver returns the validated provider default and private paths",
    defaultAnthropic.accountProfileId === anthropicProfile.id &&
      defaultAnthropic.configDir === anthropicPaths.configDir &&
      defaultAnthropic.authFile === anthropicPaths.authFile,
    JSON.stringify(defaultAnthropic),
  );
  await expectThrows(
    "an explicit profile can never cross providers",
    () =>
      store.resolve({
        provider: "anthropic",
        preferredAccountProfileId: openaiProfile.id,
      }),
    /does not belong/,
  );
  await expectThrows(
    "a malformed explicit profile id never becomes a filesystem path",
    () =>
      store.resolve({
        provider: "anthropic",
        preferredAccountProfileId: "../../auth.json",
      }),
    /lowercase UUIDv4/,
  );

  const openaiFingerprint = piAccountCredentialIdentityFingerprint(
    "openai-codex",
    legacy["openai-codex"],
  );
  check(
    "OpenAI account identity becomes only a SHA-256 fingerprint",
    /^[a-f0-9]{64}$/.test(openaiFingerprint) &&
      openaiFingerprint !== legacy["openai-codex"].accountId,
  );
  // Codex's own token carries the account's OpenID claims, so its card gets an
  // address without any extra request. Anthropic's token is opaque and yields
  // none — that address comes from the connect-time profile read instead.
  const codexIdClaims = [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(JSON.stringify({ email: "codex-user@example.com" })).toString(
      "base64url",
    ),
    "not-a-real-signature",
  ].join(".");
  check(
    "a Codex credential reports the account address from its own claims",
    piAccountCredentialAccountEmail("openai-codex", {
      ...legacy["openai-codex"],
      access: codexIdClaims,
    }) === "codex-user@example.com",
  );
  check(
    "an opaque or malformed token yields no address instead of an error",
    piAccountCredentialAccountEmail("openai-codex", legacy["openai-codex"]) ===
      undefined &&
      piAccountCredentialAccountEmail("anthropic", {
        ...legacy.anthropic,
        access: codexIdClaims,
      }) === undefined,
  );
  await expectThrows(
    "reconnect rejects a different OpenAI account identity",
    () =>
      store.prepareCredentialTarget({
        provider: "openai-codex",
        profileId: openaiProfile.id,
        identityFingerprint: "f".repeat(64),
      }),
    /different account/,
  );

  // An Anthropic account connected before Codara could identify it carries no
  // digest. Reconnecting is the moment one becomes available, and stamping it
  // then is what lets the account merge with its Claude Code sign-in.
  const anthropicFingerprint = "a".repeat(64);
  check(
    "an Anthropic account starts with no identity digest",
    (await registry.getProfile(anthropicProfile.id)).identityFingerprint ===
      undefined,
  );
  await store.prepareCredentialTarget({
    provider: "anthropic",
    profileId: anthropicProfile.id,
    identityFingerprint: anthropicFingerprint,
  });
  check(
    "reconnecting records the Anthropic account digest on the existing profile",
    (await registry.getProfile(anthropicProfile.id)).identityFingerprint ===
      anthropicFingerprint,
  );
  await store.prepareCredentialTarget({
    provider: "anthropic",
    profileId: anthropicProfile.id,
    identityFingerprint: anthropicFingerprint,
  });
  check(
    "reconnecting the same account again is a no-op",
    (await registry.getProfile(anthropicProfile.id)).identityFingerprint ===
      anthropicFingerprint,
  );
  // The address is display metadata, not an identity claim: a reconnect that
  // reports a different one replaces it, and no reconnect ever invents one.
  check(
    "an Anthropic account starts with no email",
    (await registry.getProfile(anthropicProfile.id)).accountEmail === undefined,
  );
  await store.prepareCredentialTarget({
    provider: "anthropic",
    profileId: anthropicProfile.id,
    identityFingerprint: anthropicFingerprint,
    accountEmail: "someone@example.com",
  });
  check(
    "reconnecting records the account email for the card",
    (await registry.getProfile(anthropicProfile.id)).accountEmail ===
      "someone@example.com",
  );
  await store.prepareCredentialTarget({
    provider: "anthropic",
    profileId: anthropicProfile.id,
    identityFingerprint: anthropicFingerprint,
    accountEmail: "renamed@example.com",
  });
  check(
    "a changed address replaces the one on the card",
    (await registry.getProfile(anthropicProfile.id)).accountEmail ===
      "renamed@example.com",
  );
  await expectThrows(
    "an unusable address is refused rather than rendered",
    () =>
      store.prepareCredentialTarget({
        provider: "anthropic",
        profileId: anthropicProfile.id,
        identityFingerprint: anthropicFingerprint,
        accountEmail: "not an address\nX-Injected: 1",
      }),
    /control characters|Account email/,
  );
  await expectThrows(
    "reconnect rejects a different Anthropic account identity",
    () =>
      store.prepareCredentialTarget({
        provider: "anthropic",
        profileId: anthropicProfile.id,
        identityFingerprint: "b".repeat(64),
      }),
    /different account/,
  );
  // A profile with no digest of its own cannot be told apart from the account
  // that just signed in — unless another profile already claims that digest,
  // which names the sign-in outright.
  const secondAnthropic = (
    await registry.registerProfile({
      provider: "anthropic",
      label: "Second Anthropic account",
    })
  ).profile;
  await expectThrows(
    "reconnecting a digest another account claims names that account instead",
    () =>
      store.prepareCredentialTarget({
        provider: "anthropic",
        profileId: secondAnthropic.id,
        identityFingerprint: anthropicFingerprint,
      }),
    /belongs to .*already connected/,
  );
  check(
    "the refused reconnect leaves the second account's digest unset",
    (await registry.getProfile(secondAnthropic.id)).identityFingerprint ===
      undefined,
  );
  // An unknown digest on an unstamped profile is the ordinary "connected
  // before Codara could identify it" case, and still merges on reconnect.
  const unknownFingerprint = "c".repeat(64);
  await store.prepareCredentialTarget({
    provider: "anthropic",
    profileId: secondAnthropic.id,
    identityFingerprint: unknownFingerprint,
  });
  check(
    "an unclaimed digest is stamped onto the account that reconnected",
    (await registry.getProfile(secondAnthropic.id)).identityFingerprint ===
      unknownFingerprint,
  );
  await store.deleteProfile(secondAnthropic.id);

  const staged = path.join(
    path.dirname(anthropicPaths.configDir),
    `.${anthropicProfile.id}.deleting-abcdef`,
  );
  fs.renameSync(anthropicPaths.configDir, staged);
  await store.inspect();
  check(
    "reconciliation restores a credential directory when metadata deletion did not commit",
    fs.existsSync(anthropicPaths.authFile) && !fs.existsSync(staged),
  );

  await expectThrows(
    "ownership guard rejects deletion before any disk mutation",
    () =>
      store.deleteProfile(anthropicProfile.id, {
        ownershipGuard: () => true,
      }),
    /active and cannot be deleted/,
  );
  check(
    "guarded profile and credentials remain intact",
    fs.existsSync(anthropicPaths.authFile) &&
      (await registry.getProfile(anthropicProfile.id)) !== null,
  );
  await store.deleteProfile(anthropicProfile.id, {
    ownershipGuard: () => false,
  });
  check(
    "approved deletion removes metadata and credential directory",
    !fs.existsSync(anthropicPaths.configDir) &&
      (await registry.getProfile(anthropicProfile.id)) === null,
  );

  const orphanPaths = piAccountProfilePaths(root, IDS.orphan);
  fs.mkdirSync(orphanPaths.configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    orphanPaths.authFile,
    JSON.stringify({ anthropic: legacy.anthropic }),
    { mode: 0o600 },
  );
  const withOrphan = await store.inspect();
  check(
    "unregistered credential directories are reported by opaque id without token leakage",
    withOrphan.reconciliation.orphanCredentialProfileIds.includes(IDS.orphan) &&
      !JSON.stringify(withOrphan).includes("anthropic-access-must-never-leak"),
  );

  const gate = new PiOAuthLoginGate();
  const release = gate.acquire("request-a");
  await expectThrows(
    "OAuth callback flows are globally serialized",
    async () => gate.acquire("request-b"),
    /already in progress/,
  );
  release();
  const releaseAgain = gate.acquire("request-b");
  check("OAuth lease release permits the next flow", gate.active());
  releaseAgain();
  check("OAuth lease release is idempotent and clears the gate", !gate.active());

  const corruptRoot = path.join(TMP, "corrupt");
  fs.mkdirSync(corruptRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(corruptRoot, "auth.json"),
    '{"anthropic":{"type":"oauth","access":"eyJTHIS_MUST_NOT_APPEAR"',
    { mode: 0o600 },
  );
  const corruptStore = new PiAccountAuthStore(corruptRoot);
  const corruptError = await expectThrows(
    "corrupt legacy auth fails closed with a fixed safe error",
    () => corruptStore.inspect(),
    /not valid JSON/,
  );
  check(
    "corrupt-auth errors never quote token fragments",
    !String(corruptError && corruptError.message).includes("THIS_MUST_NOT_APPEAR"),
  );

  if (failures) {
    console.error(`\n${failures} of ${assertions} assertions failed`);
    process.exitCode = 1;
  } else {
    console.log(`\n${assertions} assertions passed`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
