// Binary resolver.
//
// When the user picks "Claude Code" (or any other agent CLI) in the runtime
// picker, Codara needs the absolute path to the binary on this machine.
// `which` / `where` is the obvious starting point, but in practice it misses
// installs that aren't on the inherited PATH — Electron from Finder/Dock
// inherits a sparse PATH that excludes npm-global, nvm, volta, scoop, etc.
//
// The resolver probes in priority order and caches the first hit per binary
// name:
//
//   1. `which` / `where` using the enriched PATH (login-shell-sourced on
//      POSIX, registry-merged on Windows). This catches anything the user's
//      interactive shell could find.
//   2. `npm prefix -g` + the standard global-install layout (`/bin/<name>`
//      on POSIX, `\<name>.cmd` on Windows). Most agent CLIs ship as npm
//      packages, so this is the most reliable single hit.
//   3. Hard-coded list of common install dirs: nvm versions, volta, scoop
//      shims, /usr/local/bin, ~/AppData/Roaming/npm, ~/.local/bin, fnm, etc.
//      These are the directories that don't always make it into PATH but
//      always exist if the user installed the corresponding tool.
//
// The resolver does NOT shell out for every candidate — it only stat()s the
// filesystem. The two shell-outs (which/where, npm prefix) are bounded by
// short timeouts so a hung user shell can't block the resolver forever.

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import { getCachedEnrichedPath, getEnrichedPath } from "./path-reconstruction";

const PROBE_TIMEOUT_MS = 3000;

// Resolved-binary cache keyed by the requested name (e.g. "claude"). null
// values are cached too — a missing binary doesn't change between probes
// inside a single app lifetime, and we don't want every detect call to walk
// the same set of nonexistent paths. `clearResolverCache()` flushes both.
const cache = new Map<string, string | null>();

export function clearResolverCache(): void {
  cache.clear();
}

// On Windows, `where <name>` can return several matches for one CLI — npm, for
// instance, installs BOTH an extensionless Unix `sh` shim and a `<name>.cmd`
// batch shim side by side (this is exactly how `codex` lands). Not all of these
// are launchable under a PTY: node-pty spawns via CreateProcess, which runs
// `.exe`/`.com` directly and — via cli-session's launcher — `.cmd`/`.bat`
// through cmd.exe and `.ps1` through PowerShell. The extensionless sh shim is
// NOT a Win32 image, so handing it to CreateProcess fails with
// "Cannot create process, error code: 193" (ERROR_BAD_EXE_FORMAT). Rank matches
// so we never hand back the sh shim when a launchable sibling exists.
const WINDOWS_LAUNCH_RANK: Record<string, number> = {
  ".exe": 0,
  ".com": 0,
  ".cmd": 1,
  ".bat": 1,
  ".ps1": 2,
};

function pickLaunchableBinary(matches: readonly string[]): string | null {
  if (matches.length === 0) return null;
  if (process.platform !== "win32") return matches[0];
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const match of matches) {
    // Unknown / extensionless ranks last (3) — still a fallback if it's the
    // only thing `where` found, but always beaten by a real launchable form.
    const rank = WINDOWS_LAUNCH_RANK[extname(match).toLowerCase()] ?? 3;
    if (rank < bestRank) {
      best = match;
      bestRank = rank;
    }
  }
  return best ?? matches[0];
}

/**
 * Returns the absolute path to a binary on this machine, or null if it
 * isn't installed in any known location.
 */
export async function resolveBinary(name: string): Promise<string | null> {
  if (!name || typeof name !== "string") return null;
  if (cache.has(name)) return cache.get(name) ?? null;

  // Ensure the enriched PATH is computed before we probe — `whichWhere`
  // reads from `getCachedEnrichedPath()` which falls back to process.env.PATH
  // if the warmup hasn't happened yet, so this also acts as a lazy fallback
  // for callers that resolve before app startup.
  await getEnrichedPath();

  const found =
    (await probeWhichWhere(name)) ||
    (await probeNpmPrefix(name)) ||
    (await probeCommonDirs(name));

  cache.set(name, found);
  return found;
}

// ---------------------------------------------------------------------------
// Probe 1: which / where with enriched PATH.
// ---------------------------------------------------------------------------

