import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { ChatBackendKind, FsEntry, GitFileChange, Workspace, WorkspaceGroup } from "@shared/types";
import type { GitHubWorkQueueItem } from "@shared/github";
import { WORKSPACE_COLORS } from "@shared/workspace-colors";
import type { SharedGitStatus } from "../git/useSharedGitStatus";
import type { ChatStatusTone } from "./chat/timeline";
import { statusToneColor } from "./chat/timeline";
import { PlusIcon } from "./icons";
import FileTree from "./FileTree";
import GitPanel from "./git/GitPanel";
import AnchoredMenu from "./chat/composer/AnchoredMenu";
import {
  PANEL_HEADER_H,
  PANEL_SECTION_KEYS,
  sectionSlotStyles,
  type PanelSectionKey,
  type PanelSide,
} from "../panels/usePanelLayout";
import ResizeHandle from "../panels/ResizeHandle";
import SectionHeader, { type SectionHeaderDragProps } from "../panels/SectionHeader";

const PANEL_SECTION_MIME = "application/x-codara-panel-section";
const WORKSPACE_ROW_MIME = "application/x-codara-workspace-row";
const WORKSPACE_GROUP_MIME = "application/x-codara-workspace-group";
// Below this width the full tracked uppercase label no longer fits beside the
// workspace count and the fixed 20px "+" action, so the header swaps in "WS".
// Derived from the SectionHeader band rather than guessed: 12px row padding
// (5 + 7) + 14px drag slot + 16px chevron slot + 88px for "WORKSPACES"
// (10px/700 Inter at 0.15em tracking, measured in Chromium) + 12px for the
// two-digit count + 4 × 7px inner gaps + 6px gap to the action cluster + one
// 20px action ≈ 196px. Rounded to 200 for a few px of guard against wider
// fallback fonts. Was 250 back when the band carried four 20px actions.
const COMPACT_WORKSPACE_HEADER_WIDTH = 200;

const SECTION_LABELS: Record<PanelSectionKey, string> = {
  workspaces: "Workspaces",
  graph: "Source Control",
  explorer: "Explorer",
};

interface RailProps {
  side: PanelSide;
  sections: PanelSectionKey[];
  draggingSection: PanelSectionKey | null;
  workspaces: Workspace[];
  workspaceGroups: WorkspaceGroup[];
  workspaceRailOrder: string[];
  activeId: string | null;
  editingId: string | null;
  width: number;
  activeWorkspace: Workspace | null;
  // Per-workspace status-tone rollup (the max-attention tone across that
  // workspace's runs). Drives the small status dot on each rail row. App
  // passes a memoized object so this prop stays referentially stable and the
  // rail's React.memo keeps holding off unrelated re-renders.
  toneByWorkspaceId?: Record<string, ChatStatusTone | null>;
  // Per-workspace "something inside is working" flag (a live run, a loom pass,
  // or a manual terminal agent mid-turn). Spins the workspace color dot. App
  // passes a memoized object so this prop stays referentially stable like
  // toneByWorkspaceId.
  workingByWorkspaceId?: Record<string, boolean>;
  // The first section's share when exactly two sections are stacked here.
  split: number;
  collapsed: Record<PanelSectionKey, boolean>;
  activePath: string | null;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onChange: (id: string, patch: Partial<Workspace>) => void;
  onPreviewColor: (id: string, color: string) => void;
  onCreateCopyBranch: (id: string) => void;
  onDelete: (id: string) => void;
  onMoveWorkspace: (
    workspaceId: string,
    groupId: string | null,
    beforeWorkspaceId: string | null,
  ) => void;
  onCreateWorkspaceGroup: () => string;
  onChangeWorkspaceGroup: (id: string, patch: Partial<WorkspaceGroup>) => void;
  onReorderWorkspaceRailItem: (id: string, beforeItemId: string | null) => void;
  onDeleteWorkspaceGroup: (id: string) => void;
  onCloseEditor: () => void;
  onCreate: () => void;
  // Opens the SSH connect dialog to add a remote (VPS) workspace.
  onCreateRemote: () => void;
  onSplitChange: (ratio: number) => void;
  onToggleSection: (section: PanelSectionKey) => void;
  onMoveSection: (section: PanelSectionKey, side: PanelSide, index: number) => void;
  onSectionDragStart: (section: PanelSectionKey) => void;
  onSectionDragEnd: () => void;
  onOpenGitHubQueueItem: (item: GitHubWorkQueueItem) => Promise<void>;
  onOpenFile: (absolutePath: string) => void;
  onOpenFileEntry: (entry: FsEntry, options?: { preview?: boolean }) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: (oldPath: string, entry: FsEntry) => void;
  onRunPlan: (entry: FsEntry, backend?: ChatBackendKind) => void;
  // Shared git status (owned by App) — feeds the Source Control panel and
  // the explorer's changed-file decorations from one poll.
  git: SharedGitStatus;
  onOpenDiffTab: (file: GitFileChange) => void;
  activeDiffTarget: { path: string; staged: boolean } | null;
  // Explorer context-menu "Open Changes" for a changed file (absolute path).
  onOpenDiffForPath: (absolutePath: string) => void;
}

// Memoized: App hoists every prop to a stable reference (the `workspaces`
// array changes only on a real workspace mutation; `onActivate`/`onEdit`/
// `onChange`/`onDelete`/`onCloseEditor`/`onCreate` are all useCallback). So
// the rail skips re-renders driven by unrelated App state — most importantly
// the live `--accent` color drag, which previously repainted the whole rail.
/**
 * Which workspaces point at a folder that is not on disk right now.
 *
 * Only LOCAL workspaces are checked. An SSH workspace's cwd is a virtual
 * `ssh://<host>/...` path that never exists locally, so testing it would mark
 * every remote workspace missing; a copy-branch worktree is a real local
 * directory and is checked normally.
 *
 * Re-checked when the workspace set changes and on window focus, which is when
 * a folder the user just moved in Finder would have changed underneath us. The
 * result is presentation-only — nothing here removes or rewrites a workspace.
 */
function useMissingWorkspaces(workspaces: Workspace[]): Set<string> {
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const localKey = workspaces
    .filter((workspace) => !workspace.remote)
    .map((workspace) => `${workspace.id}\u0000${workspace.cwd}`)
    .join("\u0001");

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const local = workspaces.filter((workspace) => !workspace.remote);
      const results = await Promise.all(
        local.map(async (workspace) => {
          try {
            const result = await window.spark.fs.pathExists({ target: workspace.cwd });
            return result?.exists === false ? workspace.id : null;
          } catch {
            // An errored probe is not evidence of absence — leave the row alone
            // rather than striking through a workspace that is probably fine.
            return null;
          }
        }),
      );
      if (!alive) return;
      const next = new Set(results.filter((id): id is string => id !== null));
      setMissing((current) =>
        current.size === next.size && [...next].every((id) => current.has(id)) ? current : next,
      );
    };
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
    // localKey collapses the id+cwd pairs so this re-runs when a workspace is
    // added, removed, or repointed — but not on every unrelated rail render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localKey]);

  return missing;
}

