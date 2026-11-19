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

export const FIREFOX_DEBUGGING_ADDRESS = "about:debugging#/runtime/this-firefox";

/** Firefox's own command names on Linux, in the order they are tried. */
const LINUX_NAMES = ["firefox", "firefox-esr", "firefox-developer-edition", "firefox-nightly"];
/** Variables an AppImage sets for its own libraries, which would break another program. */
const APPIMAGE_ONLY = ["APPIMAGE", "APPDIR", "ARGV0", "OWD", "LD_LIBRARY_PATH", "LD_PRELOAD", "GTK_PATH", "GIO_MODULE_DIR", "GDK_PIXBUF_MODULE_FILE", "GSETTINGS_SCHEMA_DIR", "PYTHONHOME", "PYTHONPATH"];

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

/** The user's Firefox, found the way their shell would; null where opening it is not offered. */
export function findUserFirefox({ platform = process.platform, env = process.env, home = homedir(), isExecutable = executable }: Host = {}): string | null {
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

/** The user's environment without Codara's own: Electron's variables, and an AppImage's libraries. */
function userEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const appImage = Boolean(env.APPIMAGE || env.APPDIR);
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("ELECTRON_")) continue;
    if (appImage && APPIMAGE_ONLY.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

type Spawn = (command: string, args: string[], options: SpawnOptions) => { on(event: "error", listener: () => void): unknown; unref(): void };

/** Opens about:debugging's This Firefox page in the user's Firefox; false when that is not possible here. */
export function openFirefoxDebugging(host: Host & { spawn?: Spawn } = {}): boolean {
  const env = host.env ?? process.env;
  const binary = findUserFirefox({ ...host, env });
  if (!binary) return false;
  const child = (host.spawn ?? (nodeSpawn as unknown as Spawn))(binary, ["--new-tab", FIREFOX_DEBUGGING_ADDRESS], { detached: true, stdio: "ignore", env: userEnv(env) });
  child.on("error", () => undefined);
  child.unref();
  return true;
}
