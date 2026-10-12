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
//   - A Studio started from a terminal (`npm run dev` in WezTerm) inherits
//     that terminal's identity and pane address. In a pane, Claude Code's
//     /sessions picker ran `wezterm cli split-pane --pane-id $WEZTERM_PANE`
//     and opened in the WezTerm window running `npm run dev`, not in Codara.
//   - An installed AppImage hands its panes APPIMAGE and APPDIR. An unpacked
//     build started there took itself for that AppImage, so its boot cleanup
//     treated it as installed and rewrote the user's real CLI configs.
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

// The harness stubs injectEnrichedPath to a no-op; this one hands the pane
// the PATH a test sets, as the real one hands it the login shell's merged
// with the process's own.
function enrichedPathStub() {
  return {
    name: "enriched-path-stub",
    setup(build) {
      build.onResolve({ filter: /^\.\/path-reconstruction$/ }, () => ({ path: "path-reconstruction", namespace: "enriched-path" }));
      build.onLoad({ filter: /.*/, namespace: "enriched-path" }, () => ({
        contents:
          "export function injectEnrichedPath(env) { if (globalThis.__codaraEnrichedPath) env.PATH = globalThis.__codaraEnrichedPath; }",
        loader: "js",
      }));
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

// What WezTerm, tmux and kitty export to the shell Codara was started from.
const HOST_TERMINAL = {
  TERM_PROGRAM: "WezTerm",
  TERM_PROGRAM_VERSION: "20240203-110809-5046fc22",
  WEZTERM_PANE: "1",
  WEZTERM_UNIX_SOCKET: "/run/user/1000/wezterm/gui-sock-8167",
  WEZTERM_EXECUTABLE: "/usr/bin/wezterm-gui",
  WEZTERM_EXECUTABLE_DIR: "/usr/bin",
  TMUX: "/tmp/tmux-1000/default,4242,0",
  TMUX_PANE: "%3",
  KITTY_WINDOW_ID: "7",
  KITTY_LISTEN_ON: "unix:/tmp/kitty-4242",
  WINDOWID: "62914571",
};

// What the AppImage runtime and electron-updater export to an installed
// Codara, plus a runtime knob of the user's own.
const APPIMAGE_LAUNCH = {
  APPIMAGE: "/home/user/Applications/Codara.AppImage",
  APPDIR: "/tmp/.mount_CodaraAb12Cd",
  OWD: "/home/user",
  ARGV0: "Codara.AppImage",
  APPIMAGE_SILENT_INSTALL: "true",
  APPIMAGE_EXIT_AFTER_INSTALL: "true",
};
const USER_APPIMAGE_KNOB = { APPIMAGE_EXTRACT_AND_RUN: "1" };
// What electron-builder's AppRun exports before it starts Codara.
const MOUNT = APPIMAGE_LAUNCH.APPDIR;
const APPRUN_SEARCH_PATHS = {
  LD_LIBRARY_PATH: `${MOUNT}/usr/lib:/opt/user/lib`,
  XDG_DATA_DIRS: `${MOUNT}/usr/share/:/usr/share/gnome:/usr/local/share/:/usr/share/`,
  GSETTINGS_SCHEMA_DIR: `${MOUNT}/usr/share/glib-2.0/schemas`,
};

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
  ...Object.keys(HOST_TERMINAL),
  ...Object.keys(APPIMAGE_LAUNCH),
  ...Object.keys(USER_APPIMAGE_KNOB),
  ...Object.keys(APPRUN_SEARCH_PATHS),
];

const PROBE =
  'print -r -- "@@[${NODE_ENV-unset}][${ELECTRON_RENDERER_URL-unset}]' +
  '[${HOME_ZSHENV:-0}${HOME_ZPROFILE:-0}${HOME_ZSHRC:-0}${HOME_ZLOGIN:-0}]' +
  '[${CUSTOM_ZSHENV:-0}${CUSTOM_ZPROFILE:-0}${CUSTOM_ZSHRC:-0}${CUSTOM_ZLOGIN:-0}]' +
  '[${WEZTERM_PANE-unset}][${TERM_PROGRAM-unset}][${TMUX-unset}]@@"';

function runZsh(call) {
  const result = spawnSync(call.exe, [...call.args, "-i", "-c", PROBE], {
    cwd: call.options.cwd,
    env: call.options.env,
    encoding: "latin1",
    timeout: 20_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const match = /@@\[(.*?)\]\[(.*?)\]\[(\d{4})\]\[(\d{4})\]\[(.*?)\]\[(.*?)\]\[(.*?)\]@@/.exec(output);
  return {
    output,
    nodeEnv: match?.[1],
    rendererUrl: match?.[2],
    homeFiles: match?.[3],
    customFiles: match?.[4],
    hostTerminal: match ? match.slice(5, 8) : undefined,
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
      plugins: [realEnvSanitize(), enrichedPathStub(), stubPlugin()],
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

    // --- the terminal Codara was started from ------------------------------
    for (const integrated of [true, false]) {
      const kind = integrated ? "an integrated" : "a plain";
      const call = await spawnPane(HOST_TERMINAL, { integrated });
      const env = call.options.env;
      const leaked = Object.keys(HOST_TERMINAL).filter((key) => key in env);
      check(
        `${kind} pane carries no pane address or identity of the launching terminal`,
        leaked.length === 0,
        leaked,
      );
      check(`${kind} pane still names its own terminal type`, env.TERM === "xterm-256color", env.TERM);
      if (HAS_ZSH) {
        const zsh = runZsh(call);
        check(
          `zsh in ${kind} pane sees no WEZTERM_PANE, TERM_PROGRAM or TMUX`,
          JSON.stringify(zsh.hostTerminal) === JSON.stringify(["unset", "unset", "unset"]),
          zsh.hostTerminal ?? zsh.output.slice(-400),
        );
      }
    }

    // --- an installed AppImage's own launch --------------------------------
    for (const integrated of [true, false]) {
      const kind = integrated ? "an integrated" : "a plain";
      const call = await spawnPane({ ...APPIMAGE_LAUNCH, ...USER_APPIMAGE_KNOB }, { integrated });
      const env = call.options.env;
      const leaked = Object.keys(APPIMAGE_LAUNCH).filter((key) => key in env);
      check(`${kind} pane does not inherit Codara's AppImage identity`, leaked.length === 0, leaked);
      check(
        `${kind} pane keeps the user's own AppImage runtime knob`,
        env.APPIMAGE_EXTRACT_AND_RUN === "1",
        env.APPIMAGE_EXTRACT_AND_RUN,
      );
      if (HAS_ZSH) {
        const result = spawnSync(
          call.exe,
          [...call.args, "-i", "-c", 'print -r -- "@@[${APPIMAGE-unset}][${APPDIR-unset}][${OWD-unset}][${ARGV0-unset}]@@"'],
          { cwd: call.options.cwd, env: call.options.env, encoding: "latin1", timeout: 20_000 },
        );
        const seen = /@@(.*?)@@/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`)?.[1];
        check(`zsh in ${kind} pane sees no APPIMAGE, APPDIR, OWD or ARGV0`, seen === "[unset][unset][unset][unset]", seen);
      }
    }

    // --- AppRun's search paths into the mount ------------------------------
    try {
      // The enriched PATH keeps the process's own entries, AppRun's among them.
      globalThis.__codaraEnrichedPath = `/usr/local/bin:/usr/bin:${MOUNT}:${MOUNT}/usr/sbin:${MOUNT}Other/bin`;
      const call = await spawnPane({ ...APPIMAGE_LAUNCH, ...APPRUN_SEARCH_PATHS });
      const env = call.options.env;
      check(
        "a pane's PATH loses the mount and keeps every other entry",
        env.PATH === `/usr/local/bin:/usr/bin:${MOUNT}Other/bin`,
        env.PATH,
      );
      check("a pane's LD_LIBRARY_PATH loses the mount's usr/lib", env.LD_LIBRARY_PATH === "/opt/user/lib", env.LD_LIBRARY_PATH);
      check(
        "a pane's XDG_DATA_DIRS keeps the rest exactly as AppRun left it",
        env.XDG_DATA_DIRS === "/usr/share/gnome:/usr/local/share/:/usr/share/",
        env.XDG_DATA_DIRS,
      );
      check(
        "a search path left empty goes",
        !("GSETTINGS_SCHEMA_DIR" in env),
        env.GSETTINGS_SCHEMA_DIR,
      );
      // An unpacked build that inherited a launch had it dropped at boot, so
      // without APPDIR nothing is taken for a mount.
      const unpacked = await spawnPane({ LD_LIBRARY_PATH: `${MOUNT}/usr/lib:/opt/user/lib` });
      check(
        "without APPDIR, LD_LIBRARY_PATH is left alone",
        unpacked.options.env.LD_LIBRARY_PATH === `${MOUNT}/usr/lib:/opt/user/lib`,
        unpacked.options.env.LD_LIBRARY_PATH,
      );
    } finally {
      delete globalThis.__codaraEnrichedPath;
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
