import React, { useEffect, useRef, useState } from "react";
import { PAGE_SIZE } from "./model";

// ── Shared interaction state ─────────────────────────────────────────────────
// Hand-rolled buttons in this dialog set an inline box-shadow, which silently
// wins over the global :focus-visible ring (the ring rule isn't !important).
// Each custom control tracks hover / focus-visible / press locally and composes
// the accent --focus-ring back into its inline box-shadow so keyboard focus
// actually renders. Native elements that DON'T set an inline box-shadow (the
// .spark-* utilities) inherit the global ring for free. Mirrors SettingsDialog.
export function useInteractive() {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pressed, setPressed] = useState(false);
  const handlers = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => {
      setHover(false);
      setPressed(false);
    },
    onMouseDown: () => setPressed(true),
    onMouseUp: () => setPressed(false),
    onFocus: (event: React.FocusEvent) => {
      if (event.target.matches(":focus-visible")) setFocus(true);
    },
    onBlur: () => {
      setFocus(false);
      setPressed(false);
    },
  };
  return { hover, focus, pressed, handlers };
}

export function withFocusRing(base: string | undefined, focus: boolean): string | undefined {
  if (!focus) return base;
  if (!base || base === "none") return "var(--focus-ring)";
  return `${base}, var(--focus-ring)`;
}

// Text only screen readers announce, for glyph-only cells.
export function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return <span style={visuallyHiddenStyle}>{children}</span>;
}

// The toolbar over a section's list. The title bar above already names the
// section and describes it in one line, so the lead is a filter or a short
// fact about the list (a count, where it is read from), never a second
// description of the page.
export function SectionHead({
  lead,
  actions,
}: {
  lead?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div style={sectionHeadStyle}>
      <div style={sectionLeadStyle}>{lead}</div>
      {actions ? <div style={sectionActionsStyle}>{actions}</div> : null}
    </div>
  );
}

// The dialog corner's close button, drawn exactly like the one in Settings.
export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="st-close" aria-label="Close" title="Close" onClick={onClick}>
      <CloseGlyph />
    </button>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <div style={searchWrapStyle}>
      <SearchGlyph />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="spark-input"
        style={searchInputStyle}
        spellCheck={false}
      />
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      {children}
      {hint ? <span style={fieldHintStyle}>{hint}</span> : null}
    </label>
  );
}

export function EmptyRow({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="st-empty">
      <span className="st-empty__body">{text}</span>
      {action ? <span className="st-empty__action">{action}</span> : null}
    </div>
  );
}

// Stand-in rows while a list is being read, so the pane never claims to be
// empty before it knows.
export function LoadingRows({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" aria-label={label}>
      <div style={loadingLabelStyle}>{label}</div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} style={loadingRowStyle} aria-hidden>
          <span style={{ ...skeletonBarStyle, width: `${46 - index * 8}%` }} />
          <span style={{ ...skeletonBarStyle, width: `${70 - index * 10}%`, height: 8, opacity: 0.6 }} />
        </div>
      ))}
    </div>
  );
}

