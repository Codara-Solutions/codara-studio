#!/usr/bin/env node
"use strict";

// claude-follow's edits of shell startup files, in a fake HOME: which files
// each platform gets (macOS, Linux and Windows through injected seams), that
// a missing file is created only for the login shell, that edits are
// idempotent, byte exact (BOM, UTF-16, CRLF, no final newline), atomic,
// keep the mode, back the original up once, leave a symlink in place, skip
// git-tracked, hard-linked and signed files, give way to a concurrent edit,
// and that removal restores the file exactly.
//
//   node scripts/test-claude-follow-startup-files.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-follow-files-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(HOME, ".codarastudio");
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = CODARA;
delete process.env.CLAUDE_CONFIG_DIR;

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(ROOT, "src", "main", "claude-follow", "startup-files.ts"))};`,
      `export * from ${JSON.stringify(path.join(ROOT, "src", "main", "claude-follow", "hook-scripts.ts"))};`,
      `export * from ${JSON.stringify(path.join(ROOT, "src", "main", "claude-follow", "claude-follow.ts"))};`,
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

function fresh(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const BLOCK = ["# >>> codara studio claude >>>", 'if [ -f "$HOME/x" ]; then . "$HOME/x"; fi', "# <<< codara studio claude <<<"];
const BLOCK2 = ["# >>> codara studio claude >>>", 'if [ -f "$HOME/y" ]; then . "$HOME/y"; fi', "# <<< codara studio claude <<<"];

function target(file, home, extra = {}) {
  return { shell: "zsh", path: file, kind: "block", create: false, homeDir: home, newFileEol: "\n", newFileBom: false, ...extra };
}

async function main() {
  const h = await buildHarness();
  fs.mkdirSync(HOME, { recursive: true });

  // --- Which files -----------------------------------------------------------
  {
    const home = fresh("plan-linux");
    const plan = (loginShell, extra = {}) =>
      h.planStartupTargets({ platform: "linux", homeDir: home, env: {}, loginShell, resolveZdotdir: async () => null, ...extra });
    let result = await plan("/usr/bin/zsh");
    assert.deepEqual(result.targets.map((t) => [path.relative(home, t.path), t.create]), [[".zshrc", true]], "zsh user: only .zshrc, created");
    result = await plan("/bin/bash");
    assert.deepEqual(result.targets.map((t) => [path.relative(home, t.path), t.create]), [[".bashrc", true]]);
    fs.writeFileSync(path.join(home, ".bashrc"), "x\n");
    result = await plan("/usr/bin/zsh");
    assert.deepEqual(result.targets.map((t) => [path.relative(home, t.path), t.create]), [[".zshrc", true], [".bashrc", false]], "an existing .bashrc is edited, not created");
    fs.mkdirSync(path.join(home, ".config", "fish"), { recursive: true });
    result = await plan("/usr/bin/zsh");
    assert.equal(result.targets.at(-1).kind, "dropin");
    assert.equal(path.relative(home, result.targets.at(-1).path), path.join(".config", "fish", "conf.d", "codara-claude-follow.fish"));
    const zdot = path.join(home, "zdot");
    result = await plan("/usr/bin/zsh", { resolveZdotdir: async () => zdot });
    assert.equal(result.targets[0].path, path.join(zdot, ".zshrc"), "ZDOTDIR is respected");
    result = await plan("/usr/bin/fish", { env: { XDG_CONFIG_HOME: path.join(home, "xdg") } });
    assert.equal(result.targets.at(-1).path, path.join(home, "xdg", "fish", "conf.d", "codara-claude-follow.fish"));
  }
  {
    const home = fresh("plan-mac");
    const plan = (loginShell) =>
      h.planStartupTargets({ platform: "darwin", homeDir: home, env: {}, loginShell, resolveZdotdir: async () => null });
    let result = await plan("/bin/zsh");
    assert.deepEqual(result.targets.map((t) => path.basename(t.path)), [".zshrc"], "a zsh Mac user gets no bash file created");
    result = await plan("/bin/bash");
    assert.deepEqual(result.targets.map((t) => [path.basename(t.path), t.create]), [[".bash_profile", true]]);
    fs.writeFileSync(path.join(home, ".profile"), "x\n");
    result = await plan("/bin/bash");
    assert.deepEqual(result.targets.map((t) => [path.basename(t.path), t.create]), [[".profile", false]], "bash reads .profile when there is no .bash_profile; none is created next to it");
    fs.writeFileSync(path.join(home, ".bash_profile"), "x\n");
    fs.writeFileSync(path.join(home, ".bashrc"), "x\n");
    result = await plan("/bin/zsh");
    assert.deepEqual(result.targets.map((t) => path.basename(t.path)), [".zshrc", ".bash_profile", ".bashrc"]);
  }
  {
    const probes = {
      WindowsPowerShell: { profilePath: "C:\\Users\\u\\OneDrive\\Documents\\WindowsPowerShell\\profile.ps1", policy: "Restricted" },
      PowerShell: { profilePath: "C:\\Users\\u\\OneDrive\\Documents\\PowerShell\\profile.ps1", policy: "RemoteSigned" },
    };
    const result = await h.planStartupTargets({
      platform: "win32",
      homeDir: "C:\\Users\\u",
      env: {},
      loginShell: null,
      probePowerShell: async (edition) => probes[edition],
    });
    assert.deepEqual(result.targets.map((t) => [t.path, t.create, t.newFileEol, t.newFileBom]), [
      ["C:\\Users\\u\\OneDrive\\Documents\\PowerShell\\profile.ps1", true, "\r\n", true],
    ], "Windows: the profile PowerShell itself names (OneDrive-redirected), never a missing Git Bash file");
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /execution policy \(Restricted\)/);
    const none = await h.planStartupTargets({ platform: "win32", homeDir: "C:\\Users\\u", env: {}, loginShell: null, probePowerShell: async () => null });
    assert.deepEqual(none.targets, []);
  }
  pass("planning: login shell decides creation, ZDOTDIR and XDG respected, macOS bash login files, Windows profile and policy");

  // --- The edit ----------------------------------------------------------------
  {
    const home = fresh("edit");
    const file = path.join(home, ".zshrc");
    const original = "export A=1\nalias ll='ls -l'\n";
    fs.writeFileSync(file, original, { mode: 0o640 });
    const backup = path.join(home, "backups", "zshrc");
    let outcome = await h.addStartupBlock(target(file, home), BLOCK, { backupFile: backup });
    assert.equal(outcome.result, "written");
    assert.equal(fs.readFileSync(file, "utf8"), `${original}${BLOCK.join("\n")}\n`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(backup, "utf8"), original);
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600, "the backup is private");
    outcome = await h.addStartupBlock(target(file, home), BLOCK, { backupFile: null });
    assert.equal(outcome.result, "unchanged", "idempotent");
    // The user adds lines after the block; a new block replaces the old in place.
    fs.appendFileSync(file, "export AFTER=1\n");
    outcome = await h.addStartupBlock(target(file, home), BLOCK2, { backupFile: null });
    assert.equal(fs.readFileSync(file, "utf8"), `${original}${BLOCK2.join("\n")}\nexport AFTER=1\n`);
    // A duplicate block (a restored backup) collapses to one.
    fs.appendFileSync(file, `${BLOCK.join("\n")}\n`);
    await h.addStartupBlock(target(file, home), BLOCK2, { backupFile: null });
    assert.equal(fs.readFileSync(file, "utf8"), `${original}${BLOCK2.join("\n")}\nexport AFTER=1\n`);
    outcome = await h.removeStartupBlock(file, "block", { created: false, joinedLastLine: false, homeDir: home });
    assert.equal(fs.readFileSync(file, "utf8"), `${original}export AFTER=1\n`);
    assert.equal(fs.readdirSync(home).filter((name) => name.includes("codara-startup")).length, 0, "no temporary file left");
  }
  pass("edit: appended once, replaced in place, duplicates collapse, mode kept, one private backup, removal exact");

  {
    const home = fresh("bytes");
    const cases = [
      ["no final newline", Buffer.from("export A=1", "utf8")],
      ["CRLF", Buffer.from("export A=1\r\nexport B=2\r\n", "utf8")],
      ["UTF-8 BOM and accents", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# café\r\n$x = 'é'\r\n", "utf8")])],
      ["UTF-16LE", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# ünïcode\r\nSet-Alias g git\r\n", "utf16le")])],
      ["latin1 bytes that are not UTF-8", Buffer.from([0x23, 0x20, 0xe9, 0x0a])],
      ["empty", Buffer.alloc(0)],
    ];
    for (const [name, bytes] of cases) {
      const file = path.join(home, `f-${name.replace(/\W+/g, "-")}`);
      fs.writeFileSync(file, bytes);
      const outcome = await h.addStartupBlock(target(file, home), BLOCK, { backupFile: null });
      assert.equal(outcome.result, "written", name);
      const after = fs.readFileSync(file);
      if (name === "CRLF" || name === "UTF-8 BOM and accents") {
        assert.ok(after.toString("utf8").endsWith(`${BLOCK.join("\r\n")}\r\n`), `${name}: the block takes the file's CRLF`);
      }
      if (name === "UTF-16LE") {
        assert.deepEqual([...after.subarray(0, 2)], [0xff, 0xfe]);
        assert.ok(after.subarray(2).toString("utf16le").includes(BLOCK[1]), "UTF-16 stays UTF-16");
      }
      if (name === "UTF-8 BOM and accents") assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.ok(after.subarray(0, bytes.length).equals(bytes) || name === "no final newline", `${name}: the user's bytes come first, unchanged`);
      await h.removeStartupBlock(file, "block", { created: false, joinedLastLine: outcome.joinedLastLine, homeDir: home });
      assert.ok(fs.readFileSync(file).equals(bytes), `${name}: removal restores every byte`);
    }
    const be = path.join(home, "utf16be");
    fs.writeFileSync(be, Buffer.from([0xfe, 0xff, 0x00, 0x23]));
    assert.equal((await h.addStartupBlock(target(be, home), BLOCK, { backupFile: null })).result, "skipped");
  }
  pass("bytes: no final newline, CRLF, BOM, UTF-16LE, non-UTF-8 and empty files round-trip exactly; UTF-16BE is left alone");

  {
    const home = fresh("links");
    // stow-style: ~/.zshrc -> ~/dotfiles/zshrc (no git): the target is edited, the link stays.
    fs.mkdirSync(path.join(home, "dotfiles"));
    fs.writeFileSync(path.join(home, "dotfiles", "zshrc"), "x\n");
    fs.symlinkSync(path.join(home, "dotfiles", "zshrc"), path.join(home, ".zshrc"));
    let outcome = await h.addStartupBlock(target(path.join(home, ".zshrc"), home), BLOCK, { backupFile: null });
    assert.equal(outcome.result, "written");
    assert.equal(outcome.file, path.join(home, "dotfiles", "zshrc"));
    assert.ok(fs.lstatSync(path.join(home, ".zshrc")).isSymbolicLink(), "the link stays a link");
    assert.match(fs.readFileSync(path.join(home, "dotfiles", "zshrc"), "utf8"), /codara studio claude/);
    // The same in a git repository: left alone.
    fs.mkdirSync(path.join(home, "repo", ".git"), { recursive: true });
    fs.writeFileSync(path.join(home, "repo", "bashrc"), "x\n");
    fs.symlinkSync(path.join(home, "repo", "bashrc"), path.join(home, ".bashrc"));
    outcome = await h.addStartupBlock(target(path.join(home, ".bashrc"), home), BLOCK, { backupFile: null });
    assert.equal(outcome.result, "skipped");
    assert.match(outcome.reason, /git repository/);
    assert.equal(fs.readFileSync(path.join(home, "repo", "bashrc"), "utf8"), "x\n");
    // A dangling link, a hard link and a directory are left alone.
    fs.symlinkSync(path.join(home, "nowhere"), path.join(home, ".profile"));
    assert.equal((await h.addStartupBlock(target(path.join(home, ".profile"), home, { create: true }), BLOCK, { backupFile: null })).result, "skipped");
    assert.ok(fs.lstatSync(path.join(home, ".profile")).isSymbolicLink());
    fs.writeFileSync(path.join(home, "shared"), "x\n");
    fs.linkSync(path.join(home, "shared"), path.join(home, ".bash_profile"));
    outcome = await h.addStartupBlock(target(path.join(home, ".bash_profile"), home), BLOCK, { backupFile: null });
    assert.equal(outcome.result, "skipped");
    assert.match(outcome.reason, /hard links/);
    fs.mkdirSync(path.join(home, ".kshrc"));
    assert.equal((await h.addStartupBlock(target(path.join(home, ".kshrc"), home), BLOCK, { backupFile: null })).result, "skipped");
  }
  pass("links: a symlinked file is edited at its target and stays a link; git-tracked, dangling, hard-linked and non-files are skipped");

  {
    const home = fresh("create");
    const file = path.join(home, ".zshrc");
    let outcome = await h.addStartupBlock(target(file, home), BLOCK, { backupFile: null });
    assert.equal(outcome.result, "skipped", "never created without permission");
    assert.equal(fs.existsSync(file), false);
    outcome = await h.addStartupBlock(target(file, home, { create: true }), BLOCK, { backupFile: path.join(home, "b") });
    assert.deepEqual([outcome.result, outcome.created], ["written", true]);
    assert.equal(fs.existsSync(path.join(home, "b")), false, "nothing to back up for a new file");
    await h.removeStartupBlock(file, "block", { created: true, joinedLastLine: false, homeDir: home });
    assert.equal(fs.existsSync(file), false, "a file Codara created and nothing else uses goes");
    await h.addStartupBlock(target(file, home, { create: true }), BLOCK, { backupFile: null });
    fs.appendFileSync(file, "export MINE=1\n");
    await h.removeStartupBlock(file, "block", { created: true, joinedLastLine: false, homeDir: home });
    assert.equal(fs.readFileSync(file, "utf8"), "export MINE=1\n", "a created file the user wrote into stays");
    // A PowerShell profile Codara creates starts with a BOM and uses CRLF.
    const ps = path.join(home, "Documents", "PowerShell", "profile.ps1");
    await h.addStartupBlock(target(ps, home, { shell: "powershell", create: true, newFileEol: "\r\n", newFileBom: true }), BLOCK, { backupFile: null });
    const bytes = fs.readFileSync(ps);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.subarray(3).toString("utf8"), `${BLOCK.join("\r\n")}\r\n`);
    // A signed profile is never edited.
    const signed = path.join(home, "signed.ps1");
    fs.writeFileSync(signed, "Write-Host hi\r\n# SIG # Begin signature block\r\n# abc\r\n# SIG # End signature block\r\n");
    const outcomeSigned = await h.addStartupBlock(target(signed, home, { shell: "powershell" }), BLOCK, { backupFile: null });
    assert.equal(outcomeSigned.result, "skipped");
  }
  pass("creation only when allowed, removal deletes only an otherwise empty created file, new PowerShell profiles get BOM and CRLF, signed ones are skipped");

  {
    const home = fresh("race");
    const file = path.join(home, ".zshrc");
    fs.writeFileSync(file, "a\n");
    const outcome = await h.addStartupBlock(target(file, home), BLOCK, {
      backupFile: null,
      beforeWrite: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        fs.writeFileSync(file, "a\nedited meanwhile\n");
      },
    });
    assert.equal(outcome.result, "changed-meanwhile");
    assert.equal(fs.readFileSync(file, "utf8"), "a\nedited meanwhile\n", "a concurrent edit is never overwritten");
    // A block whose end marker the user deleted is not a block: nothing of theirs is taken.
    fs.writeFileSync(file, `x\n${BLOCK[0]}\n${BLOCK[1]}\nexport KEEP=1\nexport KEEP2=1\nexport KEEP3=1\nexport KEEP4=1\n${BLOCK[2]}\n`);
    await h.removeStartupBlock(file, "block", { created: false, joinedLastLine: false, homeDir: home });
    assert.match(fs.readFileSync(file, "utf8"), /KEEP4/, "a far-away end marker is not paired");
    // A marker that is not at a line start is not a marker.
    fs.writeFileSync(file, `echo "${BLOCK[0]}"\n`);
    const out = await h.addStartupBlock(target(file, home), BLOCK, { backupFile: null });
    assert.equal(out.result, "written");
    assert.ok(fs.readFileSync(file, "utf8").startsWith(`echo "${BLOCK[0]}"\n${BLOCK[0]}\n`));
    // Leftover temporaries of an interrupted edit are swept, nothing else.
    fs.writeFileSync(path.join(home, ".zshrc.codara-startup-abc.tmp"), "");
    fs.writeFileSync(path.join(home, ".zshrc.mine.tmp"), "");
    await h.sweepStartupTemporaries([file]);
    assert.deepEqual(fs.readdirSync(home).sort(), [".zshrc", ".zshrc.mine.tmp"]);
  }
  pass("a concurrent edit wins, a broken block takes nothing of the user's, quoted markers are text, only Codara's temporaries are swept");

  {
    const home = fresh("fish");
    const file = path.join(home, ".config", "fish", "conf.d", "codara-claude-follow.fish");
    const content = h.renderClaudeFollowFishDropIn({ platform: "linux", homeDir: home, scriptPath: path.join(home, ".codarastudio", "shell", "claude-follow.fish") });
    const fishTarget = target(file, home, { shell: "fish", kind: "dropin", create: true });
    assert.equal((await h.addStartupBlock(fishTarget, content, { backupFile: null })).result, "written");
    assert.equal(fs.readFileSync(file, "utf8"), content);
    assert.equal((await h.addStartupBlock(fishTarget, content, { backupFile: null })).result, "unchanged");
    assert.equal((await h.removeStartupBlock(file, "dropin", { created: true, joinedLastLine: false, homeDir: home })).result, "removed-file");
    fs.writeFileSync(file, "# the user's own file\n");
    assert.equal((await h.addStartupBlock(fishTarget, content, { backupFile: null })).result, "skipped");
    assert.equal((await h.removeStartupBlock(file, "dropin", { created: true, joinedLastLine: false, homeDir: home })).result, "skipped");
    assert.equal(fs.readFileSync(file, "utf8"), "# the user's own file\n");
  }
  pass("fish: the drop-in is Codara's whole file; a same-named file of the user's is never touched");

  // --- The whole install against a fake home ---------------------------------
  {
    const home = fresh("install");
    const codara = path.join(home, ".codarastudio");
    fs.writeFileSync(path.join(home, ".bashrc"), "# mine\n", { mode: 0o644 });
    const context = {
      codaraHome: codara,
      homeDir: home,
      platform: "linux",
      env: {},
      loginShell: "/bin/bash",
      liveConfigDir: path.join(codara, "claude-cli", "live", "home"),
      resolveZdotdir: async () => null,
      now: () => new Date("2026-10-15T10:00:00Z"),
    };
    const first = await h.installClaudeFollow(context, "/opt/Codara.AppImage");
    assert.deepEqual(first.files.map((file) => [path.basename(file.path), file.result]), [[".bashrc", "written"]]);
    assert.equal(fs.existsSync(path.join(home, ".zshrc")), false, "no file for a shell the user does not use");
    const paths = h.claudeFollowPaths(codara);
    const manifest = await h.readClaudeFollowManifest(paths);
    assert.equal(manifest.entries.length, 1);
    assert.equal(fs.readFileSync(manifest.entries[0].backup, "utf8"), "# mine\n");
    const again = await h.installClaudeFollow(context, "/opt/Codara.AppImage");
    assert.deepEqual(again.files.map((file) => file.result), ["unchanged"]);
    assert.equal(fs.readdirSync(path.join(codara, "backups", "claude-follow")).length, 1, "one backup, made before the first edit");
    // The user deletes the line by hand: the next start adds it back, and removal still works.
    fs.writeFileSync(path.join(home, ".bashrc"), "# mine\n");
    await h.installClaudeFollow(context, "/opt/Codara.AppImage");
    assert.match(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), /codara studio claude/);
    // The manifest lost: an installed build's removal still finds the block.
    fs.rmSync(paths.manifestFile);
    const removed = await h.removeClaudeFollow(context, { scanStartupFiles: true });
    assert.deepEqual(removed.files.map((file) => file.result), ["written"]);
    assert.equal(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), "# mine\n");
    assert.equal(fs.readdirSync(paths.shellDir).filter((name) => name.startsWith("claude-follow")).length, 0);
  }
  pass("install: only used shells, idempotent, one backup, re-adds a hand-deleted line, removal works without the manifest");

  // --- The Windows uninstaller's script ---------------------------------------
  {
    // Built the way electron.vite.config.ts builds it, run the way the NSIS
    // macro runs it (plain Node), against a fake HOME with a Codara setup.
    const home = fresh("uninstall");
    const codara = path.join(home, ".codarastudio");
    fs.writeFileSync(path.join(home, ".bashrc"), "# mine\n");
    fs.writeFileSync(path.join(home, ".zshrc"), "# my zsh\n");
    const context = {
      codaraHome: codara,
      homeDir: home,
      platform: "linux",
      env: {},
      loginShell: "/bin/bash",
      liveConfigDir: path.join(codara, "claude-cli", "live", "home"),
      resolveZdotdir: async () => null,
    };
    await h.installClaudeFollow(context, "/opt/Codara.AppImage");
    const paths = h.claudeFollowPaths(codara);
    await h.writeClaudeFollowFlag(paths, true);
    const script = path.join(TMP, "claude-follow-uninstall.js");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "claude-follow", "uninstall-entry.ts")],
      outfile: script,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      alias: { "@shared": path.join(ROOT, "src", "shared") },
    });
    assert.doesNotMatch(fs.readFileSync(script, "utf8"), /require\(["']electron["']\)/, "the script never loads electron");
    const env = { PATH: process.env.PATH, HOME: home, SHELL: "/bin/bash" };
    const run = require("node:child_process").spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0);
    assert.equal(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), "# mine\n");
    assert.equal(fs.readFileSync(path.join(home, ".zshrc"), "utf8"), "# my zsh\n");
    for (const file of [paths.flagFile, paths.manifestFile, paths.script("bash"), paths.script("zsh")]) {
      assert.equal(fs.existsSync(file), false, `${path.basename(file)} is gone`);
    }
    // Run again on a home with nothing to do: still exits 0.
    assert.equal(require("node:child_process").spawnSync(process.execPath, [script], { env, encoding: "utf8" }).status, 0);
  }
  pass("the uninstaller's script takes every line out and always exits 0");

  // --- Which builds may add the line ------------------------------------------
  {
    const transient = (roots) => async (target) => roots.some((root) => target.startsWith(root));
    const probe = (extra) => ({
      platform: "linux",
      isPackaged: true,
      execPath: "/tmp/.mount_Codara/codara-studio",
      env: { APPIMAGE: "/home/u/Apps/Codara.AppImage" },
      codaraHome: "/home/u/.codarastudio",
      fromAppImage: true,
      isTransientPath: transient(["/tmp/", "/home/u/worktrees/"]),
      ...extra,
    });
    assert.deepEqual(await h.claudeFollowGate(probe({})), { allowed: true, appPath: "/home/u/Apps/Codara.AppImage", dev: false });
    assert.deepEqual(await h.claudeFollowGate(probe({ isPackaged: false })), { allowed: false, reason: "development" });
    assert.deepEqual(await h.claudeFollowGate(probe({ codaraHome: "/tmp/codara-test/home" })), { allowed: false, reason: "temporary" });
    assert.deepEqual(await h.claudeFollowGate(probe({ fromAppImage: false, execPath: "/home/u/repo/dist/linux-unpacked/codara" })), { allowed: false, reason: "location" });
    assert.deepEqual(await h.claudeFollowGate(probe({ env: { APPIMAGE: "/tmp/Codara.AppImage" } })), { allowed: false, reason: "location" });
    assert.deepEqual(
      await h.claudeFollowGate(probe({ platform: "darwin", fromAppImage: false, env: {}, execPath: "/Volumes/Codara Studio/Codara Studio.app/Contents/MacOS/Codara Studio" })),
      { allowed: false, reason: "location" },
      "started from the disk image",
    );
    assert.deepEqual(
      await h.claudeFollowGate(probe({ platform: "darwin", fromAppImage: false, env: {}, execPath: "/private/var/folders/x/T/AppTranslocation/ABC/d/Codara Studio.app/Contents/MacOS/Codara Studio" })),
      { allowed: false, reason: "location" },
    );
    assert.deepEqual(
      await h.claudeFollowGate(probe({ platform: "darwin", fromAppImage: false, env: {}, execPath: "/Applications/Codara Studio.app/Contents/MacOS/Codara Studio" })),
      { allowed: true, appPath: "/Applications/Codara Studio.app", dev: false },
    );
    assert.deepEqual(
      await h.claudeFollowGate(probe({ isPackaged: false, fromAppImage: false, env: { CODARA_CLAUDE_FOLLOW_DEV: "1" }, execPath: "/home/u/worktrees/x/node_modules/electron/dist/electron" })),
      { allowed: true, appPath: "/home/u/worktrees/x/node_modules/electron/dist/electron", dev: true },
      "the documented development opt-in",
    );
    assert.deepEqual(
      await h.claudeFollowGate(probe({ isPackaged: false, env: { CODARA_CLAUDE_FOLLOW_DEV: "1" }, codaraHome: "/tmp/test-home" })),
      { allowed: false, reason: "temporary" },
      "never for a temporary Codara folder, opt-in or not",
    );
  }
  pass("gate: installed AppImage and /Applications app yes; dev, test, worktree, unpacked, disk image and translocated copies no; dev opt-in documented");

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
