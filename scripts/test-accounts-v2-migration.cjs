#!/usr/bin/env node
"use strict";

// The accounts v1 to v2 migration (accounts spec 11) against a fake HOME,
// with the owner's machine as the fixture (11.1) plus a managed account that
// is not live and a Cora-only row: the expected v2 registry, the System
// homes untouched, Cora refresh tokens stripped for rows on the System
// login, the dead personal login tombstoned, a crash before and after the
// commit resumed, and a second run that does nothing.
//
//   node scripts/test-accounts-v2-migration.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-accounts-v2-")));
process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.GROK_HOME;

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const NOW = new Date("2026-10-12T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const MAIN_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KUNIX_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const WORK_UUID = "c3333333-3333-4333-8333-333333333333";
const CODEX_MAIN = "acct-11111111-1111-4111-8111-111111111111";
const CODEX_WORK = "acct-22222222-2222-4222-8222-222222222222";
const GROK_SUBJECT = "33333333-3333-4333-8333-333333333333";
const ROW = {
  mainA: "f7ef8f54-0000-4000-8000-000000000001",
  oneA: "b4271284-0000-4000-8000-000000000002",
  workA: "a0000000-0000-4000-8000-000000000003",
  coraA: "a0000000-0000-4000-8000-000000000004",
  mainC: "a65c34aa-0000-4000-8000-000000000005",
  workC: "a0000000-0000-4000-8000-000000000006",
  oneX: "51a7666f-0000-4000-8000-000000000007",
};
const CLAUDE_MAIN = "bd5882bc-0000-4000-8000-000000000011";
const CLAUDE_WORK = "bd5882bc-0000-4000-8000-000000000012";
const CODEX_MAIN_CLI = "224c686d-0000-4000-8000-000000000021";
const CODEX_WORK_CLI = "224c686d-0000-4000-8000-000000000022";
const MATERIALIZED = "dddddddd-0000-4000-8000-000000000031";

const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * as migration from ${JSON.stringify(orchestration("accounts-v2-migration.ts"))};`,
      `export * as profiles from ${JSON.stringify(orchestration("pi-account-profiles.ts"))};`,
      `export * as claudeProfiles from ${JSON.stringify(orchestration("claude-cli-account-profiles.ts"))};`,
      `export * as codexProfiles from ${JSON.stringify(orchestration("codex-cli-account-profiles.ts"))};`,
      `export * as grokProfiles from ${JSON.stringify(orchestration("grok-cli-account-profiles.ts"))};`,
      `export * as liveLogin from ${JSON.stringify(orchestration("claude-cli-live-login.ts"))};`,
      `export * as systemLogin from ${JSON.stringify(orchestration("system-cli-login.ts"))};`,
      `export * as guard from ${JSON.stringify(path.join(ROOT, "src", "main", "outside-write-guard.ts"))};`,
    ].join("\n"),
  );
  const out = path.join(TMP, "harness.cjs");
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
        name: "accounts-v2-harness",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  return require(out);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function treeHash(target) {
  if (!fs.existsSync(target)) return "absent";
  const hash = crypto.createHash("sha256");
  const visit = (current) => {
    const stats = fs.lstatSync(current);
    hash.update(`${path.relative(target, current)}|${stats.mode}|${stats.mtimeMs}\n`);
    if (stats.isSymbolicLink()) hash.update(fs.readlinkSync(current));
    else if (stats.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
    else hash.update(fs.readFileSync(current));
  };
  visit(target);
  return hash.digest("hex");
}

const codexAuth = (accountId, refresh) => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: jwt({ email: `${accountId.slice(5, 13)}@example.com` }),
    access_token: jwt({
      exp: Math.floor(NOW.getTime() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
    refresh_token: refresh,
    account_id: accountId,
  },
});
const claudeLogin = (access, expiresAt) => ({
  version: 1,
  store: { claudeAiOauth: { accessToken: access, refreshToken: `${access}-refresh`, expiresAt, scopes: ["user:inference"] } },
});

let fixtureIndex = 0;

/** The owner's v1 machine (spec 11.1), optionally with a still-alive old personal Claude login. */
async function buildFixture(H, options = {}) {
  fixtureIndex += 1;
  const HOME = path.join(TMP, `fixture-${fixtureIndex}`, "home");
  const CODARA = path.join(HOME, ".codarastudio");
  process.env.HOME = HOME;
  process.env.CODARA_HOME_DIR = CODARA;
  H.guard.resetOutsideWriteGuardForTests();

  // The System logins: Main for Claude and Codex, the Grok subject for Grok.
  writeJson(path.join(HOME, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "system" } });
  writeJson(path.join(HOME, ".claude.json"), { oauthAccount: { accountUuid: MAIN_UUID, emailAddress: "main@example.com" } });
  writeJson(path.join(HOME, ".codex", "auth.json"), codexAuth(CODEX_MAIN, "system-codex-refresh"));
  writeJson(path.join(HOME, ".grok", "auth.json"), {
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
      key: jwt({ sub: GROK_SUBJECT, email: "grok@example.com" }),
      user_id: GROK_SUBJECT,
      refresh_token: "system-grok-refresh",
    },
  });

  const piRoot = path.join(CODARA, "pi-agent");
  const claudeRoot = path.join(CODARA, "claude-cli");
  const codexRoot = path.join(CODARA, "codex-cli");
  const grokRoot = path.join(CODARA, "grok-cli");
  const claudeIds = [CLAUDE_MAIN, CLAUDE_WORK, MATERIALIZED];
  const codexIds = [CODEX_MAIN_CLI, CODEX_WORK_CLI];
  const claudeStore = new H.claudeProfiles.ClaudeCliAccountProfileStore(claudeRoot, {
    personalConfigDir: path.join(HOME, ".claude"),
    personalConfigDirEnv: null,
    idFactory: () => claudeIds.shift(),
  });
  const codexStore = new H.codexProfiles.CodexCliAccountProfileStore(codexRoot, {
    personalHomeDir: path.join(HOME, ".codex"),
    idFactory: () => codexIds.shift(),
  });
  const grokStore = new H.grokProfiles.GrokCliAccountProfileStore(grokRoot, {
    personalHomeDir: path.join(HOME, ".grok"),
  });
  await claudeStore.createProfile({ label: "Main" });
  await claudeStore.createProfile({ label: "Work" });
  await codexStore.createProfile({ label: "Main" });
  await codexStore.createProfile({ label: "Work" });
  await grokStore.snapshot();

  // v1 Claude: Main moved into ~/.claude (live-login.json names it), its
  // vault a rotated-away copy; Work vaulted; the old personal login aside.
  writeJson(H.liveLogin.claudeCliVaultFile(claudeRoot, CLAUDE_MAIN), claudeLogin("main-old", NOW.getTime() - DAY));
  writeJson(H.liveLogin.claudeCliVaultFile(claudeRoot, CLAUDE_WORK), claudeLogin("work", NOW.getTime() + DAY));
  writeJson(path.join(claudeRoot, "live-login.json"), { version: 1, profileId: CLAUDE_MAIN });
  writeJson(
    path.join(claudeRoot, "personal-login.json"),
    claudeLogin("kunix", options.personalAlive ? NOW.getTime() + DAY : NOW.getTime() - 14 * DAY),
  );
  // v1 Codex: Main moved into ~/.codex (active-auth.json names it); vaults
  // sat beside each managed home.
  writeJson(path.join(codexRoot, "active-auth.json"), { version: 1, profileId: CODEX_MAIN_CLI });
  writeJson(path.join(codexRoot, "accounts", CODEX_MAIN_CLI, "auth.json"), codexAuth(CODEX_MAIN, "main-rotated-away"));
  writeJson(path.join(codexRoot, "accounts", CODEX_WORK_CLI, "auth.json"), codexAuth(CODEX_WORK, "work-refresh"));
  fs.rmSync(path.join(codexRoot, "accounts", CODEX_WORK_CLI, "home", "auth.json"), { force: true });

  // v1 Pi: one auth.json per row, plus the legacy single login.
  const pi = (provider, access, expires, refresh = `${access}-refresh`) => ({
    [provider]: { type: "oauth", access, refresh, expires },
  });
  const piAuth = (row) => path.join(piRoot, "accounts", row, "auth.json");
  writeJson(piAuth(ROW.mainA), pi("anthropic", "main-cora", NOW.getTime() + DAY));
  writeJson(piAuth(ROW.oneA), pi("anthropic", "kunix-cora", NOW.getTime() - 14 * DAY));
  writeJson(piAuth(ROW.workA), pi("anthropic", "work-cora", NOW.getTime() + DAY));
  writeJson(piAuth(ROW.coraA), pi("anthropic", "cora-only", NOW.getTime() + DAY));
  writeJson(piAuth(ROW.mainC), pi("openai-codex", "codex-main-cora", NOW.getTime() + DAY));
  writeJson(piAuth(ROW.workC), pi("openai-codex", "codex-work-cora", NOW.getTime() + DAY));
  writeJson(piAuth(ROW.oneX), pi("xai", "grok-cora", NOW.getTime() + DAY));
  writeJson(path.join(piRoot, "auth.json"), pi("anthropic", "legacy", NOW.getTime() + DAY));
  const at = "2026-01-01T00:00:00.000Z";
  const row = (id, provider, label, extra) => ({ id, provider, label, createdAt: at, updatedAt: at, ...extra });
  writeJson(path.join(piRoot, "account-profiles.json"), {
    version: 1,
    profiles: [
      row(ROW.mainA, "anthropic", "Main", { identityFingerprint: sha(MAIN_UUID), cliProfileId: CLAUDE_MAIN }),
      row(ROW.oneA, "anthropic", "Account 1", { identityFingerprint: sha(KUNIX_UUID), cliProfileId: "personal" }),
      row(ROW.workA, "anthropic", "Work", { identityFingerprint: sha(WORK_UUID), cliProfileId: CLAUDE_WORK }),
      row(ROW.coraA, "anthropic", "Cora only", {}),
      row(ROW.mainC, "openai-codex", "Main", { identityFingerprint: sha(CODEX_MAIN), cliProfileId: CODEX_MAIN_CLI }),
      row(ROW.workC, "openai-codex", "Work", { identityFingerprint: sha(CODEX_WORK), cliProfileId: CODEX_WORK_CLI }),
      row(ROW.oneX, "xai", "Account 1", { identityFingerprint: sha(GROK_SUBJECT), cliProfileId: "personal" }),
    ],
    defaults: { anthropic: ROW.mainA, "openai-codex": ROW.mainC, xai: ROW.oneX },
  });

  const registry = new H.profiles.PiAccountProfileRegistry(piRoot);
  const systemHashes = () => ({
    claude: treeHash(path.join(HOME, ".claude")),
    config: treeHash(path.join(HOME, ".claude.json")),
    codex: treeHash(path.join(HOME, ".codex")),
    grok: treeHash(path.join(HOME, ".grok")),
  });
  const deps = {
    codaraHome: CODARA,
    registry,
    piRootDir: piRoot,
    claudeStore,
    codexStore,
    grokStore,
    readSystemLogin: (provider) => H.systemLogin.readSystemLogin(provider, { homeDir: HOME, env: {}, platform: "linux" }),
    now: () => NOW,
  };
  return { HOME, CODARA, piRoot, claudeRoot, codexRoot, piAuth, registry, claudeStore, codexStore, deps, systemHashes };
}

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const H = await buildHarness();

  // --- The owner's machine ---------------------------------------------------
  const f = await buildFixture(H);
  const systemBefore = f.systemHashes();
  assert.equal(await f.registry.needsMigration(), true);
  await assert.rejects(
    () => f.registry.registerProfile({ provider: "anthropic", label: "x" }),
    { name: "PiAccountProfilesMigrationPendingError" },
  );
  const result = await H.migration.migrateAccountsToV2(f.deps);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.cases, {
    [ROW.mainA]: "system",
    [ROW.oneA]: "dead",
    [ROW.workA]: "managed",
    [ROW.coraA]: "cora-only",
    [ROW.mainC]: "system",
    [ROW.workC]: "managed",
    [ROW.oneX]: "system",
  });
  const v2 = readJson(path.join(f.piRoot, "account-profiles.json"));
  assert.equal(v2.version, 2);
  const byId = Object.fromEntries(v2.profiles.map((profile) => [profile.id, profile]));
  assert.deepEqual(Object.keys(byId).sort(), [ROW.mainA, ROW.workA, ROW.coraA, ROW.mainC, ROW.workC, ROW.oneX].sort());
  assert.deepEqual([byId[ROW.mainA].cli, byId[ROW.mainA].cora], [{ kind: "system" }, "borrowed"]);
  assert.deepEqual([byId[ROW.workA].cli, byId[ROW.workA].cora], [{ kind: "managed", profileId: CLAUDE_WORK }, "linked"]);
  assert.deepEqual([byId[ROW.coraA].cli, byId[ROW.coraA].cora], [{ kind: "none" }, "own"]);
  assert.deepEqual([byId[ROW.mainC].cli, byId[ROW.mainC].cora], [{ kind: "system" }, "borrowed"]);
  assert.deepEqual([byId[ROW.workC].cli, byId[ROW.workC].cora], [{ kind: "managed", profileId: CODEX_WORK_CLI }, "linked"]);
  assert.deepEqual([byId[ROW.oneX].cli, byId[ROW.oneX].cora], [{ kind: "system" }, "borrowed"]);
  assert.deepEqual(v2.defaults, { anthropic: ROW.mainA, "openai-codex": ROW.mainC, xai: ROW.oneX });
  pass("the owner's v1 accounts become the expected v2 registry with the Active rows unchanged");

  // Case a: the Cora copy of the System login's grant cannot refresh.
  assert.equal(readJson(f.piAuth(ROW.mainA)).anthropic.refresh, "");
  assert.equal(readJson(f.piAuth(ROW.mainA)).anthropic.access, "main-cora", "the access token keeps Cora working");
  assert.equal(readJson(f.piAuth(ROW.mainC))["openai-codex"].refresh, "");
  assert.equal(readJson(f.piAuth(ROW.oneX)).xai.refresh, "");
  assert.equal(readJson(f.piAuth(ROW.workA)).anthropic.refresh, "work-cora-refresh", "a managed row keeps its grant");
  // The rotated-away managed copies are retired, never placed in a home.
  const claudeIds = (await f.claudeStore.snapshot()).profiles.map((profile) => profile.id);
  assert.deepEqual(claudeIds, [CLAUDE_WORK]);
  const codexIds = (await f.codexStore.snapshot()).profiles.map((profile) => profile.id);
  assert.deepEqual(codexIds, [CODEX_WORK_CLI]);
  pass("rows on the System login borrow Cora's access without a refresh token, and their old copies retire");

  // Case b: the Codex vault became the managed home's login.
  const workHome = H.codexProfiles.codexCliManagedProfilePaths(f.codexRoot, CODEX_WORK_CLI);
  assert.equal(readJson(workHome.authFile).tokens.refresh_token, "work-refresh");
  assert.equal(fs.existsSync(path.join(workHome.profileDir, "auth.json")), false, "the v1 vault file is archived");
  assert.equal(readJson(H.liveLogin.claudeCliVaultFile(f.claudeRoot, CLAUDE_WORK)).store.claudeAiOauth.accessToken, "work");
  pass("a managed account that was not live keeps its login inside Codara's home");

  // Case c, dead: gone with a tombstone; nothing brings it back.
  assert.ok(v2.tombstones.some((entry) => entry.provider === "anthropic" && entry.identityFingerprint === sha(KUNIX_UUID)));
  assert.equal(fs.existsSync(f.piAuth(ROW.oneA)), false, "its Cora half is archived");
  assert.equal(fs.existsSync(path.join(f.claudeRoot, "personal-login.json")), false);
  await assert.rejects(
    () => f.registry.registerProfile({ provider: "anthropic", label: "kunix", identityFingerprint: sha(KUNIX_UUID) }),
    { name: "PiAccountProfileTombstonedError" },
  );
  pass("the dead old personal login is archived and tombstoned");

  // Archive and retired files.
  const archiveDir = result.archiveDir;
  assert.ok(archiveDir.startsWith(path.join(f.CODARA, "backups", "accounts-v2")));
  assert.equal(readJson(path.join(archiveDir, "pi-agent", "account-profiles.json")).version, 1);
  assert.equal(readJson(path.join(archiveDir, "claude-cli", "personal-login.json")).store.claudeAiOauth.accessToken, "kunix");
  assert.equal(readJson(path.join(archiveDir, "codex-cli", "accounts", CODEX_MAIN_CLI, "auth.json")).tokens.refresh_token, "main-rotated-away");
  assert.equal(readJson(path.join(archiveDir, "journal.json")).state, "done");
  for (const retired of [
    path.join(f.piRoot, "auth.json"),
    path.join(f.claudeRoot, "live-login.json"),
    path.join(f.codexRoot, "active-auth.json"),
  ]) {
    assert.equal(fs.existsSync(retired), false, retired);
  }
  pass("every retired v1 file is in the archive before it leaves its place");

  assert.deepEqual(f.systemHashes(), systemBefore, "~/.claude, ~/.claude.json, ~/.codex and ~/.grok are untouched");
  pass("the System homes are byte for byte and mtime for mtime unchanged");

  // A second run does nothing.
  const registryBytes = fs.readFileSync(path.join(f.piRoot, "account-profiles.json"), "utf8");
  const again = await H.migration.migrateAccountsToV2(f.deps);
  assert.equal(again.migrated, false);
  assert.equal(fs.readFileSync(path.join(f.piRoot, "account-profiles.json"), "utf8"), registryBytes);
  pass("a second run changes nothing");

  // --- A crash before the commit resumes without duplicating work ------------
  const g = await buildFixture(H, { personalAlive: true });
  const systemBeforeG = g.systemHashes();
  const commit = g.registry.commitMigration.bind(g.registry);
  g.registry.commitMigration = async () => {
    throw new Error("power cut");
  };
  await assert.rejects(() => H.migration.migrateAccountsToV2(g.deps), /power cut/);
  assert.equal(readJson(path.join(g.piRoot, "account-profiles.json")).version, 1, "nothing committed");
  const journals = fs.readdirSync(path.join(g.CODARA, "backups", "accounts-v2"));
  assert.equal(journals.length, 1);
  const journal = readJson(path.join(g.CODARA, "backups", "accounts-v2", journals[0], "journal.json"));
  assert.equal(journal.state, "planned");
  assert.equal(journal.materialized[ROW.oneA], MATERIALIZED, "the alive old personal login got a managed profile");
  g.registry.commitMigration = commit;
  const resumed = await H.migration.migrateAccountsToV2(g.deps);
  assert.equal(resumed.migrated, true);
  assert.equal(resumed.archiveDir, path.join(g.CODARA, "backups", "accounts-v2", journals[0]), "the same journal resumes");
  assert.equal(resumed.cases[ROW.oneA], "managed");
  const resumedRows = readJson(path.join(g.piRoot, "account-profiles.json")).profiles;
  assert.deepEqual(
    resumedRows.find((profile) => profile.id === ROW.oneA).cli,
    { kind: "managed", profileId: MATERIALIZED },
  );
  assert.deepEqual(
    (await g.claudeStore.snapshot()).profiles.map((profile) => profile.id).sort(),
    [CLAUDE_WORK, MATERIALIZED].sort(),
    "the resumed run reused the profile instead of making another",
  );
  assert.equal(
    readJson(H.liveLogin.claudeCliVaultFile(g.claudeRoot, MATERIALIZED)).store.claudeAiOauth.accessToken,
    "kunix",
  );
  assert.deepEqual(g.systemHashes(), systemBeforeG);
  pass("a crash before the commit resumes the same journal and reuses what it made");

  // --- A crash after the commit finishes the retirement at the next boot ----
  const archive = resumed.archiveDir;
  const journalFile = path.join(archive, "journal.json");
  writeJson(journalFile, { ...readJson(journalFile), state: "committed" });
  writeJson(path.join(g.piRoot, "auth.json"), { anthropic: { type: "oauth", access: "late" } });
  const finished = await H.migration.migrateAccountsToV2(g.deps);
  assert.equal(finished.migrated, false);
  assert.equal(readJson(journalFile).state, "done");
  assert.equal(fs.existsSync(path.join(g.piRoot, "auth.json")), false, "the retirement completed");
  pass("a crash after the commit completes the retirement at the next boot");

  // --- Old archives go after 30 days -------------------------------------------
  writeJson(journalFile, { ...readJson(journalFile), startedAt: new Date(NOW.getTime() - 31 * DAY).toISOString() });
  await H.migration.migrateAccountsToV2(g.deps);
  assert.equal(fs.existsSync(archive), false);
  pass("a finished archive is purged after 30 days");

  console.log(`\nPASS accounts v2 migration (${passes} checks)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
