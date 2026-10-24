import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { claudeLiveConfigDir } from "../orchestration/claude-cli-live-login";
import { claudeFollowPaths, readClaudeFollowManifest, removeClaudeFollow } from "./claude-follow";
import { syncClaudeFollowConfig } from "./config-sync";
import { mendSharedFileLinks } from "./shared-state";

/**
 * Run by the Windows uninstaller (build/installer.nsh, customUnInstall)
 * through the app's own executable with ELECTRON_RUN_AS_NODE=1, before the
 * app's files are removed and never for an update. It takes Codara's line
 * out of every startup file, so nothing of claude-follow outlives the app.
 * Built as a self-contained script (electron.vite.config.ts), it must not
 * import electron. It never fails the uninstall: every error is swallowed
 * and it always exits 0.
 *
 * macOS and Linux have no uninstaller: there the line and the script stay
 * inert once the app is gone, since the script checks for the app first.
 */

function isInside(child: string, parent: string): boolean {
  const inner = resolve(child).toLowerCase();
  const outer = resolve(parent).toLowerCase();
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

async function main(): Promise<void> {
  const home = homedir();
  const codaraHome = resolve(process.env.CODARA_HOME_DIR?.trim() || join(home, ".codarastudio"));
  const claudeRoot = join(codaraHome, "claude-cli");
  const live = claudeLiveConfigDir(claudeRoot);
  const paths = claudeFollowPaths(codaraHome);

  if (await readClaudeFollowManifest(paths)) {
    // What following terminals changed reaches the user's own Claude home first.
    const own = process.env.CLAUDE_CONFIG_DIR?.trim();
    const userConfigDir = own && !isInside(own, codaraHome) ? resolve(own) : join(home, ".claude");
    await syncClaudeFollowConfig({
      userHome: { configDir: userConfigDir, configDirEnv: own && !isInside(own, codaraHome) ? userConfigDir : null, homeDir: home },
      liveHome: { configDir: live, configDirEnv: live, homeDir: dirname(live) },
      baseFile: paths.syncBaseFile,
    }).catch(() => undefined);
    await mendSharedFileLinks({
      root: claudeRoot,
      home: live,
      backupDir: join(paths.backupDir, "shared-files"),
    }).catch(() => undefined);
  }

  await removeClaudeFollow(
    {
      codaraHome,
      homeDir: home,
      platform: process.platform,
      env: process.env,
      loginShell: null,
      liveConfigDir: live,
    },
    { scanStartupFiles: true },
  );
}

// The uninstaller waits for this process; it never waits long.
setTimeout(() => process.exit(0), 60_000).unref();

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
