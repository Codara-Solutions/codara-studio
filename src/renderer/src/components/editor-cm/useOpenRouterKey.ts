import { useEffect, useRef } from "react";

// Reads Spark Agent's existing OpenRouter API key from AppSettings on mount
// and keeps a ref fresh. This is the same key used by the orchestration
// manager (src/main/orchestration/openrouter-manager.ts) — DO NOT add a new
// settings field for it. The key flows: settings.json → loadSettings() →
// `settings:load` IPC → window.spark.settings.load() → here.
//
// We cannot subscribe to settings changes today (no broadcast IPC for them
// like preferences has), so the ref is hydrated once and refreshed when the
// user manually re-enters the editor pane (StrictMode dev double-mount also
// causes a re-fetch which is fine).
export function useOpenRouterKey(): { current: string } {
  const keyRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    void window.spark.settings
      .load()
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
