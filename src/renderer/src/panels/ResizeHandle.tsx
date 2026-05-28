import { useEffect, useRef, useState } from "react";
import { SPLIT_HANDLE, WIDTH_HANDLE } from "./usePanelLayout";

interface ResizeHandleProps {
  // "col" sits between side-by-side panels and resizes width (drag horizontal);
  // "row" sits between stacked sections and resizes height (drag vertical).
  orientation: "col" | "row";
  onResizeStart?: () => void;
  // `delta` is the signed pixel distance the pointer has moved since the drag
  // started (clientX for "col", clientY for "row"). The parent integrates it
  // against a value snapshotted in onResizeStart, so there is no drift.
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
  // Renders an inert hairline with the same footprint — used when a split is
  // meaningless because one of its sections is collapsed.
  disabled?: boolean;
  // Workspace accent, used for the dragging state only.
  accent?: string;
  ariaLabel: string;
}

// A draggable divider. The visible part is a hairline rule centred inside a
// wider invisible hit target; it brightens on hover and picks up the workspace
// accent while dragging.
//
// During a drag we listen on `window` and drop a fixed full-viewport overlay,
// so the pointer stream survives the cursor crossing an iframe (the preview
// tab) or an xterm canvas, and the resize cursor holds for the whole gesture.
export function ResizeHandle({
  orientation,
  onResizeStart,
  onResize,
  onResizeEnd,
  disabled = false,
  accent,
  ariaLabel,
}: ResizeHandleProps) {
  const isCol = orientation === "col";
  const hitSize = isCol ? WIDTH_HANDLE : SPLIT_HANDLE;
  const cursor = isCol ? "col-resize" : "row-resize";
  const accentColor = accent || "var(--accent)";

  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const startRef = useRef(0);

  // Latest callbacks via refs so the window-listener effect never resubscribes
  // mid-drag if the parent hands down a fresh callback identity per render.
  const resizeRef = useRef(onResize);
  const endRef = useRef(onResizeEnd);
  resizeRef.current = onResize;
  endRef.current = onResizeEnd;

  useEffect(() => {
    if (!dragging) return;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setDragging(false);
      endRef.current?.();
    };
    const onMove = (event: PointerEvent) => {
      const pos = isCol ? event.clientX : event.clientY;
      resizeRef.current(pos - startRef.current);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") finish();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("mouseup", finish, true);
    window.addEventListener("blur", finish);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("mouseup", finish, true);
      window.removeEventListener("blur", finish);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [dragging, isCol]);

  if (disabled) {
    return (
      <div
        aria-hidden
        style={{
          flex: `0 0 ${hitSize}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={
            isCol
              ? { width: 1, height: "100%", background: "var(--rule-soft)" }
              : { height: 1, width: "100%", background: "var(--rule-soft)" }
          }
        />
      </div>
    );
  }

  const active = dragging || hover;
  const lineColor = dragging
    ? accentColor
    : hover
      ? "var(--rule-strong)"
      : isCol
        ? "var(--rule)"
        : "var(--rule-soft)";
  const lineThickness = dragging ? 2 : 1;

  return (
    <div
      role="separator"
      aria-orientation={isCol ? "vertical" : "horizontal"}
      aria-label={ariaLabel}
      onPointerDown={(event) => {
        event.preventDefault();
        startRef.current = isCol ? event.clientX : event.clientY;
        setDragging(true);
        onResizeStart?.();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: `0 0 ${hitSize}px`,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor,
        touchAction: "none",
        zIndex: 6,
        background: dragging
          ? `color-mix(in oklch, ${accentColor} 9%, transparent)`
          : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      {/* Hairline rule. */}
      <div
        style={{
          background: lineColor,
          boxShadow: dragging ? `0 0 8px ${accentColor}` : "none",
          transition:
            "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
          ...(isCol
            ? { width: lineThickness, height: "100%" }
            : { height: lineThickness, width: "100%" }),
        }}
      />
      {/* Grip — fades in on hover, accent-lit while dragging. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          borderRadius: 999,
          background: dragging ? accentColor : "var(--rule-strong)",
          opacity: active ? 1 : 0,
          transition: "opacity var(--motion-fast) var(--ease-out)",
          ...(isCol ? { width: 3, height: 26 } : { height: 3, width: 26 }),
        }}
      />
      {/* Full-viewport overlay so the drag survives iframes / xterm canvases. */}
      {dragging && <div style={{ position: "fixed", inset: 0, zIndex: 9999, cursor }} />}
    </div>
  );
}

export default ResizeHandle;
