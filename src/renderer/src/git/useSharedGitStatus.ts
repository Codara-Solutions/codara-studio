import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitLog, GitStatus } from "@shared/types";

// Single shared git status/log poll per active workspace, extracted verbatim
// from GitPanel so the Source Control panel, the explorer's git decorations,
// and the diff tabs all read ONE source of truth instead of racing three
// independent pollers. App owns one instance and threads the result down.
//
// gitVersion bumps after every mutation this app performs — consumers with
// derived reads (open diff tabs, branch/stash sections) refetch on it.

// How often git state is re-read while the window is visible. The fs watcher
// drives most updates already — this poll is a safety net for changes the
// watcher misses (e.g. ref / index writes that bypass the worktree).
const POLL_MS = 10000;

// Cheap shallow equality on git status. Used to skip no-op setState calls so
// downstream React.memo gates actually hold, instead of being defeated by
// fresh array identities arriving every poll.
export function sameStatus(a: GitStatus | null, b: GitStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.isRepo !== b.isRepo ||
    a.branch !== b.branch ||
    a.detached !== b.detached ||
    a.upstream !== b.upstream ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.hasConflicts !== b.hasConflicts ||
    a.error !== b.error ||
    a.staged.length !== b.staged.length ||
    a.unstaged.length !== b.unstaged.length
  ) {
    return false;
  }
  for (let i = 0; i < a.staged.length; i++) {
    const x = a.staged[i];
    const y = b.staged[i];
    if (
      x.path !== y.path ||
      x.status !== y.status ||
      x.staged !== y.staged ||
      x.untracked !== y.untracked ||
      x.oldPath !== y.oldPath
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.unstaged.length; i++) {
    const x = a.unstaged[i];
    const y = b.unstaged[i];
    if (
      x.path !== y.path ||
      x.status !== y.status ||
      x.staged !== y.staged ||
      x.untracked !== y.untracked ||
      x.oldPath !== y.oldPath
    ) {
      return false;
    }
  }
  return true;
}

// Cheap shallow equality on git log. Commit shas are the identity here — if
// every row hash + ref decoration is unchanged, the graph view models can be
// reused and the memoized commit rows skip re-rendering.
function sameLog(a: GitLog | null, b: GitLog | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.isRepo !== b.isRepo || a.error !== b.error || a.rows.length !== b.rows.length) {
    return false;
  }
  for (let i = 0; i < a.rows.length; i++) {
    const x = a.rows[i];
    const y = b.rows[i];
    if (
      x.hash !== y.hash ||
      x.subject !== y.subject ||
      x.isHead !== y.isHead ||
      x.graph !== y.graph
    ) {
      return false;
    }
    const xRefs = x.refs ?? [];
    const yRefs = y.refs ?? [];
    if (xRefs.length !== yRefs.length) return false;
    for (let j = 0; j < xRefs.length; j++) {
      if (xRefs[j] !== yRefs[j]) return false;
    }
  }
  return true;
}

export interface SharedGitStatus {
  status: GitStatus | null;
  log: GitLog | null;
  loading: boolean;
  /** Error from the status/log read itself (mutation errors stay in GitPanel). */
  readError: string | null;
  /** Bumped after every mutation performed by this app. */
  gitVersion: number;
  refresh: (silent?: boolean) => Promise<void>;
  bumpVersion: () => void;
  /** refresh(true) + bumpVersion() — the standard after-mutation combo. */
  notifyChanged: () => void;
}

export function useSharedGitStatus(cwd: string | null): SharedGitStatus {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [gitVersion, setGitVersion] = useState(0);

  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const statusRef = useRef<GitStatus | null>(status);
  statusRef.current = status;
  const logRef = useRef<GitLog | null>(log);
  logRef.current = log;

  const refresh = useCallback(async (silent = false): Promise<void> => {
    const target = cwdRef.current;
    if (!target) {
      setStatus(null);
      setLog(null);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const [nextStatus, nextLog] = await Promise.all([
        window.spark.git.status(target),
        window.spark.git.log(target),
      ]);
      if (cwdRef.current !== target) return;
      // Skip the setState when nothing changed — keeps row identities stable
      // so memoized children don't re-render on every poll tick.
      if (!sameStatus(statusRef.current, nextStatus)) setStatus(nextStatus);
      if (!sameLog(logRef.current, nextLog)) setLog(nextLog);
      setReadError(null);
    } catch (err) {
      if (cwdRef.current === target) setReadError((err as Error).message);
    } finally {
      if (cwdRef.current === target) setLoading(false);
    }
  }, []);

  // Initial load + full reset whenever the workspace changes.
  useEffect(() => {
    setStatus(null);
    setLog(null);
    setReadError(null);
    if (cwd) void refresh(false);
  }, [cwd, refresh]);

  // Lightweight poll so the state tracks changes made from the terminal or
  // another tool. Skipped while the window is hidden.
  useEffect(() => {
    if (!cwd) return undefined;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh(true);
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [cwd, refresh]);

  // Snappier than the poll when the file watcher (driven by the file tree) is
  // live — a debounced refresh on any change under the workspace root.
  useEffect(() => {
    if (!cwd) return undefined;
    let timer: number | null = null;
    const unsub = window.spark.fs.onChanged((event) => {
      if (event.root !== cwd) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(true), 300);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsub();
    };
  }, [cwd, refresh]);

  // Background auto-fetch moved remote refs for this root (ahead/behind, the
  // remote branches in the graph). The fs watcher ignores .git, so without
  // this push the change would only land on the next 10s poll tick.
  useEffect(() => {
    if (!cwd) return undefined;
    const onRemoteUpdated = window.spark.git.onRemoteUpdated;
    if (!onRemoteUpdated) return undefined;
    return onRemoteUpdated((payload) => {
      if (payload.cwds.includes(cwd)) void refresh(true);
    });
  }, [cwd, refresh]);

  const bumpVersion = useCallback(() => setGitVersion((v) => v + 1), []);
  const notifyChanged = useCallback(() => {
    void refresh(true);
    setGitVersion((v) => v + 1);
  }, [refresh]);

  // Stable object identity while nothing changed — consumers (WorkspaceRail)
  // are React.memo'd and would otherwise re-render on every App render.
  return useMemo(
    () => ({ status, log, loading, readError, gitVersion, refresh, bumpVersion, notifyChanged }),
    [status, log, loading, readError, gitVersion, refresh, bumpVersion, notifyChanged],
  );
}
