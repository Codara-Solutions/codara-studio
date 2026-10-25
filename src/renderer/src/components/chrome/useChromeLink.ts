import { useEffect, useState } from "react";

import type { ChromeLinkState } from "@shared/chrome-link";

/** The browser extension link's live state, or null until main answers. */
export function useChromeLink(): ChromeLinkState | null {
  const [state, setState] = useState<ChromeLinkState | null>(null);
  useEffect(() => {
    const api = window.spark?.chromeLink;
    if (!api?.state) return;
    let alive = true;
    void api.state().then((next) => {
      if (alive) setState(next);
    }).catch(() => undefined);
    const off = api.onChanged((next) => setState(next));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}
