#!/usr/bin/env node
"use strict";

// claude-follow's hook, executed for real: the scripts and startup lines
// Codara generates are installed into a fake HOME and run by zsh, bash, dash
// and (when installed) PowerShell 7, with a fake `claude` on PATH that
// prints the CLAUDE_CONFIG_DIR it was started with. Covered: following the
// active account, the System login, a deleted app, a deleted Codara folder,
// a Codara pane, the user's own CLAUDE_CONFIG_DIR, alias and function,
// `set -u` / `set -e`, arguments, stdin and exit status, and the hot swap of
// the live slot reaching a `claude` started through the hook. fish is not
// installed here, so its script is checked statically. Nothing outside the
// temporary directory is read or written.
//
//   node scripts/test-claude-follow-hooks.cjs

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-follow-hooks-")));
// Looked up before HOME is replaced below; only its existence is read.
const PWSH = [path.join(os.userInfo().homedir, ".local", "bin", "pwsh"), "/usr/bin/pwsh", "/usr/local/bin/pwsh"].find(
  (file) => fs.existsSync(file),
);
// A space in HOME and a quote and a dollar in the app's path: every word the
// hook writes must survive quoting.
const HOME = path.join(TMP, "my home");
const CODARA = path.join(HOME, ".codarastudio");
const BIN = path.join(TMP, "bin");
const APPS = path.join(TMP, "apps");
const APP = path.join(APPS, "Codara Studio's $build.AppImage");
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
      `export * from ${main("claude-follow", "claude-follow.ts")};`,
      `export * from ${main("claude-follow", "hook-scripts.ts")};`,
      `export { claudeLiveConfigDir, claudeCliVaultFile, activateClaudeCliAccount } from ${main("orchestration", "claude-cli-live-login.ts")};`,
      `export { claudeCliKeychainService } from ${main("orchestration", "claude-cli-credentials.ts")};`,
      `export { buildClaudeCliProfileEnvironment } from ${main("orchestration", "claude-cli-profile-environment.ts")};`,
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

const FAKE_CLAUDE = `#!/bin/sh
if [ "\${1-}" = watch ]; then
  token() { grep -o '"accessToken": *"[^"]*"' "$CLAUDE_CONFIG_DIR/.credentials.json" | sed 's/.*"\\([^"]*\\)"$/\\1/'; }
  printf 'TOKEN=%s\\n' "$(token)"
  while [ ! -f "$2" ]; do sleep 0.05; done
  printf 'TOKEN=%s\\n' "$(token)"
  exit 0
fi
printf 'CONFIG=%s\\n' "\${CLAUDE_CONFIG_DIR-unset}"
for arg in "$@"; do printf 'ARG=[%s]\\n' "$arg"; done
if [ -n "\${FAKE_CLAUDE_STDIN-}" ]; then IFS= read -r line; printf 'STDIN=%s\\n' "$line"; fi
exit "\${FAKE_CLAUDE_EXIT-0}"
`;

function baseEnv(extra = {}) {
  return {
    HOME,
    PATH: `${BIN}:/usr/bin:/bin`,
    TERM: "dumb",
    LANG: "C.UTF-8",
    ...extra,
  };
}

/** Noise a non-terminal interactive shell prints on its own. */
function ownNoise(stderr) {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        line.trim() !== "" &&
        !/cannot set terminal process group|no job control in this shell|Inappropriate ioctl/.test(line),
    )
    .join("\n");
}

