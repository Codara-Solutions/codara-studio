#!/usr/bin/env node
// Pins the removal of the old combined native-CLI shell selector.
//
// The retired feature exported CLAUDE_CONFIG_DIR / CODEX_HOME from the user's
// shell profile. Claude Code keeps its chats, settings, agents, and commands
// inside the directory that variable selects, so switching the Active account
// silently swapped the user's terminal Claude Code state for an empty managed
// directory. These checks pin three things:
//
//   (a) no account selector may touch a shell startup file;
//   (b) no CODEX_HOME/CLAUDE_CONFIG_DIR export mechanism can return;
//   (c) the one-time cleanup removes exactly the three artifacts the old
//       feature generated, and refuses everything else.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
// realpath: macOS $TMPDIR is itself a symlink, and this test compares paths.
const TMP = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "codara-terminal-removal-")),
);
const OUT = path.join(TMP, "bundle.cjs");

buildSync({
  entryPoints: [
    path.join(ROOT, "src", "main", "orchestration", "native-cli-terminal-cleanup.ts"),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: OUT,
  external: ["electron"],
  alias: { "@shared": path.join(ROOT, "src", "shared") },
});

const {
  cleanupNativeCliActivePointerArtifacts,
  cleanupRetiredCodexHomeEnvironment,
  detectNativeCliShellProfileLeftover,
  NATIVE_CLI_SHELL_BLOCK_BEGIN,
  NATIVE_CLI_SHELL_BLOCK_END,
  NATIVE_CLI_ACTIVE_ENV_HEADER,
} = require(OUT);

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

function walkSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "out") continue;
      walkSources(file, out);
    } else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push(file);
    }
  }
  return out;
}

const ENV_FILE = "env.sh";
const GENERATED_ENV = `${NATIVE_CLI_ACTIVE_ENV_HEADER} — do not edit.\nexport CODEX_HOME='/tmp/x'\n`;