export function ErrorRow({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" style={errorRowStyle}>
      <WarnGlyph />
      <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
      <button type="button" className="spark-btn" style={smallBtnStyle} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function Pager({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div style={pagerStyle}>
      <span>
        {shown} of {total} shown
      </span>
      <button type="button" className="spark-btn" style={smallBtnStyle} onClick={onMore}>
        Show {Math.min(PAGE_SIZE, total - shown)} more
      </button>
    </div>
  );
}

// Destructive actions stay neutral until armed, then reveal the danger tint for
// the confirm step. The arm expires so a stray first click cannot linger.
export function ConfirmRemoveButton({
  busy,
  disabled,
  label = "Remove",
  title,
  ariaLabel,
  onConfirm,
}: {
  busy: boolean;
  disabled: boolean;
  label?: string;
  title?: string;
  ariaLabel?: string;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = () => {
    if (busy || disabled) return;
    if (!confirming) {
      setConfirming(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setConfirming(false), 4000);
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setConfirming(false);
    onConfirm();
  };

  return (
    <button
      type="button"
      className={confirming ? "spark-btn is-danger" : "spark-btn"}
      style={smallBtnStyle}
      disabled={busy || disabled}
      onClick={handleClick}
      title={confirming ? "Click again to confirm" : title}
      aria-label={confirming ? `Confirm: ${ariaLabel ?? label}` : ariaLabel}
    >
      {busy ? "Working" : confirming ? "Confirm" : label}
    </button>
  );
}

// ── Switch: the Settings switch (.st-switch in styles.css), so an off switch
// reads the same in both dialogs: a grey track with a white knob, never a
// dark knob that looks like it is on. SwitchTrack is the pure-visual part so
// the same geometry can be (a) an interactive role=switch button, or (b) a
// decorative indicator nested inside a larger clickable row (ToggleRow),
// where a nested <button> would be invalid HTML.
const SWITCH_W = 32;

export function SwitchTrack({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden
      className={`st-switch${checked ? " is-on" : ""}`}
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <span className="st-switch__knob" />
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
  title?: string;
}) {
  const { focus, pressed, handlers } = useInteractive();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...handlers}
      style={{
        appearance: "none",
        display: "inline-flex",
        flex: `0 0 ${SWITCH_W}px`,
        padding: 0,
        border: "none",
        borderRadius: 999,
        background: "transparent",
        cursor: "default",
        transform: pressed && !disabled ? "translateY(0.5px)" : "none",
        boxShadow: withFocusRing(undefined, focus),
        transition: "transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <SwitchTrack checked={checked} disabled={disabled} />
    </button>
  );
}

// A full-width labelled switch row: the whole strip is the hit target, so the
// title and its explanation are part of the control.
export function ToggleRow({
  title,
  detail,
  checked,
  disabled,
  onChange,
  children,
}: {
  title: string;
  detail: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  children?: React.ReactNode;
}) {
  const { focus, handlers } = useInteractive();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...handlers}
      style={{
        ...toggleRowStyle,
        boxShadow: withFocusRing(undefined, focus),
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={toggleTitleStyle}>{title}</span>
        <span style={toggleDetailStyle}>{detail}</span>
        {children}
      </span>
      <SwitchTrack checked={checked} disabled={disabled} />
    </button>
  );
}

// Shared 1.5px-stroke SVG icon family at currentColor (no unicode glyphs).
export function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function SearchGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      style={searchGlyphStyle}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

// "Yes, this one is set up here." Tinted --ok rather than inheriting, because
// in a column of dashes and buttons the tick is the signal.
export function CheckGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="var(--ok)"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function WarnGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="var(--warn)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 14px" }}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

export function TrashGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
    </svg>
  );
}

export function EyeGlyph({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.6" />
      {open ? null : <path d="M4 20L20 4" />}
    </svg>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

export const visuallyHiddenStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export const sectionStyle: React.CSSProperties = {
  display: "grid",
  gap: 16,
  alignContent: "start",
};

export const sectionHeadStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const sectionLeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flex: "1 1 200px",
  minWidth: 0,
  color: "var(--st-faint)",
  fontSize: 12.5,
  lineHeight: 1.45,
};

export const sectionTitleStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 13.5,
  fontWeight: 600,
  lineHeight: 1.35,
  margin: 0,
};

export const sectionDetailStyle: React.CSSProperties = {
  color: "var(--st-desc)",
  fontSize: 12.5,
  lineHeight: 1.5,
  margin: "3px 0 0",
  maxWidth: "62ch",
};

export const sectionActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
};

// Lists and panels are drawn the way Settings draws its rows: hairlines
// between items, no boxes around them.
export const listStyle: React.CSSProperties = {
  borderTop: "1px solid var(--st-line)",
  borderBottom: "1px solid var(--st-line)",
};

export const panelStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  paddingTop: 14,
  borderTop: "1px solid var(--st-line)",
};

export const noticeStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "9px 12px",
  borderRadius: 8,
  border: "1px solid color-mix(in oklch, var(--warn) 35%, transparent)",
  background: "color-mix(in oklch, var(--warn) 9%, transparent)",
  color: "var(--ink)",
  fontSize: 11.5,
  lineHeight: 1.45,
};

export const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 14,
  alignItems: "center",
  padding: "13px 0",
  borderBottom: "1px solid var(--st-line)",
};

// Names wrap to a second line instead of clipping: the Server column is the
// only flexible track, and a long name cut to "github-enterprise-int" reads as
// a different server.
export const rowNameStyle: React.CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  overflowWrap: "anywhere",
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.35,
};

export const rowMetaStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  marginTop: 4,
  minWidth: 0,
};

