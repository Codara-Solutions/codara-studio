import { useEffect, useMemo, useRef, useState } from "react";
import { WORKSPACE_COLORS } from "@shared/workspace-colors";
import {
  WORKSPACE_ICON_CATEGORIES,
  WorkspaceIconGlyph,
  searchWorkspaceIcons,
  type WorkspaceIconCategory,
} from "./workspace-icons";

// Body of the "Change icon…" popover: search, category chips, the glyph grid,
// and (unless the folder owns the shade) the color swatches. Parent supplies
// the AnchoredMenu shell so this stays a plain controlled panel.
export default function WorkspaceIconPicker({
  icon,
  color,
  colorLocked,
  onPickIcon,
  onPickColor,
}: {
  icon: string | undefined;
  color: string;
  /** The workspace sits in a folder whose family color assigns its shade. */
  colorLocked: boolean;
  onPickIcon: (id: string) => void;
  onPickColor: (color: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<WorkspaceIconCategory | "all">("all");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const results = useMemo(() => searchWorkspaceIcons(query, category), [query, category]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  return (
    <div
      data-testid="workspace-icon-picker"
      style={{ width: 268, padding: 8, display: "grid", gap: 8 }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <input
        ref={searchRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search icons…"
        aria-label="Search icons"
        style={{
          appearance: "none",
          width: "100%",
          boxSizing: "border-box",
          fontFamily: "inherit",
          fontSize: 12,
          padding: "6px 9px",
          borderRadius: "var(--radius-control, 7px)",
          border: "1px solid var(--rule-soft)",
          background: "color-mix(in oklab, var(--ink) 4%, transparent)",
          color: "var(--ink)",
          outline: "none",
        }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {WORKSPACE_ICON_CATEGORIES.map((entry) => {
          const on = entry.id === category;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setCategory(entry.id)}
              style={{
                appearance: "none",
                border: `1px solid ${on ? "var(--rule-soft)" : "transparent"}`,
                background: on ? "var(--hover)" : "transparent",
                color: on ? "var(--ink)" : "var(--muted)",
                fontFamily: "inherit",
                fontSize: 10.5,
                fontWeight: 500,
                padding: "2px 7px",
                borderRadius: 999,
                cursor: "default",
              }}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      <div
        role="listbox"
        aria-label="Workspace icons"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 3,
          maxHeight: 196,
          overflowY: "auto",
          paddingRight: 2,
        }}
      >
        {results.map((def) => {
          const selected = def.id === icon;
          return (
            <button
              key={def.id}
              type="button"
              role="option"
              aria-selected={selected}
              title={def.label}
              onClick={(event) => {
                event.stopPropagation();
                onPickIcon(def.id);
              }}
              style={{
                appearance: "none",
                aspectRatio: "1",
                display: "grid",
                placeItems: "center",
                border: "none",
                borderRadius: "var(--radius-control, 7px)",
                background: selected
                  ? `color-mix(in oklab, ${color} 22%, transparent)`
                  : "transparent",
                boxShadow: selected
                  ? `inset 0 0 0 1px color-mix(in oklab, ${color} 55%, transparent)`
                  : "none",
                color: selected ? color : "var(--ink-dim)",
                cursor: "default",
                padding: 0,
              }}
              onMouseEnter={(event) => {
                if (!selected) event.currentTarget.style.background = "var(--hover)";
              }}
              onMouseLeave={(event) => {
                if (!selected) event.currentTarget.style.background = "transparent";
              }}
            >
              <WorkspaceIconGlyph icon={def.id} size={16} />
            </button>
          );
        })}
        {results.length === 0 && (
          <div
            style={{
              gridColumn: "1 / -1",
              padding: "14px 0",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 11.5,
            }}
          >
            No icons match “{query}”
          </div>
        )}
      </div>
      {!colorLocked && (
        <div
          role="group"
          aria-label="Workspace colors"
          style={{
            display: "flex",
            gap: 6,
            paddingTop: 8,
            borderTop: "1px solid var(--rule-soft)",
          }}
        >
          {WORKSPACE_COLORS.map((swatch) => {
            const selected = swatch.toLowerCase() === color.toLowerCase();
            return (
              <button
                key={swatch}
                type="button"
                aria-label={`Set color to ${swatch}`}
                title={swatch}
                onClick={(event) => {
                  event.stopPropagation();
                  onPickColor(swatch);
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
                  background: swatch,
                  boxShadow: selected
                    ? `0 0 0 2px color-mix(in oklab, ${swatch} 30%, transparent)`
                    : "none",
                  cursor: "default",
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
