import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "@shared/types";

// Fast mode is one global setting (AppSettings.openAiFastMode) whose only
// control now sits in the chat composer, far from the Settings dialog that
// owns App's settings object. Both surfaces go through this module so the two
// copies cannot diverge: every writer republishes what the main process
// actually saved, and every reader re-hydrates from that broadcast. Without it
// a composer flip would be silently reverted by the next Settings save, which
// still carries the whole AppSettings record.
const SETTINGS_CHANGED_EVENT = "spark:settings-changed";

let cached: AppSettings | null = null;
let inflight: Promise<AppSettings> | null = null;

function loadSettingsOnce(): Promise<AppSettings> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = window.spark.settings
      .load()
      .then((settings) => {
        cached = settings;
        return settings;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Announce the settings a writer just persisted so every reader is exact. */
export function publishSettings(settings: AppSettings): void {
  cached = settings;
  window.dispatchEvent(
    new CustomEvent<AppSettings>(SETTINGS_CHANGED_EVENT, { detail: settings }),
  );
}

export function onSettingsChanged(
  listener: (settings: AppSettings) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<AppSettings>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(SETTINGS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
}

export interface OpenAiFastModeControl {
  enabled: boolean;
  toggle: () => void;
}

/**
 * Reads and flips AppSettings.openAiFastMode. Read fail-closed: an unreadable
 * or unsaveable settings file reports OFF, because the wrong answer costs the
 * user 2x on every OpenAI token rather than merely running at normal speed.
 * The value takes effect on the next manager turn — pi-backend carries fast
 * mode in its session identity, so a flip relaunches the Pi session.
 */
export function useOpenAiFastMode(): OpenAiFastModeControl {
  const [enabled, setEnabled] = useState(cached?.openAiFastMode === true);

  useEffect(() => {
    let cancelled = false;
    void loadSettingsOnce()
      .then((settings) => {
        if (!cancelled) setEnabled(settings.openAiFastMode === true);
      })
      .catch(() => {
        // Unreadable settings stay off; the composer simply shows the toggle
        // in its muted state rather than surfacing a toast for it.
      });
    const unsubscribe = onSettingsChanged((settings) => {
      if (!cancelled) setEnabled(settings.openAiFastMode === true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const toggle = useCallback(() => {
    void (async () => {
      let current: AppSettings;
      try {
        current = await loadSettingsOnce();
      } catch {
        return;
      }
      const desired = current.openAiFastMode !== true;
      setEnabled(desired);
      try {
        const saved = await window.spark.settings.save({
          ...current,
          openAiFastMode: desired,
        });
        publishSettings(saved);
      } catch {
        setEnabled(current.openAiFastMode === true);
      }
    })();
  }, []);

  return { enabled, toggle };
}
