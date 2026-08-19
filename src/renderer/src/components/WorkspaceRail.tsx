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
import { resolveWorkspaceAccent } from "../lib/workspace-accent";
import { useTheme } from "../theme/theme-context";
import {
  PANEL_HEADER_H,
  PANEL_SECTION_KEYS,
  sectionSlotStyles,
  type PanelSectionKey,
  type PanelSide,
} from "../panels/usePanelLayout";
import ResizeHandle from "../panels/ResizeHandle";
import SectionHeader from "../panels/SectionHeader";
import {
  beforeItemForVerticalPlan,
  planVerticalReorder,
  railAutoScrollDelta,
  type VerticalReorderSlot,
} from "./workspaceReorder";

const PANEL_SECTION_MIME = "application/x-codara-panel-section";
const WORKSPACE_ROW_MIME = "application/x-codara-workspace-row";
const WORKSPACE_GROUP_MIME = "application/x-codara-workspace-group";
// Reorder scopes: the rail is not one list but several. The top level holds
// unfiled workspaces and folder cards; every expanded folder owns a second,
// nested list of its members. Each gets its own cached geometry and its own
// ghost slot, keyed by these ids.
const RAIL_SCOPE_TOP = "top";
const RAIL_SCOPE_GROUP_PREFIX = "group:";
const railScopeForGroup = (groupId: string): string => `${RAIL_SCOPE_GROUP_PREFIX}${groupId}`;
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

// User-dragged heights for external Explorer folder trees, keyed by folder
// path. Renderer-local presentation state (like tab layouts in localStorage),
// deliberately not part of AppState.
const EXTERNAL_HEIGHTS_KEY = "spark.explorer.externalFolderHeights";
// One row plus the tree's vertical padding — the smallest useful tree.
const EXTERNAL_TREE_MIN_H = 34;
// Dragging an external tree taller stops here so the primary workspace tree
// always keeps a usable strip of the section.
const EXTERNAL_TREE_RESERVED_H = 140;

function readExternalFolderHeights(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXTERNAL_HEIGHTS_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    const out: Record<string, number> = {};
    for (const [path, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) out[path] = value;
    }
    return out;
  } catch {
    return {};
  }
}

// Escape a string for use inside a quoted CSS attribute selector (Windows
// paths are full of backslashes, which CSS treats as escapes).
function cssAttrValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function folderBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

