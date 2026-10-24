#!/usr/bin/env node
"use strict";

// What keeps the live slot and the user's own Claude home in step while a
// plain `claude` follows Codara, against a fake HOME:
//
//  - config-sync: MCP servers and folder trust, both ways, as a three-way
//    merge (a change or removal on one side reaches the other, the user's
//    side wins a conflict), new folders get
//    Claude Code's full default entry, nothing else moves, Codara's own
//    entries never move, a concurrent Claude Code save is never undone, a
//    symlinked ~/.claude.json is only read;
//  - mcp-oauth-import: only the MCP sign-ins the live slot lacks are copied,
//    the user's store is only read;
//  - login-adoption: a /login typed in a following terminal becomes an
//    account (new, existing, or the user's own row) and is made active;
//  - Windows shared state, through the platform seam: folders become
//    junctions (directory links here), files hard links, an empty private
//    folder is replaced, and a hard link broken by a rename is mended.
//
//   node scripts/test-claude-follow-sync.cjs

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-follow-sync-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(HOME, ".codarastudio");
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = CODARA;
process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  const main = (...parts) => JSON.stringify(path.join(ROOT, "src", "main", ...parts));
  fs.writeFileSync(
    entry,
    [
      `export * from ${main("claude-follow", "config-sync.ts")};`,
      `export * from ${main("claude-follow", "mcp-oauth-import.ts")};`,
      `export * from ${main("claude-follow", "login-adoption.ts")};`,
      `export * from ${main("claude-follow", "shared-state.ts")};`,
      `export { ensureClaudeManagedHome, sharedLinkSeams, readSharedFileLinks, sharedFileLinkRecordFile, setClaudeServersSyncedTwoWay } from ${main("orchestration", "cli-account-homes.ts")};`,
      `export { claudeLiveConfigDir, claudeLiveHome, claudeCliVaultFile, activateClaudeCliAccount, readClaudeForeignLiveLogin, readClaudeLiveSelection } from ${main("orchestration", "claude-cli-live-login.ts")};`,
      `export { ClaudeCliAccountProfileStore } from ${main("orchestration", "claude-cli-account-profiles.ts")};`,
      `export { anthropicAccountFingerprint } from ${main("orchestration", "native-cli-account-identity.ts")};`,
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
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  return require(out);
}

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`ok - ${name}`);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
}

