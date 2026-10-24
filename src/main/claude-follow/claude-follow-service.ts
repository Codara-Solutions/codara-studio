import { app } from "electron";
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import type { ClaudeFollowStatus } from "@shared/claude-follow";
import { runsFromAppImage } from "../appimage-launch";
import { isTransientPath } from "../hook-installer";
import { getPreferenceCached, loadPreferences, setPreference } from "../preferences-store";
import { isClaudeCliManagedProfileId } from "../orchestration/claude-cli-account-profiles";
import {
  claudeGlobalConfigFile,
  claudeLiveHome,
  type ClaudeLiveHome,
} from "../orchestration/claude-cli-live-login";
import { setClaudeForeignLoginHandler } from "../orchestration/claude-login-keeper";
import { setClaudeServersSyncedTwoWay } from "../orchestration/cli-account-homes";
import { codaraHomeDir } from "../orchestration/codara-managed-cli-roots";
import { nativeClaudeProfileStore } from "../orchestration/native-claude-profile-runtime";
import { anthropicAccounts, onActiveAccountsChanged } from "../orchestration/unified-account-registry";
import {
  claudeFollowGate,
  claudeFollowPaths,
  installClaudeFollow,
  readClaudeFollowManifest,
  removeClaudeFollow,
  writeClaudeFollowFlag,
  writeClaudeFollowManifest,
  type ClaudeFollowContext,
  type ClaudeFollowGate,
} from "./claude-follow";
import { syncClaudeFollowConfig } from "./config-sync";
import { adoptFollowingTerminalLogin } from "./login-adoption";
import { importMcpOAuthGrants } from "./mcp-oauth-import";
import { mendSharedFileLinks } from "./shared-state";

/**
 * The running side of claude-follow (claude-follow.ts has the design): the
 * setting, the boot pass, the flag kept in step with every account change,
 * and while the feature is on, the periodic pass that keeps the live slot
 * and the user's own Claude home in step.
 */

const PASS_INTERVAL_MS = 30_000;

const log = (message: string): void => console.warn(message);

let gatePromise: Promise<ClaudeFollowGate> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let passTimer: NodeJS.Timeout | null = null;
let passRun: Promise<void> | null = null;
let lastSyncStamp = "";

function gate(): Promise<ClaudeFollowGate> {
  gatePromise ??= claudeFollowGate({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    env: process.env,
    codaraHome: codaraHomeDir(),
    fromAppImage: runsFromAppImage({
      appImage: process.env.APPIMAGE,
      appDir: process.env.APPDIR,
      execPath: process.execPath,
    }),
    isTransientPath,
  });
  return gatePromise;
}

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => undefined);
  return run;
}

function loginShell(): string | null {
  try {
    return userInfo().shell ?? null;
  } catch {
    return null;
  }
}

function context(): ClaudeFollowContext {
  return {
    codaraHome: codaraHomeDir(),
    homeDir: homedir(),
    platform: process.platform,
    env: process.env,
    loginShell: loginShell(),
    liveConfigDir: nativeClaudeProfileStore.liveConfigDir,
    log,
  };
}

function userClaudeHome(): ClaudeLiveHome {
  return {
    configDir: nativeClaudeProfileStore.personalConfigDir,
    configDirEnv: nativeClaudeProfileStore.personalConfigDirEnv,
    homeDir: homedir(),
  };
}

async function claudeDefaultIsManaged(): Promise<boolean> {
  const snapshot = await nativeClaudeProfileStore.snapshot().catch(() => null);
  return !!snapshot && isClaudeCliManagedProfileId(snapshot.defaultProfileId);
}

function enabledSetting(): boolean {
  return getPreferenceCached("claudeFollowsActiveAccount") !== false;
}

// ---------------------------------------------------------------------------
// The periodic pass.

async function fileStamp(file: string): Promise<string> {
  const stats = await fs.stat(file).catch(() => null);
  return stats ? `${stats.mtimeMs}:${stats.size}` : "-";
}

async function runPass(): Promise<void> {
  const paths = claudeFollowPaths(codaraHomeDir());
  const manifest = await readClaudeFollowManifest(paths);
  if (!manifest) return;
  const store = nativeClaudeProfileStore;

  if (!manifest.mcpOAuthImported) {
    const user = userClaudeHome();
    const { added } = await importMcpOAuthGrants({
      userConfigDir: user.configDir,
      userConfigDirEnv: user.configDirEnv,
      liveConfigDir: store.liveConfigDir,
    }).catch((error: unknown) => {
      log(`[claude-follow] MCP sign-ins were not copied: ${error instanceof Error ? error.message : String(error)}`);
      return { added: null as string[] | null };
    });
    if (added !== null) {
      await writeClaudeFollowManifest(paths, { ...manifest, mcpOAuthImported: true });
      if (added.length > 0) log(`[claude-follow] copied ${added.length} MCP sign-in(s) into the live slot`);
    }
  }

  // Stat first: most passes find neither file changed and read nothing.
  const user = userClaudeHome();
  const live = claudeLiveHome(store);
  const configFiles = await Promise.all([claudeGlobalConfigFile(user), claudeGlobalConfigFile(live)]);
  const stampNow = async () => (await Promise.all(configFiles.map(fileStamp))).join("|");
  if ((await stampNow()) !== lastSyncStamp) {
    await syncClaudeFollowConfig({ userHome: user, liveHome: live, baseFile: paths.syncBaseFile, log });
    // The stamp after the sync's own writes, so they do not trigger another pass.
    lastSyncStamp = await stampNow();
  }

  if (process.platform === "win32") {
    await mendSharedFileLinks({
      root: store.rootDir,
      home: store.liveConfigDir,
      backupDir: join(paths.backupDir, "shared-files"),
      log,
    });
  }
}

