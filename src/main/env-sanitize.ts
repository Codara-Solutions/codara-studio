// Nested-agent-CLI env sanitization.
//
// When Codara itself is launched from inside a Claude Code session (the
// standard way the dev instance gets started — `npm run dev` typed into a CC
// terminal), the Electron process inherits CC's nesting markers:
// CLAUDECODE=1, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID, and friends.
// Every pty Codara spawns then re-inherits them, so any `claude` CLI Codara
// runs (chat backends, worker panes, standing terminals, or the user typing
// `claude` into a regular pane) believes it is a NESTED Claude Code child.
//
// Proven consequence on CC 2.1.201: a nested CC writes NO session JSONL
// transcript at all — which kills Codara's JSONL heartbeat, message tailing,
// and MCP-call tracking, so every chat turn times out at the 90s cap.
//
// The fix is central: pty-manager strips these keys from the inherited base
// env for EVERY pty it spawns, BEFORE layering the caller's explicit env
// overrides. Codara's own deliberate vars (CLAUDE_CODE_DISABLE_NONESSENTIAL_
// TRAFFIC, CLAUDE_CODE_HIDE_CWD, CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY — set
// via CliSessionOptions.env / SpawnOptions.env) are applied AFTER this strip,
// so they always survive.

import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

// Exact-name nesting markers that don't share the CLAUDE_CODE_ prefix.
const NESTED_AGENT_ENV_EXACT = new Set([
  "CLAUDECODE",
  "CLAUDE_EFFORT",
  "CLAUDE_PLUGIN_DATA",
]);

/** True when `key` is a Claude Code session-nesting marker that must not
 *  leak into a spawned pty's environment. Everything under the CLAUDE_CODE_
 *  prefix counts (ENTRYPOINT, SESSION_ID, CHILD_SESSION, EXECPATH, SSE_PORT,
 *  EXPERIMENTAL_AGENT_TEAMS, …) plus the exact names above. */
export function isNestedAgentEnvKey(key: string): boolean {
  return key.startsWith("CLAUDE_CODE_") || NESTED_AGENT_ENV_EXACT.has(key);
}

/**
 * Delete every Claude Code nesting marker from `env`, in place. Call on an
 * env derived from process.env BEFORE applying any deliberate per-spawn
 * overrides, so an app-set CLAUDE_CODE_* key is preserved while inherited
 * leakage is dropped.
 */
export function sanitizeNestedAgentEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (isNestedAgentEnvKey(key)) delete env[key];
  }
}

// electron-vite dev wiring.
//
// `npm run dev` exports these into the Electron process so the app finds the
// renderer dev server and electron-vite can relaunch Electron. No other tool
// defines them, and each one reconfigures the next electron-vite or Electron
// dev run started from a pane: ELECTRON_RENDERER_URL makes any `electron .`
// (every Playwright spec) load the LIVE dev server instead of its own
// out/renderer, and ELECTRON_EXEC_PATH / ELECTRON_MAJOR_VER / ELECTRON_ENTRY /
// ELECTRON_CLI_ARGS make another project's `electron-vite dev` launch this
// app's Electron binary and entry.
const ELECTRON_VITE_DEV_ENV = [
  "ELECTRON_RENDERER_URL",
  "ELECTRON_CLI_ARGS",
  "ELECTRON_ENTRY",
  "ELECTRON_EXEC_PATH",
  "ELECTRON_MAJOR_VER",
];
const ELECTRON_VITE_MODE_MARKER = "NODE_ENV_ELECTRON_VITE";

/**
 * Delete electron-vite's dev wiring from `env`, in place. NODE_ENV is a
 * user-facing variable, so it goes only while it still equals electron-vite's
 * mode marker (electron-vite overwrites NODE_ENV with that mode on every
 * dev/build/preview run); a NODE_ENV the user set survives.
 */
export function sanitizeElectronViteDevEnv(env: Record<string, string | undefined>): void {
  for (const key of ELECTRON_VITE_DEV_ENV) delete env[key];
  const mode = env[ELECTRON_VITE_MODE_MARKER];
  if (mode !== undefined && env.NODE_ENV === mode) delete env.NODE_ENV;
  delete env[ELECTRON_VITE_MODE_MARKER];
}

