import React, { useEffect, useRef, useState } from "react";

// The one dropdown both Settings and the Capability Center use, so a picker
// looks and behaves the same in either dialog.

export interface CustomSelectOption {
  value: string;
  label: string;
  /**
   * Optional group heading. Consecutive options sharing a group render once
   * under a header row (the Cora model-picker look); ungrouped options render
   * flush at the top.
   */
  group?: string;
  /** Secondary text beside the label, such as the path behind a shell name. */
  detail?: string;
}

// A crisp 1.5px-stroke chevron at currentColor, never the Unicode "▾",
// which sits on a text baseline and renders heavier than the SVG icons
// elsewhere in the app. Flips on open.
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`st-select__chevron${open ? " is-open" : ""}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// Replaces the native <select> dropdown: Chromium's OS-rendered popup on
// Windows ignores our theme variables, so unselected options render with
// near-zero contrast in dark mode. This in-app dropdown is an absolutely
// positioned panel anchored to the trigger, themed with the dialog's
// tokens, and dismissed on outside-click / Escape / blur.
export default function CustomSelect({
  value,
  options,
  onChange,
  ariaLabel,
  describedBy,
  width,
  disabled,
}: {
  value: string;
  options: ReadonlyArray<CustomSelectOption>;
  onChange: (next: string) => void;
  ariaLabel?: string;
  /** Id of the row description the trigger is described by. */
  describedBy?: string;
  disabled?: boolean;
  /** Fixed trigger width when the select sits in a row's control slot. */
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !triggerRef.current?.contains(event.target) &&
        !popupRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Capture + stopPropagation so Escape dismisses just the dropdown
        // instead of also closing the whole Settings dialog.
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // Capture, as in AnchoredMenu: dialog surfaces such as the Capability
    // Center stop mousedown from bubbling, and a bubble-phase listener never
    // heard a click elsewhere in them, so the list stayed open.
    document.addEventListener("mousedown", onDown, { capture: true });
    document.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onDown, { capture: true });
      document.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  return (
    <div className="st-select-wrap" style={width ? { width } : undefined}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        disabled={disabled}
        className={`st-select-trigger${open ? " is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="st-select-trigger__value">
          {current?.label ?? value}
          {current?.detail ? <span className="st-select__detail">{current.detail}</span> : null}
        </span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div ref={popupRef} role="listbox" className="spark-menu st-select-menu">
          {options.map((opt, index) => {
            const previous = index > 0 ? options[index - 1] : undefined;
            const showHeader = Boolean(opt.group) && opt.group !== previous?.group;
            return (
              <React.Fragment key={opt.value}>
                {showHeader && (
                  <div role="presentation" className={`st-select-menu__group${index > 0 ? " has-rule" : ""}`}>
                    {opt.group}
                  </div>
                )}
                <SelectOption
                  label={opt.label}
                  detail={opt.detail}
                  active={opt.value === value}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                />
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SelectOption({
  label,
  detail,
  active,
  onClick,
}: {
  label: string;
  detail?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={active ? "spark-menu-item is-active" : "spark-menu-item"}
      onClick={onClick}
    >
      <span className="st-select-option__label">{label}</span>
      {detail ? <span className="st-select__detail">{detail}</span> : null}
    </button>
  );
}
