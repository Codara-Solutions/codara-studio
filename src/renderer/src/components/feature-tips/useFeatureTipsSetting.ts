import { useCallback, useEffect, useState } from "react";
import type { FeatureTipsState } from "@shared/feature-tips";

// The Settings rows for feature tips: whether tips may appear, and a way to
// see the ones already shown again. Follows changes made from a tip's own
// "Don't show tips" while Settings is open.

export interface FeatureTipsSetting {
  hydrated: boolean;
  enabled: boolean;
  /** Tips shown so far. */
  seen: number;
  setEnabled: (next: boolean) => void;
  reset: () => void;
}

export function useFeatureTipsSetting(): FeatureTipsSetting {
  const [state, setState] = useState<FeatureTipsState | null>(null);

  useEffect(() => {
    const api = window.spark.featureTips;
    if (!api) return;
    let alive = true;
    void api
      .load()
      .then((boot) => {
        if (alive) setState(boot.state);
      })
      .catch(() => undefined);
    const off = api.onChanged((next) => setState(next));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setState((current) => (current ? { ...current, enabled: next } : current));
    void window.spark.featureTips.setEnabled(next).then(setState, () => undefined);
  }, []);

  const reset = useCallback(() => {
    void window.spark.featureTips.reset().then(setState, () => undefined);
  }, []);

  return {
    hydrated: state !== null,
    enabled: state?.enabled ?? true,
    seen: state ? Object.keys(state.tips).length : 0,
    setEnabled,
    reset,
  };
}
