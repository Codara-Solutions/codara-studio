import { useEffect, useMemo, useRef, useState } from "react";
import { buildRailFamily, buildRailTree, railMergeState } from "@shared/rail-tree";
import { isRemotePath } from "@shared/remote";
import { buildSourceLanes, type LaneChanges, type LaneInput, type SourceLanes } from "@shared/source-lanes";
import type { Workspace } from "@shared/types";
import { railRowMerged, type WorktreeRailExternal, type WorktreeRailState } from "@shared/worktree-cleanup";
import { usePullRequestWatches } from "../../../git/pullRequestWatchStore";
import { useAgentLinesOf } from "../../workspace-status/agentLinesStore";
import { useGitRefresh } from "../../../git/gitRefreshClock";

// The lanes of the active workspace's project: the project's own checkout and
// every worktree of it, wherever the user is standing. Agents land on the
// lane they work in by the rail's own rule (buildRailFamily), so the rail and
// this panel can never disagree on who works where.

// Lanes are read when the panel opens, when the window regains focus, when a
// lane's git state moves (the shared clock, gitRefreshClock.ts), when a file
// changes in the user's own checkout, and otherwise at most this often: edits
// another lane has not committed or staged show by then.
const SAFETY_MS = 5 * 60_000;
const OWN_EDIT_DEBOUNCE_MS = 3_000;

export interface SourceLanesContext {
  workspaces: readonly Workspace[];
  branchByWorkspaceId?: Readonly<Record<string, string | null>>;
  worktreeByWorkspaceId?: Readonly<Record<string, WorktreeRailState>>;
  worktreeStatesLoaded?: boolean;
  externalWorktrees?: readonly WorktreeRailExternal[];
}

