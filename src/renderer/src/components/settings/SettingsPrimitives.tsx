import React from "react";

/**
 * The building blocks every Settings page is drawn with. A page is a stack of
 * sections under the dialog's title bar, which carries the page title and its
 * one-line description so they stay put while the page scrolls. A section
 * is a heading over a stack of rows split by hairlines; a row is a label and
 * a short description on the left with its control on the right. Spacing and
 * dividers separate things, never boxes. The look lives in styles.css under
 * `.st-*`, scoped to the dialog surface, so these components carry structure
 * and no colours.
 *
 * `anchor` names a section or row for Settings search: a result scrolls to
 * the element carrying the same `data-setting-anchor`.
 */

export function SettingsPage({ children }: { children: React.ReactNode }) {
  return <div className="st-page">{children}</div>;
}

/**
 * A quiet "show more" toggle with a chevron that turns when open. Details
 * most people never need (tuning, how a mechanism works) sit behind one so
 * the page reads as a list of settings rather than a wall of text.
 */
export function Disclosure({
  open,
  onToggle,
  anchor,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  anchor?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="st-disclosure"
      aria-expanded={open}
      data-setting-anchor={anchor}
      onClick={onToggle}
    >
      <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 6l6 6-6 6" />
      </svg>
      {children}
    </button>
  );
}

/** A key name drawn as a small keycap inside running text. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="st-kbd st-kbd--inline">{children}</kbd>;
}

export function SettingsSection({
  title,
  description,
  actions,
  anchor,
  plain,
  children,
}: {
  title?: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  anchor?: string;
  /** Children are laid out as they are, without the hairline row stack. */
  plain?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section className="st-section" data-setting-anchor={anchor ?? title}>
      {title || actions ? (
        <div className="st-section__head">
          <div className="st-section__titles">
            {title ? <h3 className="st-section__title">{title}</h3> : null}
            {description ? <p className="st-section__desc">{description}</p> : null}
          </div>
          {actions ? <div className="st-section__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children ? <div className={plain ? "st-section__body" : "st-rows"}>{children}</div> : null}
    </section>
  );
}

export function SettingRow({
  title,
  desc,
  control,
  disabled,
  htmlFor,
  anchor,
  stacked,
  children,
}: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  control?: React.ReactNode;
  disabled?: boolean;
  htmlFor?: string;
  anchor?: string;
  /** The control takes the full width under the label (text fields, lists). */
  stacked?: boolean;
  /** Extra content under the row (a sub-setting that belongs to this one). */
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`st-row${stacked ? " st-row--stacked" : ""}${disabled ? " is-disabled" : ""}`}
      data-setting-anchor={anchor ?? (typeof title === "string" ? title : undefined)}
    >
      <div className="st-row__main">
        <div className="st-row__text">
          <label htmlFor={htmlFor} className="st-row__title">
            {title}
          </label>
          {desc ? <div className="st-row__desc">{desc}</div> : null}
        </div>
        {control !== undefined && control !== null ? (
          <div className="st-row__control">{control}</div>
        ) : null}
      </div>
      {children ? <div className="st-row__extra">{children}</div> : null}
    </div>
  );
}