function WorkspaceRail(props: RailProps) {
  const {
    side,
    sections,
    draggingSection,
    workspaces,
    width,
    onCreate,
    split,
    collapsed,
    onSplitChange,
    onToggleSection,
    onMoveSection,
    onSectionDragStart,
    onSectionDragEnd,
  } = props;
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const missingWorkspaceIds = useMissingWorkspaces(workspaces);
  // Workspace rows can be reordered within a folder or dropped onto another
  // folder. The transfer payload makes the gesture work even when Workspaces
  // is rendered in the opposite rail; local state is only visual feedback.
  const [wsDragId, setWsDragId] = useState<string | null>(null);
  const wsDragIdRef = useRef<string | null>(null);
  const [wsDropMarker, setWsDropMarker] = useState<{
    workspaceId: string;
    position: "before" | "after";
  } | null>(null);
  const [groupDragId, setGroupDragId] = useState<string | null>(null);
  const groupDragIdRef = useRef<string | null>(null);
  const [railDropIndex, setRailDropIndex] = useState<number | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createBtnRef = useRef<HTMLButtonElement>(null);
  // The workspaces scroll container — passed to the rail's AnchoredMenus as
  // their flip boundary so a menu near the section's end opens upward instead
  // of overhanging the section stacked below (Source Control / Explorer).
  const wsScrollRef = useRef<HTMLDivElement | null>(null);
  const [railCtxMenu, setRailCtxMenu] = useState<{
    x: number;
    y: number;
    // The scroll container the right-click landed in — the menu's anchor
    // region, so scroll-close can test "did the scrolled thing move ME".
    anchor: HTMLElement;
  } | null>(null);

  // Section-divider drag: snapshot the split ratio and the body height at
  // drag start, then translate a pointer delta into a ratio delta. The hook's
  // setter clamps, so an over-drag is harmless.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const splitAtDragStart = useRef(split);
  const bodyHeightAtDragStart = useRef(1);

  const accent = props.activeWorkspace?.color || "var(--accent)";
  const workspaceGroupIds = new Set(props.workspaceGroups.map((group) => group.id));
  const unfiledWorkspaces = workspaces.filter((workspace) =>
    !workspace.groupId || !workspaceGroupIds.has(workspace.groupId));
  const unfiledWorkspaceById = new Map(unfiledWorkspaces.map((workspace) => [workspace.id, workspace]));
  const workspaceGroupById = new Map(props.workspaceGroups.map((group) => [group.id, group]));
  const eligibleRailIds = new Set([...unfiledWorkspaceById.keys(), ...workspaceGroupById.keys()]);
  const topLevelItemIds: string[] = [];
  const seenRailIds = new Set<string>();
  for (const id of props.workspaceRailOrder) {
    if (!eligibleRailIds.has(id) || seenRailIds.has(id)) continue;
    seenRailIds.add(id);
    topLevelItemIds.push(id);
  }
  for (const id of eligibleRailIds) {
    if (!seenRailIds.has(id)) topLevelItemIds.push(id);
  }
  const compactWorkspaceHeader = width < COMPACT_WORKSPACE_HEADER_WIDTH;
  const slots = sectionStackStyles(sections, split, collapsed);
  const canResizePair = sections.length === 2;

  const canAcceptPanelSection = (event: React.DragEvent): boolean => {
    if (draggingSection) return true;
    return Array.from(event.dataTransfer.types).includes(PANEL_SECTION_MIME);
  };

  const sectionFromEvent = (event: React.DragEvent): PanelSectionKey | null => {
    const raw = event.dataTransfer.getData(PANEL_SECTION_MIME) || draggingSection || "";
    return isPanelSectionKey(raw) ? raw : null;
  };

  const markDropAt = (event: React.DragEvent, index: number) => {
    if (!canAcceptPanelSection(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropIndex(index);
  };

  const dropAt = (event: React.DragEvent, index: number) => {
    if (!canAcceptPanelSection(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const section = sectionFromEvent(event);
    if (section) onMoveSection(section, side, index);
    setDropIndex(null);
    onSectionDragEnd();
  };

  const headerDrag = (section: PanelSectionKey) => ({
    draggable: true,
    dragging: draggingSection === section,
    onDragStart: (event: React.DragEvent<HTMLButtonElement>) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(PANEL_SECTION_MIME, section);
      event.dataTransfer.setData("text/plain", SECTION_LABELS[section]);
      onSectionDragStart(section);
    },
    onDragEnd: () => {
      setDropIndex(null);
      onSectionDragEnd();
    },
  });

  const isWorkspaceDrag = (event: React.DragEvent): boolean => {
    if (draggingSection) return false;
    if (
      groupDragIdRef.current !== null ||
      Array.from(event.dataTransfer.types).includes(WORKSPACE_GROUP_MIME)
    ) {
      return false;
    }
    return wsDragIdRef.current !== null || Array.from(event.dataTransfer.types).some((type) =>
      type === WORKSPACE_ROW_MIME || type === "text/plain");
  };

  const isWorkspaceGroupDrag = (event: React.DragEvent): boolean => {
    if (draggingSection || wsDragIdRef.current !== null) return false;
    return groupDragIdRef.current !== null ||
      Array.from(event.dataTransfer.types).includes(WORKSPACE_GROUP_MIME);
  };

  const draggedWorkspaceGroupId = (event: React.DragEvent): string | null => {
    const candidate = event.dataTransfer.getData(WORKSPACE_GROUP_MIME) || groupDragIdRef.current;
    return candidate && props.workspaceGroups.some((group) => group.id === candidate)
      ? candidate
      : null;
  };

  const draggedWorkspaceId = (event: React.DragEvent): string | null => {
    for (const candidate of [
      event.dataTransfer.getData(WORKSPACE_ROW_MIME),
      event.dataTransfer.getData("text/plain"),
      wsDragIdRef.current,
    ]) {
      if (candidate && workspaces.some((workspace) => workspace.id === candidate)) return candidate;
    }
    return null;
  };

  const clearWorkspaceDrag = () => {
    wsDragIdRef.current = null;
    setWsDragId(null);
    setWsDropMarker(null);
    setRailDropIndex(null);
  };

  const clearWorkspaceGroupDrag = () => {
    groupDragIdRef.current = null;
    setGroupDragId(null);
    setRailDropIndex(null);
  };

  // Safety net: dragend is delivered to the drag SOURCE row, and a row that
  // unmounts mid-drag (a folder popover closing, a row re-parenting between
  // group and top level) never receives it — wedging the dimmed "dragging"
  // ghost on that row indefinitely. While any rail drag is live, also listen
  // at the window so every way a drag can end clears the visual state.
  useEffect(() => {
    if (wsDragId === null && groupDragId === null) return undefined;
    const end = () => {
      clearWorkspaceDrag();
      clearWorkspaceGroupDrag();
    };
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
    // The clear helpers only touch stable refs/setters — ids are the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsDragId, groupDragId]);

  const markRailDropAt = (event: React.DragEvent, index: number) => {
    if (!isWorkspaceDrag(event) && !isWorkspaceGroupDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setRailDropIndex(index);
  };

  const dropRailItemAt = (event: React.DragEvent, index: number) => {
    if (!isWorkspaceDrag(event) && !isWorkspaceGroupDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const beforeItemId = topLevelItemIds[index] ?? null;
    const workspaceId = draggedWorkspaceId(event);
    if (workspaceId) {
      props.onMoveWorkspace(workspaceId, null, null);
      props.onReorderWorkspaceRailItem(workspaceId, beforeItemId);
      clearWorkspaceDrag();
      return;
    }
    const groupId = draggedWorkspaceGroupId(event);
    if (groupId) props.onReorderWorkspaceRailItem(groupId, beforeItemId);
    clearWorkspaceGroupDrag();
  };

  const renderWorkspaceRows = (
    items: Workspace[],
    groupId: string | null,
    topLevel = false,
  ): React.ReactNode =>
    items.map((w, index) => (
      <React.Fragment key={w.id}>
        {wsDropMarker?.workspaceId === w.id && wsDropMarker.position === "before" && (
          <RowDropIndicator accent={accent} />
        )}
        <WorkspaceRow
          ws={w}
          active={w.id === props.activeId}
          editing={w.id === props.editingId}
          dragging={wsDragId === w.id}
          tone={props.toneByWorkspaceId?.[w.id] ?? null}
          working={props.workingByWorkspaceId?.[w.id] ?? false}
          missing={missingWorkspaceIds.has(w.id)}
          folderColorManaged={groupId !== null}
          menuBoundaryRef={wsScrollRef}
          onActivate={() => props.onActivate(w.id)}
          onEdit={() => props.onEdit(w.id)}
          onChange={(patch) => props.onChange(w.id, patch)}
          onPreviewColor={(color) => props.onPreviewColor(w.id, color)}
          onCloseEditor={props.onCloseEditor}
          onCreateCopyBranch={() => props.onCreateCopyBranch(w.id)}
          onDelete={() => props.onDelete(w.id)}
          onRowDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(WORKSPACE_ROW_MIME, w.id);
            // text/plain is a compatibility transport for WebDriver/native
            // drag implementations that discard custom MIME payloads.
            event.dataTransfer.setData("text/plain", w.id);
            wsDragIdRef.current = w.id;
            setWsDragId(w.id);
          }}
          onRowDragOver={(event) => {
            if (topLevel && isWorkspaceGroupDrag(event)) {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              const targetIndex = topLevelItemIds.indexOf(w.id);
              setWsDropMarker(null);
              setRailDropIndex(
                event.clientY < rect.top + rect.height / 2
                  ? targetIndex
                  : targetIndex + 1,
              );
              return;
            }
            if (!isWorkspaceDrag(event)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            setWsDropMarker({
              workspaceId: w.id,
              position: event.clientY < rect.top + rect.height / 2 ? "before" : "after",
            });
          }}
          onRowDrop={(event) => {
            if (topLevel && isWorkspaceGroupDrag(event)) {
              event.preventDefault();
              event.stopPropagation();
              const sourceId = draggedWorkspaceGroupId(event);
              if (sourceId) {
                const rect = event.currentTarget.getBoundingClientRect();
                const targetIndex = topLevelItemIds.indexOf(w.id);
                const beforeItemId = event.clientY < rect.top + rect.height / 2
                  ? w.id
                  : topLevelItemIds[targetIndex + 1] ?? null;
                props.onReorderWorkspaceRailItem(sourceId, beforeItemId);
              }
              clearWorkspaceGroupDrag();
              return;
            }
            if (!isWorkspaceDrag(event)) return;
            event.preventDefault();
            event.stopPropagation();
            const sourceId = draggedWorkspaceId(event);
            if (!sourceId) return clearWorkspaceDrag();
            const rect = event.currentTarget.getBoundingClientRect();
            if (topLevel) {
              const targetIndex = topLevelItemIds.indexOf(w.id);
              const beforeItemId = event.clientY < rect.top + rect.height / 2
                ? w.id
                : topLevelItemIds[targetIndex + 1] ?? null;
              props.onMoveWorkspace(sourceId, null, null);
              props.onReorderWorkspaceRailItem(sourceId, beforeItemId);
              clearWorkspaceDrag();
              return;
            }
            const before = event.clientY < rect.top + rect.height / 2
              ? w.id
              : items[index + 1]?.id ?? null;
            props.onMoveWorkspace(sourceId, groupId, before);
            clearWorkspaceDrag();
          }}
          onRowDragEnd={clearWorkspaceDrag}
        />
        {wsDropMarker?.workspaceId === w.id && wsDropMarker.position === "after" && (
          <RowDropIndicator accent={accent} />
        )}
      </React.Fragment>
    ));

  const renderSection = (section: PanelSectionKey): React.ReactNode => {
    switch (section) {
      case "workspaces":
        return (
          <>
            <SectionHeader
              label="Workspaces"
              displayLabel={compactWorkspaceHeader ? "WS" : undefined}
              count={workspaces.length}
              collapsed={collapsed.workspaces}
              onToggleCollapse={() => onToggleSection("workspaces")}
              {...headerDrag("workspaces")}
              actions={
                <>
                  <RailIconButton
                    ref={createBtnRef}
                    title="New…"
                    onClick={() => setCreateMenuOpen((o) => !o)}
                  >
                    <PlusIcon size={11} />
                  </RailIconButton>
                  <AnchoredMenu
                    anchorRef={createBtnRef}
                    open={createMenuOpen}
                    onClose={() => setCreateMenuOpen(false)}
                    className="spark-menu"
                    role="menu"
                    ariaLabel="Create"
                    placement="below"
                    boundaryRef={wsScrollRef}
                    align="end"
                  >
                    <div style={{ minWidth: 200, padding: 4, display: "grid", gap: 2 }}>
                      <RowMenuItem
                        label="New workspace…"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          onCreate();
                        }}
                      />
                      <RowMenuItem
                        label="New folder"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          setEditingGroupId(props.onCreateWorkspaceGroup());
                        }}
                      />
                      <RowMenuItem
                        label="New remote workspace (SSH)…"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          props.onCreateRemote();
                        }}
                      />
                    </div>
                  </AnchoredMenu>
                </>
              }
            />
            {!collapsed.workspaces && (
              <div
                ref={wsScrollRef}
                style={{ flex: 1, overflow: "auto", minHeight: 0, padding: "6px 8px 10px" }}
                onContextMenu={(event) => {
                  // Blank space only — rows and folders keep their "…" menus.
                  if (event.target !== event.currentTarget) return;
                  event.preventDefault();
                  setRailCtxMenu({
                    x: event.clientX,
                    y: event.clientY,
                    anchor: event.currentTarget,
                  });
                }}
                onDragOver={(event) => {
                  if (!isWorkspaceDrag(event)) return;
                  if (event.target === event.currentTarget) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                    setWsDropMarker(null);
                  }
                }}
                onDrop={(event) => {
                  if (!isWorkspaceDrag(event) || event.target !== event.currentTarget) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const sourceId = draggedWorkspaceId(event);
                  if (sourceId) props.onMoveWorkspace(sourceId, null, null);
                  clearWorkspaceDrag();
                }}
              >
                {workspaces.length === 0 && props.workspaceGroups.length === 0 && (
                  <EmptyState onCreate={onCreate} />
                )}
                {topLevelItemIds.map((itemId, itemIndex) => {
                  const workspace = unfiledWorkspaceById.get(itemId);
                  const group = workspaceGroupById.get(itemId);
                  if (!workspace && !group) return null;
                  const members = group
                    ? workspaces.filter((candidate) => candidate.groupId === group.id)
                    : [];
                  return (
                    <React.Fragment key={itemId}>
                      <RailItemDropZone
                        index={itemIndex}
                        active={railDropIndex === itemIndex}
                        accent={accent}
                        onDragOver={(event) => markRailDropAt(event, itemIndex)}
                        onDrop={(event) => dropRailItemAt(event, itemIndex)}
                      />
                      {workspace
                        ? renderWorkspaceRows([workspace], null, true)
                        : group ? (
                          <WorkspaceFolder
                            group={group}
                            name={group.name}
                            count={members.length}
                            accent={group.color ?? members[0]?.color ?? accent}
                            editing={editingGroupId === group.id}
                            dragging={groupDragId === group.id}
                            menuBoundaryRef={wsScrollRef}
                            isWorkspaceDrag={isWorkspaceDrag}
                            isWorkspaceGroupDrag={isWorkspaceGroupDrag}
                            onGroupDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData(WORKSPACE_GROUP_MIME, group.id);
                              groupDragIdRef.current = group.id;
                              setGroupDragId(group.id);
                            }}
                            onGroupDragOver={(event) => {
                              const rect = event.currentTarget.getBoundingClientRect();
                              setRailDropIndex(
                                event.clientY < rect.top + rect.height / 2
                                  ? itemIndex
                                  : itemIndex + 1,
                              );
                            }}
                            onGroupDrop={(event) => {
                              const sourceId = draggedWorkspaceGroupId(event);
                              if (sourceId) {
                                const rect = event.currentTarget.getBoundingClientRect();
                                const insertAt = event.clientY < rect.top + rect.height / 2
                                  ? itemIndex
                                  : itemIndex + 1;
                                props.onReorderWorkspaceRailItem(
                                  sourceId,
                                  topLevelItemIds[insertAt] ?? null,
                                );
                              }
                              clearWorkspaceGroupDrag();
                            }}
                            onGroupDragEnd={clearWorkspaceGroupDrag}
                            onToggle={() => props.onChangeWorkspaceGroup(group.id, { collapsed: !group.collapsed })}
                            onRename={(name) => {
                              props.onChangeWorkspaceGroup(group.id, { name });
                              setEditingGroupId(null);
                            }}
                            onChangeColor={(color) => {
                              props.onChangeWorkspaceGroup(group.id, { color });
                            }}
                            onStartRename={() => setEditingGroupId(group.id)}
                            onCancelRename={() => setEditingGroupId(null)}
                            onDelete={() => {
                              props.onDeleteWorkspaceGroup(group.id);
                              setEditingGroupId(null);
                            }}
                            onDropWorkspace={(event) => {
                              const sourceId = draggedWorkspaceId(event);
                              if (sourceId) props.onMoveWorkspace(sourceId, group.id, null);
                              clearWorkspaceDrag();
                            }}
                          >
                            {!group.collapsed && renderWorkspaceRows(members, group.id)}
                          </WorkspaceFolder>
                        ) : null}
                    </React.Fragment>
                  );
                })}
                {topLevelItemIds.length > 0 && (
                  <RailItemDropZone
                    index={topLevelItemIds.length}
                    active={railDropIndex === topLevelItemIds.length}
                    accent={accent}
                    onDragOver={(event) => markRailDropAt(event, topLevelItemIds.length)}
                    onDrop={(event) => dropRailItemAt(event, topLevelItemIds.length)}
                  />
                )}
              </div>
            )}
            {railCtxMenu && (
              <RailContextMenu
                x={railCtxMenu.x}
                y={railCtxMenu.y}
                anchor={railCtxMenu.anchor}
                onClose={() => setRailCtxMenu(null)}
              >
                <RowMenuItem
                  label="New workspace…"
                  onClick={() => {
                    setRailCtxMenu(null);
                    onCreate();
                  }}
                />
                <RowMenuItem
                  label="New folder"
                  onClick={() => {
                    setRailCtxMenu(null);
                    setEditingGroupId(props.onCreateWorkspaceGroup());
                  }}
                />
              </RailContextMenu>
            )}
          </>
        );
      case "graph":
        return (
          <GitPanel
            cwd={props.activeWorkspace?.cwd ?? null}
            workspace={props.activeWorkspace}
            collapsed={collapsed.graph}
            onToggleCollapse={() => onToggleSection("graph")}
            headerDrag={headerDrag("graph")}
            onOpenGitHubQueueItem={props.onOpenGitHubQueueItem}
            git={props.git}
            onOpenDiffTab={props.onOpenDiffTab}
            activeDiffTarget={props.activeDiffTarget}
          />
        );
      case "explorer": {
        const cwd = props.activeWorkspace?.cwd ?? null;
        if (!cwd) {
          return (
            <>
              <SectionHeader
                label="Explorer"
                collapsed={collapsed.explorer}
                onToggleCollapse={() => onToggleSection("explorer")}
                {...headerDrag("explorer")}
              />
              {!collapsed.explorer && (
                <div style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 11 }}>
                  No active workspace.
                </div>
              )}
            </>
          );
        }
        return (
          <FileTree
            // Remount on workspace switch so Virtuoso scroll/cache state and any
            // half-applied in-place tree mutation are fully reset; the reload
            // effect already resets internal state, this just guarantees no
            // stale scroll or partial mutation survives a fast switch.
            key={cwd}
            cwd={cwd}
            activePath={props.activePath}
            onOpenFile={props.onOpenFileEntry}
            onDeleteFile={props.onDeleteFile}
            onRenameFile={props.onRenameFile}
            onRunPlan={props.onRunPlan}
            gitStatus={props.git.status}
            onOpenChanges={props.onOpenDiffForPath}
            collapsed={collapsed.explorer}
            onToggleCollapse={() => onToggleSection("explorer")}
            headerDrag={headerDrag("explorer")}
          />
        );
      }
    }
  };

  return (
    <aside
      onDragOver={(event) => {
        if (sections.length === 0 || event.currentTarget === event.target) {
          markDropAt(event, sections.length);
        }
      }}
      onDrop={(event) => dropAt(event, sections.length)}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setDropIndex(null);
      }}
      style={{
        width,
        flex: `0 0 ${width}px`,
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        ref={bodyRef}
        style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        {sections.length === 0 && (
          <EmptyPanelDropTarget active={draggingSection !== null} accent={accent} />
        )}

        {sections.map((section, index) => (
          <React.Fragment key={section}>
            {dropIndex === index && <PanelDropIndicator accent={accent} />}
            <section
              onDragOver={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const insertIndex = event.clientY < rect.top + rect.height / 2 ? index : index + 1;
                markDropAt(event, insertIndex);
              }}
              onDrop={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const insertIndex = event.clientY < rect.top + rect.height / 2 ? index : index + 1;
                dropAt(event, insertIndex);
              }}
              style={{
                ...slots[index],
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {renderSection(section)}
            </section>

            {index < sections.length - 1 && (
              <ResizeHandle
                orientation="row"
                disabled={
                  !canResizePair ||
                  collapsed[sections[0]] ||
                  collapsed[sections[1]]
                }
                accent={accent}
                ariaLabel={`Resize ${SECTION_LABELS[sections[0]]} and ${SECTION_LABELS[sections[1]]}`}
                onResizeStart={() => {
                  splitAtDragStart.current = split;
                  bodyHeightAtDragStart.current = bodyRef.current?.clientHeight ?? 1;
                }}
                onResize={(delta) => {
                  onSplitChange(splitAtDragStart.current + delta / bodyHeightAtDragStart.current);
                }}
              />
            )}
          </React.Fragment>
        ))}
        {dropIndex === sections.length && <PanelDropIndicator accent={accent} />}
      </div>
    </aside>
  );
}

