import { zoomPercent } from "./zoom-math";

// Minus, percent, plus and fit: the zoom row every viewer's toolbar carries.
// Docked, the toolbar lives in the pane chrome's pointer-none slot, so each
// control re-enables the pointer for itself.

export default function ZoomControl({
  zoom,
  onZoomOut,
  onZoomIn,
  onFit,
  fitLabel = "Fit",
  fitTitle = "Fit to view",
}: {
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  fitLabel?: string;
  fitTitle?: string;
}) {
  return (
    <>
      <button type="button" className="spark-btn" style={buttonStyle} onClick={onZoomOut} title="Zoom out" aria-label="Zoom out">
        −
      </button>
      <span
        data-testid="viewer-zoom-level"
        aria-label="Zoom level"
        style={{
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          minWidth: 42,
          textAlign: "center",
          pointerEvents: "auto",
        }}
      >
        {zoomPercent(zoom)}
      </span>
      <button type="button" className="spark-btn" style={buttonStyle} onClick={onZoomIn} title="Zoom in" aria-label="Zoom in">
        +
      </button>
      <button
        type="button"
        className="spark-btn"
        style={{ ...buttonStyle, width: "auto", padding: "0 8px" }}
        onClick={onFit}
        title={fitTitle}
      >
        {fitLabel}
      </button>
    </>
  );
}

const buttonStyle: React.CSSProperties = {
  width: 24,
  height: 22,
  padding: 0,
  fontSize: 13,
  lineHeight: 1,
  flex: "0 0 auto",
  pointerEvents: "auto",
};