function makeHome(name) {
  const home = path.join(TMP, name);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function makePointerDir(home) {
  const dir = path.join(home, "cli", "active");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const sources = walkSources(path.join(ROOT, "src"));
  const cleanupPath = path.join(
    ROOT,
    "src",
    "main",
    "orchestration",
    "native-cli-terminal-cleanup.ts",
  );

  // ── (a) the retired combined feature stays gone ──
  await check("the shell-profile and active-pointer modules are gone", () => {
    for (const gone of [
      "src/main/orchestration/native-cli-shell-profile.ts",
      "src/main/orchestration/native-cli-active-pointer.ts",
      "src/shared/native-cli-terminal.ts",
      "scripts/test-native-cli-active-pointer.cjs",
    ]) {
      assert.equal(
        fs.existsSync(path.join(ROOT, gone)),
        false,
        `${gone} still exists`,
      );
    }
  });

  await check("no source installs, uninstalls, or reconciles the old feature", () => {
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      for (const banned of [
        "native-cli-terminal:install",
        "native-cli-terminal:uninstall",
        "native-cli-terminal:status",
        "installNativeCliShellProfile",
        "uninstallNativeCliShellProfile",
        "reconcileNativeCliActivePointers",
      ]) {
        assert.ok(
          !text.includes(banned),
          `${path.relative(ROOT, file)} still references ${banned}`,
        );
      }
    }
  });

  await check("Codara never installs, updates, or uninstalls native CLI binaries", () => {
    const directPackageManagerMutation =
      /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["'`](?:npm|pnpm|yarn|bun|brew)["'`][\s\S]{0,400}?\b(?:install|add|update|upgrade|uninstall|remove)\b/;
    const shellPackageManagerMutation =
      /\b(?:exec|execSync)\s*\(\s*["'`][^\n"'`]*(?:npm|pnpm|yarn|bun|brew)\s+(?:install|add|update|upgrade|uninstall|remove)\b/;
    for (const file of sources) {
      const code = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.ok(
        !directPackageManagerMutation.test(code) &&
          !shellPackageManagerMutation.test(code),
        `${path.relative(ROOT, file)} attempts to manage a native CLI package`,
      );
    }
  });

  await check("no source resolves a home-directory shell startup file to write it", () => {
    // A path like join(<home>, ".zshrc") is the user's own dotfile. Only the
    // read-only leftover detection may build one; shell-init.ts materializes
    // Codara's OWN rc shims strictly under its shell-integration cache dir.
    const homeRcJoin =
      /(?:homedir\(\)|homeDir|home)\s*,\s*["']\.(?:zshrc|bashrc|bash_profile|zprofile)["']/;
    const joining = sources
      .filter((file) => file !== cleanupPath)
      .filter((file) => homeRcJoin.test(fs.readFileSync(file, "utf8")));
    assert.deepEqual(
      joining.map((file) => path.relative(ROOT, file)),
      [],
    );
    const shellInit = fs.readFileSync(
      path.join(ROOT, "src", "main", "shell-init.ts"),
      "utf8",
    );
    assert.ok(
      shellInit.includes('".cache", "spark", "shell-integration"'),
      "shell-init.ts must keep its rc shims under its own cache directory",
    );
  });

  await check("the cleanup module itself can only delete, never create", () => {
    const text = fs.readFileSync(cleanupPath, "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const banned of [
      /\bwriteFile/,
      /\bappendFile/,
      /\bsymlink\s*\(/,
      /\bmkdir/,
      /\bcp\s*\(/,
      /\brm\s*\(/, // recursive rm is exactly what this module must never do
      /\brename\s*\(/,
      /createWriteStream/,
    ]) {
      assert.ok(!banned.test(code), `cleanup module matches ${banned}`);
    }
  });

  // ── (b) no combined selector export mechanism ──
  await check("no module renders a shell account selector", () => {
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      assert.ok(
        !/export (?:CLAUDE_CONFIG_DIR|CODEX_HOME)=/.test(text) &&
          !/(?:\$\{selector\}|selectorEnv\}?)=\$\{/.test(text) &&
          !text.includes("renderNativeCliActiveEnvFile"),
        `${path.relative(ROOT, file)} builds a shell export of the selector`,
      );
    }
  });

  await check("env.sh survives only inside the cleanup that deletes it", () => {
    for (const file of sources) {
      if (file === cleanupPath) continue;
      const code = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.ok(
        !code.includes("env.sh"),
        `${path.relative(ROOT, file)} still references env.sh in code`,
      );
    }
  });

  await check("the marker constants still match what the old feature wrote", () => {
    // Detection must recognize blocks written by earlier builds verbatim.
    assert.equal(NATIVE_CLI_SHELL_BLOCK_BEGIN, "# >>> codara active cli account >>>");
    assert.equal(NATIVE_CLI_SHELL_BLOCK_END, "# <<< codara active cli account <<<");
    assert.equal(NATIVE_CLI_ACTIVE_ENV_HEADER, "# Generated by Codara Studio");
  });

  // A running Studio may inherit the old selector even after the shell block
  // was removed. Clear Codara-owned/default values in memory, but preserve a
  // real custom Codex home chosen by the user.
  {
    const userHome = makeHome("process-env");
    const codaraHome = path.join(userHome, ".Codara");
    const personalCodexHome = path.join(userHome, ".codex");
    const managedHome = path.join(
      codaraHome,
      "codex-cli",
      "accounts",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const managedEnv = { PATH: "/safe/bin", CODEX_HOME: managedHome };
    const managedResult = cleanupRetiredCodexHomeEnvironment(managedEnv, {
      codaraHomeDir: codaraHome,
      personalCodexHomeDir: personalCodexHome,
    });
    await check("clears an inherited Codara-managed CODEX_HOME", () => {
      assert.deepEqual(managedResult.removedKeys, ["CODEX_HOME"]);
      assert.equal(managedEnv.CODEX_HOME, undefined);
      assert.equal(managedEnv.PATH, "/safe/bin");
    });

    const defaultEnv = { CODEX_HOME: personalCodexHome };
    cleanupRetiredCodexHomeEnvironment(defaultEnv, {
      codaraHomeDir: codaraHome,
      personalCodexHomeDir: personalCodexHome,
    });
    await check("clears redundant ~/.codex without changing its effective home", () => {
      assert.equal(defaultEnv.CODEX_HOME, undefined);
    });

    const customHome = path.join(userHome, "custom-codex");
    const customEnv = { CODEX_HOME: customHome };
    const customResult = cleanupRetiredCodexHomeEnvironment(customEnv, {
      codaraHomeDir: codaraHome,
      personalCodexHomeDir: personalCodexHome,
    });
    await check("preserves a user-selected custom CODEX_HOME", () => {
      assert.deepEqual(customResult.removedKeys, []);
      assert.equal(customEnv.CODEX_HOME, customHome);
    });

    const mainSource = fs.readFileSync(
      path.join(ROOT, "src", "main", "index.ts"),
      "utf8",
    );
    await check("cleans the inherited selector before Electron startup", () => {
      const cleanupCall = mainSource.indexOf(
        "cleanupRetiredCodexHomeEnvironment(process.env)",
      );
      assert.ok(cleanupCall >= 0);
      assert.ok(cleanupCall < mainSource.indexOf('app.setName("Codara Studio")'));
    });
  }

  // ── (c) the one-time cleanup ──
  {
    const home = makeHome("full-set");
    const dir = makePointerDir(home);
    const claudeTarget = path.join(home, "claude-cli", "accounts", "abc");
    const codexTarget = path.join(home, "codex-cli", "accounts", "def");
    fs.mkdirSync(claudeTarget, { recursive: true });
    fs.mkdirSync(codexTarget, { recursive: true });
    fs.writeFileSync(path.join(claudeTarget, "settings.json"), "{}");
    fs.symlinkSync(claudeTarget, path.join(dir, "claude"));
    fs.symlinkSync(codexTarget, path.join(dir, "codex"));
    fs.writeFileSync(path.join(dir, ENV_FILE), GENERATED_ENV);
    const result = await cleanupNativeCliActivePointerArtifacts(home);
    await check("removes the two symlinks, env.sh, and the emptied directory", () => {
      assert.equal(result.removed.length, 3);
      assert.equal(result.refused.length, 0);
      assert.equal(result.directoryRemoved, true);
      assert.equal(fs.existsSync(dir), false);
    });
    await check("the account directories the links pointed at are untouched", () => {
      assert.equal(
        fs.readFileSync(path.join(claudeTarget, "settings.json"), "utf8"),
        "{}",
      );
      assert.ok(fs.existsSync(codexTarget));
    });
    await check("the parent cli/ directory is left in place", () => {
      assert.ok(fs.existsSync(path.join(home, "cli")));
    });
    await check("a second run over the removed directory is a clean no-op", async () => {
      const again = await cleanupNativeCliActivePointerArtifacts(home);
      assert.deepEqual(again.removed, []);
      assert.deepEqual(again.refused, []);
      assert.equal(again.directoryRemoved, false);
    });
  }

  {
    const home = makeHome("missing");
    await check("a home that never had the feature is a no-op", async () => {
      const result = await cleanupNativeCliActivePointerArtifacts(home);
      assert.deepEqual(result.removed, []);
      assert.deepEqual(result.refused, []);
      assert.equal(result.directoryRemoved, false);
    });
  }

  {
    const home = makeHome("real-dir");
    const dir = makePointerDir(home);
    const realDir = path.join(dir, "claude");
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, "keep-me.txt"), "user data");
    fs.symlinkSync(path.join(home, "somewhere"), path.join(dir, "codex"));
    fs.writeFileSync(path.join(dir, ENV_FILE), GENERATED_ENV);
    const result = await cleanupNativeCliActivePointerArtifacts(home);
    await check("a real directory under a link name is refused, never deleted", () => {
      assert.equal(
        fs.readFileSync(path.join(realDir, "keep-me.txt"), "utf8"),
        "user data",
      );
      assert.ok(result.refused.some((entry) => entry.path === realDir));
    });
    await check("the recognizable artifacts are still removed around a refusal", () => {
      assert.equal(fs.existsSync(path.join(dir, "codex")), false);
      assert.equal(fs.existsSync(path.join(dir, ENV_FILE)), false);
    });
    await check("the directory stays while it still holds refused content", () => {
      assert.equal(result.directoryRemoved, false);
      assert.ok(fs.existsSync(dir));
    });
  }

  {
    const home = makeHome("foreign-env");
    const dir = makePointerDir(home);
    fs.writeFileSync(path.join(dir, ENV_FILE), "# my own notes\nexport FOO=1\n");
    const result = await cleanupNativeCliActivePointerArtifacts(home);
    await check("an env.sh without the generated header is refused", () => {
      assert.equal(
        fs.readFileSync(path.join(dir, ENV_FILE), "utf8"),
        "# my own notes\nexport FOO=1\n",
      );
      assert.ok(
        result.refused.some((entry) => /header/.test(entry.reason)),
      );
      assert.equal(result.directoryRemoved, false);
    });
  }

  {
    const home = makeHome("env-symlink");
    const dir = makePointerDir(home);
    const real = path.join(home, "real-env.sh");
    fs.writeFileSync(real, GENERATED_ENV);
    fs.symlinkSync(real, path.join(dir, ENV_FILE));
    const result = await cleanupNativeCliActivePointerArtifacts(home);
    await check("an env.sh that is a symlink is refused and its target kept", () => {
      assert.ok(result.refused.some((entry) => /regular file/.test(entry.reason)));
      assert.equal(fs.readFileSync(real, "utf8"), GENERATED_ENV);
      assert.ok(fs.lstatSync(path.join(dir, ENV_FILE)).isSymbolicLink());
    });
  }

  {
    const home = makeHome("stray");
    const dir = makePointerDir(home);
    fs.symlinkSync(path.join(home, "gone"), path.join(dir, "claude"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    const result = await cleanupNativeCliActivePointerArtifacts(home);
    await check("an unrecognized stray file keeps the directory alive", () => {
      assert.equal(fs.existsSync(path.join(dir, "claude")), false);
      assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "mine");
      assert.equal(result.directoryRemoved, false);
      assert.ok(fs.existsSync(dir));
    });
  }

  {
    const home = makeHome("dir-is-link");
    fs.mkdirSync(path.join(home, "cli"), { recursive: true });
    const elsewhere = path.join(home, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "claude"), "not ours");
    fs.symlinkSync(elsewhere, path.join(home, "cli", "active"));
    const result = await cleanupNativeCliActivePointerArtifacts(home);
    await check("an active/ that is itself a symlink is left entirely alone", () => {
      assert.equal(result.removed.length, 0);
      assert.ok(result.refused.some((entry) => /not a directory/.test(entry.reason)));
      assert.ok(fs.lstatSync(path.join(home, "cli", "active")).isSymbolicLink());
      assert.equal(fs.readFileSync(path.join(elsewhere, "claude"), "utf8"), "not ours");
    });
  }

  // ── leftover shell-block detection is read-only ──
  {
    const home = makeHome("shell-detect");
    const rc = path.join(home, ".zshrc");
    const contents = [
      "export PATH=/usr/local/bin:$PATH",
      NATIVE_CLI_SHELL_BLOCK_BEGIN,
      '. "$HOME/.Codara/cli/active/env.sh"',
      NATIVE_CLI_SHELL_BLOCK_END,
      "",
    ].join("\n");
    fs.writeFileSync(rc, contents);
    fs.chmodSync(rc, 0o644);
    const before = fs.statSync(rc);
    const leftover = await detectNativeCliShellProfileLeftover(home);
    await check("detection reports the file and the exact marker lines", () => {
      assert.equal(leftover.profilePath, rc);
      assert.equal(leftover.markerBegin, NATIVE_CLI_SHELL_BLOCK_BEGIN);
      assert.equal(leftover.markerEnd, NATIVE_CLI_SHELL_BLOCK_END);
    });
    await check("detection never modifies the startup file", () => {
      assert.equal(fs.readFileSync(rc, "utf8"), contents);
      assert.equal(fs.statSync(rc).mtimeMs, before.mtimeMs);
      assert.equal(fs.statSync(rc).mode & 0o777, 0o644);
      assert.equal(fs.existsSync(`${rc}.codara-backup`), false);
    });
  }

  {
    const home = makeHome("shell-bash");
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      `${NATIVE_CLI_SHELL_BLOCK_BEGIN}\n${NATIVE_CLI_SHELL_BLOCK_END}\n`,
    );
    await check("detection also covers .bashrc", async () => {
      const leftover = await detectNativeCliShellProfileLeftover(home);
      assert.equal(leftover.profilePath, path.join(home, ".bashrc"));
    });
  }

  {
    const home = makeHome("shell-clean");
    fs.writeFileSync(path.join(home, ".zshrc"), "alias ll='ls -la'\n");
    await check("a profile without the block reports nothing", async () => {
      assert.equal(await detectNativeCliShellProfileLeftover(home), null);
    });
  }

  {
    const home = makeHome("shell-none");
    await check("a home with no startup files reports nothing", async () => {
      assert.equal(await detectNativeCliShellProfileLeftover(home), null);
    });
  }

  if (failures) {
    console.error(`\n${failures} terminal-removal check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll native CLI terminal-removal checks passed.");
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
