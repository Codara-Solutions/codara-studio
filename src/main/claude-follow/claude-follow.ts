import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertCodaraOwnedWrite } from "../outside-write-guard";
import { atomicWritePrivateFile, readPrivateJsonFile } from "../orchestration/native-cli-atomic-file";
import {
  CLAUDE_FOLLOW_SCRIPT_NAMES,
  renderClaudeFollowBlock,
  renderClaudeFollowFishDropIn,
  renderClaudeFollowScript,
  type ClaudeFollowShell,
} from "./hook-scripts";
import {
  addStartupBlock,
  planStartupTargets,
  removeStartupBlock,
  sweepStartupTemporaries,
  type PowerShellProbe,
  type StartupEdition,
  type StartupTarget,
} from "./startup-files";

/**
 * claude-follow: a plain `claude`, typed in any terminal outside Codara,
 * uses the account active in Codara, and stops doing so the moment Codara
 * is gone. The parts:
 *
 *  - hook-scripts.ts renders one small script per shell, kept in Codara's
 *    own folder (<codaraHome>/shell/claude-follow.*). It wraps `claude` so
 *    that, while the flag file below exists and the recorded app is still
 *    on disk, Claude Code runs with CLAUDE_CONFIG_DIR at the live slot, the
 *    same directory Codara's panes use. Nothing of the user's own login is
 *    written: the live slot holds the active account, swapped in place by
 *    Codara on a switch exactly as for its panes.
 *  - startup-files.ts adds one guarded line (or, for fish, a drop-in file)
 *    to the startup files of the shells the user uses. The line sources the
 *    script only while it exists.
 *  - this module records what it did (the manifest), keeps the flag in step
 *    with the active account, and takes everything out again: from Settings,
 *    and from the Windows uninstaller (uninstall-entry.ts). On macOS and
 *    Linux nothing runs at removal; the line and the script stay inert
 *    because the app they check for is gone.
 *  - config-sync.ts, mcp-oauth-import.ts, login-adoption.ts and
 *    shared-state.ts close the gaps between the live slot and the user's
 *    own Claude home while the feature is on.
 *
 * Only an installed copy of Codara adds lines (claudeFollowGate): never a
 * development build, a test run, a build inside a git worktree or a
 * temporary folder, or an app started from a disk image.
 */

/** Development opt-in: a dev build adds the lines too, recording its own Electron binary. */
export const CLAUDE_FOLLOW_DEV_ENV = "CODARA_CLAUDE_FOLLOW_DEV";

const MANIFEST_VERSION = 1;

export interface ClaudeFollowPaths {
  shellDir: string;
  /** Exists while a Codara-managed Claude account is active. */
  flagFile: string;
  manifestFile: string;
  /** config-sync.ts's record of what both .claude.json files last agreed on. */
  syncBaseFile: string;
  /** Originals of the startup files, copied before Codara's first edit. */
  backupDir: string;
  script(shell: ClaudeFollowShell): string;
}

export function claudeFollowPaths(codaraHome: string): ClaudeFollowPaths {
  const home = resolve(codaraHome);
  const shellDir = join(home, "shell");
  return {
    shellDir,
    flagFile: join(shellDir, "claude-follow.on"),
    manifestFile: join(shellDir, "claude-follow.json"),
    syncBaseFile: join(shellDir, "claude-follow-sync.json"),
    backupDir: join(home, "backups", "claude-follow"),
    script: (shell) => join(shellDir, CLAUDE_FOLLOW_SCRIPT_NAMES[shell]),
  };
}

// ---------------------------------------------------------------------------
// Which builds may add the lines.

export type ClaudeFollowUnavailableReason = "development" | "temporary" | "location";

export type ClaudeFollowGate =
  | { allowed: true; appPath: string; dev: boolean }
  | { allowed: false; reason: ClaudeFollowUnavailableReason };

export interface ClaudeFollowGateProbe {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  env: NodeJS.ProcessEnv;
  codaraHome: string;
  /** This process is the AppImage APPIMAGE names (appimage-launch.ts). */
  fromAppImage: boolean;
  /** A temporary folder or a git worktree checkout (hook-installer.ts). */
  isTransientPath: (path: string) => Promise<boolean>;
}

/**
 * The path the hook checks to know Codara is still installed: the .app
 * bundle on macOS (moving it to the Trash removes it), the AppImage file on
 * Linux, the installed executable on Windows.
 */
