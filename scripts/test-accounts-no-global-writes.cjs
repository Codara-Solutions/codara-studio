#!/usr/bin/env node
"use strict";

// The accounts invariant that matters most (spec I1 to I7): whatever Codara
// does with accounts, the user's own CLI homes stay exactly as they were.
// A fake HOME is seeded with ~/.claude, ~/.claude.json, ~/.codex and ~/.grok,
// and then, with real stores, services, mirror and Pi AuthStorage, Codara
// runs the v1 migration and the startup pass, adds a managed account for
// every CLI, switches both ways, plans launches and plain shells, writes the
// shell pointer, runs a keeper tick and mirror reconciles, deletes the
// Active accounts and boots again. Every entry of HOME outside Codara's own
// directory must be byte-identical with the same mode and mtime, with no
// new entry and no lock left behind. (The Keychain is off: this runs the
// file path that every platform shares.)
//
//   node scripts/test-accounts-no-global-writes.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-no-global-writes-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(HOME, ".codarastudio");
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = CODARA;
process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.GROK_HOME;

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const HOUR = 60 * 60 * 1000;
const SYSTEM_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CLAUDE_WORK_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CODEX_SYSTEM = "acct-11111111-1111-4111-8111-111111111111";
const CODEX_WORK = "acct-22222222-2222-4222-8222-222222222222";
const GROK_SYSTEM = "11111111-1111-4111-8111-111111111111";
const GROK_WORK = "22222222-2222-4222-8222-222222222222";
const GROK_SLOT = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const V1_CLAUDE_MAIN = "bd5882bc-0000-4000-8000-000000000011";
const V1_ROW = "f7ef8f54-0000-4000-8000-000000000001";

const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  const modules = {
    accounts: "unified-accounts.ts",
    migration: "unified-account-migration.ts",
    claudeAdapter: "account-adapters/claude-account-adapter.ts",
    codexAdapter: "account-adapters/codex-account-adapter.ts",
    grokAdapter: "account-adapters/grok-account-adapter.ts",
    claudeCodec: "account-adapters/claude-credential-codec.ts",
    codexCodec: "account-adapters/codex-credential-codec.ts",
    grokCodec: "account-adapters/grok-credential-codec.ts",
    mirror: "credential-mirror.ts",
    piStore: "pi-account-auth-store.ts",
    claudeProfiles: "claude-cli-account-profiles.ts",
    claudeExecution: "claude-cli-profile-execution.ts",
    codexProfiles: "codex-cli-account-profiles.ts",
    codexExecution: "codex-cli-profile-execution.ts",
    grokProfiles: "grok-cli-account-profiles.ts",
    grokExecution: "grok-cli-profile-execution.ts",
    liveLogin: "claude-cli-live-login.ts",
    keeper: "claude-login-keeper.ts",
    pointer: "active-cli-env-pointer.ts",
    shellDefaults: "native-cli-shell-defaults.ts",
    systemLogin: "system-cli-login.ts",
  };
  fs.writeFileSync(
    entry,
    Object.entries(modules)
      .map(([name, file]) => `export * as ${name} from ${JSON.stringify(orchestration(file))};`)
      .join("\n"),
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
        name: "no-global-writes-harness",
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
          stub(/pi-runtime-electron$/, "runtime-electron", `export async function resolveCodaraPiRuntime() { throw new Error("not used"); } export async function resolveCodaraPiLibrary() { throw new Error("not used"); } export async function resolveUserPiRuntime() { throw new Error("not used"); }`);
          stub(/pi-subscription-usage$/, "usage", `export function invalidatePiSubscriptionUsageCache() {}`);
          stub(/pi-model-catalog$/, "catalog", `export function invalidatePiModelCatalogCache() {}`);
        },
      },
    ],
  });
  return require(out);
}

async function loadAuthStorage() {
  const loaded = await import(
    pathToFileURL(path.join(PI_PACKAGE_ROOT, "dist", "core", "auth-storage.js")).href
  );
  return loaded.AuthStorage;
}

