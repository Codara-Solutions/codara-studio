import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// On Wayland only the compositor can bring a window forward. A notification
// click carries the notification server's activation token, and Electron
// hands it to the compositor on focus(), but COSMIC's activation_policy can
// still refuse: with FocusIfActiveWorkspace (or Urgent) a window on another
// desktop is only marked urgent, so the click opens the right tab in a window
// nobody can see. cosmic-activate asks through COSMIC's toplevel-management
// protocol, the one its dock uses, which that policy does not govern. It is
// optional: without it the click still opens the tab and the desktop is
// marked urgent.

export const COMPOSITOR_RAISE_HELPER = "cosmic-activate";

// Long enough for the compositor to answer the token and Chromium to see the
// window become active, short enough to feel part of the click.
export const COMPOSITOR_RAISE_DELAY_MS = 400;

const HELPER_TIMEOUT_MS = 2_000;

export interface RaiseTarget {
  isDestroyed(): boolean;
  isFocused(): boolean;
}

export interface CompositorRaiseDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  isExecutable?: (file: string) => boolean;
  run?: (file: string, args: string[], done: (outcome: string) => void) => void;
  schedule?: (fn: () => void, ms: number) => void;
  log?: (message: string) => void;
}

export function isCosmicWayland(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== "linux") return false;
  if (env.XDG_SESSION_TYPE !== "wayland" && !env.WAYLAND_DISPLAY) return false;
  return (env.XDG_CURRENT_DESKTOP ?? "")
    .split(":")
    .some((name) => name.trim().toUpperCase() === "COSMIC");
}

// Desktop launchers often start apps without ~/.local/bin on PATH, which is
// where a hand-installed helper usually lives.
export function findRaiseHelper(
  env: NodeJS.ProcessEnv,
  home: string,
  isExecutable: (file: string) => boolean = isExecutableFile,
): string | null {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (home) dirs.push(join(home, ".local", "bin"));
  for (const dir of dirs) {
    const candidate = join(dir, COMPOSITOR_RAISE_HELPER);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// The Wayland app id Electron gives the window: CHROME_DESKTOP minus its
// ".desktop", the same name the notification carries as desktop-entry.
export function studioAppId(env: NodeJS.ProcessEnv): string {
  const desktop = (env.CHROME_DESKTOP ?? "").trim().replace(/\.desktop$/, "");
  return desktop || "codara-studio";
}

// Called right after focus() for a notification click: if the window is still
// not focused once the compositor had time to answer, ask it through the
// helper. Does nothing off COSMIC Wayland or without the helper.
export function raiseIfStillBehind(win: RaiseTarget, deps: CompositorRaiseDeps = {}): void {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  if (!isCosmicWayland(env, platform)) return;
  const helper = findRaiseHelper(env, deps.home ?? homedir(), deps.isExecutable);
  const log = deps.log ?? (() => undefined);
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const run = deps.run ?? runHelper;
  schedule(() => {
    if (win.isDestroyed() || win.isFocused()) return;
    if (!helper) {
      log(`window still behind after a notification click; no ${COMPOSITOR_RAISE_HELPER} to raise it`);
      return;
    }
    const appId = studioAppId(env);
    run(helper, [appId], (outcome) => {
      log(`window still behind after a notification click; ${COMPOSITOR_RAISE_HELPER} ${appId}: ${outcome}`);
    });
  }, COMPOSITOR_RAISE_DELAY_MS);
}

function runHelper(file: string, args: string[], done: (outcome: string) => void): void {
  let settled = false;
  const finish = (outcome: string): void => {
    if (settled) return;
    settled = true;
    done(outcome);
  };
  try {
    const child = spawn(file, args, { stdio: "ignore", timeout: HELPER_TIMEOUT_MS });
    child.once("error", (err) => finish(`failed (${err.message})`));
    child.once("exit", (code, signal) => finish(signal ? `killed (${signal})` : `exit ${code}`));
  } catch (err) {
    finish(`failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
