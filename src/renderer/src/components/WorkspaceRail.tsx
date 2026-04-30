import React, { useEffect, useRef, useState } from "react";
import type { Workspace } from "@shared/types";
import { PlusIcon } from "./icons";
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
  onDelete: (id: string) => void;
  onCloseEditor: () => void;
  onCreate: () => void;
}

export default function WorkspaceRail(props: RailProps) {
  const { workspaces, width, onCreate } = props;
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
          <RailSectionHeader label="WORKSPACES" count={workspaces.length} onCreate={onCreate} />
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
              onDelete={() => props.onDelete(w.id)}
              onCloseEditor={props.onCloseEditor}
            />
          ))}
        </div>
        <GitGraph cwd={props.activeWorkspace?.cwd ?? null} />
      </div>
    </aside>
  );
}

function RailSectionHeader({
  label,
  count,
  onCreate,
}: {
  label: string;
  count: number;
  onCreate?: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{
        padding: "14px 12px 8px 14px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 10,
        letterSpacing: "0.14em",
        fontWeight: 600,
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
        <button
          type="button"
          onClick={onCreate}
          title="New workspace"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            width: 22,
            height: 22,
            border: "1px solid var(--rule-soft)",
            background: hover ? "var(--hover)" : "transparent",
            color: hover ? "var(--ink)" : "var(--ink-dim)",
            display: "grid",
            placeItems: "center",
            cursor: "default",
            padding: 0,
            marginLeft: 2,
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
          }}
        >
          <PlusIcon size={11} />
        </button>
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ padding: "20px 14px", lineHeight: 1.55 }}>
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
  onDelete: () => void;
  onCloseEditor: () => void;
}

function WorkspaceRow({
  ws,
  active,
  editing,
  onActivate,
  onEdit,
  onChange,
  onDelete,
  onCloseEditor,
}: RowProps) {
  const accent = ws.color || "var(--accent)";
  const inputRef = useRef<HTMLInputElement | null>(null);
  const colorRef = useRef<HTMLInputElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [name, setName] = useState(ws.name);
  const [rowHover, setRowHover] = useState(false);
  const [moreHover, setMoreHover] = useState(false);

  useEffect(() => setName(ws.name), [ws.id, ws.name]);
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
    ? "color-mix(in oklch, var(--accent) 12%, var(--panel-2))"
    : editing
      ? "var(--panel-2)"
      : rowHover
        ? "var(--hover)"
        : "transparent";

  return (
    <div
      ref={rowRef}
      onClick={editing ? undefined : onActivate}
      onMouseEnter={() => setRowHover(true)}
      onMouseLeave={() => setRowHover(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        padding: editing ? "8px 14px 12px" : "8px 14px",
        background,
        cursor: "default",
        position: "relative",
        borderTop: editing ? "1px solid var(--rule-soft)" : "none",
        borderBottom: editing ? "1px solid var(--rule-soft)" : "none",
        marginTop: editing ? -1 : 0,
        marginBottom: editing ? -1 : 0,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
            width: 10,
            height: 10,
            borderRadius: 2,
            background: accent,
            flex: "0 0 10px",
            cursor: "default",
            boxShadow: editing
              ? "0 0 0 2px var(--rule-strong)"
              : "inset 0 0 0 1px color-mix(in oklch, black 25%, transparent), 0 1px 2px rgba(0,0,0,0.25)",
          }}
        />
        {editing && (
          <input
            ref={colorRef}
            type="color"
            value={normalizeHex(ws.color)}
            onChange={(e) => onChange({ color: e.target.value })}
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
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, gap: 2 }}>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: active ? "var(--ink)" : "var(--ink-dim)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {ws.name}
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontWeight: 400,
                color: "var(--muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {ws.cwd}
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
            background: moreHover ? "var(--hover-strong)" : "transparent",
            border: "none",
            color: editing ? accent : moreHover ? "var(--ink)" : "var(--muted)",
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "default",
            padding: 4,
            flex: "0 0 24px",
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
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

      {editing && (
        <div
          style={{
            marginTop: 12,
            paddingLeft: 20,
            display: "flex",
            alignItems: "center",
          }}
        >
          <DeleteButton
            onClick={(e) => {
              e.stopPropagation();
              onCloseEditor();
              onDelete();
            }}
          />
        </div>
      )}
    </div>
  );
}

function DeleteButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Delete workspace"
      style={{
        appearance: "none",
        background: hover ? "var(--danger-soft)" : "transparent",
        border: "none",
        color: hover ? "var(--danger)" : "var(--muted)",
        fontFamily: "inherit",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        padding: "4px 8px",
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      Delete
    </button>
  );
}

function normalizeHex(c: string): string {
  // <input type="color"> only accepts #rrggbb. Reject anything else and fall
  // back to a default so React doesn't warn about a non-conforming value.
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  return "#f0c419";
}

export { WORKSPACE_COLORS };