function runShell(shell, command, extra = {}, input) {
  const args =
    shell === "zsh"
      ? ["-o", "NO_GLOBAL_RCS", "-i", "-c", command]
      : ["--rcfile", path.join(HOME, ".bashrc"), "-i", "-c", command];
  const result = spawnSync(shell, args, {
    env: baseEnv(extra),
    cwd: TMP,
    encoding: "utf8",
    input: input ?? "",
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: ownNoise(result.stderr) };
}

/** A POSIX single-quoted word. */
function sq(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function configOf(stdout) {
  const line = stdout.split("\n").find((entry) => entry.startsWith("CONFIG="));
  return line ? line.slice("CONFIG=".length) : null;
}

async function main() {
  const h = await buildHarness();
  for (const dir of [HOME, BIN, APPS]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(BIN, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(APP, "app", { mode: 0o755 });
  const rootDir = path.join(CODARA, "claude-cli");
  const live = h.claudeLiveConfigDir(rootDir);
  fs.mkdirSync(live, { recursive: true, mode: 0o700 });
  const userZshrc = "# my zsh setup\nexport MY_ZSH=1\n";
  const userBashrc = "# my bash setup\nexport MY_BASH=1";
  fs.writeFileSync(path.join(HOME, ".zshrc"), userZshrc, { mode: 0o640 });
  fs.writeFileSync(path.join(HOME, ".bashrc"), userBashrc, { mode: 0o600 });

  const context = {
    codaraHome: CODARA,
    homeDir: HOME,
    platform: "linux",
    env: {},
    loginShell: "/usr/bin/zsh",
    liveConfigDir: live,
    resolveZdotdir: async () => null,
  };
  const paths = h.claudeFollowPaths(CODARA);
  const report = await h.installClaudeFollow(context, APP);
  assert.deepEqual(
    report.files.map((file) => [path.basename(file.path), file.result]),
    [
      [".zshrc", "written"],
      [".bashrc", "written"],
    ],
  );
  assert.ok(fs.readFileSync(path.join(HOME, ".zshrc"), "utf8").startsWith(userZshrc));
  assert.equal(fs.statSync(path.join(HOME, ".zshrc")).mode & 0o777, 0o640, "the file keeps its mode");
  const bashrc = fs.readFileSync(path.join(HOME, ".bashrc"), "utf8");
  assert.ok(bashrc.startsWith(`${userBashrc}\n# >>> codara studio claude >>>\n`), "a missing final newline is added once");
  assert.match(bashrc, /\nif \[ -n "\$\{BASH_VERSION-\}" \] && \[ -f "\$HOME\/\.codarastudio\/shell\/claude-follow\.bash" \]; then \. "\$HOME\/\.codarastudio\/shell\/claude-follow\.bash"; fi\n/);
  await h.writeClaudeFollowFlag(paths, true);
  pass("install adds one guarded block per startup file, keeps the user's bytes and mode");

  for (const shell of ["zsh", "bash"]) {
    // Follows: the live slot for the child alone, arguments intact.
    let run = runShell(shell, 'claude a "b c" ""; echo "AFTER=${CLAUDE_CONFIG_DIR-unset}"');
    assert.equal(run.stderr, "", `${shell}: nothing on stderr`);
    assert.equal(configOf(run.stdout), live, `${shell}: follows the live slot`);
    assert.match(run.stdout, /ARG=\[a\]\nARG=\[b c\]\nARG=\[\]\n/, `${shell}: arguments pass through`);
    assert.match(run.stdout, /AFTER=unset/, `${shell}: the shell itself never gets CLAUDE_CONFIG_DIR`);
    run = runShell(shell, shell === "zsh" ? "whence -w claude" : "type -t claude");
    assert.match(run.stdout, /function/, `${shell}: claude is a function`);

    // Exit status and stdin.
    run = runShell(shell, "claude; echo STATUS=$?", { FAKE_CLAUDE_EXIT: "7" });
    assert.match(run.stdout, /STATUS=7/, `${shell}: exit status passes through`);
    run = runShell(shell, "claude", { FAKE_CLAUDE_STDIN: "1" }, "piped line\n");
    assert.match(run.stdout, /STDIN=piped line/, `${shell}: stdin passes through`);

    // set -u and set -e.
    run = runShell(shell, shell === "zsh" ? "setopt nounset errexit; claude x; echo DONE" : "set -eu; claude x; echo DONE");
    assert.equal(run.stderr, "", `${shell}: silent under set -u -e`);
    assert.equal(configOf(run.stdout), live);
    assert.match(run.stdout, /DONE/);

    // The user's own CLAUDE_CONFIG_DIR, and any variable that picks another login.
    run = runShell(shell, "claude", { CLAUDE_CONFIG_DIR: path.join(TMP, "mine") });
    assert.equal(configOf(run.stdout), path.join(TMP, "mine"), `${shell}: the user's CLAUDE_CONFIG_DIR wins`);
    run = runShell(shell, "claude", { ANTHROPIC_API_KEY: "sk-test" });
    assert.equal(configOf(run.stdout), "unset", `${shell}: an API key of the user's own is left alone`);

    // Inside a Codara pane the function is not even defined.
    run = runShell(shell, `${shell === "zsh" ? "whence -w claude" : "type -t claude"}; claude`, { SPARK_AGENT_PANE_ID: "pane-1" });
    assert.doesNotMatch(run.stdout, /function/, `${shell}: no function in a Codara pane`);
    assert.equal(configOf(run.stdout), "unset");
    pass(`${shell}: follows, passes arguments, status and stdin through, honors set -u -e, the user's own choices and Codara panes`);
  }

  // The System login (or no managed account): the flag goes, claude is plain.
  await h.writeClaudeFollowFlag(paths, false);
  for (const shell of ["zsh", "bash"]) assert.equal(configOf(runShell(shell, "claude").stdout), "unset");
  await h.writeClaudeFollowFlag(paths, true);
  pass("with the System login active, claude runs untouched");

  // The user's own alias or function, before or after Codara's line.
  for (const [shell, rc, mine] of [
    ["zsh", ".zshrc", "alias claude='echo USER-ALIAS'"],
    ["bash", ".bashrc", "alias claude='echo USER-ALIAS'"],
    ["zsh", ".zshrc", "claude() { echo USER-FUNCTION; }"],
    ["bash", ".bashrc", "claude() { echo USER-FUNCTION; }"],
  ]) {
    const file = path.join(HOME, rc);
    const original = fs.readFileSync(file, "utf8");
    for (const placement of ["before", "after"]) {
      fs.writeFileSync(file, placement === "before" ? `${mine}\n${original}` : `${original}${mine}\n`);
      const run = runShell(shell, shell === "bash" ? "shopt -s expand_aliases\nclaude" : "claude");
      assert.match(run.stdout, /USER-(ALIAS|FUNCTION)/, `${shell}: the user's own claude (${placement}) wins`);
      assert.equal(configOf(run.stdout), null);
      assert.equal(run.stderr, "", `${shell}: silent with the user's own claude (${placement})`);
    }
    fs.writeFileSync(file, original);
  }
  pass("a claude alias or function of the user's own wins, defined before or after the line");

  // Sourcing the rc twice (`source ~/.zshrc`) keeps one working function.
  for (const shell of ["zsh", "bash"]) {
    const run = runShell(shell, `. ${sq(path.join(HOME, shell === "zsh" ? ".zshrc" : ".bashrc"))}; claude`);
    assert.equal(configOf(run.stdout), live, `${shell}: re-sourcing keeps the function`);
  }
  pass("re-sourcing the startup file keeps the hook working");

  // ~/.profile is read by every POSIX login shell: the bash line is inert in dash.
  const profile = path.join(HOME, ".profile");
  fs.writeFileSync(profile, `${h.renderClaudeFollowBlock("bash", { platform: "linux", homeDir: HOME, scriptPath: paths.script("bash") }).join("\n")}\necho PROFILE-OK\n`);
  const dash = spawnSync("dash", ["-c", `. ${sq(profile)}; command -v claude`], {
    env: baseEnv(),
    encoding: "utf8",
  });
  assert.equal(dash.stderr, "");
  assert.match(dash.stdout, /PROFILE-OK\n.*\/bin\/claude\n/);
  fs.rmSync(profile);
  pass("the bash line does nothing in sh (dash) reading ~/.profile");

  // The app is gone: the function is not defined at the next start, and an
  // already-open shell stops following at the next call.
  fs.renameSync(APP, `${APP}.moved`);
  for (const shell of ["zsh", "bash"]) {
    const run = runShell(shell, `${shell === "zsh" ? "whence -w claude" : "type -t claude"}; claude`);
    assert.doesNotMatch(run.stdout, /function/);
    assert.equal(configOf(run.stdout), "unset", `${shell}: plain claude once the app is gone`);
    assert.equal(run.stderr, "");
  }
  fs.renameSync(`${APP}.moved`, APP);
  for (const shell of ["zsh", "bash"]) {
    const run = runShell(shell, `claude; mv ${sq(APP)} ${sq(`${APP}.gone`)}; claude`);
    const configs = run.stdout.split("\n").filter((line) => line.startsWith("CONFIG="));
    assert.deepEqual(configs, [`CONFIG=${live}`, "CONFIG=unset"], `${shell}: an open shell stops following when the app goes`);
    fs.renameSync(`${APP}.gone`, APP);
  }
  pass("deleting the app makes the hook inert, at the next start and in open shells");

  // Codara's folder deleted: the line sources nothing and prints nothing.
  const backup = path.join(TMP, "codara-moved");
  fs.renameSync(CODARA, backup);
  for (const shell of ["zsh", "bash"]) {
    const run = runShell(shell, "claude; echo OK");
    assert.equal(run.stderr, "", `${shell}: silent with Codara's folder gone`);
    assert.equal(configOf(run.stdout), "unset");
    assert.match(run.stdout, /OK/);
  }
  fs.renameSync(backup, CODARA);
  pass("deleting Codara's folder leaves the shells silent and claude plain");

  // macOS: the recorded path is the .app bundle, a directory.
  assert.equal(
    h.installedAppPath("darwin", "/Applications/Codara Studio.app/Contents/MacOS/Codara Studio", {}, false),
    "/Applications/Codara Studio.app",
  );
  assert.equal(h.installedAppPath("linux", "/tmp/.mount_x/codara", { APPIMAGE: "/home/u/Codara.AppImage" }, true), "/home/u/Codara.AppImage");
  assert.equal(h.installedAppPath("win32", "C:\\Users\\u\\AppData\\Local\\Programs\\codara-studio\\Codara Studio.exe", {}, false), "C:\\Users\\u\\AppData\\Local\\Programs\\codara-studio\\Codara Studio.exe");
  {
    const bundle = path.join(APPS, "Codara Studio.app");
    fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
    const script = h.renderClaudeFollowScript("zsh", { platform: "darwin", appPath: bundle, flagFile: paths.flagFile, liveConfigDir: live });
    fs.writeFileSync(path.join(TMP, "mac.zsh"), script);
    const run = spawnSync("zsh", ["-f", "-c", `. ${sq(path.join(TMP, "mac.zsh"))}; claude`], { env: baseEnv(), encoding: "utf8" });
    assert.equal(configOf(run.stdout), live);
    fs.rmSync(bundle, { recursive: true });
    const gone = spawnSync("zsh", ["-f", "-c", `. ${sq(path.join(TMP, "mac.zsh"))}; claude`], { env: baseEnv(), encoding: "utf8" });
    assert.equal(configOf(gone.stdout), "unset", "moving the bundle to the Trash makes it inert");
  }
  pass("macOS records the .app bundle; Linux the AppImage; Windows the installed exe");

  // 5e: the hook passes the live slot exactly as Codara's panes do, so
  // Claude Code names the same Keychain item for both.
  const paneEnv = h.buildClaudeCliProfileEnvironment({}, live);
  assert.equal(paneEnv.CLAUDE_CONFIG_DIR, live);
  assert.ok(fs.readFileSync(paths.script("zsh"), "utf8").includes(`CLAUDE_CONFIG_DIR='${live.replace(/'/g, "'\\''")}'`));
  assert.equal(h.claudeCliKeychainService(configOf(runShell("zsh", "claude").stdout)), h.claudeCliKeychainService(paneEnv.CLAUDE_CONFIG_DIR));
  pass("the hook's CLAUDE_CONFIG_DIR is byte-identical to a pane's: one Keychain item on macOS");

  // Hot swap: a claude started through the hook sees the next account
  // without a restart, exactly as a Codara pane does.
  {
    const login = (token) => ({ accessToken: token, refreshToken: `${token}-refresh`, expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"], subscriptionType: "max" });
    const vault = (profileId, token, email) => {
      const file = h.claudeCliVaultFile(rootDir, profileId);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ version: 1, store: { claudeAiOauth: login(token) }, oauthAccount: { accountUuid: randomUUID(), emailAddress: email } }), { mode: 0o600 });
    };
    const a = randomUUID();
    const b = randomUUID();
    vault(a, "TOKEN-ACCOUNT-A", "a@example.com");
    vault(b, "TOKEN-ACCOUNT-B", "b@example.com");
    const store = { rootDir, liveConfigDir: live };
    const known = async () => [a, b];
    await h.activateClaudeCliAccount(store, a, { knownProfileIds: known, fileOnly: true });
    const go = path.join(TMP, "go");
    const child = spawn("bash", ["--rcfile", path.join(HOME, ".bashrc"), "-i", "-c", `claude watch ${sq(go)}`], {
      env: baseEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    const until = async (predicate) => {
      const deadline = Date.now() + 15_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out; output so far: ${out}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    await until(() => out.includes("TOKEN="));
    assert.match(out, /TOKEN=TOKEN-ACCOUNT-A/);
    await h.activateClaudeCliAccount(store, b, { knownProfileIds: known, fileOnly: true });
    fs.writeFileSync(go, "");
    await until(() => out.split("TOKEN=").length > 2);
    child.kill();
    assert.match(out, /TOKEN=TOKEN-ACCOUNT-A\nTOKEN=TOKEN-ACCOUNT-B\n/);
  }
  pass("hot swap: a claude started through the hook reads the switched account without a restart");

  // PowerShell 7, when installed: the same rules through the profile line.
  if (PWSH) {
    const psScript = h.renderClaudeFollowScript("powershell", { platform: "linux", appPath: APP, flagFile: paths.flagFile, liveConfigDir: live });
    fs.writeFileSync(paths.script("powershell"), psScript);
    const profileFile = path.join(TMP, "profile.ps1");
    const line = h.renderClaudeFollowBlock("powershell", { platform: "linux", homeDir: HOME, scriptPath: paths.script("powershell") });
    fs.writeFileSync(profileFile, `${line.join("\r\n")}\r\n`);
    const ps = (command, extra = {}) => {
      const result = spawnSync(PWSH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `. '${profileFile}'; ${command}`], {
        env: baseEnv({ USERPROFILE: HOME, ...extra }),
        encoding: "utf8",
        timeout: 60_000,
      });
      return { stdout: result.stdout, stderr: result.stderr, status: result.status };
    };
    let run = ps("claude a 'b c'; \"AFTER=$env:CLAUDE_CONFIG_DIR\"; exit $LASTEXITCODE", { FAKE_CLAUDE_EXIT: "5" });
    assert.equal(run.stderr, "");
    assert.equal(configOf(run.stdout), live);
    assert.match(run.stdout, /ARG=\[a\]\nARG=\[b c\]\n/);
    assert.match(run.stdout, /AFTER=\n/, "the variable is removed again after the call");
    assert.equal(run.status, 5, "exit status passes through");
    run = ps("'piped line' | claude", { FAKE_CLAUDE_STDIN: "1" });
    assert.match(run.stdout, /STDIN=piped line/);
    run = ps("claude", { CLAUDE_CONFIG_DIR: path.join(TMP, "mine") });
    assert.equal(configOf(run.stdout), path.join(TMP, "mine"));
    run = ps("claude", { SPARK_AGENT_PANE_ID: "pane-1" });
    assert.equal(configOf(run.stdout), "unset");
    run = ps("Set-StrictMode -Version Latest; claude");
    assert.equal(run.stderr, "");
    assert.equal(configOf(run.stdout), live);
    fs.writeFileSync(path.join(TMP, "alias.ps1"), "function global:claude { 'USER-FUNCTION' }\r\n");
    run = spawnSync(PWSH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `. '${path.join(TMP, "alias.ps1")}'; . '${profileFile}'; claude`], { env: baseEnv({ USERPROFILE: HOME }), encoding: "utf8" });
    assert.match(run.stdout, /USER-FUNCTION/);
    await h.writeClaudeFollowFlag(paths, false);
    assert.equal(configOf(ps("claude").stdout), "unset");
    await h.writeClaudeFollowFlag(paths, true);
    fs.rmSync(paths.script("powershell"));
    run = ps("claude; 'OK'");
    assert.equal(run.stderr, "");
    assert.equal(configOf(run.stdout), "unset");
    pass("PowerShell 7: follows, passes arguments, stdin and status, cleans up, honors the user's own choices, inert without the script");
  } else {
    console.log("skip - PowerShell 7 not installed");
  }

  // Static: the Windows forms of each line and the fish script.
  {
    const win = { platform: "win32", homeDir: "C:\\Users\\Zoë", scriptPath: "C:\\Users\\Zoë\\.codarastudio\\shell\\claude-follow.ps1" };
    const [begin, line, end] = h.renderClaudeFollowBlock("powershell", win);
    assert.equal(begin, "# >>> codara studio claude >>>");
    assert.equal(end, "# <<< codara studio claude <<<");
    assert.equal(line, 'if (Test-Path -LiteralPath "$env:USERPROFILE\\.codarastudio\\shell\\claude-follow.ps1") { try { . "$env:USERPROFILE\\.codarastudio\\shell\\claude-follow.ps1" } catch { } }');
    assert.ok(/^[\x20-\x7e]*$/.test(line), "the PowerShell line is plain ASCII");
    const other = h.renderClaudeFollowBlock("powershell", { ...win, homeDir: "D:\\Profiles\\x", scriptPath: "C:\\Users\\Zoë\\x.ps1" })[1];
    assert.match(other, /"C:\\Users\\Zo\$\(\[char\]0x00eb\)\\x\.ps1"/);
    const gitBash = h.renderClaudeFollowScript("bash", {
      platform: "win32",
      appPath: "C:\\Users\\u\\AppData\\Local\\Programs\\codara-studio\\Codara Studio.exe",
      flagFile: "C:\\Users\\u\\.codarastudio\\shell\\claude-follow.on",
      liveConfigDir: "C:\\Users\\u\\.codarastudio\\claude-cli\\live\\home",
    });
    assert.ok(gitBash.includes("[ -e '/c/Users/u/AppData/Local/Programs/codara-studio/Codara Studio.exe' ]"), "Git Bash tests MSYS paths");
    assert.ok(gitBash.includes("CLAUDE_CONFIG_DIR='C:\\Users\\u\\.codarastudio\\claude-cli\\live\\home' command claude"), "Claude Code gets the Windows path");
    const ps = h.renderClaudeFollowScript("powershell", { platform: "win32", appPath: "C:\\A\\Codara Studio.exe", flagFile: "C:\\f", liveConfigDir: "C:\\l" });
    assert.ok(ps.includes("\r\n") && !/[^\r]\n/.test(ps), "the PowerShell script has CRLF line endings");
    const bash = h.renderClaudeFollowScript("bash", { platform: "darwin", appPath: "/Applications/Codara Studio.app", flagFile: "/f", liveConfigDir: "/l" });
    assert.doesNotMatch(bash, /\[\[|declare -g|local -n|mapfile|readarray|\$\{[A-Za-z_]+,,|\$\{[A-Za-z_]+\^\^|;&|\|&/, "bash 3.2 has none of these");
    const fish = h.renderClaudeFollowScript("fish", { platform: "linux", appPath: "/a/b's", flagFile: "/f", liveConfigDir: "/l" });
    assert.match(fish, /^if status is-interactive; and test -z "\$SPARK_AGENT_PANE_ID\$SPARK_AGENT_ARGS_DIR"; and test -e '\/a\/b\\'s'$/m);
    assert.match(fish, /set -lx CLAUDE_CONFIG_DIR '\/l'\n {16}command claude \$argv/);
    assert.match(fish, /if not functions -q claude; or set -q __codara_claude_follow/);
    const dropIn = h.renderClaudeFollowFishDropIn({ platform: "linux", homeDir: "/home/u", scriptPath: "/home/u/.codarastudio/shell/claude-follow.fish" });
    assert.match(dropIn, /^# codara studio claude \(generated by Codara Studio\)\n/);
    assert.match(dropIn, /\ntest -f "\$HOME\/\.codarastudio\/shell\/claude-follow\.fish"; and source "\$HOME\/\.codarastudio\/shell\/claude-follow\.fish"\n$/);
    assert.throws(() => h.renderClaudeFollowScript("zsh", { platform: "linux", appPath: "/a\nb", flagFile: "/f", liveConfigDir: "/l" }));
  }
  pass("static: PowerShell line is ASCII with $env:USERPROFILE, Git Bash uses MSYS tests, bash 3.2 safe, fish script shape");

  // Removal takes out exactly what install added.
  const removed = await h.removeClaudeFollow(context, { scanStartupFiles: true });
  assert.deepEqual(removed.files.map((file) => file.result), ["written", "written"]);
  assert.equal(fs.readFileSync(path.join(HOME, ".zshrc"), "utf8"), userZshrc);
  assert.equal(fs.readFileSync(path.join(HOME, ".bashrc"), "utf8"), userBashrc, "the added newline goes too");
  for (const shell of ["zsh", "bash", "fish", "powershell"]) assert.equal(fs.existsSync(paths.script(shell)), false);
  assert.equal(fs.existsSync(paths.flagFile), false);
  assert.equal(fs.existsSync(paths.manifestFile), false);
  for (const shell of ["zsh", "bash"]) assert.equal(configOf(runShell(shell, "claude").stdout), "unset");
  pass("removal restores both startup files byte for byte and deletes the scripts, flag and manifest");

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
