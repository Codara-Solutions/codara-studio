// "Open this page in Firefox" for the Firefox add-on's install step: Firefox
// does not let web pages or links open about: pages, but its command line
// does. `firefox --new-tab <address>` hands the address to the Firefox the
// user is running (or starts it on it), checked on Linux with Firefox ESR 153
// and 160. On macOS and Windows that path was not checked, so it is not
// offered there and the card keeps Copy. Only the fixed address is passed,
// only when the user clicks, in the user's own Firefox and profile.

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { processEnvWithoutElectronViteDev } from "../env-sanitize";

export const FIREFOX_DEBUGGING_ADDRESS = "about:debugging#/runtime/this-firefox";

/** Firefox's own command names on Linux, in the order they are tried. */
const LINUX_NAMES = ["firefox", "firefox-esr", "firefox-developer-edition", "firefox-nightly"];
/**
 * Set by Electron itself at start, whatever the user had (checked on
 * Electron 43: GDK_BACKEND becomes its own backend, NO_AT_BRIDGE=1 turns off
 * the accessibility bridge, CHROME_DESKTOP names Codara's desktop file). The
 * user's values cannot be read back, so Firefox gets none and picks its own.
 */
const ELECTRON_SET = ["GDK_BACKEND", "NO_AT_BRIDGE", "CHROME_DESKTOP"];

/**
 * The environment the user's own programs get from Codara: without
 * electron-vite's and npm's dev wiring or Codara's AppImage mount
 * (env-sanitize.ts), Electron's own variables, or what Electron changed.
 */
export function userProgramEnv(): NodeJS.ProcessEnv {
  const env = processEnvWithoutElectronViteDev();
  for (const key of Object.keys(env)) if (key.startsWith("ELECTRON_")) delete env[key];
  for (const key of ELECTRON_SET) delete env[key];
  // Older Electrons replaced the desktop's name and kept it aside.
  if (env.ORIGINAL_XDG_CURRENT_DESKTOP !== undefined) env.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP;
  delete env.ORIGINAL_XDG_CURRENT_DESKTOP;
  return env;
}

interface Host {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  isExecutable?: (file: string) => boolean;
}

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The user's Mozilla Firefox, found the way their shell would; null where opening it is not offered. */
export function findUserFirefox({ platform = process.platform, env = userProgramEnv(), home = homedir(), isExecutable = executable }: Host = {}): string | null {
  if (platform !== "linux") return null;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of LINUX_NAMES) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  for (const candidate of [join(home, ".local/share/flatpak/exports/bin/org.mozilla.firefox"), "/var/lib/flatpak/exports/bin/org.mozilla.firefox"]) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

interface Child {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}
type Spawn = (command: string, args: string[], options: SpawnOptions) => Child;

/**
 * Opens about:debugging's This Firefox page in the user's Firefox. True once
 * Firefox started; false when there is none here, it failed to start, or it
 * did not start within startTimeoutMs, so the caller offers Copy instead.
 */
export function openFirefoxDebugging(host: Omit<Host, "env"> & { spawn?: Spawn; startTimeoutMs?: number } = {}): Promise<boolean> {
  const env = userProgramEnv();
  const home = host.home ?? homedir();
  const binary = findUserFirefox({ ...host, env, home });
  if (!binary) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(opened);
    };
    const timer = setTimeout(() => settle(false), host.startTimeoutMs ?? 2_000);
    let child: Child;
    try {
      // From the user's home, so no folder of Codara's (an AppImage mount) stays busy.
      child = (host.spawn ?? (nodeSpawn as unknown as Spawn))(binary, ["--new-tab", FIREFOX_DEBUGGING_ADDRESS], { detached: true, stdio: "ignore", cwd: home, env });
    } catch {
      settle(false);
      return;
    }
    child.on("error", () => settle(false));
    child.once("spawn", () => settle(true));
    child.unref();
  });
}
