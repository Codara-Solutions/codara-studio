export interface PreviewControl {
  action: string;
  runId: string | null;
  x?: number;
  y?: number;
}

export default function PreviewCursor({ control }: { control: PreviewControl | null }) {
  if (!control) return null;
  const positioned = Number.isFinite(control.x) && Number.isFinite(control.y);
  return (
    <div data-preview-control aria-live="polite" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20, overflow: "hidden" }}>
      <div style={{ position: "absolute", right: 12, top: 12, padding: "6px 10px", borderRadius: 8, background: "var(--bg)", color: "var(--accent-text)", border: "1px solid var(--accent)", fontSize: 12, boxShadow: "0 2px 12px #0003" }}>
        Cora · {control.action}
      </div>
      {positioned ? (
        <div data-preview-cursor style={{ position: "absolute", left: control.x, top: control.y, transition: "left 100ms linear, top 100ms linear", color: "var(--accent)", filter: "drop-shadow(0 1px 2px #0008)" }}>
          <svg width="24" height="30" viewBox="0 0 24 30" aria-hidden="true">
            <path d="M2 2L2 23L8 18L13 28L18 25L13 16L21 15Z" fill="currentColor" stroke="white" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </div>
      ) : null}
    </div>
  );
}
