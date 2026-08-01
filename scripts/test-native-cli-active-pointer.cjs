#!/usr/bin/env node
// Contract test for the "Active account in your terminal" pointer and the
// consent-gated shell-profile block. No Electron, no CLI, no credential.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
// realpath: macOS $TMPDIR is itself a symlink, and this test compares link
// targets and sourced values against literal paths.
const TMP = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "codara-active-pointer-")),
);
const ENTRY = path.join(TMP, "entry.ts");
const OUT = path.join(TMP, "bundle.cjs");
const source = (name) =>
  JSON.stringify(
    path.join(ROOT, "src", "main", "orchestration", name).replace(/\.ts$/, ""),
  );

fs.writeFileSync(
  ENTRY,
  [
    `export * from ${source("native-cli-active-pointer.ts")};`,
    `export * from ${source("native-cli-shell-profile.ts")};`,
  ].join("\n"),
);
buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: OUT,
  external: ["electron"],
});

const {
  reconcileNativeCliActivePointers,
  nativeCliActivePointerDir,
  NATIVE_CLI_ACTIVE_ENV_FILE,
  installNativeCliShellProfile,
  uninstallNativeCliShellProfile,
  nativeCliShellProfileStatus,
  NATIVE_CLI_SHELL_BLOCK_BEGIN,
  NATIVE_CLI_SHELL_BACKUP_SUFFIX,
} = require(OUT);

