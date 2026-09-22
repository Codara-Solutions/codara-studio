#!/usr/bin/env node
"use strict";

// A Studio shell must not inherit the wiring of the app that spawned it.
// Two leaks reached every pane through pty-manager's inherited base env:
//
//   - `npm run dev` (electron-vite dev) exports its dev-server wiring into the
//     Electron process. Panes then handed ELECTRON_RENDERER_URL to every
//     `electron .` they started, so Playwright specs loaded the live dev
//     server's renderer instead of out/renderer; ELECTRON_EXEC_PATH and
//     ELECTRON_MAJOR_VER to every other electron-vite project; and
//     NODE_ENV=development to every build. NODE_ENV is electron-vite's only
//     while it equals the NODE_ENV_ELECTRON_VITE marker; any other value is
//     the user's and stays.
//   - A Studio started from a Studio pane inherits ZDOTDIR pointing at the
//     outer instance's zsh integration dir. shell-init recorded that as the
//     user's own ZDOTDIR (SPARK_USER_ZDOTDIR), so every integration file
//     sourced itself until zsh stopped with "job table full or recursion
//     limit exceeded".
//
// Drives the real shell-init and pty-manager env construction (node-pty and
// the account runtimes stubbed as in test-pty-spawn-serialization.cjs), then
// runs each captured env through a real zsh with the bundled integration
// scripts.
//
//   node scripts/test-pty-inherited-env.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");
const {
  createController,
  stubPlugin,
  CACHE_ROOT,
} = require("./test-pty-spawn-serialization.cjs");

const ROOT = path.resolve(__dirname, "..");
const INTEGRATION = path.join(ROOT, "resources", "shell-integration");
const HAS_ZSH = fs.existsSync("/bin/zsh");

let failures = 0;
const check = (name, condition, detail) => {
  if (!condition) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

// pty-manager must see the real sanitizer; the shared harness stubs it out.
function realEnvSanitize() {
  const target = path.join(ROOT, "src", "main", "env-sanitize.ts");
  return {
    name: "real-env-sanitize",
    setup(build) {
      build.onResolve({ filter: /^\.\/env-sanitize$/ }, () => ({ path: target }));
    },
  };
}

function materializeIntegration(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [source, target] of [
    ["zshenv.zsh", ".zshenv"],
    ["zprofile.zsh", ".zprofile"],
    ["zlogin.zsh", ".zlogin"],
    ["zshrc.zsh", ".zshrc"],
  ]) {
    fs.copyFileSync(path.join(INTEGRATION, source), path.join(dir, target));
  }
}

// Each startup file the user owns bumps its own counter, so a probe shows
// exactly which of the user's files ran and how many times.
function writeUserStartupFiles(dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
    const name = `${tag}_${file.slice(1).toUpperCase()}`;
    fs.writeFileSync(path.join(dir, file), `export ${name}=$(( \${${name}:-0} + 1 ))\n`);
  }
}

const INHERITED_KEYS = [
  "ELECTRON_RENDERER_URL",
  "ELECTRON_CLI_ARGS",
  "ELECTRON_ENTRY",
  "ELECTRON_EXEC_PATH",
  "ELECTRON_MAJOR_VER",
  "NODE_ENV_ELECTRON_VITE",
  "NODE_ENV",
  "ZDOTDIR",
  "SPARK_USER_ZDOTDIR",
];

const PROBE =
  'print -r -- "@@[${NODE_ENV-unset}][${ELECTRON_RENDERER_URL-unset}]' +
  '[${HOME_ZSHENV:-0}${HOME_ZPROFILE:-0}${HOME_ZSHRC:-0}${HOME_ZLOGIN:-0}]' +
  '[${CUSTOM_ZSHENV:-0}${CUSTOM_ZPROFILE:-0}${CUSTOM_ZSHRC:-0}${CUSTOM_ZLOGIN:-0}]@@"';

