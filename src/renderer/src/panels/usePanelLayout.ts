import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

// Panel layout — outer widths, internal split ratios, and per-section collapse
// state for the left (Workspaces / Graph) and right (Spark / Explorer) side
// panels.
//
// Persisted GLOBALLY, not per-workspace: panel chrome is an app-level
// preference, the same shape across every project. Persistence mirrors the
// useTabs pattern — a versioned JSON blob in localStorage written on a
// trailing debounce, so a resize drag (one setState per pointermove) collapses
// into a single write once the gesture settles.

const STORAGE_KEY = "spark.panels:v1";
const PERSIST_DEBOUNCE_MS = 300;

// Height of a section header band, and the height a section occupies when
// collapsed (header only). Exported so the panel slot math and the rendered
// SectionHeader agree on one number.
export const PANEL_HEADER_H = 34;

// Hit-area thickness of the draggable dividers. The visible rule is a hairline
// centred inside this wider invisible target.
export const WIDTH_HANDLE = 7;
export const SPLIT_HANDLE = 9;

// Clamp ranges. Widths keep both panels usable without starving the centre
// workbench; splits keep neither section from collapsing to nothing by drag
// (explicit collapse is a separate, deliberate action).
export const LEFT_WIDTH_RANGE = { min: 196, max: 460 } as const;
export const RIGHT_WIDTH_RANGE = { min: 300, max: 640 } as const;
const SPLIT_RANGE = { min: 0.2, max: 0.8 } as const;

export type PanelSectionKey = "workspaces" | "graph" | "agent" | "explorer";

export interface PanelLayout {
  leftWidth: number;
  rightWidth: number;
  leftSplit: number; // Workspaces' share of the left panel body (0..1)
  rightSplit: number; // Spark's share of the right panel body (0..1)
  collapsed: Record<PanelSectionKey, boolean>;
}

const DEFAULT_LAYOUT: PanelLayout = {
  leftWidth: 240,
  rightWidth: 360,
  leftSplit: 0.52,
  rightSplit: 0.64,
  collapsed: { workspaces: false, graph: false, agent: false, explorer: false },
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

// Coerce an arbitrary parsed blob into a valid layout. Every field is range-
// checked so a hand-edited or stale localStorage entry can't wedge the UI.
function sanitize(raw: Partial<PanelLayout> | null | undefined): PanelLayout {
  if (!raw || typeof raw !== "object") return DEFAULT_LAYOUT;
  const c = (raw.collapsed ?? {}) as Partial<Record<PanelSectionKey, boolean>>;
  return {
    leftWidth: clamp(Number(raw.leftWidth ?? DEFAULT_LAYOUT.leftWidth), LEFT_WIDTH_RANGE.min, LEFT_WIDTH_RANGE.max),
    rightWidth: clamp(Number(raw.rightWidth ?? DEFAULT_LAYOUT.rightWidth), RIGHT_WIDTH_RANGE.min, RIGHT_WIDTH_RANGE.max),
    leftSplit: clamp(Number(raw.leftSplit ?? DEFAULT_LAYOUT.leftSplit), SPLIT_RANGE.min, SPLIT_RANGE.max),
    rightSplit: clamp(Number(raw.rightSplit ?? DEFAULT_LAYOUT.rightSplit), SPLIT_RANGE.min, SPLIT_RANGE.max),
    collapsed: {
      workspaces: Boolean(c.workspaces),
      graph: Boolean(c.graph),
      agent: Boolean(c.agent),
      explorer: Boolean(c.explorer),
    },
  };
}

function loadLayout(): PanelLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    return sanitize(JSON.parse(raw) as Partial<PanelLayout>);
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export interface UsePanelLayoutApi extends PanelLayout {
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  setLeftSplit: (ratio: number) => void;
  setRightSplit: (ratio: number) => void;
  toggleCollapse: (key: PanelSectionKey) => void;
}

export function usePanelLayout(): UsePanelLayoutApi {
  const [layout, setLayout] = useState<PanelLayout>(loadLayout);

  // Trailing-debounce the localStorage write. A width/split drag mutates
  // `layout` continuously; one synchronous setItem per pointermove would
  // hammer the main thread. 300ms after the last change, one write lands.
  const persistTimer = useRef<number | null>(null);
  useEffect(() => {
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
      } catch {
        /* Quota exceeded or storage unavailable; persistence is best-effort. */
      }
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    };
  }, [layout]);

  // Every setter clamps, so callers can hand in raw drag-derived values.
  const setLeftWidth = useCallback((width: number) => {
    setLayout((l) => ({ ...l, leftWidth: clamp(width, LEFT_WIDTH_RANGE.min, LEFT_WIDTH_RANGE.max) }));
  }, []);
  const setRightWidth = useCallback((width: number) => {
    setLayout((l) => ({ ...l, rightWidth: clamp(width, RIGHT_WIDTH_RANGE.min, RIGHT_WIDTH_RANGE.max) }));
  }, []);
  const setLeftSplit = useCallback((ratio: number) => {
    setLayout((l) => ({ ...l, leftSplit: clamp(ratio, SPLIT_RANGE.min, SPLIT_RANGE.max) }));
  }, []);
  const setRightSplit = useCallback((ratio: number) => {
    setLayout((l) => ({ ...l, rightSplit: clamp(ratio, SPLIT_RANGE.min, SPLIT_RANGE.max) }));
  }, []);
  const toggleCollapse = useCallback((key: PanelSectionKey) => {
    setLayout((l) => ({ ...l, collapsed: { ...l.collapsed, [key]: !l.collapsed[key] } }));
  }, []);

  // Memoized API object: identity changes only when `layout` does, so the
  // memoized panels downstream re-render on a real layout change and nothing
  // else. The callbacks are all stable for the hook's lifetime.
  return useMemo<UsePanelLayoutApi>(
    () => ({ ...layout, setLeftWidth, setRightWidth, setLeftSplit, setRightSplit, toggleCollapse }),
    [layout, setLeftWidth, setRightWidth, setLeftSplit, setRightSplit, toggleCollapse],
  );
}

// Flex styles for the two stacked sections of a panel, given section A's share
// of the body and each section's collapse state. A collapsed section shrinks
// to its header band; an expanded section flexes to fill whatever a collapsed
// sibling leaves behind.
export function sectionSlotStyles(
  ratioA: number,
  aCollapsed: boolean,
  bCollapsed: boolean,
): [CSSProperties, CSSProperties] {
  const collapsedSlot: CSSProperties = { flex: `0 0 ${PANEL_HEADER_H}px`, minHeight: 0 };
  const fillSlot: CSSProperties = { flex: "1 1 0", minHeight: 0 };
  if (aCollapsed && bCollapsed) return [collapsedSlot, collapsedSlot];
  if (aCollapsed) return [collapsedSlot, fillSlot];
  if (bCollapsed) return [fillSlot, collapsedSlot];
  return [
    { flex: `${ratioA} 1 0`, minHeight: 0 },
    { flex: `${1 - ratioA} 1 0`, minHeight: 0 },
  ];
}