// Two lines before it gives way, so a summary is read rather than guessed.
export const rowSummaryStyle: React.CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  color: "var(--st-desc)",
  fontSize: 12.5,
  lineHeight: 1.45,
  maxWidth: "100%",
};

export const rowNoteStyle: React.CSSProperties = {
  color: "var(--st-desc)",
  fontSize: 12.5,
  lineHeight: 1.45,
};

export const rowScopeStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 12,
};

export const rowActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  alignSelf: "center",
  flexWrap: "wrap",
  gap: 6,
};

export const cellStyle: React.CSSProperties = {
  display: "grid",
  justifyItems: "center",
  alignContent: "center",
  gap: 4,
  minWidth: 0,
};

export const cellLabelStyle: React.CSSProperties = {
  color: "var(--st-desc)",
  fontSize: 12,
  lineHeight: 1.3,
};

export const cellDashStyle: React.CSSProperties = {
  color: "var(--muted-2)",
  fontSize: 12,
};

export const cellNoteStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 11.5,
  lineHeight: 1.3,
  textAlign: "center",
};

export const tableHeadStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  alignItems: "center",
  padding: "8px 0",
  borderBottom: "1px solid var(--st-line)",
};

export const tableHeadCellStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 11,
  lineHeight: 1.3,
  textAlign: "center",
};

export const tableHeadLeadStyle: React.CSSProperties = {
  ...tableHeadCellStyle,
  textAlign: "left",
};

export const smallBtnStyle: React.CSSProperties = {
  height: 28,
  padding: "0 10px",
  fontSize: 12,
};

export const microBtnStyle: React.CSSProperties = {
  height: "auto",
  padding: "2px 7px",
  fontSize: 10,
};

export const badgeStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  textTransform: "none",
  letterSpacing: 0,
};

export const fieldStyle: React.CSSProperties = {
  display: "grid",
  gap: 5,
  minWidth: 0,
};

export const fieldLabelStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 500,
};

export const fieldHintStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 12,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};

export const optionalStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontWeight: 400,
};

export const textareaStyle: React.CSSProperties = {
  height: "auto",
  padding: "8px 10px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  // .spark-input sets line-height 1 for its 26px single-line shell, which packs
  // wrapped lines together.
  lineHeight: 1.5,
  resize: "vertical",
};

export const formErrorStyle: React.CSSProperties = {
  color: "var(--danger)",
  fontSize: 11.5,
  lineHeight: 1.45,
};

// Pair with className="st-rows" for the hairlines between rows.
export const toggleListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

export const toggleRowStyle: React.CSSProperties = {
  appearance: "none",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 24,
  alignItems: "center",
  textAlign: "left",
  width: "100%",
  padding: "13px 0",
  border: "none",
  borderRadius: 0,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "default",
  transition: "box-shadow var(--motion-fast) var(--ease-out)",
};

export const toggleTitleStyle: React.CSSProperties = {
  display: "block",
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.35,
};

export const toggleDetailStyle: React.CSSProperties = {
  display: "block",
  maxWidth: "62ch",
  color: "var(--st-desc)",
  fontSize: 12.5,
  lineHeight: 1.5,
  marginTop: 3,
};

const searchWrapStyle: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
};

const searchGlyphStyle: React.CSSProperties = {
  position: "absolute",
  left: 9,
  color: "var(--muted)",
  pointerEvents: "none",
};

const searchInputStyle: React.CSSProperties = {
  width: 190,
  paddingLeft: 30,
};

const pagerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "8px 0",
  color: "var(--st-faint)",
  fontSize: 12,
};

const loadingLabelStyle: React.CSSProperties = {
  padding: "10px 0 2px",
  color: "var(--st-faint)",
  fontSize: 12,
};

const loadingRowStyle: React.CSSProperties = {
  display: "grid",
  gap: 7,
  padding: "12px 0",
  borderBottom: "1px solid var(--st-line)",
};

const skeletonBarStyle: React.CSSProperties = {
  display: "block",
  height: 10,
  borderRadius: 4,
  background:
    "linear-gradient(90deg, color-mix(in oklab, var(--ink) 6%, transparent) 0%, color-mix(in oklab, var(--ink) 12%, transparent) 50%, color-mix(in oklab, var(--ink) 6%, transparent) 100%)",
  backgroundSize: "200% 100%",
  animation: "spark-shimmer 1.6s linear infinite",
};

const errorRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 0",
  color: "var(--danger)",
  fontSize: 12,
  lineHeight: 1.45,
};
