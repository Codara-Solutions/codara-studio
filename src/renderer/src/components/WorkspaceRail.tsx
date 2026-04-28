import React, { useEffect, useRef, useState } from "react";
import type { Workspace } from "@shared/types";
import { PlusIcon } from "./icons";

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
      <RailHeader onCreate={onCreate} />
      <div style={{ flex: 1, overflow: "auto" }}>
        <RailSectionHeader label="WORKSPACES" count={workspaces.length} />
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
    </aside>
  );
}

function RailHeader({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderBottom: "1px solid var(--rule)",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          border: "1px solid var(--ink)",
          display: "grid",
          placeItems: "center",
          fontWeight: 800,
          fontSize: 11,
        }}
      >
        S
      </div>
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
        <span style={{ fontWeight: 700, letterSpacing: "0.04em" }}>SPARK</span>
        <span style={{ fontSize: 10, color: "var(--muted)" }}>v0.1 · {navPlatformLabel()}</span>
      </div>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onCreate}
        title="New workspace"
        style={{
          width: 22,
          height: 22,
          border: "1px solid var(--rule)",
          background: "transparent",
          color: "var(--ink-dim)",
          display: "grid",
          placeItems: "center",
          cursor: "default",
          padding: 0,
        }}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

function navPlatformLabel(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("linux")) return "linux";
  return "desktop";
}

function RailSectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        padding: "10px 14px 6px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 10,
        letterSpacing: "0.14em",
        fontWeight: 700,
        color: "var(--muted)",
      }}
    >
      <span>{label}</span>
      <span style={{ flex: 1, height: 1, background: "var(--rule)" }} />
      <span style={{ color: "var(--muted)" }}>{String(count).padStart(2, "0")}</span>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ padding: "20px 14px", color: "var(--muted)", fontSize: 11, lineHeight: 1.6 }}>
      <div style={{ marginBottom: 12 }}>No workspaces yet.</div>
      <button
        type="button"
        onClick={onCreate}
        style={{
          appearance: "none",
          background: "transparent",
          border: "1px solid var(--rule-strong)",
          color: "var(--ink-dim)",
          padding: "6px 10px",
          fontSize: 11,
          letterSpacing: "0.08em",
          fontWeight: 700,
          cursor: "default",
          fontFamily: "inherit",
        }}
      >
        + NEW WORKSPACE
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

  return (
    <div
      ref={rowRef}
      onClick={editing ? undefined : onActivate}
      style={{
        display: "flex",
        flexDirection: "column",
        padding: editing ? "8px 14px 10px" : "8px 14px",
        borderLeft: active || editing ? `2px solid ${accent}` : "2px solid transparent",
        background: editing || active ? "var(--panel-2)" : "transparent",
        cursor: "default",
        position: "relative",
        borderTop: editing ? "1px solid var(--rule)" : "none",
        borderBottom: editing ? "1px solid var(--rule)" : "none",
        marginTop: editing ? -1 : 0,
        marginBottom: editing ? -1 : 0,
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
            background: accent,
            flex: "0 0 10px",
            cursor: editing ? "default" : "default",
            outline: editing ? "1px solid var(--rule-strong)" : "none",
            outlineOffset: 2,
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
              fontSize: 13,
              fontWeight: 700,
              padding: "3px 0",
              outline: "none",
            }}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
            <span
              style={{
                fontWeight: active ? 700 : 500,
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
                fontSize: 10,
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
          title={editing ? "Done" : "Edit workspace"}
          style={{
            appearance: "none",
            background: "transparent",
            border: "none",
            color: editing ? accent : "var(--muted)",
            width: 22,
            height: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "default",
            padding: 0,
            flex: "0 0 22px",
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
            <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
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
            marginTop: 8,
            paddingLeft: 20,
            display: "flex",
            alignItems: "center",
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCloseEditor();
              onDelete();
            }}
            title="Delete workspace"
            style={{
              appearance: "none",
              background: "transparent",
              border: "none",
              color: "var(--muted)",
              fontFamily: "inherit",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.14em",
              padding: "2px 0",
              cursor: "default",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
          >
            DELETE
          </button>
        </div>
      )}
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
