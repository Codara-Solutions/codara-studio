import { app } from "electron";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Spark stores its own user data ($HOME/.SparkAgent by default) instead of
// piggybacking on Electron's userData dir. Keeps run.json, events.jsonl,
// spark-state.json, and spark-settings.json out of %APPDATA%\Spark Agent\
// (which is otherwise full of Chromium caches).
const DEFAULT_DIR_NAME = ".SparkAgent";
const MIGRATION_MARKER = ".migrated";

let homeDirCached: string | null = null;

export function sparkHome(): string {
  if (homeDirCached !== null) return homeDirCached;
  const override = process.env.SPARK_HOME_DIR ?? process.env.SPARK_USER_DATA_DIR;
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
