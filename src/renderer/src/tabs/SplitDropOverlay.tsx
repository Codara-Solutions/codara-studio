import { useEffect, useRef, useState } from "react";
import type { Tab } from "./types";
import { canSplitDrop, type SplitDropPlacement, type SplitDropSource } from "./splitDrop";
import {
  endTabDockDrag, endTabReorderDrag, endTerminalPaneDrag,
  peekTabReorderDrag, peekTerminalPaneDrag,
  subscribeTabReorderDrag, subscribeTerminalPaneDrag,
} from "./terminalDrag";

interface Props {
  tabs: Tab[];
  activeId: string | null;
  onDrop: (source: SplitDropSource, targetId: string, placement: SplitDropPlacement) => void;
}

export default function SplitDropOverlay({ tabs, activeId, onDrop }: Props) {
  const [source, setSource] = useState<SplitDropSource | null>(null);
  const [placement, setPlacement] = useState<SplitDropPlacement | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ tabs, activeId, onDrop });
  callbacks.current = { tabs, activeId, onDrop };

  useEffect(() => {
    const update = () => {
      setSource(peekTerminalPaneDrag() ?? peekTabReorderDrag());
      setPlacement(null);
    };
    const offTab = subscribeTabReorderDrag(update);
    // Pane notifications also carry movement; don't reset the preview on
    // every move, since pointer capture keeps those events on the handle.
    const offPane = subscribeTerminalPaneDrag((state) => {
      setSource(state?.payload ?? peekTabReorderDrag());
      if (!state) setPlacement(null);
    });
    const pointerMove = (event: PointerEvent) => {
      if (peekTerminalPaneDrag()) updatePlacement(atPoint(event));
    };
    const pointerUp = (event: PointerEvent) => {
      const payload = peekTerminalPaneDrag();
      if (payload) commit(payload, event);
    };
    const cancel = () => {
      endTerminalPaneDrag();
      endTabDockDrag();
      endTabReorderDrag();
      setPlacement(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    const pointerCancel = () => {
      // Chromium cancels the pointer stream when a native tab drag starts.
      // Only pointer-driven pane drags should end on that event.
      if (peekTerminalPaneDrag()) cancel();
    };
    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      offTab();
      offPane();
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  function updatePlacement(next: SplitDropPlacement | null) {
    setPlacement((current) => current?.direction === next?.direction && current?.position === next?.position ? current : next);
  }

  function atPoint(point: { clientX: number; clientY: number }): SplitDropPlacement | null {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    const x = (point.clientX - rect.left) / rect.width;
    const y = (point.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    const horizontal = Math.min(x, 1 - x) <= Math.min(y, 1 - y);
    return {
      direction: horizontal ? "horizontal" : "vertical",
      position: (horizontal ? x : y) < 0.5 ? "before" : "after",
    };
  }

  function commit(payload: SplitDropSource, point: { clientX: number; clientY: number }) {
    const next = atPoint(point);
    const current = callbacks.current;
    if (!next || !current.activeId || !canSplitDrop(current.tabs, payload, current.activeId)) return;
    current.onDrop(payload, current.activeId, next);
    endTerminalPaneDrag();
    endTabDockDrag();
    endTabReorderDrag();
    setPlacement(null);
  }

  if (!source || !activeId || !canSplitDrop(tabs, source, activeId)) return null;
  const horizontal = placement?.direction === "horizontal";
  const before = placement?.position === "before";
  return (
    <div
      ref={overlayRef}
      data-split-drop-overlay
      onDragOver={(event) => {
        if (!peekTabReorderDrag()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        updatePlacement(atPoint(event));
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPlacement(null);
      }}
      onDrop={(event) => {
        const payload = peekTabReorderDrag();
        if (!payload) return;
        event.preventDefault();
        event.stopPropagation();
        commit(payload, event);
      }}
      // The webview is a separate guest and swallows host drag events unless
      // a real hit target covers it for the duration of the gesture.
      style={{ position: "absolute", inset: 0, zIndex: 10 }}
    >
      {placement && (
        <div
          data-split-drop-preview={`${placement.direction}-${placement.position}`}
          style={{
            position: "absolute", pointerEvents: "none",
            left: horizontal && !before ? "50%" : 0,
            top: !horizontal && !before ? "50%" : 0,
            width: horizontal ? "50%" : "100%",
            height: horizontal ? "100%" : "50%",
            boxSizing: "border-box", padding: 12,
            background: "var(--accent-soft)", border: "2px dashed var(--accent-edge)",
            borderRadius: "var(--terminal-pane-radius)",
            display: "grid", placeItems: "center", color: "var(--accent-text)",
          }}
        >
          <span className="spark-btn">Split {horizontal ? (before ? "left" : "right") : (before ? "above" : "below")}</span>
        </div>
      )}
    </div>
  );
}
