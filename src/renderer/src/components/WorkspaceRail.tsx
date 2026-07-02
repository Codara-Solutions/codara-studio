import React, { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ChatBackendKind, FsEntry, RunState, Workspace } from "@shared/types";
import type { ChatStatusTone } from "./chat/timeline";
import { statusToneColor } from "./chat/timeline";
import { MinusIcon, PlusIcon } from "./icons";
import FileTree from "./FileTree";
import GitPanel from "./git/GitPanel";
import {
  PANEL_HEADER_H,
  PANEL_SECTION_KEYS,
  sectionSlotStyles,
  type PanelSectionKey,
  type PanelSide,
} from "../panels/usePanelLayout";
import ResizeHandle from "../panels/ResizeHandle";
import SectionHeader from "../panels/SectionHeader";

const WORKSPACE_COLORS = [
  "#2AA298",
  "#7FB3FF",
  "#5BD68F",
  "#FF5C2B",
  "#C99BFF",
  "#E0E0E0",
  "#FF8FB1",
  "#5DD6D6",
];

const PANEL_SECTION_MIME = "application/x-spark-panel-section";
const WORKSPACE_ROW_MIME = "application/x-spark-workspace-row";

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
  activeId: string | null;
  editingId: string | null;
  width: number;
  activeWorkspace: Workspace | null;
  // Per-workspace status-tone rollup (the max-attention tone across that
  // workspace's runs). Drives the small status dot on each rail row. App
  // passes a memoized object so this prop stays referentially stable and the
  // rail's React.memo keeps holding off unrelated re-renders.
  toneByWorkspaceId?: Record<string, ChatStatusTone | null>;
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
  onReorder: (fromIndex: number, toIndex: number) => void;
  onCloseEditor: () => void;
  onCreate: () => void;
  onSplitChange: (ratio: number) => void;
  onToggleSection: (section: PanelSectionKey) => void;
  onMoveSection: (section: PanelSectionKey, side: PanelSide, index: number) => void;
  onSectionDragStart: (section: PanelSectionKey) => void;
  onSectionDragEnd: () => void;
  onRunSnapshot: (
    run: RunState,
    options?: { select?: boolean; focusRuns?: boolean },
  ) => void;
  onOpenFile: (absolutePath: string) => void;
  onOpenFileEntry: (entry: FsEntry, options?: { preview?: boolean }) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: (oldPath: string, entry: FsEntry) => void;
  onRunPlan: (entry: FsEntry, backend?: ChatBackendKind) => void;
}

// Memoized: App hoists every prop to a stable reference (the `workspaces`
// array changes only on a real workspace mutation; `onActivate`/`onEdit`/
// `onChange`/`onDelete`/`onCloseEditor`/`onCreate` are all useCallback). So
// the rail skips re-renders driven by unrelated App state — most importantly
// the live `--accent` color drag, which previously repainted the whole rail.
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
  // ── Workspace row reorder ────────────────────────────────────────────────
  // `wsDragIndex` is the index of the row currently being dragged (so it can
  // render dimmed); `wsDropIndex` is the insertion index where a drop would
  // land (a small horizontal line is drawn before that index, or after the
  // last row when equal to workspaces.length).
  const [wsDragIndex, setWsDragIndex] = useState<number | null>(null);
  const [wsDropIndex, setWsDropIndex] = useState<number | null>(null);
  const deleteActiveWorkspace = () => {
    if (!props.activeId) return;
    props.onCloseEditor();
    props.onDelete(props.activeId);
  };

  // Section-divider drag: snapshot the split ratio and the body height at
  // drag start, then translate a pointer delta into a ratio delta. The hook's
  // setter clamps, so an over-drag is harmless.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const splitAtDragStart = useRef(split);
  const bodyHeightAtDragStart = useRef(1);

  const accent = props.activeWorkspace?.color || "var(--accent)";
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

  const renderSection = (section: PanelSectionKey): React.ReactNode => {
    switch (section) {
      case "workspaces":
        return (
          <>
            <SectionHeader
              label="Workspaces"
              count={workspaces.length}
              collapsed={collapsed.workspaces}
              onToggleCollapse={() => onToggleSection("workspaces")}
              {...headerDrag("workspaces")}
              actions={
                <>
                  <RailIconButton title="New workspace" onClick={onCreate}>
                    <PlusIcon size={11} />
                  </RailIconButton>
                  <RailIconButton
                    title={
                      props.activeId
                        ? "Delete selected workspace"
                        : "Select a workspace to delete"
                    }
                    onClick={deleteActiveWorkspace}
                    disabled={!props.activeId}
                    danger
                  >
                    <MinusIcon size={11} />
                  </RailIconButton>
                </>
              }
            />
            {!collapsed.workspaces && (
              <div
                style={{ flex: 1, overflow: "auto", minHeight: 0, padding: "6px 8px 10px" }}
                onDragOver={(event) => {
                  if (wsDragIndex === null) return;
                  // Drop into the empty space below the last row → append.
                  if (event.target === event.currentTarget) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                    setWsDropIndex(workspaces.length);
                  }
                }}
                onDrop={(event) => {
                  if (wsDragIndex === null) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const to = wsDropIndex ?? workspaces.length;
                  if (wsDragIndex !== to && wsDragIndex + 1 !== to) {
                    props.onReorder(wsDragIndex, to);
                  }
                  setWsDragIndex(null);
                  setWsDropIndex(null);
                }}
              >
                {workspaces.length === 0 && <EmptyState onCreate={onCreate} />}
                {workspaces.map((w, index) => (
                  <React.Fragment key={w.id}>
                    {wsDropIndex === index && wsDragIndex !== null && (
                      <RowDropIndicator accent={accent} />
                    )}
                    <WorkspaceRow
                      ws={w}
                      active={w.id === props.activeId}
                      editing={w.id === props.editingId}
                      dragging={wsDragIndex === index}
                      tone={props.toneByWorkspaceId?.[w.id] ?? null}
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
                        event.dataTransfer.setData("text/plain", w.name);
                        setWsDragIndex(index);
                      }}
                      onRowDragOver={(event) => {
                        if (wsDragIndex === null) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = "move";
                        const rect = event.currentTarget.getBoundingClientRect();
                        const insertIndex =
                          event.clientY < rect.top + rect.height / 2 ? index : index + 1;
                        setWsDropIndex(insertIndex);
                      }}
                      onRowDrop={(event) => {
                        if (wsDragIndex === null) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();
                        const to =
                          event.clientY < rect.top + rect.height / 2 ? index : index + 1;
                        if (wsDragIndex !== to && wsDragIndex + 1 !== to) {
                          props.onReorder(wsDragIndex, to);
                        }
                        setWsDragIndex(null);
                        setWsDropIndex(null);
                      }}
                      onRowDragEnd={() => {
                        setWsDragIndex(null);
                        setWsDropIndex(null);
                      }}
                    />
                  </React.Fragment>
                ))}
                {wsDropIndex === workspaces.length && wsDragIndex !== null && (
                  <RowDropIndicator accent={accent} />
                )}
              </div>
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
            onRunSnapshot={props.onRunSnapshot}
            onOpenFile={props.onOpenFile}
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
        background: active ? `color-mix(in oklch, ${accent} 8%, transparent)` : "transparent",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    />
  );
}

