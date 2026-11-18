// How an agent CLI was installed, and therefore how it is updated.
//
// Codara never guesses: it reads where the binary really lives and uses that
// installer's own command. The vendor's native installer and a global npm
// package in a folder the user can write are updated by Codara; anything else
// (Homebrew, WinGet, Scoop, pnpm, bun, Volta, an npm folder that needs
// administrator rights, an unknown layout) gets the command shown, never run.
// Everything here is pure apart from the two file probes the caller passes,
// so every platform's layout is tested on any machine.

import { posix, win32 } from "node:path";

import type { UpdatableAgentCliToolId } from "@shared/agent-cli-updates";

export interface CliCommand {
  executable: string;
  args: string[];
  /** Extra environment for the command, on top of the enriched one. */
  env?: Record<string, string>;
  /** The command as a person would type it. */
  display: string;
}

export interface InstallPlan {
  method: "native" | "npm" | "manual";
  /** How the install was recognised, in plain words. */
  source: string;
  /** What Codara runs to update; null for a manual install. */
  update: CliCommand | null;
  /** What a person runs to update it by hand. */
  manualCommand: string;
  /**
   * Installs `version` again. `binary` is the previous version's own binary
   * when it is still on disk (a broken new build must not run its own
   * roll back), else the launcher. Null for a manual install.
   */
  rollback: ((version: string, binary: string) => CliCommand) | null;
}

export interface InstallProbeInput {
  tool: UpdatableAgentCliToolId;
  platform: NodeJS.Platform;
  /** The launcher the binary resolver found. */
  binaryPath: string;
  /** The launcher with every symlink followed. */
  realPath: string;
  /** The `npm` the enriched PATH resolves, or null. */
  npmOnPath: string | null;
  exists: (path: string) => Promise<boolean>;
  writable: (path: string) => Promise<boolean>;
}

export const NPM_PACKAGES: Record<UpdatableAgentCliToolId, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  grok: "@xai-official/grok",
};

const VENDOR_UPDATE: Record<UpdatableAgentCliToolId, string> = {
  claude: "claude update",
  codex: "codex update",
  grok: "grok update",
};

// The vendor installers' layouts, matched on the real path with forward
// slashes. Claude keeps each version as one file under versions/ (POSIX links
// ~/.local/bin/claude to it; Windows copies claude.exe into ~/.local/bin).
// Codex links its launcher into packages/standalone/releases/<version>-<target>.
// Grok links ~/.grok/bin/grok to downloads/grok-<version>-<platform> (older
// installers: to grok-<version> beside it).
const NATIVE_LAYOUTS: Record<UpdatableAgentCliToolId, RegExp> = {
  claude: /\/\.local\/share\/claude\/versions\/[^/]+$/i,
  codex: /\/packages\/standalone\/releases\/[^/]+\/(?:bin\/)?codex(?:\.exe)?$/i,
  grok: /\/\.grok\/(?:bin|downloads)\/grok(?:-[\w.-]+)?(?:\.exe)?$/i,
};

function slashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function quoteForDisplay(value: string): string {
  return /[\s"']/.test(value) ? JSON.stringify(value) : value;
}

function manual(source: string, manualCommand: string): InstallPlan {
  return { method: "manual", source, update: null, manualCommand, rollback: null };
}

function nativePlan(tool: UpdatableAgentCliToolId, launcher: string): InstallPlan {
  const run = (binary: string, args: string[], env?: Record<string, string>): CliCommand => ({
    executable: binary,
    args,
    ...(env ? { env } : {}),
    display: [tool, ...args].join(" "),
  });
  const rollback: Record<UpdatableAgentCliToolId, (version: string, binary: string) => CliCommand> = {
    // Without --force Claude's installer reports success and keeps the
    // newer build selected.
    claude: (version, binary) => run(binary, ["install", version, "--force"]),
    // `codex update` runs Codex's own installer, which takes the release to
    // install from CODEX_RELEASE.
    codex: (version, binary) => ({ ...run(binary, ["update"], { CODEX_RELEASE: version }), display: `CODEX_RELEASE=${version} codex update` }),
    grok: (version, binary) => run(binary, ["update", "--version", version]),
  };
  return {
    method: "native",
    source: "native installer",
    update: run(launcher, ["update"]),
    manualCommand: VENDOR_UPDATE[tool],
    rollback: rollback[tool],
  };
}

/** Another package manager's global folder, recognised from the real path. */
function otherManager(tool: UpdatableAgentCliToolId, real: string): InstallPlan | null {
  const pkg = NPM_PACKAGES[tool];
  const brew = /\/(Caskroom|Cellar)\/([^/]+)\//i.exec(real);
  if (brew) {
    const cask = brew[1].toLowerCase() === "caskroom";
    return manual("Homebrew", `brew upgrade ${cask ? "--cask " : ""}${brew[2]}`);
  }
  if (/\/Microsoft\/WinGet\//i.test(real)) {
    return manual("WinGet", tool === "claude" ? "winget upgrade --id Anthropic.ClaudeCode" : "winget upgrade");
  }
  const scoop = /\/scoop\/apps\/([^/]+)\//i.exec(real);
  if (scoop) return manual("Scoop", `scoop update ${scoop[1]}`);
  if (/\/\.volta\//i.test(real)) return manual("Volta", `volta install ${pkg}@latest`);
  if (/\/(?:\.?pnpm)\//i.test(real)) return manual("pnpm", `pnpm add -g ${pkg}@latest`);
  if (/\/\.bun\//i.test(real)) return manual("bun", `bun add -g ${pkg}@latest`);
  return null;
}

/**
 * npm's global prefix that holds this tool, when the tool is an npm global
 * there: POSIX links <prefix>/bin/<tool> into <prefix>/lib/node_modules/<pkg>,
 * Windows writes <prefix>\<tool>.cmd beside <prefix>\node_modules\<pkg>.
 */
async function npmPrefix(input: InstallProbeInput, real: string): Promise<string | null> {
  const pkg = NPM_PACKAGES[input.tool];
  const path = input.platform === "win32" ? win32 : posix;
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const index = new RegExp(`/lib/node_modules/${escaped}/`, "i").exec(real)?.index ?? -1;
  if (index > 0) return path.normalize(real.slice(0, index));
  const winIndex = new RegExp(`/node_modules/${escaped}/`, "i").exec(real)?.index ?? -1;
  if (input.platform === "win32" && winIndex > 0) return path.normalize(real.slice(0, winIndex));
  if (input.platform === "win32") {
    const dir = win32.dirname(input.binaryPath);
    if (await input.exists(win32.join(dir, "node_modules", ...pkg.split("/"), "package.json"))) return dir;
  }
  return null;
}

async function npmPlan(input: InstallProbeInput, prefix: string): Promise<InstallPlan> {
  const pkg = NPM_PACKAGES[input.tool];
  const win = input.platform === "win32";
  const path = win ? win32 : posix;
  const modules = win ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  const manualCommand = `npm install -g ${pkg}@latest`;
  if (!(await input.writable(modules))) {
    return manual("npm, in a folder that needs administrator rights", manualCommand);
  }
  // The npm of the same Node install keeps the tool where it is; --prefix
  // pins the folder when that npm is not beside it (Windows keeps npm.cmd in
  // Program Files and the globals in %APPDATA%\npm).
  const besidePrefix = win ? path.join(prefix, "npm.cmd") : path.join(prefix, "bin", "npm");
  const npm = (await input.exists(besidePrefix)) ? besidePrefix : input.npmOnPath;
  if (!npm) return manual("npm", manualCommand);
  // cmd.exe expands % and ends a quoted part at ", whatever the quoting.
  if (win && [npm, prefix].some((part) => /[%"\r\n]/.test(part))) return manual("npm", manualCommand);
  const install = (spec: string): CliCommand => ({
    executable: npm,
    args: ["install", "-g", "--prefix", prefix, spec],
    display: `npm install -g --prefix ${quoteForDisplay(prefix)} ${spec}`,
  });
  return {
    method: "npm",
    source: "npm",
    update: install(`${pkg}@latest`),
    manualCommand,
    rollback: (version) => install(`${pkg}@${version}`),
  };
}

export async function detectInstallPlan(input: InstallProbeInput): Promise<InstallPlan> {
  const real = slashes(input.realPath);
  // A Homebrew formula on Node keeps an npm tree in its Cellar, and Volta an
  // npm tree per package: those are theirs. A Node that pnpm or Scoop
  // installed has its own npm, and its globals are npm's.
  const other = otherManager(input.tool, real);
  const managedNode = /\/(?:\.?pnpm|scoop\/(?:apps|persist))\/nodejs\//i.test(real);
  if (other && !managedNode) return other;
  const prefix = await npmPrefix(input, real);
  if (prefix) return npmPlan(input, prefix);
  if (other) return other;
  // A plain file at ~/.local/bin/claude is the installer's copy only on
  // Windows; elsewhere it is the user's own wrapper.
  const windowsClaude = input.tool === "claude" && input.platform === "win32" && /\/\.local\/bin\/claude\.exe$/i.test(real);
  if (windowsClaude || NATIVE_LAYOUTS[input.tool].test(real)) {
    return nativePlan(input.tool, input.binaryPath);
  }
  return manual("unknown", VENDOR_UPDATE[input.tool]);
}

/**
 * The command as it can be spawned: Windows runs a .cmd or .bat shim (npm's)
 * through cmd.exe with the whole command quoted once, as the onboarding
 * installer does.
 */
export function spawnableCommand(
  command: CliCommand,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): CliCommand & { verbatim: boolean } {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(command.executable)) {
    // cmd.exe expands % and ends a quoted part at ", whatever the quoting.
    if ([command.executable, ...command.args].some((part) => /[%"\r\n]/.test(part))) {
      throw new Error(`Codara does not run ${command.display} through cmd.exe: its path holds %, " or a line break.`);
    }
    const quoted = [command.executable, ...command.args].map((part) => `"${part}"`).join(" ");
    // Never a cmd.exe found on PATH or in the working folder.
    const shell = env.ComSpec || win32.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
    return { ...command, executable: shell, args: ["/d", "/s", "/c", `"${quoted}"`], verbatim: true };
  }
  return { ...command, verbatim: false };
}
