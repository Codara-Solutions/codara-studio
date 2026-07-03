// PATH reconstruction for child processes.
//
// Electron apps launched from a graphical shell (Finder, Dock, Windows
// Explorer, taskbar shortcuts) inherit a sparse $PATH that does NOT include
// the directories the user's interactive shell normally adds — Homebrew,
// nvm, volta, scoop, npm-global, pyenv, /usr/local/bin, ~/.local/bin, and so
// on. The first user-visible symptom: `claude --version` works in the
// terminal but Codara reports "claude not installed" because spawn("claude")
// uses the sparse PATH.
//
// Strategy:
//   macOS / Linux — spawn the user's login shell with `-ilc 'echo <delims>
//     $PATH <delims>'`, read PATH out of the output. The login flag makes
//     the shell source the user's profile files (.zprofile, .bash_profile,
//     .profile) which is where most installers add their bin directories.
//
//   Windows — read the user (HKCU) and machine (HKLM) Environment registry
//     keys directly. The interactive process env is built from these at
//     login plus any per-process additions; reading them straight from the
//     registry gets us the same PATH the user sees in cmd / pwsh. We merge
//     with whatever the current process already has so per-process
//     additions (like nvm's session shim) survive.
//
// The result is memoized: the first call kicks off the lookup, every later
// call returns the cached value. The expectation is that Codara calls
// getEnrichedPath() once at app startup so PTY spawns can read the value
// synchronously from `getCachedEnrichedPath()` without awaiting anything.
//
// On any failure (shell missing, registry unreadable, 3s timeout) we fall
// back to process.env.PATH so the spawn still works — just without the
// enrichment. The cache also stores the fallback, so we don't retry the
// expensive lookup on every spawn.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter } from "node:path";

const SHELL_TIMEOUT_MS = 3000;
const REGISTRY_TIMEOUT_MS = 3000;

// Sentinels around the PATH inside the login shell's echo output. Picked to
// be very unlikely to appear in any real PATH entry, and to survive any
// shell-startup banner / prompt / motd noise that may also land in stdout.
const SENTINEL_START = "<<SPARK_PATH_START>>";
const SENTINEL_END = "<<SPARK_PATH_END>>";

let cachedPath: string | null = null;
let inflight: Promise<string> | null = null;

/**
 * Returns the enriched PATH for child processes. The first call computes it
 * (login-shell sourcing on POSIX, registry reads on Windows) and caches the
 * result; later calls return the cache.
 */
export function getEnrichedPath(): Promise<string> {
  if (cachedPath !== null) return Promise.resolve(cachedPath);
  if (inflight) return inflight;
  inflight = computeEnrichedPath()
    .then((value) => {
      cachedPath = value;
      inflight = null;
      return value;
    })
    .catch((err) => {
      // computeEnrichedPath() already handles its own failure modes — this
      // only fires for a programmer error / unexpected throw. Cache the
      // process.env fallback so we don't keep retrying.
      console.error("[path-reconstruction] unexpected failure:", err);
      cachedPath = process.env.PATH ?? process.env.Path ?? "";
      inflight = null;
      return cachedPath;
    });
  return inflight;
}

/**
 * Synchronous access to the cached enriched PATH. Returns the in-process
 * fallback (process.env.PATH) until the async warmup has run. Callers on a
 * hot path (PTY spawn) should rely on this after the startup warmup.
 */
export function getCachedEnrichedPath(): string {
  if (cachedPath !== null) return cachedPath;
  return process.env.PATH ?? process.env.Path ?? "";
}

/**
 * Build an env block with PATH replaced by the enriched value. Mirrors the
 * shape pty-manager already produces (string-only values). The platform's
 * canonical key (`Path` on Windows, `PATH` elsewhere) is set, and the other
 * variant is removed so the spawned process doesn't see two different
 * answers — Windows is case-insensitive for env vars but Node's child_process
 * still forwards both keys verbatim if both exist.
 */
export async function getEnrichedEnv(): Promise<NodeJS.ProcessEnv> {
  const path = await getEnrichedPath();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (process.platform === "win32") {
    delete env.PATH;
    env.Path = path;
  } else {
    env.PATH = path;
  }
  return env;
}

/**
 * Replace the PATH entry on an existing env block in place. Used by
 * pty-manager so it doesn't have to await `getEnrichedEnv()` on the hot
 * spawn path — it owns the env build and just calls this after.
 */
export function injectEnrichedPath(env: Record<string, string>): void {
  const path = getCachedEnrichedPath();
  if (!path) return;
  if (process.platform === "win32") {
    // Windows env is case-insensitive but the keys we receive may use any
    // casing. Drop every variant first so the spawned process sees exactly
    // one PATH-like value (the one we set as `Path`).
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key];
    }
    env.Path = path;
  } else {
    env.PATH = path;
  }
}

/** Test-only hook: forget the memoized value so the next call recomputes. */
export function _resetPathReconstructionCache(): void {
  cachedPath = null;
  inflight = null;
}