async function main() {
  const h = await buildHarness();
  const claudeRoot = path.join(CODARA, "claude-cli");
  const live = h.claudeLiveConfigDir(claudeRoot);
  const userClaude = path.join(HOME, ".claude");
  const userFile = path.join(HOME, ".claude.json");
  const liveFile = path.join(live, ".claude.json");
  const baseFile = path.join(CODARA, "shell", "claude-follow-sync.json");
  const userHome = { configDir: userClaude, configDirEnv: null, homeDir: HOME };
  const liveHome = { configDir: live, configDirEnv: live, homeDir: path.dirname(live) };
  const sync = (extra = {}) => h.syncClaudeFollowConfig({ userHome, liveHome, baseFile, ...extra });

  // --- config-sync ------------------------------------------------------------
  writePrivate(userFile, {
    numStartups: 12,
    oauthAccount: { accountUuid: "me", emailAddress: "me@example.com" },
    mcpServers: {
      mine: { type: "http", url: "https://mine.example/mcp" },
      shared: { type: "stdio", command: "shared-v1" },
      "codara-studio": { command: "node", _sparkManaged: true },
    },
    projects: {
      "/work/a": { allowedTools: ["Bash"], hasTrustDialogAccepted: true, mcpServers: {}, lastCost: 3 },
    },
  });
  writePrivate(liveFile, {
    numStartups: 2,
    oauthAccount: { accountUuid: "managed", emailAddress: "work@example.com" },
    mcpServers: { shared: { type: "stdio", command: "shared-v1" }, added: { type: "http", url: "https://added.example/mcp" } },
    projects: {
      "/work/b": {
        allowedTools: [],
        hasTrustDialogAccepted: true,
        mcpServers: { local: { command: "local-server" } },
        enabledMcpjsonServers: ["team"],
      },
    },
  });
  let report = await sync();
  assert.equal(report.userWritable, true);
  let user = readJson(userFile);
  let liveConfig = readJson(liveFile);
  assert.deepEqual(Object.keys(user.mcpServers).sort(), ["added", "codara-studio", "mine", "shared"]);
  assert.deepEqual(Object.keys(liveConfig.mcpServers).sort(), ["added", "mine", "shared"], "Codara's own entry never moves");
  assert.equal(user.numStartups, 12, "other keys stay");
  assert.equal(user.oauthAccount.accountUuid, "me", "the user's account never changes");
  assert.equal(liveConfig.oauthAccount.accountUuid, "managed");
  assert.deepEqual(user.projects["/work/b"], {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: { local: { command: "local-server" } },
    enabledMcpjsonServers: ["team"],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  }, "a folder new to a side gets Claude Code's full default entry");
  assert.equal(user.projects["/work/a"].lastCost, 3);
  assert.equal(liveConfig.projects["/work/a"].hasTrustDialogAccepted, true);
  assert.equal(liveConfig.projects["/work/a"].lastCost, undefined, "only the synced keys move");
  assert.equal(fs.statSync(baseFile).mode & 0o777, 0o600);
  report = await sync();
  assert.deepEqual([report.toUser, report.toLive, report.deferred], [0, 0, 0], "a second pass has nothing to do");
  pass("first pass: servers and trust meet in the middle, defaults for new folders, nothing else moves");

  // Removals travel, the user wins a conflict, trust given stays given.
  user = readJson(userFile);
  delete user.mcpServers.mine;
  user.mcpServers.shared = { type: "stdio", command: "shared-user" };
  user.projects["/work/b"].hasTrustDialogAccepted = false;
  writePrivate(userFile, user);
  liveConfig = readJson(liveFile);
  delete liveConfig.mcpServers.added;
  liveConfig.mcpServers.shared = { type: "stdio", command: "shared-live" };
  delete liveConfig.projects["/work/b"].mcpServers.local;
  writePrivate(liveFile, liveConfig);
  await sync();
  user = readJson(userFile);
  liveConfig = readJson(liveFile);
  assert.deepEqual(Object.keys(user.mcpServers).sort(), ["codara-studio", "shared"]);
  assert.deepEqual(Object.keys(liveConfig.mcpServers).sort(), ["shared"]);
  assert.equal(user.mcpServers.shared.command, "shared-user");
  assert.equal(liveConfig.mcpServers.shared.command, "shared-user", "the user's side wins a conflict");
  assert.deepEqual(user.projects["/work/b"].mcpServers, {});
  assert.equal(user.projects["/work/b"].hasTrustDialogAccepted, false);
  assert.equal(liveConfig.projects["/work/b"].hasTrustDialogAccepted, false, "trust taken back on one side is taken back on the other, as Claude Code's default");
  pass("removals travel both ways (servers and trust), the user wins a conflict");

  // A concurrent Claude Code save between the read and the write wins.
  liveConfig = readJson(liveFile);
  liveConfig.mcpServers.fromLive = { command: "live-new" };
  writePrivate(liveFile, liveConfig);
  user = readJson(userFile);
  user.mcpServers.fromUser = { command: "user-new" };
  writePrivate(userFile, user);
  report = await sync({
    // The user's own Claude Code saves a server of the same name meanwhile.
    beforeWrite: async () => {
      const current = readJson(userFile);
      current.mcpServers.fromLive = { command: "user-concurrent" };
      writePrivate(userFile, current);
    },
  });
  assert.equal(report.deferred, 1);
  assert.equal(readJson(userFile).mcpServers.fromLive.command, "user-concurrent", "the concurrent save is kept");
  assert.equal(readJson(liveFile).mcpServers.fromUser.command, "user-new", "entries that did not move go through");
  report = await sync();
  assert.equal(readJson(liveFile).mcpServers.fromLive.command, "user-concurrent", "the next pass converges, the user's side winning");
  assert.equal(readJson(userFile).mcpServers.fromLive.command, "user-concurrent");
  pass("a concurrent save is never undone; the entry waits for the next pass");

  // A symlinked ~/.claude.json is only read.
  {
    const real = path.join(HOME, "dotfiles-claude.json");
    fs.renameSync(userFile, real);
    fs.symlinkSync(real, userFile);
    const before = fs.readFileSync(real);
    liveConfig = readJson(liveFile);
    liveConfig.mcpServers.whileLinked = { command: "x" };
    writePrivate(liveFile, liveConfig);
    report = await sync();
    assert.equal(report.userWritable, false);
    assert.ok(fs.readFileSync(real).equals(before));
    assert.ok(fs.lstatSync(userFile).isSymbolicLink());
    fs.rmSync(userFile);
    fs.renameSync(real, userFile);
  }
  pass("a symlinked ~/.claude.json is never written");

  // The one-way merge stands down while the sync runs both ways.
  {
    h.setClaudeServersSyncedTwoWay(true);
    liveConfig = readJson(liveFile);
    delete liveConfig.mcpServers.shared;
    writePrivate(liveFile, liveConfig);
    await h.ensureClaudeManagedHome({ home: live, root: claudeRoot, systemHome: userClaude, systemConfigDirEnv: null });
    assert.equal(readJson(liveFile).mcpServers.shared, undefined, "a server removed in a following terminal is not brought back");
    h.setClaudeServersSyncedTwoWay(false);
    await h.ensureClaudeManagedHome({ home: live, root: claudeRoot, systemHome: userClaude, systemConfigDirEnv: null });
    assert.ok(readJson(liveFile).mcpServers.shared, "without the sync, the one-way merge is back");
  }
  pass("ensureClaudeManagedHome's one-way server merge stands down while the two-way sync runs");

  // --- mcp-oauth-import ------------------------------------------------------
  {
    const userStore = path.join(userClaude, ".credentials.json");
    writePrivate(userStore, {
      claudeAiOauth: { accessToken: "USER-TOKEN", refreshToken: "USER-REFRESH", expiresAt: Date.now() + 3_600_000 },
      mcpOAuth: { "linear|1": { accessToken: "linear-user" }, "notion|2": { accessToken: "notion-user" } },
    });
    const liveStore = path.join(live, ".credentials.json");
    writePrivate(liveStore, { claudeAiOauth: { accessToken: "LIVE-TOKEN" }, mcpOAuth: { "notion|2": { accessToken: "notion-live" } } });
    const before = { bytes: fs.readFileSync(userStore), mtime: fs.statSync(userStore).mtimeMs };
    const { added } = await h.importMcpOAuthGrants({ userConfigDir: userClaude, userConfigDirEnv: null, liveConfigDir: live, options: { fileOnly: true } });
    assert.deepEqual(added, ["linear|1"]);
    const after = readJson(liveStore);
    assert.equal(after.claudeAiOauth.accessToken, "LIVE-TOKEN", "the login is never touched");
    assert.equal(after.mcpOAuth["linear|1"].accessToken, "linear-user");
    assert.equal(after.mcpOAuth["notion|2"].accessToken, "notion-live", "the live slot's own grant stays");
    assert.ok(fs.readFileSync(userStore).equals(before.bytes));
    assert.equal(fs.statSync(userStore).mtimeMs, before.mtime, "the user's store is only read");
    assert.deepEqual((await h.importMcpOAuthGrants({ userConfigDir: userClaude, userConfigDirEnv: null, liveConfigDir: live, options: { fileOnly: true } })).added, []);
  }
  pass("MCP sign-ins: only missing ones are copied, the login and the user's store are untouched");

  // --- login-adoption ----------------------------------------------------------
  {
    const store = new h.ClaudeCliAccountProfileStore(claudeRoot);
    const login = (token) => ({ accessToken: token, refreshToken: `${token}-refresh`, expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"], subscriptionType: "max" });
    const vault = (profileId, token, uuid, email) =>
      writePrivate(h.claudeCliVaultFile(claudeRoot, profileId), { version: 1, store: { claudeAiOauth: login(token) }, oauthAccount: { accountUuid: uuid, emailAddress: email } });
    const a = (await store.createProfile({ label: "Work" })).profile.id;
    const uuidA = randomUUID();
    vault(a, "TOKEN-A", uuidA, "work@example.com");
    const known = async () => (await store.snapshot()).profiles.map((profile) => profile.id);
    await h.activateClaudeCliAccount(store, a, { knownProfileIds: known, fileOnly: true });
    // A /login in a following terminal: Claude Code writes the slot.
    const terminalLogin = (token, uuid, email) => {
      const credentials = readJson(path.join(live, ".credentials.json"));
      credentials.claudeAiOauth = login(token);
      writePrivate(path.join(live, ".credentials.json"), credentials);
      const config = readJson(liveFile);
      config.oauthAccount = { accountUuid: uuid, emailAddress: email };
      writePrivate(liveFile, config);
    };
    const calls = [];
    const rows = new Map();
    const deps = {
      slot: store,
      storeOptions: { fileOnly: true },
      createCliProfile: async (label) => {
        calls.push(["create", label]);
        return (await store.createProfile({ label })).profile.id;
      },
      deleteCliProfile: async (id) => {
        calls.push(["delete", id]);
        await store.deleteProfile(id);
      },
      rowForIdentity: async (fingerprint) => rows.get(fingerprint) ?? null,
      shareCliLogin: async (cliProfileId) => {
        calls.push(["share", cliProfileId]);
        return { coraProfileId: `row-${cliProfileId}` };
      },
      useAccount: async (id) => {
        calls.push(["use", id]);
      },
    };
    assert.equal(await h.adoptFollowingTerminalLogin(deps), "none", "the slot holds its own login");

    const uuidNew = randomUUID();
    terminalLogin("TOKEN-NEW", uuidNew, "new@example.com");
    assert.equal((await h.readClaudeForeignLiveLogin(store)).accountUuid, uuidNew);
    assert.equal(await h.adoptFollowingTerminalLogin(deps), "adopted-new");
    const created = calls.find((call) => call[0] === "share")[1];
    assert.deepEqual(calls, [["create", "new@example.com"], ["share", created], ["use", `row-${created}`]]);
    assert.equal(readJson(h.claudeCliVaultFile(claudeRoot, created)).store.claudeAiOauth.accessToken, "TOKEN-NEW");
    assert.equal(readJson(h.claudeCliVaultFile(claudeRoot, a)).store.claudeAiOauth.accessToken, "TOKEN-A", "the previous account keeps its own login");
    assert.equal((await h.readClaudeLiveSelection(claudeRoot)).profileId, created);
    assert.equal(await h.readClaudeForeignLiveLogin(store), null);

    calls.length = 0;
    terminalLogin("TOKEN-A2", uuidA, "work@example.com");
    rows.set(h.anthropicAccountFingerprint(uuidA), { id: "row-work", cli: { kind: "managed", profileId: a } });
    assert.equal(await h.adoptFollowingTerminalLogin(deps), "adopted-existing");
    assert.deepEqual(calls, [["use", "row-work"]]);
    assert.equal(readJson(h.claudeCliVaultFile(claudeRoot, a)).store.claudeAiOauth.accessToken, "TOKEN-A2", "the existing account takes the new login");

    calls.length = 0;
    const uuidMe = randomUUID();
    terminalLogin("TOKEN-ME", uuidMe, "me@example.com");
    rows.set(h.anthropicAccountFingerprint(uuidMe), { id: "row-system", cli: { kind: "system" } });
    assert.equal(await h.adoptFollowingTerminalLogin(deps), "switched-to-own-login");
    assert.deepEqual(calls, [["use", "row-system"]]);
    assert.equal(readJson(path.join(userClaude, ".credentials.json")).claudeAiOauth.accessToken, "USER-TOKEN", "the user's own login is never written");
  }
  pass("a /login in a following terminal: new account, existing account, or the user's own row, each made active");

  // --- Windows shared state through the platform seam -------------------------
  {
    h.sharedLinkSeams.windowsFileSymlinks = false;
    const winRoot = path.join(CODARA, "claude-cli-win");
    const winHome = path.join(winRoot, "live", "home");
    fs.mkdirSync(path.join(winHome, "todos"), { recursive: true });
    fs.mkdirSync(path.join(winHome, "plans"), { recursive: true });
    writePrivate(path.join(winHome, "plans", "mine.md"), "private plan\n");
    fs.mkdirSync(path.join(userClaude, "projects"), { recursive: true });
    fs.mkdirSync(path.join(userClaude, "todos"), { recursive: true });
    fs.mkdirSync(path.join(userClaude, "plans"), { recursive: true });
    writePrivate(path.join(userClaude, "settings.json"), '{"theme":"dark"}\n');
    writePrivate(path.join(userClaude, "history.jsonl"), '{"display":"one"}\n');
    writePrivate(path.join(userClaude, "CLAUDE.md"), "# me\n");
    await h.ensureClaudeManagedHome({ home: winHome, root: winRoot, systemHome: userClaude, systemConfigDirEnv: null, platform: "win32" });
    assert.ok(fs.lstatSync(path.join(winHome, "projects")).isSymbolicLink(), "a folder becomes a junction");
    assert.ok(fs.lstatSync(path.join(winHome, "todos")).isSymbolicLink(), "an empty private folder becomes a junction");
    assert.ok(!fs.lstatSync(path.join(winHome, "plans")).isSymbolicLink(), "a folder with something in it stays private");
    const settings = path.join(winHome, "settings.json");
    assert.ok(!fs.lstatSync(settings).isSymbolicLink());
    assert.equal(fs.statSync(settings).ino, fs.statSync(path.join(userClaude, "settings.json")).ino, "a file becomes a hard link");
    const links = await h.readSharedFileLinks(h.sharedFileLinkRecordFile(winRoot));
    assert.deepEqual(Object.keys(links).map((entry) => path.basename(entry)).sort(), ["CLAUDE.md", "history.jsonl", "settings.json"]);
    await h.ensureClaudeManagedHome({ home: winHome, root: winRoot, systemHome: userClaude, systemConfigDirEnv: null, platform: "win32" });
    assert.equal(fs.statSync(settings).ino, fs.statSync(path.join(userClaude, "settings.json")).ino, "a hard link is kept on the next pass");

    const mend = () => h.mendSharedFileLinks({ root: winRoot, home: winHome, backupDir: path.join(CODARA, "backups", "shared"), platform: "win32" });
    const renameOver = (file, content) => {
      fs.writeFileSync(`${file}.new`, content);
      fs.renameSync(`${file}.new`, file);
    };
    // Claude Code saves settings in a following terminal by renaming a new file over the link.
    renameOver(settings, '{"theme":"light"}\n');
    let mended = await mend();
    assert.deepEqual(mended.savedToUser, ["settings.json"]);
    assert.equal(fs.readFileSync(path.join(userClaude, "settings.json"), "utf8"), '{"theme":"light"}\n', "the change reaches the user's file");
    assert.equal(fs.statSync(settings).ino, fs.statSync(path.join(userClaude, "settings.json")).ino, "and the link is whole again");
    // The user's editor saves CLAUDE.md the same way: the live side follows.
    renameOver(path.join(userClaude, "CLAUDE.md"), "# me, edited\n");
    mended = await mend();
    assert.deepEqual([mended.relinked, mended.savedToUser], [["CLAUDE.md"], []]);
    assert.equal(fs.readFileSync(path.join(winHome, "CLAUDE.md"), "utf8"), "# me, edited\n");
    // Both changed: the user's file wins, the other copy goes to Codara's backups.
    renameOver(settings, '{"theme":"live"}\n');
    renameOver(path.join(userClaude, "settings.json"), '{"theme":"user"}\n');
    mended = await mend();
    assert.deepEqual(mended.conflicts, ["settings.json"]);
    assert.equal(fs.readFileSync(settings, "utf8"), '{"theme":"user"}\n');
    assert.ok(fs.readdirSync(path.join(CODARA, "backups", "shared")).some((name) => name.startsWith("settings.json.")));
    // history.jsonl merges lines instead.
    const history = path.join(winHome, "history.jsonl");
    renameOver(history, '{"display":"one"}\n{"display":"live"}\n');
    renameOver(path.join(userClaude, "history.jsonl"), '{"display":"one"}\n{"display":"user"}\n');
    await mend();
    assert.equal(fs.readFileSync(path.join(userClaude, "history.jsonl"), "utf8"), '{"display":"one"}\n{"display":"user"}\n{"display":"live"}\n');
    assert.equal(fs.statSync(history).ino, fs.statSync(path.join(userClaude, "history.jsonl")).ino);
    // Off Windows, nothing happens.
    assert.deepEqual(await h.mendSharedFileLinks({ root: winRoot, home: winHome, backupDir: path.join(TMP, "x"), platform: "linux" }), { relinked: [], savedToUser: [], conflicts: [] });
    h.sharedLinkSeams.windowsFileSymlinks = true;
  }
  pass("Windows: junctions for folders, hard links for files, empty private folders replaced, broken hard links mended both ways");

  console.log(`\n${passes} passed`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
