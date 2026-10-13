// The page dialogs (alert, confirm, prompt) main asked this window to show,
// by browser tab. previewRpc's dialog_show op resolves with the user's answer;
// dialog_hide closes one main answered another way (an agent, the policy).

import { useSyncExternalStore } from "react";

export interface PageDialogView {
  id: string;
  tabId: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt: string;
  url: string;
  /** When the tab's policy answers it if nobody does (ISO), or null. */
  autoAt: string | null;
}

export type PageDialogAnswer = { accept: boolean; promptText?: string } | null;

const open = new Map<string, { view: PageDialogView; resolve: (answer: PageDialogAnswer) => void }>();
const listeners = new Set<() => void>();
let snapshot: PageDialogView[] = [];

function changed(): void {
  snapshot = [...open.values()].map((entry) => entry.view);
  for (const listener of listeners) listener();
}

export function showPageDialog(view: PageDialogView): Promise<PageDialogAnswer> {
  if (!view || typeof view.id !== "string" || typeof view.tabId !== "string") return Promise.resolve(null);
  return new Promise((resolve) => {
    open.get(view.id)?.resolve(null);
    open.set(view.id, { view, resolve });
    changed();
  });
}

export function closePageDialog(id: string): void {
  const entry = open.get(id);
  if (!entry) return;
  open.delete(id);
  entry.resolve(null);
  changed();
}

export function answerPageDialog(id: string, answer: { accept: boolean; promptText?: string }): void {
  const entry = open.get(id);
  if (!entry) return;
  open.delete(id);
  entry.resolve(answer);
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The oldest dialog open on a tab: the page shows one at a time. */
export function usePageDialog(tabId: string | undefined): PageDialogView | null {
  const all = useSyncExternalStore(subscribe, () => snapshot);
  if (!tabId) return null;
  return all.find((view) => view.tabId === tabId) ?? null;
}
