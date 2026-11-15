// One listener on a main-to-renderer channel, returning its unsubscribe. The
// preload is size-budgeted (scripts/bundle-budgets.json): written out by hand
// each subscription costs the bundle its boilerplate again.

import { ipcRenderer } from "electron";

export function subscribe<T>(channel: string): (listener: (payload: T) => void) => () => void {
  return (listener) => {
    const wrapped = (_event: unknown, payload: T): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  };
}

export function subscribeSignal(channel: string): (listener: () => void) => () => void {
  return (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  };
}
