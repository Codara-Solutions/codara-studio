import { useEffect, useState, useSyncExternalStore } from "react";

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

// The connect card shows a pairing's code with Allow and Deny itself. While
// one is on screen the floating prompt stays away: one Allow, not two.
let cardsOnScreen = 0;
const cardListeners = new Set<() => void>();
const subscribeCards = (listener: () => void) => {
  cardListeners.add(listener);
  return () => cardListeners.delete(listener);
};

/** Mark a connect card as on screen while the calling component is mounted. */
export function useConnectCardOnScreen(): void {
  useEffect(() => {
    cardsOnScreen += 1;
    cardListeners.forEach((listener) => listener());
    return () => {
      cardsOnScreen -= 1;
      cardListeners.forEach((listener) => listener());
    };
  }, []);
}

/** Whether a connect card is on screen. */
export function useConnectCardShown(): boolean {
  return useSyncExternalStore(subscribeCards, () => cardsOnScreen > 0);
}