const CLAUDE_ID = "50000000-0000-4000-8000-000000000001";
const CLAUDE_ID_2 = "50000000-0000-4000-8000-000000000002";
const CODEX_ID = "60000000-0000-4000-8000-000000000001";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} — ${err.message}`);
  }
}

function makeCase(name) {
  const root = path.join(TMP, name);
  const home = path.join(root, "codara-home");
  const claudeRoot = path.join(root, "claude-cli");
  const codexRoot = path.join(root, "codex-cli");
  const personalClaude = path.join(root, "personal", ".claude");
  const personalCodex = path.join(root, "personal", ".codex");
  fs.mkdirSync(path.join(claudeRoot, "accounts"), { recursive: true });
  fs.mkdirSync(path.join(codexRoot, "accounts"), { recursive: true });
  fs.mkdirSync(personalClaude, { recursive: true });
  fs.mkdirSync(personalCodex, { recursive: true });
  return {
    options: {
      homeDir: home,
      claudeRootDir: claudeRoot,
      codexRootDir: codexRoot,
      personalClaudeConfigDir: personalClaude,
      personalCodexHomeDir: personalCodex,
    },
    home,
    claudeRoot,
    codexRoot,
    personalClaude,
    personalCodex,
    pointerDir: nativeCliActivePointerDir(home),
    writeList(runtimeRoot, profiles, activeId) {
      for (const id of profiles) {
        fs.mkdirSync(path.join(runtimeRoot, "accounts", id), { recursive: true });
      }
      fs.writeFileSync(
        path.join(runtimeRoot, "account-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: profiles.map((id) => ({
            id,
            label: `Account ${id.slice(0, 4)}`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })),
          defaultProfileId: activeId,
        }),
      );
    },
  };
}

// Read the generated file the way a login shell does, so the assertions cover
// the actual exported values rather than the text that produced them.
function sourcedEnv(envFile, variable) {
  return execFileSync(
    "/bin/sh",
    ["-c", `. ${JSON.stringify(envFile)}; printf '%s' "\${${variable}-<unset>}"`],
    { encoding: "utf8" },
  );
}

async function main() {
  // ── personal by default ──
  {
    const c = makeCase("personal");
    const state = await reconcileNativeCliActivePointers(c.options);
    await check("no account store yet leaves both pointers on the personal login", () => {
      assert.equal(state.supported, true);
      assert.equal(state.pointers.length, 2);
      for (const pointer of state.pointers) {
        assert.equal(pointer.profileId, "personal");
        assert.equal(pointer.exported, false);
      }
      assert.equal(
        fs.readlinkSync(path.join(c.pointerDir, "claude")),
        c.personalClaude,
      );
      assert.equal(
        fs.readlinkSync(path.join(c.pointerDir, "codex")),
        c.personalCodex,
      );
    });
    await check("a personal Active account exports nothing at all", () => {
      const envFile = path.join(c.pointerDir, NATIVE_CLI_ACTIVE_ENV_FILE);
      assert.equal(sourcedEnv(envFile, "CLAUDE_CONFIG_DIR"), "<unset>");
      assert.equal(sourcedEnv(envFile, "CODEX_HOME"), "<unset>");
      // Claude Code only uses its default Keychain item when the selector is
      // unset, so an exported personal path would read as signed out.
      assert.match(fs.readFileSync(envFile, "utf8"), /unset CLAUDE_CONFIG_DIR/);
    });
    await check("the generated env file is owner-only", () => {
      const mode =
        fs.statSync(path.join(c.pointerDir, NATIVE_CLI_ACTIVE_ENV_FILE)).mode &
        0o777;
      assert.equal(mode, 0o600);
    });
  }

  // ── managed accounts, and what each runtime exports ──
  {
    const c = makeCase("managed");
    c.writeList(c.claudeRoot, [CLAUDE_ID, CLAUDE_ID_2], CLAUDE_ID);
    c.writeList(c.codexRoot, [CODEX_ID], CODEX_ID);
    const state = await reconcileNativeCliActivePointers(c.options);
    const claudeDir = path.join(c.claudeRoot, "accounts", CLAUDE_ID);
    const codexDir = path.join(c.codexRoot, "accounts", CODEX_ID);
    const envFile = path.join(c.pointerDir, NATIVE_CLI_ACTIVE_ENV_FILE);
    await check("each pointer resolves to the Active account's own directory", () => {
      assert.equal(fs.readlinkSync(path.join(c.pointerDir, "claude")), claudeDir);
      assert.equal(fs.readlinkSync(path.join(c.pointerDir, "codex")), codexDir);
      assert.equal(state.pointers[0].profileId, CLAUDE_ID);
      assert.equal(state.pointers[0].fellBackToPersonal, false);
    });
    await check("Claude exports the resolved directory, never the symlink", () => {
      // Claude Code hashes the literal CLAUDE_CONFIG_DIR string into its macOS
      // Keychain service name, so the symlink path would be a separate
      // credential slot shared by every account.
      assert.equal(sourcedEnv(envFile, "CLAUDE_CONFIG_DIR"), claudeDir);
      assert.ok(
        !fs.readFileSync(envFile, "utf8").includes(`'${c.pointerDir}/claude'`),
        "env.sh must not export the Claude symlink path",
      );
    });
    await check("Codex exports the symlink so open terminals follow a switch", () => {
      assert.equal(
        sourcedEnv(envFile, "CODEX_HOME"),
        path.join(c.pointerDir, "codex"),
      );
      assert.equal(fs.realpathSync(sourcedEnv(envFile, "CODEX_HOME")), codexDir);
    });

    // ── switching the Active account ──
    c.writeList(c.claudeRoot, [CLAUDE_ID, CLAUDE_ID_2], CLAUDE_ID_2);
    await reconcileNativeCliActivePointers(c.options);
    await check("changing the Active account repoints the link and the exports", () => {
      const moved = path.join(c.claudeRoot, "accounts", CLAUDE_ID_2);
      assert.equal(fs.readlinkSync(path.join(c.pointerDir, "claude")), moved);
      assert.equal(sourcedEnv(envFile, "CLAUDE_CONFIG_DIR"), moved);
    });
    await check("an open terminal follows a Codex switch without re-sourcing", async () => {
      // CODEX_HOME still holds the same string; only the link moved.
      const before = sourcedEnv(envFile, "CODEX_HOME");
      const second = "60000000-0000-4000-8000-000000000002";
      c.writeList(c.codexRoot, [CODEX_ID, second], second);
      await reconcileNativeCliActivePointers(c.options);
      assert.equal(sourcedEnv(envFile, "CODEX_HOME"), before);
      assert.equal(
        fs.realpathSync(before),
        path.join(c.codexRoot, "accounts", second),
      );
    });

    // ── deleted account ──
    fs.rmSync(path.join(c.claudeRoot, "accounts", CLAUDE_ID_2), {
      recursive: true,
      force: true,
    });
    const afterDelete = await reconcileNativeCliActivePointers(c.options);
    await check("a deleted Active account falls back to the personal login", () => {
      const claude = afterDelete.pointers.find((p) => p.runtime === "claude");
      assert.equal(claude.profileId, "personal");
      assert.equal(claude.fellBackToPersonal, true);
      assert.equal(claude.exported, false);
      assert.equal(
        fs.readlinkSync(path.join(c.pointerDir, "claude")),
        c.personalClaude,
      );
      assert.equal(sourcedEnv(envFile, "CLAUDE_CONFIG_DIR"), "<unset>");
    });
  }

  // ── overlapping switches ──
  {
    const c = makeCase("overlapping");
    c.writeList(c.claudeRoot, [CLAUDE_ID, CLAUDE_ID_2], CLAUDE_ID);
    const finished = [];
    const first = reconcileNativeCliActivePointers(c.options).then((state) => {
      finished.push("first");
      return state;
    });
    // The user clicks the second account before the first reconcile lands.
    c.writeList(c.claudeRoot, [CLAUDE_ID, CLAUDE_ID_2], CLAUDE_ID_2);
    const second = reconcileNativeCliActivePointers(c.options).then((state) => {
      finished.push("second");
      return state;
    });
    const [, latest] = await Promise.all([first, second]);
    await check("two overlapping reconciles end on the last requested state", () => {
      const expected = path.join(c.claudeRoot, "accounts", CLAUDE_ID_2);
      assert.deepEqual(finished, ["first", "second"]);
      assert.equal(fs.readlinkSync(path.join(c.pointerDir, "claude")), expected);
      assert.equal(
        latest.pointers.find((p) => p.runtime === "claude").target,
        expected,
      );
      assert.equal(
        sourcedEnv(path.join(c.pointerDir, NATIVE_CLI_ACTIVE_ENV_FILE), "CLAUDE_CONFIG_DIR"),
        expected,
      );
    });
  }

  // ── safety ──
  {
    const c = makeCase("safety");
    const linkPath = path.join(c.pointerDir, "claude");
    fs.mkdirSync(linkPath, { recursive: true });
    fs.writeFileSync(path.join(linkPath, "keep-me.txt"), "user data");
    const state = await reconcileNativeCliActivePointers(c.options);
    await check("a real directory at the link path is reported, never removed", () => {
      assert.ok(state.error, "expected an error to be reported");
      assert.equal(fs.readFileSync(path.join(linkPath, "keep-me.txt"), "utf8"), "user data");
      assert.equal(state.pointers.some((p) => p.runtime === "claude"), false);
    });
  }
  {
    const c = makeCase("credentials");
    c.writeList(c.codexRoot, [CODEX_ID], CODEX_ID);
    const authFile = path.join(c.codexRoot, "accounts", CODEX_ID, "auth.json");
    fs.writeFileSync(authFile, '{"tokens":"secret"}');
    fs.chmodSync(authFile, 0o000);
    const state = await reconcileNativeCliActivePointers(c.options);
    await check("an unreadable credential file is never opened", () => {
      assert.equal(state.error, undefined);
      assert.equal(
        fs.readlinkSync(path.join(c.pointerDir, "codex")),
        path.join(c.codexRoot, "accounts", CODEX_ID),
      );
      assert.equal((fs.statSync(authFile).mode & 0o777), 0o000);
    });
    fs.chmodSync(authFile, 0o600);
  }

  // ── shell profile ──
  {
    const home = path.join(TMP, "shell-home");
    fs.mkdirSync(home, { recursive: true });
    const rc = path.join(home, ".zshrc");
    fs.writeFileSync(rc, "export PATH=/usr/local/bin:$PATH\nalias ll='ls -la'\n");
    fs.chmodSync(rc, 0o644);
    const envFile = path.join(home, ".Codara", "cli", "active", "env.sh");
    const options = { envFile, shell: "/bin/zsh", homeDir: home };

    const before = await nativeCliShellProfileStatus(options);
    await check("status reports the shell, the file, and that nothing is installed", () => {
      assert.equal(before.supported, true);
      assert.equal(before.installed, false);
      assert.equal(before.shell, "zsh");
      assert.equal(before.profilePath, rc);
      assert.match(before.snippet, /\$HOME\/\.Codara\/cli\/active\/env\.sh/);
    });

    const installed = await installNativeCliShellProfile(options);
    const afterInstall = fs.readFileSync(rc, "utf8");
    await check("install appends one marked block and keeps the original lines", () => {
      assert.equal(installed.installed, true);
      assert.match(afterInstall, /alias ll='ls -la'/);
      assert.equal(afterInstall.split(NATIVE_CLI_SHELL_BLOCK_BEGIN).length - 1, 1);
      assert.match(afterInstall, /\. "\$HOME\/\.Codara\/cli\/active\/env\.sh"/);
    });
    await check("install keeps one backup of the untouched file", () => {
      const backup = fs.readFileSync(`${rc}${NATIVE_CLI_SHELL_BACKUP_SUFFIX}`, "utf8");
      assert.equal(backup, "export PATH=/usr/local/bin:$PATH\nalias ll='ls -la'\n");
    });
    await check("install preserves the file's own permissions", () => {
      assert.equal(fs.statSync(rc).mode & 0o777, 0o644);
    });

    await installNativeCliShellProfile(options);
    await check("installing twice never stacks a second block", () => {
      const twice = fs.readFileSync(rc, "utf8");
      assert.equal(twice.split(NATIVE_CLI_SHELL_BLOCK_BEGIN).length - 1, 1);
      assert.equal(twice, afterInstall);
    });
    await check("the backup is not overwritten by the second install", () => {
      const backup = fs.readFileSync(`${rc}${NATIVE_CLI_SHELL_BACKUP_SUFFIX}`, "utf8");
      assert.ok(!backup.includes(NATIVE_CLI_SHELL_BLOCK_BEGIN));
    });

    const removed = await uninstallNativeCliShellProfile(options);
    await check("uninstall removes the block and leaves the rest untouched", () => {
      assert.equal(removed.installed, false);
      const after = fs.readFileSync(rc, "utf8");
      assert.equal(after, "export PATH=/usr/local/bin:$PATH\nalias ll='ls -la'\n");
    });

    const bashHome = path.join(TMP, "bash-home");
    fs.mkdirSync(bashHome, { recursive: true });
    const bashStatus = await installNativeCliShellProfile({
      envFile,
      shell: "/bin/bash",
      homeDir: bashHome,
    });
    await check("bash writes .bashrc, creating it when the user has none", () => {
      assert.equal(bashStatus.profilePath, path.join(bashHome, ".bashrc"));
      assert.match(
        fs.readFileSync(path.join(bashHome, ".bashrc"), "utf8"),
        new RegExp(NATIVE_CLI_SHELL_BLOCK_BEGIN),
      );
    });

    // ── a dotfile manager's symlink (stow, chezmoi, a dotfiles repo) ──
    {
      const linkHome = path.join(TMP, "symlink-home");
      const repo = path.join(TMP, "dotfiles-repo");
      fs.mkdirSync(linkHome, { recursive: true });
      fs.mkdirSync(repo, { recursive: true });
      const real = path.join(repo, "zshrc");
      fs.writeFileSync(real, "alias gs='git status'\n");
      const rcLink = path.join(linkHome, ".zshrc");
      fs.symlinkSync(real, rcLink);
      const linkOptions = { envFile, shell: "/bin/zsh", homeDir: linkHome };

      const installedLink = await installNativeCliShellProfile(linkOptions);
      await check("install writes through a symlinked startup file, never over it", () => {
        assert.equal(installedLink.installed, true);
        assert.ok(
          fs.lstatSync(rcLink).isSymbolicLink(),
          "the dotfile link must survive the install",
        );
        assert.equal(fs.readlinkSync(rcLink), real);
        const written = fs.readFileSync(real, "utf8");
        assert.match(written, /alias gs='git status'/);
        assert.equal(written.split(NATIVE_CLI_SHELL_BLOCK_BEGIN).length - 1, 1);
      });

      const removedLink = await uninstallNativeCliShellProfile(linkOptions);
      await check("uninstall writes through the same link and leaves it intact", () => {
        assert.equal(removedLink.installed, false);
        assert.ok(fs.lstatSync(rcLink).isSymbolicLink());
        assert.equal(fs.readFileSync(real, "utf8"), "alias gs='git status'\n");
      });
    }

    // ── a link that leads nowhere ──
    {
      const brokenHome = path.join(TMP, "broken-link-home");
      fs.mkdirSync(brokenHome, { recursive: true });
      const rcLink = path.join(brokenHome, ".zshrc");
      fs.symlinkSync(path.join(TMP, "no-such-dotfile"), rcLink);
      const brokenOptions = { envFile, shell: "/bin/zsh", homeDir: brokenHome };
      const status = await nativeCliShellProfileStatus(brokenOptions);
      const attempted = await installNativeCliShellProfile(brokenOptions);
      await check("a link with no target is refused and explained, never replaced", () => {
        assert.equal(status.supported, false);
        assert.match(status.manualInstruction, /symbolic link/);
        assert.equal(attempted.supported, false);
        assert.equal(attempted.installed, false);
        assert.ok(fs.lstatSync(rcLink).isSymbolicLink());
        assert.equal(fs.existsSync(path.join(TMP, "no-such-dotfile")), false);
      });
    }

    const fish = await nativeCliShellProfileStatus({
      envFile,
      shell: "/opt/homebrew/bin/fish",
      homeDir: home,
    });
    await check("an unsupported shell is never edited, only explained", () => {
      assert.equal(fish.supported, false);
      assert.equal(fish.installed, false);
      assert.match(fish.manualInstruction, /\.zshrc and \.bashrc/);
      assert.equal(fish.profilePath, undefined);
    });
  }

  // ── no credential access anywhere in the feature ──
  await check("neither module names or opens a credential file", () => {
    for (const file of [
      "native-cli-active-pointer.ts",
      "native-cli-shell-profile.ts",
    ]) {
      const text = fs.readFileSync(
        path.join(ROOT, "src", "main", "orchestration", file),
        "utf8",
      );
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.ok(
        !/auth\.json|\.credentials\.json|readFile\([^)]*auth/i.test(code),
        `${file} references a credential file`,
      );
    }
  });

  if (failures) {
    console.error(`\n${failures} active-pointer check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll native CLI active-pointer checks passed.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
