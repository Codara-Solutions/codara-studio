import { useEffect, useMemo, useState } from "react";
import { buildRailFamily, buildRailTree, railMergeState } from "@shared/rail-tree";
import { isRemotePath } from "@shared/remote";
import { buildSourceLanes, type LaneChanges, type LaneInput, type SourceLanes } from "@shared/source-lanes";
import type { Workspace } from "@shared/types";
import { railRowMerged, type WorktreeRailExternal, type WorktreeRailState } from "@shared/worktree-cleanup";
import { usePullRequestWatches } from "../../../git/pullRequestWatchStore";
import { useAgentLinesOf } from "../../workspace-status/agentLinesStore";

// The lanes of the active workspace's project: the project's own checkout and
// every worktree of it, wherever the user is standing. Agents land on the
// lane they work in by the rail's own rule (buildRailFamily), so the rail and
// this panel can never disagree on who works where.

const POLL_MS = 15_000;

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

  useEffect(() => {
    if (!own.visible || !cwdsKey) return;
    const wanted = cwdsKey.split("\n").filter((cwd) => !isRemotePath(cwd));
    if (wanted.length === 0) return;
    let cancelled = false;
    const read = () => {
      if (document.hidden) return;
      void window.spark.git.laneChanges(wanted).then(
        (next) => {
          if (!cancelled) setChanges(next);
        },
        () => undefined,
      );
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [cwdsKey, own.visible, own.version]);

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
