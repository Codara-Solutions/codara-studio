import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ShellInfo } from "@shared/types";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import type { SparkOpenInput } from "./useTerminalSession";

// TerminalStrip is the bottom collapsible terminal region. It owns a small
// tabbed multiplexer of independent pty-backed shells (distinct from the
// orchestration worker grid in the centre of the app — orchestration panes
// run a planned worker command, the strip runs a plain interactive shell).
//
// Layout: a 26px header (Terminal label, URL chip when sniffed, tab bar,
// add/collapse buttons) and a content area that holds every TerminalPane
// stacked absolutely so PTYs survive tab switches.
//
// Toggling collapse is exposed to the rest of the app through a window
// CustomEvent (`spark:toggle-terminal`) so a global keyboard shortcut can
// open/close the strip without prop drilling. Mod+` is registered in the
// shortcuts module.
//
// Detected local-URL events (vite/next/webpack dev servers) re-emit on the
// window so a future browser-tab agent can grab them; the strip itself just
// renders a "↗ open" chip in the header for the active session.

const STRIP_HEADER_HEIGHT = 30;
const STRIP_DEFAULT_HEIGHT = 240;
const STRIP_MIN_HEIGHT = 120;
const STRIP_MAX_RATIO = 0.8;

interface Props {
  shell: ShellInfo | null;
  cwd: string | null;
  onOpenFile?: (path: string) => void;
}

