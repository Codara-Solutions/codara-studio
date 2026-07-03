import { useEffect, useRef } from "react";
import type { AppSettings } from "@shared/types";

// Reads Codara's existing OpenRouter API key from AppSettings on mount
// and keeps a ref fresh. This is the same key used by the orchestration
// manager (src/main/orchestration/openrouter-manager.ts) — DO NOT add a new
// settings field for it. The key flows: settings.json → loadSettings() →
// `settings:load` IPC → window.spark.settings.load() → here.
//
// We cannot subscribe to settings changes today (no broadcast IPC for them
// like preferences has), so the ref is hydrated once and refreshed when the
// user manually re-enters the editor pane (StrictMode dev double-mount also
// causes a re-fetch which is fine).

// Module-level memoized settings load. EditorStack mounts every open editor
// tab at once; without this each EditorPane would fire its own `settings:load`
// IPC + disk read of settings.json. The first hook to mount kicks off the
// load and every later caller awaits the very same promise — one IPC round
// trip total, regardless of how many editors are open.
let settingsPromise: Promise<AppSettings> | null = null;

function loadSettingsOnce(): Promise<AppSettings> {
  if (!settingsPromise) {
    settingsPromise = window.spark.settings.load();
  }
  return settingsPromise;
}

export function useOpenRouterKey(): { current: string } {
  const keyRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    void loadSettingsOnce()
      .then((settings) => {
        if (cancelled) return;
        keyRef.current = settings.openRouterApiKey || "";
      })
      .catch(() => {
        // Inline AI silently disables when the key is missing — no toast.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return keyRef;
}