async function computeEnrichedPath(): Promise<string> {
  const fallback = process.env.PATH ?? process.env.Path ?? "";
  try {
    if (process.platform === "win32") {
      return await computeWindowsPath(fallback);
    }
    return await computeUnixPath(fallback);
  } catch (err) {
    console.error("[path-reconstruction] failed, using fallback:", err);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// POSIX: source the user's login shell.
// ---------------------------------------------------------------------------

async function computeUnixPath(fallback: string): Promise<string> {
  const shell = pickLoginShell();
  const output = await runShellCapture(shell);
  if (!output) return fallback;
  const start = output.indexOf(SENTINEL_START);
  const end = output.indexOf(SENTINEL_END, start + SENTINEL_START.length);
  if (start < 0 || end < 0) {
    console.warn(
      "[path-reconstruction] login shell output missing sentinels; falling back",
    );
    return fallback;
  }
  const value = output.slice(start + SENTINEL_START.length, end).trim();
  if (!value) return fallback;
  return mergePaths(value, fallback);
}

function pickLoginShell(): string {
  // $SHELL is the user's preferred interactive shell — it's what
  // chsh-style tooling, terminals, and `getent passwd` agree on. Fall back
  // to bash so we always have a reachable binary.
  return process.env.SHELL && process.env.SHELL.trim().length > 0
    ? process.env.SHELL
    : "/bin/bash";
}

function runShellCapture(shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(value);
    };
    // -i (interactive) loads rc files like ~/.zshrc that define aliases AND
    // export $PATH additions in the user's preferred shell. -l (login) makes
    // it source profile files too. The combined `-ilc` is what every PATH-
    // reconstruction implementation I've seen in similar Electron apps uses.
    let child;
    try {
      child = spawn(shell, [
        "-ilc",
        `echo "${SENTINEL_START}$PATH${SENTINEL_END}"`,
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Don't inherit our possibly-sparse env — let the login shell build
        // its own from the user's profile. We still pass HOME because some
        // shells need it to find rc files.
        env: {
          HOME: process.env.HOME ?? homedir(),
          USER: process.env.USER ?? "",
          LOGNAME: process.env.LOGNAME ?? "",
          LANG: process.env.LANG ?? "",
          TERM: "dumb",
        },
      });
    } catch (err) {
      console.warn("[path-reconstruction] login shell spawn failed:", err);
      finish(null);
      return;
    }
    const out: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", (err) => {
      console.warn("[path-reconstruction] login shell error:", err);
      finish(null);
    });
    child.on("close", () => {
      finish(Buffer.concat(out).toString("utf8"));
    });
    const timer = setTimeout(() => {
      console.warn(
        `[path-reconstruction] login shell timed out after ${SHELL_TIMEOUT_MS}ms`,
      );
      try {
        child.kill("SIGTERM");
      } catch {
        /* best effort */
      }
      finish(null);
    }, SHELL_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------------------
// Windows: read the user + system Environment keys from the registry.
// ---------------------------------------------------------------------------

async function computeWindowsPath(fallback: string): Promise<string> {
  const [userPath, systemPath] = await Promise.all([
    readRegistryPath("HKCU", "Environment", "Path"),
    readRegistryPath(
      "HKLM",
      "System\\CurrentControlSet\\Control\\Session Manager\\Environment",
      "Path",
    ),
  ]);
  // System-wide entries first, then user-specific, then anything the current
  // process already accumulated. Matches Windows' own merge order at logon
  // (system first, user appended) and keeps process-local PATH additions
  // (e.g. nvm-windows session shim, `npm config set prefix`) at the end so
  // they win on duplicate basenames thanks to mergePaths's dedupe.
  return mergePaths(systemPath ?? "", userPath ?? "", fallback);
}

function readRegistryPath(
  hive: "HKCU" | "HKLM",
  subkey: string,
  name: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(value);
    };
    // `reg.exe query` is shipped on every Windows install and is faster than
    // PowerShell's Get-ItemProperty (no .NET / module load). The output has
    // a fixed layout:
    //
    //   HKEY_CURRENT_USER\Environment
    //       Path    REG_EXPAND_SZ    C:\foo;C:\bar
    //
    // We parse the line that starts with the variable name.
    const fullKey = hive === "HKCU"
      ? `HKCU\\${subkey}`
      : `HKLM\\${subkey}`;
    let child;
    try {
      child = spawn("reg.exe", ["query", fullKey, "/v", name], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      console.warn("[path-reconstruction] reg.exe spawn failed:", err);
      finish(null);
      return;
    }
    const out: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", (err) => {
      console.warn("[path-reconstruction] reg.exe error:", err);
      finish(null);
    });
    child.on("close", () => {
      const text = Buffer.concat(out).toString("utf8");
      finish(parseRegOutput(text, name));
    });
    const timer = setTimeout(() => {
      console.warn(
        `[path-reconstruction] reg.exe timed out after ${REGISTRY_TIMEOUT_MS}ms (${fullKey})`,
      );
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      finish(null);
    }, REGISTRY_TIMEOUT_MS);
  });
}

// Exported for unit-style sanity checks in this file's tests.
export function parseRegOutput(text: string, name: string): string | null {
  // Lines look like:
  //     Path    REG_EXPAND_SZ    C:\Windows\system32;C:\Windows;...
  // The leading whitespace is at least four spaces; columns are separated by
  // runs of whitespace. Use a simple regex that captures everything after the
  // type column.
  const lines = text.split(/\r?\n/);
  const target = name.toLowerCase();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\S+)\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s+(.*)$/);
    if (!m) continue;
    if (m[1].toLowerCase() !== target) continue;
    const value = m[2].trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Merge utility.
// ---------------------------------------------------------------------------

/**
 * Concatenate any number of PATH-shaped strings, splitting on the platform
 * delimiter (`;` on Windows, `:` elsewhere) and dropping duplicates while
 * preserving the order of first appearance.
 */
export function mergePaths(...parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const entry of part.split(delimiter)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // Normalize for dedup but preserve original casing in output. Windows
      // paths are case-insensitive so dedup must compare lowercased.
      const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.join(delimiter);
}
