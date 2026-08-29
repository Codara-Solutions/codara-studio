// Tiny in-process fanout for git activity, so the automation scheduler can
// react to the SAME auto-fetch pass that already drives the renderer's
// "teammate pushed" refresh (ipc.broadcastGitRemoteUpdated calls emit here).
// Deliberately dependency-free: ipc.ts and scheduler.ts both import it
// without creating a cycle.

type RemoteUpdatedListener = (cwds: string[]) => void;

const remoteUpdatedListeners = new Set<RemoteUpdatedListener>();

export function emitGitRemoteUpdated(cwds: string[]): void {
  for (const listener of remoteUpdatedListeners) {
    try {
      listener(cwds);
    } catch (err) {
      console.warn("[git-events] remoteUpdated listener failed:", err);
    }
  }
}

export function onGitRemoteUpdated(listener: RemoteUpdatedListener): () => void {
  remoteUpdatedListeners.add(listener);
  return () => remoteUpdatedListeners.delete(listener);
}
