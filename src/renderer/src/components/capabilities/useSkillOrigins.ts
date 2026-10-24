import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClaudePluginSkillList, SkillOriginStatus } from "@shared/skill-origins";
import { errorText, failure, ok, type StatusMessage } from "./model";
import { checkSummary, indexOrigins, lastCheckedAt, skillDirKey } from "./skill-origins";

// What the Skills section needs to show origins and run updates.
export interface SkillOriginsView {
  index: ReadonlyMap<string, SkillOriginStatus>;
  // Skill folders with an update or rollback in flight.
  busy: ReadonlySet<string>;
  checking: boolean;
  canCheck: boolean;
  lastCheckedAt: string | null;
  // Skills (by name) whose source moved.
  updateCount: number;
  onCheck: () => void;
  onUpdate: (statuses: SkillOriginStatus[], name: string) => void;
  onRollback: (statuses: SkillOriginStatus[], name: string) => void;
}

/**
 * Origin records, the background update check and the plugin skill list for
 * the Capability Center. The check starts when the dialog opens; the main
 * process answers from its cache for hours, so reopening costs nothing.
 * `inventory` is the asset list: when it changes (an import, a removal, a
 * copy to a CLI) the records are read again.
 */
export function useSkillOrigins(input: {
  cwd: string | null;
  inventory: unknown;
  onStatus: (status: StatusMessage | null) => void;
  onChanged: () => void;
}): { view: SkillOriginsView; plugins: ClaudePluginSkillList | null } {
  const [statuses, setStatuses] = useState<SkillOriginStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [plugins, setPlugins] = useState<ClaudePluginSkillList | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The list effect below starts a check, which is defined further down.
  const checkRef = useRef<(force: boolean) => void>(() => undefined);

  useEffect(() => {
    void window.spark.skillOrigins
      .list()
      .then((next) => {
        if (!alive.current) return;
        setStatuses(next);
        // A skill just imported from git gets its first answer now; the
        // cached ones cost nothing.
        if (next.some((status) => status.origin.kind === "git" && status.state === "unchecked")) checkRef.current(false);
      })
      .catch(() => undefined);
  }, [input.inventory]);

  useEffect(() => {
    let cancelled = false;
    void window.spark.skillOrigins
      .pluginSkills(input.cwd)
      .then((next) => {
        if (!cancelled) setPlugins(next);
      })
      .catch(() => {
        if (!cancelled) setPlugins(null);
      });
    return () => {
      cancelled = true;
    };
  }, [input.cwd, input.inventory]);

  const check = useCallback((force: boolean) => {
    setChecking(true);
    void window.spark.skillOrigins
      .check(force)
      .then((next) => {
        if (!alive.current) return;
        setStatuses(next);
        if (force) {
          const summary = checkSummary(next);
          latest.current.onStatus(summary.ok ? ok(summary.text) : failure(summary.text));
        }
      })
      .catch((err) => {
        if (alive.current && force) latest.current.onStatus(failure(`Could not check for updates: ${errorText(err)}`));
      })
      .finally(() => {
        if (alive.current) setChecking(false);
      });
  }, []);

  checkRef.current = check;
  useEffect(() => {
    check(false);
  }, [check]);

  const markBusy = useCallback((dirs: string[], on: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      for (const dir of dirs) {
        if (on) next.add(skillDirKey(dir));
        else next.delete(skillDirKey(dir));
      }
      return next;
    });
  }, []);

  const update = useCallback((targets: SkillOriginStatus[], name: string) => {
    const dirs = targets.map((status) => status.skillDir);
    if (dirs.length === 0) return;
    markBusy(dirs, true);
    latest.current.onStatus(null);
    void window.spark.skillOrigins
      .update(dirs)
      .then((result) => {
        if (!alive.current) return;
        if (result.origins.length > 0 || result.ok) setStatuses(result.origins);
        if (result.updated.length > 0 && result.errors.length === 0) {
          latest.current.onStatus(
            ok(`Updated ${name}. New Cora chats and workers load the new version; Roll back restores the one it replaced.`),
          );
        } else if (result.errors.length === 0) {
          latest.current.onStatus(ok(`${name} already matches its repository. Nothing was changed.`));
        } else {
          const done = result.updated.length > 0 ? `Updated ${result.updated.length} of ${dirs.length} copies of ${name}. ` : "";
          latest.current.onStatus(failure(`${done}Could not update ${name}: ${result.errors.join(" ")}`));
        }
        latest.current.onChanged();
      })
      .catch((err) => {
        if (alive.current) latest.current.onStatus(failure(`Could not update ${name}: ${errorText(err)}`));
      })
      .finally(() => {
        if (alive.current) markBusy(dirs, false);
      });
  }, [markBusy]);

  const rollback = useCallback((targets: SkillOriginStatus[], name: string) => {
    const dirs = targets.map((status) => status.skillDir);
    if (dirs.length === 0) return;
    markBusy(dirs, true);
    latest.current.onStatus(null);
    void window.spark.skillOrigins
      .rollback(dirs)
      .then((result) => {
        if (!alive.current) return;
        if (result.origins.length > 0 || result.ok) setStatuses(result.origins);
        latest.current.onStatus(
          result.errors.length === 0
            ? ok(`Restored the version of ${name} from before its last update.`)
            : failure(`Could not roll back ${name}: ${result.errors.join(" ")}`),
        );
        latest.current.onChanged();
      })
      .catch((err) => {
        if (alive.current) latest.current.onStatus(failure(`Could not roll back ${name}: ${errorText(err)}`));
      })
      .finally(() => {
        if (alive.current) markBusy(dirs, false);
      });
  }, [markBusy]);

  const view = useMemo<SkillOriginsView>(() => {
    const git = statuses.filter((status) => status.origin.kind === "git");
    return {
      index: indexOrigins(statuses),
      busy,
      checking,
      canCheck: git.length > 0,
      lastCheckedAt: lastCheckedAt(git),
      updateCount: new Set(git.filter((status) => status.state === "update-available").map((status) => status.name)).size,
      onCheck: () => check(true),
      onUpdate: update,
      onRollback: rollback,
    };
  }, [statuses, busy, checking, check, update, rollback]);

  return { view, plugins };
}