export function ToggleRow({
  title,
  desc,
  checked,
  disabled,
  anchor,
  onChange,
  children,
}: {
  title: string;
  desc?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  anchor?: string;
  onChange: (next: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <SettingRow
      title={title}
      desc={desc}
      anchor={anchor}
      disabled={disabled}
      control={
        <Switch checked={checked} disabled={disabled} onChange={onChange} ariaLabel={title} />
      }
    >
      {children}
    </SettingRow>
  );
}

/**
 * The pure-visual part of the switch, so the same geometry can be a real
 * role=switch button or a decorative indicator inside a larger clickable
 * control, where a nested button would be invalid HTML.
 */
export function SwitchTrack({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={`st-switch${checked ? " is-on" : ""}`}>
      <span className="st-switch__knob" />
    </span>
  );
}

export function Switch({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className="st-switch-btn"
      onClick={() => onChange(!checked)}
    >
      <SwitchTrack checked={checked} />
    </button>
  );
}

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * A row of mutually exclusive presets. Each segment stays a real button with
 * aria-pressed, so its label is its accessible name; the hint rides along as
 * a tooltip and the row shows the selected one as its description.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="st-segmented">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            title={option.hint}
            className={`st-segmented__item${active ? " is-active" : ""}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A slider with its value printed beside it, sized to sit in a row's control slot. */
export function RangeControl({
  ariaLabel,
  min,
  max,
  step,
  value,
  display,
  onChange,
  onCommit,
  onPointerDown,
}: {
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (next: number) => void;
  /** Fires on release, blur and key-up for callers that persist once per gesture. */
  onCommit?: (next: number) => void;
  onPointerDown?: () => void;
}) {
  const commit = onCommit
    ? (event: React.SyntheticEvent<HTMLInputElement>) =>
        onCommit(Number(event.currentTarget.value))
    : undefined;
  return (
    <span className="st-range">
      <input
        aria-label={ariaLabel}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onPointerDown}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        onPointerUp={commit}
        onPointerCancel={commit}
        onBlur={commit}
        onKeyUp={commit}
      />
      <span className="st-range__value">{display}</span>
    </span>
  );
}

/**
 * A stacked form field: a sentence-case label over its control, with an
 * optional hint under it. Wrapping in a <label> keeps getByLabel working for
 * both inputs and button-shaped controls.
 */
export function Label({
  text,
  hint,
  hintAction,
  anchor,
  children,
}: {
  text: string;
  hint?: React.ReactNode;
  /** A button beside the hint, kept outside the <label> so it is never its target. */
  hintAction?: React.ReactNode;
  anchor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="st-field" data-setting-anchor={anchor ?? text}>
      <label className="st-field__label-wrap">
        <span className="st-field__label">{text}</span>
        {children}
      </label>
      {hint || hintAction ? (
        <div className={`st-field__hint${hintAction ? " st-field__hint--row" : ""}`}>
          <span>{hint}</span>
          {hintAction}
        </div>
      ) : null}
    </div>
  );
}

export function InlineMessage({
  tone,
  role,
  children,
  action,
}: {
  tone: "danger" | "warn" | "info" | "ok" | "muted";
  role?: "alert" | "status";
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={`st-message st-message--${tone}`} role={role}>
      <StatusGlyph tone={tone} />
      <span className="st-message__text">{children}</span>
      {action ? <span className="st-message__action">{action}</span> : null}
    </div>
  );
}

export function StatusGlyph({ tone }: { tone: "danger" | "warn" | "info" | "ok" | "muted" }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "st-glyph",
  };
  if (tone === "ok") {
    return (
      <svg {...common}>
        <path d="M5 12.5l4.5 4.5L19 7" />
      </svg>
    );
  }
  if (tone === "danger" || tone === "warn") {
    return (
      <svg {...common}>
        <path d="M12 4.5 21 19.5H3z" />
        <line x1="12" y1="10" x2="12" y2="14" />
        <circle cx="12" cy="16.9" r="0.4" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8.5" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.4" fill="currentColor" />
    </svg>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="st-empty">
      {icon ? <span className="st-empty__icon" aria-hidden>{icon}</span> : null}
      <span className="st-empty__title">{title}</span>
      {body ? <span className="st-empty__body">{body}</span> : null}
      {action ? <span className="st-empty__action">{action}</span> : null}
    </div>
  );
}

/** A label and a plain value, for read-only facts (versions, counts). */
export function ValueRow({
  title,
  desc,
  value,
  mono,
  anchor,
}: {
  title: string;
  desc?: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  anchor?: string;
}) {
  return (
    <SettingRow
      title={title}
      desc={desc}
      anchor={anchor}
      control={<span className={`st-value${mono ? " is-mono" : ""}`}>{value}</span>}
    />
  );
}
