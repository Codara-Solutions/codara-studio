import { useCallback, useEffect, useState } from "react";
import { ZoomPaneIcon } from "../icons";

// In-app focus mode deliberately does not call the browser Fullscreen API.
// Native macOS fullscreen changes the Codara window itself and can restore it
// at a different size. This state only expands the preview over the renderer,
// leaving the real app window and every workspace layout untouched.
export function usePreviewFullscreen(enabled: boolean) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!enabled) setFullscreen(false);
  }, [enabled]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [fullscreen]);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((current) => !current);
  }, []);

  return { fullscreen, toggleFullscreen };
}

export function PreviewFullscreenButton({
  fullscreen,
  onToggle,
}: {
  fullscreen: boolean;
  onToggle: () => void;
}) {
  const label = fullscreen ? "Exit full screen" : "Preview full screen";
  return (
    <button
      type="button"
      className="spark-btn"
      title={fullscreen ? `${label} (Esc)` : label}
      aria-label={label}
      aria-pressed={fullscreen}
      onClick={onToggle}
      style={buttonStyle}
    >
      <ZoomPaneIcon size={13} zoomed={fullscreen} />
    </button>
  );
}

const buttonStyle: React.CSSProperties = {
  width: 27,
  height: 24,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  color: "var(--ink-dim)",
  background: "color-mix(in oklch, var(--panel-3) 82%, transparent)",
  border: "1px solid var(--rule)",
  borderRadius: 7,
  boxShadow: "var(--lift-hi)",
  pointerEvents: "auto",
};