function pass(): Promise<void> {
  passRun ??= runPass()
    .catch((error: unknown) => {
      log(`[claude-follow] pass failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      passRun = null;
    });
  return passRun;
}

async function adoptTerminalLogin(): Promise<void> {
  const store = nativeClaudeProfileStore;
  const outcome = await adoptFollowingTerminalLogin({
    slot: store,
    createCliProfile: async (label) => (await store.createProfile({ label })).profile.id,
    deleteCliProfile: async (cliProfileId) => {
      await store.deleteProfile(cliProfileId);
    },
    rowForIdentity: (fingerprint) => anthropicAccounts.rowForIdentity(fingerprint),
    shareCliLogin: (cliProfileId) => anthropicAccounts.shareLogin({ cliProfileId }),
    useAccount: (coraProfileId) => anthropicAccounts.useAccount(coraProfileId),
    log,
  });
  if (outcome !== "none") log(`[claude-follow] terminal sign-in: ${outcome}`);
}

function startRunning(): void {
  setClaudeServersSyncedTwoWay(true);
  setClaudeForeignLoginHandler(adoptTerminalLogin);
  if (!passTimer) {
    passTimer = setInterval(() => void pass(), PASS_INTERVAL_MS);
    passTimer.unref?.();
  }
  void pass();
}

function stopRunning(): void {
  if (passTimer) clearInterval(passTimer);
  passTimer = null;
  setClaudeForeignLoginHandler(null);
  setClaudeServersSyncedTwoWay(false);
}

// ---------------------------------------------------------------------------
// Turning it on and off.

async function refreshFlagLocked(): Promise<void> {
  const paths = claudeFollowPaths(codaraHomeDir());
  const manifest = await readClaudeFollowManifest(paths);
  await writeClaudeFollowFlag(paths, !!manifest && (await claudeDefaultIsManaged()));
}

async function applyLocked(enabled: boolean): Promise<void> {
  const allowed = await gate();
  const ctx = context();
  const paths = claudeFollowPaths(ctx.codaraHome);
  if (enabled) {
    if (!allowed.allowed) {
      // A development build or test run adds nothing; it only keeps the
      // flag of an installed build's setup in step with its own switches.
      await refreshFlagLocked();
      return;
    }
    const report = await installClaudeFollow(ctx, allowed.appPath);
    for (const file of report.files) {
      if (file.result === "skipped" || file.result === "failed" || file.result === "changed-meanwhile") {
        log(`[claude-follow] ${file.path} left as it is: ${file.reason ?? file.result}`);
      }
    }
    await refreshFlagLocked();
    if (report.manifest && report.manifest.entries.length > 0) startRunning();
    return;
  }
  stopRunning();
  if (await readClaudeFollowManifest(paths)) {
    // What following terminals added reaches the user's own file first.
    await passRun?.catch(() => undefined);
    await syncClaudeFollowConfig({
      userHome: userClaudeHome(),
      liveHome: claudeLiveHome(nativeClaudeProfileStore),
      baseFile: paths.syncBaseFile,
      log,
    }).catch(() => undefined);
    if (process.platform === "win32") {
      await mendSharedFileLinks({
        root: nativeClaudeProfileStore.rootDir,
        home: nativeClaudeProfileStore.liveConfigDir,
        backupDir: join(paths.backupDir, "shared-files"),
        log,
      }).catch(() => undefined);
    }
  }
  const report = await removeClaudeFollow(ctx, { scanStartupFiles: allowed.allowed });
  for (const file of report.files) {
    if (file.result === "skipped" || file.result === "failed" || file.result === "changed-meanwhile") {
      log(`[claude-follow] ${file.path} still has the line: ${file.reason ?? file.result}`);
    }
  }
}

/** Boot: apply the setting once the account startup pass is done. */
export function startClaudeFollow(ready: Promise<unknown>): void {
  // Every change of the Active Claude account moves the flag with it.
  onActiveAccountsChanged(refreshClaudeFollowFlag);
  void ready
    .then(() => loadPreferences())
    .then(() => serialize(() => applyLocked(enabledSetting())))
    .catch((error: unknown) => {
      log(`[claude-follow] could not start: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/** Apply the stored setting (after a write of the preference from elsewhere). */
export function applyClaudeFollowSetting(): Promise<void> {
  return serialize(() => applyLocked(enabledSetting()));
}

/** Every change of the active account: the flag follows it. */
export function refreshClaudeFollowFlag(): Promise<void> {
  return serialize(refreshFlagLocked);
}

function displayPath(file: string): string {
  const home = homedir();
  const rel = relative(home, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return file;
  return process.platform === "win32" ? `~\\${rel}` : `~/${rel}`;
}

export async function claudeFollowStatus(): Promise<ClaudeFollowStatus> {
  await loadPreferences().catch(() => undefined);
  const allowed = await gate();
  const manifest = await readClaudeFollowManifest(claudeFollowPaths(codaraHomeDir()));
  return {
    enabled: enabledSetting(),
    available: allowed.allowed,
    files: (manifest?.entries ?? []).map((entry) => displayPath(entry.path)),
    windows: process.platform === "win32",
  };
}

export async function setClaudeFollowEnabled(enabled: boolean): Promise<ClaudeFollowStatus> {
  await setPreference("claudeFollowsActiveAccount", enabled);
  await serialize(() => applyLocked(enabled));
  return claudeFollowStatus();
}

/** Quit: a last pass so nothing a following terminal changed waits for the next start. */
export async function flushClaudeFollow(): Promise<void> {
  if (!passTimer) return;
  await pass();
}