export function installedAppPath(
  platform: NodeJS.Platform,
  execPath: string,
  env: NodeJS.ProcessEnv,
  fromAppImage: boolean,
): string {
  if (platform === "darwin") {
    const bundle = /^(.*?\.app)(?:\/|$)/i.exec(execPath);
    if (bundle) return bundle[1];
  }
  if (platform === "linux" && fromAppImage && env.APPIMAGE?.trim()) return env.APPIMAGE.trim();
  return execPath;
}

export async function claudeFollowGate(probe: ClaudeFollowGateProbe): Promise<ClaudeFollowGate> {
  const dev = probe.env[CLAUDE_FOLLOW_DEV_ENV] === "1";
  // A test run keeps Codara's folder in a temporary directory; nothing it
  // records may outlive it, opt-in or not.
  if (await probe.isTransientPath(probe.codaraHome).catch(() => true)) {
    return { allowed: false, reason: "temporary" };
  }
  const appPath = installedAppPath(probe.platform, probe.execPath, probe.env, probe.fromAppImage);
  if (dev) return { allowed: true, appPath, dev: true };
  if (!probe.isPackaged) return { allowed: false, reason: "development" };
  if (probe.platform === "darwin" && (/^\/Volumes\//.test(appPath) || appPath.includes("/AppTranslocation/"))) {
    // Started from the disk image or a quarantined copy: not where it stays.
    return { allowed: false, reason: "location" };
  }
  // Linux ships only as an AppImage; an unpacked build is a local package run.
  if (probe.platform === "linux" && !probe.fromAppImage) return { allowed: false, reason: "location" };
  if (await probe.isTransientPath(appPath).catch(() => true)) return { allowed: false, reason: "location" };
  return { allowed: true, appPath, dev: false };
}

// ---------------------------------------------------------------------------
// The manifest of edited startup files.

export interface ClaudeFollowManifestEntry {
  /** The startup file as the shell names it. */
  path: string;
  /** The file actually edited (a symlink's target). */
  file: string;
  shell: ClaudeFollowShell;
  kind: StartupTarget["kind"];
  /** Codara created the file. */
  created: boolean;
  /** Codara added a newline before its block. */
  joinedLastLine: boolean;
  homeDir: string;
  backup?: string;
}

export interface ClaudeFollowManifest {
  version: number;
  appPath: string;
  entries: ClaudeFollowManifestEntry[];
  /** The one-time copy of the user's MCP sign-ins was made. */
  mcpOAuthImported?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SHELLS = new Set<ClaudeFollowShell>(["zsh", "bash", "fish", "powershell"]);

function manifestEntry(value: unknown): ClaudeFollowManifestEntry | null {
  if (!isRecord(value)) return null;
  const { path, file, shell, kind, created, joinedLastLine, homeDir, backup } = value;
  if (typeof path !== "string" || typeof file !== "string" || typeof homeDir !== "string") return null;
  if (!SHELLS.has(shell as ClaudeFollowShell) || (kind !== "block" && kind !== "dropin")) return null;
  return {
    path,
    file,
    shell: shell as ClaudeFollowShell,
    kind,
    created: created === true,
    joinedLastLine: joinedLastLine === true,
    homeDir,
    ...(typeof backup === "string" ? { backup } : {}),
  };
}

export async function readClaudeFollowManifest(paths: ClaudeFollowPaths): Promise<ClaudeFollowManifest | null> {
  const read = await readPrivateJsonFile(paths.manifestFile);
  if (read.kind !== "value" || !isRecord(read.value) || read.value.version !== MANIFEST_VERSION) return null;
  const entries = Array.isArray(read.value.entries)
    ? read.value.entries.map(manifestEntry).filter((entry): entry is ClaudeFollowManifestEntry => entry !== null)
    : [];
  return {
    version: MANIFEST_VERSION,
    appPath: typeof read.value.appPath === "string" ? read.value.appPath : "",
    entries,
    ...(read.value.mcpOAuthImported === true ? { mcpOAuthImported: true } : {}),
  };
}

export async function writeClaudeFollowManifest(
  paths: ClaudeFollowPaths,
  manifest: ClaudeFollowManifest,
): Promise<void> {
  await atomicWritePrivateFile(paths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// The flag.

/** Create or remove the flag; answers whether it now exists. */
export async function writeClaudeFollowFlag(paths: ClaudeFollowPaths, on: boolean): Promise<boolean> {
  assertCodaraOwnedWrite(paths.flagFile);
  if (on) {
    const exists = await fs.lstat(paths.flagFile).catch(() => null);
    if (!exists?.isFile()) await atomicWritePrivateFile(paths.flagFile, "1\n");
    return true;
  }
  await fs.rm(paths.flagFile, { force: true });
  return false;
}

// ---------------------------------------------------------------------------
// Adding and removing.

export interface ClaudeFollowContext {
  codaraHome: string;
  /** The user's home (os.homedir()). */
  homeDir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The user's login shell (os.userInfo().shell). */
  loginShell: string | null;
  /** The live slot, spelled exactly as Codara's panes pass it. */
  liveConfigDir: string;
  resolveZdotdir?: () => Promise<string | null>;
  probePowerShell?: (edition: StartupEdition) => Promise<PowerShellProbe | null>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface ClaudeFollowFileReport {
  path: string;
  shell: ClaudeFollowShell;
  result: "written" | "unchanged" | "removed-file" | "skipped" | "changed-meanwhile" | "failed";
  reason?: string;
}

export interface ClaudeFollowEditReport {
  files: ClaudeFollowFileReport[];
  manifest: ClaudeFollowManifest | null;
}

async function planFor(context: ClaudeFollowContext) {
  return planStartupTargets({
    platform: context.platform,
    homeDir: context.homeDir,
    env: context.env,
    loginShell: context.loginShell,
    ...(context.resolveZdotdir ? { resolveZdotdir: context.resolveZdotdir } : {}),
    ...(context.probePowerShell ? { probePowerShell: context.probePowerShell } : {}),
  });
}

function backupName(path: string): string {
  const tag = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return `${basename(path).replace(/^\./, "dot-")}-${tag}`;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Write one of Codara's scripts; Codara's own folder, so a plain atomic write. */
async function writeScript(path: string, content: string): Promise<void> {
  const current = await fs.readFile(path, "utf8").catch(() => null);
  if (current === content) return;
  await atomicWritePrivateFile(path, content);
}

/**
 * Write the scripts and add the line to every startup file of a shell the
 * user uses. Idempotent: a second run changes nothing unless the recorded
 * app or the live slot moved.
 */
export async function installClaudeFollow(
  context: ClaudeFollowContext,
  appPath: string,
): Promise<ClaudeFollowEditReport> {
  const paths = claudeFollowPaths(context.codaraHome);
  const plan = await planFor(context);
  const previous = await readClaudeFollowManifest(paths);
  const manifest: ClaudeFollowManifest = {
    version: MANIFEST_VERSION,
    appPath,
    entries: [...(previous?.entries ?? [])],
    ...(previous?.mcpOAuthImported ? { mcpOAuthImported: true } : {}),
  };
  const files: ClaudeFollowFileReport[] = plan.skipped.map((skip) => ({
    path: skip.path,
    shell: skip.shell,
    result: "skipped",
    reason: skip.reason,
  }));

  // The scripts first, so a line never sources a script that is not there yet.
  const shells = new Set<ClaudeFollowShell>([
    ...plan.targets.map((target) => target.shell),
    ...manifest.entries.map((entry) => entry.shell),
  ]);
  for (const shell of shells) {
    await writeScript(
      paths.script(shell),
      renderClaudeFollowScript(shell, {
        platform: context.platform,
        appPath,
        flagFile: paths.flagFile,
        liveConfigDir: context.liveConfigDir,
      }),
    );
  }

  const backupRun = join(paths.backupDir, stamp((context.now ?? (() => new Date()))()));
  for (const target of plan.targets) {
    const existing = manifest.entries.find((entry) => entry.path === target.path);
    const lineInput = { platform: context.platform, homeDir: target.homeDir, scriptPath: paths.script(target.shell) };
    const content =
      target.kind === "dropin"
        ? renderClaudeFollowFishDropIn(lineInput)
        : renderClaudeFollowBlock(target.shell as Exclude<ClaudeFollowShell, "fish">, lineInput);
    try {
      const outcome = await addStartupBlock(target, content, {
        backupFile: existing?.backup ? null : join(backupRun, backupName(target.path)),
      });
      if (outcome.result === "written" || outcome.result === "unchanged") {
        const entry: ClaudeFollowManifestEntry = {
          path: target.path,
          file: outcome.file,
          shell: target.shell,
          kind: target.kind,
          created: (existing?.created ?? false) || (outcome.result === "written" && outcome.created),
          joinedLastLine:
            (existing?.joinedLastLine ?? false) || (outcome.result === "written" && outcome.joinedLastLine),
          homeDir: target.homeDir,
          ...(existing?.backup
            ? { backup: existing.backup }
            : outcome.result === "written" && outcome.backup
              ? { backup: outcome.backup }
              : {}),
        };
        const index = manifest.entries.findIndex((item) => item.path === target.path);
        if (index >= 0) manifest.entries[index] = entry;
        else manifest.entries.push(entry);
        // The manifest is saved after every file, so an interruption never
        // leaves a line Codara does not know to take out.
        await writeClaudeFollowManifest(paths, manifest);
        files.push({ path: target.path, shell: target.shell, result: outcome.result });
      } else if (outcome.result === "skipped") {
        files.push({ path: target.path, shell: target.shell, result: "skipped", reason: outcome.reason });
      } else {
        files.push({ path: target.path, shell: target.shell, result: "changed-meanwhile" });
      }
    } catch (error) {
      files.push({
        path: target.path,
        shell: target.shell,
        result: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await writeClaudeFollowManifest(paths, manifest);
  await sweepStartupTemporaries(manifest.entries.map((entry) => entry.file)).catch(() => undefined);
  return { files, manifest };
}

export interface ClaudeFollowRemoveOptions {
  /**
   * Also look for Codara's block in every startup file the plan names, for
   * a manifest that was lost. Only an installed build does this.
   */
  scanStartupFiles: boolean;
}

/**
 * Take every line out, delete the scripts and the flag. A file that cannot
 * be edited right now stays in the manifest for the next attempt; its line
 * is inert meanwhile, since the script it sources is gone.
 */
export async function removeClaudeFollow(
  context: ClaudeFollowContext,
  options: ClaudeFollowRemoveOptions,
): Promise<ClaudeFollowEditReport> {
  const paths = claudeFollowPaths(context.codaraHome);
  const manifest = await readClaudeFollowManifest(paths);
  const entries: ClaudeFollowManifestEntry[] = [...(manifest?.entries ?? [])];
  if (options.scanStartupFiles) {
    const plan = await planFor(context).catch(() => ({ targets: [] as StartupTarget[] }));
    for (const target of plan.targets) {
      if (entries.some((entry) => entry.path === target.path)) continue;
      entries.push({
        path: target.path,
        file: target.path,
        shell: target.shell,
        kind: target.kind,
        created: false,
        joinedLastLine: false,
        homeDir: target.homeDir,
      });
    }
  }

  // The flag and scripts first: every line is inert from this moment on.
  await writeClaudeFollowFlag(paths, false).catch(() => undefined);
  for (const shell of SHELLS) {
    const script = paths.script(shell);
    assertCodaraOwnedWrite(script);
    await fs.rm(script, { force: true }).catch(() => undefined);
  }

  const files: ClaudeFollowFileReport[] = [];
  const remaining: ClaudeFollowManifestEntry[] = [];
  for (const entry of entries) {
    try {
      const outcome = await removeStartupBlock(entry.path, entry.kind, {
        created: entry.created,
        joinedLastLine: entry.joinedLastLine,
        homeDir: entry.homeDir,
      });
      if (outcome.result === "skipped" || outcome.result === "changed-meanwhile") {
        // A file that became a git-tracked link or changed meanwhile: a
        // recorded entry is tried again later; a scanned one is not ours to chase.
        if (manifest?.entries.includes(entry)) remaining.push(entry);
        files.push({
          path: entry.path,
          shell: entry.shell,
          result: outcome.result,
          ...(outcome.result === "skipped" ? { reason: outcome.reason } : {}),
        });
        continue;
      }
      files.push({ path: entry.path, shell: entry.shell, result: outcome.result });
    } catch (error) {
      if (manifest?.entries.includes(entry)) remaining.push(entry);
      files.push({
        path: entry.path,
        shell: entry.shell,
        result: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await sweepStartupTemporaries(entries.map((entry) => entry.file)).catch(() => undefined);

  if (remaining.length > 0 && manifest) {
    const next = { ...manifest, entries: remaining };
    await writeClaudeFollowManifest(paths, next);
    return { files, manifest: next };
  }
  for (const file of [paths.manifestFile, paths.syncBaseFile]) {
    assertCodaraOwnedWrite(file);
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
  return { files, manifest: null };
}
