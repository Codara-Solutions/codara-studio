// window.spark.skillOrigins: the renderer side of src/main/skill-updates-ipc.ts
// (where each skill came from, update checks, update and rollback). An older
// main process without these channels answers as if nothing were recorded,
// until Codara restarts.

import { ipcRenderer } from "electron";
import type {
  SkillOriginStatus,
  SkillRollbackResult,
  SkillUpdateResult,
} from "@shared/skill-origins";

function missingHandler(err: unknown, channel: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(`No handler registered for '${channel}'`);
}

function invokeOr<T>(channel: string, input: unknown, fallback: T): Promise<T> {
  return ipcRenderer.invoke(channel, input).catch((err: unknown) => {
    if (missingHandler(err, channel)) return fallback;
    throw err;
  });
}

const RESTART = "Restart Codara to update skills.";

export const skillOriginsApi = {
  /** The recorded origin of every installed skill, with the last check. No network. */
  list: (): Promise<SkillOriginStatus[]> => invokeOr("skills:origins", {}, []),
  /** Asks each skill's git remote whether it moved; cached for hours unless `force`. */
  check: (force = false): Promise<SkillOriginStatus[]> => invokeOr("skills:checkUpdates", { force }, []),
  update: (dirs: string[]): Promise<SkillUpdateResult> =>
    invokeOr("skills:update", { dirs }, { ok: false, updated: [], unchanged: [], errors: [RESTART], origins: [] }),
  rollback: (dirs: string[]): Promise<SkillRollbackResult> =>
    invokeOr("skills:rollback", { dirs }, { ok: false, restored: [], errors: [RESTART], origins: [] }),
};
