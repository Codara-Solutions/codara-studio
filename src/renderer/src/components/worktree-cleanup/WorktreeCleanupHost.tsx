import React, { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { WorktreeCleanupApprovalRequest } from "@shared/worktree-cleanup-agent";
import { OPEN_WORKTREE_CLEANUP_EVENT, type OpenWorktreeCleanupDetail } from "./open-worktree-cleanup";

// Always mounted, a few bytes: the screen itself loads on first open, and
// so does the dialog an agent's removal request (codara_worktree_cleanup)
// opens. Requests wait their turn, one dialog at a time.
const WorktreeCleanupDialog = lazy(() => import("./WorktreeCleanupDialog"));
const WorktreeCleanupApproval = lazy(() => import("./WorktreeCleanupApproval"));

export default function WorktreeCleanupHost(): React.ReactElement | null {
  const [open, setOpen] = useState<OpenWorktreeCleanupDetail | null>(null);
  const [approvals, setApprovals] = useState<WorktreeCleanupApprovalRequest[]>([]);

  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<OpenWorktreeCleanupDetail> | undefined>).detail;
      // A second open while the screen is up keeps what the user is doing.
      setOpen((current) => current ?? { workspaceId: detail?.workspaceId ?? null });
    };
    window.addEventListener(OPEN_WORKTREE_CLEANUP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WORKTREE_CLEANUP_EVENT, onOpen);
  }, []);

  useEffect(() => {
    const api = window.spark?.worktreeCleanup;
    if (!api?.onApproval) return;
    const stopRequests = api.onApproval((request) => setApprovals((current) => [...current, request]));
    const stopClosed = api.onApprovalClosed(({ id }) =>
      setApprovals((current) => current.filter((request) => request.id !== id)),
    );
    return () => {
      stopRequests();
      stopClosed();
    };
  }, []);

  const close = useCallback(() => setOpen(null), []);
  const approval = approvals[0] ?? null;
  const approvalDone = useCallback(
    () => setApprovals((current) => current.filter((request) => request.id !== approval?.id)),
    [approval?.id],
  );
  if (!open && !approval) return null;
  return (
    <Suspense fallback={null}>
      {open ? <WorktreeCleanupDialog workspaceId={open.workspaceId} onClose={close} /> : null}
      {approval ? <WorktreeCleanupApproval key={approval.id} request={approval} onDone={approvalDone} /> : null}
    </Suspense>
  );
}
