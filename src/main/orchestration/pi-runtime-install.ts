// Managed install of Codara's pinned Pi runtime.
//
// Cora's whole backend — chat, planning, and every worker — launches the exact
// Pi build Codara was tested against. Normally that build ships inside the
// app (dev: the repo's node_modules; packaged: app.asar). When it is missing,
// Settings previously offered nothing but the error text "Codara's pinned Pi
// runtime <version> is not installed", which is a dead end for anyone who is
// not going to open a terminal in the repo.
//
// This module installs that exact version into a user-writable directory —
// $CODARA_HOME/pi-runtime/node_modules — which resolveCodaraPiRuntime()
// searches after the app-bundled roots. Two properties matter:
//
//   * Version-exact. npm is asked for `<pkg>@<CODARA_PI_VERSION>`, and the
//     result is re-resolved through resolvePinnedPiRuntime() before the
//     install is reported as successful, so a partial or wrong-version tree
//     never registers as installed.
//   * Self-contained. A private package.json in the install root stops npm
//     from walking up and writing into the user's home directory or whatever
//     project happens to sit above $CODARA_HOME.
//
// npm itself is the one external requirement. A desktop app launched from
// Finder/Dock inherits a sparse PATH, so the spawn uses the reconstructed
// login-shell PATH; when npm still cannot be found the error names the exact
// command the user can run by hand.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getEnrichedEnv } from "../path-reconstruction";
import { codaraHome } from "../codara-home";
import { CODARA_PI_PACKAGE, CODARA_PI_VERSION, resolvePinnedPiRuntime } from "./pi-runtime";

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
/** npm chatter is unbounded; only the tail is worth surfacing in a dialog. */
const MAX_RETAINED_OUTPUT = 8_000;

export interface PiRuntimeInstallProgress {
  message: string;
}

/** $CODARA_HOME/pi-runtime — the writable root this module owns end to end. */
export function managedPiRuntimeRoot(): string {
  return join(codaraHome(), "pi-runtime");
}

/** The node_modules dir resolveCodaraPiRuntime() searches for a managed build. */
export function managedPiRuntimeNodeModules(): string {
  return join(managedPiRuntimeRoot(), "node_modules");
}

/** The exact command a user can run themselves if the in-app install fails. */
export function managedPiRuntimeInstallCommand(): string {
  return `npm install --prefix "${managedPiRuntimeRoot()}" ${CODARA_PI_PACKAGE}@${CODARA_PI_VERSION}`;
}

/**
 * The (command, argv) pair that runs npm with `args`. On Windows the npm shim
 * is npm.cmd, and spawning a .cmd directly with shell:false throws EINVAL on
 * every Node carrying the CVE-2024-27980 fix — so, as binary-resolver.ts does,
 * npm is invoked through `cmd.exe /c npm …`. Still shell:false: cmd.exe is the
 * program being spawned, not a shell interpreting a concatenated string.
 */
function npmCommand(args: string[]): { command: string; argv: string[] } {
  return process.platform === "win32"
    ? { command: "cmd.exe", argv: ["/c", "npm", ...args] }
    : { command: "npm", argv: args };
}

async function prepareInstallRoot(): Promise<string> {
  const root = managedPiRuntimeRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  // `private: true` plus a real name/version keeps npm from treating the
  // directory as part of an enclosing workspace and from publishing warnings
  // about a missing manifest on every install.
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "codara-pi-runtime",
        version: "1.0.0",
        private: true,
        description: "Codara's managed install of the pinned Pi coding agent runtime.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
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
 * Install the pinned Pi runtime into the managed root and return its resolved
 * version. Concurrent callers share one install; `onProgress` receives npm's
 * output line by line so Settings can show that something is happening during
 * a download that routinely takes tens of seconds.
 */
export function installPinnedPiRuntime(
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

/** True while an install is running — Settings disables its button on this. */
export function isPinnedPiRuntimeInstalling(): boolean {
  return inflight !== null;
}

async function runInstall(
  onProgress: (progress: PiRuntimeInstallProgress) => void,
): Promise<string> {
  const root = await prepareInstallRoot();
  onProgress({ message: `Installing ${CODARA_PI_PACKAGE}@${CODARA_PI_VERSION}…` });

  const env = await getEnrichedEnv();
  // The pinned runtime is a plain dependency install; npm's audit and funding
  // passes only add network round trips and noise to the progress stream.
  const args = [
    "install",
    "--prefix",
    root,
    `${CODARA_PI_PACKAGE}@${CODARA_PI_VERSION}`,
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--loglevel=http",
  ];

  const code = await new Promise<number>((resolveExit, rejectExit) => {
    let child: InstallChild;
    try {
      const { command, argv } = npmCommand(args);
      child = spawn(command, argv, {
        cwd: root,
        env,
        // shell:false — every argument is a constant or an absolute path we
        // built, and a shell would only add quoting failure modes.
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
      // the spawn shape itself was rejected (the classic case being a .cmd
      // shim without cmd.exe on patched Node). Either way the actionable fix
      // is the same hand-run command, so both get the helpful message.
      if (error.code === "ENOENT" || error.code === "EINVAL") {
        rejectExit(
          new Error(
            "npm could not be launched. Install Node.js 22.19+ (which includes npm), reopen Codara, and try again — " +
              `or run this yourself: ${managedPiRuntimeInstallCommand()}`,
          ),
        );
        return;
      }
      rejectExit(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) {
        resolveExit(0);
        return;
      }
      const tail = readTail();
      rejectExit(
        new Error(
          `npm exited with code ${exitCode ?? "unknown"} while installing Pi.` +
            (tail ? `\n${tail.slice(-1_500)}` : ""),
        ),
      );
    });
  });
  if (code !== 0) throw new Error(`npm exited with code ${code} while installing Pi`);

  onProgress({ message: "Verifying the installed runtime…" });
  // Never trust npm's exit code alone: re-resolve through the same check the
  // launcher uses, so "installed" means "the launcher will find this build".
  const located = await resolvePinnedPiRuntime([resolve(managedPiRuntimeNodeModules())]);
  onProgress({ message: `Pi ${located.version} is installed.` });
  return located.version;
}
