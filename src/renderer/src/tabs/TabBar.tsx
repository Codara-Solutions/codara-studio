import React, { useEffect, useRef, useState } from "react";
import type { Tab, TabId } from "./types";
import { CloseIcon, FileIcon, PlusIcon } from "../components/icons";

// TabBar is the strip at the top of the workspace pane. Visually similar
// to a code editor's tab strip but with a kind-icon-prefixed label so it's
// obvious at a glance that you're switching between an editor, a terminal,
// a preview window, and a runs canvas.
//
// Behavior worth calling out:
//   - Wheel-deltaY scrolls the strip horizontally (terax pattern). Allows
//     a single-axis wheel mouse to navigate when many tabs are open.
//   - The active tab is scrolled into view on every selection change.
//   - The "+" button opens a small dropdown with kinds the user can spawn.
//   - Closing the last tab is a no-op on the store side; we still render
//     the close button for kinds with len > 1.
//   - Middle-click closes a tab (mouseup button === 1).

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  onSelect: (id: TabId) => void;
  onClose: (id: TabId) => void;
  onNewTerminal: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
}

export default function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewTerminal,
  onNewPreview,
  onNewEditor,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // Convert vertical wheel deltas to horizontal scroll on the tab strip,
  // but only when there's actually overflow to scroll. We register with
  // passive: false so preventDefault works.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab in view after a selection or open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeId) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${cssEscape(activeId)}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  // Close the new-tab picker on outside click / Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        pickerRef.current &&
        e.target instanceof Node &&
        !pickerRef.current.contains(e.target)
      ) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  return (
    <div
      style={{
        flex: "0 0 32px",
        height: 32,
        display: "flex",
        alignItems: "stretch",
        gap: 4,
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule-soft)",
        padding: "0 8px",
        position: "relative",
      }}
    >
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "stretch",
          gap: 2,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none",
        }}
        className="spark-tabbar-scroll"
      >
        {tabs.map((t) => (
          <TabItem
            key={t.id}
            tab={t}
            active={t.id === activeId}
            canClose={tabs.length > 1}
            onSelect={() => onSelect(t.id)}
            onClose={() => onClose(t.id)}
          />
        ))}
      </div>
      <div
        ref={pickerRef}
        style={{ position: "relative", display: "flex", alignItems: "center" }}
      >
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          title="New tab"
          aria-label="New tab"
          style={{
            appearance: "none",
            width: 24,
            height: 24,
            border: "1px solid var(--rule-soft)",
            borderRadius: 5,
            background: "color-mix(in oklch, var(--ink) 2%, transparent)",
            color: "var(--ink-dim)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "default",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background =
              "color-mix(in oklch, var(--ink) 2%, transparent)";
          }}
        >
          <PlusIcon size={12} />
        </button>
        {pickerOpen && (
          <div
            style={{
              position: "absolute",
              top: 28,
              right: 0,
              zIndex: 50,
              background: "var(--panel-2)",
              border: "1px solid var(--rule-strong)",
              borderRadius: 6,
              boxShadow: "var(--shadow-2)",
              minWidth: 200,
              overflow: "hidden",
            }}
          >
            <PickerItem
              label="Terminal"
              hint="⌘T"
              onClick={() => {
                setPickerOpen(false);
                onNewTerminal();
              }}
            />
            <PickerItem
              label="Editor"
              hint="⌘E"
              onClick={() => {
                setPickerOpen(false);
                onNewEditor();
              }}
            />
            <PickerItem
              label="Preview"
              hint="⌘P"
              onClick={() => {
                setPickerOpen(false);
                onNewPreview();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface TabItemProps {
  tab: Tab;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function TabItem({ tab, active, canClose, onSelect, onClose }: TabItemProps) {
  const [hover, setHover] = useState(false);
  const [closeHover, setCloseHover] = useState(false);

  const background = active
    ? "var(--bg)"
    : hover
      ? "color-mix(in oklch, var(--ink) 4%, var(--panel))"
      : "transparent";

  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && canClose) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      title={titleFor(tab)}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "0 8px 0 10px",
        background,
        color: active ? "var(--ink)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        cursor: "default",
        borderRight: "1px solid var(--rule-soft)",
        flex: "0 0 auto",
        maxWidth: 220,
        minWidth: 0,
      }}
    >
      {active && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            background: "var(--accent)",
          }}
        />
      )}
      <KindIcon tab={tab} />
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {labelFor(tab)}
      </span>
      {tab.kind === "editor" && tab.dirty && !closeHover ? (
        <span
          aria-label="Unsaved changes"
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: "var(--ink-dim)",
            flex: "0 0 7px",
          }}
        />
      ) : null}
      {canClose && (
        <button
          type="button"
          onMouseEnter={() => setCloseHover(true)}
          onMouseLeave={() => setCloseHover(false)}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close"
          aria-label="Close tab"
          style={{
            appearance: "none",
            width: 16,
            height: 16,
            border: "none",
            borderRadius: 3,
            background: closeHover ? "var(--hover)" : "transparent",
            color:
              closeHover || active || hover ? "var(--ink-dim)" : "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            cursor: "default",
            flex: "0 0 16px",
          }}
        >
          <CloseIcon size={10} />
        </button>
      )}
    </div>
  );
}

function KindIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "editor") {
    return (
      <span style={{ display: "inline-flex", flex: "0 0 14px" }}>
        <FileIcon ext={tab.entry.ext} />
      </span>
    );
  }
  if (tab.kind === "terminal") return <GlyphIcon glyph="❯" color="var(--accent)" />;
  if (tab.kind === "preview") return <GlyphIcon glyph="◉" color="var(--accent)" />;
  return <GlyphIcon glyph="◆" color="var(--accent)" />;
}

function GlyphIcon({ glyph, color }: { glyph: string; color: string }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        flex: "0 0 14px",
        color,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      {glyph}
    </span>
  );
}

function labelFor(t: Tab): string {
  if (t.kind === "terminal" && t.cwd) {
    const parts = t.cwd.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : t.title;
  }
  return t.title;
}

function titleFor(t: Tab): string {
  if (t.kind === "editor") return t.path;
  if (t.kind === "preview") return t.url;
  if (t.kind === "terminal") return t.cwd ?? t.title;
  return t.title;
}

function cssEscape(value: string): string {
  // Limited escape: tab ids are uid()-generated so this is mostly identity.
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function PickerItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        padding: "8px 12px",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        cursor: "default",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover-strong)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {hint && (
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
          {hint}
        </span>
      )}
    </button>
  );
}