// Host terminal identity.
//
// Codara started from another terminal (`npm run dev` typed into WezTerm, a
// launcher run inside kitty or tmux) inherits that terminal's name and the
// address of the pane it ran in. A Codara pane is not that pane. Tools that
// act on "the current pane" through these variables reach the launcher's
// window instead: `wezterm cli split-pane` (what a /sessions picker uses to
// open over the current pane) splits the WezTerm pane running `npm run dev`,
// so nothing appears in Codara. Claude Code also reads TERM_PROGRAM and
// WEZTERM_PANE to pick its keyboard protocol and clipboard path, and would
// configure itself for WezTerm inside xterm.js.
const HOST_TERMINAL_ENV = [
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "WINDOWID",
  "WEZTERM_PANE",
  "WEZTERM_UNIX_SOCKET",
  "WEZTERM_EXECUTABLE",
  "WEZTERM_EXECUTABLE_DIR",
  "KITTY_WINDOW_ID",
  "KITTY_PID",
  "KITTY_LISTEN_ON",
  "KITTY_PUBLIC_KEY",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  "ITERM_SESSION_ID",
  "ITERM_PROFILE",
  "WT_SESSION",
  "WT_PROFILE_ID",
  "ALACRITTY_WINDOW_ID",
  "ALACRITTY_SOCKET",
  "GHOSTTY_RESOURCES_DIR",
  "GHOSTTY_BIN_DIR",
  "GHOSTTY_SHELL_FEATURES",
  "VTE_VERSION",
  "GNOME_TERMINAL_SCREEN",
  "GNOME_TERMINAL_SERVICE",
  "TILIX_ID",
  "KONSOLE_VERSION",
  "KONSOLE_DBUS_SERVICE",
  "KONSOLE_DBUS_SESSION",
  "KONSOLE_DBUS_WINDOW",
  "TERMINATOR_UUID",
  "TERMINATOR_DBUS_NAME",
  "TERMINATOR_DBUS_PATH",
];

/** Delete the launching terminal's identity and pane address from `env`, in place. */
export function sanitizeHostTerminalEnv(env: Record<string, string | undefined>): void {
  for (const key of HOST_TERMINAL_ENV) delete env[key];
}

// AppImage identity.
//
// The AppImage runtime exports APPIMAGE (the .AppImage file), APPDIR (its
// mount), OWD and ARGV0 to the app it starts, and electron-updater adds
// APPIMAGE_SILENT_INSTALL or APPIMAGE_EXIT_AFTER_INSTALL to the Codara it
// relaunches after an update. All of them describe Codara's own launch. In a
// pane they make an unpacked or dev build started there take itself for the
// installed AppImage (its updater would replace that file, and its config
// gates would treat it as installed), and electron-builder's AppRun, run from
// an extracted AppDir, would start Codara's binary from the inherited APPDIR.
// The user's own APPIMAGE_* runtime knobs (APPIMAGE_EXTRACT_AND_RUN) stay.
const APPIMAGE_LAUNCH_ENV = [
  "APPIMAGE",
  "APPDIR",
  "OWD",
  "ARGV0",
  "APPIMAGE_SILENT_INSTALL",
  "APPIMAGE_EXIT_AFTER_INSTALL",
];

/** Delete the AppImage runtime's description of Codara's own launch from `env`, in place. */
export function sanitizeAppImageLaunchEnv(env: Record<string, string | undefined>): void {
  for (const key of APPIMAGE_LAUNCH_ENV) delete env[key];
}

// electron-builder's AppRun puts the mount in front of these lists before it
// starts Codara: the mount itself and usr/sbin on PATH, usr/lib (its bundled
// libnotify, libXss, libgconf and friends) on LD_LIBRARY_PATH, usr/share on
// XDG_DATA_DIRS and the glib schemas. A pane's programs then load Codara's old
// copies ahead of the system's. Codara's own children that run its binary as
// Node (the codara-studio server, Pi) link none of those libraries.
const APPRUN_SEARCH_PATH_ENV = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];

