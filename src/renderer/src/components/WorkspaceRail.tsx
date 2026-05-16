import React, { useEffect, useRef, useState } from "react";
import type { Workspace } from "@shared/types";
import { MinusIcon, PlusIcon } from "./icons";
import GitGraph from "./GitGraph";

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

interface RailProps {
  workspaces: Workspace[];
  activeId: string | null;
  editingId: string | null;
  width: number;
  activeWorkspace: Workspace | null;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onChange: (id: string, patch: Partial<Workspace>) => void;
  onPreviewColor: (id: string, color: string) => void;
  onDelete: (id: string) => void;
  onCloseEditor: () => void;
  onCreate: () => void;
}

// Memoized: App hoists every prop to a stable reference (the `workspaces`
// array changes only on a real workspace mutation; `onActivate`/`onEdit`/
// `onChange`/`onDelete`/`onCloseEditor`/`onCreate` are all useCallback). So
// the rail skips re-renders driven by unrelated App state — most importantly
// the live `--accent` color drag, which previously repainted the whole rail.
function WorkspaceRail(props: RailProps) {
  const { workspaces, width, onCreate } = props;
  const deleteActiveWorkspace = () => {
    if (!props.activeId) return;
    props.onCloseEditor();
    props.onDelete(props.activeId);
  };
  return (
    <aside
      style={{
        width,
        flex: `0 0 ${width}px`,
        background: "var(--panel)",
        borderRight: "1px solid var(--rule)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ flex: "1 1 50%", overflow: "auto", minHeight: 0 }}>
          <RailSectionHeader
            label="WORKSPACES"
            count={workspaces.length}
            onCreate={onCreate}
            onDelete={deleteActiveWorkspace}
            deleteDisabled={!props.activeId}
          />
          <div style={{ padding: "2px 8px 10px" }}>
            {workspaces.length === 0 && <EmptyState onCreate={onCreate} />}
            {workspaces.map((w) => (
              <WorkspaceRow
                key={w.id}
                ws={w}
                active={w.id === props.activeId}
                editing={w.id === props.editingId}
                onActivate={() => props.onActivate(w.id)}
                onEdit={() => props.onEdit(w.id)}
                onChange={(patch) => props.onChange(w.id, patch)}
                onPreviewColor={(color) => props.onPreviewColor(w.id, color)}
                onCloseEditor={props.onCloseEditor}
              />
            ))}
          </div>
        </div>
        <GitGraph cwd={props.activeWorkspace?.cwd ?? null} />
      </div>
    </aside>
  );
}

export default React.memo(WorkspaceRail);

function RailSectionHeader({
  label,
  count,
  onCreate,
  onDelete,
  deleteDisabled = false,
}: {
  label: string;
  count: number;
  onCreate?: () => void;
  onDelete?: () => void;
  deleteDisabled?: boolean;
}) {
  return (
    <div
      style={{
        padding: "14px 10px 9px 14px",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 9,
        letterSpacing: "0.18em",
        fontWeight: 700,
        color: "var(--muted)",
        textTransform: "uppercase",
      }}
    >
      <span>{label}</span>
      <span style={{ flex: 1, height: 1, background: "var(--rule-soft)" }} />
      <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
        {String(count).padStart(2, "0")}
      </span>
      {onCreate && (
        <RailIconButton
          title="New workspace"
          onClick={onCreate}
        >
          <PlusIcon size={11} />
        </RailIconButton>
      )}
      {onDelete && (
        <RailIconButton
          title={deleteDisabled ? "Select a workspace to delete" : "Delete selected workspace"}
          onClick={onDelete}
          disabled={deleteDisabled}
          danger
        >
          <MinusIcon size={11} />
        </RailIconButton>
      )}
    </div>
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
  onActivate: () => void;
  onEdit: () => void;
  onChange: (patch: Partial<Workspace>) => void;
  onPreviewColor: (color: string) => void;
  onCloseEditor: () => void;
}

function WorkspaceRow({
  ws,
  active,
  editing,
  onActivate,
  onEdit,
  onChange,
  onPreviewColor,
  onCloseEditor,
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