export default React.memo(WorkspaceRail);

function isPanelSectionKey(value: string): value is PanelSectionKey {
  return PANEL_SECTION_KEYS.includes(value as PanelSectionKey);
}

function sectionStackStyles(
  sections: PanelSectionKey[],
  split: number,
  collapsed: Record<PanelSectionKey, boolean>,
): CSSProperties[] {
  const collapsedSlot: CSSProperties = { flex: `0 0 ${PANEL_HEADER_H}px`, minHeight: 0 };
  const fillSlot: CSSProperties = { flex: "1 1 0", minHeight: 0 };
  if (sections.length === 0) return [];
  if (sections.length === 1) return [collapsed[sections[0]] ? collapsedSlot : fillSlot];
  if (sections.length === 2) {
    return sectionSlotStyles(split, collapsed[sections[0]], collapsed[sections[1]]);
  }
  return sections.map((section) => (collapsed[section] ? collapsedSlot : fillSlot));
}

function WorkspaceFolder({
  group,
  name,
  count,
  accent,
  editing = false,
  dragging = false,
  menuBoundaryRef,
  isWorkspaceDrag,
  isWorkspaceGroupDrag,
  onDropWorkspace,
  onGroupDragStart,
  onGroupDragOver,
  onGroupDrop,
  onGroupDragEnd,
  onToggle,
  onRename,
  onChangeColor,
  onStartRename,
  onCancelRename,
  onDelete,
  children,
}: {
  group?: WorkspaceGroup;
  name: string;
  count: number;
  accent: string;
  editing?: boolean;
  dragging?: boolean;
  /** Flip boundary for the folder's "…" AnchoredMenu (the workspaces scroll container). */
  menuBoundaryRef?: React.RefObject<HTMLElement | null>;
  isWorkspaceDrag: (event: React.DragEvent) => boolean;
  isWorkspaceGroupDrag: (event: React.DragEvent) => boolean;
  onDropWorkspace: (event: React.DragEvent) => void;
  onGroupDragStart?: (event: React.DragEvent<Element>) => void;
  onGroupDragOver?: (event: React.DragEvent<Element>) => void;
  onGroupDrop?: (event: React.DragEvent<Element>) => void;
  onGroupDragEnd?: () => void;
  onToggle?: () => void;
  onRename?: (name: string) => void;
  onChangeColor?: (color: string) => void;
  onStartRename?: () => void;
  onCancelRename?: () => void;
  onDelete?: () => void;
  children: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const colorInputRef = useRef<HTMLInputElement | null>(null);
  const folderMenuBtnRef = useRef<HTMLButtonElement>(null);
  const [draftName, setDraftName] = useState(name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const collapsed = group?.collapsed === true;

  useEffect(() => setDraftName(name), [name]);
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);
  // Row drops stop propagation after moving the workspace, so the folder's
  // own onDrop is not guaranteed to run. Clear the transient drop wash at the
  // document boundary too, preventing a destination folder from remaining
  // highlighted until the next reload.
  useEffect(() => {
    if (!dropActive) return;
    const clearDropState = () => setDropActive(false);
    document.addEventListener("drop", clearDropState, true);
    document.addEventListener("dragend", clearDropState, true);
    document.addEventListener("pointerdown", clearDropState, true);
    window.addEventListener("blur", clearDropState);
    return () => {
      document.removeEventListener("drop", clearDropState, true);
      document.removeEventListener("dragend", clearDropState, true);
      document.removeEventListener("pointerdown", clearDropState, true);
      window.removeEventListener("blur", clearDropState);
    };
  }, [dropActive]);

  const commitRename = () => {
    const next = draftName.trim();
    if (next) onRename?.(next);
    else {
      setDraftName(name);
      onCancelRename?.();
    }
  };

  const dragHandlers = {
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      if (!group || editing) return;
      const target = event.target instanceof Element ? event.target : null;
      // A row inside this folder is draggable in its own right. Its dragstart
      // bubbles up here, so bow out — but WITHOUT preventDefault, which would
      // cancel the row's own drag and is what made workspaces immovable once
      // they were inside a folder. The drag source is the nearest draggable
      // ancestor of the grab (the row), so declining to claim it is enough.
      if (target?.closest("[data-workspace-id]")) return;
      // Buttons, inputs and menus are NOT draggable, so a drag begun on one
      // would otherwise fall through to this section and start a group drag.
      // Here preventDefault is the right tool: there is no inner drag to kill.
      if (target?.closest("button, input, [role='menu']")) {
        event.preventDefault();
        return;
      }
      onGroupDragStart?.(event);
    },
    onDragOver: (event: React.DragEvent) => {
      if (isWorkspaceGroupDrag(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        onGroupDragOver?.(event);
        return;
      }
      if (!isWorkspaceDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropActive(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setDropActive(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (isWorkspaceGroupDrag(event)) {
        event.preventDefault();
        event.stopPropagation();
        onGroupDrop?.(event);
        return;
      }
      if (!isWorkspaceDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropActive(false);
      onDropWorkspace(event);
    },
    onDragEnd: () => onGroupDragEnd?.(),
  };

  return (
    <section
      className="spark-workspace-folder"
      data-workspace-group-id={group?.id ?? ""}
      draggable={Boolean(group) && !editing}
      style={{
        position: "relative",
        marginBottom: 8,
        padding: 4,
        borderRadius: "var(--radius-surface, 10px)",
        border: dropActive
          ? `1px solid color-mix(in oklab, ${accent} 54%, var(--rule))`
          : "1px solid color-mix(in oklab, var(--rule) 72%, transparent)",
        background: dropActive
          ? `color-mix(in oklab, ${accent} 12%, var(--panel))`
          : "color-mix(in oklab, var(--panel-raised, var(--panel)) 78%, transparent)",
        boxShadow: dropActive ? `0 0 18px color-mix(in oklab, ${accent} 18%, transparent)` : "var(--lift-hi)",
        opacity: dragging ? 0.46 : 1,
        backdropFilter: "blur(18px) saturate(125%)",
        WebkitBackdropFilter: "blur(18px) saturate(125%)",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
      {...dragHandlers}
    >
      <div
        style={{
          minHeight: 28,
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "2px 4px",
          color: "var(--ink-dim)",
        }}
      >
        {group ? (
          <button
            type="button"
            onClick={onToggle}
            title={collapsed ? `Expand ${name}` : `Collapse ${name}`}
            style={{
              appearance: "none",
              border: "none",
              background: "transparent",
              color: "var(--muted)",
              width: 14,
              height: 18,
              padding: 0,
              display: "grid",
              placeItems: "center",
              cursor: "default",
            }}
          >
            <ChevronGlyph collapsed={collapsed} />
          </button>
        ) : (
          <span style={{ width: 14 }} />
        )}
        <FolderGlyph color={group ? accent : "var(--muted)"} open={!collapsed} />
        {editing ? (
          <input
            ref={inputRef}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") {
                setDraftName(name);
                onCancelRename?.();
              }
            }}
            aria-label="Workspace folder name"
            style={{
              minWidth: 0,
              flex: 1,
              appearance: "none",
              background: "transparent",
              color: accent,
              border: "none",
              borderBottom: `1px solid ${accent}`,
              outline: "none",
              padding: "1px 0",
              fontFamily: "inherit",
              fontSize: 11,
              fontWeight: 700,
            }}
          />
        ) : group ? (
          <button
            type="button"
            onClick={onToggle}
            style={{
              minWidth: 0,
              flex: 1,
              appearance: "none",
              border: "none",
              background: "transparent",
              color: accent,
              textAlign: "left",
              padding: 0,
              fontFamily: "inherit",
              fontSize: 10,
              fontWeight: 750,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              cursor: "default",
            }}
            title={name}
          >
            {name}
          </button>
        ) : (
          <span
            title={name}
            style={{
              minWidth: 0,
              flex: 1,
              color: "var(--ink-dim)",
              fontSize: 10,
              fontWeight: 750,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {name}
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--muted-2)", fontVariantNumeric: "tabular-nums" }}>
          {count}
        </span>
        {group && !editing && (
          <div style={{ flex: "0 0 18px" }}>
            <button
              ref={folderMenuBtnRef}
              type="button"
              className="spark-icon-btn"
              title="Folder actions"
              onClick={() => setMenuOpen((open) => !open)}
              style={{
                ["--spark-icon-btn-size" as string]: "18px",
                color: menuOpen ? "var(--ink)" : "var(--muted)",
                borderRadius: "var(--radius-control, 7px)",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
                <circle cx="2" cy="5" r="1" />
                <circle cx="5" cy="5" r="1" />
                <circle cx="8" cy="5" r="1" />
              </svg>
            </button>
            <AnchoredMenu
              anchorRef={folderMenuBtnRef}
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              className="spark-menu"
              role="menu"
              ariaLabel="Folder actions"
              placement="below"
              boundaryRef={menuBoundaryRef}
              align="end"
            >
              <div style={{ minWidth: 180, padding: 4, display: "grid", gap: 2 }}>
                <div
                  style={{
                    padding: "4px 7px 3px",
                    color: "var(--muted)",
                    fontSize: 9,
                    fontWeight: 750,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}
                >
                  Folder color
                </div>
                <div
                  role="group"
                  aria-label="Folder colors"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(8, 1fr)",
                    gap: 5,
                    padding: "3px 7px 6px",
                  }}
                >
                  {WORKSPACE_COLORS.map((color) => {
                    const selected = normalizeHex(accent) === normalizeHex(color);
                    return (
                      <button
                        key={color}
                        type="button"
                        aria-label={`Set ${name} folder color to ${color}`}
                        title={color}
                        onClick={(event) => {
                          event.stopPropagation();
                          onChangeColor?.(color);
                          setMenuOpen(false);
                        }}
                        style={{
                          appearance: "none",
                          width: 15,
                          height: 15,
                          padding: 0,
                          borderRadius: 999,
                          border: selected
                            ? "2px solid var(--ink)"
                            : "1px solid color-mix(in oklab, var(--ink) 22%, transparent)",
                          background: color,
                          boxShadow: selected
                            ? `0 0 0 2px color-mix(in oklab, ${color} 30%, transparent)`
                            : "none",
                          cursor: "default",
                        }}
                      />
                    );
                  })}
                </div>
                <RowMenuItem
                  label="Custom color…"
                  onClick={() => colorInputRef.current?.click()}
                />
                <input
                  ref={colorInputRef}
                  type="color"
                  value={normalizeHex(accent)}
                  onChange={(event) => {
                    onChangeColor?.(event.currentTarget.value);
                    setMenuOpen(false);
                  }}
                  tabIndex={-1}
                  aria-hidden="true"
                  style={{ position: "absolute", width: 0, height: 0, opacity: 0 }}
                />
                <div style={{ height: 1, margin: "3px 5px", background: "var(--rule-soft)" }} />
                <RowMenuItem
                  label="Rename folder"
                  onClick={() => {
                    setMenuOpen(false);
                    onStartRename?.();
                  }}
                />
                <RowMenuItem
                  label="Delete folder"
                  danger
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete?.();
                  }}
                />
              </div>
            </AnchoredMenu>
          </div>
        )}
      </div>
      {!collapsed && (
        <div style={{ paddingTop: count > 0 ? 2 : 0 }}>
          {children}
          {count === 0 && (
            <div
              style={{
                margin: "2px 3px 3px",
                padding: "7px 8px",
                borderRadius: "var(--radius-control, 7px)",
                border: "1px dashed color-mix(in oklab, var(--rule) 75%, transparent)",
                color: dropActive ? accent : "var(--muted-2)",
                fontSize: 10,
                textAlign: "center",
              }}
            >
              Drop workspaces here
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RowDropIndicator({ accent }: { accent: string }) {
  return (
    <div
      aria-hidden
      style={{
        height: 2,
        // Left inset aligns to the row's text start (9px row padding) so the
        // insertion line reads as landing in the list's content column.
        margin: "2px 6px 2px 9px",
        borderRadius: 999,
        background: accent,
        boxShadow: `0 0 8px ${accent}`,
        pointerEvents: "none",
      }}
    />
  );
}

function RailItemDropZone({
  index,
  active,
  accent,
  onDragOver,
  onDrop,
}: {
  index: number;
  active: boolean;
  accent: string;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      aria-hidden
      data-workspace-rail-drop-index={index}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        height: 8,
        margin: "-2px 0",
        position: "relative",
        zIndex: active ? 12 : 1,
      }}
    >
      {active && (
        <div
          style={{
            position: "absolute",
            left: 8,
            right: 8,
            top: 3,
            height: 2,
            borderRadius: 999,
            background: accent,
            boxShadow: `0 0 12px ${accent}`,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}

function PanelDropIndicator({ accent }: { accent: string }) {
  return (
    <div aria-hidden style={{ flex: "0 0 0px", position: "relative", zIndex: 8 }}>
      <div
        style={{
          position: "absolute",
          left: 8,
          right: 8,
          top: -1,
          height: 2,
          borderRadius: 999,
          background: accent,
          boxShadow: `0 0 12px ${accent}`,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function EmptyPanelDropTarget({ active, accent }: { active: boolean; accent: string }) {
  return (
    <div
      aria-hidden
      style={{
        flex: 1,
        minHeight: 0,
        margin: 8,
        border: active ? `1px dashed ${accent}` : "1px dashed transparent",
        background: active ? `color-mix(in oklab, ${accent} 8%, transparent)` : "transparent",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    />
  );
}

interface RailIconButtonProps {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}

const RailIconButton = React.forwardRef<HTMLButtonElement, RailIconButtonProps>(
  function RailIconButton(
    { title, onClick, disabled = false, danger = false, children },
    ref,
  ) {
    const [hover, setHover] = useState(false);
    const [focus, setFocus] = useState(false);
    const active = hover && !disabled;
    return (
      <button
        ref={ref}
        type="button"
        className="spark-icon-btn"
        onClick={() => {
          if (!disabled) onClick();
        }}
        disabled={disabled}
        title={title}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          // Routed through .spark-icon-btn for shared hover/press/disabled;
          // sized to 20px and overridden inline for the danger tint + focus
          // ring. No unconditional border — the band reads cleaner.
          ["--spark-icon-btn-size" as string]: "20px",
          borderRadius: "var(--radius-control, 7px)",
          background: active
            ? danger
              ? "var(--danger-soft)"
              : "var(--hover-strong, var(--hover))"
            : "transparent",
          color: disabled
            ? "var(--muted-2)"
            : active && danger
              ? "var(--danger)"
              : active
                ? "var(--ink)"
                : "var(--ink-dim)",
          boxShadow: focus
            ? "var(--focus-ring, 0 0 0 2px var(--accent-edge))"
            : "none",
        }}
      >
        {children}
      </button>
    );
  },
);

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    // Calm centered first-run hint via .spark-empty: a faint workspace-dot
    // glyph, the eyebrow names the absent thing, a body line explains, and the
    // CTA is the shared .spark-btn (built-in hover / press / focus ring). The
    // horizontal padding matches the list body so it sits where rows would.
    <div className="spark-empty" style={{ padding: "28px 8px", gap: 8 }}>
      <span
        aria-hidden
        style={{
          display: "grid",
          placeItems: "center",
          width: 28,
          height: 28,
          marginBottom: 2,
          borderRadius: "var(--radius-surface, 10px)",
          color: "var(--muted-2)",
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="6" rx="1.5" />
          <rect x="3" y="14" width="18" height="6" rx="1.5" />
        </svg>
      </span>
      <div className="spark-eyebrow">No workspaces yet</div>
      <div className="spark-empty__body">
        Create one to start orchestrating workers.
      </div>
      <button
        type="button"
        className="spark-btn"
        onClick={onCreate}
        style={{ marginTop: 4 }}
      >
        New workspace
      </button>
    </div>
  );
}

interface RowProps {
  ws: Workspace;
  active: boolean;
  editing: boolean;
  dragging: boolean;
  tone?: ChatStatusTone | null;
  working?: boolean;
  /** The workspace's folder is not on disk right now (moved/renamed/unmounted). */
  missing?: boolean;
  /** Folder members inherit their ordered shade from the folder family. */
  folderColorManaged?: boolean;
  /** Flip boundary for the row's "…" AnchoredMenu (the workspaces scroll container). */
  menuBoundaryRef?: React.RefObject<HTMLElement | null>;
  onActivate: () => void;
  onEdit: () => void;
  onChange: (patch: Partial<Workspace>) => void;
  onPreviewColor: (color: string) => void;
  onCloseEditor: () => void;
  onCreateCopyBranch: () => void;
  onDelete: () => void;
  onRowDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
  onRowDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onRowDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onRowDragEnd: () => void;
}

function WorkspaceRow({
  ws,
  active,
  editing,
  dragging,
  tone,
  working = false,
  missing = false,
  folderColorManaged = false,
  menuBoundaryRef,
  onActivate,
  onEdit,
  onChange,
  onPreviewColor,
  onCloseEditor,
  onCreateCopyBranch,
  onDelete,
  onRowDragStart,
  onRowDragOver,
  onRowDrop,
  onRowDragEnd,
}: RowProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const colorRef = useRef<HTMLInputElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [name, setName] = useState(ws.name);
  const [rowHover, setRowHover] = useState(false);
  const [rowPressed, setRowPressed] = useState(false);
  const [moreHover, setMoreHover] = useState(false);
  const [moreFocus, setMoreFocus] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  // In-flight color while the OS color dialog is open. The native
  // <input type="color"> streams `input` events 30-60×/sec (sometimes faster)
  // during a drag. We keep the live value here for a LOCAL preview only — just
  // this row's color dot + border — and lift to App state exactly once, on the
  // final `change` event. Crucially we do NOT touch the global `--accent`
  // variable or App state during the drag: doing so re-tinted the whole app
  // (every `color-mix(--accent)` recalculated) and re-themed every terminal on
  // every tick, which dropped frames. The whole-app accent applies on commit.
  const [draftColor, setDraftColor] = useState<string | null>(null);
  // The `input` stream can outrun the frame rate, so the local preview update
  // is coalesced to at most one setState per animation frame.
  const colorRaf = useRef<number | null>(null);
  const pendingColor = useRef<string>("");
  const committedColor = useRef(normalizeHex(ws.color));
  const latestOnChange = useRef(onChange);
  const latestOnPreviewColor = useRef(onPreviewColor);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The live draft (if a pick is in progress) wins over the committed color.
  const accent = draftColor || ws.color || "var(--accent)";

  useEffect(() => setName(ws.name), [ws.id, ws.name]);
  useEffect(() => {
    latestOnChange.current = onChange;
  }, [onChange]);
  useEffect(() => {
    latestOnPreviewColor.current = onPreviewColor;
  }, [onPreviewColor]);
  useEffect(() => {
    committedColor.current = normalizeHex(ws.color);
  }, [ws.color]);
  // Clear any pending timers / frames if the row unmounts mid-pick.
  useEffect(() => {
    return () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
      if (colorRaf.current !== null) cancelAnimationFrame(colorRaf.current);
    };
  }, []);
  useEffect(() => {
    const input = colorRef.current;
    if (!editing || !input) return;

    const commitColor = () => {
      if (commitTimer.current) {
        clearTimeout(commitTimer.current);
        commitTimer.current = null;
      }
      const value = normalizeHex(input.value || pendingColor.current || committedColor.current);
      pendingColor.current = value;
      if (value !== committedColor.current) {
        committedColor.current = value;
        latestOnChange.current({ color: value });
      }
      setDraftColor(null);
    };

    input.addEventListener("change", commitColor);
    input.addEventListener("blur", commitColor);
    return () => {
      input.removeEventListener("change", commitColor);
      input.removeEventListener("blur", commitColor);
    };
  }, [editing]);
  useEffect(() => {
    if (editing && inputRef.current) {
      // Editing hides the "…" button; drop its menu state too so a stale open
      // menu cannot reappear when editing ends.
      setMenuOpen(false);
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (rowRef.current && e.target instanceof Node && !rowRef.current.contains(e.target)) {
        commitName();
        onCloseEditor();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseEditor();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commitName = () => {
    const v = name.trim();
    if (v && v !== ws.name) onChange({ name: v });
  };

  // A flat list at rest — no resting ink wash. Press is the tactile beat
  // (--press), hover is the first tint step (--hover). The active row's
  // identity now comes from a SOFT, ROUNDED, COLOR-TINTED FILL in the row's
  // own color — a calm macOS-sidebar selection, not an outlined box. Editing
  // shares that color wash (a touch lighter) so a rename never changes the
  // surface. No left-edge bar, no stacked halo: the color carries it quietly.
  const background = rowPressed
    ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
    : active
      ? `color-mix(in oklab, ${accent} 14%, var(--panel))`
      : editing
        ? `color-mix(in oklab, ${accent} 9%, var(--panel))`
        : rowHover
          ? "var(--hover, color-mix(in oklab, var(--ink) 5%, transparent))"
          : "transparent";

  return (
    <div
      ref={rowRef}
      data-workspace-id={ws.id}
      draggable={!editing}
      onDragStart={onRowDragStart}
      onDragOver={onRowDragOver}
      onDrop={onRowDrop}
      onDragEnd={onRowDragEnd}
      onClick={editing ? undefined : onActivate}
      onMouseEnter={() => setRowHover(true)}
      onMouseLeave={() => {
        setRowHover(false);
        setRowPressed(false);
      }}
      onMouseDown={() => {
        if (!editing) setRowPressed(true);
      }}
      onMouseUp={() => setRowPressed(false)}
      aria-busy={working}
      data-agent-working={working ? "true" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        minHeight: 32,
        // Copy-branch rows indent so they read as a child of their parent repo.
        marginLeft: ws.copyBranch ? 14 : 0,
        // Padding is identical between resting and editing so an inline rename
        // never reflows the row (Apple inline-rename swaps only the affordance,
        // not the geometry).
        padding: "5px 6px 5px 9px",
        background,
        cursor: "default",
        opacity: dragging ? 0.4 : 1,
        position: "relative",
        // Border stays 1px in every state — width never changes, so selection
        // never shifts the box by a hair. The active row carries NO hard border
        // (the soft color fill IS the selection); only editing keeps a faint,
        // very soft color edge as a "this is being renamed" affordance.
        border: editing
          ? `1px solid color-mix(in oklab, ${accent} 24%, var(--rule-soft))`
          : "1px solid transparent",
        // Generous, calm rounding — de-boxed. Surfaces sit at the surface rung.
        borderRadius: "var(--radius-surface, 10px)",
        // ONE soft cue, per the one-hairline elevation law: the tinted fill
        // does the work; a single faint top highlight lifts active / editing /
        // hover. No left-edge bar, no border+ring+shadow+inset halo.
        boxShadow: active || editing || rowHover ? "var(--lift-hi)" : "none",
        marginBottom: 4,
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 }}>
        {ws.copyBranch && !editing ? (
          <BranchGlyph color={accent} active={active} working={working} />
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (editing && !folderColorManaged) colorRef.current?.click();
            }}
            tabIndex={editing && !folderColorManaged ? 0 : -1}
            title={
              editing
                ? folderColorManaged
                  ? "This workspace's shade follows its folder color and position"
                  : "Change color"
                : working
                  ? `${ws.name} — agent working`
                  : undefined
            }
            style={{
              appearance: "none",
              border: "none",
              padding: 0,
              // Constant 8px advance in every state so toggling active /
              // editing never nudges the label. Active reads purely through
              // the glow (box-shadow), never a size bump. BranchGlyph shares
              // this exact 8px advance so the copy-branch swap never reflows.
              // While `working`, the dot keeps its 8px slot but hollows to a
              // faint core and grows the spinning comet ring below — the ring's
              // asymmetric arc, not the recoloured core, is what reads as motion.
              width: 8,
              height: 8,
              borderRadius: 999,
              background: working
                ? `color-mix(in oklab, ${accent} 30%, transparent)`
                : accent,
              flex: "0 0 8px",
              cursor: "default",
              position: "relative",
              overflow: "visible",
              // No resting ink ring — the idle list settles flat. The active /
              // editing dot earns a SOFT COLORED GLOW RING in its own color so
              // the eye lands on it; the 8px advance never changes (glow only).
              boxShadow: editing
                ? `0 0 0 3px color-mix(in oklab, ${accent} 26%, transparent)`
                : active
                  ? `0 0 0 3px color-mix(in oklab, ${accent} 22%, transparent), 0 0 10px color-mix(in oklab, ${accent} 50%, transparent)`
                  : "none",
            }}
          >
            {working && (
              <span
                aria-hidden
                className="spark-activity-spin"
                style={{
                  position: "absolute",
                  inset: -2, // 12px visual ring over the 8px slot
                  borderRadius: 999,
                  background: `conic-gradient(from 0deg, transparent 0deg 70deg, color-mix(in oklab, ${accent} 35%, transparent) 120deg, ${accent} 330deg, transparent 330deg 360deg)`,
                  WebkitMask:
                    "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
                  mask: "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
                }}
              />
            )}
          </button>
        )}
        <StatusDot tone={tone} />
        {editing && !folderColorManaged && (
          <input
            ref={colorRef}
            type="color"
            // Show the draft mid-pick so the native swatch tracks the drag;
            // otherwise reflect the committed color.
            value={normalizeHex(draftColor ?? ws.color)}
            // `input` fires continuously while dragging inside the OS picker.
            // We deliberately do NOT call onChange (App state) or write the
            // global `--accent` variable here — only this row's local draft
            // preview is updated (coalesced to one setState per frame). A
            // global mutation per tick re-tinted the whole app and re-themed
            // every terminal; the whole-app accent is applied once, on commit.
            onInput={(e) => {
              pendingColor.current = e.currentTarget.value;
              if (colorRaf.current === null) {
                colorRaf.current = requestAnimationFrame(() => {
                  colorRaf.current = null;
                  const value = normalizeHex(pendingColor.current);
                  pendingColor.current = value;
                  setDraftColor(value);
                  latestOnPreviewColor.current(value);
                });
              }
              if (commitTimer.current) clearTimeout(commitTimer.current);
              commitTimer.current = setTimeout(() => {
                commitTimer.current = null;
                const value = normalizeHex(pendingColor.current);
                if (value !== committedColor.current) {
                  committedColor.current = value;
                  latestOnChange.current({ color: value });
                }
                setDraftColor(null);
              }, 260);
            }}
            style={{
              position: "absolute",
              width: 0,
              height: 0,
              opacity: 0,
              pointerEvents: "none",
            }}
            tabIndex={-1}
            aria-hidden="true"
          />
        )}

        {editing ? (
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitName();
                onCloseEditor();
              }
              if (e.key === "Escape") {
                setName(ws.name);
                onCloseEditor();
              }
            }}
            style={{
              appearance: "none",
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              // Inline rename matches the resting label's exact size + weight,
              // swapping only the border-bottom affordance — so entering edit
              // mode never jumps the type (was 14px/600 -> reflow).
              borderBottom: `1px solid ${accent}`,
              color: "var(--ink)",
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: 600,
              padding: "1px 0",
              outline: "none",
            }}
          />
        ) : (
          <div style={{ display: "flex", alignItems: "center", minWidth: 0, flex: 1 }}>
            <span
              // A workspace whose folder was moved, renamed, or unmounted is
              // struck through and dimmed rather than removed: the entry may
              // still be wanted (external drive, another machine, a clone in
              // progress), and deleting it on the app's own initiative is not
              // undoable. The strike says "this path is gone" without deciding
              // anything on the user's behalf.
              title={missing ? `${ws.name} — folder not found at ${ws.cwd}` : ws.name}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: missing ? "var(--muted)" : active ? "var(--ink)" : "var(--ink-dim)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                ...(missing
                  ? { textDecoration: "line-through", textDecorationThickness: "1px", opacity: 0.75 }
                  : {}),
              }}
            >
              {ws.name}
            </span>
          </div>
        )}

        <div style={{ flex: "0 0 18px" }}>
          <button
            ref={menuBtnRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (editing) {
                commitName();
                onCloseEditor();
              } else {
                setMenuOpen((o) => !o);
              }
            }}
            onMouseEnter={() => setMoreHover(true)}
            onMouseLeave={() => setMoreHover(false)}
            onFocus={() => setMoreFocus(true)}
            onBlur={() => setMoreFocus(false)}
            title={editing ? "Done" : "Workspace actions"}
            style={{
              appearance: "none",
              // Hover/press tint via .spark-icon-btn; color logic kept (editing
              // -> accent, otherwise muted -> ink-dim on hover/active) and the
              // keyboard focus ring composed inline for parity.
              background:
                !editing && (menuOpen || moreHover)
                  ? "var(--hover-strong, var(--hover))"
                  : "transparent",
              border: "none",
              borderRadius: "var(--radius-control, 7px)",
              color: editing
                ? accent
                : menuOpen || moreHover || active
                  ? "var(--ink-dim)"
                  : "var(--muted-2)",
              width: 18,
              height: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "default",
              padding: 0,
              opacity: menuOpen || moreHover || active || editing ? 1 : 0.72,
              boxShadow: moreFocus
                ? "var(--focus-ring, 0 0 0 2px var(--accent-edge))"
                : "none",
              transition:
                "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
            }}
          >
            {editing ? (
              <svg
                width="11"
                height="11"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="square"
              >
                <polyline points="1.5,5.5 4,8 8.5,2.5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor">
                <circle cx="2" cy="5" r="1" />
                <circle cx="5" cy="5" r="1" />
                <circle cx="8" cy="5" r="1" />
              </svg>
            )}
          </button>
          <AnchoredMenu
            anchorRef={menuBtnRef}
            open={menuOpen && !editing}
            onClose={() => setMenuOpen(false)}
            className="spark-menu"
            role="menu"
            ariaLabel="Workspace actions"
            placement="below"
            boundaryRef={menuBoundaryRef}
            align="end"
          >
            <div style={{ minWidth: 168, maxWidth: 240, padding: 4, display: "grid", gap: 2 }}>
              <RowMenuItem
                label="Edit"
                onClick={() => {
                  setMenuOpen(false);
                  onEdit();
                }}
              />
              {!ws.remote && (
                <RowMenuItem
                  label="Create isolated worktree…"
                  onClick={() => {
                    setMenuOpen(false);
                    onCreateCopyBranch();
                  }}
                />
              )}
              <RowMenuItem
                label="Delete"
                danger
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              />
            </div>
          </AnchoredMenu>
        </div>
      </div>
    </div>
  );
}

function normalizeHex(c: string): string {
  // <input type="color"> only accepts #rrggbb. Reject anything else and fall
  // back to a default so React doesn't warn about a non-conforming value.
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  return "#f0c419";
}

// Right-click menu for blank rail space. Anchored to a POINT, not an element,
// so AnchoredMenu doesn't fit — but the same rules apply: portal to body
// (correct glass backdrop, no overflow clipping) and clamp to the viewport.
function RailContextMenu({
  x,
  y,
  anchor,
  onClose,
  children,
}: {
  x: number;
  y: number;
  // The container the right-click landed in; scrolls that move it close the menu.
  anchor: HTMLElement;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.min(Math.max(pad, x), window.innerWidth - rect.width - pad),
      top: Math.min(Math.max(pad, y), window.innerHeight - rect.height - pad),
    });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Same rule as AnchoredMenu: only a scroll that MOVES THE ANCHOR closes
    // the menu. Closing on any scroll breaks it during a run — the
    // conversation timeline follows streamed output and scrolls itself several
    // times a second, which would flick this menu shut on every token even
    // though the rail hasn't moved. Capture-phase because scroll doesn't
    // bubble; a Document-level scroll contains everything and still closes.
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (!target || !target.contains(anchor)) return;
      onClose();
    };
    // Capture-phase: some dialog surfaces stopPropagation on mousedown.
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="spark-menu"
      style={{
        position: "fixed",
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        minWidth: 180,
        padding: 4,
        display: "grid",
        gap: 2,
        zIndex: 60,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function RowMenuItem({
  label,
  onClick,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        textAlign: "left",
        width: "100%",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 500,
        padding: "6px 9px",
        borderRadius: "var(--radius-control, 7px)",
        border: "none",
        cursor: "default",
        color: danger ? "var(--danger)" : "var(--ink)",
        background: hover
          ? danger
            ? "var(--danger-soft)"
            : "var(--hover)"
          : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}

// Small status-tone badge sitting next to the color dot / branch glyph. It is
// the rail's at-a-glance "which workspace wants me" signal: its fill is the
// run-status tone rolled up across the workspace's runs (blocked / done-unseen
// / live / …). Deliberately static — no pulse — to honor the house rule that
// blocked never animates and to keep the rail calm when nothing is happening.
// Quiet workspaces render nothing: a null/undefined tone, or `idle` (which
// maps to the muted token), is suppressed so only meaningful states show.
function StatusDot({ tone }: { tone?: ChatStatusTone | null }) {
  if (!tone || tone === "idle") return null;
  const color = statusToneColor(tone);
  return (
    <span
      aria-hidden
      title={tone}
      style={{
        flex: "0 0 6px",
        width: 6,
        height: 6,
        borderRadius: 999,
        background: color,
        boxShadow: `0 0 0 2px color-mix(in oklab, ${color} 18%, transparent)`,
      }}
    />
  );
}

// Branch glyph shown in place of the color dot on copy-branch workspace rows,
// tinted with the inherited (parent) color so the row reads as a branch of it.
function BranchGlyph({
  color,
  active,
  working = false,
}: {
  color: string;
  active: boolean;
  working?: boolean;
}) {
  return (
    <span
      aria-hidden
      title="Copy branch"
      style={{
        // Shares the color dot's exact 8px advance so toggling copyBranch
        // never reflows the row's leading cluster. The 13px glyph is centered
        // over the slot and overflows it symmetrically (visible overflow), so
        // it reads clearly without widening the row's text origin.
        flex: "0 0 8px",
        display: "grid",
        placeItems: "center",
        width: 8,
        height: 13,
        overflow: "visible",
        position: "relative",
        // Mirrors the color dot's active treatment: a soft glow in the row's
        // own color so the branch glyph reads as the selected mark, no halo.
        filter: active
          ? `drop-shadow(0 0 6px color-mix(in oklab, ${color} 50%, transparent))`
          : "none",
      }}
    >
      {working && (
        <span
          aria-hidden
          className="spark-activity-spin"
          style={{
            // A ring must be SQUARE to rotate cleanly — inset on this 8×13
            // slot would spin a wobbling ellipse. Centered via margins, not
            // transform: spark-spin animates `transform`, so a translate here
            // would be overwritten on the animation's first frame.
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 18,
            height: 18,
            marginLeft: -9,
            marginTop: -9,
            borderRadius: 999,
            background: `conic-gradient(from 0deg, transparent 0deg 70deg, color-mix(in oklab, ${color} 35%, transparent) 120deg, ${color} 330deg, transparent 330deg 360deg)`,
            WebkitMask:
              "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
            mask: "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))",
          }}
        />
      )}
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flex: "0 0 auto" }}
      >
        <line x1="6" x2="6" y1="3" y2="15" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
    </span>
  );
}

function ChevronGlyph({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 120ms ease" }}
    >
      <path d="M2 3.5 5 6.5 8 3.5" />
    </svg>
  );
}

function FolderGlyph({ color, open }: { color: string; open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 18 18"
      fill="none"
      stroke={color}
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: "0 0 14px", filter: open ? `drop-shadow(0 0 5px color-mix(in oklab, ${color} 30%, transparent))` : "none" }}
    >
      <path d="M2.25 5.25h5l1.4 1.6h7.1v6.4a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5v-8Z" />
      <path d="M2.25 5.25V4.6a1.35 1.35 0 0 1 1.35-1.35h3.05l1.3 1.5h6.3a1.5 1.5 0 0 1 1.5 1.5v.6" opacity=".72" />
    </svg>
  );
}