function isInsideDir(entry: string, dir: string): boolean {
  if (!isAbsolute(entry)) return false;
  const target = resolve(entry);
  return target === dir || target.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/**
 * Remove the entries inside `appDir` from the search paths AppRun extended,
 * in place, leaving every other entry as it was. A list left empty goes.
 */
export function stripAppImageSearchPaths(env: Record<string, string | undefined>, appDir: string | undefined): void {
  // AppRun writes the entries from $APPDIR as it is, so no realpath.
  if (!appDir || !isAbsolute(appDir)) return;
  const dir = resolve(appDir);
  for (const key of APPRUN_SEARCH_PATH_ENV) {
    const value = env[key];
    if (value === undefined) continue;
    const entries = value.split(delimiter);
    const kept = entries.filter((entry) => !isInsideDir(entry, dir));
    if (kept.length === entries.length) continue;
    if (kept.length === 0) delete env[key];
    else env[key] = kept.join(delimiter);
  }
}

/**
 * Remove Codara's AppImage launch from a child's `env`, in place: AppRun's
 * search path entries, then the launch variables. Once boot has dropped an
 * inherited launch (appimage-launch.ts), an APPDIR still in process.env is
 * the mount this Codara runs from.
 */
export function sanitizeAppImageChildEnv(env: Record<string, string | undefined>): void {
  stripAppImageSearchPaths(env, env.APPDIR);
  sanitizeAppImageLaunchEnv(env);
}

/**
 * A copy of process.env without electron-vite's dev wiring, for a child that
 * runs the user's own commands outside pty-manager (automation steps and
 * checks). Those must behave as they would from a plain terminal.
 */
export function processEnvWithoutElectronViteDev(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  sanitizeElectronViteDevEnv(env);
  sanitizeNpmRunScriptEnv(env);
  sanitizeAppImageChildEnv(env);
  return env;
}

// npm run-script wiring.
//
// `npm run dev` starts the app through npm's run-script, which prepends
// node_modules/.bin for the package directory and each of its ancestors,
// plus npm's node-gyp shim, to PATH, and exports npm_* variables and
// INIT_CWD. Inherited by a pane, that PATH runs this repository's own `pi`,
// `tsc` or `electron-vite` ahead of the user's installs (so `pi update`
// tries to update the copy in node_modules), and Codara takes the
// repository's Pi for the user's. Only a process npm started carries
// npm_lifecycle_event, so an app started any other way is unchanged.
const NPM_NODE_GYP_BIN = /[\\/]@npmcli[\\/]run-script[\\/]lib[\\/]node-gyp-bin$/;

/** `path` without the entries npm's run-script prepended for `env`'s run. */
export function withoutNpmRunScriptPath(
  path: string,
  env: Record<string, string | undefined>,
): string {
  if (env.npm_lifecycle_event === undefined) return path;
  const injected = new Set<string>();
  if (env.npm_package_json) {
    let dir = dirname(resolve(env.npm_package_json));
    for (;;) {
      injected.add(join(dir, "node_modules", ".bin"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path
    .split(delimiter)
    .filter((entry) => !injected.has(entry) && !NPM_NODE_GYP_BIN.test(entry))
    .join(delimiter);
}

/** Delete npm's run-script wiring from `env`, in place. */
export function sanitizeNpmRunScriptEnv(env: Record<string, string | undefined>): void {
  if (env.npm_lifecycle_event === undefined) return;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path" && env[key] !== undefined) {
      env[key] = withoutNpmRunScriptPath(env[key]!, env);
    }
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_")) delete env[key];
  }
  delete env.INIT_CWD;
}

// Codara's zsh integration dir. Must match the cache layout shell-init.ts
// materializes (<home>/.cache/spark/shell-integration/zsh). Matched by suffix
// rather than against this process's home: an instance started with another
// HOME (every e2e spec) still inherits the outer instance's dir.
const ZSH_INTEGRATION_DIR_SUFFIX = "/.cache/spark/shell-integration/zsh";

function isCodaraZshIntegrationDir(dir: string): boolean {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").endsWith(ZSH_INTEGRATION_DIR_SUFFIX);
}

/**
 * The user's own ZDOTDIR behind `env`, or undefined when zsh should read the
 * startup files in $HOME. Inside a Codara pane ZDOTDIR is the integration dir
 * and the user's original, if they had one, is in SPARK_USER_ZDOTDIR. Taking
 * the integration dir itself for the user's makes each integration file
 * source itself until zsh aborts with "job table full or recursion limit
 * exceeded".
 */
export function userZdotdirFromEnv(env: Record<string, string | undefined>): string | undefined {
  const zdotdir = env.ZDOTDIR;
  if (!zdotdir) return undefined;
  if (!isCodaraZshIntegrationDir(zdotdir)) return zdotdir;
  const recorded = env.SPARK_USER_ZDOTDIR;
  return recorded && !isCodaraZshIntegrationDir(recorded) ? recorded : undefined;
}

/**
 * Give an env inherited from a Codara pane the user's own ZDOTDIR back, in
 * place. SPARK_USER_ZDOTDIR always goes: it only means something next to an
 * integration ZDOTDIR, and shell-init sets both afresh for an integrated
 * shell.
 */
export function restoreUserZdotdir(env: Record<string, string | undefined>): void {
  if (env.ZDOTDIR !== undefined && isCodaraZshIntegrationDir(env.ZDOTDIR)) {
    const user = userZdotdirFromEnv(env);
    if (user === undefined) delete env.ZDOTDIR;
    else env.ZDOTDIR = user;
  }
  delete env.SPARK_USER_ZDOTDIR;
}
