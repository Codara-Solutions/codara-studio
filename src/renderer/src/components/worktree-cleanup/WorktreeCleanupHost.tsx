import React, { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { OPEN_WORKTREE_CLEANUP_EVENT, type OpenWorktreeCleanupDetail } from "./open-worktree-cleanup";

// Always mounted, a few bytes: the screen itself loads on first open.
const WorktreeCleanupDialog = lazy(() => import("./WorktreeCleanupDialog"));

export default function WorktreeCleanupHost(): React.ReactElement | null {
  const [open, setOpen] = useState<OpenWorktreeCleanupDetail | null>(null);

  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<OpenWorktreeCleanupDetail> | undefined>).detail;
      // A second open while the screen is up keeps what the user is doing.
      setOpen((current) => current ?? { workspaceId: detail?.workspaceId ?? null });
    };
    window.addEventListener(OPEN_WORKTREE_CLEANUP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WORKTREE_CLEANUP_EVENT, onOpen);
  }, []);

  const close = useCallback(() => setOpen(null), []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <WorktreeCleanupDialog workspaceId={open.workspaceId} onClose={close} />
    </Suspense>
  );
}
