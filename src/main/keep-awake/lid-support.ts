import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

// Where "keep awake with the lid closed" can work without admin rights or a
// change to the system's power settings, which is where the option is shown:
//
//   - macOS: no. A closed lid sleeps the Mac unless pmset (admin) changes;
//     a sleep assertion only covers idle sleep.
//   - Windows: no. The lid action is part of the power plan, and changing it
//     is changing the user's power settings.
//   - Linux: yes on a laptop booted with systemd, through a systemd-inhibit
//     lock (linux-lid-inhibitor.ts). A desktop has no lid to close.

export interface LidSupport {
  supported: boolean;
  /** Absolute path of systemd-inhibit when supported. */
  command: string | null;
  /** Why not, for the log. */
  reason: string;
}

export interface LidSupportProbe {
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  /** Entries of a directory, or [] when it cannot be read. */
  readDir(path: string): string[];
  /** A file's text, or "" when it cannot be read. */
  readFile(path: string): string;
  /** The PATH directories to look for systemd-inhibit in. */
  pathDirs: string[];
}

const FALLBACK_DIRS = ["/usr/bin", "/bin", "/usr/local/bin"];

export function detectLidSupport(probe: LidSupportProbe): LidSupport {
  if (probe.platform !== "linux") {
    return {
      supported: false,
      command: null,
      reason: `a closed lid on ${probe.platform} sleeps unless its power settings change`,
    };
  }
  // logind exists exactly when systemd booted the machine.
  if (!probe.exists("/run/systemd/system")) {
    return { supported: false, command: null, reason: "not booted with systemd" };
  }
  const command =
    [...probe.pathDirs, ...FALLBACK_DIRS]
      .filter((dir) => dir.startsWith("/"))
      .map((dir) => join(dir, "systemd-inhibit"))
      .find((candidate) => probe.exists(candidate)) ?? null;
  if (!command) return { supported: false, command: null, reason: "systemd-inhibit not found" };
  const acpiLid = probe.readDir("/proc/acpi/button/lid").length > 0;
  const inputLid = /^N: Name="[^"\n]*\blid switch\b[^"\n]*"/im.test(probe.readFile("/proc/bus/input/devices"));
  if (!acpiLid && !inputLid) return { supported: false, command: null, reason: "no lid switch" };
  return { supported: true, command, reason: "laptop with systemd-logind" };
}

export function systemLidSupportProbe(): LidSupportProbe {
  return {
    platform: process.platform,
    exists: (path) => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    readDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    },
    pathDirs: (process.env.PATH ?? "").split(delimiter).filter(Boolean),
  };
}
