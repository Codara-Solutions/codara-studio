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
  return { ...require(outfile), ...require(startup) };
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
    // A parent folder added as a workspace: the repository inside it is trusted at its root.
    assert.equal(await key(at("repo", "sub"), [ws(at())]), at("repo"));
    // A workspace inside a repository: the workspace folder, never the repository above it.
    assert.equal(await key(at("repo", "sub"), [ws(at("repo", "sub"))]), at("repo", "sub"));
    // Outside a repository, the folder Claude Code runs in.
    assert.equal(await key(at("plain", "deep"), [ws(at("plain"))]), at("plain", "deep"));
    // A Codara worktree is a copy-branch workspace: its own root.
    assert.equal(
      await key(at("repo-wt"), [ws(at("repo")), ws(at("repo-wt"), { copyBranch: { repoCwd: at("repo"), branch: "wt" } })]),
      at("repo-wt"),
    );
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
