import { app } from "electron";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Cora stores its own user data ($HOME/.Cora by default) instead of
// piggybacking on Electron's userData dir. Keeps run.json, events.jsonl,
// spark-state.json, and spark-settings.json out of the Chromium-cache-filled
// userData folder. Internal file names keep the legacy spark- prefix — they
// are an on-disk contract, renaming them buys nothing (see rebrand Phase C).
const DEFAULT_DIR_NAME = ".Cora";
// Pre-rename home (app was Spark Agent). Its contents are copied into ~/.Cora
// on first boot after the rename; the old dir is left untouched as a backstop.
const LEGACY_DIR_NAME = ".SparkAgent";
const MIGRATION_MARKER = ".migrated";

let homeDirCached: string | null = null;

export function sparkHome(): string {
  if (homeDirCached !== null) return homeDirCached;
  const override =
    process.env.CORA_HOME_DIR ??
    process.env.SPARK_HOME_DIR ??
    process.env.SPARK_USER_DATA_DIR;
  homeDirCached = override && override.trim()
    ? override
    : path.join(os.homedir(), DEFAULT_DIR_NAME);
  return homeDirCached;
}

export function ensureSparkHomeSync(): void {
  const dir = sparkHome();
  mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, MIGRATION_MARKER);
  if (existsSync(marker)) return;

  // Marker is only written after a clean pass — a mid-loop copy failure
  // leaves it absent so the next boot retries (migrateIfMissing skips
  // whatever already landed).
  let migrationFailed = false;

  // Leg 1: ~/.SparkAgent → ~/.Cora (the app rename). Whole-content copy so
  // runs/, prefs, and settings survive; skipped when the app runs under an
  // explicit home override that IS the legacy dir.
  try {
    const legacyHome = path.join(os.homedir(), LEGACY_DIR_NAME);
    if (existsSync(legacyHome) && path.resolve(legacyHome) !== path.resolve(dir)) {
      for (const entry of [
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
      ]) {
        try {
          migrateIfMissing(path.join(legacyHome, entry), path.join(dir, entry));
        } catch (err) {
          migrationFailed = true;
          console.error(`[spark-home] could not migrate ${entry} from ~/.SparkAgent:`, err);
        }
      }
      // Deliberately NOT copied: worktrees/ (git registers their absolute
      // paths in the source repos — existing ones keep working from the old
      // dir; new ones land here) and sandbox/ (recreatable scratch).
    }
  } catch (err) {
    console.error("[spark-home] migration from ~/.SparkAgent failed:", err);
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
