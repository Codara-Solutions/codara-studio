// Linux AppImage only. Crashpad's handler is a separate process launched from
// the folder the AppImage runtime mounted (chrome_crashpad_handler beside the
// executable). It outlives the app by a moment, and when the runtime unmounts
// that folder at exit the handler faults on its next page in (SIGBUS), which
// the desktop then reports as a crash of Codara. Stopping this launch's
// handler in the final exit phase avoids that. A main-process crash skips
// the exit hook, but by then the handler has written the dump that matters.
//
// The extract-and-run mode (APPIMAGE_EXTRACT_AND_RUN) has no mount to lose,
// so it is left alone.

import { readdirSync, readlinkSync, statSync } from "node:fs";
import { posix } from "node:path";
import { runsFromAppImage } from "../appimage-launch";

export interface CrashpadHandlerProbe {
  execPath: string;
  listPids(): number[];
  readExecutable(pid: number): string | null;
}

/** The pids of the Crashpad handler started from this launch's own folder. */
export function crashpadHandlersOfLaunch(probe: CrashpadHandlerProbe): number[] {
  const handler = posix.join(posix.dirname(probe.execPath), "chrome_crashpad_handler");
  return probe.listPids().filter((pid) => probe.readExecutable(pid) === handler);
}

function procPids(): number[] {
  try {
    return readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number);
  } catch {
    return [];
  }
}

function procExecutable(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

/** True when `dir` is a mount point: its device differs from its parent's. */
export function isMountRoot(dir: string, stat: (path: string) => { dev: number } = statSync): boolean {
  try {
    return stat(dir).dev !== stat(posix.dirname(dir)).dev;
  } catch {
    return false;
  }
}

let installed = false;

export function stopCrashpadHandlerOnAppImageExit(env: NodeJS.ProcessEnv = process.env): boolean {
  if (installed || process.platform !== "linux") return installed;
  const execPath = process.execPath;
  if (!runsFromAppImage({ appImage: env.APPIMAGE, appDir: env.APPDIR, execPath })) return false;
  if (!isMountRoot(posix.dirname(execPath))) return false;
  installed = true;
  // `exit`, not will-quit: Electron can still be tearing down after will-quit,
  // and the handler must outlive every child it may need to record.
  process.once("exit", () => {
    for (const pid of crashpadHandlersOfLaunch({ execPath, listPids: procPids, readExecutable: procExecutable })) {
      try {
        // SIGKILL: SIGTERM runs the handler's own code, which pages in from
        // the mount that is about to go away.
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  return true;
}