function runZsh(call) {
  const result = spawnSync(call.exe, [...call.args, "-i", "-c", PROBE], {
    cwd: call.options.cwd,
    env: call.options.env,
    encoding: "latin1",
    timeout: 20_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const match = /@@\[(.*?)\]\[(.*?)\]\[(\d{4})\]\[(\d{4})\]@@/.exec(output);
  return {
    output,
    nodeEnv: match?.[1],
    rendererUrl: match?.[2],
    homeFiles: match?.[3],
    customFiles: match?.[4],
    recursed: /job table full|recursion limit exceeded/.test(output),
  };
}

async function main() {
  if (process.platform === "win32") {
    console.log("SKIP zsh and electron-vite pane env (POSIX only)");
    return;
  }
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const bundleDir = fs.mkdtempSync(path.join(CACHE_ROOT, "pty-inherited-env-"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pty-inherited-env-"));
  const home = path.join(tmp, "home");
  const ownIntegration = path.join(home, ".cache", "spark", "shell-integration", "zsh");
  // An outer instance started with a different HOME (every e2e spec does).
  const outerIntegration = path.join(tmp, "outer-home", ".cache", "spark", "shell-integration", "zsh");
  const customZdotdir = path.join(tmp, "custom-zdotdir");
  writeUserStartupFiles(home, "HOME");
  writeUserStartupFiles(customZdotdir, "CUSTOM");
  materializeIntegration(outerIntegration);

  const savedEnv = { ...process.env };
  process.env.HOME = home;
  process.env.SHELL = "/bin/zsh";

  const entry = path.join(bundleDir, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export { spawn, dispose } from ${JSON.stringify(path.join(ROOT, "src", "main", "pty-manager.ts"))};`,
      `export { buildIntegratedShellLaunch } from ${JSON.stringify(path.join(ROOT, "src", "main", "shell-init.ts"))};`,
    ].join("\n"),
  );
  const outfile = path.join(bundleDir, "bundle.cjs");
  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      plugins: [realEnvSanitize(), stubPlugin()],
      logLevel: "silent",
    });
    const controller = createController();
    globalThis.__codaraPtySpawnHarness = controller;
    const mod = require(outfile);

    let seq = 0;
    // Spawns the way the renderer does: shells:integratedDefault resolves the
    // launch against the app's own env, then pty-manager builds the child env.
    const spawnPane = async (inherited, { integrated = true } = {}) => {
      for (const key of INHERITED_KEYS) delete process.env[key];
      Object.assign(process.env, inherited);
      const shell = integrated
        ? { id: "integrated", ...(await mod.buildIntegratedShellLaunch()) }
        : { id: "/bin/zsh", label: "zsh", exe: "/bin/zsh", args: ["-l"], family: "zsh" };
      const id = `inherited-env-${++seq}`;
      await mod.spawn({ id, shell, cwd: home, cols: 80, rows: 24, webContents: null });
      const call = controller.localSpawnCalls.at(-1);
      controller.exitLocal(call.pid);
      mod.dispose(id);
      return call;
    };

    // --- electron-vite dev wiring ------------------------------------------
    {
      const call = await spawnPane({
        ELECTRON_RENDERER_URL: "http://localhost:5173",
        ELECTRON_CLI_ARGS: "[]",
        ELECTRON_ENTRY: ".",
        ELECTRON_EXEC_PATH: "/outer/node_modules/electron/dist/Electron",
        ELECTRON_MAJOR_VER: "43",
        NODE_ENV_ELECTRON_VITE: "development",
        NODE_ENV: "development",
      });
      const env = call.options.env;
      const leaked = INHERITED_KEYS.slice(0, 7).filter((key) => key in env);
      check("a dev app's pane carries none of electron-vite's variables", leaked.length === 0, leaked);
      check("the pane keeps its own Codara marker", env.SPARK_TERMINAL === "1", env.SPARK_TERMINAL);
      if (HAS_ZSH) {
        const zsh = runZsh(call);
        check(
          "zsh in a dev app's pane sees empty NODE_ENV and ELECTRON_RENDERER_URL",
          zsh.nodeEnv === "unset" && zsh.rendererUrl === "unset",
          zsh.output.slice(-400),
        );
      }
    }
    {
      const call = await spawnPane({ NODE_ENV: "production" });
      check(
        "a NODE_ENV without electron-vite's marker is the user's and survives",
        call.options.env.NODE_ENV === "production",
        call.options.env.NODE_ENV,
      );
    }
    {
      const call = await spawnPane({ NODE_ENV_ELECTRON_VITE: "development", NODE_ENV: "staging" });
      check(
        "a NODE_ENV that differs from electron-vite's marker survives",
        call.options.env.NODE_ENV === "staging" && !("NODE_ENV_ELECTRON_VITE" in call.options.env),
        { NODE_ENV: call.options.env.NODE_ENV, marker: call.options.env.NODE_ENV_ELECTRON_VITE },
      );
    }
    {
      const call = await spawnPane({ NODE_ENV_ELECTRON_VITE: "production", NODE_ENV: "production" });
      check(
        "electron-vite build/preview's NODE_ENV is stripped too",
        !("NODE_ENV" in call.options.env),
        call.options.env.NODE_ENV,
      );
    }

    // --- nested instance: ZDOTDIR inherited from an outer Codara pane -------
    const nested = [
      {
        name: "same HOME, the user had no ZDOTDIR",
        inherited: { ZDOTDIR: ownIntegration },
        userZdotdir: undefined,
      },
      {
        name: "different HOME, the user had no ZDOTDIR",
        inherited: { ZDOTDIR: `${outerIntegration}/` },
        userZdotdir: undefined,
      },
      {
        name: "the outer pane recorded the user's own ZDOTDIR",
        inherited: { ZDOTDIR: outerIntegration, SPARK_USER_ZDOTDIR: customZdotdir },
        userZdotdir: customZdotdir,
      },
      {
        name: "an already nested pane recorded an integration dir as the user's",
        inherited: { ZDOTDIR: ownIntegration, SPARK_USER_ZDOTDIR: outerIntegration },
        userZdotdir: undefined,
      },
    ];
    for (const scenario of nested) {
      const call = await spawnPane(scenario.inherited);
      const env = call.options.env;
      check(
        `nested (${scenario.name}): zsh starts in this instance's integration dir`,
        env.ZDOTDIR === ownIntegration,
        env.ZDOTDIR,
      );
      check(
        `nested (${scenario.name}): SPARK_USER_ZDOTDIR names the user's own dir`,
        env.SPARK_USER_ZDOTDIR === scenario.userZdotdir,
        env.SPARK_USER_ZDOTDIR,
      );
      if (HAS_ZSH) {
        const zsh = runZsh(call);
        const expectHome = scenario.userZdotdir ? "0000" : "1111";
        const expectCustom = scenario.userZdotdir ? "1111" : "0000";
        check(
          `nested (${scenario.name}): zsh starts without recursing and runs each user file once`,
          !zsh.recursed && zsh.homeFiles === expectHome && zsh.customFiles === expectCustom,
          zsh.recursed ? zsh.output.split("\n").slice(0, 3) : { home: zsh.homeFiles, custom: zsh.customFiles },
        );
      }
    }
    {
      const call = await spawnPane(
        { ZDOTDIR: outerIntegration, SPARK_USER_ZDOTDIR: customZdotdir },
        { integrated: false },
      );
      check(
        "nested: a shell without integration gets the user's own ZDOTDIR back",
        call.options.env.ZDOTDIR === customZdotdir && !("SPARK_USER_ZDOTDIR" in call.options.env),
        { ZDOTDIR: call.options.env.ZDOTDIR, SPARK_USER_ZDOTDIR: call.options.env.SPARK_USER_ZDOTDIR },
      );
    }
    {
      const call = await spawnPane({ ZDOTDIR: outerIntegration }, { integrated: false });
      check(
        "nested: a shell without integration and no recorded ZDOTDIR falls back to HOME",
        !("ZDOTDIR" in call.options.env),
        call.options.env.ZDOTDIR,
      );
    }
    {
      const call = await spawnPane({ ZDOTDIR: customZdotdir });
      check(
        "top level: a user's own ZDOTDIR is still recorded for the integration",
        call.options.env.ZDOTDIR === ownIntegration && call.options.env.SPARK_USER_ZDOTDIR === customZdotdir,
        { ZDOTDIR: call.options.env.ZDOTDIR, SPARK_USER_ZDOTDIR: call.options.env.SPARK_USER_ZDOTDIR },
      );
    }
    if (!HAS_ZSH) console.log("SKIP real zsh probes (/bin/zsh not found)");
  } finally {
    delete globalThis.__codaraPtySpawnHarness;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(bundleDir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