function trim(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

export function useSourceLanes(
  context: SourceLanesContext,
  workspace: Workspace | null,
  own: { branch: string | null; visible: boolean; version: number },
): SourceLanes {
  const { workspaces, branchByWorkspaceId, worktreeByWorkspaceId, worktreeStatesLoaded, externalWorktrees } = context;
  const { project, worktrees } = useMemo(() => {
    if (!workspace) return { project: null, worktrees: [] as Workspace[] };
    // An SSH workspace's lanes would each be a round trip; it shows its own checkout.
    if (workspace.remote) return { project: workspace, worktrees: [] as Workspace[] };
    const tree = buildRailTree(workspaces);
    const byId = new Map(workspaces.map((item) => [item.id, item]));
    const top = byId.get(tree.parentOf.get(workspace.id) ?? "") ?? workspace;
    return {
      project: top,
      worktrees: (tree.childrenOf.get(top.id) ?? []).flatMap((id) => byId.get(id) ?? []),
    };
  }, [workspace, workspaces]);

  const ids = useMemo(() => (project ? [project.id, ...worktrees.map((item) => item.id)] : []), [project, worktrees]);
  const lineLists = useAgentLinesOf(ids);
  const watches = usePullRequestWatches();

  const external = useMemo(() => {
    if (!project) return [];
    const rows = new Set(workspaces.map((item) => trim(item.cwd)));
    return (externalWorktrees ?? []).filter((entry) => entry.projectId === project.id && !rows.has(trim(entry.path)));
  }, [externalWorktrees, project, workspaces]);

  const cwds = useMemo(
    () => [
      ...(project ? [project.cwd] : []),
      ...worktrees.filter((item) => !worktreeByWorkspaceId?.[item.id]?.missing).map((item) => item.cwd),
      ...external.map((entry) => entry.path),
    ],
    [project, worktrees, external, worktreeByWorkspaceId],
  );
  const cwdsKey = cwds.join("\n");
  const [changes, setChanges] = useState<Record<string, LaneChanges>>({});
  const wanted = useMemo(
    () => (own.visible && cwdsKey ? cwdsKey.split("\n").filter((cwd) => !isRemotePath(cwd)) : []),
    [cwdsKey, own.visible],
  );
  const lastReadAt = useRef(0);
  const readRef = useRef<((only?: readonly string[]) => void) | null>(null);

  useEffect(() => {
    if (wanted.length === 0) return;
    let cancelled = false;
    // `only`: the lanes to re-read; the others keep what they showed.
    const read = (only?: readonly string[]) => {
      if (document.hidden) return;
      const lanes = only ? wanted.filter((cwd) => only.includes(cwd)) : wanted;
      if (lanes.length === 0) return;
      if (!only) lastReadAt.current = Date.now();
      void window.spark.git.laneChanges(lanes).then(
        (next) => {
          if (cancelled) return;
          setChanges((prev) => {
            if (!only) return next;
            const merged: Record<string, LaneChanges> = {};
            for (const cwd of wanted) {
              const value = next[cwd] ?? prev[cwd];
              if (value) merged[cwd] = value;
            }
            return merged;
          });
        },
        () => undefined,
      );
    };
    readRef.current = read;
    read();
    // The user's own checkout: an edit there shows without waiting.
    const ownCwd = workspace?.cwd;
    let editTimer: number | null = null;
    const unsubscribe = ownCwd && wanted.includes(ownCwd)
      ? window.spark.fs.onChanged((event) => {
          if (event.root !== ownCwd) return;
          if (editTimer !== null) window.clearTimeout(editTimer);
          editTimer = window.setTimeout(() => read([ownCwd]), OWN_EDIT_DEBOUNCE_MS);
        })
      : null;
    return () => {
      cancelled = true;
      if (readRef.current === read) readRef.current = null;
      if (editTimer !== null) window.clearTimeout(editTimer);
      unsubscribe?.();
    };
  }, [wanted, own.version, workspace?.cwd]);

  useGitRefresh(wanted, true, (changed, reason) => {
    if (reason === "focus" || Date.now() - lastReadAt.current >= SAFETY_MS) readRef.current?.();
    else if (changed.length > 0) readRef.current?.(changed);
  });

  return useMemo(() => {
    if (!project || !workspace) return buildSourceLanes([]);
    const family = buildRailFamily({
      projectLines: lineLists[0] ?? [],
      children: worktrees.map((item, index) => {
        const creator = item.copyBranch?.createdBy;
        const state = worktreeByWorkspaceId?.[item.id];
        return {
          workspaceId: item.id,
          lines: lineLists[index + 1] ?? [],
          creatorPaneId: creator?.kind === "agent" ? creator.paneId : undefined,
          createdAt: item.copyBranch?.createdAt,
          merged: railMergeState(state ? railRowMerged(state) : undefined, {
            remote: Boolean(item.remote),
            loaded: worktreeStatesLoaded ?? false,
          }),
        };
      }),
    });
    const agentsOf = new Map([...family.active, ...family.merged].map((child) => [child.workspaceId, child.agents]));
    const pullRequestOf = (id: string) => {
      const entry = watches[id];
      return entry?.watching ? entry.pullRequest : null;
    };
    const inputs: LaneInput[] = [project, ...worktrees].map((item) => {
      const state = worktreeByWorkspaceId?.[item.id];
      const isOwn = item.id === workspace.id;
      return {
        id: item.id,
        workspaceId: item.id,
        path: item.cwd,
        branch: isOwn
          ? own.branch
          : (branchByWorkspaceId?.[item.id] ?? item.copyBranch?.branch ?? state?.branch ?? null),
        own: isOwn,
        agents: item.id === project.id ? family.own : (agentsOf.get(item.id) ?? []),
        creator: item.copyBranch?.createdBy?.kind === "agent" ? (item.copyBranch.createdBy.client ?? null) : null,
        pullRequest: pullRequestOf(item.id),
        merged: item.id !== project.id && railRowMerged(state),
        missing: state?.missing === true,
        changes: changes[item.cwd] ?? null,
      };
    });
    for (const entry of external) {
      inputs.push({
        id: `path:${entry.path}`,
        workspaceId: null,
        path: entry.path,
        branch: entry.branch,
        own: false,
        agents: [],
        pullRequest: null,
        merged: false,
        missing: false,
        changes: changes[entry.path] ?? null,
      });
    }
    return buildSourceLanes(inputs);
  }, [
    project,
    workspace,
    worktrees,
    external,
    lineLists,
    watches,
    changes,
    own.branch,
    branchByWorkspaceId,
    worktreeByWorkspaceId,
    worktreeStatesLoaded,
  ]);
}
