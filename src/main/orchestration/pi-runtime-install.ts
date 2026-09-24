// Installing Pi the way the user would.
//
// Cora's sessions run the `pi` the user installed, the same one their
// terminals run, so updating it is the user's call. When it is missing,
// Settings offers to install it with the standard global npm install:
//
//   npm install -g @earendil-works/pi-coding-agent
//
// The result is re-resolved through the same lookup Cora's launcher uses
// before the install is reported as done, so "installed" means "Cora will
// find this build".
//
// npm itself is the one external requirement. A desktop app launched from
// Finder/Dock inherits a sparse PATH, so the spawn uses the reconstructed
// login-shell PATH; when npm cannot run, or cannot write to its global
// folder, the error names the exact command to run by hand.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { forgetResolvedBinary } from "../binary-resolver";
import { codaraHome } from "../codara-home";
import { getEnrichedEnv } from "../path-reconstruction";
import { CODARA_PI_PACKAGE, PI_INSTALL_COMMAND } from "./pi-runtime";

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
/** npm chatter is unbounded; only the tail is worth surfacing in a dialog. */
const MAX_RETAINED_OUTPUT = 8_000;

export interface PiRuntimeInstallProgress {
  message: string;
}

/**
 * Where earlier Codara builds installed their own copy of Pi. Nothing reads
 * it any more; it is removed once the user's own install is in place.
 */
export function retiredPiRuntimeRoot(): string {
  return join(codaraHome(), "pi-runtime");
}

/**
 * The (command, argv) pair that runs npm with `args`. On Windows the npm shim
 * is npm.cmd, and spawning a .cmd directly with shell:false throws EINVAL on
 * every Node carrying the CVE-2024-27980 fix, so, as binary-resolver.ts does,
 * npm is invoked through `cmd.exe /c npm ...`. Still shell:false: cmd.exe is
 * the program being spawned, not a shell interpreting a concatenated string.
 */
function npmCommand(args: string[]): { command: string; argv: string[] } {
  return process.platform === "win32"
    ? { command: "cmd.exe", argv: ["/c", "npm", ...args] }
    : { command: "npm", argv: args };
}

type InstallChild = ChildProcessByStdio<null, Readable, Readable>;

function streamLines(
  child: InstallChild,
  onLine: (line: string) => void,
): () => string {
  let tail = "";
  const attach = (stream: NodeJS.ReadableStream): void => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-MAX_RETAINED_OUTPUT);
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    });
  };
  attach(child.stdout);
  attach(child.stderr);
  return () => tail.trim();
}

let inflight: Promise<string> | null = null;

/**
 * Install Pi globally and return the version Cora will run. Concurrent
 * callers share one install; `onProgress` receives npm's output line by
 * line so Settings can show that something is happening.
 */
export function installPiCli(
  onProgress: (progress: PiRuntimeInstallProgress) => void,
): Promise<string> {
  if (inflight) return inflight;
  const work = runInstall(onProgress);
  inflight = work;
  void work.finally(() => {
    if (inflight === work) inflight = null;
  });
  return work;
}

/** True while an install is running; Settings disables its button on this. */
export function isPiCliInstalling(): boolean {
  return inflight !== null;
}

async function runInstall(
  onProgress: (progress: PiRuntimeInstallProgress) => void,
): Promise<string> {
  onProgress({ message: `Running ${PI_INSTALL_COMMAND}` });
  const env = await getEnrichedEnv();
  const args = [
    "install",
    "--global",
    CODARA_PI_PACKAGE,
    "--no-audit",
    "--no-fund",
    "--loglevel=http",
  ];

  await new Promise<void>((resolveExit, rejectExit) => {
    let child: InstallChild;
    try {
      const { command, argv } = npmCommand(args);
      child = spawn(command, argv, {
        env,
        // shell:false: every argument is a constant, and a shell would only
        // add quoting failure modes.
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectExit(error);
      return;
    }
    const readTail = streamLines(child, (line) => onProgress({ message: line }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("Installing Pi timed out after 15 minutes"));
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT: npm (or cmd.exe) is not on the reconstructed PATH. EINVAL:
      // the spawn shape itself was rejected. Either way the fix is the same
      // hand-run command.
      if (error.code === "ENOENT" || error.code === "EINVAL") {
        rejectExit(
          new Error(
            "npm could not be launched. Install Node.js 22.19 or newer (which includes npm), reopen Codara, and try again, " +
              `or run this yourself: ${PI_INSTALL_COMMAND}`,
          ),
        );
        return;
      }
      rejectExit(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) {
        resolveExit();
        return;
      }
      const tail = readTail();
      const permission = /EACCES|EPERM|permission denied/i.test(tail)
        ? ` npm could not write to its global folder; run this in a terminal instead: ${PI_INSTALL_COMMAND}`
        : "";
      rejectExit(
        new Error(
          `npm exited with code ${exitCode ?? "unknown"} while installing Pi.${permission}` +
            (tail ? `\n${tail.slice(-1_500)}` : ""),
        ),
      );
    });
  });

  onProgress({ message: "Looking for the installed pi..." });
  forgetResolvedBinary("pi");
  // Never trust npm's exit code alone: re-resolve through the lookup the
  // launcher uses, so "installed" means "Cora will find this build".
  const { forgetNpmGlobalRoot, resolveUserPiRuntime } = await import("./pi-runtime-electron");
  forgetNpmGlobalRoot();
  const located = await resolveUserPiRuntime();
  await rm(retiredPiRuntimeRoot(), { recursive: true, force: true }).catch(() => undefined);
  onProgress({ message: `Pi ${located.version} is installed.` });
  return located.version;
}
