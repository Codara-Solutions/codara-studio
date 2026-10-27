#!/usr/bin/env node
"use strict";

// Folder trust for the Claude Code sessions Codara starts (claude-pretrust.ts):
// which folder Claude Code 2.1.311 records trust under (the physical repository
// root, a worktree's own root, or the folder itself outside a repository),
// which folders Codara may trust (a workspace or a worktree made from one,
// never an imported pull request), and how the record is written (added only,
// every other key kept, under Claude Code's lock, never holding a launch).
//
// SAFETY: HOME and CODARA_HOME_DIR point into a throwaway directory before the
// module loads, every write goes to a temporary CLAUDE_CONFIG_DIR, and the
// real configs are hashed before and after.
//
//   node scripts/test-claude-pretrust.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const REAL_FILES = [
  path.join(os.homedir(), ".claude.json"),
  path.join(os.homedir(), ".codarastudio", "claude-cli", "live", "home", ".claude.json"),
];
const digest = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "<absent>";
  }
};
const REAL_DIGESTS = REAL_FILES.map(digest);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-pretrust-")));
process.env.HOME = path.join(TMP, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.CODARA_HOME_DIR = path.join(TMP, "codara");
for (const key of ["SPARK_HOME_DIR", "SPARK_USER_DATA_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_IGNORE_PERSISTED_TRUST"]) {
  delete process.env[key];
}
fs.mkdirSync(process.env.HOME, { recursive: true });

let passes = 0;
async function check(name, fn) {
  await fn();
  passes += 1;
  console.log(`PASS ${name}`);
}

async function load() {
  const outfile = path.join(TMP, "claude-pretrust.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "claude-pretrust.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    plugins: [
      {
        name: "electron-stub",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
          pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(ROOT)}, getPath: () => ${JSON.stringify(TMP)} }; export const safeStorage = {}; export const BrowserWindow = { getAllWindows: () => [] };`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const startup = path.join(TMP, "manual-agent-startup.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "manual-agent-startup.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: startup,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const sync = path.join(TMP, "config-sync.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "claude-follow", "config-sync.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: sync,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  return { ...require(outfile), ...require(startup), sync: require(sync) };
}

function git(cwd, ...args) {
  require("node:child_process").execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

/**
 * <TMP>/fs/
 *   plain/deep            a folder outside any repository
 *   repo/sub              a repository and a folder inside it
 *   repo-wt               a worktree of repo (its .git is a file)
 *   link -> .             a symlink to the whole tree
 */
function layout() {
  const base = path.join(TMP, "fs");
  const at = (...parts) => path.join(base, ...parts);
  fs.mkdirSync(at("plain", "deep"), { recursive: true });
  fs.mkdirSync(at("repo", "sub"), { recursive: true });
  git(at("repo"), "init", "-q");
  git(at("repo"), "commit", "-q", "--allow-empty", "-m", "init");
  git(at("repo"), "worktree", "add", "-q", at("repo-wt"), "-b", "wt");
  fs.symlinkSync(base, at("link"));
  // A repository cloned or vendored inside the workspace's, and a submodule.
  fs.mkdirSync(at("repo", "vendor", "evil"), { recursive: true });
  git(at("repo", "vendor", "evil"), "init", "-q");
  fs.mkdirSync(at("lib"), { recursive: true });
  git(at("lib"), "init", "-q");
  git(at("lib"), "commit", "-q", "--allow-empty", "-m", "lib");
  git(at("repo"), "-c", "protocol.file.allow=always", "submodule", "add", "-q", at("lib"), "libs/lib");
  return at;
}

function liveHome(name) {
  const configDir = path.join(TMP, "codara", name, "claude-cli", "live", "home");
  fs.mkdirSync(configDir, { recursive: true });
  return { configDir, configDirEnv: configDir, homeDir: path.dirname(configDir) };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const ws = (cwd, extra = {}) => ({ cwd, ...extra });

async function main() {
  const trust = await load();
  const at = layout();

  await check("the trust root is the physical repository root, a worktree's own root, or the folder itself", async () => {
    assert.equal(await trust.claudeTrustRoot(at("plain", "deep")), at("plain", "deep"));
    assert.equal(await trust.claudeTrustRoot(at("repo")), at("repo"));
    assert.equal(await trust.claudeTrustRoot(at("repo", "sub")), at("repo"));
    assert.equal(await trust.claudeTrustRoot(at("repo-wt")), at("repo-wt"), "a worktree is its own root, not its main repository");
    assert.equal(await trust.claudeTrustRoot(at("link", "repo", "sub")), at("repo"), "a symlinked path resolves to the physical one");
    assert.equal(await trust.claudeTrustRoot(at("link", "plain", "deep")), at("plain", "deep"));
    assert.equal(await trust.claudeTrustRoot(at("gone")), null);
  });

  await check("only a workspace folder, or a worktree made from one, is in scope", async () => {
    const key = (cwd, workspaces) => trust.claudeTrustKeyForCwd(cwd, workspaces);
    // A workspace that is a repository: any folder in it trusts the root.
    assert.equal(await key(at("repo", "sub"), [ws(at("repo"))]), at("repo"));
    // A parent folder added as a workspace: a repository inside it is not what the user added.
    assert.equal(await key(at("repo", "sub"), [ws(at())]), null);
    assert.equal(await key(at("plain", "deep"), [ws(at())]), at("plain", "deep"), "a plain folder under it is");
    // A repository nested in the workspace's: a vendored clone, a submodule.
    assert.equal(fs.statSync(at("repo", "libs", "lib", ".git")).isFile(), true, "the submodule is a real one");
    assert.equal(await key(at("repo", "vendor", "evil"), [ws(at("repo"))]), null);
    assert.equal(await key(at("repo", "libs", "lib"), [ws(at("repo"))]), null);
    assert.equal(await key(at("repo", "vendor"), [ws(at("repo"))]), at("repo"), "the workspace's own folders still are");
    // A workspace inside a repository: the workspace folder, never the repository above it.
    assert.equal(await key(at("repo", "sub"), [ws(at("repo", "sub"))]), at("repo", "sub"));
    // Outside a repository, the folder Claude Code runs in.
    assert.equal(await key(at("plain", "deep"), [ws(at("plain"))]), at("plain", "deep"));
    // A Codara worktree is a copy-branch workspace: its own root.
    assert.equal(
      await key(at("repo-wt"), [ws(at("repo")), ws(at("repo-wt"), { copyBranch: { repoCwd: at("repo"), branch: "wt" } })]),
      at("repo-wt"),
    );
    // Pull-request code: an import, or a worktree made from one or from a PR ref.
    const madeFromPr = ws(at("repo-wt"), { copyBranch: { repoCwd: at("repo"), branch: "wt", pullRequestCode: true } });
    assert.equal(await key(at("repo-wt"), [ws(at("repo")), madeFromPr]), null);
    const prBase = ws(at("repo-wt"), { copyBranch: { repoCwd: at("repo"), branch: "wt", baseBranch: "codara/pr/ab/7/fix" } });
    assert.equal(await key(at("repo-wt"), [ws(at("repo")), prBase]), null);
    const prCheckout = ws(at("repo-wt"), { copyBranch: { repoCwd: at("repo"), branch: "codara/pr/ab/7/fix" } });
    assert.equal(await key(at("repo-wt"), [ws(at("repo")), prCheckout]), null);
    // Reached through a symlink: still the physical key, from either side.
    assert.equal(await key(at("link", "repo", "sub"), [ws(at("repo"))]), at("repo"));
    assert.equal(await key(at("repo", "sub"), [ws(at("link", "repo"))]), at("repo"));
    // Out of scope.
    assert.equal(await key(at("plain", "deep"), [ws(at("repo"))]), null, "a folder outside every workspace");
    assert.equal(await key(at("repo-wt"), [ws(at("repo"))]), null, "a worktree Codara did not record");
    assert.equal(await key(at("gone"), [ws(at())]), null);
    assert.equal(await key("ssh://host-1/home/me/repo", [ws("ssh://host-1/home/me/repo")]), null, "a remote pane");
    const pr = ws(at("repo-wt"), { copyBranch: { repoCwd: at("repo"), branch: "wt", origin: { kind: "github-pull-request" } } });
    assert.equal(await key(at("repo-wt"), [ws(at()), pr]), null, "an imported pull request, even inside a trusted workspace");
    assert.equal(await key(at("repo-wt"), [pr]), null);
  });

  await check("never the home folder, a folder above it, or a filesystem root", async () => {
    const home = process.env.HOME;
    fs.mkdirSync(path.join(home, "notes", "deep"), { recursive: true });
    const key = (cwd, workspaces) => trust.claudeTrustKeyForCwd(cwd, workspaces);
    assert.equal(await key(home, [ws(home)]), null, "a home workspace opened at its root");
    assert.equal(await key(path.join(home, "notes"), [ws(home)]), path.join(home, "notes"), "a folder under it is fine");
    assert.equal(await key(TMP, [ws(TMP)]), null, "a folder above home");
    assert.equal(await key("/", [ws("/")]), null, "the root");
    // Home reached through a symlink is still home.
    fs.symlinkSync(home, path.join(TMP, "home-link"));
    assert.equal(await trust.isTooBroadToTrust(home, path.join(TMP, "home-link")), true);
    for (const root of ["C:\\", "D:\\", "\\\\server\\share\\"]) {
      assert.equal(await trust.isTooBroadToTrust(root, "C:\\Users\\me", "win32"), true, root);
    }
    assert.equal(await trust.isTooBroadToTrust("C:\\work\\repo", "C:\\Users\\me", "win32"), false);
    assert.equal(await trust.isTooBroadToTrust(at("repo"), home), false);
  });

  await check("keys are written as Claude Code writes them", async () => {
    assert.equal(trust.claudeProjectKey("C:\\Users\\me\\repo", "win32"), "C:/Users/me/repo");
    assert.equal(trust.claudeProjectKey("/home/me/repo", "linux"), "/home/me/repo");
    assert.equal(trust.claudeProjectKey("/home/me/Cafe\u0301", "linux"), "/home/me/Caf\u00e9");
  });

  await check("the record is added with Claude Code's defaults, and every other key stays", async () => {
    const home = liveHome("adds");
    const file = path.join(home.configDir, ".claude.json");
    writeJson(file, {
      oauthAccount: { accountUuid: "keep" },
      mcpServers: { mine: { command: "mine" } },
      projects: {
        "/other": { allowedTools: ["Bash"], hasTrustDialogAccepted: false, lastCost: 3 },
        "/partial": { allowedTools: ["Read"], hasClaudeMdExternalIncludesApproved: false },
      },
    });
    fs.chmodSync(file, 0o640);
    assert.equal(await trust.addClaudeFolderTrust(home, "/new"), "added");
    assert.equal(await trust.addClaudeFolderTrust(home, "/partial"), "added");
    const config = readJson(file);
    assert.deepEqual(config.oauthAccount, { accountUuid: "keep" });
    assert.deepEqual(config.mcpServers, { mine: { command: "mine" } });
    assert.deepEqual(config.projects["/other"], { allowedTools: ["Bash"], hasTrustDialogAccepted: false, lastCost: 3 });
    assert.deepEqual(config.projects["/new"], {
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
    });
    assert.deepEqual(
      config.projects["/partial"],
      { allowedTools: ["Read"], hasClaudeMdExternalIncludesApproved: false, hasTrustDialogAccepted: true },
      "an existing entry keeps its keys and gets no external-import approval",
    );
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, "the file keeps its mode");
    const before = fs.readFileSync(file, "utf8");
    assert.equal(await trust.addClaudeFolderTrust(home, "/new"), "present");
    assert.equal(fs.readFileSync(file, "utf8"), before, "a folder already trusted is not rewritten");
  });

  await check("a missing or foreign-shaped config is never created or replaced", async () => {
    const missing = liveHome("missing");
    assert.equal(await trust.addClaudeFolderTrust(missing, "/x"), "no-config");
    assert.equal(fs.existsSync(path.join(missing.configDir, ".claude.json")), false, "a managed home is seeded elsewhere");
    const odd = liveHome("odd");
    const oddFile = path.join(odd.configDir, ".claude.json");
    writeJson(oddFile, { projects: ["not", "an", "object"] });
    assert.equal(await trust.addClaudeFolderTrust(odd, "/x"), "present");
    assert.deepEqual(readJson(oddFile), { projects: ["not", "an", "object"] });
    writeJson(oddFile, { projects: { "/x": "odd" } });
    assert.equal(await trust.addClaudeFolderTrust(odd, "/x"), "present");
    assert.deepEqual(readJson(oddFile), { projects: { "/x": "odd" } });
  });

  await check("the write waits for Claude Code's lock and re-reads inside it", async () => {
    const { lock } = require("proper-lockfile");
    const home = liveHome("locked");
    const file = path.join(home.configDir, ".claude.json");
    writeJson(file, { projects: {} });
    const release = await lock(file, { realpath: false, lockfilePath: `${file}.lock` });
    let done = false;
    const write = trust.addClaudeFolderTrust(home, "/locked").then((result) => {
      done = true;
      return result;
    });
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false, "the write waits while Claude Code holds the lock");
    // Claude Code saves its own state while it holds the lock; that save survives.
    writeJson(file, { projects: { "/claude": { hasTrustDialogAccepted: true } }, numStartups: 9 });
    await release();
    assert.equal(await write, "added");
    const after = readJson(file);
    assert.equal(after.numStartups, 9);
    assert.deepEqual(after.projects["/claude"], { hasTrustDialogAccepted: true });
    assert.equal(after.projects["/locked"].hasTrustDialogAccepted, true);
  });

  const listed = (home) => {
    try {
      return readJson(path.join(path.dirname(home.configDir), "pretrusted-folders.json")).folders;
    } catch {
      return [];
    }
  };

  await check("Codara lists the folders it trusted, and only those", async () => {
    const home = liveHome("listed");
    const file = path.join(home.configDir, ".claude.json");
    writeJson(file, { projects: { "/by-the-user": { hasTrustDialogAccepted: true } } });
    assert.equal(await trust.addClaudeFolderTrust(home, "/by-codara"), "added");
    assert.equal(await trust.addClaudeFolderTrust(home, "/by-the-user"), "present");
    assert.deepEqual(listed(home), ["/by-codara"]);
    const record = path.join(path.dirname(home.configDir), "pretrusted-folders.json");
    assert.equal(fs.statSync(record).mode & 0o777, 0o600);
  });

  await check("a config removed while the lock is awaited is not created", async () => {
    const { lock } = require("proper-lockfile");
    const home = liveHome("vanishing");
    const file = path.join(home.configDir, ".claude.json");
    writeJson(file, {});
    const release = await lock(file, { realpath: false, lockfilePath: `${file}.lock` });
    const write = trust.addClaudeFolderTrust(home, "/gone");
    // The folder is listed before the write waits for Claude Code's lock.
    for (let attempt = 0; attempt < 200 && listed(home).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fs.rmSync(file);
    await release();
    assert.equal(await write, "no-config");
    assert.equal(fs.existsSync(file), false);
  });

  await check("claude-follow never copies Codara's trust into the user's .claude.json", async () => {
    const live = liveHome("follow");
    const userDir = path.join(TMP, "follow-user");
    fs.mkdirSync(userDir, { recursive: true });
    const user = { configDir: path.join(userDir, ".claude"), configDirEnv: null, homeDir: userDir };
    const userFile = path.join(userDir, ".claude.json");
    writeJson(userFile, { projects: {} });
    const liveFile = path.join(live.configDir, ".claude.json");
    writeJson(liveFile, { projects: { "/answered-in-a-following-terminal": { hasTrustDialogAccepted: true } } });
    assert.equal(await trust.addClaudeFolderTrust(live, "/workspace"), "added");
    const baseFile = path.join(TMP, "follow-base.json");
    await trust.sync.syncClaudeFollowConfig({ userHome: user, liveHome: live, baseFile });
    const mine = readJson(userFile).projects;
    assert.equal(mine["/answered-in-a-following-terminal"].hasTrustDialogAccepted, true, "the user's own answer still reaches their file");
    assert.equal(mine["/workspace"], undefined, "Codara's never does");
    assert.equal(readJson(liveFile).projects["/workspace"].hasTrustDialogAccepted, true, "and stays in the live slot");
    // A second pass, and a user who trusts the folder themselves, change nothing for it.
    mine["/workspace"] = { hasTrustDialogAccepted: false };
    writeJson(userFile, { projects: mine });
    await trust.sync.syncClaudeFollowConfig({ userHome: user, liveHome: live, baseFile });
    assert.equal(readJson(userFile).projects["/workspace"].hasTrustDialogAccepted, false);
    assert.equal(readJson(liveFile).projects["/workspace"].hasTrustDialogAccepted, true);
  });

  const deps = (home, workspaces, logs = [], extra = {}) => ({
    workspaces: async () => workspaces,
    home: () => home,
    log: (message) => logs.push(message),
    ...extra,
  });

  await check("a launch in scope adds its record; out of scope, or with persisted trust ignored, nothing is written", async () => {
    const home = liveHome("launch");
    const file = path.join(home.configDir, ".claude.json");
    writeJson(file, { numStartups: 1 });
    const logs = [];
    assert.equal(await trust.pretrustClaudeFolder(at("repo", "sub"), { deps: deps(home, [ws(at("repo"))], logs) }), "added");
    assert.equal(readJson(file).projects[at("repo")].hasTrustDialogAccepted, true);
    assert.deepEqual(logs, [`trusted ${at("repo")} for Claude Code`]);
    assert.equal(await trust.pretrustClaudeFolder(at("repo", "sub"), { deps: deps(home, [ws(at("repo"))], logs) }), "present");
    const before = fs.readFileSync(file, "utf8");
    assert.equal(await trust.pretrustClaudeFolder(at("plain", "deep"), { deps: deps(home, [ws(at("repo"))]) }), "skipped");
    assert.equal(
      await trust.pretrustClaudeFolder(at("plain", "deep"), {
        env: { CLAUDE_CODE_IGNORE_PERSISTED_TRUST: "1" },
        deps: deps(home, [ws(at("plain"))]),
      }),
      "skipped",
    );
    assert.equal(fs.readFileSync(file, "utf8"), before);
    // The caller's list wins over the stored one (a worktree just saved).
    assert.equal(
      await trust.pretrustClaudeFolder(at("plain", "deep"), { workspaces: [ws(at("plain"))], deps: deps(home, []) }),
      "added",
    );
  });

  await check("a failed or slow write never blocks the launch", async () => {
    const broken = liveHome("broken");
    fs.writeFileSync(path.join(broken.configDir, ".claude.json"), "{ not json");
    const logs = [];
    assert.equal(await trust.pretrustClaudeFolder(at("repo"), { deps: deps(broken, [ws(at("repo"))], logs) }), "failed");
    assert.equal(fs.readFileSync(path.join(broken.configDir, ".claude.json"), "utf8"), "{ not json", "an unparsable file is left alone");
    assert.match(logs[0], /could not trust .* for Claude Code: /);
    const failingDeps = { ...deps(broken, []), workspaces: async () => { throw new Error("state unreadable"); } };
    assert.equal(await trust.pretrustClaudeFolder(at("repo"), { deps: failingDeps }), "failed");

    const { lock } = require("proper-lockfile");
    const slow = liveHome("slow");
    const file = path.join(slow.configDir, ".claude.json");
    writeJson(file, {});
    const release = await lock(file, { realpath: false, lockfilePath: `${file}.lock` });
    const slowLogs = [];
    const result = await trust.pretrustClaudeFolder(at("repo"), { deps: deps(slow, [ws(at("repo"))], slowLogs, { waitMs: 10 }) });
    assert.equal(result, "timed-out");
    assert.match(slowLogs.at(-1), /gave up waiting/);
    await release();
    // The write still lands once the lock is free, for the next launch.
    for (let attempt = 0; attempt < 100 && !readJson(file).projects; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(readJson(file).projects[at("repo")].hasTrustDialogAccepted, true);
  });

  await check("a new worktree is trusted only when its source is in scope", async () => {
    const home = liveHome("worktree");
    const file = path.join(home.configDir, ".claude.json");
    writeJson(file, {});
    assert.equal(await trust.pretrustClaudeWorktree(at("repo-wt"), at("plain"), { deps: deps(home, [ws(at("repo"))]) }), "skipped");
    assert.equal(readJson(file).projects, undefined);
    assert.equal(await trust.pretrustClaudeWorktree(at("repo-wt"), at("repo"), { deps: deps(home, [ws(at("repo"))]) }), "added");
    assert.deepEqual(Object.keys(readJson(file).projects), [at("repo-wt")]);
  });

  await check("a pane's startup command is a Claude launch only when its program is claude", async () => {
    for (const command of [
      "claude --dangerously-skip-permissions",
      "claude --dangerously-skip-permissions --resume 11111111-1111-4111-8111-111111111111",
      "claude --dangerously-skip-permissions --settings /x/settings.json",
      "  claude",
      "/home/me/.local/bin/claude -p hi",
      "C:\\tools\\claude.exe --model opus",
      "claude.cmd",
    ]) {
      assert.equal(trust.startupCommandRunsClaude(command), true, command);
    }
    for (const command of [undefined, null, "", "codex --yolo", "grok --yolo", "pi", "claude-code", "echo claude", "npm run dev"]) {
      assert.equal(trust.startupCommandRunsClaude(command), false, String(command));
    }
  });

  assert.deepEqual(REAL_FILES.map(digest), REAL_DIGESTS, "the real Claude configs were not touched");
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
