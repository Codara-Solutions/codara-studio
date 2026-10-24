import { useCallback, useEffect, useState } from "react";
import type { KeepAwakeMode, KeepAwakeStatus } from "@shared/keep-awake";
import { recordFeatureUse } from "../feature-tips/feature-usage";

// The live keep-awake status from main, plus the two writes the UI makes.
// The writes go through preferences like every other setting; main reacts to
// the change and pushes the new status back, which replaces the optimistic
// one set here.

export interface UseKeepAwakeResult {
  status: KeepAwakeStatus | null;
  setMode: (mode: KeepAwakeMode) => void;
  setLidClosed: (on: boolean) => void;
  refresh: () => void;
}

export function useKeepAwake(): UseKeepAwakeResult {
  const [status, setStatus] = useState<KeepAwakeStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const off = window.spark.keepAwake.onChanged((next) => {
      if (alive) setStatus(next);
    });
    void window.spark.keepAwake
      .status()
      .then((next) => {
        // A pushed status that arrived first is newer than this reply.
        if (alive && next) setStatus((current) => current ?? next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const refresh = useCallback(() => {
    void window.spark.keepAwake
      .status()
      .then((next) => {
        if (next) setStatus(next);
      })
      .catch(() => undefined);
  }, []);

  const setMode = useCallback((mode: KeepAwakeMode) => {
    recordFeatureUse("keep-awake");
    setStatus((current) => (current ? { ...current, mode } : current));
    void window.spark.preferences.set("keepAwakeMode", mode).catch(() => undefined);
  }, []);

  const setLidClosed = useCallback((on: boolean) => {
    setStatus((current) => (current ? { ...current, lid: { ...current.lid, enabled: on } } : current));
    void window.spark.preferences.set("keepAwakeLidClosed", on).catch(() => undefined);
  }, []);

  return { status, setMode, setLidClosed, refresh };
}