// Live preview of where a rail drag would land. Derived entirely from
// planVerticalReorder, so what the rail paints and what the drop commits come
// from one calculation.
interface ReorderPreview {
  /** Which list this preview belongs to: "top", or `group:<folder id>`. */
  scope: string;
  draggedId: string;
  /** Landing index within this list minus the dragged item. */
  insertIndex: number;
  /**
   * False for a "home" drop (releasing here changes nothing): the ghost slot
   * fades out rather than promising a move the drop will not make.
   */
  changed: boolean;
  /** Content-space box of the ghost slot — the hole the rows slid apart to open. */
  ghostStart: number;
  ghostHeight: number;
  /** translateY px per item id; absent means 0. */
  offsets: Record<string, number>;
}

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
  // Attach a local folder outside the workspace cwd as an extra Explorer root
  // (OS folder picker), and detach one (reference removal only, never disk).
  onAddExternalFolder: () => void;
  onRemoveExternalFolder: (workspaceId: string, folderPath: string) => void;
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
  const [groupDragId, setGroupDragId] = useState<string | null>(null);
  const groupDragIdRef = useRef<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createBtnRef = useRef<HTMLButtonElement>(null);
  // The workspaces scroll container — passed to the rail's AnchoredMenus as
  // their flip boundary so a menu near the section's end opens upward instead
  // of overhanging the section stacked below (Source Control / Explorer).
  const wsScrollRef = useRef<HTMLDivElement | null>(null);
  // ── Rail reorder ─────────────────────────────────────────────────────────
  // The gesture is owned by the LIST, not by the individual rows — the same
  // shape the tab strip uses. One hit-test against one cached geometry, so
  // there are no dead pixels in the gaps between rows or in the empty run past
  // the last one (dropping there used to be a silent cancel), and no per-row
  // indicator that can get stranded when a fast drag skips a dragleave.
  //
  // There are two independent lists ("scopes"): the top level, and each
  // expanded folder's member list. A workspace can be dragged between them; a
  // folder only ever reorders within the top level.
  const memberListRefs = useRef(new Map<string, HTMLDivElement>());
  // Geometry is measured ONCE per scope per gesture. Re-measuring mid-drag
  // would read the live transforms of the sliding rows, and moving boundaries
  // make the insertion index oscillate whenever the pointer rests near a
  // midpoint. Content coordinates also survive the edge auto-scroll below.
  const reorderSlotsRef = useRef(new Map<string, VerticalReorderSlot[]>());
  // Height of the item in flight, captured at dragstart. Only consulted when
  // it lands in a list it did not come from, which has no slot to measure.
  const dragHeightRef = useRef(0);
  const dragPointerRef = useRef<number | null>(null);
  const dragScopeRef = useRef<string | null>(null);
  const autoScrollRef = useRef<number | null>(null);
  // Dimming the source is deferred one frame: doing it synchronously in
  // dragstart can be caught by the browser's drag-image snapshot, handing the
  // user a drag image that is already faded.
  const dragDimFrameRef = useRef<number | null>(null);
  const [reorderPreview, setReorderPreview] = useState<ReorderPreview | null>(null);
  const reorderPreviewRef = useRef<ReorderPreview | null>(null);
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

  // External-folder tree heights, dragged via the divider above each attached
  // folder. State drives layout live during the drag; the ref mirror lets the
  // drag-end handler persist the latest values without a stale closure.
  const [externalHeights, setExternalHeights] = useState<Record<string, number>>(
    readExternalFolderHeights,
  );
  const externalHeightsRef = useRef(externalHeights);
  externalHeightsRef.current = externalHeights;
  const externalDragStart = useRef({ startH: 0, maxH: 0 });

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

  const stopRailAutoScroll = () => {
    if (autoScrollRef.current === null) return;
    cancelAnimationFrame(autoScrollRef.current);
    autoScrollRef.current = null;
  };

  const clearReorderPreview = () => {
    reorderPreviewRef.current = null;
    setReorderPreview((current) => (current === null ? current : null));
  };

  // Everything a gesture allocates — cached geometry, the auto-scroll frame,
  // the deferred dim, the preview. Every teardown path runs through here so
  // none of them can leave half the state behind.
  const endRailGesture = () => {
    stopRailAutoScroll();
    if (dragDimFrameRef.current !== null) cancelAnimationFrame(dragDimFrameRef.current);
    dragDimFrameRef.current = null;
    reorderSlotsRef.current.clear();
    dragPointerRef.current = null;
    dragScopeRef.current = null;
    dragHeightRef.current = 0;
    clearReorderPreview();
  };

  const clearWorkspaceDrag = () => {
    wsDragIdRef.current = null;
    setWsDragId(null);
    endRailGesture();
  };

  const clearWorkspaceGroupDrag = () => {
    groupDragIdRef.current = null;
    setGroupDragId(null);
    endRailGesture();
  };

  const clearRailDrag = () => {
    clearWorkspaceDrag();
    clearWorkspaceGroupDrag();
  };

  // Safety net: dragend is delivered to the drag SOURCE row, and a row that
  // unmounts mid-drag (a folder popover closing, a row re-parenting between
  // group and top level) never receives it — wedging the dimmed "dragging"
  // ghost on that row indefinitely. While any rail drag is live, also listen
  // at the window so every way a drag can end clears the visual state.
  useEffect(() => {
    if (wsDragId === null && groupDragId === null) return undefined;
    const end = () => clearRailDrag();
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    // A drag that leaves the window entirely (onto another app, or the window
    // losing focus behind a dialog) fires neither of the above here.
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
      window.removeEventListener("blur", end);
    };
    // The clear helpers only touch stable refs/setters — ids are the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsDragId, groupDragId]);

  // Unmount mid-drag (the section moved to the other rail, the workspace
  // switched): never leave an animation frame scheduled behind us.
  useEffect(() => () => {
    if (autoScrollRef.current !== null) cancelAnimationFrame(autoScrollRef.current);
    if (dragDimFrameRef.current !== null) cancelAnimationFrame(dragDimFrameRef.current);
  }, []);

  const listNodeForScope = (scope: string): HTMLElement | null =>
    scope === RAIL_SCOPE_TOP ? wsScrollRef.current : memberListRefs.current.get(scope) ?? null;

  // Only the top-level list scrolls; member lists ride inside it, so their
  // content space is just their own box.
  const scrollTopForScope = (node: HTMLElement, scope: string): number =>
    scope === RAIL_SCOPE_TOP ? node.scrollTop : 0;

  // Direct children only: a folder card is one item of the TOP list, and the
  // member rows nested inside it belong to the folder's own list, not this one.
  const railItemElements = (node: HTMLElement): HTMLElement[] =>
    Array.from(node.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && Boolean(railItemId(child)));

  const railItemId = (element: HTMLElement): string =>
    element.dataset.workspaceId || element.dataset.workspaceGroupId || "";

  const measureRailSlots = (scope: string): VerticalReorderSlot[] => {
    const node = listNodeForScope(scope);
    if (!node) return [];
    const listTop = node.getBoundingClientRect().top;
    const scrollTop = scrollTopForScope(node, scope);
    // Undo this scope's live preview transforms, so a mid-gesture re-measure
    // reads layout positions rather than where the rows have slid to.
    const offsets = reorderPreviewRef.current?.scope === scope
      ? reorderPreviewRef.current.offsets
      : undefined;
    return railItemElements(node).map((element) => {
      const id = railItemId(element);
      const rect = element.getBoundingClientRect();
      const shift = offsets?.[id] ?? 0;
      return {
        id,
        start: rect.top - listTop + scrollTop - shift,
        end: rect.bottom - listTop + scrollTop - shift,
      };
    });
  };

  // Cached geometry, refreshed only when the list's membership changed under
  // the drag (an agent creating or deleting a workspace mid-gesture).
  const ensureRailSlots = (scope: string): VerticalReorderSlot[] => {
    const node = listNodeForScope(scope);
    const cached = reorderSlotsRef.current.get(scope);
    if (node && cached) {
      const live = railItemElements(node).map(railItemId);
      if (live.length === cached.length && live.every((id, index) => id === cached[index].id)) {
        return cached;
      }
    }
    const next = measureRailSlots(scope);
    reorderSlotsRef.current.set(scope, next);
    return next;
  };

  // A folder card only reorders among the top-level items — it cannot be
  // filed inside another folder. A workspace can land in any list.
  const railDragIdForScope = (scope: string): string | null => {
    if (groupDragIdRef.current) {
      return scope === RAIL_SCOPE_TOP ? groupDragIdRef.current : null;
    }
    return wsDragIdRef.current;
  };

  const railPointerY = (node: HTMLElement, scope: string, clientY: number): number =>
    clientY - node.getBoundingClientRect().top + scrollTopForScope(node, scope);

  const applyRailPlanAt = (scope: string, clientY: number) => {
    const draggedId = railDragIdForScope(scope);
    const node = listNodeForScope(scope);
    if (!draggedId || !node) return;
    dragPointerRef.current = clientY;
    dragScopeRef.current = scope;
    const slots = ensureRailSlots(scope);
    const plan = planVerticalReorder(
      slots,
      draggedId,
      railPointerY(node, scope, clientY),
      dragHeightRef.current,
    );
    // The dragged item is neither in this list nor measurable — show nothing
    // rather than guess a destination.
    if (!plan) return clearReorderPreview();
    const previous = reorderPreviewRef.current;
    if (
      previous &&
      previous.scope === scope &&
      previous.draggedId === plan.draggedId &&
      previous.insertIndex === plan.insertIndex &&
      previous.changed === plan.changed &&
      previous.ghostStart === plan.ghostStart
    ) {
      return;
    }
    const offsets: Record<string, number> = {};
    plan.offsets.forEach((offset, index) => {
      if (offset !== 0) offsets[slots[index].id] = offset;
    });
    const next: ReorderPreview = {
      scope,
      draggedId: plan.draggedId,
      insertIndex: plan.insertIndex,
      changed: plan.changed,
      ghostStart: plan.ghostStart,
      ghostHeight: plan.ghostHeight,
      offsets,
    };
    reorderPreviewRef.current = next;
    setReorderPreview(next);
  };

  // Edge auto-scroll: without it, a rail taller than its section can only be
  // reordered inside the visible window — the slot the user wants is
  // off-screen and unreachable, because HTML5 drag events never scroll a
  // container themselves. Only the top-level list scrolls, but a drag hovering
  // inside a folder near the section's edge scrolls it too.
  const startRailAutoScroll = () => {
    if (autoScrollRef.current !== null) return;
    const step = () => {
      autoScrollRef.current = null;
      const el = wsScrollRef.current;
      const scope = dragScopeRef.current;
      const clientY = dragPointerRef.current;
      // The gesture ended, or the pointer left the rail (the coordinate is
      // cleared on dragleave) — stop rather than scroll on a stale position.
      if (!el || !scope || clientY === null) return;
      const rect = el.getBoundingClientRect();
      const delta = railAutoScrollDelta(clientY, rect.top, rect.bottom);
      if (delta !== 0) {
        const limit = el.scrollHeight - el.clientHeight;
        const next = Math.max(0, Math.min(limit, el.scrollTop + delta));
        if (next !== el.scrollTop) {
          el.scrollTop = next;
          // The pointer didn't move but the content under it did, so the
          // insertion index has to be recomputed against the new scroll.
          applyRailPlanAt(scope, clientY);
        }
      }
      autoScrollRef.current = requestAnimationFrame(step);
    };
    autoScrollRef.current = requestAnimationFrame(step);
  };

  // Does this scope accept the drag in flight? Group drags are top-level only;
  // workspace drags go anywhere.
  const railScopeAccepts = (event: React.DragEvent, scope: string): boolean =>
    isWorkspaceGroupDrag(event) ? scope === RAIL_SCOPE_TOP : isWorkspaceDrag(event);

  const handleRailDragOver = (event: React.DragEvent, scope: string) => {
    if (!railScopeAccepts(event, scope)) return;
    event.preventDefault();
    // Claim the event for THIS list: the top-level handler must not also plan
    // a move when the pointer is inside a folder's member list.
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    applyRailPlanAt(scope, event.clientY);
    startRailAutoScroll();
  };

  const handleRailDragLeave = (event: React.DragEvent, scope: string) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (reorderPreviewRef.current?.scope !== scope) return;
    // Left this list: the rows slide home and the ghost fades. Forgetting the
    // pointer also stops edge auto-scroll chasing a coordinate the user has
    // abandoned.
    dragPointerRef.current = null;
    clearReorderPreview();
  };

  // A workspace hovering a folder CARD means "file it in here", which has no
  // slot to point at. Drop whatever preview the top-level list last planned so
  // the two destinations are never promised at once — but keep tracking the
  // pointer, so a drag resting on a folder near the section's edge still
  // scrolls the rail.
  const handleFolderCardDragOver = (event: React.DragEvent) => {
    dragPointerRef.current = event.clientY;
    dragScopeRef.current = RAIL_SCOPE_TOP;
    clearReorderPreview();
    startRailAutoScroll();
  };

  // Resolve the drop from the release position rather than trusting the last
  // dragover: a fast flick can outrun the dragover stream, and the frame the
  // user released on is the one they aimed with.
  const handleRailDrop = (event: React.DragEvent, scope: string) => {
    if (!railScopeAccepts(event, scope)) return;
    event.preventDefault();
    event.stopPropagation();
    const isGroup = isWorkspaceGroupDrag(event);
    const draggedId = isGroup ? draggedWorkspaceGroupId(event) : draggedWorkspaceId(event);
    const node = listNodeForScope(scope);
    // undefined means "no-op": either we could not resolve a plan, or the user
    // released the item back in its own slot.
    let beforeItemId: string | null | undefined;
    if (draggedId && node) {
      const slots = ensureRailSlots(scope);
      const plan = planVerticalReorder(
        slots,
        draggedId,
        railPointerY(node, scope, event.clientY),
        dragHeightRef.current,
      );
      if (plan) beforeItemId = beforeItemForVerticalPlan(slots, plan);
    }
    // Tear the preview down BEFORE committing, so the new order lands in a
    // list with no transforms on it and settles instantly instead of animating
    // backwards out of the preview offsets.
    clearRailDrag();
    if (!draggedId || beforeItemId === undefined) return;
    if (isGroup) {
      props.onReorderWorkspaceRailItem(draggedId, beforeItemId);
      return;
    }
    if (scope === RAIL_SCOPE_TOP) {
      // Two writes: unfile it (it may be coming out of a folder), then place
      // it among the top-level items.
      props.onMoveWorkspace(draggedId, null, null);
      props.onReorderWorkspaceRailItem(draggedId, beforeItemId);
      return;
    }
    props.onMoveWorkspace(draggedId, scope.slice(RAIL_SCOPE_GROUP_PREFIX.length), beforeItemId);
  };

  // One class for both lists: --reordering is what switches the shared slide
  // duration on, and it is dropped in the same commit that applies the new
  // order (see styles.css) so the settle is instant.
  const railListClassName = wsDragId || groupDragId
    ? "spark-workspace-list spark-workspace-list--reordering"
    : "spark-workspace-list";

  // Shared tail of every rail dragstart. Callers set their id REF
  // synchronously (the first dragover needs it); this captures the item's
  // height — what lets a list the item did not come from open a correctly
  // sized slot for it — and defers only the dim, which must not be caught by
  // the browser's drag-image snapshot.
  const beginRailDrag = (event: React.DragEvent<HTMLElement>, dim: () => void) => {
    event.dataTransfer.effectAllowed = "move";
    dragHeightRef.current = event.currentTarget.getBoundingClientRect().height;
    dragDimFrameRef.current = requestAnimationFrame(() => {
      dragDimFrameRef.current = null;
      dim();
    });
  };

  // Rows carry no drop logic of their own: the list they sit in owns the whole
  // gesture (see handleRailDragOver). They only announce the drag and paint
  // the preview's slide offset.
  const renderWorkspaceRows = (items: Workspace[], groupId: string | null): React.ReactNode =>
    items.map((w) => (
      <WorkspaceRow
        key={w.id}
        ws={w}
        active={w.id === props.activeId}
        editing={w.id === props.editingId}
        dragging={wsDragId === w.id}
        dragOffset={reorderPreview?.offsets[w.id] ?? 0}
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
          event.dataTransfer.setData(WORKSPACE_ROW_MIME, w.id);
          // text/plain is a compatibility transport for WebDriver/native drag
          // implementations that discard custom MIME payloads.
          event.dataTransfer.setData("text/plain", w.id);
          wsDragIdRef.current = w.id;
          beginRailDrag(event, () => setWsDragId(w.id));
        }}
        onRowDragEnd={clearWorkspaceDrag}
      />
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
                className={railListClassName}
                // Names the reorder scope this list owns, so the scope a drop
                // resolves against is readable in the DOM.
                data-rail-list={RAIL_SCOPE_TOP}
                style={{
                  flex: 1,
                  overflow: "auto",
                  minHeight: 0,
                  padding: "6px 8px 10px",
                  // Positioning context for the reorder ghost, which is placed
                  // in content coordinates and must scroll with the list.
                  position: "relative",
                  // Matches the horizontal padding above, so the ghost lines up
                  // with the rows rather than with the scroller's edges.
                  ["--ws-list-inset" as string]: "8px",
                }}
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
                // The whole list is the drop target, not the rows: the 4px
                // gaps between rows, the container's padding and the empty run
                // past the last item are all valid ground, so there is no
                // position the user can aim at that silently cancels the drag.
                onDragEnter={(event) => handleRailDragOver(event, RAIL_SCOPE_TOP)}
                onDragOver={(event) => handleRailDragOver(event, RAIL_SCOPE_TOP)}
                onDragLeave={(event) => handleRailDragLeave(event, RAIL_SCOPE_TOP)}
                onDrop={(event) => handleRailDrop(event, RAIL_SCOPE_TOP)}
              >
                <RailReorderGhost
                  preview={reorderPreview?.scope === RAIL_SCOPE_TOP ? reorderPreview : null}
                  accent={accent}
                />
                {workspaces.length === 0 && props.workspaceGroups.length === 0 && (
                  <EmptyState onCreate={onCreate} />
                )}
                {topLevelItemIds.map((itemId) => {
                  const workspace = unfiledWorkspaceById.get(itemId);
                  const group = workspaceGroupById.get(itemId);
                  if (!workspace && !group) return null;
                  const members = group
                    ? workspaces.filter((candidate) => candidate.groupId === group.id)
                    : [];
                  return (
                    <React.Fragment key={itemId}>
                      {workspace
                        ? renderWorkspaceRows([workspace], null)
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
                              event.dataTransfer.setData(WORKSPACE_GROUP_MIME, group.id);
                              groupDragIdRef.current = group.id;
                              beginRailDrag(event, () => setGroupDragId(group.id));
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
                            dragOffset={reorderPreview?.scope === RAIL_SCOPE_TOP
                              ? reorderPreview.offsets[group.id] ?? 0
                              : 0}
                            memberScope={railScopeForGroup(group.id)}
                            memberPreview={
                              reorderPreview?.scope === railScopeForGroup(group.id)
                                ? reorderPreview
                                : null
                            }
                            memberListRef={(node) => {
                              const scope = railScopeForGroup(group.id);
                              if (node) memberListRefs.current.set(scope, node);
                              else memberListRefs.current.delete(scope);
                            }}
                            onMemberDragOver={handleRailDragOver}
                            onMemberDragLeave={handleRailDragLeave}
                            onMemberDrop={handleRailDrop}
                            onCardDragOver={handleFolderCardDragOver}
                            memberListClassName={railListClassName}
                            railAccent={accent}
                          >
                            {!group.collapsed && renderWorkspaceRows(members, group.id)}
                          </WorkspaceFolder>
                        ) : null}
                    </React.Fragment>
                  );
                })}
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
        const ws = props.activeWorkspace;
        const cwd = ws?.cwd ?? null;
        if (!cwd || !ws) {
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
          <>
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
              onAddExternalFolder={props.onAddExternalFolder}
            />
            {/* External folders attached to this workspace: each is its own
                single-root tree stacked under the primary one, sharing the
                Explorer section's collapse state. No gitStatus — decorations
                would resolve against the wrong repo root. The divider above
                each tree drags its height; the choice persists per folder. */}
            {(ws.extraFolders ?? []).map((folder) => (
              <React.Fragment key={folder}>
                {!collapsed.explorer && (
                  <ResizeHandle
                    orientation="row"
                    accent={accent}
                    ariaLabel={`Resize ${folderBasename(folder)} folder tree`}
                    onResizeStart={() => {
                      // No stored height yet means the tree is auto-sized —
                      // snapshot its rendered height so the drag starts from
                      // what the user sees instead of jumping.
                      const el = document.querySelector<HTMLElement>(
                        `[data-external-tree="${cssAttrValue(folder)}"]`,
                      );
                      externalDragStart.current = {
                        startH:
                          externalHeightsRef.current[folder] ??
                          el?.getBoundingClientRect().height ??
                          120,
                        maxH:
                          (el?.parentElement?.clientHeight ?? 600) - EXTERNAL_TREE_RESERVED_H,
                      };
                    }}
                    onResize={(delta) => {
                      // The handle sits above the tree, so dragging down
                      // shrinks it. Clamp between one row and "leave the
                      // primary tree usable".
                      const { startH, maxH } = externalDragStart.current;
                      const next = Math.round(
                        Math.min(
                          Math.max(startH - delta, EXTERNAL_TREE_MIN_H),
                          Math.max(maxH, EXTERNAL_TREE_MIN_H),
                        ),
                      );
                      if (externalHeightsRef.current[folder] === next) return;
                      // Update the ref eagerly, not just via the render
                      // mirror: pointerup can fire before React re-renders,
                      // and the drag-end persist must see the final height.
                      externalHeightsRef.current = {
                        ...externalHeightsRef.current,
                        [folder]: next,
                      };
                      setExternalHeights(externalHeightsRef.current);
                    }}
                    onResizeEnd={() => {
                      try {
                        localStorage.setItem(
                          EXTERNAL_HEIGHTS_KEY,
                          JSON.stringify(externalHeightsRef.current),
                        );
                      } catch {
                        /* persistence is best-effort */
                      }
                    }}
                  />
                )}
                <FileTree
                  cwd={folder}
                  variant="external"
                  activePath={props.activePath}
                  onOpenFile={props.onOpenFileEntry}
                  onDeleteFile={props.onDeleteFile}
                  onRenameFile={props.onRenameFile}
                  onRunPlan={props.onRunPlan}
                  collapsed={collapsed.explorer}
                  onToggleCollapse={() => onToggleSection("explorer")}
                  onRemoveExternalFolder={() => props.onRemoveExternalFolder(ws.id, folder)}
                  heightPx={externalHeights[folder] ?? null}
                />
              </React.Fragment>
            ))}
          </>
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
  dragOffset = 0,
  memberScope,
  memberPreview = null,
  memberListRef,
  memberListClassName = "spark-workspace-list",
  onMemberDragOver,
  onMemberDragLeave,
  onMemberDrop,
  onCardDragOver,
  railAccent,
  menuBoundaryRef,
  isWorkspaceDrag,
  isWorkspaceGroupDrag,
  onDropWorkspace,
  onGroupDragStart,
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
  /** translateY px from the top-level reorder preview. */
  dragOffset?: number;
  /** Reorder scope id of this folder's member list. */
  memberScope?: string;
  /** The live preview when it targets THIS folder's member list. */
  memberPreview?: ReorderPreview | null;
  memberListRef?: (node: HTMLDivElement | null) => void;
  /** Class for the member list — carries the shared reorder-motion variable. */
  memberListClassName?: string;
  onMemberDragOver?: (event: React.DragEvent, scope: string) => void;
  onMemberDragLeave?: (event: React.DragEvent, scope: string) => void;
  onMemberDrop?: (event: React.DragEvent, scope: string) => void;
  /** A workspace is hovering the card itself (not the member list). */
  onCardDragOver?: (event: React.DragEvent) => void;
  /** Rail accent, for the member list's ghost slot. */
  railAccent?: string;
  /** Flip boundary for the folder's "…" AnchoredMenu (the workspaces scroll container). */
  menuBoundaryRef?: React.RefObject<HTMLElement | null>;
  isWorkspaceDrag: (event: React.DragEvent) => boolean;
  isWorkspaceGroupDrag: (event: React.DragEvent) => boolean;
  onDropWorkspace: (event: React.DragEvent) => void;
  onGroupDragStart?: (event: React.DragEvent<HTMLElement>) => void;
  onGroupDragEnd?: () => void;
  onToggle?: () => void;
  onRename?: (name: string) => void;
  onChangeColor?: (color: string) => void;
  onStartRename?: () => void;
  onCancelRename?: () => void;
  onDelete?: () => void;
  children: React.ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const colorInputRef = useRef<HTMLInputElement | null>(null);
  const committedFolderColor = useRef(normalizeHex(accent));
  const latestOnChangeColor = useRef(onChangeColor);
  const folderMenuBtnRef = useRef<HTMLButtonElement>(null);
  const [draftName, setDraftName] = useState(name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const collapsed = group?.collapsed === true;
  const readableAccent = React.useMemo(
    () => resolveWorkspaceAccent(accent).readable,
    [accent, resolvedTheme],
  );

  useEffect(() => setDraftName(name), [name]);
  useEffect(() => {
    latestOnChangeColor.current = onChangeColor;
  }, [onChangeColor]);
  useEffect(() => {
    const color = normalizeHex(accent);
    committedFolderColor.current = color;
    if (colorInputRef.current) colorInputRef.current.value = color;
  }, [accent]);
  useEffect(() => {
    const input = colorInputRef.current;
    if (!input) return;
    const commitColor = () => {
      const color = normalizeHex(input.value);
      if (color === committedFolderColor.current) return;
      committedFolderColor.current = color;
      latestOnChangeColor.current?.(color);
    };
    // React's onChange for a color input follows the native `input` stream,
    // which fires continuously while the picker is dragged. Updating a folder
    // there re-shades every child and persists the whole workspace tree on
    // every pointer sample. Native `change` is the final committed selection.
    input.addEventListener("change", commitColor);
    return () => input.removeEventListener("change", commitColor);
  }, [group?.id, editing]);
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
    // A folder card is ONE item of the top-level list, so a folder-on-folder
    // reorder belongs to that list, not here: group drags are deliberately let
    // through to bubble up to it.
    //
    // A workspace hovering the card itself (the header band, the padding, the
    // "drop workspaces here" placeholder) means "file it in this folder" —
    // claimed here, and shown as a wash on the whole card. Hovering the member
    // list inside means "put it at this exact position", which that list
    // claims first and never reaches us.
    // dragenter is handled identically: it bubbles, so leaving it to the list
    // outside would let a top-level preview flash for a frame on the way in.
    onDragEnter: (event: React.DragEvent) => dragHandlers.onDragOver(event),
    onDragOver: (event: React.DragEvent) => {
      if (isWorkspaceGroupDrag(event) || !isWorkspaceDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropActive(true);
      onCardDragOver?.(event);
    },
    onDragLeave: (event: React.DragEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setDropActive(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (isWorkspaceGroupDrag(event) || !isWorkspaceDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropActive(false);
      onDropWorkspace(event);
    },
    onDragEnd: () => onGroupDragEnd?.(),
  };

  // The card lights up for both ways of landing a workspace here: hovering the
  // card (append) and hovering the member list (exact slot).
  const landing = dropActive || memberPreview !== null;

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
        border: landing
          ? `1px solid color-mix(in oklab, ${accent} 54%, var(--rule))`
          : "1px solid color-mix(in oklab, var(--rule) 72%, transparent)",
        background: landing
          ? `color-mix(in oklab, ${accent} 12%, var(--panel))`
          : "color-mix(in oklab, var(--panel-raised, var(--panel)) 78%, transparent)",
        boxShadow: landing ? `0 0 18px color-mix(in oklab, ${accent} 18%, transparent)` : "var(--lift-hi)",
        opacity: dragging ? 0.46 : 1,
        // Compositor-only slide while a top-level reorder is previewing.
        ...(dragOffset ? { transform: `translate3d(0, ${dragOffset}px, 0)` } : {}),
        backdropFilter: "blur(18px) saturate(125%)",
        WebkitBackdropFilter: "blur(18px) saturate(125%)",
        // See the row: --ws-reorder-motion is 0s at rest, so the committed
        // order settles instantly instead of animating backwards out of the
        // offsets it was previewing.
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--ws-reorder-motion, 0s) var(--ease-out-fast)",
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
        <FolderGlyph color={group ? readableAccent : "var(--muted)"} open={!collapsed} />
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
              color: readableAccent,
              border: "none",
              borderBottom: `1px solid ${readableAccent}`,
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
              color: readableAccent,
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
                  onClick={() => {
                    // The native picker is outside the portalled menu below,
                    // so closing the menu cannot unmount its owning input and
                    // kill the picker on the user's first interaction.
                    setMenuOpen(false);
                    colorInputRef.current?.click();
                  }}
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
            <input
              ref={colorInputRef}
              type="color"
              defaultValue={normalizeHex(accent)}
              tabIndex={-1}
              aria-hidden="true"
              style={{ position: "absolute", width: 0, height: 0, opacity: 0 }}
            />
          </div>
        )}
      </div>
      {!collapsed && (
        <div style={{ paddingTop: count > 0 ? 2 : 0 }}>
          {/* The member list is its own reorder scope: one hit-test, one ghost
              slot, exactly like the top level. It claims its own drag events so
              the list outside never plans a move for a pointer that is in here.
              Rendered even when empty so the ref survives the folder filling up
              mid-drag; with no rows it has no height, so the card's own
              "append here" wash is what the user sees. */}
          <div
            ref={memberListRef}
            className={memberListClassName}
            data-rail-list={memberScope}
            style={{ position: "relative" }}
            onDragEnter={(event) => memberScope && onMemberDragOver?.(event, memberScope)}
            onDragOver={(event) => memberScope && onMemberDragOver?.(event, memberScope)}
            onDragLeave={(event) => memberScope && onMemberDragLeave?.(event, memberScope)}
            onDrop={(event) => memberScope && onMemberDrop?.(event, memberScope)}
          >
            {count > 0 && (
              <RailReorderGhost preview={memberPreview} accent={railAccent ?? accent} />
            )}
            {children}
          </div>
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

/**
 * The macOS-style drop preview: a placeholder the exact size and shape of the
 * row (or folder card) in flight, sitting in the hole its neighbours slid
 * apart to open. The destination reads as a SLOT the item drops into, not as a
 * line between two things — so there is never a choice to make between "after
 * item N" and "before item N+1" for what is one destination.
 *
 * One per list, owned by the list. Kept mounted for the whole gesture and
 * merely faded out on a home drop, so it glides between destinations instead
 * of blinking in and out.
 */
function RailReorderGhost({
  preview,
  accent,
}: {
  preview: ReorderPreview | null;
  accent: string;
}) {
  if (!preview) return null;
  return (
    <div
      aria-hidden
      className={
        preview.changed
          ? "spark-workspace-reorder-ghost spark-workspace-reorder-ghost--visible"
          : "spark-workspace-reorder-ghost"
      }
      style={{
        // Whole-pixel so the hairline stays crisp.
        height: Math.round(preview.ghostHeight),
        transform: `translate3d(0, ${Math.round(preview.ghostStart)}px, 0)`,
        borderColor: `color-mix(in oklab, ${accent} 52%, var(--rule))`,
        background: `color-mix(in oklab, ${accent} 10%, transparent)`,
      }}
    />
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
  /** translateY px from the live reorder preview — the row's slide. */
  dragOffset?: number;
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
  onRowDragEnd: () => void;
}

function WorkspaceRow({
  ws,
  active,
  editing,
  dragging,
  dragOffset = 0,
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
        // Compositor-only slide, so a row opening the landing gap never
        // reflows the list. The dragged row itself always sits at 0: it stays
        // put and dims, and the drag image is what follows the cursor.
        ...(dragOffset ? { transform: `translate3d(0, ${dragOffset}px, 0)` } : {}),
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
        // --ws-reorder-motion is 0s at rest and the reorder curve for the
        // length of a drag; the list owns it (see styles.css), because an
        // inline transition is not something a class or a media query could
        // override.
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--ws-reorder-motion, 0s) var(--ease-out-fast)",
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
