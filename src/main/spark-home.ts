import { app } from "electron";
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Codara stores its own user data ($HOME/.Codara by default) instead of
// piggybacking on Electron's userData dir. Keeps run.json, events.jsonl,
// spark-state.json, and spark-settings.json out of the Chromium-cache-filled
// userData folder. Internal file names keep the legacy spark- prefix — they
// are an on-disk contract, renaming them buys nothing (see rebrand Phase C).
const DEFAULT_DIR_NAME = ".Codara";
// Pre-rename homes, newest first (the app was briefly "Cora", and "Spark
// Agent" before that). Their contents are copied into ~/.Codara on first boot
// after the rename; the old dirs are left untouched as a backstop.
const LEGACY_DIR_NAMES = [".Cora", ".SparkAgent"];
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
  "run-queue.json",
  "runs",
  "memory",
  "prompts",
  "hooks",
  "cc-settings",
  "cc-mcp",
];

let homeDirCached: string | null = null;

// The home we use when no override is set: $HOME/.Codara. Exported because
// callers that must land on a DURABLE per-user path (the Claude hook script
// copy, see hook-installer.ts) need somewhere to fall back to when the
// override points at a throwaway directory.
export function defaultSparkHome(): string {
  return path.join(os.homedir(), DEFAULT_DIR_NAME);
}

export function sparkHome(): string {
  if (homeDirCached !== null) return homeDirCached;
  const override =
    process.env.CODARA_HOME_DIR ??
    process.env.SPARK_HOME_DIR ??
    process.env.SPARK_USER_DATA_DIR;
  homeDirCached = override && override.trim()
    ? override
    : defaultSparkHome();
  return homeDirCached;
}

export function ensureSparkHomeSync(): void {
  const dir = sparkHome();
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

  // Leg 1: prior home dirs (~/.Cora, then ~/.SparkAgent — the app renames).
  // Whole-content copy so runs/, prefs, and settings survive; the newest
  // legacy home wins per entry (migrateIfMissing skips anything already
  // present). Skipped when the app runs under an explicit home override that
  // IS one of the legacy dirs.
  for (const legacyName of LEGACY_DIR_NAMES) {
    try {
      const legacyHome = path.join(os.homedir(), legacyName);
      if (existsSync(legacyHome) && path.resolve(legacyHome) !== path.resolve(dir)) {
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

function migrateIfMissing(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return;
  cpSync(from, to, { recursive: true });
}