function probeWhichWhere(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(value);
    };
    const enrichedPath = getCachedEnrichedPath();
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (process.platform === "win32") {
      // Drop every PATH-cased variant so the lookup tool sees exactly one.
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "path") delete env[key];
      }
      env.Path = enrichedPath;
    } else {
      env.PATH = enrichedPath;
    }

    const cmd = process.platform === "win32" ? "where" : "which";
    let child;
    try {
      child = spawn(cmd, [name], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env,
      });
    } catch {
      finish(null);
      return;
    }
    const out: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", () => {
      const text = Buffer.concat(out).toString("utf8");
      const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      finish(pickLaunchableBinary(lines));
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      finish(null);
    }, PROBE_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------------------
// Probe 2: npm prefix -g + standard global layout.
// ---------------------------------------------------------------------------

async function probeNpmPrefix(name: string): Promise<string | null> {
  const prefix = await readNpmPrefix();
  if (!prefix) return null;
  if (process.platform === "win32") {
    // npm on Windows installs CLI shims as `<name>.cmd` (sometimes
    // `<name>.ps1` / `<name>.bat` too) directly under the prefix, not under
    // a `bin/` subdirectory. We probe a few extensions in turn.
    // `.exe` first — a native image spawns directly under CreateProcess; the
    // `.cmd`/`.bat`/`.ps1` shims need cli-session's shell wrapper, and the
    // bare (extensionless) sh shim isn't launchable on Windows at all, so it
    // ranks last (see pickLaunchableBinary).
    const candidates = [
      join(prefix, `${name}.exe`),
      join(prefix, `${name}.cmd`),
      join(prefix, `${name}.bat`),
      join(prefix, `${name}.ps1`),
      join(prefix, name),
    ];
    return firstExisting(candidates);
  }
  return firstExisting([join(prefix, "bin", name)]);
}

function readNpmPrefix(): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(value);
    };
    const enrichedPath = getCachedEnrichedPath();
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (process.platform === "win32") {
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "path") delete env[key];
      }
      env.Path = enrichedPath;
    } else {
      env.PATH = enrichedPath;
    }

    // On Windows the npm shim is npm.cmd, which needs to be invoked through
    // cmd.exe — direct spawn("npm.cmd", ...) works via the file-extension
    // resolver in CreateProcess for some paths but fails when the shim is on
    // a UNC path or behind a junction. cmd /c is the lowest-friction path.
    const isWin = process.platform === "win32";
    let child;
    try {
      child = isWin
        ? spawn("cmd.exe", ["/c", "npm", "prefix", "-g"], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env,
          })
        : spawn("npm", ["prefix", "-g"], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env,
          });
    } catch {
      finish(null);
      return;
    }
    const out: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", () => {
      const text = Buffer.concat(out).toString("utf8").trim();
      finish(text.length > 0 ? text.split(/\r?\n/)[0].trim() : null);
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      finish(null);
    }, PROBE_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------------------
// Probe 3: common install dirs.
// ---------------------------------------------------------------------------

