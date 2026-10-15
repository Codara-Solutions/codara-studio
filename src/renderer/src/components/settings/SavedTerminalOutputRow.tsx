// Settings > Terminal > Output history: how much terminal output Codara has
// saved on disk, and a two-click way to delete all of it. Saved output can
// hold anything a terminal printed, secrets included.

import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "@shared/worktree-cleanup";
import { SettingRow } from "./SettingsPrimitives";

interface Usage {
  files: number;
  bytes: number;
}

export function describeSavedOutput(usage: Usage | null): string {
  if (!usage) return "Checking…";
  if (usage.files === 0) return "Nothing saved right now.";
  return `${formatBytes(usage.bytes)} saved from ${usage.files} ${usage.files === 1 ? "terminal" : "terminals"}.`;
}

export default function SavedTerminalOutputRow() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await window.spark.terminalScrollback.usage();
      if (alive.current) setUsage(next);
    } catch {
      if (alive.current) setUsage({ files: 0, bytes: 0 });
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const clear = async () => {
    setArmed(false);
    setBusy(true);
    setFailed(false);
    try {
      await window.spark.terminalScrollback.clear();
    } catch {
      if (alive.current) setFailed(true);
    }
    if (alive.current) setBusy(false);
    await refresh();
  };

  const empty = usage !== null && usage.files === 0;
  return (
    <SettingRow
      title="Clear saved terminal output"
      anchor="Clear saved terminal output"
      desc={
        <>
          Codara keeps what your terminals printed, secrets included, on this computer for up to 30 days and up to 64 MB,
          so panes can show it after a restart. Clearing deletes it all now.{" "}
          <span data-testid="saved-terminal-output-usage">
            {failed ? "Could not clear it. Try again." : describeSavedOutput(usage)}
          </span>
        </>
      }
      control={
        <span
          className="st-row-actions"
          onMouseLeave={() => setArmed(false)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setArmed(false);
          }}
        >
          {armed ? (
            <button type="button" className="spark-btn is-danger" disabled={busy} onClick={() => void clear()}>
              Confirm clear
            </button>
          ) : (
            <button
              type="button"
              className="spark-btn"
              disabled={busy || empty}
              onClick={() => setArmed(true)}
            >
              Clear saved output
            </button>
          )}
        </span>
      }
    />
  );
}
