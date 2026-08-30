import { app } from "electron";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Codara stores its own user data ($HOME/.codarastudio by default) instead of
// piggybacking on Electron's userData dir. Keeps run.json, events.jsonl,
// spark-state.json, and spark-settings.json out of the Chromium-cache-filled
// userData folder. Internal file names keep the legacy spark- prefix — they
// are an on-disk contract, renaming them buys nothing (see rebrand Phase C).
const DEFAULT_DIR_NAME = ".codarastudio";
// The home immediately before this one. Unlike the older legacy homes below
// it is MOVED (renamed) into place wholesale on first boot, so everything —
// worktrees, CLI roots, auth — carries over without a copy. A symlink is left
// at the old path so absolute paths persisted elsewhere (git worktree
// registrations, `~/.codarastudio/cli/active/env.sh` lines in shell rc files,
// SPARK_HOME_DIR baked into Claude/Codex MCP configs until they self-heal)
// keep resolving.
const RENAMED_DIR_NAME = ".Codara";
// Pre-rename homes, newest first (the app was "Codara", briefly "Cora", and
// "Spark Agent" before that). Their contents are copied into the current home
// on first boot after the rename; the old dirs are left untouched as a
// backstop. ".Codara" is listed here only for the case where the rename leg
// could not run (both dirs already existed) — then it falls back to a copy.
const LEGACY_DIR_NAMES = [RENAMED_DIR_NAME, ".Cora", ".SparkAgent"];
const MIGRATION_MARKER = ".migrated";
// The per-home files/dirs worth carrying across a rename. Deliberately NOT
// copied: worktrees/ (git registers their absolute paths in the source repos —
// existing ones keep working from the old dir; new ones land here) and
// sandbox/ (recreatable scratch).
const MIGRATED_ENTRIES = [
  "spark-state.json",
  "spark-settings.json",
  "spark-preferences.json",
  "notifications.json",
  "scheduler.json",
  "runs",
  "memory",
  "prompts",
  "hooks",
  "cc-settings",
  "cc-mcp",
];

let homeDirCached: string | null = null;

// The home we use when no override is set: $HOME/.codarastudio. Exported because
// callers that must land on a DURABLE per-user path (the Claude hook script
// copy, see hook-installer.ts) need somewhere to fall back to when the
// override points at a throwaway directory.
export function defaultCodaraHome(): string {
  return path.join(os.homedir(), DEFAULT_DIR_NAME);
}

// The override is normalized the same way codaraHomeDir() in
// codara-managed-cli-roots.ts normalizes it: the value exported to panes as
// SPARK_HOME_DIR and the managed roots the shell hooks compare against by
// exact prefix must be the same bytes, or a trailing slash or a relative
// segment in a dev launch makes every shell treat the selector as user-owned
// and follow nothing.
export function codaraHome(): string {
  if (homeDirCached !== null) return homeDirCached;
  const override =
    process.env.CODARA_HOME_DIR ??
    process.env.SPARK_HOME_DIR ??
    process.env.SPARK_USER_DATA_DIR;
  homeDirCached = override && override.trim()
    ? path.resolve(override.trim())
    : defaultCodaraHome();
  return homeDirCached;
}