function RailIconButton({
  title,
  onClick,
  disabled = false,
  danger = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const active = hover && !disabled;
  return (
    <button
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
}

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
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuWrapRef.current && e.target instanceof Node && !menuWrapRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
    ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
    : active
      ? `color-mix(in oklch, ${accent} 14%, var(--panel))`
      : editing
        ? `color-mix(in oklch, ${accent} 9%, var(--panel))`
        : rowHover
          ? "var(--hover, color-mix(in oklch, var(--ink) 5%, transparent))"
          : "transparent";

  return (
    <div
      ref={rowRef}
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
          ? `1px solid color-mix(in oklch, ${accent} 24%, var(--rule-soft))`
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
          <BranchGlyph color={accent} active={active} />
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (editing) colorRef.current?.click();
            }}
            tabIndex={editing ? 0 : -1}
            title={editing ? "Change color" : undefined}
            style={{
              appearance: "none",
              border: "none",
              padding: 0,
              // Constant 8px advance in every state so toggling active /
              // editing never nudges the label. Active reads purely through
              // the glow (box-shadow), never a size bump. BranchGlyph shares
              // this exact 8px advance so the copy-branch swap never reflows.
              width: 8,
              height: 8,
              borderRadius: 999,
              background: accent,
              flex: "0 0 8px",
              cursor: "default",
              // No resting ink ring — the idle list settles flat. The active /
              // editing dot earns a SOFT COLORED GLOW RING in its own color so
              // the eye lands on it; the 8px advance never changes (glow only).
              boxShadow: editing
                ? `0 0 0 3px color-mix(in oklch, ${accent} 26%, transparent)`
                : active
                  ? `0 0 0 3px color-mix(in oklch, ${accent} 22%, transparent), 0 0 10px color-mix(in oklch, ${accent} 50%, transparent)`
                  : "none",
            }}
          />
        )}
        <StatusDot tone={tone} />
        {editing && (
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
              title={ws.name}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: active ? "var(--ink)" : "var(--ink-dim)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {ws.name}
            </span>
          </div>
        )}

        <div ref={menuWrapRef} style={{ position: "relative", flex: "0 0 18px" }}>
          <button
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
          {menuOpen && !editing && (
            <div
              role="menu"
              className="spark-menu"
              style={{
                position: "absolute",
                top: 24,
                right: 0,
                minWidth: 168,
                padding: 4,
                zIndex: 20,
                display: "grid",
                gap: 2,
              }}
            >
              <RowMenuItem
                label="Edit"
                onClick={() => {
                  setMenuOpen(false);
                  onEdit();
                }}
              />
              <RowMenuItem
                label="Create copy"
                onClick={() => {
                  setMenuOpen(false);
                  onCreateCopyBranch();
                }}
              />
              <RowMenuItem
                label="Delete"
                danger
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              />
            </div>
          )}
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
        boxShadow: `0 0 0 2px color-mix(in oklch, ${color} 18%, transparent)`,
      }}
    />
  );
}

// Branch glyph shown in place of the color dot on copy-branch workspace rows,
// tinted with the inherited (parent) color so the row reads as a branch of it.
function BranchGlyph({ color, active }: { color: string; active: boolean }) {
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
        // Mirrors the color dot's active treatment: a soft glow in the row's
        // own color so the branch glyph reads as the selected mark, no halo.
        filter: active
          ? `drop-shadow(0 0 6px color-mix(in oklch, ${color} 50%, transparent))`
          : "none",
      }}
    >
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

export { WORKSPACE_COLORS };
