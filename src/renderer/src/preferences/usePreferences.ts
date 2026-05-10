import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PREFERENCES,
  type AppPreferences,
  type PrefKey,
} from "@shared/types";

// usePreferences() — small React hook that hydrates the preferences object
// once on mount and subscribes to cross-window updates broadcast by the main
// process. Both the main window and the settings window mount this hook, so
// flipping a toggle in Settings reflects everywhere.
//
// Kept dependency-free (no zustand) to avoid pulling a new package; the
// settings surface is small. If complexity grows, swap to a store.

type SetPreferenceFn = <K extends PrefKey>(
  key: K,
  value: AppPreferences[K],
) => Promise<void>;

export interface UsePreferencesResult {
  preferences: AppPreferences;
  hydrated: boolean;
  setPreference: SetPreferenceFn;
}

export function usePreferences(): UsePreferencesResult {
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.spark.preferences.load().then((p) => {
      if (!alive) return;
      setPreferences(p);
      setHydrated(true);
    });
    const off = window.spark.preferences.onChanged((change) => {
      setPreferences((current) => ({ ...current, [change.key]: change.value }));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const setPreference = useCallback<SetPreferenceFn>(async (key, value) => {
    // Optimistic update — the broadcast event will reconcile if the write is
    // rejected/normalized differently downstream.
    setPreferences((current) => ({ ...current, [key]: value }));
    await window.spark.preferences.set(key, value);
  }, []);

  return { preferences, hydrated, setPreference };
}
