// Whether this process is the AppImage its environment names.
//
// The AppImage runtime exports APPIMAGE and APPDIR to the app it starts, and
// every child of that app inherits them: a Codara pane, a terminal emulator
// that is itself an AppImage, and any build started from either. An unpacked
// build from `npm run package:linux` reports app.isPackaged too, so the
// variables alone would let it treat the user's installed AppImage as its
// own. They describe this process only when its executable sits inside
// APPDIR, and APPDIR is the runtime's own directory straight in a temporary
// folder: any other folder that merely contains the executable is a
// transient build, not a mount.

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { sanitizeAppImageLaunchEnv } from "./env-sanitize";
import { temporaryRoots } from "./temporary-roots";

export interface AppImageLaunchProbe {
  /** APPIMAGE: the .AppImage file the runtime was started from. */
  appImage?: string;
  /** APPDIR: where the runtime mounted or extracted it. */
  appDir?: string;
  /** This process's executable. */
  execPath: string;
}

// The type 2 runtime mounts at $TMPDIR/.mount_<name><random>; with
// APPIMAGE_EXTRACT_AND_RUN it extracts to $TMPDIR/appimage_extracted_<hash>.
const APPIMAGE_RUNTIME_DIR = /^(\.mount_|appimage_extracted_)./;

function realpathOrResolved(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

// Synchronous so the boot check can run before any other module reads the
// variables.
export function runsFromAppImage(probe: AppImageLaunchProbe): boolean {
  const appImage = probe.appImage?.trim();
  const appDir = probe.appDir?.trim();
  if (!appImage || !appDir || !isAbsolute(appImage) || !isAbsolute(appDir)) return false;
  let realAppDir: string;
  let realExec: string;
  try {
    if (!statSync(appImage).isFile()) return false;
    realAppDir = realpathSync(appDir);
    realExec = realpathSync(probe.execPath);
  } catch {
    return false;
  }
  const fromAppDir = relative(realAppDir, realExec);
  if (fromAppDir === "" || fromAppDir.startsWith("..") || isAbsolute(fromAppDir)) return false;
  if (!APPIMAGE_RUNTIME_DIR.test(basename(realAppDir))) return false;
  const parent = dirname(realAppDir);
  return temporaryRoots().some((root) => realpathOrResolved(root) === parent);
}

/**
 * Drop an inherited AppImage launch from `env`, in place, unless this process
 * is that AppImage. electron-updater picks the file it deletes and replaces
 * on install from APPIMAGE alone.
 */
export function clearInheritedAppImageLaunch(env: NodeJS.ProcessEnv, execPath: string): void {
  if (runsFromAppImage({ appImage: env.APPIMAGE, appDir: env.APPDIR, execPath })) return;
  sanitizeAppImageLaunchEnv(env);
}