async function probeCommonDirs(name: string): Promise<string | null> {
  const home = homedir();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData =
      process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

    // npm global (default prefix on Windows). `.exe` first so a native image
    // beats the cmd/sh shims — the bare shim isn't launchable under node-pty.
    for (const ext of ["exe", "cmd", "bat", "ps1", ""]) {
      const tail = ext ? `${name}.${ext}` : name;
      candidates.push(join(appData, "npm", tail));
    }

    // Scoop shims — every install lands in ~\scoop\shims\<name>.exe
    candidates.push(join(home, "scoop", "shims", `${name}.exe`));
    candidates.push(join(home, "scoop", "shims", `${name}.cmd`));
    candidates.push(join(home, "scoop", "shims", name));

    // Volta shims live under %LOCALAPPDATA%\Volta\bin\<name>.exe
    candidates.push(join(localAppData, "Volta", "bin", `${name}.exe`));
    candidates.push(join(localAppData, "Volta", "bin", `${name}.cmd`));
    candidates.push(join(home, ".volta", "bin", `${name}.exe`));
    candidates.push(join(home, ".volta", "bin", `${name}.cmd`));

    // Chocolatey
    candidates.push(join(programFiles, "Chocolatey", "bin", `${name}.exe`));
    candidates.push(join(programFiles, "Chocolatey", "bin", `${name}.cmd`));

    // fnm (Fast Node Manager)
    candidates.push(...(await fnmCandidatesWindows(home, name)));

    // nvm-windows installs Node under %APPDATA%\nvm\<version>\
    candidates.push(...(await nvmWindowsCandidates(home, name)));

  } else {
    // POSIX (macOS + Linux)
    candidates.push("/usr/local/bin/" + name);
    candidates.push("/usr/bin/" + name);
    candidates.push("/opt/homebrew/bin/" + name); // Apple Silicon Homebrew
    candidates.push("/home/linuxbrew/.linuxbrew/bin/" + name);
    candidates.push(join(home, ".local", "bin", name));
    candidates.push(join(home, ".npm-global", "bin", name));
    candidates.push(join(home, ".bun", "bin", name));
    candidates.push(join(home, ".volta", "bin", name));
    candidates.push(join(home, ".cargo", "bin", name));
    candidates.push(join(home, "bin", name));

    // nvm — versions live under ~/.nvm/versions/node/<version>/bin/<name>
    candidates.push(...(await nvmPosixCandidates(home, name)));
    // fnm equivalent
    candidates.push(...(await fnmCandidatesPosix(home, name)));
  }

  return firstExisting(candidates);
}

async function nvmPosixCandidates(home: string, name: string): Promise<string[]> {
  const root = join(home, ".nvm", "versions", "node");
  return childrenBinCandidates(root, "bin", name);
}

async function nvmWindowsCandidates(home: string, name: string): Promise<string[]> {
  // nvm-windows installs to %APPDATA%\nvm\<version>\ (no /bin/), but the
  // global npm shims still land in the npm-prefix dir we already cover.
  // We still probe the <version> dir directly for cases like `node.exe`
  // / `npx.cmd` that ship inside the node install.
  const root =
    process.env.NVM_HOME ??
    join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "nvm");
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    for (const ext of ["exe", "cmd", "bat", "ps1", ""]) {
      const tail = ext ? `${name}.${ext}` : name;
      out.push(join(dir, tail));
    }
  }
  return out;
}

async function fnmCandidatesPosix(home: string, name: string): Promise<string[]> {
  // fnm uses XDG_DATA_HOME/fnm/node-versions/<v>/installation/bin on Linux,
  // and ~/Library/Application Support/fnm/node-versions/<v>/installation/bin
  // on macOS. We cover both by reading the env var first, then falling back.
  const candidates: string[] = [];
  const fnmDir = process.env.FNM_DIR;
  if (fnmDir) {
    candidates.push(
      ...(await childrenBinCandidates(
        join(fnmDir, "node-versions"),
        join("installation", "bin"),
        name,
      )),
    );
  }
  candidates.push(
    ...(await childrenBinCandidates(
      join(home, ".local", "share", "fnm", "node-versions"),
      join("installation", "bin"),
      name,
    )),
  );
  candidates.push(
    ...(await childrenBinCandidates(
      join(
        home,
        "Library",
        "Application Support",
        "fnm",
        "node-versions",
      ),
      join("installation", "bin"),
      name,
    )),
  );
  return candidates;
}

async function fnmCandidatesWindows(home: string, name: string): Promise<string[]> {
  const candidates: string[] = [];
  const fnmDir = process.env.FNM_DIR;
  const localAppData =
    process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const roots = [
    fnmDir ? join(fnmDir, "node-versions") : null,
    join(localAppData, "fnm_multishells"),
    join(localAppData, "fnm", "node-versions"),
  ].filter((value): value is string => typeof value === "string");
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fsp.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(root, entry, "installation");
      for (const ext of ["exe", "cmd", "bat", "ps1", ""]) {
        const tail = ext ? `${name}.${ext}` : name;
        candidates.push(join(dir, tail));
      }
    }
  }
  return candidates;
}

async function childrenBinCandidates(
  root: string,
  binSubdir: string,
  name: string,
): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    out.push(join(root, entry, binSubdir, name));
  }
  return out;
}

async function firstExisting(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* not present; keep going */
    }
  }
  return null;
}