function writeFile(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

/** Every entry of HOME outside Codara's directory: kind, mode, mtime, bytes or link target. */
function snapshotHome() {
  const out = {};
  const visit = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (full === CODARA) continue;
      const stats = fs.lstatSync(full);
      const key = path.relative(HOME, full);
      if (stats.isSymbolicLink()) out[key] = `link ${fs.readlinkSync(full)}`;
      else if (stats.isDirectory()) {
        out[key] = `dir ${stats.mode & 0o7777} ${stats.mtimeMs}`;
        visit(full);
      } else out[key] = `file ${stats.mode & 0o7777} ${stats.mtimeMs} ${sha(fs.readFileSync(full))}`;
    }
  };
  visit(HOME);
  return out;
}

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const H = await buildHarness();
  const AuthStorage = await loadAuthStorage();
  const now = Date.now();

  // --- The user's machine -----------------------------------------------------
  writeFile(path.join(HOME, ".claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "system-access", refreshToken: "system-refresh", expiresAt: now + HOUR },
  }));
  writeFile(path.join(HOME, ".claude", "settings.json"), '{"theme":"dark"}', 0o644);
  writeFile(path.join(HOME, ".claude", "CLAUDE.md"), "# me\n", 0o644);
  writeFile(path.join(HOME, ".claude", "projects", "-work", "session.jsonl"), "{}\n", 0o644);
  writeFile(path.join(HOME, ".claude.json"), JSON.stringify({
    oauthAccount: { accountUuid: SYSTEM_UUID, emailAddress: "me@example.com" },
    projects: { "/work": { hasTrustDialogAccepted: true } },
    mcpServers: { posthog: { type: "http", url: "https://mcp.posthog.com/mcp" } },
  }));
  const codexAuth = (accountId, refresh) => JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email: `${accountId.slice(5, 13)}@example.com` }),
      access_token: jwt({ exp: Math.floor(now / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
      refresh_token: refresh,
      account_id: accountId,
    },
  });
  writeFile(path.join(HOME, ".codex", "auth.json"), codexAuth(CODEX_SYSTEM, "system-codex-refresh"));
  writeFile(path.join(HOME, ".codex", "config.toml"), 'model = "gpt-5"\n', 0o644);
  writeFile(path.join(HOME, ".codex", "sessions", "2026", "rollout.jsonl"), "{}\n", 0o644);
  const grokKey = (subject) => jwt({ sub: subject, exp: Math.floor(now / 1000) + 3600, email: `${subject.slice(0, 8)}@example.com` });
  writeFile(path.join(HOME, ".grok", "auth.json"), JSON.stringify({
    [GROK_SLOT]: { key: grokKey(GROK_SYSTEM), user_id: GROK_SYSTEM, refresh_token: "system-grok-refresh" },
  }));
  writeFile(path.join(HOME, ".grok", "config.toml"), 'model = "grok-4"\n', 0o644);
  fs.mkdirSync(path.join(HOME, ".grok", "skills"), { recursive: true });

  // A v1 Codara home: Claude Main had been moved into ~/.claude.
  const piRoot = path.join(CODARA, "pi-agent");
  const claudeRoot = path.join(CODARA, "claude-cli");
  const codexRoot = path.join(CODARA, "codex-cli");
  const grokRoot = path.join(CODARA, "grok-cli");
  const claudeIds = [V1_CLAUDE_MAIN];
  const claudeLeases = new H.claudeExecution.ClaudeCliProfileLeaseRegistry();
  const codexLeases = new H.codexExecution.CodexCliProfileLeaseRegistry();
  const grokLeases = new H.grokExecution.GrokCliProfileLeaseRegistry();
  const claudeStore = new H.claudeProfiles.ClaudeCliAccountProfileStore(claudeRoot, {
    personalConfigDir: path.join(HOME, ".claude"),
    personalConfigDirEnv: null,
    leases: claudeLeases,
    idFactory: () => claudeIds.shift() ?? crypto.randomUUID(),
  });
  const codexStore = new H.codexProfiles.CodexCliAccountProfileStore(codexRoot, {
    personalHomeDir: path.join(HOME, ".codex"),
    leases: codexLeases,
  });
  const grokStore = new H.grokProfiles.GrokCliAccountProfileStore(grokRoot, {
    personalHomeDir: path.join(HOME, ".grok"),
    leases: grokLeases,
  });
  await claudeStore.createProfile({ label: "Main" });
  writeFile(path.join(claudeRoot, "live-login.json"), JSON.stringify({ version: 1, profileId: V1_CLAUDE_MAIN }));
  writeFile(H.liveLogin.claudeCliVaultFile(claudeRoot, V1_CLAUDE_MAIN), JSON.stringify({
    version: 1,
    store: { claudeAiOauth: { accessToken: "old", refreshToken: "old-r", expiresAt: now - HOUR } },
  }));
  writeFile(path.join(piRoot, "accounts", V1_ROW, "auth.json"), JSON.stringify({
    anthropic: { type: "oauth", access: "main-cora", refresh: "main-cora-r", expires: now + HOUR },
  }));
  writeFile(path.join(piRoot, "account-profiles.json"), JSON.stringify({
    version: 1,
    profiles: [{
      id: V1_ROW,
      provider: "anthropic",
      label: "Main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      identityFingerprint: sha(SYSTEM_UUID),
      cliProfileId: V1_CLAUDE_MAIN,
    }],
    defaults: { anthropic: V1_ROW },
  }));

  const before = snapshotHome();
  const topLevelBefore = fs.readdirSync(HOME).sort();

  // --- Boot -------------------------------------------------------------------
  const readSystemLogin = (provider) =>
    H.systemLogin.readSystemLogin(provider, { homeDir: HOME, env: {}, platform: "linux" });
  const pointerOptions = { claudeStore, codexStore, grokStore, homeDir: CODARA };
  const refreshPointer = () => H.pointer.refreshActiveCliEnvPointer(pointerOptions);
  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => "offline" });
  const makeServices = () => {
    const common = () => ({
      piStore,
      mirror: new H.mirror.CredentialMirror({ loadAuthStorage, pollWhenWatchBlind: null, debounceMs: 20, retryDelayMs: 20 }),
      loadAuthStorage,
      invalidateCaches: async () => undefined,
      sessions: { liveOwnerIds: () => new Set() },
      readSystemLogin,
      defaultsChanged: () => refreshPointer(),
      log: () => undefined,
    });
    return {
      anthropic: new H.accounts.UnifiedAccountService(
        H.claudeAdapter.createClaudeAccountAdapter({
          store: claudeStore,
          leases: claudeLeases,
          fileOnly: true,
          platform: "linux",
          readIdentity: async () => ({}),
        }),
        common(),
      ),
      "openai-codex": new H.accounts.UnifiedAccountService(
        H.codexAdapter.createCodexAccountAdapter({ store: codexStore, leases: codexLeases, fetchImpl }),
        common(),
      ),
      xai: new H.accounts.UnifiedAccountService(
        H.grokAdapter.createGrokAccountAdapter({ store: grokStore, leases: grokLeases }),
        common(),
      ),
    };
  };
  let services = makeServices();
  const boot = () =>
    H.migration.migrateUnifiedAccounts({
      services,
      piStore,
      claudeStore,
      codexStore,
      grokStore,
      codaraHome: CODARA,
      readSystemLogin,
      refreshShellPointer: refreshPointer,
      log: () => undefined,
    });
  const first = await boot();
  assert.equal(first.failedStep, null);
  assert.equal(first.accountsV2.cases[V1_ROW], "system");
  assert.equal(await services.anthropic.systemOffer(), null, "Main already is the System row");
  assert.deepEqual(await services["openai-codex"].systemOffer(), { email: "11111111@example.com" });
  assert.equal((await piStore.registry.listProfiles()).length, 1, "the offers registered nothing");
  pass("the migration and the startup pass ran");

  // --- Add a managed account for every CLI --------------------------------------
  const connect = async (provider, label, fingerprint, credential) => {
    const target = await piStore.prepareCredentialTarget({ provider, label, identityFingerprint: fingerprint });
    const { configDir, authFile } = H.piStore.piAccountProfilePaths(piRoot, target.profile.id);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    await AuthStorage.create(authFile).modify(provider, async () => credential);
    fs.chmodSync(authFile, 0o600);
    return target.profile;
  };
  const claudeCredential = { type: "oauth", access: "work-access", refresh: "work-refresh", expires: now + 2 * HOUR };
  const claudeWork = await connect("anthropic", "Work", sha(CLAUDE_WORK_UUID), claudeCredential);
  await services.anthropic.ensureCliHalf(claudeWork.id, H.claudeCodec.canonicalFromPi(claudeCredential), {
    fingerprint: sha(CLAUDE_WORK_UUID),
    accountUuid: CLAUDE_WORK_UUID,
  });
  const codexAccess = jwt({ exp: Math.floor(now / 1000) + 7200, "https://api.openai.com/auth": { chatgpt_account_id: CODEX_WORK } });
  const codexCredential = {
    type: "oauth",
    access: codexAccess,
    refresh: "codex-work-refresh",
    expires: now + 2 * HOUR,
    accountId: CODEX_WORK,
    idToken: jwt({ email: "work@example.com" }),
  };
  const codexWork = await connect("openai-codex", "Work", sha(CODEX_WORK), codexCredential);
  await services["openai-codex"].ensureCliHalf(codexWork.id, H.codexCodec.canonicalFromCodexPi(codexCredential));
  const grokCredential = { type: "oauth", access: grokKey(GROK_WORK), refresh: "grok-work-refresh", expires: now + 2 * HOUR };
  const grokWork = await connect("xai", "Work", sha(GROK_WORK), grokCredential);
  await services.xai.ensureCliHalf(grokWork.id, H.grokCodec.canonicalFromGrokPi(grokCredential));
  pass("a managed account was added for Claude Code, Codex and Grok");

  // --- Switch both ways, planning launches each time ---------------------------
  const planLaunches = async () => {
    const claude = await H.claudeExecution.resolveClaudeCliExecutionProfile(claudeStore, { useDefault: true, baseEnv: {} });
    const codex = await H.codexExecution.resolveCodexCliExecutionProfile(codexStore, { useDefault: true, baseEnv: {} });
    const grok = await H.grokExecution.resolveGrokCliExecutionProfile(grokStore, { useDefault: true, baseEnv: {} });
    await H.shellDefaults.resolvePlainShellAccountSelectors({
      resolveClaude: async () => claude,
      resolveCodex: async () => codex,
      resolveGrok: async () => grok,
    });
    await refreshPointer();
    return { claude, codex, grok };
  };
  const rows = { anthropic: claudeWork, "openai-codex": codexWork, xai: grokWork };
  for (const [provider, row] of Object.entries(rows)) await services[provider].useAccount(row.id);
  let plans = await planLaunches();
  assert.equal(plans.claude.env.CLAUDE_CONFIG_DIR, claudeStore.liveConfigDir);
  assert.ok(plans.codex.env.CODEX_HOME.startsWith(codexRoot));
  assert.ok(plans.grok.env.GROK_HOME.startsWith(grokRoot));
  for (const service of Object.values(services)) await service.useSystemLogin();
  plans = await planLaunches();
  assert.equal(plans.claude.env.CLAUDE_CONFIG_DIR, undefined, "the System login sets no Claude home");
  for (const [provider, row] of Object.entries(rows)) await services[provider].useAccount(row.id);
  await planLaunches();
  pass("switching to the managed accounts and back to the System logins, with launches planned each time");

  // --- A keeper tick and mirror reconciles -----------------------------------------
  const tick = await H.keeper.refreshLiveClaudeLoginIfDue({
    store: claudeStore,
    fileOnly: true,
    now: () => now + 2 * HOUR,
    refresh: async () => ({ access: "work-access-2", refresh: "work-refresh-2", expires: now + 10 * HOUR }),
  });
  assert.equal(tick, "refreshed");
  for (const [provider, row] of Object.entries(rows)) {
    await services[provider].reconcileProfile(row.id);
    await services[provider].reconcileDefault();
  }
  pass("a keeper tick refreshed the live slot and the mirror reconciled every pair");

  // --- Delete the Active accounts, then boot again -----------------------------------
  for (const [provider, row] of Object.entries(rows)) {
    const result = await services[provider].deleteAccount(row.id);
    assert.equal(result.deleted, true);
  }
  for (const service of Object.values(services)) service.stop();
  services = makeServices();
  const again = await boot();
  assert.equal(again.failedStep, null);
  for (const service of Object.values(services)) service.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  pass("the Active accounts were deleted and Codara booted again");

  // --- Nothing outside Codara's home changed --------------------------------------
  const after = snapshotHome();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    assert.equal(after[key], before[key], `HOME/${key} changed`);
  }
  assert.deepEqual(fs.readdirSync(HOME).sort(), topLevelBefore, "no new entry in HOME");
  const locks = Object.keys(after).filter((key) => /\.lock$/.test(key));
  assert.deepEqual(locks, [], "no lock left in HOME");
  pass("every file and directory in HOME outside Codara's home is byte, mode and mtime identical");

  console.log(`\nPASS no global writes (${passes} checks)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