export function ensureCodaraHomeSync(): void {
  const dir = codaraHome();
  if (process.env.SPARK_SKIP_LEGACY_MIGRATION !== "1") renameLegacyHomeSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    // The home contains the loopback bearer token and other per-user state.
    // Tighten pre-existing homes as well as newly created directories.
    try {
      chmodSync(dir, 0o700);
    } catch (err) {
      console.warn(`[spark-home] could not set owner-only permissions on ${dir}:`, err);
    }
  }
  // Test escape hatch (e2e specs): an isolated throwaway home must stay
  // pristine — importing the machine's real legacy state (~/.SparkAgent runs,
  // run-queue) both defeats the isolation and can wedge boot replaying it.
  if (process.env.SPARK_SKIP_LEGACY_MIGRATION === "1") return;
  const marker = path.join(dir, MIGRATION_MARKER);
  if (existsSync(marker)) return;

  // Marker is only written after a clean pass — a mid-loop copy failure
  // leaves it absent so the next boot retries (migrateIfMissing skips
  // whatever already landed).
  let migrationFailed = false;

  // Leg 1: prior home dirs (~/.codarastudio, ~/.Cora, then ~/.SparkAgent — the app
  // renames). ~/.codarastudio is normally a symlink to `dir` by now (see
  // renameLegacyHomeSync) and is skipped as such.
  // Whole-content copy so runs/, prefs, and settings survive; the newest
  // legacy home wins per entry (migrateIfMissing skips anything already
  // present). Skipped when the app runs under an explicit home override that
  // IS one of the legacy dirs.
  for (const legacyName of LEGACY_DIR_NAMES) {
    try {
      const legacyHome = path.join(os.homedir(), legacyName);
      if (
        existsSync(legacyHome) &&
        !isSymlink(legacyHome) &&
        path.resolve(legacyHome) !== path.resolve(dir)
      ) {
        for (const entry of MIGRATED_ENTRIES) {
          try {
            migrateIfMissing(path.join(legacyHome, entry), path.join(dir, entry));
          } catch (err) {
            migrationFailed = true;
            console.error(`[spark-home] could not migrate ${entry} from ~/${legacyName}:`, err);
          }
        }
      }
    } catch (err) {
      console.error(`[spark-home] migration from ~/${legacyName} failed:`, err);
    }
  }

  // Leg 2: pre-.SparkAgent Electron userData (the original location).
  try {
    const legacy = app.getPath("userData");
    if (legacy && path.resolve(legacy) !== path.resolve(dir)) {
      migrateIfMissing(path.join(legacy, "spark-state.json"), path.join(dir, "spark-state.json"));
      migrateIfMissing(path.join(legacy, "spark-settings.json"), path.join(dir, "spark-settings.json"));
      migrateIfMissing(path.join(legacy, "runs"), path.join(dir, "runs"));
    }
  } catch (err) {
    console.error("[spark-home] migration from legacy userData failed:", err);
  }

  if (migrationFailed) return;
  try {
    writeFileSync(marker, new Date().toISOString(), "utf8");
  } catch (err) {
    console.error("[spark-home] failed to write migration marker:", err);
  }
}

// ~/.codarastudio → ~/.codarastudio. Runs only for the un-overridden default home,
// only when the new dir does not exist yet and the old one is a real
// directory (not the symlink we leave behind). A rename is atomic on the same
// filesystem, so a crash mid-way leaves either the old or the new layout
// intact, never a half-copied mix. If the rename itself fails (permissions,
// cross-device home), nothing is touched and the copy leg in
// ensureCodaraHomeSync picks up the durable state instead.
function renameLegacyHomeSync(dir: string): void {
  if (path.resolve(dir) !== path.resolve(defaultCodaraHome())) return;
  const oldHome = path.join(os.homedir(), RENAMED_DIR_NAME);
  if (existsSync(dir) || !existsSync(oldHome) || isSymlink(oldHome)) return;
  try {
    renameSync(oldHome, dir);
    console.log(`[spark-home] renamed ~/${RENAMED_DIR_NAME} to ~/${DEFAULT_DIR_NAME}`);
  } catch (err) {
    console.error(`[spark-home] could not rename ~/${RENAMED_DIR_NAME} to ~/${DEFAULT_DIR_NAME}:`, err);
    return;
  }
  try {
    // Junction on Windows so no elevated symlink privilege is needed.
    symlinkSync(dir, oldHome, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    console.warn(`[spark-home] could not leave a compatibility link at ~/${RENAMED_DIR_NAME}:`, err);
  }
}

function isSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function migrateIfMissing(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return;
  cpSync(from, to, { recursive: true });
}
