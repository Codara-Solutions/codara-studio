import React, { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { FsEntry, RunState, Workspace } from "@shared/types";
import { MinusIcon, PlusIcon } from "./icons";
import FileTree from "./FileTree";
import GitPanel from "./git/GitPanel";
import OrchestrationSidebar from "./OrchestrationSidebar";
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
  "#F0C419",
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
  agent: "Spark",
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
  // The first section's share when exactly two sections are stacked here.
  split: number;
  collapsed: Record<PanelSectionKey, boolean>;
  activePath: string | null;
  runs: RunState[];
  activeRunId: string | null;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onChange: (id: string, patch: Partial<Workspace>) => void;
  onPreviewColor: (id: string, color: string) => void;
  onDelete: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onCloseEditor: () => void;
  onCreate: () => void;
  onSplitChange: (ratio: number) => void;
  onToggleSection: (section: PanelSectionKey) => void;
  onMoveSection: (section: PanelSectionKey, side: PanelSide, index: number) => void;
  onSectionDragStart: (section: PanelSectionKey) => void;
  onSectionDragEnd: () => void;
  onSelectRun: (id: string | null) => void;
  onRunSnapshot: (
    run: RunState,
    options?: { select?: boolean; focusRuns?: boolean },
  ) => void;
  onOpenFile: (absolutePath: string) => void;
  onOpenFileEntry: (entry: FsEntry, options?: { preview?: boolean }) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: (oldPath: string, entry: FsEntry) => void;
  onRunPlan: (entry: FsEntry) => void;
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
                      onActivate={() => props.onActivate(w.id)}
                      onEdit={() => props.onEdit(w.id)}
                      onChange={(patch) => props.onChange(w.id, patch)}
                      onPreviewColor={(color) => props.onPreviewColor(w.id, color)}
                      onCloseEditor={props.onCloseEditor}
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
      case "agent":
        return (
          <OrchestrationSidebar
            workspace={props.activeWorkspace}
            runs={props.runs}
            activeRunId={props.activeRunId}
            onSelectRun={props.onSelectRun}
            onRunSnapshot={props.onRunSnapshot}
            collapsed={collapsed.agent}
            onToggleCollapse={() => onToggleSection("agent")}
            headerDrag={headerDrag("agent")}
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
        margin: "2px 4px",
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
  const active = hover && !disabled;
  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) onClick();
      }}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 20,
        height: 20,
        border: "1px solid var(--rule-soft)",
        borderRadius: 4,
        background: active
          ? danger
            ? "var(--danger-soft)"
            : "var(--hover)"
          : "transparent",
        color: disabled
          ? "var(--muted-2)"
          : active && danger
            ? "var(--danger)"
            : active
              ? "var(--ink)"
              : "var(--ink-dim)",
        display: "grid",
        placeItems: "center",
        cursor: disabled ? "not-allowed" : "default",
        padding: 0,
        opacity: disabled ? 0.42 : 1,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ padding: "18px 6px", lineHeight: 1.55 }}>
      <div style={{ marginBottom: 4, fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
        No workspaces yet
      </div>
      <div style={{ marginBottom: 16, fontSize: 12, color: "var(--muted)" }}>
        Create one to start orchestrating workers.
      </div>
      <button
        type="button"
        onClick={onCreate}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none",
          background: hover ? "var(--hover)" : "transparent",
          border: "1px solid var(--rule-strong)",
          color: hover ? "var(--ink)" : "var(--ink-dim)",
          padding: "6px 10px",
          fontSize: 11,
          letterSpacing: "0.08em",
          fontWeight: 600,
          cursor: "default",
          fontFamily: "inherit",
          textTransform: "uppercase",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        + New workspace
      </button>
    </div>
  );
}

interface RowProps {
  ws: Workspace;
  active: boolean;
  editing: boolean;
  dragging: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onChange: (patch: Partial<Workspace>) => void;
  onPreviewColor: (color: string) => void;
  onCloseEditor: () => void;
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
  onActivate,
  onEdit,
  onChange,
  onPreviewColor,
  onCloseEditor,
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
  const [moreHover, setMoreHover] = useState(false);
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

  const commitName = () => {
    const v = name.trim();
    if (v && v !== ws.name) onChange({ name: v });
  };

  const background = active
    ? "color-mix(in oklch, var(--ink) 4%, var(--panel))"
    : editing
      ? "color-mix(in oklch, var(--ink) 6%, var(--panel))"
      : rowHover
        ? "color-mix(in oklch, var(--ink) 5%, transparent)"
        : "color-mix(in oklch, var(--ink) 2%, transparent)";

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
      onMouseLeave={() => setRowHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        minHeight: 32,
        padding: editing ? "5px 7px 5px 9px" : "5px 6px 5px 9px",
        background,
        cursor: "default",
        opacity: dragging ? 0.4 : 1,
        position: "relative",
        border: active
          ? `1px solid color-mix(in oklch, ${accent} 48%, var(--rule-strong))`
          : editing
            ? `1px solid color-mix(in oklch, ${accent} 35%, var(--rule-soft))`
            : "1px solid transparent",
        borderRadius: 7,
        boxShadow: active
          ? `0 0 0 1px color-mix(in oklch, ${accent} 18%, transparent), 0 8px 18px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.035)`
          : rowHover || editing
            ? "inset 0 1px 0 rgba(255, 255, 255, 0.035)"
            : "none",
        marginBottom: 5,
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 }}>
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
            width: active ? 9 : 8,
            height: active ? 9 : 8,
            borderRadius: 999,
            background: accent,
            flex: `0 0 ${active ? 9 : 8}px`,
            cursor: "default",
            boxShadow: editing
              ? `0 0 0 3px color-mix(in oklch, ${accent} 24%, transparent)`
              : active
                ? `0 0 0 3px color-mix(in oklch, ${accent} 16%, transparent), 0 0 12px color-mix(in oklch, ${accent} 42%, transparent)`
                : "0 0 0 2px color-mix(in oklch, var(--ink) 4%, transparent)",
          }}
        />
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
              borderBottom: `1px solid ${accent}`,
              color: "var(--ink)",
              fontFamily: "inherit",
              fontSize: 14,
              fontWeight: 600,
              padding: "3px 0",
              outline: "none",
            }}
          />
        ) : (
          <div style={{ display: "flex", alignItems: "center", minWidth: 0, flex: 1 }}>
            <span
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

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (editing) {
              commitName();
              onCloseEditor();
            } else {
              onEdit();
            }
          }}
          onMouseEnter={() => setMoreHover(true)}
          onMouseLeave={() => setMoreHover(false)}
          title={editing ? "Done" : "Edit workspace"}
          style={{
            appearance: "none",
            background: editing
              ? "transparent"
              : moreHover
                ? "transparent"
                : "transparent",
            border: "none",
            borderRadius: 0,
            color: editing ? accent : moreHover || active ? "var(--ink-dim)" : "var(--muted-2)",
            width: 18,
            height: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "default",
            padding: 0,
            flex: "0 0 18px",
            opacity: moreHover || active || editing ? 1 : 0.72,
            transition:
              "color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
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

export { WORKSPACE_COLORS };