interface SessionTab {
  id: string;
  shell: ShellInfo;
  cwd?: string;
  detectedUrl: string | null;
  exited: boolean;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function TerminalStrip({ shell, cwd, onOpenFile }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [height, setHeight] = useState<number>(STRIP_DEFAULT_HEIGHT);
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const handlesRef = useRef<Map<string, TerminalPaneHandle | null>>(new Map());

  // Resize-by-drag for the strip's vertical edge. `dragRef` holds the
  // pixel-space conversion baseline so the strip tracks the cursor 1:1.
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const ensureSession = useCallback(() => {
    if (!shell) return;
    const id = uid("strip-term");
    setTabs((list) => [
      ...list,
      {
        id,
        shell,
        cwd: cwd ?? undefined,
        detectedUrl: null,
        exited: false,
      },
    ]);
    setActiveId(id);
  }, [shell, cwd]);

  const expandIfCollapsed = useCallback(() => {
    setCollapsed(false);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((list) => {
      const idx = list.findIndex((t) => t.id === id);
      if (idx === -1) return list;
      const next = list.slice(0, idx).concat(list.slice(idx + 1));
      // Best-effort: ask main to dispose the pty even if it has already
      // exited. Idempotent on the main side (sessions.has guard).
      void window.spark.pty.dispose(id);
      handlesRef.current.delete(id);
      // Reposition the active tab so the user lands on a still-open one.
      setActiveId((current) => {
        if (current !== id) return current;
        return next[idx]?.id ?? next[idx - 1]?.id ?? next[0]?.id ?? null;
      });
      return next;
    });
  }, []);

  const handleTogglePinned = useCallback(() => {
    setCollapsed((value) => !value);
  }, []);

  const handleToggleEvent = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      // Auto-spawn the first tab the first time the strip is expanded — this
      // matches user expectation that pressing Mod+` immediately gives a
      // working shell, not an empty pane.
      if (!next && tabs.length === 0 && shell) {
        const id = uid("strip-term");
        setTabs([
          {
            id,
            shell,
            cwd: cwd ?? undefined,
            detectedUrl: null,
            exited: false,
          },
        ]);
        setActiveId(id);
      }
      return next;
    });
  }, [tabs.length, shell, cwd]);

  // Listen for `spark:toggle-terminal` so the global shortcut module can
  // open/close the strip from anywhere in the renderer without prop drilling.
  useEffect(() => {
    const onToggle = () => handleToggleEvent();
    window.addEventListener("spark:toggle-terminal", onToggle);
    return () => window.removeEventListener("spark:toggle-terminal", onToggle);
  }, [handleToggleEvent]);

  const onMouseDownDivider = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (collapsed) return;
      dragRef.current = { startY: e.clientY, startHeight: height };
      const onMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = dragRef.current.startY - ev.clientY;
        const next = Math.min(
          Math.max(STRIP_MIN_HEIGHT, dragRef.current.startHeight + delta),
          window.innerHeight * STRIP_MAX_RATIO,
        );
        setHeight(next);
      };
      const onMouseUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [collapsed, height],
  );

  const setHandle = useCallback(
    (id: string, h: TerminalPaneHandle | null) => {
      if (h) handlesRef.current.set(id, h);
      else handlesRef.current.delete(id);
    },
    [],
  );

  const onDetectedUrl = useCallback((id: string, url: string) => {
    setTabs((list) =>
      list.map((t) => (t.id === id ? { ...t, detectedUrl: url } : t)),
    );
    // Re-broadcast so a future browser-tab agent (or any other listener) can
    // light up its own affordance without being a direct subscriber here.
    window.dispatchEvent(
      new CustomEvent("spark:detected-url", {
        detail: { url, sessionId: id },
      }),
    );
  }, []);

  const onSparkOpen = useCallback(
    (input: SparkOpenInput) => {
      onOpenFile?.(input.file);
      window.dispatchEvent(
        new CustomEvent("spark:terax-open", { detail: { path: input.file } }),
      );
    },
    [onOpenFile],
  );

  const onExit = useCallback((id: string) => {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, exited: true } : t)));
  }, []);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId) ?? null,
    [tabs, activeId],
  );

  const containerHeight = collapsed ? STRIP_HEADER_HEIGHT : STRIP_HEADER_HEIGHT + height;

  // Visible area when expanded — explicit pixel height makes ResizeObserver
  // wake up promptly when the user drags the divider.
  const contentHeight = collapsed ? 0 : height;

  return (
    <div
      style={{
        flex: `0 0 ${containerHeight}px`,
        display: "flex",
        flexDirection: "column",
        borderTop: "1px solid var(--rule-soft)",
        background: "var(--panel)",
        position: "relative",
        userSelect: dragRef.current ? "none" : undefined,
      }}
    >
      {/* Drag handle — hairline strip just above the header. Only interactive
          when expanded; collapsed mode shows just the header bar. */}
      <div
        onMouseDown={onMouseDownDivider}
        style={{
          position: "absolute",
          top: -3,
          left: 0,
          right: 0,
          height: 6,
          cursor: collapsed ? "default" : "ns-resize",
          zIndex: 1,
        }}
        aria-hidden
      />
      <StripHeader
        collapsed={collapsed}
        tabs={tabs}
        activeId={activeId}
        detectedUrl={activeTab?.detectedUrl ?? null}
        canAdd={Boolean(shell)}
        onToggle={handleTogglePinned}
        onAdd={() => {
          expandIfCollapsed();
          ensureSession();
        }}
        onSelect={(id) => {
          setActiveId(id);
          expandIfCollapsed();
        }}
        onClose={closeTab}
      />

      {/* Content area is always rendered so PTY scrollback survives a
          collapse/expand cycle. We hide it via height:0 + overflow:hidden
          when collapsed so the existing xterm canvases stay attached. */}
      <div
        style={{
          position: "relative",
          flex: collapsed ? "0 0 0" : 1,
          minHeight: 0,
          height: contentHeight,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        {tabs.length === 0 && !collapsed ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
            }}
          >
            {shell
              ? "No active terminal — press + to start one."
              : "No shell detected."}
          </div>
        ) : (
          tabs.map((t) => (
            <div
              key={t.id}
              style={{
                position: "absolute",
                inset: 0,
                // Keep every pane mounted so PTY scrollback survives tab
                // switches AND collapse/expand cycles. Hidden ones get
                // pointer-events:none from the pane itself; we toggle z so
                // the active tab is on top.
                zIndex: t.id === activeId ? 2 : 1,
              }}
            >
              <TerminalPane
                ref={(h) => setHandle(t.id, h)}
                sessionId={t.id}
                shell={t.shell}
                initialCwd={t.cwd}
                visible={!collapsed && t.id === activeId}
                onExit={() => onExit(t.id)}
                onDetectedLocalUrl={(url) => onDetectedUrl(t.id, url)}
                onSparkOpen={onSparkOpen}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface StripHeaderProps {
  collapsed: boolean;
  tabs: SessionTab[];
  activeId: string | null;
  detectedUrl: string | null;
  canAdd: boolean;
  onToggle: () => void;
  onAdd: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

function StripHeader({
  collapsed,
  tabs,
  activeId,
  detectedUrl,
  canAdd,
  onToggle,
  onAdd,
  onSelect,
  onClose,
}: StripHeaderProps) {
  return (
    <div
      style={{
        flex: `0 0 ${STRIP_HEADER_HEIGHT}px`,
        height: STRIP_HEADER_HEIGHT,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 10px",
        background: "var(--panel)",
        borderBottom: collapsed ? "none" : "1px solid var(--rule-soft)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        title={collapsed ? "Expand terminal (Ctrl+`)" : "Collapse terminal (Ctrl+`)"}
        aria-label={collapsed ? "Expand terminal" : "Collapse terminal"}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          color: "var(--ink-dim)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          padding: "0 6px",
          cursor: "default",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            transform: collapsed ? "rotate(0deg)" : "rotate(180deg)",
            transition: "transform var(--motion-fast) var(--ease-out)",
            fontSize: 9,
          }}
        >
          ▲
        </span>
        TERMINAL
      </button>

      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 4,
          overflowX: "auto",
          overflowY: "hidden",
        }}
      >
        {tabs.map((t, i) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "2px 6px 2px 10px",
                borderRadius: 5,
                background: active
                  ? "color-mix(in oklch, var(--ink) 4%, var(--panel-2))"
                  : "transparent",
                border: active
                  ? "1px solid color-mix(in oklch, var(--accent) 40%, var(--rule-soft))"
                  : "1px solid transparent",
                color: active ? "var(--ink)" : "var(--muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                cursor: "default",
              }}
              onClick={() => onSelect(t.id)}
            >
              <span style={{ minWidth: 14 }}>{i + 1}</span>
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  color: t.exited ? "var(--muted)" : "var(--ink-dim)",
                }}
              >
                {t.shell.label}
                {t.exited ? " (exited)" : ""}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                title="Close"
                aria-label="Close terminal"
                style={{
                  appearance: "none",
                  background: "transparent",
                  border: "none",
                  color: "var(--muted)",
                  fontSize: 12,
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "default",
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {detectedUrl && (
        <button
          type="button"
          onClick={() => {
            void window.spark.openExternal?.(detectedUrl);
          }}
          title={`Open ${detectedUrl}`}
          style={{
            appearance: "none",
            background: "color-mix(in oklch, var(--accent) 8%, transparent)",
            border: "1px solid color-mix(in oklch, var(--accent) 40%, var(--rule-soft))",
            color: "var(--ink)",
            borderRadius: 999,
            padding: "2px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "default",
            maxWidth: 320,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ fontSize: 10 }}>↗</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {detectedUrl}
          </span>
        </button>
      )}

      <button
        type="button"
        onClick={onAdd}
        disabled={!canAdd}
        title="New terminal"
        aria-label="New terminal"
        style={{
          appearance: "none",
          width: 22,
          height: 22,
          border: "1px solid var(--rule-soft)",
          borderRadius: 5,
          background: "color-mix(in oklch, var(--ink) 2%, transparent)",
          color: canAdd ? "var(--ink-dim)" : "var(--muted)",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "default",
        }}
      >
        +
      </button>
    </div>
  );
}
